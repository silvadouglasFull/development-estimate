import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { resolve } from 'node:path';

/**
 * Callback type expected by Node's child_process.execFile.
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
const mockAccess = jest.fn<(path: string) => Promise<void>>();
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

// Step 3: Mock fs/promises access and mkdir to avoid touching real filesystem during tests.
jest.unstable_mockModule('node:fs/promises', () => ({
    access: mockAccess,
    mkdir: mockMkdir,
}));

// Step 4: Dynamically import GitService after mocks are registered.
const { GitService } = await import('@/services/git.service');

/**
 * Configures mockExecFile to succeed on every git command called.
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
        mockAccess.mockRejectedValue(new Error('ENOENT'));
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
     * Verifies that isRepositoryCloned returns true when the repository folder exists
     * and false when it does not exist.
     */
    it('deve retornar true se o repositório já foi clonado e false caso contrário', async () => {
        const service = new GitService();
        const expectedRepoDir = `${resolve('./fake-repos')}/projeto`;

        mockAccess.mockResolvedValueOnce(undefined);
        await expect(service.isRepositoryCloned('git@github.com:usuario/projeto.git')).resolves.toBe(
            true
        );
        expect(mockAccess).toHaveBeenCalledWith(expectedRepoDir);

        mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
        await expect(service.isRepositoryCloned('projeto')).resolves.toBe(false);
    });

    /**
     * Verifies that listBranches reads remote-tracking branches locally when already cloned.
     */
    it('deve listar as branches localmente quando o repositório já estiver clonado', async () => {
        // Step 5: Simulate existing local clone and `git branch -r` output.
        mockAccess.mockResolvedValueOnce(undefined);
        mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
            if (typeof callback === 'function') {
                callback(
                    null,
                    '  origin/HEAD -> origin/main\n  origin/main\n  origin/prod-v1.0\n',
                    ''
                );
            }
        });

        const service = new GitService();
        const branches = await service.listBranches('git@github.com:usuario/projeto.git');

        expect(branches).toEqual(['main', 'prod-v1.0']);
        expect(mockExecFile).toHaveBeenCalledWith(
            'git',
            ['branch', '-r'],
            expect.objectContaining({ cwd: `${resolve('./fake-repos')}/projeto` }),
            expect.any(Function)
        );
    });

    /**
     * Verifies that listBranches queries remote heads over SSH when not yet cloned.
     */
    it('deve listar as branches remotas via ls-remote quando o repositório ainda não foi clonado', async () => {
        // Step 6: Keep repository uncloned so `git ls-remote --heads` is used with SSH.
        mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
        mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
            if (typeof callback === 'function') {
                callback(
                    null,
                    '1111111\trefs/heads/main\n2222222\trefs/heads/develop\n',
                    ''
                );
            }
        });

        const service = new GitService();
        const branches = await service.listBranches('git@github.com:usuario/projeto.git');

        const expectedSshCommand = `ssh -i "${resolve('/fake/key.pem')}" -o IdentitiesOnly=yes`;

        expect(branches).toEqual(['main', 'develop']);
        expect(mockExecFile).toHaveBeenCalledWith(
            'git',
            ['ls-remote', '--heads', 'git@fake-host:usuario/projeto.git'],
            expect.objectContaining({
                env: expect.objectContaining({
                    GIT_SSH_COMMAND: expectedSshCommand,
                }),
            }),
            expect.any(Function)
        );
    });

    /**
     * Verifies that pullBranch executes `git pull origin <branch>` inside the repository folder.
     */
    it('deve atualizar o repositório com git pull origin na branch selecionada', async () => {
        mockSuccessfulGitSequence();

        const service = new GitService();
        await service.pullBranch('git@github.com:usuario/projeto.git', 'develop');

        const expectedRepoDir = `${resolve('./fake-repos')}/projeto`;
        const expectedSshCommand = `ssh -i "${resolve('/fake/key.pem')}" -o IdentitiesOnly=yes`;

        expect(mockExecFile).toHaveBeenCalledTimes(1);
        expect(mockExecFile).toHaveBeenCalledWith(
            'git',
            ['pull', 'origin', 'develop'],
            expect.objectContaining({
                cwd: expectedRepoDir,
                env: expect.objectContaining({
                    GIT_SSH_COMMAND: expectedSshCommand,
                }),
            }),
            expect.any(Function)
        );
    });

    /**
     * Verifies that cloneShallow calls pullBranch when the repository already exists.
     */
    it('deve chamar pullBranch quando o repositório já estiver clonado no diretório de destino', async () => {
        mockAccess.mockResolvedValueOnce(undefined);
        mockSuccessfulGitSequence();

        const service = new GitService();
        await service.cloneShallow('git@github.com:usuario/projeto.git', 'main');

        const expectedRepoDir = `${resolve('./fake-repos')}/projeto`;

        expect(mockExecFile).toHaveBeenCalledTimes(1);
        expect(mockExecFile).toHaveBeenCalledWith(
            'git',
            ['pull', 'origin', 'main'],
            expect.objectContaining({ cwd: expectedRepoDir }),
            expect.any(Function)
        );
    });

    /**
     * Verifies that cloneShallow rewrites the host, configures GIT_SSH_COMMAND with the .pem key,
     * and runs all four git steps in order when repository is not yet cloned.
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