import { env } from '@/env';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { MarkdownTextSplitter, RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

/**
 * Parameters required to generate an LLM analysis Markdown file for a repository.
 */
export type GenerateLlmAnalysisParams = {
    repoDir: string;
    estimateMarkdownPath: string;
    userGoalAndDetails: string;
    maxCharsPerFile?: number;
    maxTotalChars?: number;
    chunkOverlap?: number;
};

/**
 * Service that uses LangChain (starting with OpenAI) to analyze repository hour estimates
 * and Markdown documentation against a user-provided goal, saving `analysis.md`.
 */
export class LlmEstimatorAnalysisService {
    private readonly analysisFileName = 'analysis.md';
    private readonly defaultMaxCharsPerFile = 4000;
    private readonly defaultMaxTotalChars = 20000;
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

        // Step 3: Instantiate ChatOpenAI via LangChain so swapping providers later stays isolated.
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
     * Builds the prompt payload with the estimation report, repository Markdown files,
     * and the user's goal/project details by joining splitter chunks up to the total limit.
     */
    private async buildPromptContent(params: GenerateLlmAnalysisParams): Promise<string> {
        const maxCharsPerFile = params.maxCharsPerFile ?? this.defaultMaxCharsPerFile;
        const maxTotalChars = params.maxTotalChars ?? this.defaultMaxTotalChars;
        const chunkOverlap = params.chunkOverlap ?? this.defaultChunkOverlap;

        // Step 10: Read and chunk estimation.md using RecursiveCharacterTextSplitter.
        const estimationContent = await readFile(params.estimateMarkdownPath, 'utf-8');
        const estimationChunks = await this.splitGeneralTextIntoChunks(
            estimationContent,
            maxCharsPerFile,
            chunkOverlap
        );
        const joinedEstimation = this.joinChunksUpToBudget(
            estimationChunks,
            Math.max(1000, Math.floor(maxTotalChars * 0.4))
        ).text;

        const parts: string[] = [
            '# Objetivo e Detalhes Informados pelo Usuário',
            params.userGoalAndDetails.trim(),
            '',
            '# Relatório de Estimativa de Horas (estimation.md)',
            joinedEstimation,
            '',
            '# Arquivos Markdown do Repositório',
        ];

        let totalChars = parts.join('\n').length;

        // Step 11: Collect repository `.md` files and join chunks up to maxTotalChars.
        const mdFiles = await this.collectRepoMarkdownFiles(params.repoDir);

        for (const filePath of mdFiles) {
            if (totalChars >= maxTotalChars) {
                parts.push(
                    '\n> Aviso: limite total de contexto atingido; demais arquivos .md foram omitidos.'
                );
                break;
            }

            const rawText = await readFile(filePath, 'utf-8');
            const relPath = relative(params.repoDir, filePath);

            const fileChunks = await this.splitMarkdownIntoChunks(rawText, 1200, chunkOverlap);
            const remainingBudget = maxTotalChars - totalChars;
            const fileBudget = Math.min(maxCharsPerFile, remainingBudget);

            const { text: joinedFileText, truncated } = this.joinChunksUpToBudget(
                fileChunks,
                fileBudget
            );

            if (!joinedFileText) {
                continue;
            }

            const contentWithNotice = truncated
                ? `${joinedFileText}\n\n[...trechos adicionais omitidos para respeitar o limite...]`
                : joinedFileText;

            const section = [
                `## Arquivo: ${relPath}`,
                '```markdown',
                contentWithNotice,
                '```',
                '',
            ].join('\n');

            parts.push(section);
            totalChars += section.length;
        }

        return parts.join('\n');
    }

    /**
     * Runs the LLM analysis and writes the resulting Markdown report to `estimate/<REPO>/analysis.md`.
     */
    public async generateAndSaveAnalysis(params: GenerateLlmAnalysisParams): Promise<string> {
        // Step 12: Build prompt and send system + human messages via LangChain.
        const model = this.createChatModel();
        const promptContent = await this.buildPromptContent(params);

        let rawResponseContent: string;

        try {
            const response = await model.invoke([
                new SystemMessage(
                    [
                        'Você é um especialista sênior em engenharia de software, arquitetura e estimativa de projetos.',
                        'Analise os dados do histórico Git, as horas estimadas e a documentação Markdown do repositório',
                        'à luz do objetivo e dos detalhes informados pelo usuário.',
                        'Responda em português, de forma clara, prática e estruturada em Markdown.',
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

        // Step 14: Save output inside the same estimate/<REPO> folder as `analysis.md`.
        const estimateDir = dirname(resolve(params.estimateMarkdownPath));
        const repoName = basename(estimateDir);
        const analysisFilePath = join(estimateDir, this.analysisFileName);

        await mkdir(estimateDir, { recursive: true });

        const finalMarkdown = [
            `# Análise de Estimativa com LLM — ${repoName}`,
            '',
            '## Objetivo Informado',
            params.userGoalAndDetails.trim(),
            '',
            '## Parecer Técnico',
            rawResponseContent.trim(),
            '',
        ].join('\n');

        await writeFile(analysisFilePath, finalMarkdown, 'utf-8');
        return analysisFilePath;
    }
}