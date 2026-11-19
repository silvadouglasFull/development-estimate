/**
 * Represents a single parsed commit along with the list of modified files.
 */
export type CommitWorkItem = {
    hash: string;
    authorName: string;
    authoredAt: string;
    subject: string;
    filesChanged: string[];
};
/**
 * Filter parameters used to narrow down git log history and select a target branch.
 */
export type WorkLogFilters = {
    // Step 1: Optional start date or relative window (e.g. "1 year ago").
    since?: string;
    // Step 2: Optional end date filter for git log.
    until?: string;
    // Step 3: Optional commit author filter.
    author?: string;
    // Step 4: Optional target branch name to inspect and report.
    branch?: string;
};

/**
 * Configuration values used to estimate optimistic, base, and conservative work hours.
 */
export type HourEstimationConfig = {
    hoursPerActiveDay: number;
    hoursPerUniqueFile: number;
    optimisticFactor: number;
    conservativeFactor: number;
};

/**
 * Calculated effort metrics and hour ranges returned for LLM analysis.
 */
export type WorkHourMetrics = {
    totalCommits: number;
    activeDays: number;
    commitsPerActiveDay: number;
    uniqueFilesTouched: number;
    totalFileTouches: number;
    appliedFilters: WorkLogFilters;
    optimisticHours: number;
    baseHours: number;
    conservativeHours: number;
    subjectPrefixes: Record<string, number>;
};