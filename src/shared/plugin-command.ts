/**
 * Canonical plugin command identifier shared by the registry (storage side)
 * and the preload bridge (wire side) so an invoke from the renderer always
 * targets the key the registry actually registered.
 */
export function pluginCommandId(pluginId: string, method: string): string {
  return `${pluginId}.${method}`
}
