---
title: "CLI Doctor Verdict"
---

# CLI doctor verdict

This document specifies the machine-readable verdict the `psilink doctor` subcommands emit under `--json`: the document's fields, the byte encoding of the line holding them, the schema version and the compatibility rule a consumer applies before reading anything else, the `overall` and per-check status vocabularies, the fixed ordered check list each mode reports, what the verdict withholds, and the exit code each verdict maps to. It is the spec-tier complement to the operator-facing [Checking a network file drop](../CLI.md#checking-a-network-file-drop) section in [CLI.md](../CLI.md), which says what the two modes check and how an operator runs them; this document says what a caller may rely on. It does not cover the `SMB_*` inputs the checks read (see [CLI.md](../CLI.md#inputs)), the CLI-wide exit-code table these codes sit within (see [CLI.md](../CLI.md#exit-codes)), or the rendezvous semantics the checks are chosen to exercise (see [FILE_SYNC.md](FILE_SYNC.md)). Intended readers are implementors of a setup launcher or supervising process, and security auditors.

The verdict is a contract, not a formatted log: a launcher keys on the check ids and the `overall` value rather than parsing check lines, so a check keeps its id and a consumer reads `version` before anything else.

## The verdict document

`--json` writes the verdict as exactly one line of JSON on stdout, and nothing else reaches stdout, so a capture or a pipe holds the verdict alone. It replaces the human check lines rather than accompanying them. Without `--json` no verdict document is produced at all: the check lines go to stderr, and the exit code states the classification. Those lines are a rendering for a person to read rather than log records, so they have none of the `[timestamp] [level] [context]` prefix the CLI puts ahead of a diagnostic, and a launcher that collects and re-prints them passes on what the operator would have seen. They are written to the same destination the diagnostics are, so `--log-file` captures them, and `--log-level` admits or suppresses them exactly as it does a diagnostic.

```json
{"version":1,"mode":"probe","overall":"fix_and_retry","checks":[{"id":"tcp_445","status":"ok"},{"id":"write","status":"fail","meaning":"this account can read the folder but not write to it.","action":"ask whoever administers the share for write permission on this folder."}]}
```

