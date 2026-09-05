import { nativeTheme, type BrowserWindow } from 'electron'
import type { AppearanceRequest } from '@shared/appearance'
import { validateSettingsPatch } from '@shared/settings'

const OPAQUE_COLOR = /^#(?:[a-f\d]{3}|[a-f\d]{6})$/i

export function applyWindowAppearance(window: BrowserWindow, request: AppearanceRequest): void {
  validateSettingsPatch({ theme: request.theme, uiScale: request.zoomFactor })
  if (!OPAQUE_COLOR.test(request.background) || !OPAQUE_COLOR.test(request.foreground)) {
    throw new Error('Native appearance requires opaque semantic colors')
  }
  if (window.isDestroyed()) throw new Error('The application window is closed')
  nativeTheme.themeSource = request.theme
  window.setBackgroundColor(request.background)
  window.webContents.setZoomFactor(request.zoomFactor)
}
