# Task 05 — terminal-centered shell proposal and focus improvement

2026-09-07. **Task remains active. Visual approval was requested using the rendered proposal before replacing the shell, as this card explicitly requires.** The latest continuous-execution authorization covers implementation within approved scope; it does not supply an answer to the card's outstanding visual decision. Independent focus repairs are implemented while this decision is pending.

[Interactive layout proposal](layout-proposal.html) · [Rendered proposal](layout-proposal.png)

The preview contains illustrative terminal text, not actual agent output. It is not completion evidence.

## Proposed primary screen

- Main terminal surface stays `#16161D`; secondary surfaces use the existing related neutral tokens and restrained brass selection/focus accent. No font download, decorative cards, gradients or animation system.
- Left column: active project and actual checkout/branch identity, clearly labeled local execution; compact expandable project navigation; sessions directly below, with usable vertical space and real agent/provider/activity labels. Do not claim remote execution until the environment integration supplies that identity.
- Right rail: labeled Terminal, Agents, Layout, Search, Files, Changes, Memory and Control actions, with Recovery/Settings lower down. Consolidate the duplicate Add agent/Agents entry; the existing agent panel still supports starting and managing sessions.
- Tools open beside terminals. Remove RightSidebar's second horizontal tool-selector strip: one title and its move/close actions suffice when the same tools have visible rail entries.
- Keep one compact split-tab row; no new header above the terminal. Existing native terminal resource hosts, process ownership and docking persistence stay intact.
- Keep a visible Projects/Commands route when project navigation is collapsed. Preserve narrow-window reachability and keyboard routes; do not silently hide a tool at smaller sizes.

This is the primary shell arrangement, not Task29's final integrated-module polish. Implementation ownership: WorkspaceShell.tsx, workspace-shell.css, RightSidebar.tsx, workbench-dock.css, and shared focus/command routes. No new layout framework or component library.

## Research and component choice

Fresh repository snapshots are saved in `research/tool-trials/second-pass-shell` beside the checkout.

| Source | Inspected revision / terms | What it informs |
|---|---|---|
| [cmux](https://github.com/manaflow-ai/cmux/tree/7d78b6e4cb0236c3b4eb354d851498b685801e00) | 7d78b6e4cb0236c3b4eb354d851498b685801e00; current LICENSE GPL-3.0-or-later with separately offered commercial terms | Vertical workspace/session context and attention visibility are useful interaction precedents. No source or visual assets copied; not admitted as MIT/Apache. |
| [Ghostty](https://github.com/ghostty-org/ghostty/tree/82938b633ba646db38591d969c3c526332bd7e65) | 82938b633ba646db38591d969c3c526332bd7e65; MIT core | Direct split navigation/zoom and restrained terminal chrome. Task26's admitted version remains pinned, not automatically upgraded to this research head. |
| [FlexLayout](https://github.com/caplin/FlexLayout/tree/a848028c73d13cfaff1b11e6a6b87dadf2b2c98e) | a848028c73d13cfaff1b11e6a6b87dadf2b2c98e; MIT | Existing installed 0.10.8 already supports retained resource hosts and customizable split tabs. Improve presentation without remounting processes. |

Strongest architectural alternative is a fully native workspace navigation implementation. Task26 established the native terminal inside Electron; changing the host again to improve navigation would duplicate native/web panel ownership before demonstrating an interaction gain. This card uses the native terminal already integrated and rebuilds only the approved shell presentation.

## Independent focus repair

The shared navigation focus handler previously targeted xterm only. The sidebar had another local selector and focused the containing div for Ghostty. Selecting the already-active session changed no state, leaving the clicked navigation button focused. Closing Runs had no return-to-workspace focus route.

- Shared `focusPaneTarget` now targets the native terminal host as well as xterm and refuses delayed focus beneath an open app dialog/palette/settings/Runs screen.
- Tool-panel close, Runs close, session selection and numbered-tab selection route through that handler.
- The native acceptance probe now reads AppKit's first responder without assigning it, so checking focus cannot manufacture the result.

[Earlier package](native-focus-before.json) fails the close-tool native-focus regression. [Updated packaged focus receipt](native-focus.json) passes: actual native input/search/shortcut flow, close-tool and current-session focus restoration, retained process through renderer switching and recovery. Build/typecheck pass. A first trial incorrectly read a nonexistent `focused` diagnostic field; it was corrected to inspect AppKit's real first responder. That trial was a harness error, not evidence of a product failure.

Physical keyboard/pointer and rendered Metal pixels still need an unlocked desktop. No user-installed app was replaced. The native regression does not complete the proposed visual shell.
