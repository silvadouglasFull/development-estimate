import { env } from '@/env';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { MarkdownTextSplitter, RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

/**
 * Represents a single analyzed project with its local clone path and generated estimation report.
 */
export type AnalyzedProjectInput = {
    projectName?: string;
    repoDir: string;
    estimateMarkdownPath: string;
};

/**
 * Parameters required to generate a single consolidated `analysis.md` across multiple projects
 * for the target project described by the user.
 */
export type GenerateConsolidatedAnalysisParams = {
    projects: AnalyzedProjectInput[];
    userGoalAndDetails: string;
    outputDir?: string;
    includeRepoMarkdownDocs?: boolean;
    maxCharsPerProject?: number;
    maxTotalChars?: number;
    chunkOverlap?: number;
};

/**
 * Service that uses LangChain (starting with OpenAI) to read hour estimates across multiple
 * projects and generate a single consolidated `analysis.md` for the project described by the user.
 */
export class LlmEstimatorAnalysisService {
    private readonly analysisFileName = 'analysis.md';
    private readonly defaultEstimatesRootDir = 'estimate';
    private readonly defaultMaxCharsPerProject = 5000;
    private readonly defaultMaxTotalChars = 24000;
    private readonly defaultChunkOverlap = 150;

    /**
     * Builds a non-sensitive fingerprint of the active API key for debugging 401 errors.
     */
    private getKeyFingerprint(apiKey: string): string {
        // Step 1: Expose only a short prefix, suffix, and length so secrets are never leaked.
        if (apiKey.length <= 10) {
            return `len=${apiKey.length}`;
        }
        return `${apiKey.slice(0, 6)}...${apiKey.slice(-4)} (len=${apiKey.length})`;
    }

    /**
     * Creates a LangChain chat model instance (OpenAI by default).
     */
    private createChatModel(): ChatOpenAI {
        // Step 2: Validate and trim API key presence before calling the LLM provider.
        const apiKey = env.OPENAI_API_KEY?.trim();
        if (!apiKey) {
            throw new Error('OPENAI_API_KEY não configurada no ambiente (.env).');
        }

        // Step 3: Instantiate ChatOpenAI via LangChain with low temperature for consistent estimates.
        return new ChatOpenAI({
            apiKey,
            model: env.OPENAI_MODEL,
            temperature: 0.1,
        });
    }

    /**
     * Recursively collects Markdown (.md) files inside a repository directory.
     */
    private async collectRepoMarkdownFiles(dirPath: string): Promise<string[]> {
        // Step 4: Walk subdirectories while ignoring .git and node_modules.
        const entries = await readdir(dirPath, { withFileTypes: true });
        const collected: string[] = [];

        for (const entry of entries) {
            const fullPath = join(dirPath, entry.name);

            if (entry.isDirectory()) {
                if (entry.name === '.git' || entry.name === 'node_modules') {
                    continue;
                }
                const nested = await this.collectRepoMarkdownFiles(fullPath);
                collected.push(...nested);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
                collected.push(fullPath);
            }
        }

        return collected.sort();
    }

    /**
     * Splits Markdown content using LangChain's MarkdownTextSplitter so headings,
     * sections, and blocks are split at natural boundaries.
     */
    private async splitMarkdownIntoChunks(
        markdownText: string,
        chunkSize: number,
        chunkOverlap: number
    ): Promise<string[]> {
        // Step 5: Return empty array when content has no non-whitespace characters.
        const trimmed = markdownText.trim();
        if (!trimmed) {
            return [];
        }

        // Step 6: Split Markdown text using MarkdownTextSplitter.
        const splitter = new MarkdownTextSplitter({
            chunkSize: Math.max(200, chunkSize),
            chunkOverlap: Math.min(chunkOverlap, Math.floor(Math.max(200, chunkSize) / 4)),
        });

        return splitter.splitText(trimmed);
    }

    /**
     * Splits general text using LangChain's RecursiveCharacterTextSplitter.
     */
    private async splitGeneralTextIntoChunks(
        text: string,
        chunkSize: number,
        chunkOverlap: number
    ): Promise<string[]> {
        // Step 7: Return empty array when text has no non-whitespace characters.
        const trimmed = text.trim();
        if (!trimmed) {
            return [];
        }

        // Step 8: Split text using RecursiveCharacterTextSplitter.
        const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: Math.max(200, chunkSize),
            chunkOverlap: Math.min(chunkOverlap, Math.floor(Math.max(200, chunkSize) / 4)),
        });

        return splitter.splitText(trimmed);
    }

    /**
     * Joins multiple chunks sequentially up to `maxBudgetChars` so the prompt includes
     * as many complete chunks as fit without exceeding the budget.
     */
    private joinChunksUpToBudget(
        chunks: string[],
        maxBudgetChars: number
    ): { text: string; truncated: boolean } {
        // Step 9: Accumulate chunks until adding the next chunk would exceed maxBudgetChars.
        if (chunks.length === 0 || maxBudgetChars <= 0) {
            return { text: '', truncated: chunks.length > 0 };
        }

        const includedChunks: string[] = [];
        let usedChars = 0;
        let truncated = false;

        for (const chunk of chunks) {
            const cleanChunk = chunk.trim();
            if (!cleanChunk) {
                continue;
            }

            const separatorLength = includedChunks.length > 0 ? 2 : 0;
            if (usedChars + separatorLength + cleanChunk.length <= maxBudgetChars) {
                includedChunks.push(cleanChunk);
                usedChars += separatorLength + cleanChunk.length;
            } else {
                truncated = true;
                break;
            }
        }

        return {
            text: includedChunks.join('\n\n'),
            truncated,
        };
    }

    /**
     * Builds a consolidated prompt containing the user's new project description and
     * each analyzed project's `estimation.md` (plus optional repository `.md` docs).
     */
    private async buildConsolidatedPrompt(params: GenerateConsolidatedAnalysisParams): Promise<string> {
        const maxCharsPerProject = params.maxCharsPerProject ?? this.defaultMaxCharsPerProject;
        const maxTotalChars = params.maxTotalChars ?? this.defaultMaxTotalChars;
        const chunkOverlap = params.chunkOverlap ?? this.defaultChunkOverlap;
        const includeDocs = params.includeRepoMarkdownDocs ?? true;

        const goalText = params.userGoalAndDetails.trim();
        const headerParts: string[] = [
            '# Projeto Novo Descrito pelo Usuário',
            goalText,
            '',
            '# Projetos Analisados (Estimativas e Histórico)',
        ];

        let totalChars = headerParts.join('\n').length;
        const projectSections: string[] = [];

        // Step 10: Read and chunk each project's estimation.md within a shared character budget.
        for (const project of params.projects) {
            if (totalChars >= maxTotalChars) {
                projectSections.push(
                    '\n> Aviso: limite total de contexto atingido; demais projetos foram omitidos.'
                );
                break;
            }

            const projectName =
                project.projectName?.trim() ||
                basename(dirname(resolve(project.estimateMarkdownPath))) ||
                basename(resolve(project.repoDir));

            const estimationRaw = await readFile(project.estimateMarkdownPath, 'utf-8');
            const estimationChunks = await this.splitGeneralTextIntoChunks(
                estimationRaw,
                1500,
                chunkOverlap
            );

            const remainingBudget = maxTotalChars - totalChars;
            const perProjectBudget = Math.min(maxCharsPerProject, remainingBudget);
            const estimationBudget = includeDocs
                ? Math.floor(perProjectBudget * 0.7)
                : perProjectBudget;

            const joinedEstimation = this.joinChunksUpToBudget(
                estimationChunks,
                Math.max(500, estimationBudget)
            ).text;

            const sectionLines: string[] = [
                `## Projeto: ${projectName}`,
                '### Estimativa de Horas (estimation.md)',
                joinedEstimation || '_Sem conteúdo em estimation.md._',
            ];

            // Step 11: Optionally attach repository Markdown excerpts inside the remaining project budget.
            if (includeDocs) {
                const usedSoFar = sectionLines.join('\n').length;
                let docBudgetLeft = Math.max(0, perProjectBudget - usedSoFar);
                const mdFiles = await this.collectRepoMarkdownFiles(project.repoDir);

                for (const mdFile of mdFiles) {
                    if (docBudgetLeft < 300) {
                        break;
                    }

                    const docText = await readFile(mdFile, 'utf-8');
                    const docChunks = await this.splitMarkdownIntoChunks(docText, 1000, chunkOverlap);
                    const joinedDoc = this.joinChunksUpToBudget(
                        docChunks,
                        Math.min(1800, docBudgetLeft)
                    ).text;

                    if (!joinedDoc) {
                        continue;
                    }

                    const relDocPath = relative(project.repoDir, mdFile);
                    const docBlock = [
                        `#### Doc (${relDocPath})`,
                        '```markdown',
                        joinedDoc,
                        '```',
                    ].join('\n');

                    sectionLines.push(docBlock);
                    docBudgetLeft -= docBlock.length;
                }
            }

            const fullSection = sectionLines.join('\n\n');
            projectSections.push(fullSection);
            totalChars += fullSection.length;
        }

        return [...headerParts, '', ...projectSections].join('\n\n');
    }

    /**
     * Reads `estimation.md` for every provided project, runs a single consolidated LLM analysis
     * for the project described by the user, and writes one `analysis.md` file.
     */
    public async generateConsolidatedAnalysis(
        params: GenerateConsolidatedAnalysisParams
    ): Promise<string> {
        if (params.projects.length === 0) {
            throw new Error('Nenhum projeto informado para análise consolidada.');
        }

        // Step 12: Build consolidated prompt and invoke LLM once across all analyzed projects.
        const model = this.createChatModel();
        const promptContent = await this.buildConsolidatedPrompt(params);
        const goalText = params.userGoalAndDetails.trim();

        let rawResponseContent: string;

        try {
            const response = await model.invoke([
                new SystemMessage(
                    [
                        'Você é um especialista sênior em engenharia de software, arquitetura e estimativa de projetos.',
                        'Você receberá os relatórios de estimativa (estimation.md) e referências de vários projetos já analisados',
                        'junto com a descrição de um novo projeto informado pelo usuário.',
                        'Comece a resposta exatamente com a frase introdutória:',
                        `"Com base nos seus projetos que foram analisados, essa é minha analise sobre custo e tempo para desenvolver um projeto como você descreveu: ${goalText}"`,
                        'Em seguida, compare com os projetos analisados e apresente de forma clara e prática em Markdown:',
                        '1) Estimativa de tempo (horas e dias úteis considerando o ritmo informado),',
                        '2) Estimativa/estrutura de custo ou cobrança,',
                        '3) Riscos, premissas e o que faz o tempo/custo subir ou cair.',
                    ].join(' ')
                ),
                new HumanMessage(promptContent),
            ]);

            rawResponseContent =
                typeof response.content === 'string'
                    ? response.content
                    : JSON.stringify(response.content, null, 2);
        } catch (error) {
            // Step 13: Enrich 401/expired-key errors with model and safe key fingerprint details.
            const apiKey = env.OPENAI_API_KEY?.trim() ?? '';
            const fingerprint = this.getKeyFingerprint(apiKey);
            const message = error instanceof Error ? error.message : String(error);

            if (message.includes('401') || message.toLowerCase().includes('expired')) {
                throw new Error(
                    `Falha de autenticação (401) ao invocar o modelo "${env.OPENAI_MODEL}" com a chave [${fingerprint}]: a API rejeitou/expirou a chave. Verifique OPENAI_API_KEY no .env e confirme se não há outra chave antiga ativa no ambiente.`
                );
            }

            throw error;
        }

        // Step 14: Write a single consolidated analysis.md file in the target output directory.
        const targetDir = resolve(params.outputDir ?? this.defaultEstimatesRootDir);
        const analysisFilePath = join(targetDir, this.analysisFileName);

        await mkdir(targetDir, { recursive: true });

        const analyzedNames = params.projects.map(
            (project) =>
                project.projectName?.trim() ||
                basename(dirname(resolve(project.estimateMarkdownPath))) ||
                basename(resolve(project.repoDir))
        );

        const finalMarkdown = [
            '# Análise Consolidada de Custo e Tempo',
            '',
            `**Projetos analisados:** ${analyzedNames.join(', ')}`,
            '',
            '## Projeto Descrito',
            goalText,
            '',
            '## Análise Consolidada',
            rawResponseContent.trim(),
            '',
        ].join('\n');

        await writeFile(analysisFilePath, finalMarkdown, 'utf-8');
        return analysisFilePath;
    }
}