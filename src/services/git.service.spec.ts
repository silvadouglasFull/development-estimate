import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { resolve } from 'node:path';

const mockExecFile = jest.fn();
const mockMkdir = jest.fn();

jest.unstable_mockModule('@/env', () => ({
    env: {
        GITHUB_TOKEN: 'fake-token',
        GIT_PEM_PATH: '/caminho/chave.pem',
        CLONE_DEST_DIR: './repos-teste',
    },
}));

jest.unstable_mockModule('node:child_process', () => ({
    execFile: mockExecFile,
}));

jest.unstable_mockModule('node:fs/promises', () => ({
    mkdir: mockMkdir,
}));

const { GitService } = await import('@/services/git.service');

describe('GitService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('deve garantir que o diretório de destino seja criado recursivamente', async () => {
        mockMkdir.mockResolvedValueOnce(undefined as never);

        const service = new GitService();
        await service.ensureDestinationExists();

        expect(mockMkdir).toHaveBeenCalledWith(resolve('./repos-teste'), {
            recursive: true,
        });
    });

    it('deve executar o git clone com --filter=blob:none, --no-checkout e a chave .pem no SSH', async () => {
        // Simula o comportamento padrão de callback do execFile usado pelo promisify
        mockExecFile.mockImplementationOnce(
            (_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
                const cb = callback as (err: Error | null, result?: { stdout: string; stderr: string }) => void;
                cb(null, { stdout: '', stderr: '' });
            },
        );

        const service = new GitService();
        const repoUrl = 'git@github.com:usuario/projeto.git';

        await service.cloneShallow(repoUrl);

        expect(mockExecFile).toHaveBeenCalledWith(
            'git',
            ['clone', '--filter=blob:none', '--no-checkout', repoUrl],
            expect.objectContaining({
                cwd: resolve('./repos-teste'),
                env: expect.objectContaining({
                    GIT_SSH_COMMAND: `ssh -i "${resolve('/caminho/chave.pem')}" -o IdentitiesOnly=yes`,
                }),
            }),
            expect.any(Function),
        );
    });

    it('deve repassar o erro caso o comando git falhe', async () => {
        mockExecFile.mockImplementationOnce(
            (_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
                const cb = callback as (err: Error | null) => void;
                cb(new Error('Permission denied (publickey)'));
            },
        );

        const service = new GitService();

        await expect(
            service.cloneShallow('git@github.com:usuario/projeto.git'),
        ).rejects.toThrow('Permission denied (publickey)');
    });
});
