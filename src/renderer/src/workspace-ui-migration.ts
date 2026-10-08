/**
 * Legacy workspace-UI migration decisions.
 *
 * The retired `sessions` right-panel tab moved into the Agents section. The
 * predicates here are pure so the upgrade path stays covered without a DOM.
 */

/** Persisted workspace UI as written by released builds. */
export type PersistedWorkspaceUi = {
  rightSidebarTab?: string
  rightSidebarOpen?: boolean
  runsOpen?: boolean
} | undefined

/**
 * True only for profiles that actually had the retired Sessions panel open.
 *
 * A profile that merely prefers `runsOpen: false` must keep that preference:
 * redirecting a *closed* Sessions panel would override the user's saved state
 * on upgrade, and the next session persist would make that rewrite permanent.
 */
export function isLegacySessionsProfile(ui: PersistedWorkspaceUi): boolean {
  return ui?.rightSidebarTab === 'sessions' && ui.rightSidebarOpen === true
}
