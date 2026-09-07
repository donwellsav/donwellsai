# Workflow portability and current learned export

The actual settings workflow exports native Hindsight learned documents alongside SPEC.md, TASKS.md and .agents/skills/app-workflow/SKILL.md, previews the archive, and restores into a new registered project with remapped fact identities. `kit-ui-live.json` confirms exact workflow bytes, retained learned facts and clean app/daemon shutdown. Existing native-transfer-live.json separately qualifies explicit learned import/re-embedding and target-scoped recall.

The UI exposed a real contract gap: general artifact confinement rejects hidden directories, including the generated app-workflow skill. The private kit path policy now admits only exact APP_WORKFLOW_FILES keys, keeping neighboring hidden skill paths, secrets and traversal rejected. The existing roundtrip check covers the exact skill and invalid neighbors. CLI export now forwards --include-learned through the same operation.

Temporal rebuild is now demonstrated in `temporal-restore-live.json`. Destination environment pairing still requires guest access and remains unqualified.

Environment re-pairing is now completed in `environment-restore-live.json`; actual collision handling and alternate-destination restore are in `collision-live.json`. See `delivery.md` for the rebuilt Task20 outcome.
