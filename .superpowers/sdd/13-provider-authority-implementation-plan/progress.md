# SDD ledger — plan: /Users/muzikfirst/Documents/donwellsai/agentnotes/13-provider-authority-implementation-plan.md

Base: e6f3ca5e536201086df1b5a16302d62035bcc752 (Stage 2 accepted head)
Worktree: /Users/muzikfirst/Documents/donwellsai/.worktrees/stage-3-provider-authority
Branch: roadmap/stage-3-provider-authority
Stage 2 gates inherited: 24 files / 333 passed / 6 skipped; typecheck/build/package:check passed; macOS packaged/live proof receipts passed; Linux/Windows CI pending.

## Preflight

LSP status: unavailable in prior stages (workspace tsserver initialization failed); tracked-source censuses will replace LSP evidence and will not be mislabeled.
Task 1: implementer DONE at 906790c. Review found 3 P1 FK/mutation defects (default instance removal, instance update delete-reinsert, retired-binding account removal), 4 P2 contract/coverage gaps (prep purge, missing daemon mutation methods, incomplete required tests, weak duplicated certification matcher), and 4 P3 quality issues (duplicate capability/driver lists, platform coercion, sanitizer substring false positives). Fix round 1/5 dispatched, then re-dispatched after two workers crashed mid-edit (credit limits) leaving the tree uncompilable.
Fix round 1 DONE at fix commit (see task-1-report.md "Fix round 1"): compilability restored, all 3 P1 FK defects closed with non-vacuous proof (the new tests fail 4/4 at 906790c and pass after), P2/P3 closed. Found and fixed one additional live wire defect during testing: `agent.providers.update/remove/default` carried the instance in a wire field named `id`, colliding with the transport's correlation id, so `DaemonClient` could never correlate those replies and every call timed out. Gates: focused 57 passed; full suite 365 passed / 6 skipped (baseline 339/6); typecheck, build, package:check all passed.
