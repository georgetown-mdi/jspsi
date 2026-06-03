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

> A protocol file is named `<id>-...-<token>.json`. If `<token>` is all digits the file is a **message** and `<token>` is its declared byte count. Otherwise `<token>` is a **type word** (`hello`, `ack`, `receipt`, and the planned `joining`) and the file is a **control file** that is never routed as a message.

In code this discriminant is `parseMessageByteCount(name) !== undefined` (in [fileSyncConnection.ts](../packages/core/src/connection/fileSyncConnection.ts)). A `.tmp` file (the in-flight `temp-<uuid>.tmp` write) and a `.wave` file are excluded earlier, by extension. The grammar is what lets the message scan ignore a renamed hello, an ack, or a receipt without an explicit per-type exclusion -- so every new control file gets a non-numeric terminal token *for free*, provided the site that reads the directory uses the discriminant rather than a bare prefix glob.

### File taxonomy

Every row here must agree with every column for the state machine to be consistent. "Planned" rows are not implemented yet; they are the target the issues converge on.

| File | Pattern | Written by | Token | Has payload | Byte-count gated | In `responsibleFiles` | Swept by `cleanup()` | Routed by `poll()` | Seen by `hasOutstandingMessage` |
|------|---------|-----------|-------|-------------|------------------|----------------------|----------------------|--------------------|--------------------------------|
| hello | `<id>-hello.json` | each party | `hello` | **yes (envelope; fields planned: bilateral flags via 193901017)** | no (I5a read gate instead) | yes (delete mode only) | yes (not in retain mode) | no (non-numeric) | no (non-numeric) |
| wave | `<id1>-<id2>.wave` | starter (wave path) | n/a (`.wave`) | no | n/a | yes | yes | no (extension) | no (extension) |
| hello-ack | `<id>-hello-ack.json` (**planned: `<peerId>-hello-ack.json`**) | each party (lockless) | `ack` | **yes (envelope; fields planned: writer id via 194304738)** | no (I5a read gate instead) | yes (delete mode only) | yes (not in retain mode) | no (non-numeric) | no (non-numeric) |
| message | `<id>-<bytes>.json` or `<id>-<ts>-<NNN>-<bytes>.json` | each party | numeric | yes | **yes** | yes (delete mode only) | yes (not in retain mode) | **yes** | **yes** |
| temp | `temp-<uuid>.tmp` | each party (in-flight) | n/a (`.tmp`) | partial write | n/a | no | inline in `send()`/`writeReceipt()`, not `cleanup()` | no (extension) | no (extension) |
| joining (planned) | `<id>-joining.json` | joiner (wave path) | `joining` | marker | no | yes | yes | no (non-numeric) | no (non-numeric) |
| receipt | `<receiverId>-<ts>-<NNN>-<bytes>-receipt.json` | receiver (retain mode) | `receipt` | yes | **yes (size before token)** | no | **no (transcript is retained)** | no (non-numeric) | no (non-numeric) |

## The five enforcement sites

The state machine is enforced -- and therefore must be kept consistent -- at exactly these five places in [fileSyncConnection.ts](../packages/core/src/connection/fileSyncConnection.ts). Adding or changing a file type is a change to *all applicable rows of the taxonomy at all five sites*; this is the anti-drift checklist.

