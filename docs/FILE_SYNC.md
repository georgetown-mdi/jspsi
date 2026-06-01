---
title: "File-sync transport state model"
---

# File-sync transport state model

This is the single source of truth for the *intended* state mechanics of `FileSyncConnection` (the `sftp` and `filedrop` channels). It exists because the rendezvous and message-loop behaviour is an implicit state machine spread across several enforcement sites in one file, and because a cluster of planned changes each add a new file type or transition to it. Without one model to point at, each change re-derives the mechanics from prose and the enforcement sites drift apart. This document is the shared target; the planned work is tracked against it in [How the planned work converges on this model](#how-the-planned-work-converges-on-this-model).

This is a developer/design document. For the user-facing configuration reference and the canonical filename grammar see [EXCHANGE_SPEC.md](EXCHANGE_SPEC.md); for the high-level channel and synchronization overview see [COMMUNICATION.md](COMMUNICATION.md); for the cryptographic protocol see [PROTOCOL.md](PROTOCOL.md). Where this document and EXCHANGE_SPEC overlap, EXCHANGE_SPEC owns the filename grammar and this document owns the state machine.

## Core principle: the directory is the state machine

Two parties share one directory (an SFTP path or a local filedrop path) and never hold a lock on it. Each party mutates the shared state only by `put`, `delete`, and `rename`, and observes the peer only by `list`. The protocol state is therefore exactly **the set of filenames present in the directory**. Everything else -- roles, modes, who has consumed what -- is inferred from that set.

Two consequences follow, and they are the reason this document exists:

1. Correctness reduces to agreement on two things: which filenames are legal at each phase, and how each file is routed (treated as a message, a control signal, or ignored). A bug is almost always a disagreement about one of those two between the two parties, or between two of this code's own enforcement sites.
2. Every new file type is a new symbol in the state machine's alphabet, and must be accounted for at *every* site that reads the directory. Adding one without updating all of them is the standard failure mode.

## The single load-bearing invariant: the filename grammar

Routing safety rests entirely on one rule, defined in full under [EXCHANGE_SPEC.md "Filename grammar"](EXCHANGE_SPEC.md#filename-grammar) and restated here as the discriminant the state machine depends on:

> A protocol file is named `<id>-...-<token>.json`. If `<token>` is all digits the file is a **message** and `<token>` is its declared byte count. Otherwise `<token>` is a **type word** (`hello`, `ack`, and the planned `joining`, `receipt`) and the file is a **control file** that is never routed as a message.

In code this discriminant is `parseMessageByteCount(name) !== undefined` ([fileSyncConnection.ts:20](../packages/core/src/connection/fileSyncConnection.ts#L20)). A `.tmp` file (the in-flight `temp-<uuid>.tmp` write) and a `.wave` file are excluded earlier, by extension. The grammar is what lets the message scan ignore a renamed hello, an ack, or a receipt without an explicit per-type exclusion -- so every new control file gets a non-numeric terminal token *for free*, provided the site that reads the directory uses the discriminant rather than a bare prefix glob.

### File taxonomy

Every row here must agree with every column for the state machine to be consistent. "Planned" rows are not implemented yet; they are the target the issues converge on.

| File | Pattern | Written by | Token | Has payload | Byte-count gated | In `responsibleFiles` | Swept by `cleanup()` | Routed by `poll()` | Seen by `hasOutstandingMessage` |
|------|---------|-----------|-------|-------------|------------------|----------------------|----------------------|--------------------|--------------------------------|
| hello | `<id>-hello.json` | each party | `hello` | **yes (envelope; fields planned: bilateral flags via 193901017)** | no (I5 read gate instead) | yes | yes (not in retain mode) | no (non-numeric) | no (non-numeric) |
| wave | `<id1>-<id2>.wave` | starter (wave path) | n/a (`.wave`) | no | n/a | yes | yes | no (extension) | no (extension) |
| hello-ack | `<id>-hello-ack.json` (**planned: `<peerId>-hello-ack.json`**) | each party (lockless) | `ack` | **yes (envelope; fields planned: writer id via 194304738)** | no (I5 read gate instead) | yes | yes (not in retain mode) | no (non-numeric) | no (non-numeric) |
| message | `<id>-<bytes>.json` or `<id>-<ts>-<NNN>-<bytes>.json` | each party | numeric | yes | **yes** | yes | yes (not in retain mode) | **yes** | **yes** |
| temp | `temp-<uuid>.tmp` | each party (in-flight) | n/a (`.tmp`) | partial write | n/a | no | best-effort on error | no (extension) | no (extension) |
| joining (planned) | `<id>-joining.json` | joiner (wave path) | `joining` | marker | no | yes | yes | no (non-numeric) | no (non-numeric) |
| receipt (planned) | `<receiverId>-<ts>-<NNN>-<bytes>-receipt.json` | receiver (retain mode) | `receipt` | yes | **yes (size before token)** | yes | **no (transcript is retained)** | no (non-numeric) | no (non-numeric) |

## The five enforcement sites

The state machine is enforced -- and therefore must be kept consistent -- at exactly these five places in [fileSyncConnection.ts](../packages/core/src/connection/fileSyncConnection.ts). Adding or changing a file type is a change to *all applicable rows of the taxonomy at all five sites*; this is the anti-drift checklist.

1. **Preexisting-file guard** (`synchronize()` start, ~[:457](../packages/core/src/connection/fileSyncConnection.ts#L457)). Rejects a non-clean start: more than one hello, any `.wave`, or any `-hello-ack.json` left over from a crashed session. A new control file that can be left behind by a crash belongs here.
2. **`responsibleFiles` + `cleanup()`** (~[:447](../packages/core/src/connection/fileSyncConnection.ts#L447), ~[:341](../packages/core/src/connection/fileSyncConnection.ts#L341)). The set of files this party created and must remove on `close()`/`cleanup()`. Pre-track before writing so a crash mid-write is still swept. Retain mode is the sole exception: exchange files are intentionally not swept.
3. **`poll()` message scan** (~[:1106](../packages/core/src/connection/fileSyncConnection.ts#L1106)). Reads the peer's messages: `<peerId>-` prefix, `.json`, numeric terminal, and `size >= declaredSize`. Non-numeric terminals are ignored, not errors.
4. **`hasOutstandingMessage`** (~[:989](../packages/core/src/connection/fileSyncConnection.ts#L989)). The delete-mode sender waits here for the peer to consume (delete) its last message. Must use the grammar discriminant (it does: `parseMessageByteCount(name) !== undefined`) so the party's own hello/ack/receipt are not mistaken for an outstanding message.
5. **Rendezvous role and collision logic** (wave path ~[:488](../packages/core/src/connection/fileSyncConnection.ts#L488), lockless path ~[:593](../packages/core/src/connection/fileSyncConnection.ts#L593), role commit ~[:661](../packages/core/src/connection/fileSyncConnection.ts#L661)). Assigns `role`/`handshakeRole`/`peerId`, detects the two-hello collision, and recovers the peer id by fixed-suffix slicing (never by parsing).

## Two orthogonal mode axes

The transport has two independent binary modes. They are bilateral: both parties must choose the same value, and there is no negotiation (see [Bilateral configuration](#bilateral-configuration-detect-and-fail-never-negotiate)).

- **Rendezvous mode** -- how the two parties meet:
  - *Wave* (default, `lockless_rendezvous: false`): atomic exclusive-create plus a `.wave` tiebreaker; the joiner deletes the peer hello and writes its own. Requires deletion visibility and exclusive-create.
  - *Lockless* (`lockless_rendezvous: true`): an ack-handshake barrier that uses neither exclusive-create nor delete; both hellos and both acks coexist. For sync-mediated transports where both sides "win" a local create or deletions do not propagate.
- **Message-loop mode** -- how send/consume is signalled:
  - *Delete-as-signal* (default): the receiver deletes the sender's message file; the sender waits for that deletion before sending the next.
  - *Retain* (planned, `retain_files: true`): no exchange file is deleted; the receiver writes a `receipt` the sender waits for instead. For transports that do not propagate deletions, and for audit transcripts.

The four combinations are all valid. The rendezvous axis and the message-loop axis do not interact except through shared invariants (notably the retain-mode cleanup exception and the fresh-directory precondition).

## Phases and legal directory contents

Read each phase as "given this mode, the directory may legitimately contain exactly this set; anything else is an error or a not-yet-synced transient."

### Phase 0 -- clean start

Legal contents at entry: nothing this protocol owns. The preexisting-file guard aborts on any leftover hello, wave, or ack (and, planned, `joining`). This is what makes the fresh-directory precondition enforceable rather than merely documented.

### Phase 1 -- rendezvous, wave path

```
A put A-hello.json
B list -> sees A-hello.json            (B is the joiner)
B delete A-hello.json ; B put B-hello.json
A list -> sees B-hello.json ; A writes the wave
both reconstruct <first>-<second>.wave and assign roles by filename order
```

Legal transient contents: one self hello, optionally one peer hello, optionally one wave. The joiner's `delete`-then-`put` is the one observable inconsistency window (peer hello gone, joiner hello not yet written); closing it cleanly is the planned `joining` sentinel. Role is derived from hello *filename order* (`thisFile.name < otherFile.name`), which is the source of truth the wave producer encodes -- never from a fresh id comparison, because for ids where one is a prefix of the other the two can diverge.

### Phase 1 -- rendezvous, lockless path

```
A put A-hello.json ; B put B-hello.json   (neither deletes the other)
each, on seeing the peer hello, writes its ack once
each completes when it sees the peer's ack
```

Legal contents: both hellos and both acks coexist and persist into the message loop (they are not deleted at rendezvous). This is why sites 3 and 4 must rely on the grammar discriminant: the party's own `<id>-hello.json` and ack share its message prefix and would be false positives under a bare `<id>-*` glob.

### Phase 2 -- message loop, delete mode

The sender writes `temp-<uuid>.tmp`, renames it to the final numeric-terminal name (so a watcher never sees a partial file under its final name), and then blocks in `hasOutstandingMessage` until the peer deletes it. The receiver's `poll()` reads one peer message once its on-disk size reaches the declared byte count, emits `data`, and deletes it. Legal contents: at most one outstanding message per direction.

### Phase 2 -- message loop, retain mode (planned)

Same write path, but the receiver writes a `receipt` (carrying the consumed message's `<NNN>`) before emitting `data`, then attempts a best-effort, failure-tolerated delete. The sender gates its next send on a receipt whose parsed `<NNN>` equals the just-sent `seq` *and* whose on-disk size has reached its own declared byte count. No exchange file is deleted as a protocol step.

### Phase 3 -- cleanup and close

`close()` calls `cleanup()`, which removes every file in `responsibleFiles`. In retain mode `cleanup()` removes only an in-flight `temp-*.tmp`; the `*.json` transcript is left in place by design. `close()` and `cleanup()` must not diverge on this.

## Invariants

These are the testable properties the state machine must preserve. New work should be checkable against this list.

- **I1 -- one peer at rendezvous.** More than one peer hello is a terminal usage error ("other sessions using this path?"), in both rendezvous paths.
- **I2 -- grammar routing.** A file is routed as a message iff its terminal `.json` segment is all digits. Control files (`hello`, `ack`, `joining`, `receipt`) are never routed.
- **I3 -- own files are not self-messages.** A party's own control files share its message prefix; sites 3 and 4 must exclude them via the grammar discriminant, not a per-type suffix list. (Lockless makes this load-bearing because own hello and ack persist into Phase 2.)
- **I4 -- responsibility and cleanup.** Every file a party creates is pre-tracked in `responsibleFiles` and swept by `cleanup()`, except that retain mode intentionally retains exchange files (sweeping only `temp-*.tmp`).
- **I5 -- partial-sync safety for every payload-bearing file.** A file whose body is read for content must not be read before the sync tool has finished writing it. Messages carry a body gated by a byte count *in the filename*; receipts the same. Control files have no byte-count segment in their names; they use a read gate (`readControlFileWithGate` in `fileSyncConnection.ts`) that retries on a short/unparseable read until the peer timeout. A fully-synced body that parses but fails the envelope schema is a terminal `UsageError`. This gate was introduced by `194332289` for the hello (both rendezvous branches) and the lockless ack; see [Payload-bearing control files](#payload-bearing-control-files-i5).
- **I6 -- terminal failure, no caller retry.** `synchronize()` and `send()` always present a terminal failure to the caller; the caller does not retry. Any bounded retry is internal.
- **I7 -- role from filename order.** Wave-path role assignment derives from hello filename order, never from a fresh id comparison.

## Preconditions for a correct exchange

These operator-level requirements are part of the model: violating any of them silently corrupts or stalls the exchange, and several are not otherwise enforced in code. They are collected here so they live in one place rather than scattered across feature docs.

- **Dedicated directory.** One active exchange, exactly two parties, per directory. See [EXCHANGE_SPEC.md "Directory exclusivity"](EXCHANGE_SPEC.md#directory-exclusivity).
- **Matching builds.** There is no `protocol_version` field; both parties run compatible builds and the payload schema is a hard contract. A payload-schema change (e.g. adding hello flags) is a flag-day that both sides must deploy together.
- **Identical bilateral flags.** `lockless_rendezvous` and (planned) `retain_files` must match on both sides.
- **Fresh directory in retain mode.** Retain mode never deletes, so a reused directory leaves a prior exchange's files; combined with a stable `peer_id` a new session could read a prior message as current. A fresh directory per exchange is a hard requirement, not a suggestion.
- **Distinct, non-prefix peer ids.** When `peer_id` is configured, the two ids must be distinct, and neither may be the other extended by `-` (e.g. `site` / `site-2`), which would break message prefix-routing. UUIDs (the default) satisfy this automatically.

## Bilateral configuration: detect and fail, never negotiate

`lockless_rendezvous` and `retain_files` are bilateral agreements with no negotiation step. The deliberate stance is **mismatch detection and clear failure, not capability negotiation**: a party advertises its own flags in its hello and fails fast with a both-sides-named error when the peer's differ. It never adapts to the peer's mode. This boundary is intentional and load-bearing -- advertising flags is one step toward negotiation, and the design explicitly stops there. Do not let mismatch detection grow into capability negotiation without revisiting this decision.

## Error taxonomy

Errors out of `synchronize()` and `send()` fall into two classes, and the distinction is part of the contract with the CLI:

- **Usage / configuration error** -> CLI exit `64` (`EX_USAGE`). Wrong directory state (preexisting files), multiple concurrent sessions, a stale lockless ack, a message-consumption timeout, and (planned) a bilateral-mode mismatch or a malformed control payload.
- **Transport failure** -> CLI exit `69` (`EX_UNAVAILABLE`). The peer went silent past `peer_timeout_ms`, `list`/`get`/`put` rejected, the listing will not converge.

Today this distinction is carried by an internal `{ cause: "usage" }` string sentinel that the outer catch strips before rethrowing, so callers cannot actually tell the two apart and everything exits `69` (the CLI sites are [exchange.ts:388](../apps/cli/src/commands/exchange.ts#L388) and [zeroSetup.ts:371](../apps/cli/src/commands/zeroSetup.ts#L371)). The target is a typed mechanism, exportable from `packages/core`, that the CLI inspects to choose `64` vs `69`. New throw sites should be written against the typed mechanism and classified into one of these two buckets from the start.

## Payload-bearing control files (I5)

The hello and ack shipped as empty files (`194002643`): recovering the peer id is a filename slice and matching an ack is an existence check. Giving them a JSON body -- the hello's bilateral mode flags, and any field the ack needs -- requires a partial-sync read gate, because their names carry no byte-count segment and a half-synced body could be read truncated and misread as malformed (invariant I5).

`194332289` **is merged** and resolves this design point. It introduced the `ControlFileEnvelope` interface and schema (`src/connection/controlEnvelope.ts`) and the shared `readControlFileWithGate` helper (`src/connection/fileSyncConnection.ts`). The hello (both rendezvous branches) and the lockless ack are now written with a JSON envelope body and read through the gate. The initial envelope carries no application fields; `193901017` adds bilateral mode flags and `194304738` adds the ack-to-peer binding. This supersedes `194002643`'s recorded decision that the hello body stays empty with no downstream payload. (The alternative considered and rejected was encoding the flags in the hello filename; a body was chosen as the more extensible home.)

## How the planned work converges on this model

*Living section -- prune rows as items land. Item numbers are product-board ids and are intentionally confined to this section so the rest of the document stays evergreen.*

Lockless rendezvous (item `194002643`) is **merged**: it introduced the lockless path, the unconditional `<id>-hello.json` rename, and the grammar discriminant at sites 3 and 4, and is the prerequisite for most of the rest. It shipped the hello/ack as empty files; the payload-envelope precursor `194332289` adds the body + read gate on top. `193204378` (byte count, timestamp filenames, right-anchored parsing) is also merged and underpins the grammar. The board's `Implementation Order` field carries the sequence below.

| Item | Delivers (slice of this model) | Key reconciliation note |
|------|-------------------------------|-------------------------|
| 194002650 -- generalize wave filename | I7: wave-path role from filename order; tolerate non-UUID ids at site 5 | Independent of the lockless branch; precursor to custom peer id |
| 193204531 -- custom peer ID | The distinct/non-prefix-id precondition; rendezvous-time prefix-at-dash guard | Depends on 194002650; reserves the `temp` prefix; shares the unset-`peer_id` warning with retain mode |
| 194315096 -- typed error mechanism | The error taxonomy (typed, 64 vs 69) | Should land before any item that adds throw sites, so they are typed from the start |
| 194332289 -- hello/ack payload envelope + read gate | The shared control-file body plumbing and the I5 partial-sync read gate | **Merged.** Introduced `ControlFileEnvelope` + `readControlFileWithGate`; hello and lockless ack now carry `{}` envelope. 193901017 and 194304738 extend it. Supersedes 194002643's "no payload" decision |
| 192859097 -- retained mode | Message-loop retain axis, `receipt` file, I4 cleanup exception | Its `retainFiles` field must exist before mode flags can be advertised |
| 193901017 -- advertise flags, fast-fail | Bilateral mismatch detection in the hello payload | Adds the two flag fields to 194332289's envelope and compares them; needs the `retainFiles` field from 192859097 and the read gate from 194332289 |
| 194304738 -- bind ack filename to peer id | `<peerId>-hello-ack.json` filename binding | Filename rename; any ack body reuses 194332289's envelope (the writer id is likely redundant, so the ack may stay body-less); order vs 193901017 is merge-conflict avoidance, not a semantic dependency |
| 192785502 -- joiner partial-failure sentinel | The `joining` file closing the wave-path inconsistency window | Wave-path only; its `hasOutstandingMessage` exclusion is already satisfied by the grammar discriminant (I3), so that part is a no-op against the current branch |
| 193792285 -- orphaned `.tmp` sweep | Site 2 hygiene for abandoned `temp-*.tmp` | Must target only `temp-*.tmp`, never "any leftover", because retain mode fills the directory with `*.json` by design |
