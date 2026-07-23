---
title: "Web Server Job API"
---

# Web server job API

This document specifies the web application's server-side job API: the HTTP endpoints through which a supervisor creates, observes, cancels, and deletes a job -- an ordinary exchange or a zero-setup exchange -- that the Nitro server drives as a `psilink` CLI subprocess, the two typed job-create intents the client submits and the validation that makes both injection-closed, the SFTP connection (authored in-app through a separate endpoint) and its validation, the secrets-mount browse contract, the on-disk workdir layout and modes, the SSE event relay and its full-history replay, the exit-code reconciliation and cancellation escalation, the environment variables that gate and configure the feature, and the memory-only job lifetime. It is the spec-tier complement to the operator-facing overview in [DEPLOYMENT.md](../DEPLOYMENT.md#server-job-api), which says what the feature is for and how to turn it on; this document says how each request, file, and event is constructed. It consumes -- and re-validates at the trust boundary -- the CLI's fd-3 event stream specified in [CLI_EVENTS.md](CLI_EVENTS.md); it does not respecify that stream's construction (see there). It does not cover the exchange protocol that produces the events (see [PROTOCOL.md](PROTOCOL.md)) or the display-sanitization escape format the fields reuse (see [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#display-sanitization-escape-format)). Intended readers are implementors writing a supervisor against this API and security auditors.

The job API exists for the console-appliance deployment: a container serving one party, inside that party's trust boundary, that drives the party's own `psilink exchange` runs without the operator invoking the CLI by hand. It is not a shared rendezvous between parties; the trust invariant it rests on and what would violate it are in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#single-party-appliance-trust-boundary). The API is enabled only in a `console` deployment build with a data root configured -- a hosted build serves every route disabled (`404`) whatever the data root, so the public deployment can never run the server-side driver -- and its whole design -- server-composed CLI inputs, memory-only state, no per-request authentication -- is calibrated to that single-operator posture; the deployment reaches it only from the operator's own machine by publishing the container port to host loopback. The console facilitates a single exchange at a time, and this API holds at most one: while an exchange occupies the slot a second create is refused until the current exchange is deleted, and a restart forgets it (there is no job listing and no restore).

## Feature gate

The API is dark by default. Enablement requires two conditions together: a `console` deployment build (`VITE_DEPLOYMENT_PROFILE=console`, the one signal read the same way server-side as the client reads it) AND a data root configured (`JOB_DATA_ROOT` non-empty). Every endpoint resolves this feature gate before any filesystem access or subprocess spawn: if either condition is unmet -- a hosted build (any non-`console` profile, unset included) or no data root -- the endpoint answers `404` and consults nothing further, indistinguishable from an unknown route to a hosted probe, so the API's presence is not observable to a caller. Gating on the deployment profile is the app-layer defense-in-depth backstop that keeps the hosted build from ever serving the routes even when built with `JOB_DATA_ROOT` set. There is no per-request authentication: the deployment publishes the container port to host loopback (see the reachability rule below), so its only reachable caller is the local operator.

Every job response carries `Cache-Control: no-store` and no CORS headers -- the API is same-origin appliance-local, so a cross-origin caller is never granted access. These are additive to the defense-in-depth response headers the server entry already applies globally (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security)).

### Browser-CSRF gate

The shared route gate applies two complementary browser defenses to every route, after the feature gate's `404` (so a disabled API stays a uniform `404`, its presence unobservable) and before any filesystem access or spawn. Each refuses with an empty-bodied `403`, matching the gate's `404`.

- **Loopback Host-allowlist.** The request's `Host` hostname -- port-stripped, IPv6 brackets removed, lowercased -- must be a loopback literal (`127.0.0.1`, `localhost`, or `::1`) or an entry in the `JOB_ALLOWED_HOSTS` environment variable (comma-separated hostnames, each trimmed and lowercased, empties dropped); any other value is refused, as is an absent or unparseable `Host` (fail closed). The match is on the hostname only, so any published-port remapping (`-p 127.0.0.1:8080:3000`) passes. `0.0.0.0` is never a loopback literal. A rejection is logged server-side naming the `Host` and pointing at `JOB_ALLOWED_HOSTS`, so a misconfigured operator gets a self-service diagnosis rather than a silent break. The check keys on the `Host` header, never the socket peer address (under Docker Desktop the peer is the gateway, not loopback).
- **Origin / `Sec-Fetch-Site` check.** In order: if `Sec-Fetch-Site` is present and is neither `same-origin` nor `none`, the request is refused; else if `Origin` is present and its origin (scheme+host+port) does not equal the request's own origin -- derived from the `Host` header, since the console is served over http on loopback -- it is refused; if neither header is present the request is allowed.

The Origin/`Sec-Fetch-Site` check closes plain cross-origin CSRF: a page the operator visits while the console runs can issue a CORS "simple" request (no preflight) to a job route and drive a side effect -- e.g. make the appliance connect out to an attacker-chosen host via `POST /api/jobs/sftp/probe`. Browsers send `Origin` on state-changing requests and `Sec-Fetch-Site` on every fetch, and page JavaScript cannot set either (both are forbidden header names), so a visited page cannot forge its way past the check; the console's own UI fetches relative same-origin URLs and passes unchanged; a non-browser client on loopback (curl, the operator's CLI) sends neither header and is allowed. The check is on the request's origin metadata, not its body, so it is content-type-agnostic and covers every route uniformly regardless of body shape.

