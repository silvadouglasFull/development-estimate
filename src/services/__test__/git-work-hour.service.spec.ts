import type { CommitWorkItem } from '@/types/work-hour-estimator.types';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { join, resolve } from 'node:path';

/**
 * Callback type expected by Node's child_process.execFile.
 */
type ExecFileCallback = (err: Error | null, stdout?: string, stderr?: string) => void;

/**
 * Mock signature for execFile invocations inside unit tests.
 */
type ExecFileMockFn = (
    cmd: string,
    args: string[],
    options: Record<string, unknown>,
    callback?: ExecFileCallback
) => void;

const mockExecFile = jest.fn<ExecFileMockFn>();
const mockAccess = jest.fn<(filePath: string) => Promise<void>>();
const mockMkdir = jest.fn<(dirPath: string, options?: { recursive?: boolean }) => Promise<string | undefined>>();
const mockWriteFile = jest.fn<(filePath: string, data: string, encoding?: BufferEncoding) => Promise<void>>();

// Step 1: Mock node:child_process and its custom promisify behavior.
jest.unstable_mockModule('node:child_process', () => {
    const execFileFn = Object.assign(mockExecFile, {
        [Symbol.for('nodejs.util.promisify.custom')]: (
            cmd: string,
            args: string[],
            options: Record<string, unknown>
        ) =>
            new Promise<{ stdout: string; stderr: string }>((res, rej) => {
                mockExecFile(cmd, args, options, (err, stdout = '', stderr = '') => {
                    if (err) {
                        rej(err);
                        return;
                    }
                    res({ stdout, stderr });
                });
            }),
    });

    return {
        execFile: execFileFn,
    };
});

// Step 2: Mock node:fs/promises to avoid real filesystem writes during tests.
jest.unstable_mockModule('node:fs/promises', () => ({
    access: mockAccess,
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
}));

// Step 3: Dynamically import GitWorkHourEstimatorService after mocks are registered.
const { GitWorkHourEstimatorService } = await import('@/services/git-work-hour.service');

