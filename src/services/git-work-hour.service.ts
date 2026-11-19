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
 * Service that reads git commit logs, estimates work hour ranges, and exports Markdown reports.
 */
export class GitWorkHourEstimatorService implements WorkHourEstimator {
    private readonly fieldSeparator = '\x1f';
    private readonly recordSeparator = '\x1e';
    private readonly defaultConfig: HourEstimationConfig;
    private readonly defaultFilters: WorkLogFilters;
    private readonly estimatesRootDir = 'estimate';
    private readonly reportFileName = 'estimation.md';

    constructor(
        defaultFilters: WorkLogFilters = DEFAULT_WORK_LOG_FILTERS,
        defaultConfig: HourEstimationConfig = DEFAULT_HOUR_ESTIMATION_CONFIG
    ) {
        this.defaultFilters = { ...defaultFilters };
        this.defaultConfig = { ...defaultConfig };
    }

    /**
     * Reads commits and changed files from the repository using default filters when omitted.
     */
    public async getWorkItems(
        repoDir: string,
        filters?: WorkLogFilters
    ): Promise<CommitWorkItem[]> {
        // Step 1: Resolve active filters (defaults to 90 days ago and all authors).
        const resolvedFilters = this.resolveFilters(filters);

        // Step 2: Build git log command arguments with safe field and record delimiters.
        const header = ['%H', '%an', '%aI', '%s'].join(this.fieldSeparator);
        const args = [
            'log',
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

        // Step 3: Run git log inside the target repository directory.
        const { stdout } = await execFileAsync('git', args, {
            cwd: repoDir,
            maxBuffer: 15 * 1024 * 1024,
        });

        // Step 4: Parse stdout chunks into structured CommitWorkItem objects.
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
        appliedFilters: WorkLogFilters = this.defaultFilters
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

        // Step 5: Group commits by calendar day (YYYY-MM-DD) so multiple commits in one day
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

        // Step 6: Compute base hours from active days and unique files, then derive
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
     * Fetches work items and calculates hour metrics in one step.
     */
    public async estimateFromRepository(
        repoDir: string,
        filters?: WorkLogFilters,
        config: HourEstimationConfig = this.defaultConfig
    ): Promise<WorkHourMetrics> {
        const resolvedFilters = this.resolveFilters(filters);
        const items = await this.getWorkItems(repoDir, resolvedFilters);
        return this.calculateHourMetrics(items, config, resolvedFilters);
    }

    /**
     * Creates estimate/<REPO_NAME> and writes a Markdown report containing the hour metrics.
     */
    public async saveEstimateMarkdown(
        repoDir: string,
        metrics: WorkHourMetrics,
        outputRootDir: string = this.estimatesRootDir
    ): Promise<string> {
        // Step 7: Resolve repository folder name and ensure target directory exists.
        const repoName = this.extractRepoName(repoDir);
        const targetDir = resolve(process.cwd(), outputRootDir, repoName);
        const targetFile = join(targetDir, this.reportFileName);

        await mkdir(targetDir, { recursive: true });

        // Step 8: Build Markdown content and write it to disk.
        const markdownContent = this.formatMarkdownReport(repoName, metrics);
        await writeFile(targetFile, markdownContent, 'utf-8');

        return targetFile;
    }

    /**
     * Runs estimation for a repository and saves the resulting Markdown report to disk.
     */
    public async estimateAndSaveMarkdown(
        repoDir: string,
        filters?: WorkLogFilters,
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
    private resolveFilters(filters?: WorkLogFilters): WorkLogFilters {
        return {
            since: filters?.since?.trim() || this.defaultFilters.since,
            until: filters?.until?.trim() || this.defaultFilters.until,
            author: filters?.author?.trim() || this.defaultFilters.author,
        };
    }
}