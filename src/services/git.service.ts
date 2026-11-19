import { env } from '@/env';
import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import * as path from 'path';

const execFileAsync = promisify(execFile);

/**
 * Service responsible for cloning repositories shallowly, checking local clone status,
 * listing branches, and updating existing branches via git pull.
 */
export class GitService {
    private destDir: string;
    private pemPath: string;
    private defaultPullBranch = 'main';

    constructor() {
        // Step 1: Resolve destination directory and SSH PEM key path from environment variables.
        this.destDir = resolve(env.CLONE_DEST_DIR);
        this.pemPath = resolve(env.GIT_PEM_PATH);
    }

    /**
     * Ensures the destination directory exists before cloning or checking repositories.
     */
    async ensureDestinationExists(): Promise<void> {
        await mkdir(this.destDir, { recursive: true });
    }

    /**
     * Checks whether the repository already exists inside the destination directory.
     * Returns strictly true or false.
     */
    async isRepositoryCloned(repoNameOrUrl: string): Promise<boolean> {
        // Step 2: Resolve local repository folder path and verify existence with fs.access.
        const repoDir = this.resolveRepoDir(repoNameOrUrl);

        try {
            await access(repoDir);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Lists branch names for a repository (locally when cloned, or from remote via SSH if not yet cloned).
     */
    async listBranches(repoNameOrUrl: string): Promise<string[]> {
        // Step 3: If already cloned locally, read branches offline from the local git directory.
        const alreadyCloned = await this.isRepositoryCloned(repoNameOrUrl);
        if (alreadyCloned) {
            const repoDir = this.resolveRepoDir(repoNameOrUrl);
            const { stdout } = await execFileAsync('git', ['branch', '-r'], {
                cwd: repoDir,
                maxBuffer: 5 * 1024 * 1024,
            });

            const branches = stdout
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0 && !line.includes('->'))
                .map((line) => line.replace(/^remotes\//, '').replace(/^origin\//, '').trim())
                .filter((branch) => branch.length > 0);

            return Array.from(new Set(branches));
        }

        // Step 4: If not cloned yet, query remote heads over SSH using `git ls-remote --heads`.
        const repoUrlSubstitutedForGitHubHost = repoNameOrUrl.replace('github.com', env.GITHUB_HOST);
        const execOptions = this.buildSshExecOptions();

        const { stdout } = await execFileAsync(
            'git',
            ['ls-remote', '--heads', repoUrlSubstitutedForGitHubHost],
            execOptions
        );

        const remoteBranches = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => {
                const refPart = line.split(/\s+/)[1] ?? '';
                return refPart.replace(/^refs\/heads\//, '').trim();
            })
            .filter((branch) => branch.length > 0);

        return Array.from(new Set(remoteBranches));
    }

    /**
     * Updates an existing local repository by running `git pull origin <branchName>`.
     */
    async pullBranch(repoNameOrUrl: string, branchName: string): Promise<void> {
        // Step 5: Validate branch name and run git pull origin <branchName> inside repoDir.
        const normalizedBranch = branchName.trim();
        if (!normalizedBranch) {
            throw new Error('Branch name is required to run git pull.');
        }

        const repoDir = this.resolveRepoDir(repoNameOrUrl);
        const execOptions = this.buildSshExecOptions();

        await execFileAsync(
            'git',
            ['pull', 'origin', normalizedBranch],
            { ...execOptions, cwd: repoDir }
        );
    }

    /**
     * Clones a repository shallowly with sparse-checkout for Markdown files,
     * or pulls the branch if the repository already exists in the destination folder.
     */
    async cloneShallow(repoUrl: string, branchName: string = this.defaultPullBranch): Promise<void> {
        // Step 6: If the repository is already present in destDir, pull the branch instead.
        const alreadyCloned = await this.isRepositoryCloned(repoUrl);
        if (alreadyCloned) {
            await this.pullBranch(repoUrl, branchName);
            return;
        }

        const repoUrlSubstitutedForGitHubHost = repoUrl.replace('github.com', env.GITHUB_HOST);
        const repoDir = this.resolveRepoDir(repoUrl);
        const execOptions = this.buildSshExecOptions();

        // Step 7: Attempt shallow clone; if git reports destination already exists, pull instead.
        try {
            await execFileAsync(
                'git',
                ['clone', '--filter=blob:none', '--no-checkout', repoUrlSubstitutedForGitHubHost],
                { ...execOptions, cwd: this.destDir }
            );
        } catch (error) {
            if (this.isAlreadyExistsError(error)) {
                await this.pullBranch(repoUrl, branchName);
                return;
            }
            throw error;
        }

        // Step 8: Configure sparse-checkout for Markdown files and check out working tree.
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

    /**
     * Resolves the local repository directory path from a repository URL or folder name.
     */
    private resolveRepoDir(repoNameOrUrl: string): string {
        const repoName = path.basename(repoNameOrUrl, '.git');
        return path.join(this.destDir, repoName);
    }

    /**
     * Builds child_process execution options configured with the SSH private key.
     */
    private buildSshExecOptions() {
        return {
            env: {
                ...process.env,
                GIT_SSH_COMMAND: `ssh -i "${this.pemPath}" -o IdentitiesOnly=yes`,
            },
        };
    }

    /**
     * Detects whether a git clone error indicates the target directory already exists.
     */
    private isAlreadyExistsError(error: unknown): boolean {
        if (!error || typeof error !== 'object') {
            return false;
        }

        const errObj = error as { message?: string; stderr?: string };
        const combinedMessage = `${errObj.message ?? ''} ${errObj.stderr ?? ''}`.toLowerCase();

        return (
            combinedMessage.includes('already exists') ||
            combinedMessage.includes('já existe') ||
            combinedMessage.includes('destination path')
        );
    }
}