import { DEFAULT_HOUR_ESTIMATION_CONFIG, DEFAULT_WORK_LOG_FILTERS } from '@/services/constants/git-work-hours-estimator-service.constants';
import type { WorkHourEstimator } from '@/services/interfaces/work-hour-estimator.interface';
import type {
    CommitWorkItem,
    HourEstimationConfig,
    WorkHourMetrics,
    WorkLogFilters,
} from '@/types/work-hour-estimator.types';
import { execFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Extended filter options supporting an optional target branch.
 */
export type BranchWorkLogFilters = WorkLogFilters & {
    branch?: string;
};

/**
 * Service that reads git commit logs, estimates work hour ranges, and exports Markdown reports.
 */
export class GitWorkHourEstimatorService implements WorkHourEstimator {
    private readonly fieldSeparator = '\x1f';
    private readonly recordSeparator = '\x1e';
    private readonly defaultConfig: HourEstimationConfig;
    private readonly defaultFilters: BranchWorkLogFilters;
    private readonly estimatesRootDir = 'estimate';
    private readonly reportFileName = 'estimation.md';
    private readonly preferredMainBranches = ['main', 'master', 'develop'];

    constructor(
        defaultFilters: BranchWorkLogFilters = DEFAULT_WORK_LOG_FILTERS,
        defaultConfig: HourEstimationConfig = DEFAULT_HOUR_ESTIMATION_CONFIG
    ) {
        this.defaultFilters = { ...defaultFilters };
        this.defaultConfig = { ...defaultConfig };
    }

    /**
     * Normalizes a branch name for display in metrics and Markdown reports (e.g. `origin/prod-v1.0` -> `prod-v1.0`).
     */
    private normalizeBranchDisplayName(branch: string): string {
        // Step 1: Strip remote prefixes while keeping `HEAD` intact if no branch exists.
        const trimmed = branch.trim();
        if (!trimmed || trimmed === 'HEAD') {
            return trimmed || 'HEAD';
        }

        return trimmed.replace(/^remotes\//, '').replace(/^origin\//, '').trim() || trimmed;
    }

    /**
     * Discovers the repository's default/main branch offline using `git branch -r`.
     */
    public async detectDefaultBranch(repoDir: string): Promise<string> {
        // Step 2: Query remote-tracking branches locally without touching the network.
        const { stdout } = await execFileAsync('git', ['branch', '-r'], {
            cwd: repoDir,
            maxBuffer: 5 * 1024 * 1024,
        });

        const lines = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

        if (lines.length === 0) {
            return 'HEAD';
        }

        // Step 3: Check for an explicit symbolic pointer like "origin/HEAD -> origin/main".
        const headPointerLine = lines.find((line) => line.includes('->'));
        if (headPointerLine) {
            const targetRef = headPointerLine.split('->').pop()?.trim() ?? '';
            const normalizedTarget = this.normalizeBranchDisplayName(targetRef);
            if (normalizedTarget.length > 0) {
                return normalizedTarget;
            }
        }

        // Step 4: Normalize remote branch names (e.g. "origin/main" -> "main").
        const normalizedBranches = lines
            .filter((line) => !line.includes('->'))
            .map((line) => this.normalizeBranchDisplayName(line))
            .filter((branch) => branch.length > 0);

        // Step 5: Prefer standard main branch names if present.
        for (const candidate of this.preferredMainBranches) {
            if (normalizedBranches.includes(candidate)) {
                return candidate;
            }
        }

        // Step 6: Fallback to the first available remote branch or HEAD.
        return normalizedBranches[0] ?? 'HEAD';
    }

    /**
     * Resolves which clean branch name should be inspected and reported:
     * user-specified branch or offline default branch.
     */
    public async resolveTargetBranch(repoDir: string, requestedBranch?: string): Promise<string> {
        const trimmed = requestedBranch?.trim();
        if (trimmed) {
            return this.normalizeBranchDisplayName(trimmed);
        }

        return this.detectDefaultBranch(repoDir);
    }

    /**
     * Checks offline whether a git revision/branch reference exists locally in the repository.
     */
    private async isValidGitRef(repoDir: string, ref: string): Promise<boolean> {
        // Step 7: Verify local git reference existence offline using `git rev-parse --verify`.
        try {
            await execFileAsync('git', ['rev-parse', '--verify', '--quiet', ref], {
                cwd: repoDir,
                maxBuffer: 1024 * 1024,
            });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Resolves a clean branch name to an internal git ref (e.g. `origin/prod-v1.0` or `prod-v1.0`)
     * used only when running `git log`.
     */
    private async resolveGitLogRef(repoDir: string, cleanBranch: string): Promise<string> {
        // Step 8: Build candidate references so remote-only branches like `origin/prod-v1.0` work in `git log`.
        const withoutOrigin = this.normalizeBranchDisplayName(cleanBranch);
        const candidates = Array.from(
            new Set([`origin/${withoutOrigin}`, withoutOrigin, cleanBranch, 'HEAD'].filter(Boolean))
        );

        for (const candidate of candidates) {
            if (await this.isValidGitRef(repoDir, candidate)) {
                return candidate;
            }
        }

        return withoutOrigin || 'HEAD';
    }

    /**
     * Reads commits and changed files from the repository for the selected or default branch.
     */
    public async getWorkItems(
        repoDir: string,
        filters?: BranchWorkLogFilters
    ): Promise<CommitWorkItem[]> {
        // Step 9: Resolve active filters (defaults to 90 days ago and all authors).
        const resolvedFilters = this.resolveFilters(filters);

        // Step 10: Resolve clean branch name and map to an internal git ref solely for `git log`.
        const targetBranch = await this.resolveTargetBranch(repoDir, resolvedFilters.branch);
        const gitLogRef = await this.resolveGitLogRef(repoDir, targetBranch);

        // Step 11: Build git log command arguments with safe field and record delimiters.
        const header = ['%H', '%an', '%aI', '%s'].join(this.fieldSeparator);
        const args = [
            'log',
            gitLogRef,
            `--pretty=format:${this.recordSeparator}${header}${this.fieldSeparator}`,
            '--name-only',
        ];

        if (resolvedFilters.since) {
            args.push(`--since=${resolvedFilters.since}`);
        }
        if (resolvedFilters.until) {
            args.push(`--until=${resolvedFilters.until}`);
        }
        if (resolvedFilters.author) {
            args.push(`--author=${resolvedFilters.author}`);
        }

        // Step 12: Run git log inside the target repository directory.
        const { stdout } = await execFileAsync('git', args, {
            cwd: repoDir,
            maxBuffer: 15 * 1024 * 1024,
        });

        // Step 13: Parse stdout chunks into structured CommitWorkItem objects.
        return stdout
            .split(this.recordSeparator)
            .map((chunk) => chunk.trim())
            .filter((chunk) => chunk.length > 0)
            .map((chunk) => {
                const [hash = '', authorName = '', authoredAt = '', subject = '', filesRaw = ''] =
                    chunk.split(this.fieldSeparator);

                const filesChanged = filesRaw
                    .trim()
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0);

                return {
                    hash: hash.trim(),
                    authorName: authorName.trim(),
                    authoredAt: authoredAt.trim(),
                    subject: subject.trim(),
                    filesChanged,
                };
            });
    }

    /**
     * Calculates active days, file touch counts, and optimistic/base/conservative hour estimates.
     */
    public calculateHourMetrics(
        items: CommitWorkItem[],
        config: HourEstimationConfig = this.defaultConfig,
        appliedFilters: BranchWorkLogFilters = this.defaultFilters
    ): WorkHourMetrics {
        if (items.length === 0) {
            return {
                totalCommits: 0,
                activeDays: 0,
                commitsPerActiveDay: 0,
                uniqueFilesTouched: 0,
                totalFileTouches: 0,
                appliedFilters,
                optimisticHours: 0,
                baseHours: 0,
                conservativeHours: 0,
                subjectPrefixes: {},
            };
        }

        // Step 14: Group commits by calendar day (YYYY-MM-DD) so multiple commits in one day
        // count as a single active work day.
        const activeDaySet = new Set<string>();
        const uniqueFilesSet = new Set<string>();
        const subjectPrefixes: Record<string, number> = {};
        let totalFileTouches = 0;

        for (const item of items) {
            const dayKey = item.authoredAt.slice(0, 10);
            if (dayKey) {
                activeDaySet.add(dayKey);
            }

            totalFileTouches += item.filesChanged.length;
            for (const file of item.filesChanged) {
                uniqueFilesSet.add(file);
            }

            const prefixMatch = item.subject.match(/^([a-zA-Z0-9_-]+)(?:\(.+\))?:/);
            const prefix = prefixMatch ? prefixMatch[1] : 'other';
            subjectPrefixes[prefix] = (subjectPrefixes[prefix] ?? 0) + 1;
        }

        const activeDays = activeDaySet.size;
        const totalCommits = items.length;
        const uniqueFilesTouched = uniqueFilesSet.size;
        const commitsPerActiveDay = Number((totalCommits / Math.max(1, activeDays)).toFixed(2));

        // Step 15: Compute base hours from active days and unique files, then derive
        // optimistic and conservative hour ranges.
        const rawBaseHours =
            activeDays * config.hoursPerActiveDay + uniqueFilesTouched * config.hoursPerUniqueFile;
        const baseHours = Number(rawBaseHours.toFixed(1));
        const optimisticHours = Number((baseHours * config.optimisticFactor).toFixed(1));
        const conservativeHours = Number((baseHours * config.conservativeFactor).toFixed(1));

        return {
            totalCommits,
            activeDays,
            commitsPerActiveDay,
            uniqueFilesTouched,
            totalFileTouches,
            appliedFilters,
            optimisticHours,
            baseHours,
            conservativeHours,
            subjectPrefixes,
        };
    }

    /**
     * Fetches work items and calculates hour metrics in one step for the chosen or default branch,
     * keeping the clean branch name in appliedFilters.
     */
    public async estimateFromRepository(
        repoDir: string,
        filters?: BranchWorkLogFilters,
        config: HourEstimationConfig = this.defaultConfig
    ): Promise<WorkHourMetrics> {
        const resolvedFilters = this.resolveFilters(filters);
        const cleanBranch = await this.resolveTargetBranch(repoDir, resolvedFilters.branch);
        const finalFilters: BranchWorkLogFilters = {
            ...resolvedFilters,
            branch: cleanBranch,
        };

        const items = await this.getWorkItems(repoDir, finalFilters);
        return this.calculateHourMetrics(items, config, finalFilters);
    }

    /**
     * Checks if an estimate file already exists for the repository and logs a warning before overwriting.
     */
    private async warnIfEstimateExists(targetFile: string, repoName: string): Promise<void> {
        // Step 16: Check file existence and emit a console warning if it will be overwritten.
        try {
            await access(targetFile);
            console.warn(
                `Aviso: já existe uma estimativa para o repositório "${repoName}" em "${targetFile}". O arquivo será sobrescrito.`
            );
        } catch {
            // File does not exist yet; no warning needed.
        }
    }

    /**
     * Creates estimate/<REPO_NAME> and writes a Markdown report containing hour metrics and commit table.
     */
    public async saveEstimateMarkdown(
        repoDir: string,
        metrics: WorkHourMetrics,
        commits: CommitWorkItem[] = [],
        outputRootDir: string = this.estimatesRootDir
    ): Promise<string> {
        // Step 17: Resolve repository folder name and ensure target directory exists.
        const repoName = this.extractRepoName(repoDir);
        const targetDir = resolve(process.cwd(), outputRootDir, repoName);
        const targetFile = join(targetDir, this.reportFileName);

        await mkdir(targetDir, { recursive: true });
        await this.warnIfEstimateExists(targetFile, repoName);

        // Step 18: Build Markdown content including the commit history table and write it to disk.
        const markdownContent = this.formatMarkdownReport(repoName, metrics, commits);
        await writeFile(targetFile, markdownContent, 'utf-8');

        return targetFile;
    }

    /**
     * Runs estimation for a repository and saves the resulting Markdown report with commit history.
     */
    public async estimateAndSaveMarkdown(
        repoDir: string,
        filters?: BranchWorkLogFilters,
        config: HourEstimationConfig = this.defaultConfig,
        outputRootDir: string = this.estimatesRootDir
    ): Promise<{ metrics: WorkHourMetrics; filePath: string; commits: CommitWorkItem[] }> {
        // Step 19: Resolve filters/clean branch, collect commit work items, compute metrics, and save report.
        const resolvedFilters = this.resolveFilters(filters);
        const cleanBranch = await this.resolveTargetBranch(repoDir, resolvedFilters.branch);
        const finalFilters: BranchWorkLogFilters = {
            ...resolvedFilters,
            branch: cleanBranch,
        };

        const commits = await this.getWorkItems(repoDir, finalFilters);
        const metrics = this.calculateHourMetrics(commits, config, finalFilters);
        const filePath = await this.saveEstimateMarkdown(repoDir, metrics, commits, outputRootDir);

        return { metrics, filePath, commits };
    }

    /**
     * Extracts and sanitizes the repository name from a directory path.
     */
    private extractRepoName(repoDir: string): string {
        const rawName = basename(resolve(repoDir));
        const sanitized = rawName.replace(/[^a-zA-Z0-9._-]/g, '-');
        return sanitized || 'repository';
    }

    /**
     * Escapes pipe characters so commit authors and descriptions do not break Markdown tables.
     */
    private escapeMarkdownCell(value: string): string {
        return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
    }

    /**
     * Formats commit work items as a Markdown table with author, description, and date columns.
     */
    private formatCommitHistoryTable(commits: CommitWorkItem[]): string {
        if (commits.length === 0) {
            return 'Nenhum commit encontrado no período.';
        }

        const header = '|autor|desc_commit|data|';
        const divider = '|---|---|---|';
        const rows = commits.map((commit) => {
            const author = this.escapeMarkdownCell(commit.authorName);
            const descCommit = this.escapeMarkdownCell(commit.subject);
            const date = this.escapeMarkdownCell(commit.authoredAt);
            return `|${author}|${descCommit}|${date}|`;
        });

        return [header, divider, ...rows].join('\n');
    }

    /**
     * Formats WorkHourMetrics and commit history into a clear Markdown summary using the clean branch name.
     */
    private formatMarkdownReport(
        repoName: string,
        metrics: WorkHourMetrics,
        commits: CommitWorkItem[] = []
    ): string {
        const rawBranch = (metrics.appliedFilters as BranchWorkLogFilters).branch ?? 'padrão';
        const branchName =
            rawBranch === 'padrão' ? 'padrão' : this.normalizeBranchDisplayName(rawBranch);

        const prefixesLines =
            Object.keys(metrics.subjectPrefixes).length > 0
                ? Object.entries(metrics.subjectPrefixes)
                    .map(([prefix, count]) => `- **${prefix}**: ${count}`)
                    .join('\n')
                : '- Nenhum commit encontrado no período';

        const commitTable = this.formatCommitHistoryTable(commits);

        return [
            `# Estimativa de Horas — ${repoName}`,
            '',
            '## Faixa de Horas Estimadas',
            `- **Otimista:** ${metrics.optimisticHours}h`,
            `- **Base:** ${metrics.baseHours}h`,
            `- **Conservadora:** ${metrics.conservativeHours}h`,
            '',
            '## Métricas do Histórico Git',
            `- **Total de commits:** ${metrics.totalCommits}`,
            `- **Dias ativos:** ${metrics.activeDays}`,
            `- **Média de commits por dia ativo:** ${metrics.commitsPerActiveDay}`,
            `- **Arquivos únicos tocados:** ${metrics.uniqueFilesTouched}`,
            `- **Total de alterações em arquivos:** ${metrics.totalFileTouches}`,
            '',
            '## Filtros Aplicados',
            `- **Branch:** ${branchName}`,
            `- **Since:** ${metrics.appliedFilters.since ?? 'não informado'}`,
            `- **Until:** ${metrics.appliedFilters.until ?? 'não informado'}`,
            `- **Author:** ${metrics.appliedFilters.author ?? 'todos'}`,
            '',
            '## Prefixos de Commit',
            prefixesLines,
            '',
            '## Histórico de Commits',
            commitTable,
            '',
        ].join('\n');
    }

    /**
     * Applies default filters (90 days ago, all authors) when specific fields are not provided.
     */
    private resolveFilters(filters?: BranchWorkLogFilters): BranchWorkLogFilters {
        const rawBranch =
            filters?.branch?.trim() || (this.defaultFilters as BranchWorkLogFilters).branch;

        return {
            since: filters?.since?.trim() || this.defaultFilters.since,
            until: filters?.until?.trim() || this.defaultFilters.until,
            author: filters?.author?.trim() || this.defaultFilters.author,
            branch: rawBranch ? this.normalizeBranchDisplayName(rawBranch) : undefined,
        };
    }
}