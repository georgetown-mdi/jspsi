---
title: "CLI Machine-Interface Event Stream"
---

# CLI machine-interface event stream

This document specifies the opt-in machine-readable event stream the `psilink` CLI emits under `--event-stream`: the file descriptor it is written to, the NDJSON framing and per-line schema version, every event type and its fields, the four terminal-error categories and the rules that classify them, the security marker and the internal-fault code that sits opposite it, the single-terminal-event guarantees, and the sanitization applied to every field. It is the spec-tier complement to the operator-facing `--event-stream` description in [CLI.md](../CLI.md#machine-readable-event-stream), which says what the stream is for and how to consume it; this document says how each line is constructed. It does not carry the exit-code table (see [CLI.md](../CLI.md#exit-codes)) -- only the two codes a supervisor must read against the category beside them -- nor the exchange protocol that produces the stages (see [PROTOCOL.md](PROTOCOL.md)), nor the display-sanitization escape format the fields reuse (see [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#display-sanitization-escape-format) and `packages/core/src/utils/sanitizeForDisplay.ts`). Intended readers are implementors writing a supervising process and security auditors.

The stream is a machine interface for a supervising process (an orchestrator, a job runner, a test harness) that spawns `psilink` and reads structured progress and outcome events without parsing the human log. It is off by default; passing `--event-stream` turns it on for every exchange-running command (the zero-setup exchange, `psilink exchange`, and the online `psilink invite`/`accept`). It has no effect on an offline `invite`/`accept`, which runs no exchange.

## File descriptor

The event stream is written to **file descriptor 3**, a fixed constant, never configurable. `stdout` (fd 1) and `stderr` (fd 2) are untouched by `--event-stream`: the CSV result still goes to stdout (byte-stable), and every human log line still goes to stderr. A supervisor wires fd 3 to a pipe it reads (for example, in Node, `spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe", "pipe"] })` exposes it as `child.stdio[3]`), so structured events arrive on a third channel that cannot corrupt the result or interleave with the log.

If `--event-stream` is given but fd 3 is not actually open (the process was spawned without wiring it), the CLI fails closed and loud: it raises a usage error (exit 64) at the top of the protocol lifecycle, before the exchange opens a connection of its own or moves any data, rather than silently dropping every event or crashing mid-run on the first write. Command-level work ahead of the lifecycle still runs first -- an exchange-running command establishes SSH host-key trust, which opens an SSH connection of its own to read the server's key, and prepares its dataset before it reaches the check -- so a failure in either of those exits without the preflight having run and without any event. The check is an `fstat` on fd 3; an unopened descriptor raises `EBADF` and is treated as fail-closed.

## NDJSON framing

The stream is newline-delimited JSON: one JSON object per line, each terminated by a single `\n`. Each event is serialized and flushed in one synchronous write, and the writer drains a short write in a loop, so a supervisor reading incrementally never observes a partial line and no two events interleave. Line ordering is emission order.

Every line carries a schema-version field so the version is observable from any single line on its own, without tracking stream position:

| Field | Type | Value | Meaning |
| ----- | ---- | ----- | ------- |
| `v` | integer | `1` | Event-stream schema version. Starts at 1. Bumped on any breaking change to an event's field layout or to the classification rules below; an additive field need not bump it. |
| `type` | string | one of `stages`, `stage`, `stageEnd`, `warning`, `metrics`, `result`, `error` | The event discriminant. This party owns every value; none is partner-derived, so a consumer can switch on it safely. |

A write failure after the supervisor has closed its read end (an `EPIPE`) marks the stream broken and is swallowed: it never crashes the exchange. Once broken, no later event retries the write. A supervisor reads "the stream stopped before a terminal event, and the process exited" as its own signal (see [Terminal-event guarantees](#terminal-event-guarantees)).

## Event types

The event types, and the fields each carries in addition to `v` and `type`:

### `stages`

Emitted once, before the first stage transition, mirroring the web front end's `onStages`. It carries the full ordered list of protocol stages the run will pass through, so a supervisor can render a progress skeleton up front.

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `stages` | array of `{ id, label }` | The ordered stage list from core's `describeExchangeStages`. `id` is a stable stage identifier (for example `confirming protocol`, `stage 1 / 2`); `label` is its display text. Both are sanitized (see [Sanitization](#sanitization)). |

```json
{"v":1,"type":"stages","stages":[{"id":"confirming protocol","label":"Confirming protocol"},{"id":"stage 1 / 2","label":"Linking key 1 / 2"}]}
```

### `stage`

Emitted at the start of each protocol stage, mirroring `onStage`. It marks a transition into the stage named by `id`.

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `id` | string | The stage identifier, matching an `id` from the preceding `stages` event. Sanitized. |
| `label` | string | The stage's display text. Sanitized. |

```json
{"v":1,"type":"stage","id":"stage 1 / 2","label":"Linking key 1 / 2"}
```

### `stageEnd`

Emitted when a protocol stage completes, carrying how long it ran so a supervisor can attribute wall-clock to the stage. A stage completes when the next stage begins (its `stage` event closes the previous one) or when the exchange finishes (the last stage). Only a completed stage is reported: a run that aborts mid-stage emits no `stageEnd` for the in-flight stage, so a reported duration is always a whole stage's time. The local output stage (result-CSV and audit-record generation, after `runExchange` returns) is not a named protocol stage and is not timed.

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `id` | string | The completed stage's identifier, matching an `id` from the preceding `stages` event. Sanitized. |
| `durationMs` | integer | The stage's wall-clock in whole milliseconds; never negative. |

```json
{"v":1,"type":"stageEnd","id":"stage 1 / 2","durationMs":1234}
```

### `warning`

Emitted for each non-fatal warning: the terms-exchange warnings mirroring `onWarning`, the cross-party host-key divergence notice -- a security signal a supervisor that discards stderr would otherwise never see -- the resolved-cardinality and pair-table notices of the post-terms, pre-round seam ([PROTOCOL.md](PROTOCOL.md#deriving-one-table-from-the-exchanged-association-maps), The advisory bound), the pre-exchange signing-without-a-record notice below, the failed-record notice of a terminated run below, and one per **persistence loss**, the class defined below (an audit artifact the run was asked for and could not produce, a configuration or consent record an online `invite`/`accept` could not write, or the configuration and key a zero-setup `--save` could not write). A warning does not end the run, and the terminated-run notice is the one exception to that reading: it accompanies a run that is already failing, and it is the failure's own `error` event that ends it.

A run that configures a signing identity while record writing is off (`--no-record`) emits its warning before any credential, terms, or data are sent, so the operator can still change either choice: the receipt that run writes has no record to pair against and can never verify above `INCOMPLETE`, and the record cannot be reconstructed afterwards (see [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md#record-and-verification-keys-files)). The run itself is unaffected -- which artifacts to keep is the operator's call.

An audit-artifact warning takes one of two shapes: an artifact that was built but could not be written names the destination it could not be written to, while an exchange record that could not be built at all names no destination and states that none was written. The second shape closes with what the run's own state makes of that: a completed run's says the run need not be re-run, a terminated run's that the disclosure it had already made has no local record.

A run that disclosed and then terminated -- in the signed-receipt swap, or in the received-payload check before it -- still writes the self-attested record of that disclosure ([PROTOCOL.md](PROTOCOL.md#self-attested-record)). A failure to write it emits a `warning` naming the destination, exactly as the completed-run write does, and a record that could not be built at all emits the other shape, so a disclosure that occurred always leaves either its record or a notice of that record's absence. Two exits from that rule are deliberate: `--no-record` gates the write and the notice alike, the operator having chosen to keep neither, and a failure thrown as a non-object can carry neither mark back to the CLI, so core reports the loss on the operator log instead -- where the record built, at the point it could not be attached; where it did not, at the build. Both notices are deliberately **not** a [persistence loss](#persistence-loss) and leave the exit code alone. That class means "the exchange succeeded, do not re-run it", and its code says so; this run failed and exits on its own fault, which is the opposite instruction and the one the operator needs. The terminal event stays `error`, and the warning precedes it like every other.

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `message` | string | The warning text. Sanitized and redacted -- it can embed partner-authored column names (see [Sanitization](#sanitization)). |

```json
{"v":1,"type":"warning","message":"partner disclosed a column not in the agreed set"}
```

#### Persistence loss

A persistence loss is a local write a completed run was asked to make and could not: the exchange itself succeeded, so it must not be re-run, and what is missing is on this party's own disk. Every one of them is reported on fd 3 as a `warning` -- a supervisor never has to parse stderr prose for this class -- and every one of them exits `EX_CANTCREAT` (73), while the terminal event stays `result` (see [Exit codes](../CLI.md#exit-codes)). The full set:

- An audit artifact the run was asked for and could not produce: the self-attested exchange record, or the dual-signed receipt.
- The post-authentication configuration write of an online `invite`/`accept`, whose run completes and writes its result while the configuration a later recurring `psilink exchange` needs does not reach disk.
- The zero-setup `--save` bootstrap: the configuration, and the key file that accompanies it when both parties saved, which do not reach disk while the exchange itself completes and writes its result. The warning names the outcome of each file it was asked to write, so the both-saved case where the key file failed and the configuration written before it could not be rolled back names that configuration as still on disk, to be moved or removed before the `psilink invite` the same notice advises. A configuration file that appeared at the target path after the run's up-front conflict check is the same loss -- the run refuses to overwrite it, and what is missing is again the recurring-exchange setup rather than anything about the invocation.
- Either machine-managed consent record an online `accept` refreshes in place on a configuration it reuses: the received-payload lock-in, or the outbound-payload confirmation. The reused configuration stands as it is; what is lost is this acceptance's record of what the operator consented to, so the next recurring exchange reconciles against the previous one's.
- The observed received-payload set an online `invite` crystallizes into the configuration it just wrote, after the exchange has revealed what the partner transmits. The configuration is on disk; the next recurring exchange reconciles its received payload lazily rather than fail-closed against the observed set.
- The catch-all for a post-exchange persistence step that itself failed before it could name a specific loss: the run reports that a post-exchange persistence step did not complete, with the cause on the human log.

A persistence-loss `warning` carries no rendered error text: the cause of the failed write goes to the human log, where it is escaped once at its own sink, so a supervisor reading this field is not handed a double-escaped copy of it.

Every other warning leaves the exit code alone. A persistence-loss warning is an ordinary `warning` event under the same schema version: `v` marks a change to an event's field layout or to the classification rules, and neither the occasions a warning is emitted for nor the process exit code is either of those, so a consumer written against `v: 1` reads every warning above.

The terminal counterpart of the same loss is a result file that could not be written: there the run has no result to report, so it fails with the terminal `error` event and its `output` category (see [Error categories](#error-categories)) and exits 73 alongside the losses here.

### `metrics`

The per-run operational-counter summary. Emitted exactly once, immediately before the terminal `result` or `error` event (so the terminal event stays last on the stream), on any run that reaches the terminal-event site. It reports this party's dataset size and how often the transport had to retry a data operation or re-establish the connection over the run. Every field is this party's own non-negative integer -- none is partner-derived. On a signal exit no terminal event fires, so no `metrics` event fires either.

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `recordsProcessed` | integer | This party's input record count fed into the exchange. |
| `transportRetries` | integer | Data-operation retries over the run: the count of transport-operation re-issues past the first attempt (the SFTP put/rename retry loops). `0` when none occurred, and always `0` on the filedrop channel, whose per-operation resilience is the poll-read loop rather than an operation re-issue. |
| `reconnects` | integer | Connections this run had to establish beyond its first: connect-time dialing retries past the first attempt, plus every SESSION the exchange lost to the partner (SFTP only). One increment per session lost, not per operation the loss interrupted and not per re-dial that recovered it, so a drop tearing a fan of concurrent operations moves this by one and so does a drop whose recovery re-dial fails. `0` when none occurred. Which triggers are counted here, which are exempt, and which are charged against `max_reconnect_attempts` are tabulated in [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#sftp-mid-exchange-session-recovery); a healthy `connection_per_poll` run reports zero only against a partner whose server does not cap session lifetime. |

```json
{"v":1,"type":"metrics","recordsProcessed":1000,"transportRetries":0,"reconnects":1}
```

### `result`

The success **terminal event**. Emitted exactly once, after the exchange completed and the local output stage (result CSV plus the non-fatal audit record) finished. It is emitted for a run that took a [persistence loss](#persistence-loss) too -- the exchange itself succeeded -- so a `result` beside exit 73 is read with the preceding [`warning`](#warning), which names what is missing.

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `resultWritten` | boolean | `true` when a matched result CSV was produced; `false` for a helper whose agreed terms give it no output table (it contributed to the match but receives no result file), and `false` for a count-only (`psi-c`) exchange, which produces no matched pairing for either party. |
| `intersectionCount` | integer | The size of the intersection a count-only exchange reported: the run's whole result. Present exactly when this party's agreed terms entitled it to the count, absent on every other run (including a count-only helper's, whose terms give it no output). It is what separates the two `resultWritten: false` outcomes -- present means this party received what its terms promised, absent means the terms withheld the result table -- so a consumer keys on the field's presence rather than on a zero value. |
| `countReportedByPartner` | boolean | Whether `intersectionCount` arrived as the partner's report rather than as a figure this party computed: `true` on the PSI sender seat of a both-entitled count-only run, whose number travels over the count-report leg, and `false` on the receiver that computed it. Emitted with `intersectionCount` and omitted with it, so a consumer reads the pair or neither. A consumer that presents the count states the trust posture from this field -- a sender's number is checked against no run of its own ([PROTOCOL.md](PROTOCOL.md#psi-c)) -- and reads a missing or non-boolean value as `false` rather than caveating a locally computed count. |

```json
{"v":1,"type":"result","resultWritten":true}
{"v":1,"type":"result","resultWritten":false,"intersectionCount":42,"countReportedByPartner":false}
```

### `error`

The failure **terminal event**. Emitted exactly once, for an organic (non-signal) failure. It carries the classified category and display-safe error text.

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `category` | string | One of `exchange`, `output`, `security`, `config` (see [Error categories](#error-categories)). |
| `message` | string | Display-safe error text, the same rendering stderr receives (see [Sanitization](#sanitization)). |

```json
{"v":1,"type":"error","category":"security","message":"key exchange authentication failed"}
```

## Error categories

The four categories are the web front end's `ExchangeErrorCategory` vocabulary (`apps/web/src/psi/exchangeLifecycle.ts`), so a consumer reads one set of names across both. The CLI's error taxonomy -- the core `UsageError`/`OperatorConfigError` hierarchy, the `InternalConsistencyError` class beside it, the `ConnectionError` kinds, and the command boundaries' 64/69/70/73 exit split -- maps onto them as follows:

| Category | Meaning | Classification rule |
| -------- | ------- | ------------------- |
| `config` | A fault composed solely of this party's own configuration -- actionable, safe to surface, and reproduced identically by every retry. | The terminal error is an `OperatorConfigError` (a `UsageError` subclass), in any phase before `output`. Scoped to that exact base type, **not** any `UsageError`: a sibling `UsageError` can embed partner-influenced text, so it stays `exchange` (message not surfaced as config). Every construction site of `OperatorConfigError` and its subclasses is enumerated by `apps/cli/test/unit/operatorConfigErrorSites.test.ts`, which records what each message interpolates and why it is local, and fails on a site or an interpolation it does not account for. That enumeration is syntactic and bounded to what it scans: `packages/core/src`, `apps/cli/src`, and `apps/web/src`, for classes written as `class X extends <member>` and constructions written as `new <Identifier>(...)`, so a member or a construction reached through a factory, an alias, or a variable is outside it. |
| `security` | A trust-boundary failure: the authenticated key exchange reported a wrong secret, tamper, or replay; the SFTP host-key verification failed (a pinned-fingerprint mismatch, or an unpinned host refused fail-closed); or the post-handshake AEAD layer reported tampering. | The terminal error is a `ConnectionError` with `kind === "security"`, in any phase before `output`. |
| `output` | The privacy-sensitive exchange already succeeded; only local result generation failed. The operator must **not** re-run the exchange. | The failure landed in the OUTPUT phase (after `runExchange` returned, during result-CSV or audit-record generation), regardless of the error's type. |
| `exchange` | Every other failure -- a retryable transport or usage fault. | The default: any terminal error not matched by a rule above. |

The phase advances as the run progresses: everything up to and including the handshake is `prepare`, the PSI exchange is `run`, and the local result/record generation after `runExchange` returns is `output`. The rules are checked in the order output-phase, then `OperatorConfigError`, then `security`-kind `ConnectionError`, else `exchange` -- both discriminants (the error's type/kind and the phase) are structural, not a claim about which check happened to fire.

The `config` rule keys on the type alone, where the web's alert classification additionally requires its `prepare` phase. What the category has to agree with here is the exit code, which no front-end alert has: every `OperatorConfigError` exits `EX_USAGE` (64), the code that tells an operator to change their own input, while `exchange` is the retryable bucket -- so a member raised mid-run (the receipt bindings a signing run holds at the terms exchange and again at the swap, whose two disagreeing values are both this party's own) would otherwise have the stream inviting the retry the exit code refuses, on a fault every attempt reproduces identically. Widening costs the category nothing it claims: a member's message is composed solely of this party's own content whatever phase raises it, and this stream emits that message under either category.

The `output` category covers the whole stage, so it is broader than the exit code that usually accompanies it. The run exits `EX_CANTCREAT` (73) when the loss is the result file failing to reach disk -- the local write the code names, and the terminal counterpart of a [persistence loss](#persistence-loss). It exits `EX_UNAVAILABLE` (69) for the other faults of that stage, which are not local write failures: a partner payload that does not fit the shape the association table requires (duplicate or missing partner row indices) is refused while building the table, and 73 would tell an operator to go looking on their own disk for something that is not there.

### The security marker

The process exit code cannot distinguish a `security` failure from an ordinary one: a `security`-kind `ConnectionError` is not a `UsageError`, so it exits 69 (EX_UNAVAILABLE) -- the same code a plain transport drop yields. A supervisor that must treat a trust failure differently (a wrong secret is not a retryable transport blip, and a host presenting an unexpected key must not be silently reconnected to) therefore cannot rely on the exit code; the `error` event's `category: "security"` is the only place the distinction is observable. This covers the handshake cases (a failed key-exchange authentication: wrong secret, tampered or malformed handshake frames) and the host-identity cases (an SFTP host-key mismatch against the pinned fingerprint, or the unpinned fail-closed refusal) alike. Reading the terminal event, not the exit code, is the supported way to detect a trust-boundary failure.

### The internal-fault code

The mirror of the security marker: here the exit code carries the distinction and the category cannot. An internal fault is a disagreement between two derivations of the same quantity inside one party -- a defect in psilink itself, not in anything the operator, the partner, or the transport supplied. Core raises it as an `InternalConsistencyError`, and the CLI's error-to-exit boundary maps that class to `EX_SOFTWARE` (70).

One check raises it: the single-pass sender's send-time reply-cap backstop, where the reply this party built exceeds the byte cap both parties derive from their declared sizes, on an exchange whose declared sizes the single-pass ceiling gate has already cleared.

The terminal `error` event carries `category: "exchange"`. The four categories are the web's vocabulary and have no internal-fault member, and the classification rules key on the phase and on `OperatorConfigError` / `ConnectionError` membership, neither of which this class joins -- so it falls to the default bucket, alongside the retryable transport faults it is not one of. A supervisor separates it by the exit code.

Why 70 rather than a code already in the vocabulary:

- **Not 64 (`EX_USAGE`).** 64 tells the operator that their own input or configuration is what to change. This condition is reached only after the ceiling gate has found both parties' declared widths and record counts within budget, so there is no dataset either operator controls that moves it, and the error's own message says so.
- **Not 69 (`EX_UNAVAILABLE`).** 69 is the transport-availability code a supervisor is expected to retry once the transport recovers. This fault is deterministic in the run's own inputs, so every retry rebuilds the same reply and reaches the same refusal -- while conducting another full exchange, re-sending this party's records, which is exactly the loop the retry cap exists to bound (see [Exit codes](../CLI.md#exit-codes)).
- **70 (`EX_SOFTWARE`)** is the `sysexits` code for an internal software error, and matches the remedy the message states: report it, with the two byte counts it names.

The human line agrees with the code. The class carries `psilinkRecoveryHintEmitted`, so the CLI's generic post-handshake "retry the exchange without re-inviting" advisory is suppressed and the fault's own report-it remedy stands alone on stderr. The suppression is load-bearing rather than cosmetic here: the backstop fires mid-data-exchange, after the handshake rotated the secret, which is exactly the window that advisory prints in, and it would prescribe the retry the exit code exists to stop.

## Terminal-event guarantees

Exactly one terminal event -- a `result` when the exchange and the local output stage completed, or one classified `error` on an organic failure -- is emitted per run. It is the last event on the stream. The `stages`, `stage`, `stageEnd`, `warning`, and `metrics` events that precede it are progress and summary, not outcome. The one `metrics` event is emitted immediately before the terminal event, so a supervisor reads the run's operational counters on the line just above the outcome.

A `result` says the exchange completed, which is not the same as a zero exit. A run that took a [persistence loss](#persistence-loss) emits a `warning` for each one, then its `result`, and exits 73 (see [Exit codes](../CLI.md#exit-codes)). Either channel alone identifies it: the exit code separates it from both a clean run (0) and a transport failure (69), and the `warning` names what is missing where the code cannot. A supervisor keying success off the terminal event reads the exit code with it, because the terminal event alone cannot separate such a run from a fully persisted success.

The classified terminal `error` category is the machine-readable abort reason: it names a `security`, `output`, `config`, or `exchange` failure independently of the free-text `message` (the same text stderr logs) and of the exit code. A supervisor keys the abort decision off that category, not off the human log line.

The guarantee applies from protocol entry, immediately after the fd-3 preflight: every organic failure inside the protocol lifecycle -- including the local prepare checks (an expired or malformed shared secret, a bad key-file path) -- emits its one classified `error` event before the failure propagates to the process exit. A failure before the process reaches the protocol lifecycle at all -- the config file failing to load or validate in the command handler, a bad flag or positional, the SSH host-key trust probe, an unreadable input CSV, or the fd-3 preflight itself -- emits no events and exits 64 or 69, never 130 or 143; a supervisor distinguishes that from an interrupt by the exit code.

A run interrupted by `SIGINT` or `SIGTERM` exits through the signal handler's `process.exit` (exit 130 for SIGINT, 143 for SIGTERM), which bypasses the emission site, so **no terminal event is emitted on a signal exit**. A supervisor reads the absence of a terminal event together with exit 130 or 143 as the interrupt signal. This is deliberate and applies to both interrupt sub-cases (a clean interrupt and an interrupt that coincides with an in-flight error), so the "no terminal event plus 130/143" reading is unambiguous rather than fired inconsistently. A broken pipe (the supervisor closed its read end) likewise leaves the stream without a terminal event; the exit code remains authoritative there too.

## Sanitization

No unsanitized partner- or server-controlled string reaches an event. Every free-text field is escaped at construction, using the same display-boundary sanitizers stderr uses, so a hostile value cannot inject a control sequence, a bidi override, a spoofed NDJSON line break, or a confusable character into a supervisor's parser or terminal:

- Stage `label` and `id` (on both the `stage` and `stageEnd` events) and the `warning` `message` derive from linkage-key names and terms text the **partner** may have authored, so they are passed through `redactAndSanitizeForDisplay` -- the private-key strip and then `sanitizeForDisplay` (`packages/core/src/utils/sanitizeForDisplay.ts`), exactly as `protocol.ts` treats the same strings before they reach stderr, so neither route is the weaker one. Every code point outside printable ASCII is rewritten to a visible `\xHH` / `\uHHHH` / `\u{HHHHH}` escape, so a raw ESC (`\x1b`, the ANSI-sequence driver), a `U+202E` right-to-left override, a newline, a zero-width character, and a homoglyph are all neutralized. Every free-text field of this stream is stripped of PEM/OpenSSH private-key blocks alike, because a persisted event stream is the same class of sink as `--log-file`. The `warning` `message` escapes under a display cap sized for a whole composed warning rather than for a single value (4096 output characters), because the cross-party host-key divergence notice is the warning a supervisor that discards stderr has nothing else to read, and the per-value cap cuts it before its recovery instruction; the values interpolated INTO a warning carry that per-value cap where they were composed. `protocol.ts` reads the same cap where it puts a composed terms-exchange warning on stderr, so the two sinks carry one text at one budget: the operator watching the terminal is never shown less of that warning than the supervisor reading this stream. That is a property of the terms-exchange route, not of this stream's `warning` events at large -- a warning emitted only to this stream has no stderr twin to compare.
- The `error` `message` is rendered by `sanitizeErrorForDisplay`, which walks the error's `cause` chain, escapes each link through `sanitizeForDisplay`, and strips PEM/OpenSSH private-key blocks -- the same rendering stderr and `--log-file` receive.
- The numeric fields carry no free text: the `stageEnd` `durationMs` and the `metrics` counters (`recordsProcessed`, `transportRetries`, `reconnects`) are this party's own integers, floored to a non-negative whole number at construction so a malformed value cannot produce an out-of-contract field. No partner-controlled string rides any metric event. The `result` `intersectionCount` is the one numeric field a partner can influence -- a count-only sender is told the tally by the receiver (see [PROTOCOL.md](PROTOCOL.md), PSI-C) -- and it takes the same floor at construction, on top of the protocol bound core applies before it gets here: the reported figure may not exceed the smaller of the two exchanged record counts.
- The enum-like fields (`type`, `category`, and the stage `id` values the CLI itself defines) are this party's own closed vocabulary, not partner-derived, so a consumer can trust them as discriminants. `type` and `category` are emitted as first-party literals and take no escape. The stage `id` values are routed through the escape uniformly, whether the CLI defined them or they carry partner-authored text, since one field carries both and they are echoed on the wire in the same string form.

Because sanitization runs before serialization, the `\n` that frames NDJSON lines can only ever be the writer's own line terminator -- a partner-supplied newline is already an escaped `\x0a` by the time the object is serialized, so it cannot forge a second line.

A supervisor that re-escapes the `warning` `message` before showing it -- defense in depth at its own trust boundary, which this stream is designed to tolerate -- composes under that same shared budget: the field is a whole warning, not a value, so re-capping it at the per-value default would cut the recovery instruction the stream exists to deliver. Re-escaping is otherwise free of cost beyond fidelity: every pass doubles a literal backslash already doubled by the last, so a partner filename's single backslash widens with each boundary it crosses, and a message composed near the budget at one boundary is what the next one cuts.

The `error` `message` is not one value either, and a supervisor that re-escapes it splits it first. It is a whole rendered chain: at most `MAX_ERROR_CAUSE_DEPTH` links joined by the renderer's own `\ncaused by: ` framing, each already escaped under the composed-message cap of 1024 output characters. The cap bounds what the escape emits and the markers are appended on top of it, so a link the cap cut renders to as many as 1038 characters (the cap plus the 14-character truncation marker) and the last link of a chain the depth bound cut to as many as 1065 (that plus a space and the 26-character elision marker) -- an 8-link chain at its ceiling is 8331 characters of link text, 8415 with the seven framing separators. Escaping each link at that cap and holding the link count to that same depth bound admits exactly the volume the renderer emits, while charging the whole chain to one cap cuts it wherever that cap falls -- on a refusal that partitions by chooser, inside the first link or two, which is where a partner-chosen fragment sits and ahead of where this party's recovery step does. The split is exact: every link is escaped before the join, so the only raw newline the field can carry is the framing, and a link whose own text reads `caused by:` cannot forge a boundary. An elision marker that arrives on the last link is lifted off before that link is re-escaped and appended again afterwards, since the renderer appends it past the cap and re-escaping the link whole would spend the budget on the marker itself: what that preserves is the marker's ABSENCE, the half an operator can rely on ([CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#display-sanitization-escape-format)). `sanitizeErrorChainLinks` in `packages/core/src/utils/sanitizeErrorForDisplay.ts` is that pass; the console's own relay is a consumer of it ([SERVER_JOB_API.md](SERVER_JOB_API.md#relay-validation-at-the-trust-boundary)).
