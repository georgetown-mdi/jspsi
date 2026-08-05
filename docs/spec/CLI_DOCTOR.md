---
title: "CLI Doctor Verdict"
---

# CLI doctor verdict

This document specifies the machine-readable verdict the `psilink doctor` subcommands emit under `--json`: the document's fields, the schema version and the compatibility rule a consumer applies before reading anything else, the `overall` and per-check status vocabularies, the fixed ordered check list each mode reports, what the verdict deliberately withholds, and the exit code each verdict maps to. It is the spec-tier complement to the operator-facing [Checking a network file drop](../CLI.md#checking-a-network-file-drop) section in [CLI.md](../CLI.md), which says what the two modes check and how an operator runs them; this document says what a caller may rely on. It does not cover the `SMB_*` inputs the checks read (see [CLI.md](../CLI.md#inputs)), the CLI-wide exit-code table these codes sit within (see [CLI.md](../CLI.md#exit-codes)), or the rendezvous semantics the checks are chosen to exercise (see [FILE_SYNC.md](FILE_SYNC.md)). Intended readers are implementors of a setup launcher or supervising process, and security auditors.

The verdict is a contract, not a formatted log: a launcher keys on the check ids and the `overall` value rather than parsing check lines, so a check keeps its id and a consumer reads `version` before anything else.

## The verdict document

`--json` writes the verdict as exactly one line of JSON on stdout, and nothing else reaches stdout, so a capture or a pipe holds the verdict alone. It replaces the human check lines rather than accompanying them. Without `--json` no verdict document is produced at all: the check lines go to stderr as diagnostics, and the exit code carries the classification.

```json
{"version":1,"mode":"probe","overall":"fix_and_retry","checks":[{"id":"tcp_445","status":"ok"},{"id":"write","status":"fail","meaning":"this account can read the folder but not write to it.","action":"ask whoever administers the share for write permission on this folder."}]}
```

