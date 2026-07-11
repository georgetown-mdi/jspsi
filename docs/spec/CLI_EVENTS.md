---
title: "CLI Machine-Interface Event Stream"
---

# CLI machine-interface event stream

This document specifies the opt-in machine-readable event stream the `psilink` CLI emits under `--event-stream`: the file descriptor it is written to, the NDJSON framing and per-line schema version, every event type and its fields, the four terminal-error categories and the rules that classify them, the security marker, the single-terminal-event guarantees, and the sanitization applied to every field. It is the spec-tier complement to the operator-facing `--event-stream` description in [CLI.md](../CLI.md#machine-readable-event-stream), which says what the stream is for and how to consume it; this document says how each line is constructed. It does not cover the exit codes (see the exit-code table in [CLI.md](../CLI.md#exit-codes)), the exchange protocol that produces the stages (see [PROTOCOL.md](PROTOCOL.md)), or the display-sanitization escape format the fields reuse (see [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#display-sanitization-escape-format) and `packages/core/src/utils/sanitizeForDisplay.ts`). Intended readers are implementors writing a supervising process and security auditors.

The stream is a machine interface for a supervising process (an orchestrator, a job runner, a test harness) that spawns `psilink` and reads structured progress and outcome events without parsing the human log. It is off by default; passing `--event-stream` turns it on for every exchange-running command (the zero-setup exchange, `psilink exchange`, and the online `psilink invite`/`accept`). It has no effect on an offline `invite`/`accept`, which runs no exchange.

## File descriptor

The event stream is written to **file descriptor 3**, a fixed constant, never configurable. `stdout` (fd 1) and `stderr` (fd 2) are untouched by `--event-stream`: the CSV result still goes to stdout (byte-stable), and every human log line still goes to stderr. A supervisor wires fd 3 to a pipe it reads (for example, in Node, `spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe", "pipe"] })` exposes it as `child.stdio[3]`), so structured events arrive on a third channel that cannot corrupt the result or interleave with the log.

If `--event-stream` is given but fd 3 is not actually open (the process was spawned without wiring it), the CLI fails closed and loud at startup: it raises a usage error (exit 64) before opening any connection or doing any exchange work, rather than silently dropping every event or crashing mid-run on the first write. The check is an `fstat` on fd 3 at the top of the protocol lifecycle; an unopened descriptor raises `EBADF` and is treated as fail-closed.

## NDJSON framing

The stream is newline-delimited JSON: one JSON object per line, each terminated by a single `\n`. Each event is serialized and flushed in one synchronous write, and the writer drains a short write in a loop, so a supervisor reading incrementally never observes a partial line and no two events interleave. Line ordering is emission order.

Every line carries a schema-version field so the version is observable from any single line on its own, without tracking stream position:

| Field | Type | Value | Meaning |
| ----- | ---- | ----- | ------- |
| `v` | integer | `1` | Event-stream schema version. Starts at 1. Bumped on any breaking change to an event's field layout or to the classification rules below; an additive field need not bump it. |
| `type` | string | one of `stages`, `stage`, `warning`, `result`, `error` | The event discriminant. This party owns every value; none is partner-derived, so a consumer can switch on it safely. |

A write failure after the supervisor has closed its read end (an `EPIPE`) marks the stream broken and is swallowed: it never crashes the exchange. Once broken, no later event retries the write. A supervisor reads "the stream stopped before a terminal event, and the process exited" as its own signal (see [Terminal-event guarantees](#terminal-event-guarantees)).

## Event types

The five event types, and the fields each carries in addition to `v` and `type`:

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

### `warning`

Emitted for each non-fatal warning produced during the terms exchange, mirroring `onWarning`. A warning does not end the run.

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `message` | string | The warning text. Sanitized -- it can embed partner-authored column names. |

```json
{"v":1,"type":"warning","message":"partner disclosed a column not in the agreed set"}
```

### `result`

The success **terminal event**. Emitted exactly once, after the exchange completed and the local output stage (result CSV plus the non-fatal audit record) finished.

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `resultWritten` | boolean | `true` when a matched result CSV was produced; `false` for a helper whose agreed terms give it no output table (it contributed to the match but receives no result file). |

```json
{"v":1,"type":"result","resultWritten":true}
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

The four categories are lifted verbatim from the web front end's `ExchangeErrorCategory` (`apps/web/src/psi/exchangeLifecycle.ts`), so a consumer classifies a CLI failure exactly as it would a web one. The CLI's error taxonomy -- the core `UsageError`/`OperatorConfigError` hierarchy, the `ConnectionError` kinds, and the `runOrExit` 64-vs-69 exit split -- maps onto them as follows:

| Category | Meaning | Classification rule |
| -------- | ------- | ------------------- |
| `config` | A prepare-time fault composed solely of this party's own configuration -- actionable and safe to surface. | The terminal error is an `OperatorConfigError` (a `UsageError` subclass) raised in the PREPARE phase. Scoped to that exact base type, **not** any prepare-phase `UsageError`: a sibling prepare-time `UsageError` can embed partner-influenced text, so it stays `exchange` (message not surfaced as config). |
| `security` | A trust-boundary failure -- the authenticated key exchange reported a wrong secret, tamper, or replay. | The terminal error is a `ConnectionError` with `kind === "security"`, in any phase. |
| `output` | The privacy-sensitive exchange already succeeded; only local result-file generation failed. The operator must **not** re-run the exchange. | The failure landed in the OUTPUT phase (after `runExchange` returned, during result-CSV or audit-record generation), regardless of the error's type. |
| `exchange` | Every other failure -- a retryable transport or usage fault. | The default: any terminal error not matched by a rule above. |

The phase advances as the run progresses: everything up to and including the handshake is `prepare`, the PSI exchange is `run`, and the local result/record generation after `runExchange` returns is `output`. The rules are checked in the order output-phase, then prepare-phase `OperatorConfigError`, then `security`-kind `ConnectionError`, else `exchange` -- both discriminants (the error's type/kind and the phase) are structural, not a claim about which check happened to fire.

### The security marker

The process exit code cannot distinguish a `security` failure from an ordinary one: a `security`-kind `ConnectionError` is not a `UsageError`, so it exits 69 (EX_UNAVAILABLE) -- the same code a plain transport drop yields. A supervisor that must treat an authentication failure differently (a wrong secret is not a retryable transport blip) therefore cannot rely on the exit code; the `error` event's `category: "security"` is the only place the distinction is observable. Reading the terminal event, not the exit code, is the supported way to detect a trust-boundary failure.

## Terminal-event guarantees

Exactly one terminal event -- a `result` on success, or one classified `error` on an organic failure -- is emitted per run. It is the last event on the stream. The `stages`, `stage`, and `warning` events that precede it are progress, not outcome.

The guarantee applies from protocol entry, immediately after the fd-3 preflight: every organic failure inside the protocol lifecycle -- including the pre-connection prepare checks (an expired or malformed shared secret, a bad key-file path) -- emits its one classified `error` event before the failure propagates to the process exit. A failure before the process reaches the protocol lifecycle at all -- the config file failing to load or validate in the command handler, a bad flag or positional, or the fd-3 preflight itself -- emits no events and exits 64; a supervisor distinguishes that from an interrupt by the exit code (64 versus 130/143).

A run interrupted by `SIGINT` or `SIGTERM` exits through the signal handler's `process.exit` (exit 130 for SIGINT, 143 for SIGTERM), which bypasses the emission site, so **no terminal event is emitted on a signal exit**. A supervisor reads the absence of a terminal event together with exit 130 or 143 as the interrupt signal. This is deliberate and applies to both interrupt sub-cases (a clean interrupt and an interrupt that coincides with an in-flight error), so the "no terminal event plus 130/143" reading is unambiguous rather than fired inconsistently. A broken pipe (the supervisor closed its read end) likewise leaves the stream without a terminal event; the exit code remains authoritative there too.

## Sanitization

No unsanitized partner- or server-controlled string reaches an event. Every free-text field is escaped at construction, using the same display-boundary sanitizers stderr uses, so a hostile value cannot inject a control sequence, a bidi override, a spoofed NDJSON line break, or a confusable character into a supervisor's parser or terminal:

- Stage `label` and `id` and the `warning` `message` derive from linkage-key names and terms text the **partner** may have authored, so they are passed through `sanitizeForDisplay` (`packages/core/src/utils/sanitizeForDisplay.ts`) -- exactly as `protocol.ts` sanitizes the same strings before they reach stderr. Every code point outside printable ASCII is rewritten to a visible `\xHH` / `\uHHHH` / `\u{HHHHH}` escape, so a raw ESC (`\x1b`, the ANSI-sequence driver), a right-to-left override (`‮`), a newline, a zero-width character, and a homoglyph are all neutralized.
- The `error` `message` is rendered by `sanitizeErrorForDisplay`, which walks the error's `cause` chain, escapes each link through `sanitizeForDisplay`, and strips PEM/OpenSSH private-key blocks -- the same rendering stderr and `--log-file` receive.
- The enum-like fields (`type`, `category`, and the stage `id` values the CLI itself defines) are this party's own closed vocabulary, not partner-derived, so a consumer can trust them as discriminants. They are still routed through the same escape uniformly, since they are echoed on the wire in the same string form.

Because sanitization runs before serialization, the `\n` that frames NDJSON lines can only ever be the writer's own line terminator -- a partner-supplied newline is already an escaped `\x0a` by the time the object is serialized, so it cannot forge a second line.
