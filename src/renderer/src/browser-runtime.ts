export type BrowserFindOptions = {
  forward?: boolean
  findNext?: boolean
  matchCase?: boolean
}

export type BrowserFindResult = {
  requestId: number
  activeMatchOrdinal: number
  matches: number
  finalUpdate?: boolean
}

export type BrowserFindPort = {
  findInPage(text: string, options?: BrowserFindOptions): number
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void
}

export type BrowserFindState = {
  query: string
  matchCase: boolean
  activeMatch: number
  totalMatches: number
}

type ActiveFindRequest = {
  requestId: number
  requestGeneration: number
  navigationGeneration: number
  query: string
  matchCase: boolean
}

const EMPTY_FIND_STATE: BrowserFindState = {
  query: '',
  matchCase: false,
  activeMatch: 0,
  totalMatches: 0
}

/**
 * Owns one guest's find session. Electron request ids plus our navigation
 * generation prevent late found-in-page events from repainting a newer query.
 */
export class BrowserFindController {
  private state: BrowserFindState = { ...EMPTY_FIND_STATE }
  private active: ActiveFindRequest | null = null
  private requestGeneration = 0
  private navigationGeneration = 0

  constructor(
    private readonly port: BrowserFindPort,
    private readonly onState: (state: BrowserFindState) => void
  ) {}

  snapshot(): BrowserFindState {
    return { ...this.state }
  }

  search(query: string, matchCase: boolean): void {
    this.state = { query, matchCase, activeMatch: 0, totalMatches: 0 }
    this.publish()
    if (!query) {
      this.invalidateRequest()
      this.clearNativeSelection()
      return
    }
    this.issue(query, matchCase, true, true)
  }

  next(): void {
    if (!this.state.query) return
    const restart = !this.active ||
      this.active.query !== this.state.query ||
      this.active.matchCase !== this.state.matchCase ||
      this.active.navigationGeneration !== this.navigationGeneration
    this.issue(this.state.query, this.state.matchCase, true, restart)
  }

  previous(): void {
    if (!this.state.query) return
    const restart = !this.active ||
      this.active.query !== this.state.query ||
      this.active.matchCase !== this.state.matchCase ||
      this.active.navigationGeneration !== this.navigationGeneration
    this.issue(this.state.query, this.state.matchCase, false, restart)
  }

  acceptResult(result: BrowserFindResult): void {
    const active = this.active
    if (
      !active ||
      result.requestId !== active.requestId ||
      active.requestGeneration !== this.requestGeneration ||
      active.navigationGeneration !== this.navigationGeneration
    ) {
      return
    }
    this.state = {
      ...this.state,
      activeMatch: Math.max(0, result.activeMatchOrdinal),
      totalMatches: Math.max(0, result.matches)
    }
    this.publish()
  }

  navigationStarted(): void {
    this.navigationGeneration += 1
    this.invalidateRequest()
    this.clearNativeSelection()
    this.state = { ...this.state, activeMatch: 0, totalMatches: 0 }
    this.publish()
  }

  close(): void {
    this.invalidateRequest()
    this.clearNativeSelection()
    this.state = { ...EMPTY_FIND_STATE }
    this.publish()
  }

  private issue(query: string, matchCase: boolean, forward: boolean, findNext: boolean): void {
    const requestGeneration = ++this.requestGeneration
    let requestId: number
    try {
      requestId = this.port.findInPage(query, { forward, findNext, matchCase })
    } catch {
      this.active = null
      return
    }
    this.active = {
      requestId,
      requestGeneration,
      navigationGeneration: this.navigationGeneration,
      query,
      matchCase
    }
  }

  private invalidateRequest(): void {
    this.requestGeneration += 1
    this.active = null
  }

  private clearNativeSelection(): void {
    try {
      this.port.stopFindInPage('clearSelection')
    } catch {
      // A persistent host may be disposing its guest while React closes the bar.
    }
  }

  private publish(): void {
    this.onState({ ...this.state })
  }
}
