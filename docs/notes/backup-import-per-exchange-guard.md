---
title: "A Per-Exchange Guard on the Backup Import"
---

# A per-exchange guard on the backup import, in place of the empty-list rule

_Status: decided on the maintainer's ruling and built. The rule is normatively specified in [MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#reconciling-a-backup-import); this note records the rule it replaced and why. See [docs/notes/README.md](README.md)._

## The superseded rule

The web app's backup import was offered only beside an empty or unreadable list of recurring exchanges. A populated list offered a configuration-only import instead, which refused a backup file by name.

The rule stood in for a check the reconciliation did not have. The import already revived a migration-spent record holding the backup's secret and refused one handed off to the command line. It had no answer for a LIVE record of the same exchange: a live record holding the backup's secret installed a second copy beside it, and a live record that had run since the backup -- whose secret had rotated past the file's -- matched nothing at all. Keeping the import away from any populated list kept both cases away from it.

## What it cost

- **A dead end on a moved exchange.** A row moved to another device told the operator to import the backup to run it here again, and the only list that row appears on is a populated one, which refused the backup.
- **Deleting to import.** The one way to reach the backup import from a populated list was to delete every listed exchange. Deleting a handed-off record deletes the record the handed-off refusal is checked against, so the route out of the dead end removed a guard on the way.

## The rule taken

A backup holds one exchange, so the guard is a lookup against that exchange rather than a condition on the rest of the store. One import control stands beside every list state, and a backup reconciles to one of four named outcomes: restored this device's spent copy, added as new, refused because a live copy is already here, or refused because it was handed off to the command line.

The missing live-copy check is two checks:

- **By secret**: a live record holding the backup's secret is this exchange, and the import refuses, naming it -- the rule the command-line pair import already had.
- **By agreed terms and side**, for a live copy whose secret has rotated past the file's: the import names every such record in one question and installs nothing unless the operator confirms, once, installing beside them.

Equal terms and side is a heuristic -- two separate exchanges with one partner can share both -- so the second check asks rather than refuses, the warn-and-guide stance `CLAUDE.md` sets for the operator's own choices. The rule is stated once in the spec and implemented once (`findLiveCopiesByTermsAndSide`), so the pair import can apply it to a stored exchange its key file no longer matches.

## Options weighed

- **A take-back on the moved row alone**, leaving the empty-list rule in place. It closes the dead end for the one row that names it and leaves the populated list unable to take any backup, and it keeps the list-level gate standing in for a check the store should make. Declined in favor of the per-exchange guard.
- **Refusing on equal terms and side.** Certain to block a real second exchange with the same partner and terms, which the operator has no other way to import. Declined: the match is a question.
