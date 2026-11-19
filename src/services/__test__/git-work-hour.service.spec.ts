import { DEFAULT_HOUR_ESTIMATION_CONFIG } from '@/services/constants/git-work-hours-estimator-service.constants';
import type { CommitWorkItem, WorkHourMetrics } from '@/types/work-hour-estimator.types';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { join, resolve } from 'node:path';

/**
 * Callback type expected by Node's child_process.execFile.
 */
type ExecFileCallback = (err: Error | null, stdout?: string, stderr?: string) => void;

/**
 * Mock signature for execFile calls inside unit tests.
 */
type ExecFileMockFn = (
    cmd: string,
    args: string[],
    options: Record<string, unknown>,
    callback?: ExecFileCallback
) => void;

const mockExecFile = jest.fn<ExecFileMockFn>();
const mockMkdir = jest.fn<(path: string, options?: { recursive?: boolean }) => Promise<string | undefined>>();
const mockWriteFile = jest.fn<(filePath: string, data: string, encoding?: BufferEncoding) => Promise<void>>();

// Step 1: Mock node:child_process before importing GitWorkHourEstimatorService.
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

// Step 2: Mock node:fs/promises so tests do not write real files to disk.
jest.unstable_mockModule('node:fs/promises', () => ({
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
}));

// Step 3: Dynamically import the service after mocks are registered.
const { GitWorkHourEstimatorService } = await import('@/services/git-work-hour.service');

/**
 * Builds a raw stdout string matching the custom field (\x1f) and record (\x1e) format.
 */
function buildMockGitLogStdout(
    entries: Array<{
        hash: string;
        authorName: string;
        authoredAt: string;
        subject: string;
        files: string[];
    }>
): string {
    const fieldSep = '\x1f';
    const recordSep = '\x1e';

    return entries
        .map((entry) => {
            const header = [entry.hash, entry.authorName, entry.authoredAt, entry.subject].join(
                fieldSep
            );
            const filesBlock = entry.files.join('\n');
            return `${recordSep}${header}${fieldSep}${filesBlock}`;
        })
        .join('\n');
}

