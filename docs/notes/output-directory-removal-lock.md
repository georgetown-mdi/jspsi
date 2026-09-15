---
title: "The Output-Directory Removal's Write-Lock Wait"
---

# Waiting out the write lock on a failed write's removal

_Status: measurement backing `REMOVAL_LOCK_BUDGET_MS` in
[`managedOutputDirectory.ts`](../../apps/web/src/psi/managed/managedOutputDirectory.ts).
See [docs/notes/README.md](README.md)._

## The symptom

A failed write into a granted output folder creates the entry before any byte
reaches it. Removing that entry was refused with `NoModificationAllowedError`,
and the refusal was swallowed rather than retried, leaving an empty results file
standing in the operator's folder while the run's results were parked in the
browser instead.

## The cause

Chromium releases the write lock an aborted stream held one task turn after
`abort()` resolves. A removal issued immediately afterward is asked before that
turn runs, loses the race, and is refused.

## The measurement

Eight `yes` load probes kept a 10-core machine at a load average of 16-25
throughout.

| Condition | Failed writes | Empty files left | Removals refused once | Taken on next ask | Needed a third ask | Slowest clearance |
| --------- | -------------- | ----------------- | ---------------------- | ------------------ | -------------------- | ------------------ |
| Before the retry | 2400 | 160 (22, 92, 46 per 800-write batch) | -- | -- | -- | -- |
| After the retry | 800 | 0 | -- | -- | -- | -- |
| Across all removals, with the retry | 2400 | 0 | 180 (7.5%) | 180 (100%) | 0 | 13.4 ms after the first refusal |

Every refused removal cleared on the very next ask; none needed a third.

## Why a wall-clock bound rather than an attempt count

The lock's release is a task-queue turn, and how long that turn takes to run
varies with load rather than with how many times the removal has already asked.
A wall-clock budget bounds the wait directly against what was measured; an
attempt count would bound it against a turn count that has no fixed relationship
to elapsed time under load. `REMOVAL_LOCK_BUDGET_MS` is 200 ms, chosen against
the worst clearance observed (13.4 ms) with roughly a factor of fifteen held in
reserve.

## Where this lives in code

The constant: `REMOVAL_LOCK_BUDGET_MS` in
[`managedOutputDirectory.ts`](../../apps/web/src/psi/managed/managedOutputDirectory.ts).
The retry it bounds: `dropCreatedEntry` in the same file. The unit tests pinning
the retry and its bound:
[`managedOutputDirectory.test.ts`](../../apps/web/test/unit/psi/managedOutputDirectory.test.ts),
"asks again when the removal is refused over the write lock" and "gives up on a
write lock that never clears".
