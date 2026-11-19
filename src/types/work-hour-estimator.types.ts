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
 * Filter parameters used to narrow down git log history.
 */
export type WorkLogFilters = {
    since?: string;
    until?: string;
    author?: string;
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