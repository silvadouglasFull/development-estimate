import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockPaginate = jest.fn<(...args: unknown[]) => Promise<unknown[]>>();
const mockListRepos = jest.fn();

// Step 1: Mock environment variables before importing GitHubService.
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

// Step 2: Mock Octokit SDK so no real HTTP requests are made to GitHub.
jest.unstable_mockModule('octokit', () => ({
    Octokit: jest.fn().mockImplementation(() => ({
        paginate: mockPaginate,
        rest: {
            repos: {
                listForAuthenticatedUser: mockListRepos,
            },
        },
    })),
}));

// Step 3: Dynamically import GitHubService after mocks are registered.
const { GitHubService } = await import('@/services/github.service');

describe('GitHubService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    /**
     * Verifies that listRepositories paginates user repositories and maps them to Repository objects.
     */
    it('deve listar e formatar os repositórios do usuário autenticado', async () => {
        mockPaginate.mockResolvedValueOnce([
            {
                full_name: 'usuario/repo-privado',
                ssh_url: 'git@fake-host:usuario/repo-privado.git',
                private: true,
            },
            {
                full_name: 'usuario/repo-publico',
                ssh_url: 'git@fake-host:usuario/repo-publico.git',
                private: false,
            },
        ]);

        const service = new GitHubService();
        const result = await service.listRepositories();

        expect(mockPaginate).toHaveBeenCalledWith(mockListRepos, {
            per_page: 100,
            sort: 'updated',
        });

        expect(result).toEqual([
            {
                fullName: 'usuario/repo-privado',
                sshUrl: 'git@fake-host:usuario/repo-privado.git',
                isPrivate: true,
            },
            {
                fullName: 'usuario/repo-publico',
                sshUrl: 'git@fake-host:usuario/repo-publico.git',
                isPrivate: false,
            },
        ]);
    });

    /**
     * Verifies that listRepositories returns an empty array when no repositories are returned.
     */
    it('deve retornar uma lista vazia quando não houver repositórios', async () => {
        mockPaginate.mockResolvedValueOnce([]);

        const service = new GitHubService();
        const result = await service.listRepositories();

        expect(result).toEqual([]);
    });
});