import { env } from '@/env';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

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
        await execFileAsync(
            'git',
            ['clone', '--filter=blob:none', '--no-checkout', repoUrl],
            {
                cwd: this.destDir,
                env: {
                    ...process.env,
                    GIT_SSH_COMMAND: `ssh -i "${this.pemPath}" -o IdentitiesOnly=yes`,
                },
            },
        );
    }
}
