import { env } from '@/env';
import type { Repository } from '@/types/repository';
import { Octokit } from 'octokit';

export class GitHubService {
    private octokit: Octokit;

    constructor() {
        this.octokit = new Octokit({ auth: env.GITHUB_TOKEN });
    }

    async listRepositories(): Promise<Repository[]> {
        const repos = await this.octokit.paginate(
            this.octokit.rest.repos.listForAuthenticatedUser,
            {
                per_page: 100,
                sort: 'updated',
            },
        );

        return repos.map((repo) => ({
            fullName: repo.full_name,
            sshUrl: repo.ssh_url,
            isPrivate: repo.private,
        }));
    }
}
