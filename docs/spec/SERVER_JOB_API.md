---
title: "Web Server Job API"
---

# Web server job API

This document specifies the web application's server-side job API: the HTTP endpoints through which a supervisor creates, observes, cancels, and deletes an exchange job that the Nitro server drives as a `psilink` CLI subprocess, the typed intent the client submits and the validation that makes it injection-closed, the on-disk workdir layout and modes, the SSE event relay and its full-history replay, the exit-code reconciliation and cancellation escalation, the environment variables that gate and configure the feature, and the memory-only job lifetime. It is the spec-tier complement to the operator-facing overview in [DEPLOYMENT.md](../DEPLOYMENT.md#server-job-api), which says what the feature is for and how to turn it on; this document says how each request, file, and event is constructed. It consumes -- and re-validates at the trust boundary -- the CLI's fd-3 event stream specified in [CLI_EVENTS.md](CLI_EVENTS.md); it does not respecify that stream's construction (see there). It does not cover the exchange protocol that produces the events (see [PROTOCOL.md](PROTOCOL.md)) or the display-sanitization escape format the fields reuse (see [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#display-sanitization-escape-format)). Intended readers are implementors writing a supervisor against this API and security auditors.

The job API exists for the console-appliance deployment: a container serving one party, inside that party's trust boundary, that drives the party's own `psilink exchange` runs without the operator invoking the CLI by hand. It is not a shared rendezvous between parties; the trust invariant it rests on and what would violate it are in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#single-party-appliance-trust-boundary). The API is off unless a data root is configured, and its whole design -- server-composed CLI inputs, memory-only state, loopback-or-token auth -- is calibrated to that single-operator posture.

## Feature gate and authentication

The API is dark by default. Every endpoint resolves a gate before any filesystem access or subprocess spawn, in a fixed order:

1. **Feature gate.** If no data root is configured (`JOB_DATA_ROOT` unset or empty), the endpoint answers `404` and consults nothing further -- indistinguishable from an unknown route to a hosted probe, so the API's presence is not observable to an unauthenticated caller.
2. **Bearer token.** If a token is configured (`JOB_API_TOKEN` non-empty), the request must present `Authorization: Bearer <token>`. A missing or non-matching bearer is `401`. The comparison is constant-time (both sides hashed with SHA-256 and compared with `timingSafeEqual`, never short-circuiting on length), so the token is not recoverable through response timing. When no token is configured, the gate allows the request (the loopback appliance case; see the startup rule below).

Every job response carries `Cache-Control: no-store` and no CORS headers -- the API is same-origin appliance-local, so a cross-origin caller is never granted access. These are additive to the defense-in-depth response headers the server entry already applies globally (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security)).

## Endpoints

| Method | Path | Success | Notes |
| ------ | ---- | ------- | ----- |
| `POST` | `/api/jobs` | `201` `{ "id": "<uuid>" }` | Create and start a job from a JSON intent. `400` on unparseable body or intent that fails schema validation. |
| `GET` | `/api/jobs/:jobId` | `200` status JSON | `404` on malformed, unknown, or evicted id. |
| `DELETE` | `/api/jobs/:jobId` | `204` | Kills a still-running child, drops the record, removes the workdir. `404` when the id is unknown. |
| `GET` | `/api/jobs/:jobId/events` | `200` `text/event-stream` | SSE event relay with full-history replay. `404` on unknown id. |
| `POST` | `/api/jobs/:jobId/cancel` | `202` | Request cancellation; idempotent (`202` even if already terminal). `404` on unknown id. |
| `GET` | `/api/jobs/:jobId/result` | `200` `text/csv` | The matched-result CSV, only after the job succeeded. `404` otherwise. |
| `GET` | `/api/jobs/:jobId/record` | `200` `application/json` | The self-attested exchange record, only after the job succeeded. `404` otherwise. |
| `GET` | `/api/jobs/:jobId/keys` | `200` `application/json` | The private verification keys paired with the record, only after the job succeeded. `404` otherwise. |

Auth applies to every endpoint uniformly: a disabled API is `404` and a bad bearer is `401` on all of them, resolved before the id is even parsed.

### Job id and the traversal guard

