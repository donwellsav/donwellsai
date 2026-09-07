import { initialize, TypeScriptWorker } from 'monaco-editor/language/typescript/ts.worker'

self.onmessage = null
let roots = []
// This message precedes Monaco's initialization handshake and never reaches it.
self.addEventListener('message', (event) => {
  if (event.data?.kind !== 'donwells-language-roots') return
  roots = event.data.roots.slice().sort((a, b) => b.length - a.length)
  event.stopImmediatePropagation()
})

self.onmessage = () => initialize((context, options) => {
  const services = new Map()
  const rootFor = (uri) => roots.find((root) => uri.startsWith(root))
  const serviceFor = (root) => {
    if (!services.has(root)) {
      services.set(root, new TypeScriptWorker({
        getMirrorModels: () => context.getMirrorModels().filter((model) => rootFor(model.uri.toString()) === root)
      }, options))
    }
    return services.get(root)
  }
  // Reuse Monaco's complete language API; each checkout owns its compiler program.
  return Object.fromEntries(Object.getOwnPropertyNames(TypeScriptWorker.prototype)
    .filter((name) => name !== 'constructor' && typeof TypeScriptWorker.prototype[name] === 'function')
    .map((name) => [name, (...args) => {
      const activeRoots = new Set(context.getMirrorModels().map((model) => rootFor(model.uri.toString())))
      for (const [root, service] of services) {
        if (root && !activeRoots.has(root)) {
          service.getLanguageService().dispose()
          services.delete(root)
        }
      }
      if (name === 'updateExtraLibs') {
        options.extraLibs = args[0]
        for (const service of services.values()) service.updateExtraLibs(args[0])
        return
      }
      const file = typeof args[0] === 'string' && args[0].startsWith('file:') ? args[0] : null
      const root = file ? rootFor(file) : null
      if (file && !root) throw new Error('File is outside registered editor workspaces')
      return serviceFor(root)[name](...args)
    }]))
})
