import React from 'react'
import ReactDOM from 'react-dom/client'
import * as Sentry from '@sentry/electron/renderer'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@xterm/xterm/css/xterm.css'
import './main.css'
import '@shared/i18n'
import { App } from './App'
import { useAppStore } from './store'
import i18n from '@shared/i18n'

// Sync i18n language with settings
useAppStore.subscribe((state) => {
  if (state.settings?.language && i18n.resolvedLanguage !== state.settings.language) {
    void i18n.changeLanguage(state.settings.language)
  }
})

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    release: `donwells@${import.meta.env.VITE_APP_VERSION || 'dev'}`,
    environment: import.meta.env.MODE || 'production',
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)