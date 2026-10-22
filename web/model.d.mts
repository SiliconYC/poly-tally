import type { Dataset, Repository, Metric, Filters, Metrics, HistoryOptions, HistoryResult } from './src/lib/types'
export const METRICS: Exclude<Metric, 'total'>[]
export const METRIC_LABELS: Record<Metric, string>
export const STATUS_LABELS: Record<string, string>
export function metricValue(metrics: Partial<Metrics> | undefined, metric: Metric): number
export function repositoryVisibility(repository: Repository): 'public' | 'private'
export function repositoryDisplayName(repository: Repository): string
export function repositoryUpdatedAt(repository: Repository): string | null
export function selectRepositories(data: Dataset, options?: Partial<Filters>): Repository[]
export function latestTotals(repositories: Repository[], language?: string): Record<Metric, number>
export function languageTotals(repositories: Repository[], metric?: Metric, sort?: { key?: string; direction?: string }): {name: string; value: number}[]
export function repositoryShares(repositories: Repository[], options?: HistoryOptions): {id: string; name: string; value: number; share: number; percentage: number}[]
export function publicationSummary(data: Dataset): {publicRepositories: number; privateRepositories: number; privateUpdatedAt: string | null; privateSource: string | null; privateStatus: string}
export function applyDisplayWindow(data: Dataset, display?: Dataset['display']): Dataset
export function stackedHistory(repositories: Repository[], options?: HistoryOptions): HistoryResult
export function rankRepositoriesByHistoricalArea(repositories: Repository[], options?: HistoryOptions): Repository[]
export function aggregateHistory(repositories: Repository[], options?: HistoryOptions): {timestamp: string; value: number}[]
export function loadStats(fetcher?: typeof fetch): Promise<Dataset>
export function sortRepositories(repositories: Repository[], options?: {key?: string; direction?: string; metric?: Metric; language?: string}): Repository[]
export function repositoryOptions(repositories: Repository[], options?: {query?: string; key?: string; direction?: string; metric?: Metric; language?: string}): Repository[]
export function stockChange(repositories: Repository[], options?: HistoryOptions & {includeStart?: boolean}): {baseline: number | null; latest: number; change: number | null; missing: number}
