import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { join, resolve } from 'node:path';

/**
 * Shape of a directory entry returned by fs/promises readdir with withFileTypes: true.
 */
type FakeDirent = {
    name: string;
    isDirectory: () => boolean;
    isFile: () => boolean;
};

/**
 * Options accepted by LangChain text splitters in tests.
 */
type SplitterOptions = {
    chunkSize?: number;
    chunkOverlap?: number;
};

const mockInvoke = jest.fn<(messages: unknown[]) => Promise<{ content: unknown }>>();
const mockChatOpenAI = jest.fn<(options: Record<string, unknown>) => { invoke: typeof mockInvoke }>();
const mockMarkdownSplitter = jest.fn<
    (options?: SplitterOptions) => { splitText: (text: string) => Promise<string[]> }
>();
const mockRecursiveSplitter = jest.fn<
    (options?: SplitterOptions) => { splitText: (text: string) => Promise<string[]> }
>();
const mockMkdir = jest.fn<(path: string, options?: { recursive?: boolean }) => Promise<string | undefined>>();
const mockReaddir = jest.fn<(path: string, options?: { withFileTypes?: boolean }) => Promise<FakeDirent[]>>();
const mockReadFile = jest.fn<(filePath: string, encoding?: BufferEncoding) => Promise<string>>();
const mockWriteFile = jest.fn<(filePath: string, data: string, encoding?: BufferEncoding) => Promise<void>>();

const fakeEnv = {
    NODE_ENV: 'test',
    PORT: 3000,
    API_KEY: 'fake-api-key',
    GITHUB_TOKEN: 'fake-token',
    GITHUB_HOST: 'fake-host',
    GIT_PEM_PATH: '/fake/key.pem',
    CLONE_DEST_DIR: './fake-repos',
    OPENAI_API_KEY: 'sk-test-fake-key',
    OPENAI_MODEL: 'gpt-4o-mini',
};

// Step 1: Mock @/env so tests can toggle OPENAI_API_KEY without touching real env vars.
jest.unstable_mockModule('@/env', () => ({
    env: fakeEnv,
}));

// Step 2: Mock @langchain/openai so invoke never calls the real OpenAI API or spends tokens.
jest.unstable_mockModule('@langchain/openai', () => ({
    ChatOpenAI: mockChatOpenAI,
}));

// Step 3: Mock @langchain/textsplitters to split text into deterministic chunks in tests.
jest.unstable_mockModule('@langchain/textsplitters', () => ({
    MarkdownTextSplitter: mockMarkdownSplitter,
    RecursiveCharacterTextSplitter: mockRecursiveSplitter,
}));

// Step 4: Mock node:fs/promises to simulate repository files and output directory writes.
jest.unstable_mockModule('node:fs/promises', () => ({
    mkdir: mockMkdir,
    readdir: mockReaddir,
    readFile: mockReadFile,
    writeFile: mockWriteFile,
}));

// Step 5: Dynamically import the service after mocks are registered.
const { LlmEstimatorAnalysisService } = await import('@/services/llm-estimator-analysis.service');

/**
 * Helper to create lightweight directory entry objects for mocked readdir calls.
 */
function makeDirent(name: string, kind: 'file' | 'directory'): FakeDirent {
    return {
        name,
        isDirectory: () => kind === 'directory',
        isFile: () => kind === 'file',
    };
}

/**
 * Splits a string into fixed-size slices for deterministic splitter mock behavior.
 */
function createSliceSplitter(options?: SplitterOptions) {
    const size = Math.max(20, options?.chunkSize ?? 1200);
    return {
        splitText: async (text: string): Promise<string[]> => {
            const chunks: string[] = [];
            for (let i = 0; i < text.length; i += size) {
                chunks.push(text.slice(i, i + size));
            }
            return chunks.length > 0 ? chunks : [text];
        },
    };
}

