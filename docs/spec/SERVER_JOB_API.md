---
title: "Web Server Job API"
---

# Web server job API

This document specifies the web application's server-side job API: the HTTP endpoints through which a supervisor creates, observes, cancels, and deletes an exchange job that the Nitro server drives as a `psilink` CLI subprocess, the typed intent the client submits and the validation that makes it injection-closed, the operator-provisioned SFTP remotes table and its validation, the operator-mounted work-input directory and its listing/profile/coverage surface, the on-disk workdir layout and modes, the SSE event relay and its full-history replay, the exit-code reconciliation and cancellation escalation, the environment variables that gate and configure the feature, and the memory-only job lifetime. It is the spec-tier complement to the operator-facing overview in [DEPLOYMENT.md](../DEPLOYMENT.md#server-job-api), which says what the feature is for and how to turn it on; this document says how each request, file, and event is constructed. It consumes -- and re-validates at the trust boundary -- the CLI's fd-3 event stream specified in [CLI_EVENTS.md](CLI_EVENTS.md); it does not respecify that stream's construction (see there). It does not cover the exchange protocol that produces the events (see [PROTOCOL.md](PROTOCOL.md)) or the display-sanitization escape format the fields reuse (see [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#display-sanitization-escape-format)). Intended readers are implementors writing a supervisor against this API and security auditors.

The job API exists for the console-appliance deployment: a container serving one party, inside that party's trust boundary, that drives the party's own `psilink exchange` runs without the operator invoking the CLI by hand. It is not a shared rendezvous between parties; the trust invariant it rests on and what would violate it are in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#single-party-appliance-trust-boundary). The API is off unless a data root is configured, and its whole design -- server-composed CLI inputs, memory-only state, loopback-or-token auth -- is calibrated to that single-operator posture.

## Feature gate and authentication

The API is dark by default. Every endpoint resolves a gate before any filesystem access or subprocess spawn, in a fixed order:

1. **Feature gate.** If no data root is configured (`JOB_DATA_ROOT` unset or empty), the endpoint answers `404` and consults nothing further -- indistinguishable from an unknown route to a hosted probe, so the API's presence is not observable to an unauthenticated caller.
2. **Bearer token.** If a token is configured (`JOB_API_TOKEN` non-empty), the request must present `Authorization: Bearer <token>`. A missing or non-matching bearer is `401`. The comparison is constant-time (both sides hashed with SHA-256 and compared with `timingSafeEqual`, never short-circuiting on length), so the token is not recoverable through response timing. When no token is configured, the gate allows the request (the loopback appliance case; see the startup rule below).

Every job response carries `Cache-Control: no-store` and no CORS headers -- the API is same-origin appliance-local, so a cross-origin caller is never granted access. These are additive to the defense-in-depth response headers the server entry already applies globally (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security)).

## Endpoints

