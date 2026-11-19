import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { resolve } from 'node:path';

/**
 * Callback signature expected by Node's child_process.execFile.
 */
type ExecFileCallback = (err: Error | null, stdout?: string, stderr?: string) => void;

/**
 * Mock signature for execFile invocations inside unit tests.
 */
type ExecFileMockFn = (
    cmd: string,
    args: string[],
    options: Record<string, unknown>,
    callback?: ExecFileCallback
) => void;

const mockExecFile = jest.fn<ExecFileMockFn>();
const mockMkdir = jest.fn<(path: string, options?: { recursive?: boolean }) => Promise<string | undefined>>();

// Step 1: Mock environment variables before importing GitService.
jest.unstable_mockModule('@/env', () => ({
    env: {
        NODE_ENV: 'test',
        PORT: 3000,
        API_KEY: 'fake-api-key',
        GITHUB_TOKEN: 'fake-token',
        GITHUB_HOST: 'fake-host',
        GIT_PEM_PATH: '/fake/key.pem',
        CLONE_DEST_DIR: './fake-repos',
    },
}));

// Step 2: Mock child_process.execFile and its custom promisify behavior.
jest.unstable_mockModule('node:child_process', () => {
    const execFileFn = Object.assign(mockExecFile, {
        [Symbol.for('nodejs.util.promisify.custom')]: (
            cmd: string,
            args: string[],
            options: Record<string, unknown>
        ) =>
            new Promise<{ stdout: string; stderr: string }>((res, rej) => {
                mockExecFile(cmd, args, options, (err, stdout = '', stderr = '') => {
                    if (err) {
                        rej(err);
                        return;
                    }
                    res({ stdout, stderr });
                });
            }),
    });

    return {
        execFile: execFileFn,
    };
});

// Step 3: Mock fs/promises mkdir to avoid creating real directories during tests.
jest.unstable_mockModule('node:fs/promises', () => ({
    mkdir: mockMkdir,
}));

// Step 4: Dynamically import GitService after mocks are registered.
const { GitService } = await import('@/services/git.service');

/**
 * Configures mockExecFile to succeed on every git command called by cloneShallow.
 */
function mockSuccessfulGitSequence(): void {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        if (typeof callback === 'function') {
            callback(null, '', '');
        }
    });
}

describe('GitService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockMkdir.mockResolvedValue(undefined);
    });

    /**
     * Verifies that ensureDestinationExists creates the destination folder recursively.
     */
    it('deve criar o diretório de destino de forma recursiva', async () => {
        const service = new GitService();
        await service.ensureDestinationExists();

        expect(mockMkdir).toHaveBeenCalledWith(resolve('./fake-repos'), {
            recursive: true,
        });
    });

    /**
     * Verifies that cloneShallow rewrites the host, configures GIT_SSH_COMMAND with the .pem key,
     * and runs all four git steps in order.
     */
    it('deve executar o clone shallow, sparse-checkout e checkout com a chave SSH', async () => {
        mockSuccessfulGitSequence();

        const service = new GitService();
        await service.cloneShallow('git@github.com:usuario/projeto.git');

        expect(mockExecFile).toHaveBeenCalledTimes(4);

        const expectedPemPath = resolve('/fake/key.pem');
        const expectedDestDir = resolve('./fake-repos');
        const expectedRepoDir = `${expectedDestDir}/projeto`;
        const expectedSshCommand = `ssh -i "${expectedPemPath}" -o IdentitiesOnly=yes`;

        expect(mockExecFile).toHaveBeenNthCalledWith(
            1,
            'git',
            ['clone', '--filter=blob:none', '--no-checkout', 'git@fake-host:usuario/projeto.git'],
            expect.objectContaining({
                cwd: expectedDestDir,
                env: expect.objectContaining({
                    GIT_SSH_COMMAND: expectedSshCommand,
                }),
            }),
            expect.any(Function)
        );

        expect(mockExecFile).toHaveBeenNthCalledWith(
            2,
            'git',
            ['sparse-checkout', 'init', '--no-cone'],
            expect.objectContaining({ cwd: expectedRepoDir }),
            expect.any(Function)
        );

        expect(mockExecFile).toHaveBeenNthCalledWith(
            3,
            'git',
            ['sparse-checkout', 'set', '/*.md', '**/*.md'],
            expect.objectContaining({ cwd: expectedRepoDir }),
            expect.any(Function)
        );

        expect(mockExecFile).toHaveBeenNthCalledWith(
            4,
            'git',
            ['checkout'],
            expect.objectContaining({ cwd: expectedRepoDir }),
            expect.any(Function)
        );
    });
});