The job id is a server-generated v4 UUID; the client never supplies it. Every id-bearing endpoint validates the parameter against the exact canonical v4 UUID pattern before any filesystem use, and a value that is not a canonical v4 UUID (a traversal payload, an absolute path, an empty string) is `404` without touching disk. Resolving a workdir applies a second, defense-in-depth check: the id is joined to the resolved data root and the result confirmed to stay strictly under `<dataRoot>/`, so even a validated id that resolved outside the root is refused. An unknown-but-well-formed id (never created, or TTL-evicted) is `404` identically, so id validity is not distinguishable from job existence.

### The `GET /api/jobs/:jobId` status body

```json
{
  "id": "<uuid>",
  "status": "running" | "succeeded" | "failed" | "cancelled",
  "terminal": { "outcome": "...", "exitCode": <int|null>, "signal": "<sig|null>" } | null,
  "terminalEmitted": <bool>,
  "eventCount": <int>,
  "resultAvailable": <bool>,
  "recordAvailable": <bool>,
  "recordCreatedAt": "<iso-8601>"   // present only when recordAvailable is true
}
```

`terminal` is null until the child exits; `resultAvailable` is true exactly when `status` is `succeeded`. `recordAvailable` is true only when the job succeeded, both the record and its verification-keys file are on disk, and the record validates and yields a `createdAt`; the record pair is offered all-or-nothing. `recordCreatedAt` is the record's own timestamp, present exactly when `recordAvailable` is true -- a client derives the download filename from it, matching the in-browser exchange path. Because the CLI's record write is non-fatal (a disk failure after a successful exchange is warned, not thrown), a job can be `resultAvailable: true` with `recordAvailable: false`.

### The `GET /api/jobs/:jobId/result` response

Served only when `status === "succeeded"` and the output file exists and is readable; any other case (unfinished, failed, cancelled, or missing file) is `404` rather than leaking whether an unfinished job exists. The body is the job's server-chosen output file inside its workdir -- never a client-named path. Headers: `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="result-<id>.csv"` (a fixed, server-derived download name), and `X-Content-Type-Options: nosniff`, plus the `no-store` discipline.

### The `GET /api/jobs/:jobId/record` and `/api/jobs/:jobId/keys` responses

Served under the same gate as the result response -- only when `status === "succeeded"` and the respective file (`record.json`, `record.keys.json`) exists and is readable, `404` otherwise. The bodies are the job's server-chosen record and keys files inside its workdir, never a client-named path. Headers: `Content-Type: application/json; charset=utf-8`, a fixed `Content-Disposition: attachment; filename="psilink-record.json"` / `"psilink-record.keys.json"` (a server-side fallback; the browser's save name is set by its download control and carries the record's timestamp), and `X-Content-Type-Options: nosniff`, plus the `no-store` discipline. A client offers these two downloads only when `recordAvailable` on the status route is true, so it never links a `404`. The verification keys are private material -- a salt plus the record's commitment can open a committed value -- so `/keys` is gated and `no-store` identically to `/record` and `/result`; see [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md).

## The exchange intent

`POST /api/jobs` accepts a JSON body validated against a strict schema. The intent is the only channel from the client into a CLI invocation, and it is injection-closed by construction: no field becomes an argv string, a filesystem path, a host, or a credential reference.