describe('GitWorkHourEstimatorService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockMkdir.mockResolvedValue(undefined);
        mockWriteFile.mockResolvedValue(undefined);
    });

    /**
     * Verifies that getWorkItems applies the default 90-day filter and parses commits and files.
     */
    it('deve aplicar o filtro padrão de 90 dias e parsear commits com arquivos alterados', async () => {
        const stdout = buildMockGitLogStdout([
            {
                hash: 'hash-1',
                authorName: 'Douglas',
                authoredAt: '2026-10-10T10:00:00-03:00',
                subject: 'feat: cria servico de git',
                files: ['src/services/git.service.ts', 'src/types/repo.ts'],
            },
            {
                hash: 'hash-2',
                authorName: 'Douglas',
                authoredAt: '2026-10-10T15:30:00-03:00',
                subject: 'fix(git): ajusta flag de clone',
                files: ['src/services/git.service.ts'],
            },
        ]);

        mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
            if (typeof callback === 'function') {
                callback(null, stdout, '');
            }
        });

        const service = new GitWorkHourEstimatorService();
        const items = await service.getWorkItems('/repo/exemplo');

        expect(mockExecFile).toHaveBeenCalledTimes(1);
        expect(mockExecFile).toHaveBeenCalledWith(
            'git',
            expect.arrayContaining(['log', '--name-only', '--since=90 days ago']),
            expect.objectContaining({ cwd: '/repo/exemplo' }),
            expect.any(Function)
        );

        const expectedItems: CommitWorkItem[] = [
            {
                hash: 'hash-1',
                authorName: 'Douglas',
                authoredAt: '2026-10-10T10:00:00-03:00',
                subject: 'feat: cria servico de git',
                filesChanged: ['src/services/git.service.ts', 'src/types/repo.ts'],
            },
            {
                hash: 'hash-2',
                authorName: 'Douglas',
                authoredAt: '2026-10-10T15:30:00-03:00',
                subject: 'fix(git): ajusta flag de clone',
                filesChanged: ['src/services/git.service.ts'],
            },
        ];

        expect(items).toEqual(expectedItems);
    });

    /**
     * Verifies that custom filters (since, until, author) are passed to git log.
     */
    it('deve repassar filtros personalizados de since, until e author para o git log', async () => {
        mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
            if (typeof callback === 'function') {
                callback(null, '', '');
            }
        });

        const service = new GitWorkHourEstimatorService();
        await service.getWorkItems('/repo/exemplo', {
            since: '2026-01-01',
            until: '2026-03-31',
            author: 'Douglas',
        });

        expect(mockExecFile).toHaveBeenCalledWith(
            'git',
            expect.arrayContaining([
                '--since=2026-01-01',
                '--until=2026-03-31',
                '--author=Douglas',
            ]),
            expect.objectContaining({ cwd: '/repo/exemplo' }),
            expect.any(Function)
        );
    });

    /**
     * Verifies that multiple commits on the same calendar day count as one active day
     * and calculates optimistic, base, and conservative hours using active days and unique files.
     */
    it('deve agrupar múltiplos commits no mesmo dia como 1 dia ativo e calcular faixa de horas', () => {
        const service = new GitWorkHourEstimatorService();
        const items: CommitWorkItem[] = [
            {
                hash: 'c1',
                authorName: 'Douglas',
                authoredAt: '2026-11-01T09:00:00-03:00',
                subject: 'feat: tela inicial',
                filesChanged: ['a.ts', 'b.ts'],
            },
            {
                hash: 'c2',
                authorName: 'Douglas',
                authoredAt: '2026-11-01T14:00:00-03:00',
                subject: 'fix: estilo do botao',
                filesChanged: ['b.ts'],
            },
            {
                hash: 'c3',
                authorName: 'Douglas',
                authoredAt: '2026-11-02T11:00:00-03:00',
                subject: 'chore: atualiza docs',
                filesChanged: ['c.ts'],
            },
        ];

        const metrics = service.calculateHourMetrics(items, DEFAULT_HOUR_ESTIMATION_CONFIG);

        expect(metrics.totalCommits).toBe(3);
        expect(metrics.activeDays).toBe(2);
        expect(metrics.commitsPerActiveDay).toBe(1.5);
        expect(metrics.uniqueFilesTouched).toBe(3);
        expect(metrics.totalFileTouches).toBe(4);
        expect(metrics.baseHours).toBe(12.8);
        expect(metrics.optimisticHours).toBe(Number((12.8 * 0.8).toFixed(1)));
        expect(metrics.conservativeHours).toBe(Number((12.8 * 1.35).toFixed(1)));
        expect(metrics.subjectPrefixes).toEqual({
            feat: 1,
            fix: 1,
            chore: 1,
        });
    });

    /**
     * Verifies zeroed metrics when there are no commits in the filtered range.
     */
    it('deve retornar métricas zeradas quando não houver commits', () => {
        const service = new GitWorkHourEstimatorService();
        const metrics = service.calculateHourMetrics([]);

        expect(metrics.totalCommits).toBe(0);
        expect(metrics.activeDays).toBe(0);
        expect(metrics.optimisticHours).toBe(0);
        expect(metrics.baseHours).toBe(0);
        expect(metrics.conservativeHours).toBe(0);
        expect(metrics.subjectPrefixes).toEqual({});
    });

    /**
     * Verifies end-to-end execution of estimateFromRepository combining log reading and calculation.
     */
    it('deve executar estimateFromRepository retornando métricas e filtros aplicados', async () => {
        const stdout = buildMockGitLogStdout([
            {
                hash: 'h1',
                authorName: 'Douglas',
                authoredAt: '2026-11-10T10:00:00-03:00',
                subject: 'feat: endpoint de estimativa',
                files: ['src/index.ts'],
            },
        ]);

        mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
            if (typeof callback === 'function') {
                callback(null, stdout, '');
            }
        });

        const service = new GitWorkHourEstimatorService();
        const result = await service.estimateFromRepository('/repo/api', {
            since: '30 days ago',
        });

        expect(result.appliedFilters).toEqual({
            since: '30 days ago',
            until: undefined,
            author: undefined,
        });
        expect(result.activeDays).toBe(1);
        expect(result.baseHours).toBe(6.3);
    });

    /**
     * Verifies that saveEstimateMarkdown creates estimate/<REPO_NAME> and writes the Markdown report.
     */
    it('deve criar a pasta estimate/NOME_REPOSITORIO e salvar o arquivo .md com as estimativas', async () => {
        const service = new GitWorkHourEstimatorService();
        const metrics: WorkHourMetrics = {
            totalCommits: 4,
            activeDays: 2,
            commitsPerActiveDay: 2,
            uniqueFilesTouched: 5,
            totalFileTouches: 6,
            appliedFilters: { since: '90 days ago' },
            optimisticHours: 10.6,
            baseHours: 13.3,
            conservativeHours: 18,
            subjectPrefixes: { feat: 3, fix: 1 },
        };

        const expectedDir = resolve(process.cwd(), 'estimate', 'meu-projeto');
        const expectedFile = join(expectedDir, 'estimation.md');

        const savedPath = await service.saveEstimateMarkdown('/repos/meu-projeto', metrics);

        expect(savedPath).toBe(expectedFile);
        expect(mockMkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
        expect(mockWriteFile).toHaveBeenCalledWith(
            expectedFile,
            expect.stringContaining('# Estimativa de Horas — meu-projeto'),
            'utf-8'
        );
        expect(mockWriteFile).toHaveBeenCalledWith(
            expectedFile,
            expect.stringContaining('10.6h'),
            'utf-8'
        );
        expect(mockWriteFile).toHaveBeenCalledWith(
            expectedFile,
            expect.stringContaining('13.3h'),
            'utf-8'
        );
        expect(mockWriteFile).toHaveBeenCalledWith(
            expectedFile,
            expect.stringContaining('18h'),
            'utf-8'
        );
    });

    /**
     * Verifies that estimateAndSaveMarkdown calculates metrics and persists the Markdown report.
     */
    it('deve calcular métricas e salvar o arquivo .md em estimate/NOME_REPOSITORIO via estimateAndSaveMarkdown', async () => {
        const stdout = buildMockGitLogStdout([
            {
                hash: 'h2',
                authorName: 'Douglas',
                authoredAt: '2026-11-15T14:00:00-03:00',
                subject: 'feat: gera relatorio md',
                files: ['src/services/git-work-hour.service.ts'],
            },
        ]);

        mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
            if (typeof callback === 'function') {
                callback(null, stdout, '');
            }
        });

        const service = new GitWorkHourEstimatorService();
        const result = await service.estimateAndSaveMarkdown('/repos/dsweb-cli');

        const expectedDir = resolve(process.cwd(), 'estimate', 'dsweb-cli');
        const expectedFile = join(expectedDir, 'estimation.md');

        expect(result.filePath).toBe(expectedFile);
        expect(result.metrics.activeDays).toBe(1);
        expect(mockMkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
        expect(mockWriteFile).toHaveBeenCalledWith(expectedFile, expect.any(String), 'utf-8');
    });
});