import { useCallback, useEffect, useState } from 'react'
import type { ProviderCatalogSnapshot, ProviderInstanceInput } from '@shared/provider-authority'

/** Provider catalog hook. */
export function useProviderInstances() {
  const [snapshot, setSnapshot] = useState<ProviderCatalogSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  /**
   * Adopt a fresh sanitized snapshot. A mutator reports its own refusal to the
   * caller instead of replacing the loaded panel with an error: a refused write
   * must not blank the list the operator is working in.
   */
  const adopt = useCallback((next: ProviderCatalogSnapshot): void => {
    setSnapshot(next)
    setError(null)
  }, [])

  const refresh = useCallback(() => {
    void window.donwells.providerCatalogRead().then(adopt, caught => {
      setError(caught instanceof Error ? caught.message : String(caught))
    })
  }, [adopt])
  useEffect(() => { void refresh() }, [refresh])

  const mutate = useCallback(async (operation: () => Promise<ProviderCatalogSnapshot>): Promise<void> => {
    adopt(await operation())
  }, [adopt])

  const create = useCallback((input: ProviderInstanceInput) => mutate(() => window.donwells.providerCatalogCreate(input)), [mutate])
  const update = useCallback((instanceId: string, expectedRevision: number, input: ProviderInstanceInput) => mutate(() => window.donwells.providerCatalogUpdate(instanceId, expectedRevision, input)), [mutate])
  const remove = useCallback((instanceId: string, expectedRevision: number) => mutate(() => window.donwells.providerCatalogRemove(instanceId, expectedRevision)), [mutate])
  const setDefault = useCallback((instanceId: string | null, expectedRevision: number) => mutate(() => window.donwells.providerCatalogSetDefault(instanceId, expectedRevision)), [mutate])

  return { snapshot, error, refresh, create, update, remove, setDefault }
}
