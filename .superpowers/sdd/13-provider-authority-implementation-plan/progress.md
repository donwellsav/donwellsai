# SDD ledger — plan: /Users/muzikfirst/Documents/donwellsai/agentnotes/13-provider-authority-implementation-plan.md

Base: e6f3ca5e536201086df1b5a16302d62035bcc752 (Stage 2 accepted head)
Worktree: /Users/muzikfirst/Documents/donwellsai/.worktrees/stage-3-provider-authority
Branch: roadmap/stage-3-provider-authority
Stage 2 gates inherited: 24 files / 333 passed / 6 skipped; typecheck/build/package:check passed; macOS packaged/live proof receipts passed; Linux/Windows CI pending.

## Preflight

LSP status: unavailable in prior stages (workspace tsserver initialization failed); tracked-source censuses will replace LSP evidence and will not be mislabeled.
Task 1: implementer DONE at 906790c. Review found 3 P1 FK/mutation defects (default instance removal, instance update delete-reinsert, retired-binding account removal), 4 P2 contract/coverage gaps (prep purge, missing daemon mutation methods, incomplete required tests, weak duplicated certification matcher), and 4 P3 quality issues (duplicate capability/driver lists, platform coercion, sanitizer substring false positives). Fix round 1/5 dispatched, then re-dispatched after two workers crashed mid-edit (credit limits) leaving the tree uncompilable.
Fix round 1 DONE at fix commit (see task-1-report.md "Fix round 1"): compilability restored, all 3 P1 FK defects closed with non-vacuous proof (the new tests fail 4/4 at 906790c and pass after), P2/P3 closed. Found and fixed one additional live wire defect during testing: `agent.providers.update/remove/default` carried the instance in a wire field named `id`, colliding with the transport's correlation id, so `DaemonClient` could never correlate those replies and every call timed out. Gates: focused 57 passed; full suite 365 passed / 6 skipped (baseline 339/6); typecheck, build, package:check all passed.
Fix round 2 DONE (see task-1-report.md "Fix round 2"): re-review High confirmed and closed — round 1's stricter snapshot decoder called `parseAgentDriverId` on an instance's `command.driverId`, so one legacy instance for an unregistered driver rejected the whole snapshot, violating the brief's unknown-driver preservation rule. Tolerance is now scoped precisely to an instance whose driver projection is `unknown`; command structure is still enforced. Non-vacuity re-proven (3 new decode tests fail at 1c7c297). Gates: focused 60 passed; full suite 368 passed / 6 skipped; typecheck, build, package:check all passed.

Task 1: complete (commits e6f3ca5..722752b, review clean after 2 fix rounds; scoped re-review approved=true, no new breakage).
Parked Task 2 contract items from Task 1 review: command.driverId remains typed AgentDriverId on the tolerated unknown branch (mirrors in-process jsonCommand); task_launch_admissions rows purge with their expired preparation (durable record is the Stage 2 attempt); instance removal refuses while a live <=30s preparation names it with no explicit cancel path. Ruling: defer to Task 2 where the admission/consume surface is defined; cost if wrong is a narrow unsound cast and a short removal wait.
Task 2: implementer DONE at 8d14167 (7372ecd provider secret authority + protected store + saga; c35dae0 authenticated broker; 8d14167 raw-secret deletion + Graphiti stdin channel). See task-2-report.md.
Gates: focused 22 + 10 + 7 + 59 + 32 passed; full suite 407 passed / 6 skipped (baseline 368/6); typecheck, build, package:check passed. Tracked-source census clean for all four raw secret methods, DONWELLS_NEO4J_PASSWORD, and worker os.environ. Task 2 did not change live launch selection or renderer launch controls.
Five defects were found by this task's own tests and fixed at source: non-reentrant authority-lock deadlock in the saga guard; sealed tuple authenticating the pre-bind instance revision; non-monotonic credential revision; revoke returning post-retirement status; broker response parser rejecting its own transport envelope with a throwing stale-epoch path.
Awaiting review.
