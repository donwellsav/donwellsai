# Task 19 strengthening — in progress

## Index resource controls

Pause now suspends the existing document job at file, chunking, embedding-batch,
or pre-commit boundaries. The response distinguishes a pending pause from an
acknowledged pause. Resume retains the job ID. Models remain loaded; Stop
terminates the owned service and cancels the job. An in-flight native operation
finishes before a cooperative pause takes effect.

Progress polling and pause/resume require an already-running service. They cannot
start or automatically restart a stopped/crashed worker. Reopening the search
panel recovers the active job state. Search status and index status are separate.

Validation: build and all TypeScript projects passed. With the admitted local
QMD 2.8.3 and LanceDB 0.38.0 packages, 23 document/service checks passed; one
semantic-model qualification check was skipped because model paths were not set
for this run. Native checks cover stable paused progress, same-job resume through
completion, stopping while paused, old collection visibility before replacement,
sibling collection preservation, and no process launch/retry from progress reads.

Task 19 remains open: catalog/configuration, setup diagnosis and packaged UI
qualification are still pending. This is a verified implementation chunk, not
whole-task completion.
