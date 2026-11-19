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
            content: '### Resumo da Análise\nEstimativa coerente com o escopo descrito.',
        });
        mockChatOpenAI.mockImplementation(() => ({
            invoke: mockInvoke,
        }));
    });

    /**
     * Verifies that generateAndSaveAnalysis throws an error when OPENAI_API_KEY is missing.
     */
    it('deve lançar erro se OPENAI_API_KEY não estiver configurada', async () => {
        fakeEnv.OPENAI_API_KEY = '';

        const service = new LlmEstimatorAnalysisService();
        const estimatePath = resolve('/workspace/estimate/meu-repo/estimation.md');

        await expect(
            service.generateAndSaveAnalysis({
                repoDir: '/repos/meu-repo',
                estimateMarkdownPath: estimatePath,
                userGoalAndDetails: 'Estimar novo projeto semelhante',
            })
        ).rejects.toThrow('OPENAI_API_KEY não configurada no ambiente (.env).');

        expect(mockInvoke).not.toHaveBeenCalled();
        expect(mockWriteFile).not.toHaveBeenCalled();
    });

    /**
     * Verifies that generateAndSaveAnalysis reads estimation.md and repo Markdown files,
     * invokes the mocked LangChain model once, and saves analysis.md in estimate/<REPO>.
     */
    it('deve gerar analysis.md com a resposta simulada do LLM sem chamar API real', async () => {
        const repoDir = '/repos/dswebWeb';
        const estimatePath = resolve('/workspace/estimate/dswebWeb/estimation.md');
        const expectedAnalysisPath = join(resolve('/workspace/estimate/dswebWeb'), 'analysis.md');

        mockReadFile.mockImplementation(async (targetPath: string) => {
            if (targetPath === estimatePath) {
                return '# Estimativa de Horas — dswebWeb\n- **Base:** 10h';
            }
            if (targetPath === join(repoDir, 'README.md')) {
                return '# DSWeb Web\nSistema web institucional.';
            }
            if (targetPath === join(repoDir, 'docs/guia.md')) {
                return '# Guia\nDetalhes de deploy.';
            }
            return '';
        });

        mockReaddir.mockImplementation(async (dirPath: string) => {
            if (dirPath === repoDir) {
                return [
                    makeDirent('.git', 'directory'),
                    makeDirent('node_modules', 'directory'),
                    makeDirent('docs', 'directory'),
                    makeDirent('README.md', 'file'),
                    makeDirent('package.json', 'file'),
                ];
            }
            if (dirPath === join(repoDir, 'docs')) {
                return [makeDirent('guia.md', 'file')];
            }
            return [];
        });

        const service = new LlmEstimatorAnalysisService();
        const savedPath = await service.generateAndSaveAnalysis({
            repoDir,
            estimateMarkdownPath: estimatePath,
            userGoalAndDetails: 'Quero criar um novo projeto parecido e estimar prazo e valor.',
        });

        // Step 7: Verify output file path, splitter usage, single mocked LLM call, and saved Markdown.
        expect(savedPath).toBe(expectedAnalysisPath);
        expect(mockRecursiveSplitter).toHaveBeenCalledTimes(1);
        expect(mockMarkdownSplitter).toHaveBeenCalledTimes(2);
        expect(mockChatOpenAI).toHaveBeenCalledTimes(1);
        expect(mockInvoke).toHaveBeenCalledTimes(1);
        expect(mockMkdir).toHaveBeenCalledWith(resolve('/workspace/estimate/dswebWeb'), {
            recursive: true,
        });
        expect(mockWriteFile).toHaveBeenCalledWith(
            expectedAnalysisPath,
            expect.stringContaining('# Análise de Estimativa com LLM — dswebWeb'),
            'utf-8'
        );
        expect(mockWriteFile).toHaveBeenCalledWith(
            expectedAnalysisPath,
            expect.stringContaining('Quero criar um novo projeto parecido e estimar prazo e valor.'),
            'utf-8'
        );
        expect(mockWriteFile).toHaveBeenCalledWith(
            expectedAnalysisPath,
            expect.stringContaining('Estimativa coerente com o escopo descrito.'),
            'utf-8'
        );
    });

    /**
     * Verifies that chunks are joined up to maxCharsPerFile and remaining chunks are omitted cleanly.
     */
    it('deve juntar trechos até maxCharsPerFile e sinalizar quando houver trechos omitidos', async () => {
        const repoDir = '/repos/doc-pesada';
        const estimatePath = resolve('/workspace/estimate/doc-pesada/estimation.md');

        // Step 8: Use distinct markers so we confirm multiple chunks are joined and excess is omitted.
        const chunkA = 'A'.repeat(200);
        const chunkB = 'B'.repeat(200);
        const chunkC = 'C'.repeat(200);

        mockMarkdownSplitter.mockImplementation(() => ({
            splitText: async () => [chunkA, chunkB, chunkC],
        }));

        mockReadFile.mockImplementation(async (targetPath: string) => {
            if (targetPath === estimatePath) {
                return 'Resumo da estimativa';
            }
            if (targetPath === join(repoDir, 'README.md')) {
                return `${chunkA}${chunkB}${chunkC}`;
            }
            return '';
        });

        mockReaddir.mockImplementation(async (dirPath: string) => {
            if (dirPath === repoDir) {
                return [makeDirent('README.md', 'file')];
            }
            return [];
        });

        let capturedPromptText = '';
        mockInvoke.mockImplementation(async (messages: unknown[]) => {
            const msgList = messages as Array<{ content?: unknown }>;
            const humanMsg = msgList[1];
            capturedPromptText = typeof humanMsg?.content === 'string' ? humanMsg.content : '';
            return { content: 'Análise com trechos agrupados.' };
        });

        const service = new LlmEstimatorAnalysisService();
        await service.generateAndSaveAnalysis({
            repoDir,
            estimateMarkdownPath: estimatePath,
            userGoalAndDetails: 'Avaliar esforço de documentação',
            maxCharsPerFile: 450,
            maxTotalChars: 5000,
        });

        expect(capturedPromptText).toContain(chunkA);
        expect(capturedPromptText).toContain(chunkB);
        expect(capturedPromptText).not.toContain(chunkC);
        expect(capturedPromptText).toContain(
            '[...trechos adicionais omitidos para respeitar o limite...]'
        );
    });
});