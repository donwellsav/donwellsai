import { useCallback, useEffect, useState } from 'react'
import type { ProviderCatalogSnapshot, ProviderInstanceInput } from '@shared/provider-authority'

/** Provider catalog hook. */
export function useProviderInstances() {
  const [snapshot, setSnapshot] = useState<ProviderCatalogSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** Every catalog call answers with the fresh sanitized snapshot or a message the panel can show. */
  const apply = useCallback(async (operation: () => Promise<ProviderCatalogSnapshot>): Promise<void> => {
    try {
      setSnapshot(await operation())
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  const refresh = useCallback(() => apply(() => window.donwells.providerCatalogRead()), [apply])
  useEffect(() => { void refresh() }, [refresh])

  const create = useCallback((input: ProviderInstanceInput) => apply(() => window.donwells.providerCatalogCreate(input)), [apply])
  const update = useCallback((instanceId: string, expectedRevision: number, input: ProviderInstanceInput) => apply(() => window.donwells.providerCatalogUpdate(instanceId, expectedRevision, input)), [apply])
  const remove = useCallback((instanceId: string, expectedRevision: number) => apply(() => window.donwells.providerCatalogRemove(instanceId, expectedRevision)), [apply])
  const setDefault = useCallback((instanceId: string | null, expectedRevision: number) => apply(() => window.donwells.providerCatalogSetDefault(instanceId, expectedRevision)), [apply])

  return { snapshot, error, refresh, create, update, remove, setDefault }
}
