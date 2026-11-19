import type { HourEstimationConfig, WorkLogFilters } from '@/types/work-hour-estimator.types';

/**
 * Default filters: last 1 year and all authors (no author filter applied).
 */
export const DEFAULT_WORK_LOG_FILTERS: Readonly<WorkLogFilters> = {
    // Step 1: Default to a 1-year lookback window to capture meaningful implementation context.
    since: '1 year ago',
};

/**
 * Default estimation parameters used to translate Git commit activity into estimated work hours.
 *
 * Because every developer has a different daily schedule, commit granularity, and risk tolerance,
 * contributors and teams should adjust these values to match how they actually work:
 * - Think about how many focused hours you realistically spend on a project on a day when you commit
 *   (for example, part-time/side-project blocks vs. full-day sprints).
 * - Think about your commit style: frequent small commits per feature/fix call for a smaller
 *   per-file weight, while large or batched commits across many files may warrant slightly higher
 *   per-file or buffer weights.
 * - Use `optimisticFactor` and `conservativeFactor` to reflect how predictable your tasks are and
 *   how much safety margin you want for bugs, scope ambiguity, or reviews.
 */
export const DEFAULT_HOUR_ESTIMATION_CONFIG: Readonly<HourEstimationConfig> = {
    // Step 2: Set average base hours per active commit day (e.g., ~3.5h for ~4h/day work blocks
    // after accounting for file weights; lower for light/part-time days, higher for full days).
    hoursPerActiveDay: 3.5,

    // Step 3: Set hours added per unique modified file (e.g., 0.1h = 6m for granular commits;
    // increase if wide file changes usually indicate heavier integration and refactoring effort).
    hoursPerUniqueFile: 0.1,

    // Step 4: Set multiplier for the optimistic estimate (e.g., 0.8 = 20% lower than base hours
    // when tasks go smoothly with minimal rework or blockers).
    optimisticFactor: 0.8,

    // Step 5: Set multiplier for the conservative estimate (e.g., 1.3 = 30% above base hours
    // to cushion unexpected edge cases, debugging, or changing requirements).
    conservativeFactor: 1.3,
};