describe('GitWorkHourEstimatorService', () => {
    beforeEach(() => {
        // Step 4: Reset mocks and configure deterministic git responses for branch detection,
        // ref verification, and log parsing.
        jest.clearAllMocks();
        mockAccess.mockRejectedValue(new Error('ENOENT'));
        mockMkdir.mockResolvedValue(undefined);
        mockWriteFile.mockResolvedValue(undefined);

        mockExecFile.mockImplementation((_cmd, args, _opts, callback) => {
            if (typeof callback !== 'function') {
                return;
            }

            if (args[0] === 'branch' && args[1] === '-r') {
                callback(null, '  origin/HEAD -> origin/main\n  origin/main\n', '');
                return;
            }

            if (args[0] === 'rev-parse') {
                callback(null, 'abc1234\n', '');
                return;
            }

            if (args[0] === 'log') {
                const sampleLog = [
                    '\x1ehash1\x1fDouglas Silva\x1f2026-11-10T10:00:00-03:00\x1ffeat: add login form\x1f',
                    'src/login.ts\nsrc/auth.ts\n',
                    '\x1ehash2\x1fDouglas Silva\x1f2026-11-10T11:30:00-03:00\x1ffix: validate token\x1f',
                    'src/auth.ts\n',
                ].join('');
                callback(null, sampleLog, '');
                return;
            }

            callback(null, '', '');
        });
    });

    /**
     * Verifies that getWorkItems applies the default 1-year lookback window, `--no-merges`,
     * resolves the default branch, and parses commits cleanly.
     */
    it('deve aplicar o filtro padrão de 1 ano, usar branch principal e parsear commits', async () => {
        const service = new GitWorkHourEstimatorService();
        const items = await service.getWorkItems('/repo/exemplo');

        // Step 5: Assert parsed items and verify `git log` receives `--no-merges` and `--since=1 year ago`.
        expect(items).toHaveLength(2);
        expect(items[0]?.subject).toBe('feat: add login form');
        expect(mockExecFile).toHaveBeenCalledWith(
            'git',
            expect.arrayContaining(['log', 'origin/main', '--no-merges', '--name-only', '--since=1 year ago']),
            expect.objectContaining({ cwd: '/repo/exemplo' }),
            expect.any(Function)
        );
    });

    /**
     * Verifies that multiple commits on the same day count as 1 active day and computes
     * optimistic, base, and conservative hours using default weights (3.5h/day and 0.1h/file).
     */
    it('deve agrupar múltiplos commits no mesmo dia como 1 dia ativo e calcular faixa de horas', () => {
        const service = new GitWorkHourEstimatorService();
        const commits: CommitWorkItem[] = [
            {
                hash: '1',
                authorName: 'Douglas Silva',
                authoredAt: '2026-11-10T10:00:00-03:00',
                subject: 'feat: create dashboard',
                filesChanged: ['src/app.ts', 'src/dashboard.ts'],
            },
            {
                hash: '2',
                authorName: 'Douglas Silva',
                authoredAt: '2026-11-10T14:00:00-03:00',
                subject: 'fix: adjust card spacing',
                filesChanged: ['src/dashboard.ts'],
            },
            {
                hash: '3',
                authorName: 'Douglas Silva',
                authoredAt: '2026-11-11T09:30:00-03:00',
                subject: 'refactor: extract chart helper',
                filesChanged: ['src/chart.ts'],
            },
        ];

        const metrics = service.calculateHourMetrics(commits);

        // Step 6: 2 active days * 3.5h + 3 unique files * 0.1h = 7.3h base;
        // optimistic: 7.3 * 0.8 = 5.8h; conservative: 7.3 * 1.3 = 9.5h.
        expect(metrics.activeDays).toBe(2);
        expect(metrics.uniqueFilesTouched).toBe(3);
        expect(metrics.totalFileTouches).toBe(4);
        expect(metrics.baseHours).toBe(7.3);
        expect(metrics.optimisticHours).toBe(Number((7.3 * 0.8).toFixed(1)));
        expect(metrics.conservativeHours).toBe(Number((7.3 * 1.3).toFixed(1)));
        expect(metrics.subjectPrefixes).toEqual({
            feat: 1,
            fix: 1,
            refactor: 1,
        });
    });

    /**
     * Verifies that estimateFromRepository returns metrics and normalized applied filters.
     */
    it('deve executar estimateFromRepository retornando métricas e filtros aplicados', async () => {
        const service = new GitWorkHourEstimatorService();
        const result = await service.estimateFromRepository('/repo/exemplo', {
            branch: 'origin/main',
        });

        // Step 7: 1 active day * 3.5h + 2 unique files * 0.1h = 3.7h base for the mocked log.
        expect(result.appliedFilters.branch).toBe('main');
        expect(result.appliedFilters.since).toBe('1 year ago');
        expect(result.activeDays).toBe(1);
        expect(result.baseHours).toBe(3.7);
    });

    /**
     * Verifies that saveEstimateMarkdown caps the commit table at 100 rows when more commits exist
     * while keeping the full metrics count.
     */
    it('deve limitar a tabela do Markdown aos 100 commits mais recentes quando houver mais de 100', async () => {
        const service = new GitWorkHourEstimatorService();
        const manyCommits: CommitWorkItem[] = Array.from({ length: 120 }, (_, index) => ({
            hash: `hash-${index + 1}`,
            authorName: 'Douglas Silva',
            authoredAt: '2026-11-15T12:00:00-03:00',
            subject: `feat: item ${index + 1}`,
            filesChanged: [`src/file-${index + 1}.ts`],
        }));

        const metrics = service.calculateHourMetrics(manyCommits, undefined, {
            since: '1 year ago',
            branch: 'main',
        });

        await service.saveEstimateMarkdown('/repos/repo-grande', metrics, manyCommits, 'estimate-test');

        const expectedFile = join(resolve(process.cwd(), 'estimate-test', 'repo-grande'), 'estimation.md');
        expect(mockWriteFile).toHaveBeenCalledTimes(1);

        const writtenMarkdown = mockWriteFile.mock.calls[0]?.[1] ?? '';
        expect(mockWriteFile.mock.calls[0]?.[0]).toBe(expectedFile);
        expect(writtenMarkdown).toContain('- **Total de commits:** 120');
        expect(writtenMarkdown).toContain('|Douglas Silva|feat: item 100|2026-11-15T12:00:00-03:00|');
        expect(writtenMarkdown).not.toContain('|Douglas Silva|feat: item 101|2026-11-15T12:00:00-03:00|');
        expect(writtenMarkdown).toContain('20 commits anteriores omitidos da tabela');
    });
});