| Method | Path | Success | Notes |
| ------ | ---- | ------- | ----- |
| `POST` | `/api/jobs` | `201` `{ "id": "<uuid>" }` | Create and start a job from a JSON intent. `413` (empty body) when the body exceeds the size cap (see [Size caps](#size-caps)). `400` on unparseable body, intent that fails schema validation, or an sftp intent naming an unknown remote (empty body, resolved before any workdir exists). `409` (empty body) when the named remote is held by a running job. |
| `GET` | `/api/jobs` | `200` `{ "jobs": [...] }` | List every job: live in-memory records and restart-restored jobs re-discovered from disk artifacts, deduped by id (the in-memory record wins). Each entry is `{ id, status, restored, resultAvailable, recordAvailable, recordCreatedAt? }`. See [Job lifetime and orphan handling](#job-lifetime-and-orphan-handling). |
| `GET` | `/api/jobs/:jobId` | `200` status JSON | `404` on malformed or unknown id. A restart-restored job is served read-only from its disk artifacts. |
| `DELETE` | `/api/jobs/:jobId` | `204` | Kills a still-running child, drops the record, removes the workdir. For a restart-restored job (no in-memory record) it removes the disk-only workdir. `404` when neither a record nor a workdir exists. |
| `GET` | `/api/jobs/:jobId/events` | `200` `text/event-stream` | SSE event relay with full-history replay. `404` on unknown id. |
| `POST` | `/api/jobs/:jobId/cancel` | `202` | Request cancellation; idempotent (`202` even if already terminal). `404` on unknown id. |
| `GET` | `/api/jobs/:jobId/result` | `200` `text/csv` | The matched-result CSV, only after the job succeeded. `404` otherwise. |
| `GET` | `/api/jobs/:jobId/record` | `200` `application/json` | The self-attested exchange record, only after the job succeeded. `404` otherwise. |
| `GET` | `/api/jobs/:jobId/keys` | `200` `application/json` | The private verification keys paired with the record, only after the job succeeded. `404` otherwise. |
| `GET` | `/api/jobs/remotes` | `200` JSON array | The operator-provisioned SFTP remotes as a credential-free projection; `[]` when none are configured. See [SFTP remotes](#sftp-remotes). |
| `GET` | `/api/jobs/inputs` | `200` listing JSON | The operator-mounted input CSVs the server may read. `configured: false` with an empty list when `JOB_INPUT_DIR` is unset. See [Work-input files](#work-input-files). |
| `GET` | `/api/jobs/inputs/profile` | `200` profile JSON | A single-pass profile of one named input (columns, row count, inferred date format, bounded samples). `404` when the directory is unconfigured or the name is unknown, `400` on an unusable file, `429` when the parse gate is full. |
| `POST` | `/api/jobs/inputs/coverage` | `200` `{ "rates": [...] }` | Per-field non-empty coverage over one named input under a submitted standardization. `413` (body over 1 MiB), `400` (bad body, schema failure, or size/mtime drift), `404` (unconfigured or unknown name), `429` (parse gate full). |

Auth applies to every endpoint uniformly: a disabled API is `404` and a bad bearer is `401` on all of them, resolved before the id is even parsed.

### Job id and the traversal guard

The job id is a server-generated v4 UUID; the client never supplies it. Every id-bearing endpoint validates the parameter against the exact canonical v4 UUID pattern before any filesystem use, and a value that is not a canonical v4 UUID (a traversal payload, an absolute path, an empty string) is `404` without touching disk. Resolving a workdir applies a second, defense-in-depth check: the id is joined to the resolved data root and the result confirmed to stay strictly under `<dataRoot>/`, so even a validated id that resolved outside the root is refused. An unknown-but-well-formed id (never created, or TTL-evicted) is `404` identically, so id validity is not distinguishable from job existence.

### The `GET /api/jobs/:jobId` status body

```json
{
  "id": "<uuid>",
  "status": "running" | "succeeded" | "failed" | "cancelled",
  "restored": <bool>,
  "terminal": { "outcome": "...", "exitCode": <int|null>, "signal": "<sig|null>" } | null,
  "terminalEmitted": <bool>,
  "eventCount": <int>,
  "resultAvailable": <bool>,
  "recordAvailable": <bool>,
  "recordCreatedAt": "<iso-8601>"   // present only when recordAvailable is true
}
```

`terminal` is null until the child exits; `resultAvailable` is true exactly when `status` is `succeeded`. `recordAvailable` is true only when the job succeeded, both the record and its verification-keys file are on disk, and the record validates and yields a `createdAt`; the record pair is offered all-or-nothing. `recordCreatedAt` is the record's own timestamp, present exactly when `recordAvailable` is true -- a client derives the download filename from it, matching the in-browser exchange path. Because the CLI's record write is non-fatal (a disk failure after a successful exchange is warned, not thrown), a job can be `resultAvailable: true` with `recordAvailable: false`.

`restored` is true when the view was reconstructed from disk artifacts rather than an in-memory record -- after a restart, or after the in-memory record's TTL eviction on a still-running server (see [Job lifetime and orphan handling](#job-lifetime-and-orphan-handling)). A restored job carries no event history, so `terminal` is `null`, `terminalEmitted` is `true`, and `eventCount` is `0`; its `status` is derived purely from artifacts (`succeeded` when the result file or the exchange record is present, else `failed`). Because the disk carries no cancellation marker, a job that was `cancelled` before the restart restores as `failed`.

### The `GET /api/jobs/:jobId/result` response

Served only when `status === "succeeded"` and the output file exists and is readable; any other case (unfinished, failed, cancelled, or missing file) is `404` rather than leaking whether an unfinished job exists. The body is the job's server-chosen output file inside its workdir -- never a client-named path. Headers: `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="result-<id>.csv"` (a fixed, server-derived download name), and `X-Content-Type-Options: nosniff`, plus the `no-store` discipline.

### The `GET /api/jobs/:jobId/record` and `/api/jobs/:jobId/keys` responses

Served under the same gate as the result response -- only when `status === "succeeded"` and the respective file (`record.json`, `record.keys.json`) exists and is readable, `404` otherwise. The bodies are the job's server-chosen record and keys files inside its workdir, never a client-named path. Headers: `Content-Type: application/json; charset=utf-8`, a fixed `Content-Disposition: attachment; filename="psilink-record.json"` / `"psilink-record.keys.json"` (a server-side fallback; the browser's save name is set by its download control and carries the record's timestamp), and `X-Content-Type-Options: nosniff`, plus the `no-store` discipline. A client offers these two downloads only when `recordAvailable` on the status route is true, so it never links a `404`. The verification keys are private material -- a salt plus the record's commitment can open a committed value -- so `/keys` is gated and `no-store` identically to `/record` and `/result`; see [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md).

## The exchange intent

`POST /api/jobs` accepts a JSON body validated against a strict schema, discriminated on `channel`. The intent is the only channel from the client into a CLI invocation, and it is injection-closed by construction: no field becomes an argv string, a filesystem path, a host, or a credential reference. On the sftp arm, connection material is drawn exclusively from the server-side remotes table (see [SFTP remotes](#sftp-remotes)); the client contributes a lookup name only.

| Field | Type / validation | Why it cannot inject |
| ----- | ----------------- | -------------------- |
| `channel` | `"filedrop"` or `"sftp"` | The closed discriminant. A filedrop exchange has no host and no credential field at all, so the connection block the server composes carries nothing injectable. An sftp exchange draws every piece of connection material from the operator-provisioned remotes table; the intent's only sftp-specific field is `remote`. A `webrtc` or other value is rejected as unknown. |
| `remote` | sftp arm only; matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` | An opaque name compared by exact string equality (a `Map` lookup) against the remotes table -- never interpolated into a path, host, argv fragment, YAML document, or response body. An unknown name is an empty-bodied `400`, resolved before any workdir exists. On the filedrop arm the field is rejected as an unknown key. |
| `linkageTerms` | core's `LinkageTermsSchema` | Bounded partner-authored vocabulary (field names, key elements, transforms). It carries no filesystem path, host, or command field, so a hostile value cannot escape into argv or the filesystem. |
| `sharedSecret` | base64url 32-byte pattern (`/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/`) | Credential material matching the CLI key-file shape. It is written into a fixed-name key file, never used as a path or argv fragment; a malformed secret is rejected here rather than crashing the child at load. |
| `inputCsv` | non-empty string, length-capped | CONTENT written to a fixed, server-chosen filename in the workdir. The client never names a file. The cap is anchored to the browser intake's own 100 MiB file-size gate, so a CSV that passed that gate is never rejected here (see [Size caps](#size-caps)). |
| `metadata` | optional; core's `MetadataSchema` | The operator's per-party column metadata (each column's name, semantic type, role, and payload flag). Structured data written into the config as YAML values, never an argv fragment, path, host, or credential. Carried so the CLI honors the operator's disclosure edits (which columns are sent vs ignored) instead of inferring metadata from the column names. |
| `standardization` | optional; core's `StandardizationSchema` | The operator's per-party standardization pipeline (per-field transform steps). Structured data written into the config as YAML values, never an argv fragment, path, host, or credential. |
| `expectedPayloadColumns` | optional `string[]` | The acceptor's received-payload lock-in: the partner-namespace column names it will enforce it receives, mirrored from the invitation's disclosed set. Column names only, never a path, host, or credential. An empty array is a strict "receive nothing" (a non-empty partner payload then aborts); an omitted field reconciles lazily. Set on the acceptor path only; the inviter omits it. |
| `options` | numeric/boolean/enum subset (below) | Every field is a number, boolean, or closed enum -- none can carry a path, host, credential, or command. |
| `eventStream` | optional boolean (default true) | Whether `--event-stream` is passed. |

Both arms are `.strict()`: an unknown key (a smuggled `path`, `host`, `server` block, or `@path` credential reference) fails validation, and each arm admits only its own fields. The `options` subset is deliberately the numeric/boolean/enum knobs only -- `pollIntervalMs`, `peerTimeoutMs`, `serverConnectTimeoutMs`, `maxReconnectAttempts` (0..604800), `timestampInFilename`, `locklessRendezvous`, `retainFiles`, and `unexpectedFiles` (`error`/`warn`/`ignore`). The path and directory fields of the CLI's file-sync options are intentionally not surfaced (the server owns every directory), and the free-text `peerId` is omitted for the same reason. On the sftp arm `pollIntervalMs` is additionally floored at 1000 ms: an sftp poll is a directory listing against the operator's provisioned remote server, not a job-local directory, so a client-chosen hot poll would flood a shared -- possibly partner-hosted -- host.

The `metadata` and `standardization` fields are validated structured data -- core's `MetadataSchema` and `StandardizationSchema`, respectively -- and carry no injectable field. Core bounds each column `name` and closes `role`/`type` to enums; the arrays and the free-text `description`, `output`, and `input` are additionally bounded web-side at this boundary (see [Size caps](#size-caps)). A standardization step's `params` is a `Record<string, unknown>`, unbounded by nature and left uncapped at the field level -- the boundary body cap is its backstop. The linear-time regex-dialect gate (`docs/spec/PROTOCOL.md`, "Transform regular-expression dialect") -- which caps and dialect-checks transform-pattern sources -- applies to the negotiated `linkageTerms` transforms, not to the standardization pipeline's raw-pattern steps. That is a compile/size cost, not a ReDoS hole: every standardization raw-pattern step still compiles and runs under core's linear-time RE2 engine (RE2JS), so it cannot backtrack catastrophically. It remains a resource bound, not an injection escape: no metadata or standardization value becomes an argv fragment, a path, a host, or a credential.

### Size caps

The intent is operator-authored, never partner-supplied, and the API is feature-gated and loopback-or-token gated, so the worst case an oversized intent reaches is a single operator exhausting their own appliance's memory -- not a remote surface. Two defense-in-depth layers bound it anyway, so neither the request nor a persisted artifact can grow without limit:

- **Boundary body cap.** `POST /api/jobs` reads its body under a hard byte cap (224 MiB), streamed off the request and counted chunk by chunk; the read aborts the moment the running total exceeds the cap, and `Content-Length` is never trusted (it can be absent or understated on a chunked request). An oversized body is a `413` before the body is fully buffered or any schema parse runs. The cap sits well above the JSON-encoded size of a realistic schema-valid intent -- real CSV text barely grows under JSON string escaping -- so a legitimate intent reaches a clean schema error rather than a boundary `413`. It is deliberately not sized to clear a pathological payload built from control characters that each escape to a 6-byte `\uXXXX` sequence (not valid CSV), nor an unbounded standardization `params`; bounding those here is exactly the memory guard's job.
- **Schema caps.** The intent schema bounds `inputCsv` (anchored to the browser intake's 100 MiB file gate), the `expectedPayloadColumns` array and its entries, the `metadata` array and each `description`, and the `standardization` array, each transformation's `steps`, and its `output`/`input`. The bounds are deliberately generous -- far above any legitimate intent -- and apply to both channel arms. They are enforced web-side at this boundary rather than in core's shared schemas, so partner-facing validation elsewhere is unchanged.

The `expectedPayloadColumns` field is a list of partner-namespace column names -- no path, host, or credential -- validated as a string array. Its empty-vs-absent distinction is preserved end to end (an empty array is forwarded verbatim as a strict lock-in; only an omitted field stays lazy); see the composed-config note below.

### Composed CLI configuration

From a validated filedrop intent the server composes the CLI config document (snake_case YAML the CLI loads verbatim) through core's `mintExchangeFile`, so the assembled spec is validated by the CLI's own schema before it is written. The composition is fixed:

- The connection is a credential-free `filedrop` locator whose one path field is set to the server-chosen `exchange` subdirectory of the workdir -- not to any client value. By core's `ExchangeFileInput` typing no credential is representable in a filedrop connection.
- No `authentication` block is ever assembled; the shared secret rides the separate key file.
- The intent's `linkageTerms` reach the document only after core's schema validation.
- The intent's `metadata` and `standardization`, when present, are attached as the config's `metadata` and `standardization` blocks (omitted when absent). Carrying them is what makes the operator's data-prep edits authoritative on this path: the CLI's `prepareForExchange` uses the composed metadata instead of falling back to `inferMetadata`, which would default an unrecognized column to disclosed payload and could silently disclose a column the operator marked ignored.
- The intent's `expectedPayloadColumns`, when present, is attached as the config's `expected_payload_columns` (an empty array is attached verbatim; only an omitted field is left off). Carrying it makes the acceptor's received-payload lock-in explicit: the CLI prefers `expected_payload_columns` over the `linkageTerms.payload.receive` fallback, which is undefined for a token that discloses columns but carries no `payload.send` -- a shape where the fallback would fail open (silently ingesting extra partner columns) while the browser acceptor aborts. The inviter path omits it.
- The tuning `options`, if any were set, are narrowed to the CLI's file-sync options and attached; when none were set the block is omitted entirely.

An sftp intent is composed differently. `mintExchangeFile`'s input type deliberately cannot represent a credential -- an invariant shared with the browser's exchange-file minting that must not be widened -- so the server assembles the exchange spec directly: the connection's `server` block is the resolved remotes-table entry verbatim (its `@path` credential references land in the YAML as references, resolved only by the CLI child), the client's `linkageTerms`, `metadata`, `standardization`, `expectedPayloadColumns`, and tuning options attach exactly as on the filedrop path, and the assembled spec is validated through core's exchange-spec schema before serialization, with only the schema's own fields reaching the YAML. The remote NAME appears nowhere in the document. No `authentication` block is assembled on either path.

The key file body is `{"sharedSecret":"<value>"}` with no `expires` stamped, so a server-driven job carries no invitation-token lifetime of its own.

## SFTP remotes

An sftp job's connection material never comes from the client; it comes from a table the operator provisions at deploy time. `JOB_SFTP_REMOTES` names a YAML file (mounted read-only in the container case) of shape:

```yaml
remotes:
  partner-agency:
    host: sftp.partner.example
    port: 22
    username: psilink
    password: "@/run/secrets/partner-sftp-password"
    path: /exchange/psilink
    host_key_fingerprint: "SHA256:..."
```

The file is read and validated once at server startup, fail-closed: any invalid entry refuses startup with an error naming the offending field path (never a value), the same posture as the loopback-or-token rule. Setting `JOB_SFTP_REMOTES` without `JOB_DATA_ROOT` is itself a startup error. The variable is set only server-side, never derived from a request.

The validation rules, each load-bearing:

- **Names.** A remote name matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` and is kept verbatim -- top-level name keys are never case-folded or camelized, so `prod_east` and `prodEast` are distinct and cannot alias or collide. The intent's `remote` field is matched against names by exact string equality only.
- **Strict field allowlist.** An entry admits exactly `host`, `port`, `username`, `path`, `password`, `private_key`, `private_key_passphrase`, `keyboard_interactive`, and `host_key_fingerprint`; any other key is a startup error. This is deliberately stricter than the CLI's connection schema, which is non-strict and admits blocks the appliance must never carry: `provision` (whose auth block holds inline HTTP credentials and drives pre-connect egress) and the split `inbound_path`/`outbound_path` pair (which couples to the client-owned retain tuning). Strictness also turns a typo into a startup error instead of a silently dropped field.
- **Mandatory literal pin.** `host_key_fingerprint` is required (a string or a list) and every element must be a literal OpenSSH SHA256 fingerprint; an `@path` reference is rejected. The job child is non-interactive (stdin ignored), so first-use trust can never happen there; requiring the pin turns what would be a first-job failure into a boot-time error and makes every appliance SFTP connection host-key-pinned, verified before authentication. A host-key rotation is staged by listing the old and new fingerprints together.
- **Credential references only.** `password`, `private_key`, and `private_key_passphrase`, when present, must be `@path` references to an ABSOLUTE path OUTSIDE the resolved data root, and the referenced file must exist at load time (checked by `stat` only; the bytes are never read into the server). Inline values are rejected, so no secret enters server memory or any composed job file; the CLI child resolves the reference at config load. The data-root exclusion closes a laundering path: workdir contents are client-written, so a reference under the data root could turn client content -- or a past job's result -- into a transmitted credential.
- **Boot-time composition check.** Each entry is additionally parsed through core's connection schema as `{channel: "sftp", server: <entry>}`, so the CLI's cross-field refines (one primary auth method, a passphrase requires a key, keyboard-interactive requires a password, canonical fingerprint form) hold at startup rather than first inside a job.

The table is startup-frozen: changing hosts, names, or pins requires a restart. The referenced credential FILES are live -- the CLI child re-reads them at each job's config load -- so rotating a secret in place takes effect without one.

**One running job per remote.** Unlike filedrop, whose rendezvous is a fresh per-job directory, every job against a remote shares that remote's directory. A second sftp job naming a remote held by a running job is refused with an empty-bodied `409`; the hold is released when the holding job reaches a terminal state or is deleted.

### `GET /api/jobs/remotes`

Returns the provisioned remotes as an explicitly mapped, credential-free projection -- `[{ "name": "...", "host": "...", "port"?: <int>, "path"?: "..." }]` and nothing else: no username, no credential references (which would reveal the secret-mount filesystem layout), no fingerprints. An enabled API with no remotes configured serves `200 []` (a `404` would be indistinguishable from the disabled-API gate). The console web build uses this to offer the remote picker and to author an invitation's sftp endpoint from the picked remote's locator. The static `remotes` segment cannot be captured as a job id: ids are validated as canonical v4 UUIDs before any use, which `remotes` is not.

## Work-input files

The console appliance reads its input CSVs from one operator-mounted directory
rather than accepting them uploaded through the browser. `JOB_INPUT_DIR` names that
directory; the server lists it, profiles a chosen file, and computes coverage over
it, all as streaming passes that retain no rows. This surface is off unless
`JOB_INPUT_DIR` is set, and -- like every job route -- dark unless `JOB_DATA_ROOT`
enables the API at all.

### Startup resolution and containment

`JOB_INPUT_DIR` is resolved once at startup with `fs.realpathSync`, fail-closed
like the remotes table:

- A configured directory that does not exist, or is not a directory, refuses
  startup.
- `JOB_INPUT_DIR` set without `JOB_DATA_ROOT` refuses startup -- the directory
  serves only the job API, which the data root enables, exactly the
  `JOB_SFTP_REMOTES` rule. Because neither variable is ever baked into the image,
  the two provisioning vars behave identically.
- Mutual containment with the resolved data root refuses startup: the input
  directory must not equal, contain, or be contained by `JOB_DATA_ROOT`. Otherwise
  the listing could expose job workdirs, or a job could be fed its own artifacts or
  another job's key material. When the data root does not yet exist at boot, its
  side of the comparison is lexical (`path.resolve`, no symlink resolution), so a
  `JOB_DATA_ROOT` routed through a symlinked intermediate component is on the
  operator -- the same disjoint-mounts model as the boot-time realpath caveat
  below.

After the checks pass, the server logs one boot-diagnostic line -- the resolved
realpath, the total `readdir` entry count, and the admissible file count -- so an
operator who mounted the wrong host path, or whose entries are all filtered out,
sees it at boot without touching the API.

`O_NOFOLLOW` (below) protects only the final path component, and the root's
realpath is resolved once at boot. A post-boot remount, or replacement of an
intermediate path component, is out of model for the single-party appliance.

### Listing and admission

The listing is the ONLY source of truth for admissible names. `GET
/api/jobs/inputs` returns:

```json
{
  "configured": <bool>,
  "totalEntries": <int>,
  "truncated": <bool>,
  "files": [{ "name": "<segment>", "sizeBytes": <int>, "modifiedAt": <int> }]
}
```

`configured` is `false` (with an empty list) when `JOB_INPUT_DIR` is unset -- a
state reachable only when the job API itself is enabled -- so the console UI can
render an actionable "set `JOB_INPUT_DIR` and mount a directory" state rather than a
mysteriously empty list. `totalEntries` is the raw `readdir` count BEFORE admission,
so the UI can tell an empty directory from one whose entries are all inadmissible.
`modifiedAt` is integer epoch milliseconds everywhere.

Admission, applied to a non-recursive `readdir` of the resolved root:

- **Name shape.** A single path segment: no `/`, `\`, or NUL; not `.` or `..`; no
  leading dot (so a `.psilink.key`-shaped file is excluded by construction); no
  control characters; length 1..255.
- **Regular files only.** `lstat` must report a regular file. A symlink's `lstat`
  is a symlink, so `isFile()` is false and it is never admitted -- a symlink in the
  input directory pointing at `/run/secrets/...` or the data root is neither
  listable nor readable.
- **Deterministic cap.** Admitted entries are sorted by name BEFORE the 512-entry
  cap, so truncation (`truncated: true`) is deterministic across `readdir`
  orderings.

There is no `.csv` extension filter (the profile parse is the real gate; operators
name files unpredictably) and NO total-size cap: mounted inputs are the CLI-scale
files the CLI is specced for (millions of rows, gigabytes). Memory stays flat
because every reader streams; time scales linearly and is governed by the
one-parse-at-a-time gate. `MAX_CSV_FILE_BYTES` is the hosted browser-upload bound
and does not apply here.

### By-name admission and the open recipe

Every by-name operation (profile, coverage) re-runs the listing and requires the
requested name to match an admitted entry by exact string equality -- the
remotes-table `Map.get` discipline. The server only ever opens names it itself
enumerated, so a crafted name never reaches `path.join`. To read, it then:

1. `open(join(root, name), O_RDONLY | O_NOFOLLOW)`.
2. `fstat` the descriptor and require `(dev, ino)` to equal the admission `lstat`.

`O_NOFOLLOW` closes the symlink-swap window on the final component; the `(dev, ino)`
recheck closes the file-swap window between the admission `lstat` and the open. The
open-time `fstat` size/mtime are what the profile reports and what coverage compares
for drift. Failures never echo the requested name: an unset directory, an unknown
name, or an open-time race indistinguishable from one -- the `O_NOFOLLOW` `ELOOP` on
a symlink swapped in after the admission `lstat`, an `ENOENT` on a vanished file, or
an `EACCES` on one made unreadable -- is an empty-bodied `404`; an unusable file
(parse error, ceiling trip) a `400`.

### Profile

`GET /api/jobs/inputs/profile?name=...` returns, in ONE streaming constant-memory
pass:

```json
{
  "name": "<segment>",
  "sizeBytes": <int>,
  "modifiedAt": <int>,
  "rowCount": <int>,
  "columns": ["..."],
  "dateInputFormat": "<format>",
  "columnSamples": { "<column>": ["..."] }
}
```

- `columns` from the header; `rowCount` by counting.
- `dateInputFormat` (omitted when there is no date-of-birth column or the sample
  yields no signal) via the shared core composition: the DOB column is picked by
  `inferMetadata`, its first `INFER_DATE_SCAN_CAP` (1000) non-empty values are
  sampled, and `inferDateFormat` runs over the sample. The bound is exact -- that
  cap is where `inferDateFormat` stops its own scan -- so the profiled format
  equals a full-column read, the same cap-exactness the CLI's `init` relies on.
- `columnSamples` is the first `PREVIEW_SAMPLE_SIZE` (5) non-empty values per column
  in row order, the same `sampleInputValues` semantics the browser preview uses.

`sizeBytes`/`modifiedAt` are the open-time `fstat` values the client keeps for the
authoring-time drift signal.

### Coverage

`POST /api/jobs/inputs/coverage` with body `{ name, sizeBytes, modifiedAt,
standardization }` returns `{ "rates": FieldValueCoverage[] }` from one streaming
sweep of the named file under the submitted standardization. The `standardization`
is validated through the SAME bounded schema the job intent uses (the transformation
and step counts, and the output/input name lengths) PLUS a route-level per-step
pattern/delimiter source length cap reusing `MAX_TRANSFORM_PATTERN_LENGTH`. The
intent-level schema bounds counts, not pattern length, and while RE2JS execution is
linear-time, its compile cost lands on this process's event loop before any row
streams -- so this in-process endpoint caps the source length; the shared intent
schema (and the job-create path) is unchanged.

The body is read through `readJobRequestBody` under a 1 MiB cap. The submitted
`sizeBytes`/`modifiedAt` are the client's profiled snapshot: the server's open-time
`fstat` size/mtime must equal that pair, else the coverage is refused as drifted
(empty-bodied `400`) -- coverage is never silently computed over content that
changed since profiling.

### Resource posture and the in-process tradeoff

- **No cache.** The profile is one streaming pass per request; coverage is a
  streaming recompute per request. The memory ceiling is flat regardless of file
  size, and no parsed PII rests in server memory between requests.
- **One at a time.** A single-flight gate serializes all parse/sweep work across
  the profile and coverage routes (the single-operator appliance bound doing double
  duty as the memory bound). A second request waits in a depth-one queue; a third
  is refused `429`, which the client treats like a superseded response. The stream
  yields between chunks, so a worst-case event-loop stall is one chunk's pipeline
  work, not the whole file.
- **In-process pipeline execution.** The coverage sweep runs client-supplied
  standardization pipelines in the web-server process, whereas the existing homes of
  that computation are the operator's own browser and the CLI child process. The
  pipelines are count-bounded, pattern-length-capped at this endpoint, and
  linear-regex-compiled (RE2JS -- no backtracking): this is a resource bound, not a
  ReDoS hole, and no metadata or standardization value becomes an argv fragment, a
  path, a host, or a credential.

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

An sftp job's workdir has the same layout; its `exchange/` directory is created but unused (the rendezvous is the remote's own directory), and its `psilink.yaml` carries the remote entry's connection block -- locator, pinned fingerprint, and `@path` credential references, never a credential value.

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
| `JOB_SFTP_REMOTES` | The SFTP remotes table (see [SFTP remotes](#sftp-remotes)). Empty or unset -> every sftp intent is rejected; the API is otherwise unchanged. Non-empty -> the named YAML file is loaded and validated at startup, fail-closed. Requires `JOB_DATA_ROOT`; set only server-side, never derived from a request. |
| `JOB_INPUT_DIR` | The one directory the server may list and read input CSVs from (see [Work-input files](#work-input-files)). Empty or unset -> the input-file feature is off (the listing is `configured: false`, profile/coverage `404`); the API is otherwise unchanged. Non-empty -> the directory is `realpath`-resolved and containment-checked at startup, fail-closed. Requires `JOB_DATA_ROOT`; set only server-side, never derived from a request, never baked into the image. |

### Fail-closed startup rule

Before the server binds, if the API is enabled (`JOB_DATA_ROOT` set) and no token is configured (`JOB_API_TOKEN` empty) and the bind host is not loopback, startup is refused with a configuration error rather than exposing an unauthenticated CLI driver on a public interface. A bind host is loopback when it is `localhost`, `::1`/`[::1]`, or a `127.` address; an unset host (the default all-interfaces bind) is treated as non-loopback and fails closed rather than assuming loopback. A unix-socket bind is appliance-local and treated as loopback for this check. The safe configurations -- disabled, loopback, or token-protected -- start normally.

The same posture covers the remotes table: a configured `JOB_SFTP_REMOTES` that is unreadable or invalid, or one configured without `JOB_DATA_ROOT`, refuses startup. It covers the work-input directory too: a configured `JOB_INPUT_DIR` that does not resolve to a directory, is set without `JOB_DATA_ROOT`, or overlaps the resolved data root (mutual containment) refuses startup (see [Work-input files](#work-input-files)). The loopback requirement is a startup bind invariant, not a per-request check.

## Job lifetime and orphan handling

Job state lives in server memory only and is never persisted:

- **Restart empties the table; completed results are re-discoverable read-only.** The in-memory table -- running state, the terminal reconciliation, and the full event history -- does not survive a server restart, and no in-flight exchange is resumed or persisted (a restart cancels it rather than persisting another party's material). What does survive is the on-disk workdir of a completed job, and after a restart the API re-discovers those workdirs and re-surfaces each completed job read-only. Discovery reads the data root and admits an entry only when it is a real directory (a symlinked directory is not followed out of the root), its name is a canonical v4 UUID, and it resolves strictly under the resolved data root -- the same traversal guard the live routes apply. For each admitted id the restored view is derived purely from the output artifacts: `status` is `succeeded` when `output.csv` or `record.json` is present (a party whose terms give it no result of its own still writes the record on success) else `failed`, and `recordAvailable`/`recordCreatedAt` follow the same all-or-nothing rule as the live status body (`record.json` and `record.keys.json` both present and the record's `createdAt` parses). Restore reads only these output artifacts and their existence; it never reads or serves the key file (`.psilink.key`) or the connection config (`psilink.yaml`), so no shared secret or connection material re-enters server state. A restored job's `GET`, `result`, `record`, `keys`, and `DELETE` behave as a live job's do; there is no cancel and no event replay (`eventCount` is `0`, the SSE stream has no history to replay), and it is never re-run. An interrupted job (a workdir with neither a result nor a record) surfaces as `failed`/terminated, never `running` and never resumable.
- **TTL eviction is memory-only.** One hour after a job reaches a terminal state, its in-memory record is evicted as a memory backstop. Eviction removes only the record; it leaves the workdir on disk, so a completed job then resolves read-only as a restored job (served from disk until an explicit `DELETE`) rather than `404`ing, with its event history gone. The eviction timer is `unref`ed and does not resurrect a record already removed by a `DELETE`.
- **DELETE removes the disk.** `DELETE /api/jobs/:jobId` is the only operation that removes the workdir. It `SIGKILL`s a still-running child first so the delete leaves no orphan, drops the record, and `rm -rf`s the workdir (idempotent).
- **Terminal states release the remote.** An sftp job's per-remote hold (see [SFTP remotes](#sftp-remotes)) is released when the job reaches a terminal state or is deleted; a restart empties the holds with the rest of the in-memory state.
- **Shutdown signals every child.** On server shutdown (`SIGINT`/`SIGTERM`), every running child is sent `SIGTERM` so no orphaned CLI outlives the server. The shutdown hook is registered before the graceful-shutdown handler (signal listeners run in registration order), so children are signaled before any handler that may end the process. It is a no-op when the API was never enabled.

## See also

- [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#single-party-appliance-trust-boundary) - the single-party-appliance trust invariant this API rests on
- [DEPLOYMENT.md](../DEPLOYMENT.md#server-job-api) - the operator-facing overview: what the feature is for and how to enable it
- [CLI_EVENTS.md](CLI_EVENTS.md) - the CLI's fd-3 event stream this API consumes and re-validates
- [PROTOCOL.md](PROTOCOL.md) - the exchange protocol that produces the events
