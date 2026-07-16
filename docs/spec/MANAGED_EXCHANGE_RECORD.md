---
title: "Managed Exchange Record"
---

# Managed exchange record

This document specifies the **managed exchange record**: the browser-persisted
state that lets a two-party PPRL exchange run again on an agreed schedule from
the web application -- unattended where the platform allows -- without
re-authoring the exchange or re-establishing a shared secret. It covers the
record's field-by-field shape -- what persists across runs versus what is
supplied at each run -- the field types, the key-derivation implications of the
persisted secret, the schedule and run bookkeeping the unattended path relies
on, and the export artifact's custody model and rollback caveats. It is the
implementation-level complement to the **Managed exchange lifecycle** overview in
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md), which says what the feature is for,
its automation goal and platform envelope, its durability and single-owner
contract, and its threat posture; this document covers the on-disk (in-browser)
shape those properties are enforced over. It does
not cover the browser at-rest threat model (see
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges)),
the exchange-file artifact the record is composed from (see
[EXCHANGE_FILE.md](EXCHANGE_FILE.md)), the invitation wire format (see
[FILE_SYNC.md](FILE_SYNC.md)), or the shared-secret rotation construction (see
[PROTOCOL.md](PROTOCOL.md#shared-secret-rotation)). Intended readers are security
auditors and implementors.

> **Status.** The record store, the run+rotate critical section (the
> single-writer lock and the persist-before-success write-back), the
> input-acquisition seam (the persisted handle, its permission discipline, and
> the pre-connection column-shape guard), the record-creating deposits (the
> manage offers at invite creation and at accept), the attended re-run (the
> saved-exchanges entry point and its side-dispatched runner), and the
> list and per-exchange detail management surfaces (the recurring-exchange list,
> and the per-partnership detail view with its read-only configuration,
> local-field editing, run history, and self-attested record view) are
> implemented; scheduling and the unattended runner are not yet. The
> recurring-exchange epic implements against the shape below, security-reviewed
> at each step because the record persists a rotating credential at rest. The
> persist-before-success ordering and the single-owner invariant are normative,
> not aspirational.

## What the record is, and what it deliberately is not

A managed exchange record is the minimal state a party's own browser retains so
that a recurring exchange with the same partner, over the same terms, can be run
again. It is **not** a saved copy of the exchange's inputs or outputs:

- **It never holds the input data, nor any row value derived from it.** The
  input file's contents are re-read at each run and never persisted (see
  [Re-supplied each run](#re-supplied-each-run)); a managed record holds no
  second copy of them. Where the File System Access API exists, the record
  persists a `FileSystemFileHandle` -- a **pointer** to the operator's file,
  never a copy of its contents (see [Persisted across
  runs](#persisted-across-runs)). This mirrors the CLI, where `psilink.yaml`
  references data by path and never embeds it, and the exchange-record artifact
  commits to data rather than embedding it (see
  [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md)).
- **It never holds a match result.** The intersection and any received payload
  are the run's output, handled under the operator's data governance, not
  folded back into the managed record.
- **It holds exactly one live shared secret at a time.** The secret is a linear
  resource (see [The secret is a linear
  resource](#the-secret-is-a-linear-resource)); the record stores the current
  rotated value and no history of prior values.

## Record shape

The record is a single object, persisted in the browser's IndexedDB under the
app's origin -- JSON-serializable but for the optional input-file handle, a
platform object IndexedDB stores by structured clone and the export artifact
omits (see [Export artifact](#export-artifact)). Its core is this party's own
**exchange-file document** -- the same shared config schema the web app mints
and the CLI consumes -- plus the secret and the small set of local-only fields
that document deliberately does not carry. This is the CLI-parity shape: what
the CLI keeps as `psilink.yaml` plus `.psilink.key`, the browser keeps as one
record. Persisting the whole document, rather than a bespoke subset of its
fields, keeps the record from becoming a parallel format of the kind the
no-parallel-format contract in [EXCHANGE_FILE.md](EXCHANGE_FILE.md) exists to
prevent. `camelCase` on the TypeScript side; the persisted key names below are
the normative field names.

The CLI parity has one deliberate break. The CLI's two artifacts are separable:
an operator can retire the secret alone (delete `.psilink.key`, keep the config)
and permission the two files differently. The one-record design does not offer
that separability: there is no secret-only retirement -- removing a managed
secret means deleting the whole record and re-establishing it by re-invite --
and one store read discloses the secret and the partnership metadata together.
The trade buys the single persist-before-success write and one import/export
artifact; it is stated here so a reviewer does not infer a separability the
design does not have.

### Persisted across runs

These fields survive a run, a crash, a tab close, and a browser restart. They
are the standing definition of the managed exchange.

| Field | Type | Notes |
| ----- | ---- | ----- |
| `schemaVersion` | string literal | A single recognized literal for v1 (for example `psilink-managed-exchange/v1`); a reader rejects an unrecognized value rather than migrating it, matching the reader-rejects-unknown rule the exchange-record and verification-keys files follow (see [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md)). |
| `id` | string (UUID) | A locally-generated identifier for this managed exchange, distinct from any rendezvous id. Used only to name the record in local UI; never sent on the wire. |
| `label` | string, at most 120 characters (enforced at write) | An operator-supplied display name for the partnership. Local only; never sent -- but disclosed to any reader of the store (see [Metadata at rest](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)). The length cap is enforced; the content guidance is not and cannot be: keeping agreement numbers, contact details, and other sensitive counterparty detail out of the label is **operator cooperation**, exactly as export-source invalidation is -- the field's only structural protections are the cap and its never-sent locality. |
| `exchangeFile` | object | This party's exchange-file document, verbatim: the validated `ExchangeSpec` shape both applications share (see [EXCHANGE_FILE.md](EXCHANGE_FILE.md), "The artifact is the CLI config schema") -- the linkage terms both parties validated (column **shape** and disclosed payload column **names**, never a row value), metadata, standardization, any disclosed payload columns, and the connection block. It carries **no `authentication` block** (the secret lives in `sharedSecret` below) and is composed exactly as the mint layer composes a downloadable file: assembled from a credential-free locator input, validated through the shared schema, with the **parse result** (never the raw input) persisted. The document's operator-authored free-text fields persist verbatim with it: each metadata column's optional `description` (no schema length bound), each standardization step's `params` (an open parameter map -- an authored cleaning step can embed a literal value, a pattern or a replacement string), and `retentionDisposition` (bounded at 1024 characters, the config schema's text bound), plus the terms' own 1024-bounded payload `description` and legal-agreement `purpose` strings. The record stores the document as minted, so the content guidance for these fields is the same **operator cooperation** the `label` row describes, and deliberately no additional bound or strip pass runs at persist time: the document is kept verbatim, and a document the mint layer accepts must remain saveable as managed (see [Metadata at rest](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)). A change to the agreed terms requires a re-invite, not an in-place edit. |
| `side` | enum (`"inviter"` \| `"acceptor"`) | This party's side of the partnership; dispatches a re-run to the matching rendezvous flow (see [Role: a local `side` field](#role-a-local-side-field-not-the-document)). Local-only by design -- deliberately not the document's schema-only `connection.role`. |
| `inputFileHandle` | `FileSystemFileHandle` or absent | A persisted **pointer** to the operator's input file, held where the File System Access API exists (Chromium), with persistent read permission where the platform grants it (an installed app), so an unattended run reads the standing file with nobody present and an attended re-run is one action. It is a reference, never a copy: no input content or row value persists, and the no-second-copy invariant holds unchanged. It is also live, not a snapshot: each run calls `getFile()` at run start and reads whatever file currently exists at the path -- a `File` object is a point-in-time reference, so `File` objects are never retained across runs -- which is what makes dropping the current period's extract over the same name the data-refresh workflow. A missing entry at run start fails the file read with a clean not-found, recorded as a benign `"input"` failure (see `lastRun`), never routed through desync/attack framing. What it does add to the store's disclosure is the input file's **name**, and the granted read permission extends an in-origin reader's reach to the file's current contents (see [Metadata at rest](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)). Absent on browsers without the API (each attended run re-selects the file) and in any imported record: the handle is a device- and profile-local platform object stored by structured clone, with no file serialization, so the export artifact omits it and the first run after an import re-acquires one by selection. |
| `sharedSecret` | string (base64url, 43 chars / 32 bytes) | The **current** rotated shared secret, matching `SHARED_SECRET_REGEX` (see [EXCHANGE_FILE.md](EXCHANGE_FILE.md)) -- the `.psilink.key` analog the exchange-file document deliberately never carries. This is the one at-rest secret in the record. Rotated after every successful run and re-persisted before the run is treated as succeeded (see [Persist-before-success ordering](#persist-before-success-ordering)). |
| `expires` | string (ISO 8601, UTC `Z`) or absent | The instant after which `sharedSecret` must not be used; the recovery when it lapses is re-invite. Absent means no bound is in force. The record inherits the CLI key file's **consumer** semantics for `expires` -- one field, one meaning to every consumer (see [Two sources, one `expires`](../SECURITY_DESIGN.md#two-sources-one-expires), a citation about meaning, not sourcing) -- while its **provenance** is single-source: only the max-age stamp below writes it, the invitation's setup lifetime having been consumed at provisioning. |
| `tokenMaxAgeDays` | integer or absent | The operator's max-token-age policy for this exchange, the browser analog of the CLI `authentication.token_max_age_days`, and like it **off by default**: absent means no bound is in force, and a record is created with it absent unless the operator sets one. When set, each successful run stamps `expires` this many days out onto the rotated secret. The reason to opt in is a dormant partnership: rotation caps exposure only for an exchange that actually runs, so an idle stored secret has no automatic exposure bound without it (see [The primary controls](../SECURITY_DESIGN.md#the-primary-controls)). |
| `schedule` | object or absent | The partnership-agreed run schedule the unattended path executes: the agreed recurrence and run window -- the schedule is partnership-level agreement, coordinated out-of-band exactly as the terms are -- plus the retry bookkeeping for a missed window (the next planned attempt). Closed shape: timestamps, durations, and enums, no free text, under the same no-narrative constraint as `lastRun`. Absent for an exchange run attended-only. The field-by-field layout is in [The `schedule` object](#the-schedule-object). |
| `lastRun` | object or absent | Run bookkeeping the backup state and the tiered desync UX read (see [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md)): `at` (ISO 8601 UTC), `outcome` (`"succeeded"` \| `"failed"` \| `"desynced"` \| `"missed"`), and, for a non-succeeded outcome, an optional `failureKind` (`"auth"` \| `"transport"` \| `"storage"` \| `"input"` \| `"cancelled"`). A `"missed"` outcome records an agreed window that passed without a completed handshake (a runner no-show on either side); it is benign, retried at the next window, and never routed through the desync/attack framing (see [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#a-missed-window-is-neither-desync-nor-attack)). An `"input"` failure records a benign pre-run input problem -- the handle's file missing at run start, or contents the column-shape guard rejects -- detected before any connection, likewise never routed through that framing. A **re-invite clears `lastRun`** in the same rotation transaction that advances the fresh secret: the re-invite is the recovery for the failure the entry recorded, so leaving it would re-derive a consumed tier at the next visit -- and once the import marker is cleared alongside, a stale `"auth"` failure would re-derive as the attack tier rather than the benign import one. A successful run instead advances `lastRun` to `"succeeded"`; only the re-invite recovery drops it. Every field is a timestamp or a closed enum -- there is deliberately **no free-text field**, so the run bookkeeping structurally cannot carry a match result, a count, or a row value; the constraint is the type, not a prose promise. |

Everything in this table except `sharedSecret` is non-secret but not
non-sensitive: together the persisted fields disclose the partnership's
existence and shape -- who links with whom, over which field categories, on
what agreed schedule, whatever the document's operator-authored free-text
fields carry (see the `exchangeFile` row), and, when a handle is persisted,
from which named input file -- to any reader of the store. That
presence-and-shape disclosure, and why none of the secret-centric controls
reduce it, is analyzed in [Metadata at
rest](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape).

#### The connection block: credential-free by composition

For the browser path the document's connection block is the `webrtc` channel
restricted to its credential-free locator subset: `server` locator fields only
(`host`/`port`/`path` -- no `server.username`, no PeerJS `key`), and no
`turn`, `ice_provision`, or `provider_options` entries (a TURN entry carries
relay credentials, and the provider map is opaque and `@`-file-pathed). This
party's side lives in the local `side` field, not the document (see [Role: a
local `side` field](#role-a-local-side-field-not-the-document)). The full shared schema **can** represent those
credential-bearing fields, so the guarantee comes from composition, exactly as
in the mint layer: the record composer assembles the connection from a
credential-free locator input and persists the schema's parse result. The
downloadable-file mint path's credential-free input union covers only the
file-sync channels (a webrtc exchange is coordinated live, not from a
downloadable file), so core carries the composer's webrtc arm as three
distinct pieces: a credential-free `WebRTCExchangeLocator` type
(`host`/`port`/`path` only); a `webrtc` arm in `connectionFromLocator`, the
locator-to-connection expansion in `packages/core/src/config/exchangeFile.ts`;
and the composition guarantee extending to the nested `server` object's two
credential fields (`server.username` and the PeerJS `server.key`), which the
flat file-sync locators never had to exclude. The webrtc locator is the
invitation's endpoint schema (`WebRTCEndpointSchema`,
`packages/core/src/config/invitation.ts`), which is already credential-free by
schema, so there is one locator source of truth rather than two, and the
locator-to-connection expansion validates through it -- rejecting any field
outside the allowlist rather than letting the non-strict webrtc connection
schema silently strip it. The composition rule, not a strip pass, is the
enforcement.

#### Role: a local `side` field, not the document

The record's local `side` field (`"inviter"` \| `"acceptor"`) dispatches a
re-run to the right rendezvous flow: the web selects its role by **which
function runs** -- `listenAsInviter` or `dialAsAcceptor`
(`apps/web/src/psi/rendezvous.ts`), each hardcoding its peer-id derivation
label and its handshake role (the inviter is the `"responder"`, the acceptor
the `"initiator"`). The document's `connection.role` field is deliberately not
used for this: it is schema-only, nothing reads it, and the record does not
change that -- the document is persisted untouched.

On the webrtc re-run path the document's `server` locator is likewise inert: the
inviter derives its signaling location from `window.location`, and the
acceptor's came from the invitation endpoint at accept time. The connection
block is persisted for document fidelity -- the document is kept verbatim, per
the CLI-parity contract above -- not because the webrtc re-run reads it.

#### Versioning: an app upgrade can invalidate a stored record

A persisted document is subject to the exchange-file versioning and
compatibility policy (see
[EXCHANGE_FILE.md](EXCHANGE_FILE.md#versioning-and-compatibility-policy)): the
web app is continuously deployed, there is no back-compatibility promise for
existing artifacts, and an unknown enum value rejects loudly at load. An app
upgrade can therefore invalidate a stored record -- over and above the record's
own `schemaVersion` reader-rejects-unknown rule -- and the recovery is
re-invite: a record the new version cannot load is re-established from a fresh
invitation rather than hand-migrated, matching the policy's guidance for every
other artifact of this schema.

That evolution path -- reject, re-invite, re-create -- is also how the shape
grows: a future schema revision adds its fields under a new `schemaVersion`,
rather than the v1 record carrying speculative, structurally always-absent
seams.

### The schedule object

The optional `schedule` object carries the partnership-agreed run cadence, the
run window the two runners meet in, and the miss bookkeeping the retry policy
reads. It is present only when the operator saved the exchange as recurring;
an attended-only exchange omits it. Every field is a timestamp, an integer
duration, or a closed enum -- no free text, the same no-narrative constraint
`lastRun` carries -- so the object cannot quietly accumulate schedule narrative
beyond what the metadata-at-rest analysis covers (see
[Metadata at rest](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)).

| Field | Type | Notes |
| ----- | ---- | ----- |
| `anchor` | string (ISO 8601, UTC `Z`) | The instant of the first agreed window's open, the phase the recurrence counts from. Both parties persist the **same** `anchor`, agreed out-of-band with the rest of the schedule, so both runners compute the same window opens. Stored UTC; a local-time cadence ("09:00 Tuesdays") is resolved to UTC at save and re-resolved only when the operator edits the schedule, so a daylight-saving shift does not silently move an unattended window. |
| `intervalDays` | integer, at least 1 | The recurrence period in whole days: the run window opens every `intervalDays` after `anchor`. A whole-day integer covers the daily, weekly, and monthly-approximated (for example 28- or 30-day) cadences the persona runs; sub-day cadences are out of scope for a partnership coordinated out-of-band, and calendar-month recurrence (the drifting "1st of the month") is deliberately not modeled -- an integer period keeps both runners' window computation identical without a shared calendar library. |
| `windowSeconds` | integer, at least 1 | The run window's width: window *n* is open from `anchor + n * intervalDays` for `windowSeconds`. The width is chosen to dwarf realistic clock skew between the two machines (see [Clock skew](#clock-skew-and-the-window-width)); a several-hour width is the intended range, not a several-minute one. The structural floor is one second, but schedule entry enforces a UX-level minimum on the order of an hour: width is the only skew mitigation the design has, so a seconds-wide window would guarantee perpetual self-inflicted misses. |
| `nextWindow` | string (ISO 8601, UTC `Z`) | The open instant of the next window the runner plans to attempt. Derived from `anchor`, `intervalDays`, and the run bookkeeping (advanced past a completed or missed window), it is persisted rather than recomputed so a reader -- the runtime waking, or a next-visit surface -- sees the planned attempt without replaying history. After a miss it is the **next** window, never a sooner off-schedule retry: retry-at-next-window is the whole retry policy (see [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#retry-and-repeated-misses)). A runtime that wakes to find it in the past applies the catch-up rule below before anything else (see [Catch-up on wake](#catch-up-on-wake)). |
| `consecutiveMisses` | integer, at least 0 | The count of consecutive agreed windows that passed without a completed handshake, **regardless of which side was absent**: a window this runner sat out waiting for a peer that never arrived counts exactly as one this runner itself slept through (the latter recorded retroactively; see [Catch-up on wake](#catch-up-on-wake)). A `"succeeded"` outcome resets it to 0; a `"missed"` outcome increments it; **any other outcome leaves it unchanged**, because only a no-show signals the two runners are not meeting. A handshake that ran and failed (`"failed"`/`"desynced"`) means the partnership *did* meet, so it is a desync/attack question, not a coordination-drift one; a benign pre-peer `"input"` failure is likewise not a partner no-show. It drives only the surfacing of a repeated-miss coordination problem, whose escalated state fires at **two** consecutive misses (see [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#retry-and-repeated-misses)); it never pauses the schedule and never changes `nextWindow`'s cadence. |

The object holds no operator-facing recurrence label, no timezone name, and no
window-outcome history: `anchor` plus `intervalDays` plus `windowSeconds` fully
determine every past and future window, and `lastRun` already carries the most
recent outcome. A per-window outcome log would be exactly the narrative the
no-free-text constraint excludes, and it is unnecessary -- `consecutiveMisses`
is the only cross-window state the retry policy needs.

The schedule is a **local-only** field, not part of the persisted
`exchangeFile` document: a reschedule is neither a terms change nor a credential,
so it must not force the re-invite a document change requires (see [Record
shape](#record-shape)), and the CLI would carry it inertly. Each party enters it
locally at save-as-recurring, agreed out-of-band exactly as the terms and the
setup secret are (see
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#invitation-contents-and-confidentiality)).
Normatively: neither the invitation wire format nor the exchange-file document
carries the schedule, and no schedule field is ever sent to a server or to the
partner over the wire. Two parties who enter mismatched values never share an
overlapping window and record mutual misses until they reconcile out-of-band --
a benign coordination failure, never a desync or an attack. The operational
framing is in
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#where-the-schedule-is-agreed-and-where-it-lives).

#### Catch-up on wake

A runner does not tick while its machine sleeps, so a runtime can wake -- a
laptop reopened after a week on a daily cadence, the app relaunched after a
reboot -- with `nextWindow` in the past and one or more windows fully elapsed.
On wake, before attempting anything, the runner applies one catch-up rule:

- Every fully-elapsed, unattempted window counts as **one miss each**:
  `consecutiveMisses` is incremented by the count, and `lastRun` records the
  most recent elapsed window as `"missed"`.
- `nextWindow` advances past every fully-elapsed window to the first window not
  yet closed: if the current instant falls inside that window, the runner
  attempts it immediately; otherwise `nextWindow` is the first window opening
  after the current instant.

The rule keeps both fields honest. `consecutiveMisses` reflects the true count
of elapsed misses whichever side was absent, and the runner lands on a live
window rather than replaying stale past ones. Crossing the two-miss escalation
threshold during catch-up fires the repeated-miss surface at the wake -- which
is how a persistently absent party learns of a miss pattern late rather than
never (see
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#retry-and-repeated-misses)).

The import path is the rule's second consumer: an imported backup carries the
snapshot's `nextWindow`, typically in the past by the time the artifact is
restored, and the first wake after an import applies the same catch-up --
elapsed windows counted, `nextWindow` advanced to a live window -- before any
attempt.

### Clock skew and the window width

The two runners never exchange a clock reading; each opens and closes its window
by its own machine clock against the shared `anchor` and `intervalDays`, so an
overlapping window depends on both clocks agreeing closely enough. The mitigation
is width, not synchronization: `windowSeconds` is chosen to dwarf realistic skew
(a several-hour window against the seconds-to-minutes skew of a machine with any
working time source), so two reasonably-set clocks overlap comfortably and only a
grossly wrong clock on one side turns a scheduled run into a benign miss. The
design adds no time-sync protocol; a persistently miss-producing clock is a
local operational problem the miss surfacing (see
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#retry-and-repeated-misses)) points
the operator at, resolved by fixing the machine's time source, not by the app.

### Re-supplied each run

These are never persisted in the record. They are supplied at each run -- by
the scheduled runtime, or by the operator on an attended run.

| Input | Why it is not persisted |
| ----- | ----------------------- |
| The input file's contents | Never persisted -- the record holds a pointer at most (`inputFileHandle` above), never content. Each run re-reads the operator's file: through the persisted handle (unattended, or one action attended) where the File System Access API exists, by re-selection elsewhere. The file is read in the browser and never uploaded, exactly as the one-shot flow reads it (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#invitation-contents-and-confidentiality)). See [The input file each run](../MANAGED_EXCHANGE.md#the-input-file-each-run). |
| Any connection credential | The persisted document's connection block is composed from a credential-free locator (see [The connection block](#the-connection-block-credential-free-by-composition)), so no credential is representable in the record. |
| The live rendezvous / peer id | Derived fresh each run from `sharedSecret` under the label the local `side` field selects (see [Derived, never stored](#derived-never-stored)); storing it would duplicate a value that changes with every rotation. |
| The session key and AEAD keys | Ephemeral per run; derived by the handshake and discarded after. Never persisted. |

## The secret is a linear resource

The persisted `sharedSecret` is the single most consequential field, because it
is not an ordinary cache entry: it is a **linear resource**. After a successful
run, both parties independently derive the same replacement secret from the
key-exchange session key and the old secret is retired; there is exactly one live
secret shared between the two parties at any time, and neither party keeps the
old one. Two consequences follow, and both are normative:

### Single-owner invariant

A managed record's `sharedSecret` must be advanced (used to run, then rotated and
re-persisted) by **one device only**. If two devices both hold a copy and both
run, they fork the secret permanently: after the first device rotates, the second
device's copy is stale, and no automatic reconciliation exists (there is no grace
window; see [Desync detection and
recovery](../MANAGED_EXCHANGE.md#desync-detection-and-recovery)). The guard on a
single device is a cross-tab single-writer lock over the run+rotate critical
section (Web Locks); export/import between devices is **migration, not sync** (the
source copy is invalidated on export). Both are specified in
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#single-device-ownership).

### Persist-before-success ordering

The rotated secret must be durably persisted **before** this party begins the
data exchange -- the first peer-visible act after the handshake. The protocol
has no discrete peer-visible success signal to gate on: both sides rotate at
handshake completion, and the exchange's terminal act is a fire-and-forget final
send, so the data exchange itself is what the persist must precede. Concretely,
within a single run:

1. The handshake completes and yields the `AuthResult`
   (`{ sessionKey, rotatedSecret, applyEncryption }`; see
   [PROTOCOL.md](PROTOCOL.md#shared-secret-rotation)).
2. `sharedSecret` (and `expires`, refreshed from `tokenMaxAgeDays` when a
   policy is set) is written to
   IndexedDB in a transaction opened with **`{ durability: "strict" }`**, and the
   write is awaited to the transaction's `complete` event, before step 3. Strict
   durability requests OS writeback before `complete` fires; the default
   (relaxed) durability fires `complete` once the write is visible in-process,
   **before** OS writeback -- surviving a tab or renderer crash but not an OS
   crash or power loss. Strict narrows that gap without closing it (it is
   honored variably across engines and is still not a forced media flush).
3. Only then does the party begin the data exchange and, on completion, mark
   `lastRun.outcome = "succeeded"`.

This is the browser analog of the CLI's persist-then-exchange ordering, where the
key file is written (through an atomic, fsync-durable path) immediately after the
handshake rotates the secret and before the data exchange runs (see
[CREDENTIAL_STORAGE.md](CREDENTIAL_STORAGE.md#posix-write-discipline)). Its
guarantee is precisely scoped: it eliminates **this party's contribution** to
the desync window and provides renderer-crash consistency. It does not cover the
partner's independent persist failure -- neither side can know whether the
other's save succeeded, the same one-sided limit the CLI states when its
key-file write fails after rotation -- nor an OS crash or power loss under the
durability limits above, nor wholesale storage eviction (see
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#surviving-storage-eviction)). That
residual is covered by fast re-invite, not a stronger at-rest guarantee.

## Derived, never stored

Two per-run values are always derived from the persisted `sharedSecret` and never
themselves persisted, so persisting the secret is sufficient to reconstruct them
and there is no second value to keep consistent with it:

- **The rendezvous peer id.** Derived via HKDF over the decoded 32-byte secret
  with a zero salt and info `psilink-webrtc-peerid-v1:<role>` (`<role>` being
  `inviter` or `acceptor`), output 16 bytes, lowercase hex. Because it derives
  from the secret, it changes with every rotation, so it cannot be a stored
  field -- storing it would strand a stale id after a rotation. The construction
  is specified in [PROTOCOL.md](PROTOCOL.md#webrtc-rendezvous-peer-id-derivation).
- **The rotated replacement secret.** Derived via HKDF over the session key with
  info `psilink-shared-secret-rotation-v1` (see
  [PROTOCOL.md](PROTOCOL.md#shared-secret-rotation)). It is written into
  `sharedSecret` by the persist-before-success step above; the derivation itself
  is core's.

The managed record introduces no new KDF, info string, or salt: it persists the
same 32-byte secret the invitation and rotation already define, and every
derived value uses the existing labels above. The record's own at-rest hygiene
(see
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges))
is a secondary control layered over that secret, not a change to how it is
derived or rotated.

## Export artifact

The managed record can be exported to a file for device migration and
eviction recovery (see [the durability
backbone](../MANAGED_EXCHANGE.md#the-durability-backbone-exportimport)).
The artifact's shape and custody model:

- **Contents.** The persisted record fields above -- the exchange-file document
  plus `sharedSecret`, `expires`, the schedule, and the local bookkeeping: the
  browser analog of handing over `psilink.yaml` and `.psilink.key` together --
  **minus the input-file handle**: a `FileSystemFileHandle` is a device- and
  profile-local platform object with no file serialization, so the export omits
  it and the first run after an import re-acquires one (a one-time selection).
  The record's `id` is likewise not carried: it is a device-local record
  identifier, not partnership data, and an import is a **take-over that mints a
  fresh local record**, not a copy of the source's identity. The artifact does
  not rotate -- it snapshots the secret current at export -- so a stale artifact
  stays usable until the partnership rotates past it or any `expires` it carries
  (stamped when a max-age policy is set) lapses; the backup state prompts
  re-export after each rotation.
- **Top-level shape.** The artifact is a JSON document with an `artifactVersion`
  tag (its own reader-rejects-unknown literal, distinct from the record's
  `schemaVersion` -- the on-disk artifact format versions independently of the
  stored record) and three parts that keep the two CLI halves separable from the
  browser-only fields: `exchangeDocument` embeds the exchange-file document as a
  valid `psilink.yaml` (the snake_case YAML the CLI loads, serialized through the
  same discipline the mint layer applies to a validated spec); `key` is the
  `.psilink.key` pair (`sharedSecret` and, when a bound is in force, `expires`);
  and `local` carries the browser-only fields the two CLI artifacts do not
  (`label`, `side`, `schedule`, `lastRun`, `tokenMaxAgeDays`). The artifact's own
  JSON keys are `camelCase`, deliberately: the `.psilink.key` file the CLI reads is
  itself `camelCase` JSON (`sharedSecret`, `expires`), parsed without a
  `snake_case` conversion, so a `camelCase` `key` block is what maps onto a valid
  key file with no renaming. Only the embedded `exchangeDocument` is `snake_case`,
  because the CLI loads it as YAML through `camelizeKeys`.
- **CLI-separable format.** The record is the CLI's config-plus-key pair kept
  as one browser object, and its export stays consumable by the CLI toolchain
  rather than becoming a third format: the embedded `exchangeDocument` is a
  valid `psilink.yaml`; the `key` block's `sharedSecret` and `expires` pair maps
  onto a valid `.psilink.key` (the block can be lifted out verbatim -- the field
  names already match the key file's); and the `local` block's fields are cleanly
  separable and ignorable. This is a format-compatibility commitment, not a
  claim the embedded exchange runs there (the CLI has no WebRTC transport).
- **Plaintext, custody-protected.** The artifact is a plaintext credential file,
  not passphrase-encrypted. Passphrase encryption is deliberately not done: the
  record must be usable with nobody present to supply a passphrase, and the
  artifact adopts the CLI key file's trust model instead. `.psilink.key` is a
  plaintext credential protected by custody and storage permissions, not by a
  passphrase, and the export asks for the same handling -- owner-only storage,
  never an unencrypted transmission channel, the backup guidance in [Key file
  security](../SECURITY_DESIGN.md#key-file-security) (an operator who wants
  encryption at rest stores the file in an encrypted location or secrets
  manager, exactly as the CLI's backup guidance says).
- **A captured export is a captured credential.** It stays usable until the
  partnership rotates past it -- which a dormant partnership may not do for
  months -- so the response to a lost or copied artifact is the [compromise
  response](../SECURITY_DESIGN.md#compromise-response) (notify the partner
  out-of-band, re-invite), not quiet deletion.
- **No anti-rollback.** The record carries no rotation epoch and no history, and
  the handshake gives the partner no way to recognize a superseded copy, so a
  restored artifact (or a browser-profile/VM snapshot) silently re-arms whatever
  secret it holds: still-current (the captured-credential case above) or
  rotated-past (a guaranteed desync at the next run). Source invalidation on
  export is an operator-cooperation property, not a cryptographic one. A
  monotonic rotation epoch carried in the record and checked in the handshake
  would let a party detect a stale or forked peer; it is a future core hardening,
  deferred alongside the grace-window mitigation (see
  [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#rollback-at-rest-copies-can-silently-resurrect)).

### The backup marker, the spent state, and the import marker: local siblings, never in the artifact

Three pieces of derived-backup, migration, and restore state live **beside** the
record, in a separate origin-local store keyed by the record `id`, and are
**neither record fields nor artifact contents**:

- **The backup marker** (`backedUpAt`, an ISO 8601 UTC instant) records when a
  backup was last taken. It is the input to the derived backup state the UI
  surfaces (see [Moment-anchored backup
  surfaces](../MANAGED_EXCHANGE.md#moment-anchored-backup-surfaces)), which is
  simply **marker present / absent**: a present marker is "backed up", no marker is
  "backup needed". "Taken since the last rotation" is enforced **structurally**, not
  re-derived from `lastRun`, by two write-side rules:
  - **Export binds the marker to the bytes it serialized.** Every export reads the
    current record and stamps the marker in one atomic store step (a cross-store
    read-and-mark), then downloads exactly the bytes it read, so the marker can only
    ever attest the secret the file carries. A stale tab or a stale in-memory record
    cannot mark a secret it did not serialize.
  - **Rotation clears the marker.** The persist-before-success rotation write clears
    the marker in the **same** transaction that advances the secret, so a rotation
    stales any prior export the instant it lands -- independent of how the run is
    later classified (a run that rotates and then fails in the data exchange has
    still rotated, and its marker is already gone). "Marker present" therefore means
    "an export containing the current secret was taken since the last rotation".

  The marker is a **plain timestamp**, honoring the derived-never-stored rule: it is
  no digest, fingerprint, or other secret-derived value, and there is no rotation
  epoch. `navigator.storage.persisted()` is never an input to the derivation, so a
  granted persist cannot suppress the actionable "backup needed" state (see
  [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges)).
- **The spent state** (`spentAt`, an ISO 8601 UTC instant) records that a
  migration export handed this device's copy off. It transitions the source to a
  visible spent state -- no Run affordance, no scheduled runs, labeled with the
  handoff date -- so the operator-cooperation invalidation is legible at the one
  moment it is violable. The spend is **operator-attested, not dispatch-anchored**:
  a download dispatch (`anchor.click()`) gives no landing signal, so a cancelled or
  failed save must not spend the source. The migration export downloads the artifact
  and marks the source backed-up on dispatch (a spent source has a current artifact
  by construction), then writes `spentAt` only after the operator confirms the file
  is saved; a dismissed dialog leaves the source live and recoverable. It too is a
  plain timestamp, no secret material and no epoch; importing the artifact back
  clears it (a **revive-in-place**: an import whose secret matches the spent record's
  updates that record's fields, keeps its `id` and input handle, clears the spent
  state, and marks it imported and backed-up, rather than installing a duplicate).
- **The import marker** (`importedAt`, an ISO 8601 UTC instant) records that this
  device installed or revived the record from a backup artifact. It is the evidence
  the desync tiering reads to tell an **import/restore since the last successful run**
  apart from an unexplained handshake failure (Tier 1 versus Tier 2; see
  [Telling a desync from an attack](../MANAGED_EXCHANGE.md#telling-a-desync-from-an-attack)):
  a restored copy can hold a secret the partnership has rotated past, so a
  handshake failure while this marker stands is the benign import tier (recovery:
  re-invite), not the attack path. "Since the last successful run" is enforced
  **structurally**, not by comparing timestamps, by two write-side rules that mirror
  the backup marker's:
  - **Import stamps it.** A fresh install and a revive-in-place both stamp
    `importedAt` (alongside the backup marker) as of the import instant, so a
    restored record carries the evidence from the moment it lands.
  - **Rotation clears it.** The persist-before-success rotation write clears the
    import marker in the **same** transaction that advances the secret. A rotation is
    driven by a completed handshake, which proves the two parties held the same
    secret, so a successful run **consumes** the evidence -- the marker's mere
    presence therefore means "restored and not yet successfully run since". This is
    what stops a stale import from shielding a later, genuinely-unexplained handshake
    failure (the secret-farming caveat: a benign reading is offered only when the
    record's own structured evidence still explains the failure).

  It too is a **plain timestamp**, no secret material and no rotation epoch.

All three are **local siblings by design**: the marker's currency input, this
device's spent status, and this device's restore history must not travel in the
export artifact -- an imported copy is a fresh live owner, for which "the source
last backed up on X", "the source was spent", or "the source was imported on X" is
meaningless -- and the record schema is reader-rejects-unknown, so carrying any of
them on the record would force a new `schemaVersion` or leak into the artifact.
Keeping them siblings makes their non-inclusion **structural**: the exporter reads
only the record. Deleting a managed exchange removes the record and its sibling
state together (see [Deleting a managed
exchange](../MANAGED_EXCHANGE.md#deleting-a-managed-exchange)).

## See also

- [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md) - the managed exchange lifecycle: who it serves, the automation goal and platform envelope, durability contract, single-owner invariant, desync story, eviction survival, and the moment-anchored backup surfaces
- [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges) - the browser at-rest threat model for the persisted secret: the primary controls, the rollback and metadata-at-rest analyses, and the egress-hardening limits
- [EXCHANGE_FILE.md](EXCHANGE_FILE.md) - the exchange-file artifact and the credential-free endpoint locator the record composes from
- [PROTOCOL.md](PROTOCOL.md#shared-secret-rotation) - the shared-secret rotation and rendezvous-peer-id derivation constructions
- [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md) - the self-attested per-run disclosure record (a distinct artifact; the managed record is not a disclosure log)
</content>
