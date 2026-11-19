import { env } from '@/env';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import * as path from 'path';
const execFileAsync = promisify(execFile);

export class GitService {
    private destDir: string;
    private pemPath: string;

    constructor() {
        this.destDir = resolve(env.CLONE_DEST_DIR);
        this.pemPath = resolve(env.GIT_PEM_PATH);
    }

    async ensureDestinationExists(): Promise<void> {
        await mkdir(this.destDir, { recursive: true });
    }

    async cloneShallow(repoUrl: string): Promise<void> {
        const repoUrlSubstitutedForGitHubHost = repoUrl.replace('github.com', env.GITHUB_HOST);

        const repoName = path.basename(repoUrl, '.git');
        const repoDir = path.join(this.destDir, repoName);

        const execOptions = {
            env: {
                ...process.env,
                GIT_SSH_COMMAND: `ssh -i "${this.pemPath}" -o IdentitiesOnly=yes`,
            },
        };

        await execFileAsync(
            'git',
            ['clone', '--filter=blob:none', '--no-checkout', repoUrlSubstitutedForGitHubHost],
            { ...execOptions, cwd: this.destDir }
        );

        await execFileAsync(
            'git',
            ['sparse-checkout', 'init', '--no-cone'],
            { ...execOptions, cwd: repoDir }
        );

        await execFileAsync(
            'git',
            ['sparse-checkout', 'set', '/*.md', '**/*.md'],
            { ...execOptions, cwd: repoDir }
        );

        await execFileAsync(
            'git',
            ['checkout'],
            { ...execOptions, cwd: repoDir }
        );
    }
}
