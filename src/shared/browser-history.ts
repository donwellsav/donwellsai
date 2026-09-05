export const BROWSER_HISTORY_LIMIT = 250

export type BrowserHistoryEntry = {
  /** Last successfully committed HTTP(S) location. */
  url: string
  /** Stable comparison key; fragments are excluded so in-page anchors share one visit record. */
  normalizedUrl: string
  title: string
  lastVisitedAt: number
  visitCount: number
}

export type BrowserHistoryRecord = {
  url: string
  title: string
}

/** Main-owned history bridge. The renderer is a consumer, never a second persistence authority. */
export type BrowserHistoryApi = {
  browserHistoryList(): Promise<BrowserHistoryEntry[]>
  browserHistoryRecord(entry: BrowserHistoryRecord): Promise<BrowserHistoryEntry[]>
  browserHistoryClear(): Promise<void>
}
