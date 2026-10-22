import type { Repository, HistoryOptions, ChangePeriod } from './src/lib/types'
export function periodChanges(repositories: Repository[], options?: HistoryOptions & {period?: 'day' | 'week' | 'month'; limit?: number}): ChangePeriod[]
export function monthlyChanges(repositories: Repository[], options?: HistoryOptions): ChangePeriod[]
export function repositoryCsv(repositories: Repository[], language?: string): string
