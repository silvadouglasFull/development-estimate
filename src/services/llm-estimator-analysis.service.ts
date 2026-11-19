import { env } from '@/env';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
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
};

/**
 * Service that uses LangChain (starting with OpenAI) to analyze repository hour estimates
 * and Markdown documentation against a user-provided goal, saving `analysis.md`.
 */
export class LlmEstimatorAnalysisService {
    private readonly analysisFileName = 'analysis.md';
    private readonly defaultMaxCharsPerFile = 4000;
    private readonly defaultMaxTotalChars = 20000;

    /**
     * Creates a LangChain chat model instance (OpenAI by default).
     */
    private createChatModel(): ChatOpenAI {
        // Step 1: Validate API key presence before calling the LLM provider.
        const apiKey = env.OPENAI_API_KEY?.trim();
        if (!apiKey) {
            throw new Error('OPENAI_API_KEY não configurada no ambiente (.env).');
        }

        // Step 2: Instantiate ChatOpenAI via LangChain so swapping providers later stays isolated.
        return new ChatOpenAI({
            apiKey,
            model: env.OPENAI_MODEL,
            temperature: 0.3,
        });
    }

    /**
     * Recursively collects Markdown (.md) files inside a repository directory.
     */
    private async collectRepoMarkdownFiles(dirPath: string): Promise<string[]> {
        // Step 3: Walk subdirectories while ignoring .git and node_modules.
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
     * Builds the prompt payload with the estimation report, repository Markdown files,
     * and the user's goal/project details while respecting character limits.
     */
    private async buildPromptContent(params: GenerateLlmAnalysisParams): Promise<string> {
        const maxCharsPerFile = params.maxCharsPerFile ?? this.defaultMaxCharsPerFile;
        const maxTotalChars = params.maxTotalChars ?? this.defaultMaxTotalChars;

        // Step 4: Read the previously generated estimation.md report.
        const estimationContent = await readFile(params.estimateMarkdownPath, 'utf-8');

        const parts: string[] = [
            '# Objetivo e Detalhes Informados pelo Usuário',
            params.userGoalAndDetails.trim(),
            '',
            '# Relatório de Estimativa de Horas (estimation.md)',
            estimationContent.trim(),
            '',
            '# Arquivos Markdown do Repositório',
        ];

        let totalChars = parts.join('\n').length;

        // Step 5: Append repository `.md` files with per-file and total size caps.
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
            const remaining = maxTotalChars - totalChars;
            const limitForFile = Math.min(maxCharsPerFile, remaining);

            const safeText =
                rawText.length > limitForFile
                    ? `${rawText.slice(0, limitForFile)}\n\n[...conteúdo truncado...]`
                    : rawText;

            const section = [
                `## Arquivo: ${relPath}`,
                '```markdown',
                safeText.trim(),
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
        // Step 6: Build prompt and send system + human messages via LangChain.
        const model = this.createChatModel();
        const promptContent = await this.buildPromptContent(params);

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

        const rawResponseContent =
            typeof response.content === 'string'
                ? response.content
                : JSON.stringify(response.content, null, 2);

        // Step 7: Save output inside the same estimate/<REPO> folder as `analysis.md`.
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