| Field | Type | Value | Meaning |
| ----- | ---- | ----- | ------- |
| `version` | integer | `1` | Verdict schema version (see [Schema version](#schema-version-and-compatibility)). |
| `mode` | string | `probe` or `mount` | Which checks produced the verdict, matching the subcommand that ran. |
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

### The line is printable ASCII

Every byte of the emitted line is printable ASCII (`U+0020`-`U+007E`). A `meaning` or an `action` interpolates text this codebase did not choose: the `SMB_PATH` subfolder reaches the `subdirectory` check's `meaning` verbatim, and the doctor validates that variable against the C0 controls and DEL alone, so a C1 control, a bidi override, an astral character, or `U+2028`/`U+2029` in it is accepted and carried into the document. The `authentication` and `share_open` checks also include an `smbclient` NT_STATUS token in a `meaning`; that token is bounded to `NT_STATUS_[A-Z_]+` where it is extracted, so it is ASCII by construction and cannot contain such a byte -- `SMB_PATH` is the reachable source. Bare `JSON.stringify` escapes only `U+0000`-`U+001F`, the quote and the backslash, passing DEL, the whole C1 range, and `U+2028`/`U+2029` through. The verdict therefore rides the same encoder the `probe-host-key` machine lines do (`asciiSafeJsonLine`, `apps/cli/src/util/jsonLine.ts`; see [SFTP host-key verification](CHANNEL_SECURITY.md#sftp-host-key-verification), which specifies the encoder for those lines), which rewrites every UTF-16 code unit outside that range in the encoded text to the `\uHHHH` escape JSON already defines for it. A launcher that cannot classify a line prints it -- to a terminal, or into a log a person later reads -- and this is what makes doing so safe.

The escapes are JSON's own, so the keys, the value types, and the values a consumer parses back are exactly what a bare `JSON.stringify` would have produced. **This is not a second escaping altitude and not a redaction**: a launcher that renders a parsed `meaning` or `action` to a human escapes it once, at its own display sink, with nothing here to double (see CONTRIBUTING.md, Operator-facing escaping), and material that must not be shown at all is withheld where the verdict is composed (see [What the verdict withholds](#what-the-verdict-withholds)).

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
| `fix_and_retry` | The checks ran and at least one returned a verdict the operator can act on before running an exchange. | At least one `fail`, none of them a failure that made the checks unrunnable. A `fail` that ends the run early, leaving the checks after it `skipped`, still rolls up here. |
| `fatal` | The checks could not be run, so nothing was established either way -- neither that the share works nor that it does not. | At least one `fail` that made the checks unrunnable: the `smbclient` binary missing from the image, or the mount directory not listable. |

The two failure classes are distinguished by `overall` alone; which check was the unrunnable one is not itself a field. `fatal` outranks `fix_and_retry` because the two ask different things of the caller: a `fatal` verdict has no `action` to follow, since the checks that would have produced one never ran.

## Check status

| Status | Human label | Meaning | `meaning` | `action` |
| ------ | ----------- | ------- | --------- | -------- |
| `ok` | `OK:` | The check ran and establishes what it set out to. Nothing is asked of the operator. | optional | never |
| `warn` | `WARN:` | The check ran and does not block an exchange, but has something the operator should read -- a share that works only with `--lockless-rendezvous`, one nearly out of space, an exchange folder already past the transport's listing bound. | always | always |
| `fail` | `FAIL:` | The check ran and what it tests is not the case. Any `fail` moves `overall` to `fix_and_retry` or `fatal`. | always | always |
| `skipped` | `SKIP:` | The check did not establish its property, for one of three reasons the `meaning` states: an earlier check failed and stopped the run; the check does not apply to the inputs given; or the check was attempted and could not be completed. Every `skipped` record has a `meaning`. | always | optional |

`warn` is its own status rather than an `ok` with an `action`: a consumer classifies on `status` alone, without inferring severity from which optional fields are present, and both renderings key off the same field -- the human label column above is the whole mapping.

## The check list

The id set per mode is fixed and ordered. Every id below appears in every verdict that mode produces, in the order given, whatever stopped the run: a check that did not run is reported as `skipped`, never omitted, so a consumer can index the verdict by id without first discovering how far the run got.

`probe` -- the userspace checks, run over `smbclient` with nothing mounted:

| Id | What a passing check establishes |
| -- | -------------------------------- |
| `name_resolution` | The server name resolves from inside the container. A literal IPv4 address needs no resolution and passes on that basis. |
| `tcp_445` | A TCP connection to port 445 on the server completes. |
| `smbclient_available` | The `smbclient` binary is present. Its absence is the failure that makes the rest of these checks unrunnable. |
| `authentication` | The server accepted the credentials. A server that authenticates and then refuses to list its shares is `ok` with a `meaning`, not a failure: refusing the share list to ordinary accounts is common and decides nothing. |
| `share_open` | The share opened. When a subdirectory was given, a share root that will not list is `ok` with a `meaning` -- rights to one's own folder and nothing above it is the ordinary shape of an agency grant. |
| `subdirectory` | The folder the exchange will run in opened, and how many entries it holds. With no subdirectory configured this is the share root, counted the same way. A folder already holding more entries than the transport's directory-listing bound is a `warn` (see [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#directory-listing-bound)). |
| `free_space` | The free space the server reported for the share. Below 100 MB, or none at all, is a `warn`; a server that reports no figure makes this `skipped`. |
| `write` | A file was created in that folder. |
| `rename` | That file was renamed. |
| `delete` | The renamed file was deleted. |
| `marker` | The cross-check file was left behind for `doctor mount` to find. `skipped` when no marker or token was supplied, and when the share refused the write. |

`mount` -- the kernel checks, run against an already-mounted directory:

| Id | What a passing check establishes |
| -- | -------------------------------- |
| `mount_readable` | The directory exists and can be listed. Its failure is the failure that makes the rest of these checks unrunnable. |
| `marker` | The file `doctor probe` left behind is here and is this run's, so both sets of checks examined the same directory. A marker from a different run is a `warn`, and so is a matching marker the mount cannot delete; an absent one is a `fail`, since the mount and the probe are then pointing at different directories. `skipped` when no marker or token was supplied. |
| `write_rename` | A file was written under a temporary name and renamed into place, the shape psilink writes every message with. |
| `exclusive_create` | The share refuses to create a file that already exists -- the `O_EXCL` refusal psilink's rendezvous uses to decide which side goes first. A share that does not refuse it is a `warn`; a share where the create could not be tested at all is `skipped`, with an `action` naming the same remedy. |
| `rename_onto_existing` | The share renames a file onto an existing one, which psilink does when two sides meet at once. A share that will not is a `warn`. |

## What the verdict withholds

The record set behind both renderings has three fields the JSON document does not: the check's `summary` headline, a `detail` excerpt of the tool's own output behind a failure, and the marker for a failure that stopped the run.

`detail` is server-controlled text -- `smbclient` can answer with a whole share listing -- so a consumer receives the classified `meaning` and `action` rather than raw bytes to re-render. In the human rendering, where it is shown, a private-key strip runs over the whole excerpt first, before it is bounded: a key block arrives in its canonical multi-line form, so a strip applied to the bounded lines instead would match its `BEGIN` line alone and render the body verbatim, and this rendering's sink does not pass through the logger that would otherwise catch it (see [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#display-sanitization-escape-format)). The stripped excerpt is then bounded to the first 2,000 characters and the first 24 non-blank lines, with a trailing `... (output truncated)` line when either bound cut it -- measured against the stripped text, so a replacement that shortened the excerpt without either bound dropping anything does not report a cut that did not happen. The operator is asked to send that rendering on to whoever is helping them, so it is capped rather than sprayed. The `subdirectory` check reports a folder's entry count for the same reason and never its filenames: those are the operator's own names on their own share.

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

64 is also what an image predating this command answers to `doctor probe`: option validation does not reject the two words as positionals, so they reach the zero-setup default command, which reads the first of them as a server URL and refuses it. No exit code separates that from a doctor rejecting an input, and a published image cannot be changed after the fact, so a caller that may meet an older image establishes the command's presence before it runs any check -- `doctor --help` answers that without reading an `SMB_*` value or touching the share -- rather than reading a 64 as a verdict about its own inputs.

## Cleanup limits

Probe cleanup is attempted, never guaranteed. A delete is issued for every
working file the run created (`psilink-probe-*.tmp*`) on every handled exit
path, but its outcome is not re-verified: a share that refuses deletes or a
transport that dies mid-battery leaves the file in place. The next probe run
sweeps that name mask before its own staged test, which is the designed
safety check for such residue.

The marker file is the single persistent artifact: the probe
leaves it behind, and `doctor mount` consumes it on a matching cross-check.
