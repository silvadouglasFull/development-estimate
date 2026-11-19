import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockPaginate = jest.fn();
const mockListRepos = jest.fn();

// Mocka o arquivo de ambiente para não exigir um .env real nos testes
jest.unstable_mockModule('@/env', () => ({
    env: {
        GITHUB_TOKEN: 'fake-token',
        GIT_PEM_PATH: '/fake/key.pem',
        CLONE_DEST_DIR: './fake-repos',
    },
}));

// Mocka o SDK do Octokit
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

// Importa o serviço dinamicamente após registrar os mocks
const { GitHubService } = await import('@/services/github.service');

describe('GitHubService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('deve listar e formatar os repositórios do usuário autenticado', async () => {
        mockPaginate.mockResolvedValueOnce([
            {
                full_name: 'usuario/repo-privado',
                ssh_url: 'git@github.com:usuario/repo-privado.git',
                private: true,
            },
            {
                full_name: 'usuario/repo-publico',
                ssh_url: 'git@github.com:usuario/repo-publico.git',
                private: false,
            },
        ] as never);

        const service = new GitHubService();
        const result = await service.listRepositories();

        expect(mockPaginate).toHaveBeenCalledWith(mockListRepos, {
            per_page: 100,
            sort: 'updated',
        });

        expect(result).toEqual([
            {
                fullName: 'usuario/repo-privado',
                sshUrl: 'git@github.com:usuario/repo-privado.git',
                isPrivate: true,
            },
            {
                fullName: 'usuario/repo-publico',
                sshUrl: 'git@github.com:usuario/repo-publico.git',
                isPrivate: false,
            },
        ]);
    });

    it('deve retornar uma lista vazia quando não houver repositórios', async () => {
        mockPaginate.mockResolvedValueOnce([] as never);

        const service = new GitHubService();
        const result = await service.listRepositories();

        expect(result).toEqual([]);
    });
});
