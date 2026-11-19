import { DEFAULT_HOUR_ESTIMATION_CONFIG } from '@/services/constants/git-work-hours-estimator-service.constants';
import type { CommitWorkItem, WorkHourMetrics } from '@/types/work-hour-estimator.types';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
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
const mockAccess = jest.fn<(path: string) => Promise<void>>();
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

// Step 2: Mock node:fs/promises so tests do not touch the real filesystem.
jest.unstable_mockModule('node:fs/promises', () => ({
    access: mockAccess,
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

/**
 * Configures mockExecFile to handle both `git branch -r` and `git log` commands.
 */
function setupGitCommandMocks(remoteBranchesOutput: string, logOutput: string): void {
    mockExecFile.mockImplementation((_cmd, args, _opts, callback) => {
        if (typeof callback !== 'function') {
            return;
        }

        if (args[0] === 'branch' && args[1] === '-r') {
            callback(null, remoteBranchesOutput, '');
            return;
        }

        callback(null, logOutput, '');
    });
}

describe('GitWorkHourEstimatorService', () => {
    // Step 4: Use inferred spy return type so TypeScript does not reject generic spyOn arguments.
    let warnSpy: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
        jest.clearAllMocks();
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        mockAccess.mockRejectedValue(new Error('ENOENT'));
        mockMkdir.mockResolvedValue(undefined);
        mockWriteFile.mockResolvedValue(undefined);
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    /**
     * Verifies that detectDefaultBranch detects the main branch offline using `git branch -r`.
     */
    it('deve descobrir a branch principal offline via git branch -r quando não informada', async () => {
        setupGitCommandMocks('  origin/HEAD -> origin/main\n  origin/main\n  origin/develop\n', '');

        const service = new GitWorkHourEstimatorService();
        const detectedBranch = await service.detectDefaultBranch('/repo/exemplo');

        expect(detectedBranch).toBe('main');
        expect(mockExecFile).toHaveBeenCalledWith(
            'git',
            ['branch', '-r'],
            expect.objectContaining({ cwd: '/repo/exemplo' }),
            expect.any(Function)
        );
    });

    /**
     * Verifies that getWorkItems applies the default 90-day filter, detects main branch, and parses commits.
     */
    it('deve aplicar o filtro padrão de 90 dias, usar branch principal e parsear commits', async () => {
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

        setupGitCommandMocks('  origin/HEAD -> origin/main\n  origin/main\n', stdout);

        const service = new GitWorkHourEstimatorService();
        const items = await service.getWorkItems('/repo/exemplo');

        expect(mockExecFile).toHaveBeenCalledTimes(2);
        expect(mockExecFile).toHaveBeenCalledWith(
            'git',
            expect.arrayContaining(['log', 'main', '--name-only', '--since=90 days ago']),
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
     * Verifies that custom filters (since, until, author, branch) are passed to git log.
     */
    it('deve repassar filtros personalizados de since, until, author e branch para o git log', async () => {
        setupGitCommandMocks('', '');

        const service = new GitWorkHourEstimatorService();
        await service.getWorkItems('/repo/exemplo', {
            since: '2026-01-01',
            until: '2026-03-31',
            author: 'Douglas',
            branch: 'feature/estimativas',
        });

        expect(mockExecFile).toHaveBeenCalledTimes(1);
        expect(mockExecFile).toHaveBeenCalledWith(
            'git',
            expect.arrayContaining([
                'log',
                'feature/estimativas',
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

        setupGitCommandMocks('  origin/main\n', stdout);

        const service = new GitWorkHourEstimatorService();
        const result = await service.estimateFromRepository('/repo/api', {
            since: '30 days ago',
        });

        expect(result.appliedFilters).toEqual({
            since: '30 days ago',
            until: undefined,
            author: undefined,
            branch: 'main',
        });
        expect(result.activeDays).toBe(1);
        expect(result.baseHours).toBe(6.3);
    });

    /**
     * Verifies that saveEstimateMarkdown creates estimate/<REPO_NAME> and writes the Markdown report
     * including the |autor|desc_commit|data| table.
     */
    it('deve criar a pasta estimate/NOME_REPOSITORIO e salvar o .md com a tabela de commits', async () => {
        const service = new GitWorkHourEstimatorService();
        const metrics: WorkHourMetrics = {
            totalCommits: 1,
            activeDays: 1,
            commitsPerActiveDay: 1,
            uniqueFilesTouched: 2,
            totalFileTouches: 2,
            appliedFilters: { since: '90 days ago' },
            optimisticHours: 5.2,
            baseHours: 6.5,
            conservativeHours: 8.8,
            subjectPrefixes: { feat: 1 },
        };

        const commits: CommitWorkItem[] = [
            {
                hash: 'abc123',
                authorName: 'Douglas',
                authoredAt: '2026-11-18T10:30:00-03:00',
                subject: 'feat: adiciona estimativa em markdown',
                filesChanged: ['src/services/git-work-hour.service.ts'],
            },
        ];

        const expectedDir = resolve(process.cwd(), 'estimate', 'meu-projeto');
        const expectedFile = join(expectedDir, 'estimation.md');

        const savedPath = await service.saveEstimateMarkdown('/repos/meu-projeto', metrics, commits);

        expect(savedPath).toBe(expectedFile);
        expect(mockMkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
        expect(mockWriteFile).toHaveBeenCalledWith(
            expectedFile,
            expect.stringContaining('# Estimativa de Horas — meu-projeto'),
            'utf-8'
        );
        expect(mockWriteFile).toHaveBeenCalledWith(
            expectedFile,
            expect.stringContaining('|autor|desc_commit|data|'),
            'utf-8'
        );
        expect(mockWriteFile).toHaveBeenCalledWith(
            expectedFile,
            expect.stringContaining(
                '|Douglas|feat: adiciona estimativa em markdown|2026-11-18T10:30:00-03:00|'
            ),
            'utf-8'
        );
    });

    /**
     * Verifies that saveEstimateMarkdown logs a console.warn when an estimate already exists.
     */
    it('deve emitir console.warn ao sobrescrever uma estimativa existente do repositório', async () => {
        mockAccess.mockResolvedValueOnce(undefined);

        const service = new GitWorkHourEstimatorService();
        const metrics: WorkHourMetrics = {
            totalCommits: 1,
            activeDays: 1,
            commitsPerActiveDay: 1,
            uniqueFilesTouched: 1,
            totalFileTouches: 1,
            appliedFilters: { since: '90 days ago' },
            optimisticHours: 5,
            baseHours: 6.3,
            conservativeHours: 8.5,
            subjectPrefixes: { feat: 1 },
        };

        await service.saveEstimateMarkdown('/repos/meu-projeto', metrics, []);

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('meu-projeto'));
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

        setupGitCommandMocks('  origin/master\n', stdout);

        const service = new GitWorkHourEstimatorService();
        const result = await service.estimateAndSaveMarkdown('/repos/dsweb-cli');

        const expectedDir = resolve(process.cwd(), 'estimate', 'dsweb-cli');
        const expectedFile = join(expectedDir, 'estimation.md');

        expect(result.filePath).toBe(expectedFile);
        expect(result.metrics.activeDays).toBe(1);
        expect(result.commits).toHaveLength(1);
        expect(mockMkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
        expect(mockWriteFile).toHaveBeenCalledWith(
            expectedFile,
            expect.stringContaining('|autor|desc_commit|data|'),
            'utf-8'
        );
    });
});