| Field | Type | Value | Meaning |
| ----- | ---- | ----- | ------- |
| `version` | integer | `1` | Verdict schema version (see [Schema version](#schema-version-and-compatibility)). |
| `mode` | string | `probe` or `mount` | Which battery produced the verdict, matching the subcommand that ran. |
| `overall` | string | one of `ok`, `fix_and_retry`, `fatal` | The roll-up a caller branches on (see [Overall verdict](#overall-verdict)). |
| `checks` | array of check objects | | The mode's full ordered check list (see [The check list](#the-check-list)). |

Each entry of `checks`:

| Field | Type | Presence | Meaning |
| ----- | ---- | -------- | ------- |
| `id` | string | always | Stable identifier from the mode's fixed list. |
| `status` | string | always | One of `ok`, `warn`, `fail`, `skipped` (see [Check status](#check-status)). |
| `meaning` | string | per status | What the outcome means. |
| `action` | string | per status | What the operator does about it. |

No other member appears on either object. An optional field that has nothing to say is omitted rather than emitted as `null`, so a consumer tests presence, never a null value.

## Schema version and compatibility

`version` is a single integer, currently **1**. A consumer reads it first and refuses a value it does not know rather than parsing on.

Within a version:

- An added field is compatible; a consumer ignores members it does not know.
- A check added to a mode appears as an additional entry in `checks`, so a consumer keys on the ids it knows rather than on the list's length or an entry's position.

A new version is taken for any of: removing a field or a check id, changing what an existing field or check id means, adding a value to the `status` or `overall` vocabulary, or changing which exit code a verdict maps to. Both vocabularies are therefore closed within a version, and a consumer may switch on them exhaustively.

## Overall verdict

| Value | Meaning | Rolled up from |
| ----- | ------- | -------------- |
| `ok` | Nothing found here blocks an exchange. A `warn` check is reported under this value: it asks something of the operator without stopping them. | No check has status `fail`. |
| `fix_and_retry` | The checks ran and at least one returned a verdict the operator can act on before running an exchange. | At least one `fail`, none of which stopped the battery. |
| `fatal` | The checks could not be run, so nothing was established either way -- neither that the share works nor that it does not. | At least one `fail` that stopped the battery from running: the `smbclient` binary missing from the image, or the mount directory not listable. |

The two failure classes are distinguished by `overall` alone; which check stopped the battery is not itself a field. `fatal` outranks `fix_and_retry` because the two ask different things of the caller: a `fatal` verdict has no `action` to follow, since the checks that would have produced one never ran.

## Check status

| Status | Human label | Meaning | `meaning` | `action` |
| ------ | ----------- | ------- | --------- | -------- |
| `ok` | `OK:` | The check ran and establishes what it set out to. Nothing is asked of the operator. | optional | never |
| `warn` | `WARN:` | The check ran and does not block an exchange, but carries something the operator should read -- a share that works only with `--lockless-rendezvous`, one nearly out of space, an exchange folder already past the transport's listing bound. | always | always |
| `fail` | `FAIL:` | The check ran and what it tests is not the case. Any `fail` moves `overall` to `fix_and_retry` or `fatal`. | always | always |
| `skipped` | `SKIP:` | The check did not run: either an earlier check failed and stopped the battery, or the check does not apply to the inputs given. The `meaning` distinguishes the two. | optional | optional |

`warn` is its own status rather than an `ok` carrying an `action`: a consumer classifies on `status` alone, without inferring severity from which optional fields are present, and both renderings key off the same field -- the human label column above is the whole mapping.

## The check list

The id set per mode is fixed and ordered. Every id below appears in every verdict that mode produces, in the order given, whatever stopped the run: a check that did not run is reported as `skipped`, never omitted, so a consumer can index the verdict by id without first discovering how far the run got.

`probe` -- the userspace battery, run over `smbclient` with nothing mounted:

| Id | What a passing check establishes |
| -- | -------------------------------- |
| `name_resolution` | The server name resolves from inside the container. A literal IPv4 address needs no resolution and passes on that basis. |
| `tcp_445` | A TCP connection to port 445 on the server completes. |
| `smbclient_available` | The `smbclient` binary is present. Its absence is the failure that stops this battery. |
| `authentication` | The server accepted the credentials. A server that authenticates and then refuses to list its shares is `ok` with a `meaning`, not a failure: refusing the share list to ordinary accounts is common and decides nothing. |
| `share_open` | The share opened. When a subdirectory was given, a share root that will not list is `ok` with a `meaning` -- rights to one's own folder and nothing above it is the ordinary shape of an agency grant. |
| `subdirectory` | The folder the exchange will run in opened, and how many entries it holds. With no subdirectory configured this is the share root, counted the same way. A folder already holding more entries than the transport's directory-listing bound is a `warn` (see [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#directory-listing-bound)). |
| `free_space` | The free space the server reported for the share. Below 100 MB, or none at all, is a `warn`; a server that reports no figure makes this `skipped`. |
| `write` | A file was created in that folder. |
| `rename` | That file was renamed. |
| `delete` | The renamed file was deleted. |
| `marker` | The cross-check file was left behind for `doctor mount` to find. `skipped` when no marker or token was supplied, and when the share refused the write. |

`mount` -- the kernel battery, run against an already-mounted directory:

| Id | What a passing check establishes |
| -- | -------------------------------- |
| `mount_readable` | The directory exists and can be listed. Its failure is the failure that stops this battery. |
| `marker` | The file `doctor probe` left behind is here and is this run's, so both batteries examined the same directory. A marker from a different run is a `warn`; an absent one is a `fail`, since the mount and the probe are then pointing at different directories. `skipped` when no marker or token was supplied. |
| `write_rename` | A file was written under a temporary name and renamed into place, the shape psilink writes every message with. |
| `exclusive_create` | The share refuses to create a file that already exists -- the `O_EXCL` refusal psilink's rendezvous uses to decide which side goes first. A share that does not refuse it is a `warn`; a share where the create could not be tested at all is `skipped`, carrying an `action` naming the same remedy. |
| `rename_onto_existing` | The share renames a file onto an existing one, which psilink does when two sides meet at once. A share that will not is a `warn`. |

## What the verdict withholds

The record set behind both renderings carries three fields the JSON document does not: the check's `summary` headline, a `detail` excerpt of the tool's own output behind a failure, and the marker for a failure that stopped the battery.

`detail` is server-controlled text -- `smbclient` can answer with a whole share listing -- so a consumer receives the classified `meaning` and `action` rather than raw bytes to re-render. In the human rendering, where it is shown, that excerpt is bounded to the first 2,000 characters and the first 24 non-blank lines of the output, with a trailing `... (output truncated)` line when either bound cut it; the operator is asked to send that rendering on to whoever is helping them, so it is capped rather than sprayed. The `subdirectory` check reports a folder's entry count for the same reason and never its filenames: those are the operator's own names on their own share.

## Exit codes

The exit code is set from `overall`, identically with and without `--json`, so a caller that does not parse the verdict still receives the classification:

| `overall` | Code | Name |
| --------- | ---- | ---- |
| `ok` | 0 | success |
| `fix_and_retry` | 78 | `EX_CONFIG` |
| `fatal` | 69 | `EX_UNAVAILABLE` |

The two nonzero values follow BSD `sysexits`, as the rest of the CLI does: `fix_and_retry` is a configuration the operator changes, and `fatal` is something the doctor depends on not being available (the `smbclient` binary, or the mounted directory itself).

Every code above is below 125, which Docker reserves for its own failure to start a container, so a caller running the doctor in a container can tell "Docker could not run it" from any verdict the command reaches.

A usage error -- a missing or malformed input, or a bad flag -- is not in that set: it exits 64 (`EX_USAGE`) and prints no verdict on either stream, because the checks never ran. A caller that sees 64 has established nothing about the share.