1. **Preexisting-file guard** (`synchronize()` start). One mode-agnostic rule: the directory must be empty except for at most one **peer** hello (a `-hello.json` whose id is not this party's own) -- the only file kind that can legitimately predate entry, since every other kind is written only after a party has seen the peer's hello. Anything else is a `UsageError`: a second or self hello, a wave, a `-hello-ack.json`, a message, a receipt, an in-flight `temp-*.tmp`, or a foreign file. Strict-empty by design, this subsumes the former retain-specific guard and closes a gap where stale delete-mode messages slipped through; it also code-enforces retain mode's fresh-directory precondition (see [Phase 0](#phase-0----clean-start) and [Fresh directory in retain mode](#preconditions-for-a-correct-exchange)). The `ignored` set is the extension point for the two kinds that will later legitimately pre-exist -- an orphaned `temp-*.tmp` swept by `193792285`, and a directory snapshot; until they land, every non-peer-hello file is rejected.
2. **`responsibleFiles` + `cleanup()`**. The set of files this party created and must remove on `close()`/`cleanup()`. Pre-track before writing so a crash mid-write is still swept. Retain mode is the sole exception: exchange files are intentionally not swept.
3. **`poll()` message scan**. Reads the peer's messages: `<peerId>-` prefix, `.json`, numeric terminal, and `size >= declaredSize`. Non-numeric terminals are ignored, not errors. In retain mode the scan additionally selects only the message whose `<NNN>` equals the in-memory `recvSeq` counter, so an already-consumed message still on disk (retain mode never removes it) is skipped rather than re-delivered. A fully-synced message that fails to parse or validate is terminal and stops the poller (see [I5b](#invariants)); transient transport and receipt-write failures reschedule (an `emit`-handler throw would too, but the production consumer cannot throw -- see [I8](#invariants)).
4. **`hasOutstandingMessage`** (in `send()`). The delete-mode sender waits here for the peer to consume (delete) its last message. Must use the grammar discriminant (it does: `parseMessageByteCount(name) !== undefined`) so the party's own hello/ack/receipt are not mistaken for an outstanding message.
5. **Rendezvous role and collision logic** (`synchronize()`: wave path, lockless path, and role commit). Assigns `role`/`handshakeRole`/`peerId`, detects the two-hello collision, and recovers the peer id by fixed-suffix slicing (never by parsing).

## Two orthogonal mode axes

The transport has two independent binary modes. They are bilateral: both parties must choose the same value, and there is no negotiation (see [Bilateral configuration](#bilateral-configuration-detect-and-fail-never-negotiate)).

- **Rendezvous mode** -- how the two parties meet:
  - *Wave* (default, `lockless_rendezvous: false`): atomic exclusive-create plus a `.wave` tiebreaker; the joiner deletes the peer hello and writes its own. Requires deletion visibility and exclusive-create.
  - *Lockless* (`lockless_rendezvous: true`): an ack-handshake barrier that uses neither exclusive-create nor delete; both hellos and both acks coexist. For sync-mediated transports where both sides "win" a local create or deletions do not propagate.
- **Message-loop mode** -- how send/consume is signalled:
  - *Delete-as-signal* (default): the receiver deletes the sender's message file; the sender waits for that deletion before sending the next.
  - *Retain* (`retain_files: true`): no exchange file is deleted; the receiver writes a `receipt` the sender waits for instead. For transports that do not propagate deletions, and for audit transcripts.

Not all combinations are valid. Retain mode requires lockless rendezvous: wave rendezvous
is delete-based (the joiner deletes the peer hello as a role-assignment signal) and cannot
produce the whole-directory no-delete transcript retain mode guarantees.
The three valid combinations are: wave + delete-as-signal (default), lockless +
delete-as-signal, and lockless + retain. Wave + retain is rejected by schema validation.

## Phases and legal directory contents

Read each phase as "given this mode, the directory may legitimately contain exactly this set; anything else is an error or a not-yet-synced transient."

### Phase 0 -- clean start

Legal contents at entry: nothing this protocol owns, except at most one **peer** hello (the other party may have arrived first). The preexisting-file guard (site 1) aborts -- in both modes, with one `UsageError` -- on anything else: a second or self hello, a wave, an ack (and, planned, `joining`), a message, a receipt, an in-flight `temp-*.tmp`, or a foreign file. This single rule is what lets the second party to start -- which always sees the first party's hello -- proceed instead of failing, and code-enforces retain mode's fresh-directory precondition (rationale under [Preconditions](#preconditions-for-a-correct-exchange)).

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

### Phase 2 -- message loop, retain mode

Same write path, but the receiver writes a `receipt` (carrying the consumed message's `<NNN>`) before emitting `data`; it never deletes the message file. The receipt is a **durable-receipt** acknowledgment, not an application-consumption one: at the moment it is written the message is a fully-synced file that retain mode never deletes, so it is already durable, which is what licenses writing the receipt before the `data` hand-off (and keeps the sender's go-ahead independent of whether the local hand-off succeeds). The order must not be flipped to emit-before-receipt -- a receipt-write failure after a successful `emit` would re-deliver an already-consumed message. Because the receipt precedes `emit` while `recvSeq` advances only after a successful `emit`, the receipt write is idempotent per `<NNN>` so a message reprocessed after a transient receive failure is not receipted twice. The sender gates its next send on a receipt whose parsed `<NNN>` equals the just-sent `seq` *and* whose on-disk size has reached its own declared byte count. No exchange file is deleted as a protocol step. Because no message is ever deleted, every consumed message stays on disk on every transport (not only those that fail to propagate deletions), and the receiver tracks the next unprocessed message with an in-memory per-session counter `recvSeq`: it processes only the one peer message whose `<NNN>` equals `recvSeq`, then increments it (the counter stays aligned with the peer's monotonic `<NNN>` sequence only because of the clean-directory precondition -- [I0](#invariants), on which the [I8](#invariants) counter shadow rests).

### Phase 3 -- cleanup and close

`close()` calls `cleanup()`, which removes every file in `responsibleFiles`. In retain mode `cleanup()` removes only an in-flight `temp-*.tmp`; the `*.json` transcript is left in place by design. `close()` and `cleanup()` must not diverge on this.

## Invariants

These are the testable properties the state machine must preserve. New work should be checkable against this list.

- **I0 -- clean entry (strict-empty).** At `synchronize()` start (enforcement site 1) the directory must be empty except for at most one *peer* hello (a `-hello.json` whose id is not this party's own), the only file kind that can legitimately predate entry. Anything else -- a second or self hello, a wave, an ack, a message, a receipt, an in-flight `temp-*.tmp`, or a foreign file -- is a terminal `UsageError`. This is the precondition the counter arguments in I8 rest on, and it is what code-enforces retain mode's fresh-directory requirement. Strict by design: the `ignored` set is the only sanctioned relaxation (planned: an orphaned `temp-*.tmp` sweep and a directory snapshot).
- **I1 -- one peer at rendezvous.** More than one peer hello is a terminal usage error ("other sessions using this path?"), in both rendezvous paths.
- **I2 -- grammar routing.** A file is routed as a message iff its terminal `.json` segment is all digits. Control files (`hello`, `ack`, `joining`, `receipt`) are never routed.
- **I3 -- own files are not self-messages (a corollary of I2, kept as its own entry).** Not an independent property: I2 already entails it, since a party's own control files have non-numeric terminals. It is called out because it is the specific drift lockless makes load-bearing -- own hello and ack persist into Phase 2, so sites 3 and 4 must exclude them via the grammar discriminant (`parseMessageByteCount(...) !== undefined`), never a bare `<id>-*` glob or a per-type suffix list.
- **I4a -- delete-mode crash safety.** In delete mode, every committed file a party creates is added to `responsibleFiles` *before* it is written, so a crash mid-write still leaves it swept by `cleanup()` at the next `close()`. The hello, ack, wave, and message are all tracked here only: each `add` is guarded by `!retainFiles`, because retain mode never sweeps (I4b) so tracking would serve no purpose.
- **I4b -- retain mode never sweeps.** In retain mode `cleanup()` is a global no-op: the directory is the durable transcript, so no `*.json` is ever removed and `responsibleFiles` membership is irrelevant. `close()` and `cleanup()` must not diverge on this. In both modes the in-flight `temp-*.tmp` is never tracked in `responsibleFiles`; it is cleaned inline (best-effort) in `send()`/`writeReceipt()`, independent of `cleanup()`.
- **I5a -- partial-sync read safety.** A file whose body is read for content must not be read before the sync tool has finished writing it. Payload-bearing files self-describe their full size in the filename: messages and receipts carry a byte count (for a receipt the count sits *before* the `receipt` token, so -- unlike a message -- it is not the routing terminal of I2). Control files have no byte-count segment; they use a read gate (`readControlFileWithGate` in `fileSyncConnection.ts`) that retries on a short or unparseable read until the peer timeout. The control-file body, not its filename, is the extensible home for the `ControlFileEnvelope`, which initially carries no application fields.
- **I5b -- a completed body that fails validation is terminal (an instance of I6).** Once a body has reached its declared size the partial-sync excuse is exhausted: a parse or schema failure is genuine corruption, not a retryable short read, and is a terminal `UsageError`. For control files this is the envelope-schema check after the gate. For messages in `poll()` it is a `JSON.parse` or `Message` validation failure, a body-`seq`/filename-`NNN` mismatch, or a duplicate `NNN`; each stops the poller. Transient transport failures (and the unreachable emit-handler throw, see I8) are *not* `UsageError`s and reschedule instead.
- **I6 -- terminal failure, no caller retry.** `synchronize()` and `send()` always present a terminal failure to the caller; the caller does not retry. Any bounded retry is internal. The I5b classification and the I8 counter discipline are instances of this contract at specific read/write sites.
- **I7 -- role from filename order.** Wave-path role assignment derives from hello filename order, never from a fresh id comparison.
- **I8 -- in-memory counters are a shadow of on-disk NNN state, not an
  independent source of truth.** `seq` (next NNN to write), `recvSeq` (retain:
  next NNN to read), `lastReceiptedNNN` (retain: receipt idempotency guard), and
  `lastSentFile` (delete-mode drain target) are all in-memory projections of the
  shared directory's NNN sequence. Three rules keep the shadow aligned; breaking
  any one silently desynchronizes the two parties:
  - `seq` advances only AFTER a message's durable `rename` in `send()`. A failed
    write must not leave the counter past an unwritten NNN; if it did, the
    receipt gate on the next send would wait for a receipt whose NNN was never
    written to disk.
  - In retain mode, `recvSeq` advances only after a successful `emit` in
    `poll()`. The receipt (and `lastReceiptedNNN`) is written before `emit`, so
    a transient (non-`UsageError`) failure during receive -- e.g. a
    receipt-write transport hiccup -- reprocesses the never-deleted message on
    the next poll and receipts it exactly once, never skipped or double-
    receipted. A `UsageError` reaching `poll()`'s catch is terminal and stops
    the poller instead (I5b). This reprocess path covers a failure *during*
    receive, not a throw from the `data` consumer: the sole production consumer
    (`deliver()` in `messageConnection.ts`) latches an overflow as a
    non-throwing failure and never throws synchronously, so an emit-handler
    throw is unreachable defense-in-depth.
  - All four counters reset together via `resetSessionState()` at every session-
    boundary path: the rendezvous outer catch, the joiner prefix-at-dash error,
    and `close()`. A partial reset that left any counter non-zero would corrupt
    the next session on the same instance.
  The shadow is only safe because of I0 (clean entry): both counters begin at 0
  against an empty directory and therefore stay aligned with the peer's
  monotonic NNN sequence, which also starts at 0.
  Enforcement sites: `resetSessionState()` (session-boundary resets), the post-
  rename `this.seq = seq + 1` in `send()` (I8 write rule), and the post-emit
  `this.recvSeq++` guarded by the pre-emit receipt write in `poll()` (I8 receive
  rule).
- **I9 -- one outstanding message per direction (delete mode).** The delete-mode sender blocks in `hasOutstandingMessage` until the peer deletes its last message, so at most one message per direction is ever in flight; this is the channel's flow control and the property that bounds legal directory contents in Phase 2 delete mode. Retain mode imposes no such bound -- messages accumulate as the transcript and the receiver selects the next by `recvSeq` (I8).

## Preconditions for a correct exchange

These operator-level requirements are part of the model: violating any of them silently corrupts or stalls the exchange, and several are not otherwise enforced in code. They are collected here so they live in one place rather than scattered across feature docs.

- **Dedicated directory.** One active exchange, exactly two parties, per directory. See [EXCHANGE_SPEC.md "Directory exclusivity"](EXCHANGE_SPEC.md#directory-exclusivity).
- **Matching builds.** There is no `protocol_version` field; both parties run compatible builds and the payload schema is a hard contract. A payload-schema change (e.g. adding hello flags) is a flag-day that both sides must deploy together.
- **Identical bilateral flags.** `lockless_rendezvous` and `retain_files` must match on both sides.
- **Fresh directory in retain mode.** Retain mode never deletes, so a reused directory leaves a prior exchange's files: a stale message would be mis-consumed against the `recvSeq` counter and a stale receipt could prematurely release the sender's gate, corrupting or stalling the exchange with no error. The entry guard (site 1) rejects a non-clean start in both modes, which is what protects retain specifically -- so this is not advisory.
- **Distinct, non-prefix peer ids.** When `peer_id` is configured, the two ids must be distinct, and neither may be the other extended by `-` (e.g. `site` / `site-2`), which would break message prefix-routing. UUIDs (the default) satisfy this automatically.

## Bilateral configuration: detect and fail, never negotiate

`lockless_rendezvous` and `retain_files` are bilateral agreements with no negotiation step. The deliberate stance is **mismatch detection and clear failure, not capability negotiation**: a party advertises its own flags in its hello and fails fast with a both-sides-named error when the peer's differ. It never adapts to the peer's mode. This boundary is intentional and load-bearing -- advertising flags is one step toward negotiation, and the design explicitly stops there. Do not let mismatch detection grow into capability negotiation without revisiting this decision.

## Error taxonomy

Errors out of `synchronize()` and `send()` fall into two classes, and the distinction is part of the contract with the CLI:

- **Usage / configuration error** -> CLI exit `64` (`EX_USAGE`). Wrong directory state (preexisting files), multiple concurrent sessions, a stale lockless ack, a message-consumption timeout, and (planned) a bilateral-mode mismatch or a malformed control payload.
- **Transport failure** -> CLI exit `69` (`EX_UNAVAILABLE`). The peer went silent past `peer_timeout_ms`, `list`/`get`/`put` rejected, the listing will not converge.

This distinction is carried by a typed `UsageError` (exported from `@psilink/core`, defined in [errors.ts](../packages/core/src/errors.ts)): the usage class is anything `instanceof UsageError`, and everything else is a transport failure. The CLI inspects it at its catch sites -- the blocks in [exchange.ts](../apps/cli/src/commands/exchange.ts) and [zeroSetup.ts](../apps/cli/src/commands/zeroSetup.ts) map `err instanceof UsageError ? 64 : 69`. New throw sites in `synchronize()` or `send()` should throw `UsageError` for the usage bucket rather than a plain `Error`, classifying into one of these two buckets from the start.

## How the planned work converges on this model

*Living section -- prune rows as items land. Item numbers are product-board ids and are intentionally confined to this section so the rest of the document stays evergreen.*

Lockless rendezvous (item `194002643`) is **merged**: it introduced the lockless path, the unconditional `<id>-hello.json` rename, and the grammar discriminant at sites 3 and 4, and is the prerequisite for most of the rest. It shipped the hello/ack as empty files; the payload-envelope precursor `194332289` adds the body + read gate on top. `193204378` (byte count, timestamp filenames, right-anchored parsing) is also merged and underpins the grammar. The board's `Implementation Order` field carries the sequence below.

| Item | Delivers (slice of this model) | Key reconciliation note |
|------|-------------------------------|-------------------------|
| 194002650 -- generalize wave filename | I7: wave-path role from filename order; tolerate non-UUID ids at site 5 | Independent of the lockless branch; precursor to custom peer id |
| 193204531 -- custom peer ID | The distinct/non-prefix-id precondition; rendezvous-time prefix-at-dash guard | Depends on 194002650; reserves the `temp` prefix; shares the unset-`peer_id` warning with retain mode |
| 194315096 -- typed error mechanism | The error taxonomy (typed, 64 vs 69) | Should land before any item that adds throw sites, so they are typed from the start |
| 194332289 -- hello/ack payload envelope + read gate | The shared control-file body plumbing and the I5a partial-sync read gate | **Merged.** Introduced `ControlFileEnvelope` + `readControlFileWithGate`; hello and lockless ack now carry `{}` envelope. 193901017 and 194304738 extend it. Supersedes 194002643's "no payload" decision |
| 192859097 -- retained mode | Message-loop retain axis, `receipt` file, I4b cleanup exception | **Merged.** `--retain-files` ships without bilateral fast-fail (193901017); a mismatch stalls until the peer timeout fires. |
| 193901017 -- advertise flags, fast-fail | Bilateral mismatch detection in the hello payload | Adds the two flag fields to 194332289's envelope and compares them; needs the `retainFiles` field from 192859097 and the read gate from 194332289 |
| 194304738 -- bind ack filename to peer id | `<peerId>-hello-ack.json` filename binding | Filename rename; any ack body reuses 194332289's envelope (the writer id is likely redundant, so the ack may stay body-less); order vs 193901017 is merge-conflict avoidance, not a semantic dependency |
| 192785502 -- joiner partial-failure sentinel | The `joining` file closing the wave-path inconsistency window | Wave-path only; its `hasOutstandingMessage` exclusion is already satisfied by the grammar discriminant (I3), so that part is a no-op against the current branch |
| 193792285 -- orphaned `.tmp` sweep | Site 2 hygiene for abandoned `temp-*.tmp` | Must target only `temp-*.tmp`, never "any leftover", because retain mode fills the directory with `*.json` by design |
