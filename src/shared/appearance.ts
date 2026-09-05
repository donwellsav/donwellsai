import type { AppSettings } from './types'

export type AppearanceRequest = {
  theme: AppSettings['theme']
  zoomFactor: number
  background: string
  foreground: string
}

export type AppearanceApi = {
  applyAppearance(request: AppearanceRequest): Promise<void>
}
