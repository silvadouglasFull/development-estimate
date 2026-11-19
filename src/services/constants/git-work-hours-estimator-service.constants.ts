import { HourEstimationConfig, WorkLogFilters } from "@/types/work-hour-estimator.types";

/**
 * Default filters: last 90 days and all authors (no author filter applied).
 */
export const DEFAULT_WORK_LOG_FILTERS: Readonly<WorkLogFilters> = {
    since: '90 days ago',
};

/**
 * Default estimation parameters combining active days and unique files touched.
 */
export const DEFAULT_HOUR_ESTIMATION_CONFIG: Readonly<HourEstimationConfig> = {
    hoursPerActiveDay: 6,
    hoursPerUniqueFile: 0.25,
    optimisticFactor: 0.8,
    conservativeFactor: 1.35,
};