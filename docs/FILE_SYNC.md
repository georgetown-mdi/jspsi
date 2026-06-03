---
title: "File-sync transport state model"
---

# File-sync transport state model

This is the single source of truth for the *intended* state mechanics of `FileSyncConnection` (the `sftp` and `filedrop` channels). It exists because the rendezvous and message-loop behavior is an implicit state machine spread across several enforcement sites in one file, and because a cluster of planned changes each add a new file type or transition to it. Without one model to point at, each change re-derives the mechanics from prose and the enforcement sites drift apart. This document is the shared target; the planned work is tracked against it in [How the planned work converges on this model](#how-the-planned-work-converges-on-this-model).

This is a developer/design document. For the user-facing configuration reference and the canonical filename grammar see [EXCHANGE_SPEC.md](EXCHANGE_SPEC.md); for the high-level channel and synchronization overview see [COMMUNICATION.md](COMMUNICATION.md); for the cryptographic protocol see [PROTOCOL.md](PROTOCOL.md). Where this document and EXCHANGE_SPEC overlap, EXCHANGE_SPEC owns the filename grammar and this document owns the state machine.

## Core principle: the directory is the state machine

Two parties share one directory (an SFTP path or a local filedrop path) and never hold a lock on it. Each party mutates the shared state only by `put`, `delete`, and `rename`, and observes the peer only by `list`. The protocol state is therefore exactly **the set of filenames present in the directory**. Everything else -- roles, modes, who has consumed what -- is inferred from that set.

Two consequences follow, and they are the reason this document exists:

1. Correctness reduces to agreement on two things: which filenames are legal at each phase, and how each file is routed (treated as a message, a control signal, or ignored). A bug is almost always a disagreement about one of those two between the two parties, or between two of this code's own enforcement sites.
2. Every new file type is a new symbol in the state machine's alphabet, and must be accounted for at *every* site that reads the directory. Adding one without updating all of them is the standard failure mode.

## The single load-bearing invariant: the filename grammar

Routing safety rests entirely on one rule, defined in full under [EXCHANGE_SPEC.md "Filename grammar"](EXCHANGE_SPEC.md#filename-grammar) and restated here as the discriminant the state machine depends on:

> A protocol file is named `<id>-...-<token>.json`. If `<token>` is all digits the file is a **message** and `<token>` is its declared byte count. Otherwise `<token>` is a type word (`hello`, `ack`, `joining`) and the file is a **control file** that is never routed as a message.

In code this discriminant is `parseMessageByteCount(name) !== undefined` (in [fileSyncConnection.ts](../packages/core/src/connection/fileSyncConnection.ts)). A `.tmp` file (the in-flight `temp-<uuid>.tmp` write) and a `.wave` file are excluded earlier, by extension. The grammar is what lets the message scan ignore a renamed hello or an ack without an explicit per-type exclusion -- so every new control file gets a non-numeric terminal token *for free*, provided the site that reads the directory uses the discriminant rather than a bare prefix glob.

### File taxonomy

Every row here must agree with every column for the state machine to be consistent. "Planned" rows are not implemented yet; they are the target the issues converge on.

| File | Pattern | Written by | Token | Has payload | Byte-count gated | In `responsibleFiles` | Swept by `cleanup()` | Routed by `poll()` | Seen by `hasOutstandingMessage` |
|------|---------|-----------|-------|-------------|------------------|----------------------|----------------------|--------------------|--------------------------------|
| hello | `<id>-hello.json` | each party | `hello` | **yes (envelope: bilateral flags `locklessRendezvous`, `retainFiles`, camelCase on disk)** | no (I5a read gate instead) | yes (delete mode only) | yes (not in retain mode) | no (non-numeric) | no (non-numeric) |
| wave | `<id1>-<id2>.wave` | starter (wave path) | n/a (`.wave`) | no | n/a | yes | yes | no (extension) | no (extension) |
| ack | `<writerId>-<originalName>-ack.json` (named after the acked file: rendezvous `<myId>-<peerId>-hello-ack.json`; message `<myId>-<peerId>-<ts>-<NNN>-<bytes>-ack.json`) | the party acking a file -- rendezvous: each lockless party (acks the peer hello); message loop: the retain receiver (acks each consumed message) | `ack` | **no (zero-length marker; matched by name existence)** | no (zero-length: name-appearance is completion) | rendezvous ack: yes (delete-mode lockless); message ack: no | rendezvous ack: yes (delete mode); message ack: no (transcript is retained) | no (non-numeric) | no (non-numeric) |
| message | `<id>-<bytes>.json` or `<id>-<ts>-<NNN>-<bytes>.json` | each party | numeric | yes | **yes** | yes (delete mode only) | yes (not in retain mode) | **yes** | **yes** |
| temp | `temp-<uuid>.tmp` | each party (in-flight) | n/a (`.tmp`) | partial write | n/a | no | inline in `send()`/`writeAck()`, not `cleanup()` | no (extension) | no (extension) |
| joining | `<id>-joining.json` | joiner (wave path) | `joining` | yes (hello envelope, pre-staged for the rename to the hello; the peer matches by name and never reads it) | no | yes (released once the peer hello is deleted) | yes (only before the peer hello is deleted) | no (non-numeric) | no (non-numeric) |

## The five enforcement sites

The state machine is enforced -- and therefore must be kept consistent -- at exactly these five places in [fileSyncConnection.ts](../packages/core/src/connection/fileSyncConnection.ts). Adding or changing a file type is a change to *all applicable rows of the taxonomy at all five sites*; this is the anti-drift checklist.

1. **Preexisting-file guard** (`synchronize()` start). One mode-agnostic rule: the directory must be empty except for at most one **peer** hello -- a `-hello.json` whose id is not this party's own. That is the only file kind that can legitimately predate entry, since every other kind is written only after a party has seen the peer's hello. Anything else is a terminal `UsageError` (the full rejection list is [I0](#invariants)). This strict-empty rule subsumes the former retain-specific guard and closes a gap where stale delete-mode messages slipped through. It is also what code-enforces retain mode's fresh-directory precondition (see [Fresh directory in retain mode](#preconditions-for-a-correct-exchange)). Finally, the `ignored` set is the extension point for the two kinds that will later legitimately pre-exist: an orphaned `temp-*.tmp` reclaimed by a planned sweep, and a directory snapshot. Until they land, every non-peer-hello file is rejected.
2. **`responsibleFiles` + `cleanup()`**. The set of files this party created and must remove on `close()`/`cleanup()`. Pre-track before writing so a crash mid-write is still swept. Retain mode is the sole exception: exchange files are intentionally not swept.
3. **`poll()` message scan**. Reads the peer's messages: `<peerId>-` prefix, `.json`, numeric terminal, and `size >= declaredSize`. Non-numeric terminals are ignored, not errors. In retain mode the scan additionally selects only the message whose `<NNN>` equals the in-memory `recvSeq` counter, so an already-consumed message still on disk (retain mode never removes it) is skipped rather than re-delivered. A fully-synced message that fails to parse or validate is terminal and stops the poller (see [I5b](#invariants)); transient transport and ack-write failures reschedule (an `emit`-handler throw would too, but the production consumer cannot throw -- see [I8](#invariants)).
4. **`hasOutstandingMessage`** (in `send()`). The delete-mode sender waits here for the peer to consume (delete) its last message. Must use the grammar discriminant (it does: `parseMessageByteCount(name) !== undefined`) so the party's own hello and ack markers are not mistaken for an outstanding message.
5. **Rendezvous role and collision logic** (`synchronize()`: wave path, lockless path, and role commit). Assigns `role`/`handshakeRole`/`peerId`, detects the two-hello collision, and recovers the peer id by fixed-suffix slicing (never by parsing).

## Two orthogonal mode axes

The transport has two independent binary modes. They are bilateral: both parties must choose the same value, and there is no negotiation (see [Bilateral configuration](#bilateral-configuration-detect-and-fail-never-negotiate)).

- **Rendezvous mode** -- how the two parties meet:
  - *Wave* (default, `lockless_rendezvous: false`): atomic exclusive-create plus a `.wave` tiebreaker; the joiner deletes the peer hello and writes its own. Requires deletion visibility and exclusive-create.
  - *Lockless* (`lockless_rendezvous: true`): an ack-handshake barrier that uses neither exclusive-create nor delete; both hellos and both acks coexist. For sync-mediated transports where both sides "win" a local create or deletions do not propagate.
- **Message-loop mode** -- how send/consume is signaled:
  - *Delete-as-signal* (default): the receiver deletes the sender's message file; the sender waits for that deletion before sending the next.
  - *Retain* (`retain_files: true`): no exchange file is deleted; the receiver writes a zero-length `ack` marker the sender waits for instead. For transports that do not propagate deletions, and for audit transcripts.

Not all combinations are valid. Retain mode requires lockless rendezvous: wave rendezvous is delete-based (the joiner deletes the peer hello as a role-assignment signal) and cannot produce the whole-directory no-delete transcript retain mode guarantees. The three valid combinations are wave + delete-as-signal (default), lockless + delete-as-signal, and lockless + retain. Wave + retain is rejected by schema validation.

## Phases and legal directory contents

Read each phase as "given this mode, the directory may legitimately contain exactly this set; anything else is an error or a not-yet-synced transient."

### Phase 0 -- clean start

Legal contents at entry: nothing this protocol owns, except at most one **peer** hello (the other party may have arrived first). The preexisting-file guard (site 1) aborts in both modes, with one `UsageError`, on anything else (full list in [I0](#invariants)). This single rule is what lets whichever party arrives second -- it always sees the first party's hello -- proceed instead of failing.

### Phase 1 -- rendezvous, wave path

```
A put A-hello.json
B list -> sees A-hello.json            (B is the joiner)
B put B-joining.json ; B delete A-hello.json ; B rename B-joining.json -> B-hello.json
A list -> sees B-hello.json ; A writes the wave
both reconstruct <first>-<second>.wave and assign roles by filename order
```

Legal transient contents: one self hello, optionally one peer hello, optionally one wave, optionally one joiner sentinel. The joiner closes the one observable inconsistency window -- peer hello gone, joiner hello not yet written -- with a `<id>-joining.json` sentinel: it publishes the sentinel (carrying its hello body), deletes the peer hello, then renames the sentinel to its own hello. The rename is atomic, so the sentinel is present across exactly that window. The peer's wait loop treats a `<peerId>-joining.json` as "joiner mid-arrival" and waits a bounded recovery window (`joinerRecoveryMs`, default 30s) for the rename to land; if the sentinel persists past the window the joiner failed between its delete and rename, and the peer aborts with a distinct transport error (CLI exit 69) instead of polling to the full `peerTimeoutMs`. The joiner releases the sentinel from `responsibleFiles` the moment it deletes the peer hello, so a failure after that point leaves the sentinel on disk as the peer's recovery signal (and, if the joiner process dies, for the next run's Phase 0 guard to reject); a failure before that point is swept by `cleanup()` with the peer hello still intact. The peer never re-creates its own deleted hello on recovery -- that would race the joiner's rename and trip the two-hello collision check ([I1](#invariants)). Role is derived from hello *filename order* (`thisFile.name < otherFile.name`), which is the source of truth the wave producer encodes -- never from a fresh id comparison, because for ids where one is a prefix of the other the two can diverge.

### Phase 1 -- rendezvous, lockless path

```
A put A-hello.json ; B put B-hello.json   (neither deletes the other)
each, on seeing the peer hello, writes a zero-length ack named after it
  (A writes A-B-hello-ack.json; B writes B-A-hello-ack.json)
each completes when the ack of its OWN hello exists in the listing
  (A waits for B-A-hello-ack.json; B waits for A-B-hello-ack.json)
```

The ack is a zero-length marker matched by name existence -- no body is read, and there is no read gate (a zero-byte file has no partial-sync window: its name appearing is completion). Legal contents: both hellos and both acks coexist and persist into the message loop (they are not deleted at rendezvous). This is why sites 3 and 4 must rely on the grammar discriminant: the party's own `<id>-hello.json` and ack share its message prefix and would be false positives under a bare `<id>-*` glob.

### Phase 2 -- message loop, delete mode

The sender writes `temp-<uuid>.tmp`, renames it to the final numeric-terminal name (so a watcher never sees a partial file under its final name), and then blocks in `hasOutstandingMessage` until the peer deletes it. The receiver's `poll()` reads one peer message once its on-disk size reaches the declared byte count, emits `data`, and deletes it. Legal contents: at most one outstanding message per direction.

### Phase 2 -- message loop, retain mode

The write path is the same as delete mode, but the receiver never deletes the message file. Instead it writes a zero-length `ack` marker named after the consumed message (`<myId>-<consumedMessageName>-ack.json`) before emitting `data`. This is the same construct as the lockless rendezvous ack, applied to a message instead of a hello: only the receiver writes one (delete mode signals the same thing by deleting the file).

This ack is a **durable-received** acknowledgment, not an application-consumption one. By the time it is written the message is a fully-synced file that retain mode never deletes, so it is already durable. That is what licenses writing the ack before the `data` hand-off, and it keeps the sender's go-ahead independent of whether the local hand-off succeeds. The order must not be flipped to emit-before-ack: an ack-write failure after a successful `emit` would re-deliver an already-consumed message. Conversely, because the ack precedes `emit` while `recvSeq` advances only after a successful `emit`, the ack write is idempotent per `<NNN>` -- a message reprocessed after a transient receive failure is not acked twice. The marker name is also deterministic per message (a pure function of the consumed message's fixed name), so even if the per-`<NNN>` write guard were bypassed the re-write would reuse the identical name and create no duplicate file; the guard only saves a redundant `put`+`rename`.

The sender gates its next send on the existence of the ack of its just-sent message, located by constructing the expected name `<peerId>-<lastSentStem>-ack.json` from the stem it already holds in `lastSentFile` -- not by parsing a marker on disk. The ack is zero-length, so the former byte-count size-gate degenerates to existence. No exchange file is deleted as a protocol step.

Because no message is ever deleted, every consumed message stays on disk on every transport -- not only those that fail to propagate deletions. The receiver therefore tracks the next unprocessed message with an in-memory per-session counter, `recvSeq`: it processes only the peer message whose `<NNN>` equals `recvSeq`, then increments it. That counter stays aligned with the peer's monotonic `<NNN>` sequence only because of the clean-directory precondition ([I0](#invariants)), on which the [I8](#invariants) counter shadow rests.

### Phase 3 -- cleanup and close

`close()` calls `cleanup()`, which removes every file in `responsibleFiles`. In retain mode `cleanup()` removes only an in-flight `temp-*.tmp`; the `*.json` transcript is left in place by design. `close()` and `cleanup()` must not diverge on this.

## Invariants

These are the testable properties the state machine must preserve. New work should be checkable against this list.

- **I0 -- clean entry (strict-empty).** At `synchronize()` start (enforcement site 1) the directory must be empty except for at most one *peer* hello (a `-hello.json` whose id is not this party's own), the only file kind that can legitimately predate entry. Anything else -- a second or self hello, a wave, an ack marker, a `joining` sentinel, a message, an in-flight `temp-*.tmp`, or a foreign file -- is a terminal `UsageError`. This is the precondition the counter arguments in I8 rest on; it also code-enforces retain mode's fresh-directory requirement (see [Fresh directory in retain mode](#preconditions-for-a-correct-exchange)). Strict by design: the `ignored` set is the only sanctioned relaxation (planned: an orphaned `temp-*.tmp` sweep and a directory snapshot).
- **I1 -- one peer at rendezvous.** More than one peer hello is a terminal usage error ("other sessions using this path?"), in both rendezvous paths.
- **I2 -- grammar routing.** A file is routed as a message iff its terminal `.json` segment is all digits. Control files (`hello`, `ack`, `joining`) are never routed. An ack marker is the case that makes this load-bearing: a message ack carries the acked message's `<NNN>` and `<byteCount>` mid-name (both all-digit), but its terminal segment is `ack`, so right-anchored parsing routes it as a control file.
- **I3 -- own files are not self-messages (a corollary of I2, kept as its own entry).** Not an independent property: I2 already entails it, since a party's own control files have non-numeric terminals. It is called out because it is the specific drift lockless makes load-bearing -- own hello and ack persist into Phase 2, so sites 3 and 4 must exclude them via the grammar discriminant (`parseMessageByteCount(...) !== undefined`), never a bare `<id>-*` glob or a per-type suffix list.
- **I4a -- delete-mode crash safety.** In delete mode, every committed file a party creates is tracked in `responsibleFiles` so a mid-write fault still leaves it swept by `cleanup()` at the next `close()`. *When* the `add` happens depends on the write discipline, and the two are not interchangeable: a **direct-write** to the final name (`hello`, `wave` via `createExclusive`) is pre-tracked *before* the call, because the final name can be left on disk by a call that then throws (e.g. `createExclusive` creates the file on the server but the handle-close fails); a **temp-then-rename** write (`message` in `send()`, `ack` in `writeAck()`) is tracked *immediately after* the rename, because the final name only appears at that atomic step and the `add` follows it with no throwable statement between, so there is no reachable orphan window short of a rename that throws-but-succeeded -- a pathological mode the message write has always accepted identically. (`responsibleFiles` is in-memory and `cleanup()` only runs in-process at `close()`, so a hard process kill loses the set and sweeps nothing regardless of add timing; pre-tracking guards the *caught-exception* path, not a kill.) All four `add`s are guarded by `!retainFiles`, because retain mode never sweeps (I4b) so tracking would serve no purpose.
- **I4b -- retain mode never sweeps.** In retain mode `cleanup()` is a global no-op: the directory is the durable transcript, so no `*.json` is ever removed and `responsibleFiles` membership is irrelevant. `close()` and `cleanup()` must not diverge on this. In both modes the in-flight `temp-*.tmp` is never tracked in `responsibleFiles`; it is cleaned inline (best-effort) in `send()`/`writeAck()`, independent of `cleanup()`.
- **I5a -- partial-sync read safety.** A file whose body is read for content must not be read before the sync tool has finished writing it. The message is the only payload-bearing file that is byte-count gated: it self-describes its full size in the filename and the receiver waits until the on-disk size reaches it. The hello has no byte-count segment, so it uses a read gate (`readControlFileWithGate` in `fileSyncConnection.ts`) that retries on a short or unparseable read until the peer timeout, then validates `HelloEnvelope`. The ack marker needs neither: it is zero-length, so its name appearing *is* completion -- there is no body to gate or read. (This is what licensed dropping the former empty `{}` ack body and its read gate.) The hello is therefore the sole payload-bearing control file. **Control-file payload fields are camelCase on disk** (`locklessRendezvous`, `retainFiles`) -- a control file is a protocol message, not user-facing schema, so the snake_case-in-YAML config convention does not apply and there is no `camelizeKeys` conversion on the serialize or parse path. A later envelope-field addition must stay camelCase to match.
- **I5b -- a completed body that fails validation is terminal (an instance of I6).** Once a body has reached its declared size the partial-sync excuse is exhausted: a parse or schema failure is genuine corruption, not a retryable short read, and is a terminal `UsageError`. For the hello this is the `HelloEnvelope` schema check after the gate. For messages in `poll()` it is a `JSON.parse` or `Message` validation failure, a body-`seq`/filename-`NNN` mismatch, or a duplicate `NNN`; each stops the poller. Transient transport failures (and the unreachable emit-handler throw, see I8) are *not* `UsageError`s and reschedule instead.
- **I6 -- terminal failure, no caller retry.** `synchronize()` and `send()` always present a terminal failure to the caller; the caller does not retry. Any bounded retry is internal. The I5b classification and the I8 counter discipline are instances of this contract at specific read/write sites.
- **I7 -- role from filename order.** Wave-path role assignment derives from hello filename order, never from a fresh id comparison.
- **I8 -- in-memory counters are a shadow of on-disk NNN state, not an independent source of truth.** `seq` (next NNN to write), `recvSeq` (retain: next NNN to read), `lastAckedNNN` (retain: ack idempotency guard), and `lastSentFile` (the name of the last message this party sent -- read by the delete-mode drain and the retain-mode ack construction) are all in-memory projections of the shared directory's NNN sequence. Three rules keep the shadow aligned; breaking any one silently desynchronizes the two parties:
  - `seq` advances only AFTER a message's durable `rename` in `send()`. A failed write must not leave the counter past an unwritten NNN. If it did, the retain-mode ack gate on the next send would wait for the ack of a message that was never written to disk.
  - In retain mode, `recvSeq` advances only after a successful `emit` in `poll()`. The ack marker (and `lastAckedNNN`) is written before `emit`. So a transient (non-`UsageError`) failure during receive -- e.g. an ack-write transport hiccup -- reprocesses the never-deleted message on the next poll and acks it exactly once: never skipped, never double-acked. (The ack name is a pure function of the message's fixed name, so even a bypassed `lastAckedNNN` guard re-derives the identical name and writes no duplicate file; the guard only saves a redundant `put`+`rename`.) A `UsageError` reaching `poll()`'s catch is terminal and stops the poller instead (I5b). This reprocess path covers a failure *during* receive, not a throw from the `data` consumer. The sole production consumer (`deliver()` in `messageConnection.ts`) latches an overflow as a non-throwing failure and never throws synchronously, so an emit-handler throw is unreachable defense-in-depth.
  - All four counters reset together via `resetSessionState()` at every session-boundary path: the rendezvous outer catch, the joiner prefix-at-dash error, and `close()`. A partial reset that left any counter non-zero would corrupt the next session on the same instance.

  The shadow is only safe because of I0 (clean entry): both counters begin at 0 against an empty directory and therefore stay aligned with the peer's monotonic NNN sequence, which also starts at 0.

  Enforcement sites: `resetSessionState()` (session-boundary resets), the post-rename `this.seq = seq + 1` in `send()` (I8 write rule), and the post-emit `this.recvSeq++` guarded by the pre-emit ack write in `poll()` (I8 receive rule).
- **I9 -- one outstanding message per direction (delete mode).** The delete-mode sender blocks in `hasOutstandingMessage` until the peer deletes its last message, so at most one message per direction is ever in flight; this is the channel's flow control and the property that bounds legal directory contents in Phase 2 delete mode. Retain mode imposes no such bound -- messages accumulate as the transcript and the receiver selects the next by `recvSeq` (I8).

## Preconditions for a correct exchange

These operator-level requirements are part of the model: violating any of them silently corrupts or stalls the exchange, and several are not otherwise enforced in code. They are collected here so they live in one place rather than scattered across feature docs.

- **Dedicated directory.** One active exchange, exactly two parties, per directory. See [EXCHANGE_SPEC.md "Directory exclusivity"](EXCHANGE_SPEC.md#directory-exclusivity).
- **Matching builds.** There is no `protocol_version` field; both parties run compatible builds and the payload schema is a hard contract. A payload-schema change (e.g. adding hello flags) is a flag-day that both sides must deploy together.
- **Identical bilateral flags.** `lockless_rendezvous` and `retain_files` must match on both sides.
- **Fresh directory in retain mode.** Retain mode never deletes, so a reused directory leaves a prior exchange's files: a stale message would be mis-consumed against the `recvSeq` counter and a stale ack marker could prematurely release the sender's gate, corrupting or stalling the exchange with no error. The entry guard (site 1) rejects a non-clean start in both modes, which is what protects retain specifically -- so this is not advisory.
- **Distinct, non-prefix peer ids.** When `peer_id` is configured, the two ids must be distinct, and neither may be the other extended by `-` (e.g. `site` / `site-2`), which would break message prefix-routing. UUIDs (the default) satisfy this automatically.

## Bilateral configuration: detect and fail, never negotiate

`lockless_rendezvous` and `retain_files` are bilateral agreements with no negotiation step. The deliberate stance is **mismatch detection and clear failure, not capability negotiation**: a party advertises its own flags in its hello (`HelloEnvelope`, the two required fields) and fails fast with a both-sides-named error when the peer's differ. It never adapts to the peer's mode. This boundary is intentional and load-bearing -- advertising flags is one step toward negotiation, and the design explicitly stops there. Do not let mismatch detection grow into capability negotiation without revisiting this decision.

**Detection is symmetric (two-sided), via durable hellos.** The flag check sits at *every* peer-hello read site, not just one, and a detecting party leaves its own advertised hello in the directory (writing it first if it had not yet done so) and does not delete the peer's hello. The two rendezvous protocols are not symmetric in *who reads whom* -- a `lockless_rendezvous` mismatch pairs a lockless ack-barrier against a delete-based wave -- so a check at one site alone would fast-fail only the party that happens to read the peer hello, leaving the other to hit the peer timeout. Because the advertisement is durable on both sides, the peer (whatever protocol it runs) reaches a peer-hello read site, reads the flags, and fails the same way. This holds in both arrival orders and for both flags, including a `retain_files` mismatch where both parties run the lockless ack-barrier. Leaving an already-written hello so the peer can read it is **not** adaptation: the boundary the bilateral stance forbids is adaptation, not durability, so symmetric detection stays inside it.

**A mismatch leaves both hellos as the directory's terminal state.** The mismatch path does not sweep the hellos: a party that advertised a mode has its advertisement respected as the terminal state rather than silently swept, and the peer needs the file on disk to reach the same conclusion. In-memory session state is still reset (`resetSessionState()`) so the instance is not wedged; only the on-disk sweep is skipped. The cost is that a rerun against the same directory is rejected by the entry guard ([I0](#invariants), "directory not clean", a terminal usage error, not a silent stall); the operator clears the directory and reruns with corrected flags. This is consistent with retain mode's fresh-directory precondition. The mismatch is carried as a distinct typed error (`BilateralModeMismatchError`, a `UsageError` subclass) so the two cleanup sites -- the rendezvous outer catch and the joiner fast-path, which has no enclosing catch -- branch on it deterministically rather than by string-matching the message.

**The symmetric guarantee is best-effort, contingent on the advertising write landing.** Leaving a durable hello presumes the `put` that writes it succeeds. If a party detects the mismatch by reading the peer's hello but its *own* advertisement write fails (a transport error at exactly that moment), no write ordering can recover -- there is no durable file for the peer to read, so the peer degrades to the legacy peer-timeout on that one side. The detecting party still fails locally and correctly: it swallows the write failure and throws the typed `BilateralModeMismatchError` (CLI exit 64) rather than letting a transport rejection mask the actionable cause as a generic error (exit 69). This degradation is the floor, never the target -- it is no worse than the pre-advertisement behavior (a silent stall until the peer timeout), and it only occurs when shared storage is failing writes, in which case the exchange could not have proceeded regardless.

## Error taxonomy

Errors out of `synchronize()` and `send()` fall into two classes, and the distinction is part of the contract with the CLI:

- **Usage / configuration error** -> CLI exit `64` (`EX_USAGE`). Wrong directory state (preexisting files), multiple concurrent sessions, a stale lockless ack, a message-consumption timeout, a bilateral-mode mismatch (`BilateralModeMismatchError`), and a malformed control payload (a fully-synced hello missing a required flag or carrying an out-of-type value).
- **Transport failure** -> CLI exit `69` (`EX_UNAVAILABLE`). The peer went silent past `peer_timeout_ms`, `list`/`get`/`put` rejected, the listing will not converge.

This distinction is carried by a typed `UsageError` (exported from `@psilink/core`, defined in [errors.ts](../packages/core/src/errors.ts)): the usage class is anything `instanceof UsageError`, and everything else is a transport failure. The CLI inspects it at its catch sites -- the blocks in [exchange.ts](../apps/cli/src/commands/exchange.ts) and [zeroSetup.ts](../apps/cli/src/commands/zeroSetup.ts) map `err instanceof UsageError ? 64 : 69`. New throw sites in `synchronize()` or `send()` should throw `UsageError` for the usage bucket rather than a plain `Error`, classifying into one of these two buckets from the start.

## How the planned work converges on this model

*Living section -- prune rows as items land. Item numbers are product-board ids and are intentionally confined to this section so the rest of the document stays evergreen.*

Lockless rendezvous (item `194002643`) is **merged**: it introduced the lockless path, the unconditional `<id>-hello.json` rename, and the grammar discriminant at sites 3 and 4, and is the prerequisite for most of the rest. It shipped the hello/ack as empty files; the payload-envelope precursor `194332289` added the hello body + read gate, and `194304738` later returned the ack to a zero-length, existence-matched marker (the hello keeps the body). `193204378` (byte count, timestamp filenames, right-anchored parsing) is also merged and underpins the grammar. The board's `Implementation Order` field carries the sequence below.

| Item | Delivers (slice of this model) | Key reconciliation note |
|------|-------------------------------|-------------------------|
| 194002650 -- generalize wave filename | I7: wave-path role from filename order; tolerate non-UUID ids at site 5 | Independent of the lockless branch; precursor to custom peer id |
| 193204531 -- custom peer ID | The distinct/non-prefix-id precondition; rendezvous-time prefix-at-dash guard | Depends on 194002650; reserves the `temp` prefix; shares the unset-`peer_id` warning with retain mode |
| 194315096 -- typed error mechanism | The error taxonomy (typed, 64 vs 69) | Should land before any item that adds throw sites, so they are typed from the start |
| 194332289 -- hello/ack payload envelope + read gate | The shared control-file body plumbing and the I5a partial-sync read gate | **Merged.** Introduced `readControlFileWithGate` and a base `ControlFileEnvelope` whose `{}` body the hello and lockless ack both carried; 193901017 tightened the hello into `HelloEnvelope`. 194304738 later removed the base schema and the empty ack body, narrowing the gate to the hello. Supersedes 194002643's "no payload" decision for the hello |
| 192859097 -- retain mode | Message-loop retain axis, the receiver's per-message ack, I4b cleanup exception | **Merged.** Shipped `--retain-files` ahead of the bilateral fast-fail gap, now closed by 193901017. Its original `receipt` file was unified into the single `ack` marker by 194304738. |
| 193901017 -- advertise flags, fast-fail | Bilateral mismatch detection in the hello payload | **Merged.** Added `HelloEnvelope` (the two required flags) on 194332289's gate via a schema parameter, the symmetric flag check at every peer-hello read site, and `BilateralModeMismatchError`. |
| 194304738 -- unify hello-ack and receipt as one ack marker | The single zero-length, writer-prefixed, existence-matched `ack` construct for both rendezvous and the retain message loop | **Merged.** Replaced the lockless `<id>-hello-ack.json` and the retain `receipt` with `<writerId>-<originalName>-ack.json` (named after the acked file); dropped the empty `{}` body, the base `ControlFileEnvelope`, the receipt NNN+size gate, and the ack read gate. Keeping the writer's own id as the prefix fixes the selective-glob deadlock the superseded target-prefixed scope would have caused |
| 192785502 -- joiner partial-failure sentinel | The `joining` file closing the wave-path inconsistency window | **Merged.** Wave-path only. The joiner publishes `<id>-joining.json` (carrying its hello body), deletes the peer hello, then renames the sentinel to its hello; the peer recognizes the sentinel and recovers within a bounded window (`joinerRecoveryMs`) or aborts with a distinct transport error. `responsibleFiles`/`cleanup()` track it until the peer hello is deleted, then release it so it persists as the recovery signal. Its `hasOutstandingMessage`/`poll()` exclusion was already satisfied by the grammar discriminant (I3), so that part was a no-op |
| 193792285 -- orphaned `.tmp` sweep | Site 2 hygiene for abandoned `temp-*.tmp` | Must target only `temp-*.tmp`, never "any leftover", because retain mode fills the directory with `*.json` by design |
