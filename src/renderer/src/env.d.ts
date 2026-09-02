// Global declarations. Keep free of top-level imports so this stays a script file —
// an import would make it a module and disallow ambient `declare module` here.
interface Window {
  orca: import('@shared/types').IpcApi
}

declare module '*.css'