describe('LlmEstimatorAnalysisService', () => {
    beforeEach(() => {
        // Step 6: Reset all mocks and restore default fake environment and splitters before each test.
        jest.clearAllMocks();
        fakeEnv.OPENAI_API_KEY = 'sk-test-fake-key';
        fakeEnv.OPENAI_MODEL = 'gpt-4o-mini';

        mockMkdir.mockResolvedValue(undefined);
        mockReaddir.mockResolvedValue([]);
        mockReadFile.mockResolvedValue('');
        mockWriteFile.mockResolvedValue(undefined);
        mockMarkdownSplitter.mockImplementation((opts) => createSliceSplitter(opts));
        mockRecursiveSplitter.mockImplementation((opts) => createSliceSplitter(opts));
        mockInvoke.mockResolvedValue({
            content: '### Estimativa Consolidada\nPrazo estimado em poucos dias a 4h/dia.',
        });
        mockChatOpenAI.mockImplementation(() => ({
            invoke: mockInvoke,
        }));
    });

    /**
     * Verifies that generateConsolidatedAnalysis throws an error when OPENAI_API_KEY is missing.
     */
    it('deve lançar erro se OPENAI_API_KEY não estiver configurada', async () => {
        fakeEnv.OPENAI_API_KEY = '';

        const service = new LlmEstimatorAnalysisService();
        const estimatePath = resolve('/workspace/estimate/meu-repo/estimation.md');

        await expect(
            service.generateConsolidatedAnalysis({
                projects: [
                    {
                        projectName: 'meu-repo',
                        repoDir: '/repos/meu-repo',
                        estimateMarkdownPath: estimatePath,
                    },
                ],
                userGoalAndDetails: 'Estimar novo projeto semelhante',
            })
        ).rejects.toThrow('OPENAI_API_KEY não configurada no ambiente (.env).');

        expect(mockInvoke).not.toHaveBeenCalled();
        expect(mockWriteFile).not.toHaveBeenCalled();
    });

    /**
     * Verifies that generateConsolidatedAnalysis throws when no projects are supplied.
     */
    it('deve lançar erro quando nenhum projeto for informado', async () => {
        const service = new LlmEstimatorAnalysisService();

        await expect(
            service.generateConsolidatedAnalysis({
                projects: [],
                userGoalAndDetails: 'Landing page de produto',
            })
        ).rejects.toThrow('Nenhum projeto informado para análise consolidada.');

        expect(mockInvoke).not.toHaveBeenCalled();
        expect(mockWriteFile).not.toHaveBeenCalled();
    });

    /**
     * Verifies that generateConsolidatedAnalysis reads estimation.md across multiple projects,
     * invokes the mocked LangChain model once, and saves a single consolidated analysis.md.
     */
    it('deve analisar múltiplos estimation.md e gerar um único analysis.md consolidado', async () => {
        const outputDir = '/workspace/estimate';
        const repoA = '/repos/dswebWeb';
        const estimateA = resolve('/workspace/estimate/dswebWeb/estimation.md');
        const repoB = '/repos/imaginacaoArteWeb';
        const estimateB = resolve('/workspace/estimate/imaginacaoArteWeb/estimation.md');
        const expectedAnalysisPath = join(resolve(outputDir), 'analysis.md');

        mockReadFile.mockImplementation(async (targetPath: string) => {
            if (targetPath === estimateA) {
                return '# Estimativa de Horas — dswebWeb\n- **Base:** 12h';
            }
            if (targetPath === estimateB) {
                return '# Estimativa de Horas — imaginacaoArteWeb\n- **Base:** 8h';
            }
            if (targetPath === join(repoA, 'README.md')) {
                return '# DSWeb Web\nSite institucional e landing pages.';
            }
            return '';
        });

        mockReaddir.mockImplementation(async (dirPath: string) => {
            if (dirPath === repoA) {
                return [
                    makeDirent('.git', 'directory'),
                    makeDirent('node_modules', 'directory'),
                    makeDirent('README.md', 'file'),
                ];
            }
            return [];
        });

        let capturedHumanPrompt = '';
        mockInvoke.mockImplementation(async (messages: unknown[]) => {
            const msgList = messages as Array<{ content?: unknown }>;
            capturedHumanPrompt = typeof msgList[1]?.content === 'string' ? msgList[1].content : '';
            return { content: '### Estimativa Consolidada\nPrazo estimado em poucos dias a 4h/dia.' };
        });

        const service = new LlmEstimatorAnalysisService();
        const goalText = 'Landing page enxuta para divulgar um novo boné e clicar em Comprar agora.';

        const savedPath = await service.generateConsolidatedAnalysis({
            projects: [
                { projectName: 'dswebWeb', repoDir: repoA, estimateMarkdownPath: estimateA },
                {
                    projectName: 'imaginacaoArteWeb',
                    repoDir: repoB,
                    estimateMarkdownPath: estimateB,
                },
            ],
            userGoalAndDetails: goalText,
            outputDir,
        });

        // Step 7: Verify single consolidated output file, prompt contents from both projects, and single LLM call.
        expect(savedPath).toBe(expectedAnalysisPath);
        expect(mockChatOpenAI).toHaveBeenCalledTimes(1);
        expect(mockInvoke).toHaveBeenCalledTimes(1);
        expect(capturedHumanPrompt).toContain('## Projeto: dswebWeb');
        expect(capturedHumanPrompt).toContain('## Projeto: imaginacaoArteWeb');
        expect(capturedHumanPrompt).toContain('Base:** 12h');
        expect(capturedHumanPrompt).toContain('Base:** 8h');
        expect(mockMkdir).toHaveBeenCalledWith(resolve(outputDir), { recursive: true });
        expect(mockWriteFile).toHaveBeenCalledTimes(1);
        expect(mockWriteFile).toHaveBeenCalledWith(
            expectedAnalysisPath,
            expect.stringContaining('# Análise Consolidada de Custo e Tempo'),
            'utf-8'
        );
        expect(mockWriteFile).toHaveBeenCalledWith(
            expectedAnalysisPath,
            expect.stringContaining('**Projetos analisados:** dswebWeb, imaginacaoArteWeb'),
            'utf-8'
        );
        expect(mockWriteFile).toHaveBeenCalledWith(
            expectedAnalysisPath,
            expect.stringContaining(goalText),
            'utf-8'
        );
    });

    /**
     * Verifies that character budgets per project are respected when estimation reports are large.
     */
    it('deve respeitar o limite de caracteres por projeto ao consolidar estimativas grandes', async () => {
        const outputDir = '/workspace/estimate';
        const repoDir = '/repos/projeto-longo';
        const estimatePath = resolve('/workspace/estimate/projeto-longo/estimation.md');

        const longBlockA = 'A'.repeat(600);
        const longBlockB = 'B'.repeat(600);

        mockRecursiveSplitter.mockImplementation(() => ({
            splitText: async () => [longBlockA, longBlockB],
        }));

        mockReadFile.mockImplementation(async (targetPath: string) => {
            if (targetPath === estimatePath) {
                return `${longBlockA}${longBlockB}`;
            }
            return '';
        });

        let capturedPrompt = '';
        mockInvoke.mockImplementation(async (messages: unknown[]) => {
            const msgList = messages as Array<{ content?: unknown }>;
            capturedPrompt = typeof msgList[1]?.content === 'string' ? msgList[1].content : '';
            return { content: 'Análise respeitando limite de contexto.' };
        });

        const service = new LlmEstimatorAnalysisService();
        await service.generateConsolidatedAnalysis({
            projects: [
                { projectName: 'projeto-longo', repoDir, estimateMarkdownPath: estimatePath },
            ],
            userGoalAndDetails: 'Estimar nova landing page',
            includeRepoMarkdownDocs: false,
            maxCharsPerProject: 800,
            maxTotalChars: 3000,
        });

        // Step 8: With maxCharsPerProject = 800 and 70% estimation budget (~560 chars),
        // only the first 600-char chunk (or capped slice) fits while the second chunk is excluded.
        expect(capturedPrompt).toContain(longBlockA);
        expect(capturedPrompt).not.toContain(longBlockB);
    });
});