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

const mockInvoke = jest.fn<(messages: unknown[]) => Promise<{ content: unknown }>>();
const mockChatOpenAI = jest.fn<(options: Record<string, unknown>) => { invoke: typeof mockInvoke }>();
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

// Step 3: Mock node:fs/promises to simulate repository files and output directory writes.
jest.unstable_mockModule('node:fs/promises', () => ({
    mkdir: mockMkdir,
    readdir: mockReaddir,
    readFile: mockReadFile,
    writeFile: mockWriteFile,
}));

// Step 4: Dynamically import the service after mocks are registered.
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

describe('LlmEstimatorAnalysisService', () => {
    beforeEach(() => {
        // Step 5: Reset all mocks and restore default fake environment before each test.
        jest.clearAllMocks();
        fakeEnv.OPENAI_API_KEY = 'sk-test-fake-key';
        fakeEnv.OPENAI_MODEL = 'gpt-4o-mini';

        mockMkdir.mockResolvedValue(undefined);
        mockReaddir.mockResolvedValue([]);
        mockReadFile.mockResolvedValue('');
        mockWriteFile.mockResolvedValue(undefined);
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

        // Step 6: Verify output file path, single mocked LLM call, and written Markdown sections.
        expect(savedPath).toBe(expectedAnalysisPath);
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
     * Verifies that large Markdown files are truncated according to maxCharsPerFile
     * so the prompt stays lightweight and avoids token bloat.
     */
    it('deve truncar arquivos .md grandes respeitando maxCharsPerFile', async () => {
        const repoDir = '/repos/doc-pesada';
        const estimatePath = resolve('/workspace/estimate/doc-pesada/estimation.md');
        const longReadme = 'A'.repeat(200);

        mockReadFile.mockImplementation(async (targetPath: string) => {
            if (targetPath === estimatePath) {
                return 'Resumo da estimativa';
            }
            if (targetPath === join(repoDir, 'README.md')) {
                return longReadme;
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
            return { content: 'Análise com arquivo truncado.' };
        });

        const service = new LlmEstimatorAnalysisService();
        await service.generateAndSaveAnalysis({
            repoDir,
            estimateMarkdownPath: estimatePath,
            userGoalAndDetails: 'Avaliar esforço de documentação',
            maxCharsPerFile: 50,
            maxTotalChars: 5000,
        });

        expect(capturedPromptText).toContain('[...conteúdo truncado...]');
        expect(capturedPromptText).not.toContain('A'.repeat(200));
    });
});