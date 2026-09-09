import { useLayoutEffect } from 'react'
import type { AppSettings } from '@shared/types'
import { monaco } from './monaco-setup'

const OPAQUE_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

function canonicalColor(root: HTMLElement, property: '--background' | '--foreground'): string {
  const value = getComputedStyle(root).getPropertyValue(property).trim()
  if (!OPAQUE_HEX.test(value)) throw new Error(`${property} must resolve to an opaque hexadecimal color`)
  return value
}

/** Applies renderer and native-window appearance without CSS zooming the BrowserHost coordinate space. */
export function useAppearance(settings: AppSettings): void {
  useLayoutEffect(() => {
    document.documentElement.dataset.interfaceFont = settings.interfaceFont
    document.documentElement.dataset.motion = settings.interfaceMotion
    document.documentElement.dataset.density = settings.interfaceDensity
    document.documentElement.dataset.navigation = settings.navigationLabels
  }, [settings.interfaceDensity, settings.navigationLabels, settings.interfaceFont, settings.interfaceMotion])

  useLayoutEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia('(prefers-color-scheme: dark)')

    const apply = (): void => {
      const resolved = settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : settings.theme
      root.dataset.theme = resolved
      root.dataset.themePreference = settings.theme
      root.classList.toggle('dark', resolved === 'dark')
      root.style.colorScheme = resolved
      monaco.editor.setTheme(resolved === 'dark' ? 'donwells-dark' : 'donwells-light')

      const request = {
        theme: settings.theme,
        zoomFactor: settings.uiScale,
        background: canonicalColor(root, '--background'),
        foreground: canonicalColor(root, '--foreground')
      }
      void window.donwells.applyAppearance(request).then(
        () => delete root.dataset.appearanceError,
        (error: unknown) => {
          root.dataset.appearanceError = error instanceof Error ? error.message : String(error)
        }
      )
    }

    apply()
    if (settings.theme !== 'system') return
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [settings.theme, settings.uiScale])
}