The loopback Host-allowlist closes DNS rebinding, a standard technique the Origin/`Sec-Fetch-Site` check alone does not stop. A page at `http://attacker.example` whose name the attacker rebinds to `127.0.0.1` reaches the API with `Host` and `Origin` both naming `attacker.example` -- genuinely same-origin, so the Origin check passes -- and, being same-origin, the page can then _read_ the response (job results, keys, the SFTP projection), not merely drive a side effect. Requiring the `Host` to be a loopback name refuses it. This is what makes the no-CORS "cross-origin caller is never granted access" posture above actually hold: without the loopback-`Host` requirement, rebinding would render an attacker page same-origin and CORS-exempt. `JOB_ALLOWED_HOSTS` is the deliberate-exposure escape hatch for an operator who fronts the console behind a reverse proxy or reaches it by a LAN name -- deployment paths marked unsupported / an explicit choice in [DEPLOYMENT.md](../DEPLOYMENT.md#server-job-api).

## Endpoints

| Method | Path | Success | Notes |
| ------ | ---- | ------- | ----- |
| `POST` | `/api/jobs` | `201` `{ "id": "<uuid>" }` | Create and start a job from a JSON intent -- an `exchange` intent (the default) or a `zeroSetup` intent, selected by the top-level `mode` field (see [The job-create intent](#the-job-create-intent)). `413` (empty body) when the body exceeds the size cap (see [Size caps](#size-caps)). `400` on unparseable body, intent that fails schema validation, or an sftp intent with no connection authored (empty body, resolved before any workdir exists). `409` `{ "id": "<uuid>" }` -- the id (only) of the exchange occupying the single slot -- when an exchange is already active; the browser re-attaches to that exchange rather than dead-ending, and deleting it frees the slot for a new create (see [Job lifetime and orphan handling](#job-lifetime-and-orphan-handling)). |
| `GET` | `/api/jobs/:jobId` | `200` status JSON | `404` on malformed, unknown, or already-deleted id. |
| `DELETE` | `/api/jobs/:jobId` | `204` | Kills a still-running child, marks the exchange deleted, removes the workdir. Also removes an on-disk workdir named by a valid id but orphaned by a server restart. `404` when neither the active exchange nor such a workdir matches. |
| `GET` | `/api/jobs/:jobId/events` | `200` `text/event-stream` | SSE event relay with full-history replay. `404` on unknown id. |
| `POST` | `/api/jobs/:jobId/cancel` | `202` | Request cancellation; idempotent (`202` even if already terminal). `404` on unknown id. |
| `GET` | `/api/jobs/:jobId/result` | `200` `text/csv` | The matched-result CSV, only after the job succeeded. `404` otherwise. |
| `GET` | `/api/jobs/:jobId/record` | `200` `application/json` | The self-attested exchange record, only after the job succeeded. `404` otherwise. |
| `GET` | `/api/jobs/:jobId/keys` | `200` `application/json` | The private verification keys paired with the record, only after the job succeeded. `404` otherwise. |
| `GET` | `/api/jobs/:jobId/handoff` | `200` hand-off JSON | The recurring-run hand-off: the portable, secret-free template plus its metadata (see [The recurring-run hand-off](#the-recurring-run-hand-off)). `404` on malformed, unknown, or already-deleted id. |
| `GET` | `/api/jobs/sftp` | `200` `{ "configured": <bool>, ... }` | The authored SFTP connection as a credential-free projection: `{ "configured": false }` when none, else `{ "configured": true, "host", "port"?, "path"?, "credentialWarnings": [ ... ] }`. `credentialWarnings` is the non-blocking credential-containment warnings. See [The authored SFTP connection](#the-authored-sftp-connection). |
| `PUT` | `/api/jobs/sftp` | `200` credential-free projection | Author the SFTP connection from a file-reference credential body (see [Authoring the SFTP connection](#authoring-the-sftp-connection)). `400` (body naming a field path, never a value) on a body that fails hard validation. `413` when the body exceeds its size cap. |
| `DELETE` | `/api/jobs/sftp` | `204` | Forget the in-app authored connection (idempotent). |
| `POST` | `/api/jobs/sftp/probe` | `200` typed envelope | Read the host-key fingerprint a server at `{ "host", "port"? }` presents, for the operator to compare against the published value (see [Probing the server host key](#probing-the-server-host-key)). `400` (field-path body) on a bad body, `409` (empty body) when a probe is already running. |
| `GET` | `/api/jobs/mounts/secrets/entries` | `200` `{ "configured", "readable", "entries" }` | List the mounted secrets directory the operator browses for a credential file (see [The secrets mount and browsing](#the-secrets-mount-and-browsing)). |

The feature gate applies to every endpoint uniformly: a disabled API is `404` on all of them, resolved before the id is even parsed.

### Job id and the traversal guard

The job id is a server-generated v4 UUID; the client never supplies it. Every id-bearing endpoint validates the parameter against the exact canonical v4 UUID pattern before any filesystem use, and a value that is not a canonical v4 UUID (a traversal payload, an absolute path, an empty string) is `404` without touching disk. Resolving a workdir applies a second, defense-in-depth check: the id is joined to the resolved data root and the result confirmed to stay strictly under `<dataRoot>/`, so even a validated id that resolved outside the root is refused. An unknown-but-well-formed id (never created, already deleted, or belonging to an exchange the server forgot on restart) is `404` identically, so id validity is not distinguishable from job existence.

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

### The recurring-run hand-off

`GET /api/jobs/:jobId/handoff` returns the portable material an operator carries from a prototyped console exchange to a scheduled command-line `psilink` run. It is composed at job creation from that run's intent and resources and held on the in-memory record, so it is served for the whole lifetime of a live record (the panel reads it at completion, but the endpoint keys its `404` on job existence, not status -- a malformed, unknown, or already-deleted id is `404` identically to the other id-bearing routes). It is JSON with the `no-store` discipline. The body is:

```json
{
  "mode": "exchange" | "zeroSetup",
  "channel": "sftp" | "filedrop",
  "usedKeyFile": <bool>,
  "credentialPasted": <bool>,
  "template": { "kind": "config", "yaml": "<psilink.yaml text>" }
             | { "kind": "command", "argv": [ "<token>", ... ] }
}
```

`usedKeyFile` is true for the exchange mode (a `.psilink.key` the operator must copy), false for the zero-setup mode (which carries no shared secret). `credentialPasted` is true only for an sftp run whose credential was a pasted, materialized value (the panel then tells the operator to save it to a file); it is always false on the filedrop channel. The `template` is discriminated on `kind`: an exchange run yields a `config` (the `psilink.yaml` document, recomposed through the same functions the live run used), a zero-setup run a `command` (the argv tokens of the `psilink URL INPUT OUTPUT` form).

Two invariants hold by construction and are pinned by tests:

- **No secret.** The response never carries the shared secret, the key-file body, or an inline credential value. The exchange config carries the credential only as an `@path` reference (the secret rides the key file, which never crosses this API), and the zero-setup command carries no secret at all.
- **No container path.** The response never carries a container-internal path. The credential `@path` (sftp) is replaced with the fixed placeholder `@/path/to/your/credential-file` (a private-key passphrase with `@/path/to/your/passphrase-file`), and the filedrop rendezvous directory with `/path/to/your/shared-directory` in a config or `file:///path/to/your/shared-directory` in a command. The portable values -- host, port, username, the remote SFTP working directory, the host-key fingerprint pin, and the linkage terms -- are emitted verbatim as they ran; only the machine-specific local paths become placeholders.

## The job-create intent

`POST /api/jobs` accepts a JSON body validated against a strict schema, discriminated first on `mode` -- `"exchange"` or `"zeroSetup"` -- and, within each mode, on `channel`. A body that omits `mode` defaults to `"exchange"` (the merged exchange client predates the discriminant and sends none); a zero-setup body must name itself explicitly, so an omitted `mode` is never routed there. Both modes are injection-closed by construction, on identical grounds: no field on either becomes an argv string, a filesystem path, a host, or a credential reference, and every leaf arm is `.strict()`, so a smuggled `connection`, `server`, or `remote` key fails the parse regardless of mode. On the sftp arm of either mode, connection material is drawn exclusively from the authored server-side connection (see [The authored SFTP connection](#the-authored-sftp-connection)); the client contributes no connection field on either mode. `POST` stays closed to connection material even where the connection is operator-authored in-app: authored material flows only through `PUT /api/jobs/sftp` (a separate endpoint whose body is validated by the same connection chain), never a field on either mode's intent. Every arm of both modes additionally carries exactly one input source -- inline `inputCsv` content or a mounted `inputFile` reference -- enforced by a union-level refine after each arm's own strict parse, so a body naming both or neither fails identically regardless of mode.

### The exchange intent

An exchange intent (`mode: "exchange"`, or `mode` omitted) drives `psilink exchange` against a composed config and key file: the linkage terms and the shared secret are pre-agreed and carried on the intent itself, so the exchange runs against a partner already holding the same secret.

| Field | Type / validation | Why it cannot inject |
| ----- | ----------------- | -------------------- |
| `mode` | optional literal `"exchange"` | Defaults to `"exchange"` when omitted (see above); an explicit `"exchange"` is also accepted. |
| `channel` | `"filedrop"` or `"sftp"` | The closed discriminant. A filedrop exchange has no host and no credential field at all, so the connection block the server composes carries nothing injectable. An sftp exchange draws every piece of connection material from the operator-authored connection; the sftp arm carries no connection field at all (the appliance runs exactly one authored connection). A `webrtc` or other value is rejected as unknown. A `remote` field on either arm is rejected as an unknown key by the strict parse. |
| `linkageTerms` | core's `LinkageTermsSchema` | Bounded partner-authored vocabulary (field names, key elements, transforms). It carries no filesystem path, host, or command field, so a hostile value cannot escape into argv or the filesystem. |
| `sharedSecret` | base64url 32-byte pattern (`/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/`) | Credential material matching the CLI key-file shape. It is written into a fixed-name key file, never used as a path or argv fragment; a malformed secret is rejected here rather than crashing the child at load. |
| `inputCsv` | non-empty string, length-capped | CONTENT written to a fixed, server-chosen filename in the workdir. The client never names a file. The cap is anchored to the browser intake's own 100 MiB file-size gate, so a CSV that passed that gate is never rejected here (see [Size caps](#size-caps)). The alternative to `inputFile`; exactly one of the two is set. |
| `inputFile` | `{ "name": "<segment>" }` | A REFERENCE to a file in the mounted work-input directory (`JOB_INPUT_DIR`, see [Environment variables](#environment-variables)), not content: `name` is a single admissible path segment (the same shape rule the work-input listing applies) and is resolved against the mounted directory at create time -- a name that resolves to no regular file is refused before any workdir exists. The CLI reads the file in place; nothing is copied into the workdir. The alternative to `inputCsv`; exactly one of the two is set. |
| `metadata` | optional; core's `MetadataSchema` | The operator's per-party column metadata (each column's name, semantic type, role, and payload flag). Structured data written into the config as YAML values, never an argv fragment, path, host, or credential. Carried so the CLI honors the operator's disclosure edits (which columns are sent vs ignored) instead of inferring metadata from the column names. |
| `standardization` | optional; core's `StandardizationSchema` | The operator's per-party standardization pipeline (per-field transform steps). Structured data written into the config as YAML values, never an argv fragment, path, host, or credential. |
| `expectedPayloadColumns` | optional `string[]` | The acceptor's received-payload lock-in: the partner-namespace column names it will enforce it receives, mirrored from the invitation's disclosed set. Column names only, never a path, host, or credential. An empty array is a strict "receive nothing" (a non-empty partner payload then aborts); an omitted field reconciles lazily. Set on the acceptor path only; the inviter omits it. |
| `options` | numeric/boolean/enum subset (below) | Every field is a number, boolean, or closed enum -- none can carry a path, host, credential, or command. |
| `eventStream` | optional boolean (default true) | Whether `--event-stream` is passed. |

Both channel arms are `.strict()`: an unknown key (a smuggled `path`, `host`, `server` block, or `@path` credential reference) fails validation, and each arm admits only its own fields. The `options` subset is deliberately the numeric/boolean/enum knobs only -- `pollIntervalMs`, `peerTimeoutMs`, `serverConnectTimeoutMs`, `maxReconnectAttempts` (0..604800), `timestampInFilename`, `locklessRendezvous`, `retainFiles`, and `unexpectedFiles` (`error`/`warn`/`ignore`). The path and directory fields of the CLI's file-sync options are intentionally not surfaced (the server owns every directory), and the free-text `peerId` is omitted for the same reason. On the sftp arm `pollIntervalMs` is additionally floored at 1000 ms: an sftp poll is a directory listing against the operator's authored remote server, not a job-local directory, so a client-chosen hot poll would flood a shared -- possibly partner-hosted -- host.

The `metadata` and `standardization` fields are validated structured data -- core's `MetadataSchema` and `StandardizationSchema`, respectively -- and carry no injectable field. Core bounds each column `name` and closes `role`/`type` to enums; the arrays and the free-text `description`, `output`, and `input` are additionally bounded web-side at this boundary (see [Size caps](#size-caps)). A standardization step's `params` is a `Record<string, unknown>`, unbounded by nature and left uncapped at the field level -- the boundary body cap is its backstop. The linear-time regex-dialect gate (`docs/spec/PROTOCOL.md`, "Transform regular-expression dialect") -- which caps and dialect-checks transform-pattern sources -- applies to the negotiated `linkageTerms` transforms, not to the standardization pipeline's raw-pattern steps. That is a compile/size cost, not a ReDoS hole: every standardization raw-pattern step still compiles and runs under core's linear-time RE2 engine (RE2JS), so it cannot backtrack catastrophically. It remains a resource bound, not an injection escape: no metadata or standardization value becomes an argv fragment, a path, a host, or a credential.

### The zero-setup intent

A zero-setup intent (`mode: "zeroSetup"`, required and literal) drives the CLI's zero-setup command instead of `psilink exchange`: both parties run the CLI against the same server they agreed on out of band, and the CLI infers linkage terms, metadata, and standardization from each party's own input file rather than either party pre-authoring them for both. It therefore carries none of the exchange mode's `sharedSecret`, `linkageTerms`, `metadata`, `standardization`, or `expectedPayloadColumns` fields, and no connection field at all: on the sftp arm connection material is drawn exclusively from the effective server-side connection, exactly as the exchange arm; the filedrop arm's connection is the configured rendezvous directory, again exactly as the exchange arm.

| Field | Type / validation | Why it cannot inject |
| ----- | ----------------- | -------------------- |
| `mode` | literal `"zeroSetup"` | Required and literal -- a zero-setup intent names itself; a body that omits `mode` is routed to the exchange arm instead, never here. |
| `channel` | `"filedrop"` or `"sftp"` | The closed discriminant, identical in meaning to the exchange arm's. |
| `inputCsv` / `inputFile` | as the exchange mode | CONTENT or a mounted-file REFERENCE, exactly as the exchange mode's fields of the same name; exactly one of the two is set. |
| `options` | numeric/boolean/enum subset, as the exchange mode | Identical fields and identical sftp `pollIntervalMs` floor. |
| `eventStream` | optional boolean (default true) | As the exchange mode. |
| `linkageStrategy` | optional `"cascade"` or `"single-pass"` | A closed enum forwarded to the CLI's `--linkage-strategy`; never a path, host, or credential. |
| `identity` | optional string, 1 to 1024 characters, no leading `-` | A bounded operator label forwarded to the CLI's `--identity` (the party's name/org/contact string). Free text rather than a closed enum, so a leading `-` is additionally forbidden so a flag-shaped value cannot masquerade as a CLI flag; the driver also emits it as a single `--identity=<value>` token, which parses a `-`-leading value verbatim regardless. |

Both channel arms are `.strict()`, so no `sharedSecret`, `linkageTerms`, `metadata`, `standardization`, `expectedPayloadColumns`, or any other unmodeled key -- including a `connection`/`server`/`remote` key -- survives validation, and the exactly-one-input-source rule holds exactly as in the exchange mode. Because a zero-setup run carries no shared secret, it writes no key file and composes no config document at all: its connection and options reach the CLI as argv instead -- see [Composed CLI configuration](#composed-cli-configuration) and [Subprocess invocation](#subprocess-invocation).

### Size caps

The intent is operator-authored, never partner-supplied, and the API is feature-gated and reached only from the operator's own machine, so the worst case an oversized intent reaches is a single operator exhausting their own appliance's memory -- not a remote surface. Two defense-in-depth layers bound it anyway, so neither the request nor a persisted artifact can grow without limit:

- **Boundary body cap.** `POST /api/jobs` reads its body under a hard byte cap (224 MiB), streamed off the request and counted chunk by chunk; the read aborts the moment the running total exceeds the cap, and `Content-Length` is never trusted (it can be absent or understated on a chunked request). An oversized body is a `413` before the body is fully buffered or any schema parse runs. The cap sits well above the JSON-encoded size of a realistic schema-valid intent -- real CSV text barely grows under JSON string escaping -- so a legitimate intent reaches a clean schema error rather than a boundary `413`. It is deliberately not sized to clear a pathological payload built from control characters that each escape to a 6-byte `\uXXXX` sequence (not valid CSV), nor an unbounded standardization `params`; bounding those here is exactly the memory guard's job. It applies identically to both modes.
- **Schema caps.** The intent schema bounds `inputCsv` (anchored to the browser intake's 100 MiB file gate), the `expectedPayloadColumns` array and its entries, the `metadata` array and each `description`, and the `standardization` array, each transformation's `steps`, and its `output`/`input`. The bounds are deliberately generous -- far above any legitimate intent -- and apply to both channel arms. They are enforced web-side at this boundary rather than in core's shared schemas, so partner-facing validation elsewhere is unchanged. The `inputCsv` cap applies identically to a zero-setup intent's `inputCsv` field; the `expectedPayloadColumns`, `metadata`, and `standardization` caps are exchange-mode only, since a zero-setup intent carries none of those fields.

The `expectedPayloadColumns` field is a list of partner-namespace column names -- no path, host, or credential -- validated as a string array. Its empty-vs-absent distinction is preserved end to end (an empty array is forwarded verbatim as a strict lock-in; only an omitted field stays lazy); see the composed-config note below.

### Composed CLI configuration

This section covers the exchange mode only: a zero-setup intent composes no config document and no key file at all, so a zero-setup job's workdir carries neither -- see [Subprocess invocation](#subprocess-invocation) for how its connection and tuning reach the CLI instead, as argv.

From a validated filedrop intent the server composes the CLI config document (snake_case YAML the CLI loads verbatim) through core's `mintExchangeFile`, so the assembled spec is validated by the CLI's own schema before it is written. The composition is fixed:

- The connection is a credential-free `filedrop` locator whose one path field is set to the resolved rendezvous mount (`JOB_RENDEZVOUS_DIR`, or `JOB_DATA_ROOT` when it is unset) -- server-side environment configuration, never a client value. By core's `ExchangeFileInput` typing no credential is representable in a filedrop connection.
- No `authentication` block is ever assembled; the shared secret rides the separate key file.
- The intent's `linkageTerms` reach the document only after core's schema validation.
- The intent's `metadata` and `standardization`, when present, are attached as the config's `metadata` and `standardization` blocks (omitted when absent). Carrying them is what makes the operator's data-prep edits authoritative on this path: the CLI's `prepareForExchange` uses the composed metadata instead of falling back to `inferMetadata`, which would default an unrecognized column to disclosed payload and could silently disclose a column the operator marked ignored.
- The intent's `expectedPayloadColumns`, when present, is attached as the config's `expected_payload_columns` (an empty array is attached verbatim; only an omitted field is left off). Carrying it makes the acceptor's received-payload lock-in explicit: the CLI prefers `expected_payload_columns` over the `linkageTerms.payload.receive` fallback, which is undefined for a token that discloses columns but carries no `payload.send` -- a shape where the fallback would fail open (silently ingesting extra partner columns) while the browser acceptor aborts. The inviter path omits it.
- The tuning `options`, if any were set, are narrowed to the CLI's file-sync options and attached; when none were set the block is omitted entirely.

An sftp intent is composed differently. `mintExchangeFile`'s input type deliberately cannot represent a credential -- an invariant shared with the browser's exchange-file minting that must not be widened -- so the server assembles the exchange spec directly: the connection's `server` block is the authored entry verbatim (its `@path` credential references land in the YAML as references, resolved only by the CLI child), the client's `linkageTerms`, `metadata`, `standardization`, `expectedPayloadColumns`, and tuning options attach exactly as on the filedrop path, and the assembled spec is validated through core's exchange-spec schema before serialization, with only the schema's own fields reaching the YAML. The intent contributes nothing to the connection. No `authentication` block is assembled on either path.

The key file body is `{"sharedSecret":"<value>"}` with no `expires` stamped, so a server-driven job carries no invitation-token lifetime of its own.

## The authored SFTP connection

An sftp job's connection material -- for either mode -- never comes from the create intent; the operator authors it in-console through `PUT /api/jobs/sftp` ([Authoring the SFTP connection](#authoring-the-sftp-connection)). The console is a single-owner prototyping tool -- the person who runs the container, authors the connection, and runs the exchange is the same person -- so there is no deploy-time provisioning step and no server file to pin in advance. The console conducts one exchange and is not a store of named connections, so there is exactly one effective outbound SFTP connection at a time, held in a single in-memory slot scoped to the one exchange and forgotten on restart.

The authored connection resolves to an internal server block (`host`, `port`, `username`, `path`, one primary credential `@path`, an optional `private_key_passphrase` `@path`, `keyboard_interactive`, and `host_key_fingerprint`) validated by these rules, each load-bearing:

- **Strict field allowlist.** The block admits exactly `host`, `port`, `username`, `path`, `password`, `private_key`, `private_key_passphrase`, `keyboard_interactive`, and `host_key_fingerprint`; any other key is a validation error. This is deliberately stricter than the CLI's connection schema, which is non-strict and admits blocks the appliance must never carry: `provision` (whose auth block holds inline HTTP credentials and drives pre-connect egress) and the split `inbound_path`/`outbound_path` pair (which couples to the client-owned retain tuning). Strictness also turns a typo into a validation error instead of a silently dropped field.
- **Mandatory literal pin.** `host_key_fingerprint` is required (a string or a list) and every element must be a literal OpenSSH SHA256 fingerprint; an `@path` reference is rejected. The job child is non-interactive (stdin ignored), so first-use trust can never happen there; requiring the pin makes every appliance SFTP connection host-key-pinned, verified before authentication. A host-key rotation is staged by listing the old and new fingerprints together.
- **Credential must be an existing `@path` (hard); containment is a warning.** `password`, `private_key`, and `private_key_passphrase`, when present, must be `@path` references to an ABSOLUTE path, and the referenced file must exist at validation time (checked by `realpath` only; the bytes are never read into the server) -- each a hard error. Inline values are rejected, so no secret enters server memory or any composed job file; the CLI child resolves the reference at config load. A reference that resolves INSIDE the data root OR -- when configured distinctly -- the rendezvous directory is a NON-BLOCKING warning, not a rejection: the console is a single-owner prototyping tool, so referencing a credential in the operator's one mounted folder is guided-against, not forbidden. The containment is checked on both the lexically resolved path AND its realpath (so a symlink cannot resolve into an excluded directory undetected), producing at most one warning per credential field. Each warning names the field and the directory only -- never the reference, resolved path, or secret -- and points at the fix: mount a separate read-only secrets directory (`JOB_SECRETS_DIR`) and reference the file there. The warnings ride the connection's projection so both the `PUT` response and a later `GET` (a console reload) carry them.
- **Composition check.** The block is additionally parsed through core's connection schema as `{channel: "sftp", server: <block>}`, so the CLI's cross-field refines (one primary auth method, a passphrase requires a key, keyboard-interactive requires a password, canonical fingerprint form) hold at authoring time rather than first inside a job.

The connection is frozen once authored: changing the host or pin means re-authoring (`PUT` again) or clearing it. The referenced credential FILES are live -- the CLI child re-reads them at each job's config load -- so rotating a secret in place takes effect without re-authoring.

**One exchange at a time.** The console facilitates a single exchange, so the manager holds at most one in a single slot: while it is occupied a second create of either channel is refused with a `409` carrying the occupying exchange's id (`{ "id": "<uuid>" }`, the id only), so the browser can re-attach to the running exchange rather than dead-end on an "already running" alert; the current exchange is deleted to free the slot. The slot is claimed before any workdir exists and freed only when the exchange was deleted and its child's exit was observed (see [Job lifetime and orphan handling](#job-lifetime-and-orphan-handling)), so a successor can never rendezvous with a still-dying child over the authored connection or `JOB_RENDEZVOUS_DIR` directory.

### `GET /api/jobs/sftp`

Returns the authored connection as an explicitly mapped, credential-free projection: `{ "configured": false }` when none is authored, else `{ "configured": true, "host": "...", "port"?: <int>, "path"?: "...", "credentialWarnings": [ "..." ] }` and nothing else -- no username, no credential references (which would reveal the secret-mount filesystem layout), no fingerprint. `credentialWarnings` is the non-blocking credential-containment warnings (empty when every credential resolves safely outside the excluded directories; each entry names a credential field and a directory only), so a console reload re-surfaces them. An enabled API with no connection serves `200 { "configured": false }`, the same shape family and gate as `GET /api/jobs/rendezvous` (a `404` there means the API is disabled). The console web build uses this to gate the run-SFTP-here behavior and to author an invitation's sftp endpoint from the locator. The static `sftp` segment cannot be captured as a job id: ids are validated as canonical v4 UUIDs before any use, which `sftp` is not.

## Authoring the SFTP connection

The operator authors the one sftp connection in-console through `PUT /api/jobs/sftp`. The validated connection is held in a single in-memory slot scoped to the one exchange -- never persisted -- so a restart forgets it. `GET /api/jobs/sftp` projects it, and `createJob`'s sftp arm composes from it, unchanged; the create-intent injection closure is unaffected (`POST /api/jobs` gains no connection field).

### `PUT /api/jobs/sftp`

Authors the connection from a JSON body carrying a file-reference credential or a pasted value the server materializes to a file (see [Materializing a pasted credential](#materializing-a-pasted-credential)). The body is read under a small byte cap (`65536`) -- a pasted password or SSH private key rides it but is far under the cap -- so an oversized body is a `413` before any parse. Fields:

| Field | Type / validation |
| ----- | ----------------- |
| `host` | non-empty string (required) |
| `port` | integer `0..65535` (optional) |
| `username` | non-empty string (optional) |
| `path` | non-empty string (optional) -- the remote shared directory |
| `hostKeyFingerprint` | a literal OpenSSH SHA256 fingerprint or a non-empty list of them (required); an `@path` reference is rejected |
| `credential` | a credential in one of three forms (all tagged with `credType: "password" \| "private_key"`, which maps the resolved reference to the `password` or `private_key` field): a typed `{ "kind": "ref", "ref": "@/absolute/path", "credType" }` -- the escape hatch for a credential outside any listable mount -- a secrets-mount locator `{ "kind": "mountRef", "mount": "secrets", "subPath": ["seg", ...], "credType" }` the operator picked in the browser, OR a pasted value `{ "kind": "raw", "value": "<secret>", "credType" }` the server materializes to a file (see [Materializing a pasted credential](#materializing-a-pasted-credential)). Any other `kind` is refused. |
| `privateKeyPassphrase` | an `@path` reference (optional) |
| `keyboardInteractive` | boolean (optional) |

The body is strict: an unknown key (a `provision`, `certificate`, `inbound_path`, or a bare inline credential field) fails validation. A `mountRef` credential is resolved SERVER-SIDE against the resolved `JOB_SECRETS_DIR` via the same mount-file resolver the browse listing uses (`resolveMountFile`) and rewritten to `@<realpath>`, so no container-absolute path ever transits the browser; the mount is a single id (`secrets`, a cross-mount locator is out of scope), and an unset mount, an unknown id, or a `subPath` naming no readable regular file (or one escaping the mount) is a `400` naming the credential field only -- never a path. A `raw` credential is materialized to a server-owned file whose `@path` replaces it (below). The resolved (materialized, typed, or picker-resolved) `@path` credential and the passphrase are then folded into a server block and run through the validation chain of [The authored SFTP connection](#the-authored-sftp-connection) -- the strict field allowlist, mandatory literal fingerprint, credential-must-be-an-existing-`@path`, and the core-schema compose -- so every source is held to identical rules. A credential resolving inside the data root or rendezvous directory is a NON-BLOCKING warning (returned in `credentialWarnings`, naming the field and directory only), not a rejection. A hard-validation failure is a `400` whose body is `{ "error": "<field path>: <reason>" }` naming a field path only -- never a submitted value, credential reference, or secret; a malformed `raw` credential is rejected on shape (a non-string or empty `value`) before any write, and its `400` does not echo the value. On success the response is the authored connection's credential-free projection, including `credentialWarnings` (the same body `GET` returns).

### Materializing a pasted credential

The `{ "kind": "raw" }` credential is the de-emphasized fallback for a secret that exists nowhere on the appliance as a file. It widens the credential threat model -- a pasted value now transits the loopback API and is briefly held in server memory -- but only within the single-party-appliance trust boundary: a loopback-only browser on the operator's own machine, where the value crossing same-origin loopback and living momentarily in memory is on-host. The at-rest and partner-facing boundaries stay closed:

- **Materialize once, then rewrite.** The server writes `value` ONCE to a server-owned file under a fixed, container-internal scratch directory (`/run/psilink/sftp-credentials`), then rewrites the credential to `{ "kind": "ref", "ref": "@<that file>" }` and runs the SAME credential checks the file-reference forms run. The scratch directory is asserted outside the data root and rendezvous directory at boot (below), so a materialized paste never raises a containment warning. Server memory holds `value` only transiently -- between request parse and the file write -- and never logs it, places it in argv or the child environment, or returns it in any response, projection, or SSE event; a JS string cannot be zeroized, so this is best-effort minimization rather than a guaranteed wipe. The composed `psilink.yaml` carries the resulting `@path`, never the value.
- **The scratch directory.** It is NOT `JOB_DATA_ROOT` and NOT the resolved `JOB_RENDEZVOUS_DIR`, and needs no extra operator mount, so a paste works with only the data root mounted. Its path defaults to a fixed container-internal location and is relocatable server-side with `JOB_SFTP_CREDENTIAL_DIR` (the image runs as root and uses the default; a non-root deployment or the test harness points it at another writable, non-partner-syncable directory). It is created mode `0700`; each secret is written under a server-generated name (a v4 UUID) at mode `0600`, `chmod`-enforced after the write. A pasted secret exists at rest ONLY as this file, and only as long as the connection it belongs to: it is deleted on the connection's `DELETE`/reset, on a re-author that replaces it, and when the exchange it was authored for is deleted (`DELETE /api/jobs/:jobId`). Unlike a workdir, it does not linger until deleted -- see the boot sweep below. A `raw` credential on an appliance with no scratch directory (the API disabled, or the boot setup skipped) is refused rather than composed inline.
- **Boot sweep and containment assertion.** At server startup, when the job API is enabled, the currently-configured scratch directory is swept clean (covering a secret orphaned by a restart -- an SSH credential must not inherit the workdir's persistence) and asserted to resolve strictly OUTSIDE the data root, the rendezvous directory, the secrets mount, and the work-input directory, on both the lexical resolve and the realpath and in both nesting directions (a sweep of an excluded directory would destroy operator or partner data). The "no pasted secret lingers across a restart" guarantee therefore holds only while the job API stays enabled and `JOB_SFTP_CREDENTIAL_DIR` is unchanged between runs -- a since-removed override location is not the one swept. The containment check runs on the realpath BEFORE the directory is created or re-moded, so a symlinked scratch path resolving into an excluded mount is refused before any `mkdir`/`chmod` can touch that mount. A directory that fails the assertion refuses the boot, fail-closed, matching the appliance's posture. Preferring a tmpfs mount at the scratch path keeps pasted secrets off disk entirely; the boot sweep is the backstop when the container does not arrange one.

If any validation step AFTER the write rejects the entry (a bad host or fingerprint), the just-written file is deleted before the `400` returns, so a rejected paste leaves nothing at rest.

### `DELETE /api/jobs/sftp`

Forgets the in-app authored connection (and its credential warnings) and returns `204` (idempotent). The authored connection is ALSO cleared when the exchange it was authored for is deleted (`DELETE /api/jobs/:jobId` of the active exchange), so it is scoped to that single exchange and never lingers into the next.

## Probing the server host key

`POST /api/jobs/sftp/probe` reads the host-key fingerprint an SFTP server presents, so the console can offer it beside the paste field for the operator to compare against the value the server operator published. It authors nothing: it never touches the authored connection, records nothing, and returns the observation for the caller to forget. The manager spawns the CLI's `probe-host-key --json` subcommand (the same binary the exchange runs; the server cannot probe SSH in-process -- see [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md#sftp-host-key-verification)) under the shared no-shell spawn discipline, caps and parses its stdout, and DISCARDS its stderr.

The SSRF bounds are the module contract, pinned by tests:

- **Request carries host + port only.** The body is `.strictObject({ host, port? })` -- `host` a non-empty string, `port` a `0..65535` int -- so no username, path, or credential field is representable; an unmodeled key is a `400`. `host` additionally passes the shared bare-host predicate (no scheme, userinfo, path, or whitespace), the same rule `PUT /api/jobs/sftp` applies, so it cannot smuggle a URL. The body is read under a tight cap (4 KiB, `413` above it).
- **Response carries fingerprint + key type only.** A completed attempt is always a `200` with a discriminated body: `{ "status": "ok", "fingerprint": "SHA256:...", "keyType": "..." }` on success, or `{ "status": "unreachable" | "timeout" | "error" }` for a probe that ran but yielded no key. The fingerprint is re-validated against `HOST_KEY_FINGERPRINT_REGEX`, and the key type is length- and charset-capped (server-controlled bytes). No banner, stderr, latency-beyond-category, saved-hosts list, or re-probe-on-change is exposed, and there is no credentialed "test connection".
- **Single-flight and stateless.** One probe child runs at a time; a concurrent request is a `409` (empty body). The flag is claimed synchronously, independent of the exchange slot. The probe reconciles the child's exit -- CLI exit `69` to `unreachable`, a watchdog kill (SIGTERM at ~15 s, SIGKILL after a grace) to `timeout`, any other non-zero or malformed line to `error` -- and forgets it.

Non-2xx is reserved for HTTP-level conditions only: `400` for a bad body (field-path message, never a value), `409` for a probe in flight, `404` when the feature gate is off, and `500` for an unexpected internal fault. A probe that ran and failed is a `200` category, never a `502`.

## The secrets mount and browsing

`JOB_SECRETS_DIR` names an operator-mounted directory the console browses to pick a connection's credential file. Unlike `JOB_INPUT_DIR` and `JOB_RENDEZVOUS_DIR`, it has NO `JOB_DATA_ROOT` fallback: when it is unset the secrets mount is simply unavailable -- a fallback would default the credential-browse surface into the per-job, client-writable data root, the one place a credential directory must never be. It is server-side configuration, never a browser-sent path.

Browsing does not widen the credential-reference rule: a typed `{ "kind": "ref" }` reference a `PUT` carries is validated only against the data-root and rendezvous exclusions (above), not required to lie under the secrets mount. The mount is the browse surface; it is not an allowlist that authorizes a path. A `{ "kind": "mountRef" }` locator (see [`PUT /api/jobs/sftp`](#put-apijobssftp)) confines only in the tightening direction: it is resolved to a realpath under the mount before it becomes a reference, so a picker selection cannot escape the mount, yet the resolved path still runs the same data-root/rendezvous exclusion checks a typed reference does. So the mount confines a browsed pick without authorizing one.

### `GET /api/jobs/mounts/secrets/entries`

Lists one directory of the secrets mount. `subPath` is a REPEATED query parameter -- one value per path segment (`?subPath=.ssh&subPath=keys`), never a single slash-joined string -- so a `/` inside a value can never compose a traversal. Each segment is admitted by a single-segment shape rule identical to the work-input name rule EXCEPT that a leading dot is allowed, so `.ssh` and other dotfiles that hold SSH key material are navigable; the separator, `.`/`..`, control-character, and `1..255` length checks are shared with the input rule and cannot drift from it. The resolved directory is confined to the mount twice -- lexically (the `resolve` + `startsWith(root + sep)` idiom) and then by `realpath`, so a symlink cannot escape the mount. No file bytes are ever read; an entry's `kind` comes from `stat` only.

The body mirrors the input listing's shape family:

- `{ "configured": false, "readable": true, "entries": [] }` when `JOB_SECRETS_DIR` is unset (the mount is unavailable).
- `{ "configured": true, "readable": true, "entries": [ { "name": "...", "kind": "dir" | "file" }, ... ] }` for a readable directory, entries sorted by name and filtered to admissible names.
- `{ "configured": true, "readable": false, "entries": [] }` when the subpath is inadmissible, escapes the mount (lexically or by realpath), or cannot be enumerated -- carried as a bare boolean, so a mis-mount or a traversal attempt reveals neither the errno nor the absolute path.

## Workdir layout

Each job gets a workdir at `<dataRoot>/<jobId>/`, created mode `0o700` (owner-only, `rwx------`), with an explicit `chmod` after `mkdir` because a restrictive umask is not guaranteed. Creation fails if the directory already exists, so a reused id cannot clobber an existing job. The data root itself is created (recursively) if missing. Inside the workdir, files are written at fixed, server-chosen names, each mode `0o600` (owner-only, `rw-------`, again `chmod`-enforced after write):

| Name | Contents |
| ---- | -------- |
| `psilink.yaml` | The composed CLI config document. |
| `.psilink.key` | The key file carrying the shared secret. |
| `input.csv` | The client's input CSV content. |
| `output.csv` | The CLI's matched-result output (written by the CLI on success). |
| `record.json` | The self-attested exchange record (written by the CLI on success; the write is non-fatal, so it may be absent). |
| `record.keys.json` | The private verification keys paired with the record (owner-only; written alongside the record under the same non-fatal write). |

The client never supplies a filename: submitted content is written to these constant names, and the CLI is pointed at them by absolute path. Keeping the names constant is what makes "a client string never becomes a file path" hold.

A zero-setup job's workdir carries neither `psilink.yaml` nor `.psilink.key`: it composes no config document and holds no shared secret, so only `input.csv` (when the input is inline rather than a mounted `inputFile` reference), `output.csv`, and the record pair are written. Its connection and tuning options reach the CLI as argv instead (see [Subprocess invocation](#subprocess-invocation)).

Neither channel's rendezvous lives in the workdir. A filedrop job's rendezvous is the resolved `JOB_RENDEZVOUS_DIR` mount (which defaults to `JOB_DATA_ROOT` when unset; see [Composed CLI configuration](#composed-cli-configuration)), shared across jobs and held by the single-holder latch; an sftp job's rendezvous is the authored connection's own directory. An sftp job's workdir has the same fixed-name layout, and its `psilink.yaml` carries the authored connection's block -- locator, pinned fingerprint, and `@path` credential references, never a credential value.

## Subprocess invocation

The CLI is spawned with `spawn` (not a shell, `shell: false`) and an argv array assembled only from fixed templates plus server-generated absolute paths and, for a zero-setup job, the server-side connection fields described below -- never a client string beyond the bounded values the intent schema already validated. Both invocation forms share the same post-spawn plumbing (the fd-3 event reader, the stderr tail, and terminal reconciliation); they differ only in the argv each builds.

### Exchange invocation

An exchange job drives the `exchange` subcommand against its composed config and key files:

```
<node> <binaryPath> exchange --config-file <configPath> --key-file <keyPath> --record-file <recordPath> [--event-stream] <inputPath> <outputPath>
```

`--record-file` pins the self-attested record to the server-known `record.json` in the workdir (the CLI derives the keys path as `record.keys.json` alongside it), so the server can serve both from a fixed path; without it the CLI would write to a timestamped default name the server could not locate. Records are on by default, so no `--no-record` is passed.

### Zero-setup invocation

A zero-setup job drives the CLI's literal `$0` (no-subcommand) form instead: there is no subcommand token, no `--config-file`, no `--key-file`, and never `--save` -- a zero-setup run infers its terms from the input file, carries no shared secret, and persists nothing beyond the single job's record. The connection rides the positional URL and, on the sftp arm, `--server-*` flags, in place of the composed config's connection block:

```
<node> <binaryPath> sftp://<host>[:<port>][/<path>] [--server-username=<value>] [--server-password=<value> | --server-private-key=<value>] [--server-private-key-passphrase=<value>] [--server-keyboard-interactive] --server-host-key-fingerprint=<fp> [--identity=<value>] [--linkage-strategy=<value>] --record-file=<recordPath> [--event-stream] <inputPath> <outputPath>
```

```
<node> <binaryPath> file://<rendezvousDir> [--identity=<value>] [--linkage-strategy=<value>] --record-file=<recordPath> [--event-stream] <inputPath> <outputPath>
```

The URL and every `--server-*` flag are built server-side from the same effective resource an exchange job's connection block draws on -- the authored SFTP connection ([The authored SFTP connection](#the-authored-sftp-connection)), turned into an `sftp://` URL plus flags, or the configured rendezvous directory, turned into a `file://` URL (the filedrop channel has no host or credential, so the URL is the whole connection). Every credential flag carries an `@path` reference verbatim -- the same reference the authored entry holds -- never a resolved secret, so no secret byte is ever on argv; the CLI child resolves the reference at live use. The host-key fingerprint is mandatory and always emitted: a zero-setup run has no TTY, so trust-on-first-use is impossible and the pin is the only host-key defense; a multi-fingerprint authored entry is a compose-time error instead of a silently dropped pin, since the CLI flag is single-valued. `--record-file` pins the record exactly as on the exchange invocation, so the record is written and served identically regardless of mode. `identity` and `linkageStrategy`, when the intent set them, are the bounded label and closed enum from [The zero-setup intent](#the-zero-setup-intent), forwarded unchanged. Every value-bearing flag -- including `--record-file` -- uses the single `=value` token form, never a two-token pair, so a value that begins with `-` cannot be misparsed by yargs as its own flag.

### Shared spawn discipline

`spawn` is used rather than `execFile` deliberately: `execFile` caps stdio at three pipes and cannot carry fd 3, which the event stream requires. The child's `stdio` is `["ignore", "pipe", "pipe", "pipe"]` (fd 3 wired for the event stream), `cwd` is the workdir, and the environment is minimal -- only `PATH`, `HOME`, `LANG`, `LC_ALL`, and `TZ` are forwarded from the server process, so the child inherits no ambient secret. The job's inputs reach the child through the workdir files (or, for a mounted `inputFile`, the operator's own mount), never the environment.

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
| `VITE_DEPLOYMENT_PROFILE` | The deployment-profile build signal, one half of the feature gate, read server-side the same way the client reads it. `console` -> this is the console appliance and the job API may enable; any other value (or unset, which is `hosted`) -> every job route is disabled (`404`) regardless of `JOB_DATA_ROOT`. The console image sets it via a `Dockerfile` `ENV` (which persists to the container runtime); a hosted build leaves it unset. Set at build/deploy time, never derived from a request. Reading the same signal on both sides keeps the server gate from drifting from the client build. |
| `JOB_DATA_ROOT` | The data root and the other half of the feature gate. Empty or unset -> the API is disabled (every endpoint `404`, no manager constructed, no child spawned). Non-empty AND a `console` build -> per-job workdirs are created under this resolved directory; non-empty on a hosted build stays disabled (see `VITE_DEPLOYMENT_PROFILE`). Read with surrounding whitespace trimmed. |
| `JOB_INPUT_DIR` | The mounted work-input directory the console lists and profiles for this party's input CSVs (the CLI reads the selected file in place). Empty or unset -> falls back to `JOB_DATA_ROOT`, so one mount runs the listing; per-job workdirs under the data root are subdirectories and are skipped by the regular-file filter, and dot-prefixed names are inadmissible, so the flat layout lists only loose input files. Non-empty -> resolved to an absolute path. It resolves to `undefined` (feature off) only when it and `JOB_DATA_ROOT` are both empty -- a state that also disables the API. Read trimmed; set only server-side, never derived from a request. |
| `JOB_RENDEZVOUS_DIR` | The mounted synced-folder rendezvous directory a filedrop exchange reads and writes. Empty or unset -> falls back to `JOB_DATA_ROOT`, so one mount runs the filedrop transport. Non-empty -> resolved to an absolute path. At filedrop job start the manager emits a non-fatal warning when this directory overlaps (equals, contains, or is contained by) the work-input directory or the data root -- as it does in the single-folder layout, where a partner's sync writes would reach the operator's key, input, or results -- but the operator's own directory layout is theirs to choose, so the exchange still runs. Read trimmed; set only server-side, never derived from a request. |
| `JOB_CLI_BINARY` | Overrides the CLI entry path the driver spawns. Unset -> the workspace-relative built entry (`apps/cli/dist/index.js`, resolved four levels up from the jobs module). Used by production overrides and by tests pointing the driver at a stub. It is set only server-side, never derived from a request. |
| `JOB_SECRETS_DIR` | The optional mounted secrets directory the console browses for a connection's credential file (see [The secrets mount and browsing](#the-secrets-mount-and-browsing)). Empty or unset -> the secrets mount is unavailable, and the operator references a credential by typing an `@path` instead (which may point into the data root, raising a non-blocking warning); there is deliberately NO `JOB_DATA_ROOT` fallback (a fallback would default the credential-browse surface into the client-writable data root). Non-empty -> resolved to an absolute path. Read trimmed; set only server-side, never derived from a request. |
| `JOB_SFTP_CREDENTIAL_DIR` | Overrides the container-internal directory a pasted (`raw`) credential is materialized to (see [Materializing a pasted credential](#materializing-a-pasted-credential)). Empty or unset -> the fixed default (`/run/psilink/sftp-credentials`), which the root-running image can create. Non-empty -> that directory, for a non-root deployment or the test harness. Whichever it resolves to is asserted at startup to lie strictly outside the data root, rendezvous directory, secrets mount, and work-input directory (else the boot refuses), created owner-only, and swept clean. Set only server-side, never derived from a request. |

### Startup and reachability

The API is enabled by a `console` build together with `JOB_DATA_ROOT`: on a console build with the data root set, the manager is constructed and every endpoint is live; on a hosted build, or with the data root unset or empty, every endpoint answers `404` and no manager is constructed or child spawned. Because the work-input and rendezvous directories both fall back to `JOB_DATA_ROOT`, that one variable (on a console build) also lights up the input listing and the filedrop transport, so a single mount runs a full console. When `JOB_DATA_ROOT` is set but the profile is not `console`, the server logs one non-fatal startup warning that the data root is ignored and boots with the job API dark rather than refusing to start. The server does not inspect its own bind interface -- there is no loopback bind check and no bind-derived startup refusal. Reaching the unauthenticated API only from the operator's own machine is a deployment concern: the console container publishes its port to the host loopback (`-p 127.0.0.1:PORT:PORT`), so exposure is governed by that publish binding and the host firewall rather than by an app-level bind check (see [DEPLOYMENT.md](../DEPLOYMENT.md#server-job-api)); the profile gate is the app-level backstop that keeps a hosted build from serving the API even when the publish binding or a fronting proxy would reach it.

When the job API is enabled, startup also prepares the pasted-credential scratch directory (see [Materializing a pasted credential](#materializing-a-pasted-credential)): it asserts the directory resolves strictly outside the data root and rendezvous directory -- refusing the boot if not, fail-closed -- creates it owner-only, and sweeps any credential a prior run orphaned. It is a no-op when the API is disabled (no manager is constructed, so no paste can be authored).

## Job lifetime and orphan handling

The exchange lives in server memory only and is never persisted:

- **One exchange in one slot.** The manager holds at most one exchange at a time. A second create -- of either channel -- is refused with a `409` carrying the occupying exchange's id (`{ "id" }`, so the browser re-attaches to the running exchange) while the slot is occupied, and the slot frees only when BOTH hold: the exchange was explicitly `DELETE`d, and the child's exit was observed (or no child was ever spawned). Keying the release on the child's confirmed exit -- not merely on the terminal event, which the buffer-overflow path emits while a `SIGKILL`ed child may still be running -- is what keeps a successor exchange from rendezvousing with a still-dying child over the authored connection or rendezvous directory. A settled but undeleted exchange keeps the slot: the reject-until-`DELETE` rule means a create never silently destroys the previous exchange's undownloaded result.
- **Restart forgets the exchange.** The in-memory slot -- running state, the terminal reconciliation, and the full event history -- does not survive a server restart, and no in-flight exchange is resumed or persisted (a restart cancels it rather than persisting another party's material). The workdir remains on disk; it is not re-discovered, listed, or re-surfaced, so a restarted server serves `404` for the forgotten id. The files stay until removed by an explicit `DELETE` of that id or by hand.
- **DELETE removes the disk.** `DELETE /api/jobs/:jobId` is the only operation that removes the workdir. For the active exchange it `SIGKILL`s a still-running child first so the delete leaves no orphan, marks the exchange deleted (the surface `404`s from that point), and `rm -rf`s the workdir (idempotent); the slot stays occupied until the child's exit is observed. A disk-only arm removes a workdir named by a valid v4 UUID but orphaned by a restart: it reads no artifacts and serves nothing, applies the same containment and real-directory (`lstat`, so a symlinked leaf is refused not followed) guards the live routes apply, and refuses the active slot's own id. Nothing is auto-deleted.
- **Shutdown signals the child.** On server shutdown (`SIGINT`/`SIGTERM`), the active exchange's running child is sent `SIGTERM` so no orphaned CLI outlives the server. The shutdown hook is registered before the graceful-shutdown handler (signal listeners run in registration order), so the child is signaled before any handler that may end the process. It is a no-op when the API was never enabled or no exchange is active.

## See also

- [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#single-party-appliance-trust-boundary) - the single-party-appliance trust invariant this API rests on
- [DEPLOYMENT.md](../DEPLOYMENT.md#server-job-api) - the operator-facing overview: what the feature is for and how to enable it
- [CLI_EVENTS.md](CLI_EVENTS.md) - the CLI's fd-3 event stream this API consumes and re-validates
- [PROTOCOL.md](PROTOCOL.md) - the exchange protocol that produces the events
- [CLI.md](../CLI.md#zero-setup-exchange) - the zero-setup command the zero-setup mode drives
