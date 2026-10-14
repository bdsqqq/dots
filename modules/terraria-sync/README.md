# syncing game saves

sync makes another device converge on changes, including unwanted deletions.
it does not replace a backup. the aim is to move play between devices without
making the synchronized copy the only recovery option.

## avoid competing writers

sync the game's native save folders rather than maintaining a second copy job.
another copy introduces another timing boundary and another place for stale
saves to look authoritative.

cloud saves and folder sync can write independently. choose an authority before
sharing existing saves; disabling cloud sync alone does not move cloud-held
saves into local storage. preserve separate copies before resolving collisions.

## hand off only after the game closes

a player and world are separate files, not one synchronized transaction.
a watcher delay can reduce repeated transfers but cannot make an in-progress
save consistent.

quit the game, finish syncing, then open it on the other device. a disconnected
or suspended device may still hold changes no receiving copy has seen. prove
the handoff in both directions with disposable saves and compatible game
versions before relying on it.

## retain a recovery path outside active play

incoming-change versioning can preserve remote replacements and deletions
without capturing a playing device's own writes. an independent receiving copy
therefore provides a useful boundary for versioning and backup; it is not a
second place to edit saves.

for recovery, stop the game and pause synchronization before selecting a
version. restore into a separate location, inspect it, and choose the copy that
should become authoritative before resuming. retain conflicting versions until
that choice is deliberate.
