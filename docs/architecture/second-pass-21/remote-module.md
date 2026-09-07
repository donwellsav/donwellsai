# Remote terminal workspace increment

The SSH terminal now lives in the existing movable module system instead of a 340px box inside Settings. Its controls occupy a collapsible side column. The module receives its own checkout explicitly; hiding it pauses polling, resize and input collection while retaining the same xterm and remote session. Reopening does not replay terminal input or replace the remote owner. Settings routes to this module and closes. Project kits retain its portable pane kind, without machine pairing.

`remote-module-live.json` records the actual before/after terminal geometry, same DOM/PID/input sequence through hiding and reopening, and the later corrected dark/light colors at1280px and760px widths. The first visual inspection found nonexistent CSS tokens causing poor contrast; the final render uses the existing app theme tokens. Both owned zero-input SSH shells and local app/daemon were stopped afterward. No model turns were run for these changes. Existing layout/export checks and the current source build passed.

Final screenshots remain `/tmp/donwells-task21-final-render-1/{dark,light}-{1280,760}.png`. Expanded controls take substantial width in a narrow window; the40px collapse route preserves terminal space. Broader integrated ergonomics and physical native input remain open in Task21.
