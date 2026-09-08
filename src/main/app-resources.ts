import { app } from 'electron'
import { resolve } from 'node:path'

/** Both src/main and bundled out/main are two levels below the development root. */
export function appResourcesRoot(): string {
  return app.isPackaged ? process.resourcesPath : resolve(__dirname, '../..')
}
