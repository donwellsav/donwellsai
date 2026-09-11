import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { join } from 'node:path'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await electron.launch({
    args: [join(__dirname, '../out/main/index.js')],
    env: { ...process.env, DONWELLS_SMOKE: '1' },
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
})

test('app launches and shows main window', async () => {
  expect(page).toBeTruthy()
  const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.title)
  expect(title).toContain('donwells')
})

test('command palette opens on keyboard shortcut', async () => {
  await page.keyboard.press('Meta+KeyP')
  await expect(page.locator('[role="command-palette"]')).toBeVisible()
})