| Field | Type / validation | Why it cannot inject |
| ----- | ----------------- | -------------------- |
| `channel` | literal `"filedrop"` | The only accepted channel. A filedrop exchange has no host and no credential field at all, so the connection block the server composes carries nothing injectable. An `sftp`/`webrtc` intent is rejected as unknown. |
| `linkageTerms` | core's `LinkageTermsSchema` | Bounded partner-authored vocabulary (field names, key elements, transforms). It carries no filesystem path, host, or command field, so a hostile value cannot escape into argv or the filesystem. |
| `sharedSecret` | base64url 32-byte pattern (`/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/`) | Credential material matching the CLI key-file shape. It is written into a fixed-name key file, never used as a path or argv fragment; a malformed secret is rejected here rather than crashing the child at load. |
| `inputCsv` | non-empty string | CONTENT written to a fixed, server-chosen filename in the workdir. The client never names a file. |
| `metadata` | optional; core's `MetadataSchema` | The operator's per-party column metadata (each column's name, semantic type, role, and payload flag). Structured data written into the config as YAML values, never an argv fragment, path, host, or credential. Carried so the CLI honors the operator's disclosure edits (which columns are sent vs ignored) instead of inferring metadata from the column names. |
| `standardization` | optional; core's `StandardizationSchema` | The operator's per-party standardization pipeline (per-field transform steps). Structured data written into the config as YAML values, never an argv fragment, path, host, or credential. |
| `options` | numeric/boolean/enum subset (below) | Every field is a number, boolean, or closed enum -- none can carry a path, host, credential, or command. |
| `eventStream` | optional boolean (default true) | Whether `--event-stream` is passed. |

The schema is `.strict()`: an unknown key (a smuggled `path`, `host`, or `@path` credential reference) fails validation. The `options` subset is deliberately the numeric/boolean/enum knobs only -- `pollIntervalMs`, `peerTimeoutMs`, `serverConnectTimeoutMs`, `maxReconnectAttempts` (0..604800), `timestampInFilename`, `locklessRendezvous`, `retainFiles`, and `unexpectedFiles` (`error`/`warn`/`ignore`). The path and directory fields of the CLI's file-sync options are intentionally not surfaced (the server owns every directory), and the free-text `peerId` is omitted for the same reason.

The `metadata` and `standardization` fields are validated structured data -- core's `MetadataSchema` and `StandardizationSchema`, respectively -- and carry no injectable field. Their size bound is only partial: each column `name` is length-capped and `role`/`type` are closed enums, but the metadata and standardization arrays and the free-text `description`, `output`, `input`, and standardization `params` are not length-bounded by these schemas, and the linear-time regex-dialect gate (`docs/spec/PROTOCOL.md`, "Transform regular-expression dialect") applies to the negotiated `linkageTerms` transforms, not to the standardization pipeline's raw-pattern steps. That is a resource bound, not an injection escape: no metadata or standardization value becomes an argv fragment, a path, a host, or a credential.

### Composed CLI configuration

From a validated intent the server composes the CLI config document (snake_case YAML the CLI loads verbatim) through core's `mintExchangeFile`, so the assembled spec is validated by the CLI's own schema before it is written. The composition is fixed:

- The connection is a credential-free `filedrop` locator whose one path field is set to the server-chosen `exchange` subdirectory of the workdir -- not to any client value. By core's `ExchangeFileInput` typing no credential is representable in a filedrop connection.
- No `authentication` block is ever assembled; the shared secret rides the separate key file.
- The intent's `linkageTerms` reach the document only after core's schema validation.
- The intent's `metadata` and `standardization`, when present, are attached as the config's `metadata` and `standardization` blocks (omitted when absent). Carrying them is what makes the operator's data-prep edits authoritative on this path: the CLI's `prepareForExchange` uses the composed metadata instead of falling back to `inferMetadata`, which would default an unrecognized column to disclosed payload and could silently disclose a column the operator marked ignored.
- The tuning `options`, if any were set, are narrowed to the CLI's file-sync options and attached; when none were set the block is omitted entirely.

The key file body is `{"sharedSecret":"<value>"}` with no `expires` stamped, so a server-driven job carries no invitation-token lifetime of its own.

## Workdir layout

Each job gets a workdir at `<dataRoot>/<jobId>/`, created mode `0o700` (owner-only, `rwx------`), with an explicit `chmod` after `mkdir` because a restrictive umask is not guaranteed. Creation fails if the directory already exists, so a reused id cannot clobber an existing job. The data root itself is created (recursively) if missing. Inside the workdir, files are written at fixed, server-chosen names, each mode `0o600` (owner-only, `rw-------`, again `chmod`-enforced after write):

| Name | Contents |
| ---- | -------- |
| `psilink.yaml` | The composed CLI config document. |
| `.psilink.key` | The key file carrying the shared secret. |
| `input.csv` | The client's input CSV content. |
| `exchange/` | The rendezvous directory (mode `0o700`) the filedrop exchange reads and writes. |
| `output.csv` | The CLI's matched-result output (written by the CLI on success). |
| `record.json` | The self-attested exchange record (written by the CLI on success; the write is non-fatal, so it may be absent). |
| `record.keys.json` | The private verification keys paired with the record (owner-only; written alongside the record under the same non-fatal write). |

The client never supplies a filename: submitted content is written to these constant names, and the CLI is pointed at them by absolute path. Keeping the names constant is what makes "a client string never becomes a file path" hold.

## Subprocess invocation

The CLI is spawned with `spawn` (not a shell, `shell: false`) and an argv array assembled only from fixed templates plus the server-generated absolute paths:

```
<node> <binaryPath> exchange --config-file <configPath> --key-file <keyPath> --record-file <recordPath> [--event-stream] <inputPath> <outputPath>
```

`--record-file` pins the self-attested record to the server-known `record.json` in the workdir (the CLI derives the keys path as `record.keys.json` alongside it), so the server can serve both from a fixed path; without it the CLI would write to a timestamped default name the server could not locate. Records are on by default, so no `--no-record` is passed.

`spawn` is used rather than `execFile` deliberately: `execFile` caps stdio at three pipes and cannot carry fd 3, which the event stream requires. The child's `stdio` is `["ignore", "pipe", "pipe", "pipe"]` (fd 3 wired for the event stream), `cwd` is the workdir, and the environment is minimal -- only `PATH`, `HOME`, `LANG`, `LC_ALL`, and `TZ` are forwarded from the server process, so the child inherits no ambient secret. The job's inputs reach the child through the workdir files, never the environment.

A bounded, sanitized tail of the child's stderr (up to 8192 UTF-16 code units, kept as a rolling tail) is retained for diagnostics; it is passed through the display sanitizer before it is surfaced and is never streamed to the client raw.

## Event relay over SSE

`GET /api/jobs/:jobId/events` streams the job's events as server-sent events. Each frame is:

```
id: <n>
data: <json>

```

The `id` line carries the event's monotonic id (so a browser `EventSource` echoes it as `Last-Event-ID` on reconnect), the `data` line the JSON event, terminated by the blank line that ends a frame.

**Full-history replay.** Every job retains its complete event list in memory for its lifetime. On connect, the stream replays every buffered event with an id strictly greater than the resume offset. The offset is the `Last-Event-ID` request header when present and a non-negative integer, else the `?lastEventId=` query fallback (for a client that cannot set the header), else `0` (replay from the start). A malformed value is treated as `0` rather than rejected, so a bad reconnect replays the full history instead of failing. Because the full history is retained, a reconnect resumes losslessly.

**Stream close.** After the terminal event (a `result` or an `error`) is delivered, the stream closes. When the terminal event is already in the replay (the job finished before this connect), the stream closes immediately after replaying rather than holding an idle connection open. A client disconnect (`request.signal` abort) releases the subscription.

### Relay validation at the trust boundary

The CLI is a separate workspace driven as a subprocess; the server does not import its event types. It re-validates every fd-3 line independently against the v1 vocabulary from [CLI_EVENTS.md](CLI_EVENTS.md) (`stages`, `stage`, `warning`, `result`, `error`), requiring `v === 1` and a known `type`. Every string field is re-sanitized -- recursively, through arrays and nested objects -- through the display escaper before the event is buffered or relayed, deliberate defense in depth at the trust-boundary crossing on top of the CLI's own construction-time sanitization. Because sanitization precedes serialization, the `\n` that frames an SSE line can only ever be the writer's own terminator.

Degradation is fail-safe, never a crash:

- A non-JSON line, or one outside the known schema, is surfaced as a synthesized `warning` event carrying `degraded: true` and dropped -- the relay continues.
- An oversized fd-3 line (the reader buffers up to 1,048,576 UTF-16 code units before discarding the partial line) is surfaced as a degradation warning and the partial buffer discarded.
- fd 3 being unavailable, or a read error on it, is surfaced as a degradation warning.

**Buffer cap.** The event buffer is capped at 10,000 entries (a runaway backstop; a real CLI stream is dozens of lines). On overflow the job is failed rather than dropping events silently: a synthesized `error` terminal is appended, the child is `SIGKILL`ed, and status becomes `failed`, so a supervisor never observes a truncated history.

## Exit-code reconciliation

The child's exit is classified from the exit code and signal, per the CLI's terminal contract ([CLI_EVENTS.md](CLI_EVENTS.md#terminal-event-guarantees)):

| Exit / signal | Outcome |
| ------------- | ------- |
| `0` | `succeeded` |
| `130` (SIGINT) or `143` (SIGTERM) | `cancelled` -- a signal exit legitimately carries no terminal fd-3 event, so this is not a broken stream. |
| death to `SIGINT`/`SIGTERM` | `cancelled` |
| any other exit, or death to another signal | `failed` (the exit code recorded) |

**Close-not-exit ordering.** The classifier fires on the child's `close` event, not `exit`. `close` fires only after every stdio stream has drained, so the CLI's own terminal fd-3 event is always parsed before the exit is classified. On `exit` the terminal line can still sit in the pipe buffer, and the manager would synthesize a misclassified terminal in its place. A spawn or process `error` classifies as `failed` (exit code recorded as 1) with a sanitized diagnostic, so a terminal state is always reached.

**Synthesized terminal events.** Whether the CLI emitted its own terminal event is the manager's concern. If it did, that stands. If it did not, the manager synthesizes one matching the exit so the supervisor is always guaranteed a terminal event:

- `cancelled`: a `cancelled`-flavored `error` terminal (`category: "exchange"`, `cancelled: true`, message naming SIGINT or SIGTERM).
- `succeeded` with no terminal event: a `result` terminal (`resultWritten: true`).
- any other exit with no terminal event: a `failed` terminal (`category: "exchange"`) noting the stream broke and, when known, the exit code.

## Cancellation escalation

`POST /api/jobs/:jobId/cancel` requests cancellation and returns `202` (idempotent -- `202` even for an already-terminal job). It delivers a signal escalation to the running child:

1. `SIGINT` immediately.
2. `SIGTERM` after a 5000 ms grace, if the child is still running.
3. `SIGKILL` after a further 5000 ms grace, if still running.

The escalation timers are cleared when the child exits, so a child that stops on `SIGINT` is never over-signaled; the timers are `unref`ed so they never hold the process open. The job's final `cancelled`/`failed` state reflects which signal took effect (a `SIGINT`-ignoring child that only stops on `SIGTERM` records exit `143`).

## Environment variables

| Variable | Semantics |
| -------- | --------- |
| `JOB_DATA_ROOT` | The feature gate and the data root. Empty or unset -> the API is disabled (every endpoint `404`, no manager constructed, no child spawned). Non-empty -> per-job workdirs are created under this resolved directory. Read with surrounding whitespace trimmed. |
| `JOB_API_TOKEN` | The bearer token. Non-empty -> every endpoint requires a matching `Authorization: Bearer` header (constant-time compared). Empty -> unauthenticated, permitted only on a loopback bind (see the startup rule). |
| `JOB_CLI_BINARY` | Overrides the CLI entry path the driver spawns. Unset -> the workspace-relative built entry (`apps/cli/dist/index.js`, resolved four levels up from the jobs module). Used by production overrides and by tests pointing the driver at a stub. It is set only server-side, never derived from a request. |

### Fail-closed startup rule

Before the server binds, if the API is enabled (`JOB_DATA_ROOT` set) and no token is configured (`JOB_API_TOKEN` empty) and the bind host is not loopback, startup is refused with a configuration error rather than exposing an unauthenticated CLI driver on a public interface. A bind host is loopback when it is `localhost`, `::1`/`[::1]`, or a `127.` address; an unset host (the default all-interfaces bind) is treated as non-loopback and fails closed rather than assuming loopback. A unix-socket bind is appliance-local and treated as loopback for this check. The safe configurations -- disabled, loopback, or token-protected -- start normally.

## Job lifetime and orphan handling

Job state lives in server memory only and is never persisted:

- **Restart empties the table.** In-memory job records do not survive a server restart; a restart cancels in-flight exchanges rather than persisting another party's material. After a restart, a stale job id `404`s (the record is gone), while the workdir of a completed job remains on disk until an explicit `DELETE`.
- **TTL eviction is memory-only.** One hour after a job reaches a terminal state, its in-memory record is evicted as a memory backstop. Eviction removes only the record (the id then `404`s); it leaves the workdir on disk. The eviction timer is `unref`ed and does not resurrect a record already removed by a `DELETE`.
- **DELETE removes the disk.** `DELETE /api/jobs/:jobId` is the only operation that removes the workdir. It `SIGKILL`s a still-running child first so the delete leaves no orphan, drops the record, and `rm -rf`s the workdir (idempotent).
- **Shutdown signals every child.** On server shutdown (`SIGINT`/`SIGTERM`), every running child is sent `SIGTERM` so no orphaned CLI outlives the server. The shutdown hook is registered before the graceful-shutdown handler (signal listeners run in registration order), so children are signaled before any handler that may end the process. It is a no-op when the API was never enabled.

## See also

- [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#single-party-appliance-trust-boundary) - the single-party-appliance trust invariant this API rests on
- [DEPLOYMENT.md](../DEPLOYMENT.md#server-job-api) - the operator-facing overview: what the feature is for and how to enable it
- [CLI_EVENTS.md](CLI_EVENTS.md) - the CLI's fd-3 event stream this API consumes and re-validates
- [PROTOCOL.md](PROTOCOL.md) - the exchange protocol that produces the events
