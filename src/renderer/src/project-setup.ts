import { create } from 'zustand'

export type OpenProjectSetupOptions = {
  parentPath?: string
}

type ProjectSetupState = {
  open: boolean
  preferredParentPath?: string
  openSequence: number
}

export const useProjectSetup = create<ProjectSetupState>(() => ({
  open: false,
  openSequence: 0
}))

export function openProjectSetup(options: OpenProjectSetupOptions = {}): void {
  useProjectSetup.setState((state) => ({
    open: true,
    preferredParentPath: options.parentPath,
    openSequence: state.openSequence + 1
  }))
}

export function closeProjectSetup(): void {
  useProjectSetup.setState({ open: false })
}
