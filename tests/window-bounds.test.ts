import { expect, it } from 'vitest'
import { restoreWindowBounds } from '../src/main/window-bounds'

it('restores reachable bounds on current, removed and small displays', () => {
  const area = { x: -1920, y: 25, width: 1920, height: 1055 }
  const saved = { x: -1800, y: 50, width: 1100, height: 700 }
  expect(restoreWindowBounds(saved, area)).toEqual(saved)
  expect(restoreWindowBounds(saved, { x: 0, y: 25, width: 1440, height: 875 })).toEqual({ ...saved, x: 0 })
  expect(restoreWindowBounds(undefined, area)).toEqual({ x: -1600, y: 153, width: 1280, height: 800 })
  expect(restoreWindowBounds({ x: 9000, y: 9000, width: 3000, height: 2000 }, { x: 0, y: 0, width: 800, height: 500 }))
    .toEqual({ x: 0, y: 0, width: 800, height: 500 })
})
