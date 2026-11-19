import { DEFAULT_HOUR_ESTIMATION_CONFIG, DEFAULT_WORK_LOG_FILTERS } from '@/services/constants/git-work-hours-estimator-service.constants';
import type { WorkHourEstimator } from '@/services/interfaces/work-hour-estimator.interface';
import type {
    CommitWorkItem,
    HourEstimationConfig,
    WorkHourMetrics,
    WorkLogFilters,
} from '@/types/work-hour-estimator.types';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
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
     * Discovers the repository's default/main branch offline using `git branch -r`.
     */
    public async detectDefaultBranch(repoDir: string): Promise<string> {
        // Step 1: Query remote-tracking branches locally without touching the network.
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

        // Step 2: Check for an explicit symbolic pointer like "origin/HEAD -> origin/main".
        const headPointerLine = lines.find((line) => line.includes('->'));
        if (headPointerLine) {
            const targetRef = headPointerLine.split('->').pop()?.trim() ?? '';
            const normalizedTarget = targetRef.replace(/^origin\//, '').trim();
            if (normalizedTarget.length > 0) {
                return normalizedTarget;
            }
        }

        // Step 3: Normalize remote branch names (e.g. "origin/main" -> "main").
        const normalizedBranches = lines
            .filter((line) => !line.includes('->'))
            .map((line) => line.replace(/^origin\//, '').trim())
            .filter((branch) => branch.length > 0);

        // Step 4: Prefer standard main branch names if present.
        for (const candidate of this.preferredMainBranches) {
            if (normalizedBranches.includes(candidate)) {
                return candidate;
            }
        }

        // Step 5: Fallback to the first available remote branch or HEAD.
        return normalizedBranches[0] ?? 'HEAD';
    }

    /**
     * Resolves which branch should be inspected: user-specified branch or offline default branch.
     */
    public async resolveTargetBranch(repoDir: string, requestedBranch?: string): Promise<string> {
        const trimmed = requestedBranch?.trim();
        if (trimmed) {
            return trimmed;
        }

        return this.detectDefaultBranch(repoDir);
    }

    /**
     * Reads commits and changed files from the repository for the selected or default branch.
     */
    public async getWorkItems(
        repoDir: string,
        filters?: BranchWorkLogFilters
    ): Promise<CommitWorkItem[]> {
        // Step 1: Resolve active filters (defaults to 90 days ago and all authors).
        const resolvedFilters = this.resolveFilters(filters);

        // Step 2: Resolve target branch offline when not explicitly provided.
        const targetBranch = await this.resolveTargetBranch(repoDir, resolvedFilters.branch);

        // Step 3: Build git log command arguments with safe field and record delimiters.
        const header = ['%H', '%an', '%aI', '%s'].join(this.fieldSeparator);
        const args = [
            'log',
            targetBranch,
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

        // Step 4: Run git log inside the target repository directory.
        const { stdout } = await execFileAsync('git', args, {
            cwd: repoDir,
            maxBuffer: 15 * 1024 * 1024,
        });

        // Step 5: Parse stdout chunks into structured CommitWorkItem objects.
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

        // Step 6: Group commits by calendar day (YYYY-MM-DD) so multiple commits in one day
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

        // Step 7: Compute base hours from active days and unique files, then derive
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
     * Fetches work items and calculates hour metrics in one step for the chosen or default branch.
     */
    public async estimateFromRepository(
        repoDir: string,
        filters?: BranchWorkLogFilters,
        config: HourEstimationConfig = this.defaultConfig
    ): Promise<WorkHourMetrics> {
        const resolvedFilters = this.resolveFilters(filters);
        const resolvedBranch = await this.resolveTargetBranch(repoDir, resolvedFilters.branch);
        const finalFilters: BranchWorkLogFilters = {
            ...resolvedFilters,
            branch: resolvedBranch,
        };

        const items = await this.getWorkItems(repoDir, finalFilters);
        return this.calculateHourMetrics(items, config, finalFilters);
    }

    /**
     * Creates estimate/<REPO_NAME> and writes a Markdown report containing the hour metrics.
     */
    public async saveEstimateMarkdown(
        repoDir: string,
        metrics: WorkHourMetrics,
        outputRootDir: string = this.estimatesRootDir
    ): Promise<string> {
        // Step 8: Resolve repository folder name and ensure target directory exists.
        const repoName = this.extractRepoName(repoDir);
        const targetDir = resolve(process.cwd(), outputRootDir, repoName);
        const targetFile = join(targetDir, this.reportFileName);

        await mkdir(targetDir, { recursive: true });

        // Step 9: Build Markdown content and write it to disk.
        const markdownContent = this.formatMarkdownReport(repoName, metrics);
        await writeFile(targetFile, markdownContent, 'utf-8');

        return targetFile;
    }

    /**
     * Runs estimation for a repository and saves the resulting Markdown report to disk.
     */
    public async estimateAndSaveMarkdown(
        repoDir: string,
        filters?: BranchWorkLogFilters,
        config: HourEstimationConfig = this.defaultConfig,
        outputRootDir: string = this.estimatesRootDir
    ): Promise<{ metrics: WorkHourMetrics; filePath: string }> {
        const metrics = await this.estimateFromRepository(repoDir, filters, config);
        const filePath = await this.saveEstimateMarkdown(repoDir, metrics, outputRootDir);

        return { metrics, filePath };
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
     * Formats WorkHourMetrics into a clear Markdown summary for review or LLM input.
     */
    private formatMarkdownReport(repoName: string, metrics: WorkHourMetrics): string {
        const branchName = (metrics.appliedFilters as BranchWorkLogFilters).branch ?? 'padrão';
        const prefixesLines =
            Object.keys(metrics.subjectPrefixes).length > 0
                ? Object.entries(metrics.subjectPrefixes)
                    .map(([prefix, count]) => `- **${prefix}**: ${count}`)
                    .join('\n')
                : '- Nenhum commit encontrado no período';

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
        ].join('\n');
    }

    /**
     * Applies default filters (90 days ago, all authors) when specific fields are not provided.
     */
    private resolveFilters(filters?: BranchWorkLogFilters): BranchWorkLogFilters {
        return {
            since: filters?.since?.trim() || this.defaultFilters.since,
            until: filters?.until?.trim() || this.defaultFilters.until,
            author: filters?.author?.trim() || this.defaultFilters.author,
            branch: filters?.branch?.trim() || (this.defaultFilters as BranchWorkLogFilters).branch,
        };
    }
}