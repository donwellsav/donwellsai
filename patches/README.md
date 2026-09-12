# Local dependency fixes

`@xterm/addon-search@0.16.0`: invalidate cached terminal lines after parsed writes. A TUI can overwrite text while ending at the same cursor position, without linefeed/resize/cursor-move events. The old cache then returns stale search results. This patch adds the public `onWriteParsed` invalidation beside the existing listeners in TypeScript and both distributed module formats. It does not replace the terminal or change its public API.

Upstream inspected: [SearchLineCache.ts at c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/addons/addon-search/src/SearchLineCache.ts). Latest npm stable inspected was 0.16.0 (MIT); its published commit is f447274f430fd22513f6adbf9862d19524471c04. Retain the package's license. Remove the patch when an admitted upstream release invalidates overwritten lines and passes the same regression.

The former runnable regression (`tests/acceptance/terminal-recovery.mjs`) checked that the same TUI redraw changing INPUTS 0 to INPUTS 1 is searchable after hide/show, then exercised explicit daemon loss. That harness was deleted on 2026-09-11 with the rest of `tests/`; no replacement exists yet.
