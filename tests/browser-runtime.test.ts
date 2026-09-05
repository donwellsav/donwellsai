import { describe, expect, it } from 'vitest'
import {
  BrowserFindController,
  type BrowserFindOptions,
  type BrowserFindPort,
  type BrowserFindState
} from '../src/renderer/src/browser-runtime'

class RecordingFindPort implements BrowserFindPort {
  readonly calls: Array<{ requestId: number; text: string; options?: BrowserFindOptions }> = []
  readonly stops: string[] = []
  private nextRequestId = 1

  findInPage(text: string, options?: BrowserFindOptions): number {
    const requestId = this.nextRequestId++
    this.calls.push({ requestId, text, options })
    return requestId
  }

  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void {
    this.stops.push(action)
  }
}

describe('BrowserFindController', () => {
  it('ignores results from superseded requests and from the previous navigation generation', () => {
    const port = new RecordingFindPort()
    const states: BrowserFindState[] = []
    const controller = new BrowserFindController(port, (state) => states.push(state))

    controller.search('first', false)
    controller.search('second', false)
    controller.acceptResult({ requestId: 1, activeMatchOrdinal: 1, matches: 9, finalUpdate: true })
    expect(controller.snapshot()).toMatchObject({ query: 'second', activeMatch: 0, totalMatches: 0 })

    controller.acceptResult({ requestId: 2, activeMatchOrdinal: 2, matches: 4, finalUpdate: true })
    expect(controller.snapshot()).toMatchObject({ query: 'second', activeMatch: 2, totalMatches: 4 })

    controller.navigationStarted()
    controller.acceptResult({ requestId: 2, activeMatchOrdinal: 3, matches: 4, finalUpdate: true })
    expect(controller.snapshot()).toMatchObject({ activeMatch: 0, totalMatches: 0 })
    expect(port.stops).toEqual(['clearSelection'])
    expect(states.at(-1)).toMatchObject({ activeMatch: 0, totalMatches: 0 })
  })

  it('starts new query and case sessions, then advances in both directions without restarting', () => {
    const port = new RecordingFindPort()
    const controller = new BrowserFindController(port, () => {})

    controller.search('Needle', false)
    controller.next()
    controller.previous()
    controller.search('Needle', true)

    expect(port.calls.map(({ text, options }) => ({ text, options }))).toEqual([
      { text: 'Needle', options: { forward: true, findNext: true, matchCase: false } },
      { text: 'Needle', options: { forward: true, findNext: false, matchCase: false } },
      { text: 'Needle', options: { forward: false, findNext: false, matchCase: false } },
      { text: 'Needle', options: { forward: true, findNext: true, matchCase: true } }
    ])
  })

  it('clears native selection and observable counts when the find bar closes', () => {
    const port = new RecordingFindPort()
    const controller = new BrowserFindController(port, () => {})

    controller.search('needle', false)
    controller.acceptResult({ requestId: 1, activeMatchOrdinal: 1, matches: 2 })
    controller.close()
    controller.acceptResult({ requestId: 1, activeMatchOrdinal: 2, matches: 2 })

    expect(controller.snapshot()).toEqual({
      query: '',
      matchCase: false,
      activeMatch: 0,
      totalMatches: 0
    })
    expect(port.stops).toEqual(['clearSelection'])
  })
})
