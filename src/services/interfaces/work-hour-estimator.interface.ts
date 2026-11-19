import type {
    CommitWorkItem,
    HourEstimationConfig,
    WorkHourMetrics,
    WorkLogFilters,
} from '@/types/work-hour-estimator.types';

/**
 * Contract for reading git work logs and estimating effort hour ranges.
 */
export interface WorkHourEstimator {
    getWorkItems(repoDir: string, filters?: WorkLogFilters): Promise<CommitWorkItem[]>;
    calculateHourMetrics(
        items: CommitWorkItem[],
        config?: HourEstimationConfig,
        appliedFilters?: WorkLogFilters
    ): WorkHourMetrics;
    estimateFromRepository(
        repoDir: string,
        filters?: WorkLogFilters,
        config?: HourEstimationConfig
    ): Promise<WorkHourMetrics>;
}