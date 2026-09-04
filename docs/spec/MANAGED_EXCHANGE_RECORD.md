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
on, the local sibling stores beside the record (the backup, spent, and import
markers, and the accounting of disclosures each run files its record into), and
the export artifact's custody model and rollback caveats. It is the
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

> **Normative, not aspirational:** the [persist-before-success
> ordering](#persist-before-success-ordering) and the [single-owner
> invariant](#single-owner-invariant) below bind any implementation of this
> record. Sections that specify design intent rather than shipped behavior say
> so at their own head.

## What the record is, and what it is not

A managed exchange record is the minimal state a party's own browser retains so
that a recurring exchange with the same partner, over the same terms, can be run
again. It is **not** a saved copy of the exchange's inputs or outputs:

- **It never holds the input data, nor any row value derived from it.** The
  record holds a **pointer** to the operator's file at most, never a copy of
  its contents (`inputFileHandle` under [Persisted across
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
that document does not hold. This is the CLI-parity shape: what
the CLI keeps as `psilink.yaml` plus `.psilink.key`, the browser keeps as one
record. Persisting the whole document, rather than a bespoke subset of its
fields, keeps the record from becoming a parallel format of the kind the
no-parallel-format contract in [EXCHANGE_FILE.md](EXCHANGE_FILE.md) exists to
prevent. `camelCase` on the TypeScript side; the persisted key names below are
the normative field names.

The two bookkeeping fields, `schedule` and `lastRun`, hold **no free text**:
every field of each is a timestamp, an integer duration, or a closed enum, so
neither can accumulate narrative, a match result, a count, or a row value. The
constraint is the type, not a prose promise.

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
| `schemaVersion` | string literal | The single recognized literal for v1, `psilink-managed-exchange/v1`; a reader rejects any other value rather than migrating it, matching the reader-rejects-unknown rule the exchange-record and verification-keys files follow (see [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md)). |
| `id` | string (UUID) | A locally-generated identifier for this managed exchange, distinct from any rendezvous id. Used only to name the record in local UI; never sent on the wire. |
| `label` | string, at most 120 characters (enforced at write) | An operator-supplied display name for the partnership. Local only; never sent -- but disclosed to any reader of the store (see [Metadata at rest](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)). The length cap is enforced; the content guidance is not and cannot be: keeping agreement numbers, contact details, and other sensitive counterparty detail out of the label is **operator cooperation**, exactly as export-source invalidation is -- the field's only structural protections are the cap and its never-sent locality. |
| `exchangeFile` | object | This party's exchange-file document, verbatim: the validated `ExchangeSpec` shape both applications share (see [EXCHANGE_FILE.md](EXCHANGE_FILE.md), "The artifact is the CLI config schema") -- the linkage terms both parties validated (column **shape** and disclosed payload column **names**, never a row value), metadata, standardization, any payload-column commitments, the acceptor's own outbound-payload consent record (see [EXCHANGE_FILE.md](EXCHANGE_FILE.md#payload-disclosure-consent), "Payload-disclosure consent"), the acceptor's `expectedPartnerDeduplicate` -- the cardinality side the accepted invitation declared for the partner, which a re-run holds the partner to (see [EXCHANGE_FILE.md](EXCHANGE_FILE.md#terms-binding-consent), "Terms-binding consent") -- and the connection block. It has **no `authentication` block** (the secret lives in `sharedSecret` below) and is composed exactly as the mint layer composes a downloadable file: assembled from a credential-free locator input, validated through the shared schema, with the **parse result** (never the raw input) persisted. The document's operator-authored free-text fields persist verbatim with it: each metadata column's optional `description` (no schema length bound), each standardization step's `params` (an open parameter map -- an authored cleaning step can embed a literal value, a pattern or a replacement string), and `retentionDisposition` (bounded at 1024 characters, the config schema's text bound), plus the terms' own 1024-bounded payload `description` and legal-agreement `purpose` strings. The record stores the document as minted, so the content guidance for these fields is the same **operator cooperation** the `label` row describes, and no additional bound or strip pass runs at persist time: the document is kept verbatim, and a document the mint layer accepts must remain saveable as managed (see [Metadata at rest](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)). The document is immutable for the partnership: a re-invite re-issues it verbatim with only a fresh secret, and exchanging on different terms is a new exchange, not an edit or re-invite of this record. |
| `side` | enum (`"inviter"` \| `"acceptor"`) | This party's side of the partnership; dispatches a re-run to the matching rendezvous flow (see [Role: a local `side` field](#role-a-local-side-field-not-the-document)). Local-only by design -- not the document's `connection.role`, which no web path reads. |
| `inputFileHandle` | `FileSystemFileHandle` or absent | A persisted **pointer** to the operator's input file, held where the File System Access API exists (Chromium), with persistent read permission where the platform grants it (an installed app), so an unattended run reads the standing file with nobody present and an attended re-run is one action. It is a reference, never a copy: no input content or row value derived from it persists, which is where the no-second-copy invariant is enforced. It is also live, not a snapshot: each run calls `getFile()` at run start and reads whatever file currently exists at the path -- a `File` object is a point-in-time reference, so `File` objects are never retained across runs -- which is what makes dropping the current period's extract over the same name the data-refresh workflow. A missing entry at run start fails the file read with a clean not-found, recorded as a benign `"input"` failure (see `lastRun`), never routed through desync/attack framing. What it does add to the store's disclosure is the input file's **name**, and the granted read permission extends an in-origin reader's reach to the file's current contents (see [Metadata at rest](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)). Absent on browsers without the API (each attended run re-selects the file) and in any imported record: the handle is a device- and profile-local platform object stored by structured clone, with no file serialization, so the export artifact omits it and the first run after an import re-acquires one by selection. |
| `sharedSecret` | string (base64url, 43 chars / 32 bytes) | The **current** rotated shared secret, matching `SHARED_SECRET_REGEX` (see [EXCHANGE_FILE.md](EXCHANGE_FILE.md)) -- the `.psilink.key` analog the exchange-file document never holds. This is the one at-rest secret in the record. Rotated after every successful run and re-persisted before the run is treated as succeeded (see [Persist-before-success ordering](#persist-before-success-ordering)). |
| `expires` | string (ISO 8601, UTC `Z`) or absent | The instant after which `sharedSecret` must not be used; the recovery when it lapses is re-invite. Absent means no bound is in force. The record inherits the CLI key file's **consumer** semantics for `expires` -- one field, one meaning to every consumer (see [Token age and rotation policy](../SECURITY_DESIGN.md#token-age-and-rotation-policy), a citation about meaning, not sourcing) -- while its **provenance** is single-source: only the max-age stamp writes it, the invitation's setup lifetime having been consumed at provisioning. Two write paths stamp it -- a successful run's rotation write-back and an operator's in-place edit of `tokenMaxAgeDays` -- both under the same never-move-later rule (see [Edit-time re-derivation of `expires`](#edit-time-re-derivation-of-expires)). |
| `tokenMaxAgeDays` | integer or absent | The operator's max-token-age policy for this exchange, the browser analog of the CLI `authentication.token_max_age_days`, and like it **off by default**: absent means no bound is in force, and a record is created with it absent unless the operator sets one. When set, each successful run stamps `expires` this many days out onto the rotated secret. The reason to opt in is a dormant partnership: rotation caps exposure only for an exchange that actually runs, so an idle stored secret has no automatic exposure bound without it (see [The primary controls](../SECURITY_DESIGN.md#the-primary-controls)). It is a **local field** the operator may edit in place without a re-invite; what the edit does to `expires` is [Edit-time re-derivation of `expires`](#edit-time-re-derivation-of-expires). |
| `schedule` | object or absent | The partnership-agreed run schedule the unattended path executes: the agreed recurrence and run window -- the schedule is partnership-level agreement, coordinated out-of-band exactly as the terms are -- plus the retry bookkeeping for a missed window (the next planned attempt). Absent for an exchange run attended-only. The field-by-field layout is in [The `schedule` object](#the-schedule-object). |
| `lastRun` | object or absent | Run bookkeeping the backup state and the tiered desync UX read (see [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md)): `at` (ISO 8601 UTC), `outcome` (`"succeeded"` \| `"failed"` \| `"desynced"` \| `"missed"`), and, for a non-succeeded outcome, an optional `failureKind` (`"auth"` \| `"transport"` \| `"storage"` \| `"custody-unreadable"` \| `"input"` \| `"terms-shortfall"` \| `"consent"` \| `"handed-off"` \| `"cancelled"`). A `"missed"` outcome records a no-show: the wait for the other party's runner spent its whole budget with nobody arriving, so no handshake ran. A scheduled run reaches it when an agreed window passes without a completed handshake; an attended run reaches it when its own wait for the partner expires. It has no `failureKind` -- the outcome is the whole account, and it is held apart from `"transport"` (a connection that was made and broke, whose remedy is retrying the connection) and from `"cancelled"` (the operator stopped the run). It is benign, retried at the next window or whenever the operator runs the exchange again, and never routed through the desync/attack framing (see [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#a-missed-window-is-neither-desync-nor-attack)). An `"input"` failure records a benign pre-run acquisition problem -- the handle's file missing, moved, or unreadable at run start -- detected before any connection, likewise never routed through that framing; putting the file back clears it, so its surface offers the run again. A `"terms-shortfall"` failure records the other benign pre-run input state, held apart from it because its remedy is not another attempt: the file was read and cannot satisfy every linkage key the standing terms declare, so the run is refused before connecting (by the run-start input guard, or by the run boundary's own `assertLinkageTermsSatisfiable` inside the pre-connection prepare), and the same file refuses identically at the next window. Its remedy is a file covering every agreed key, or terms re-agreed with the partner out of band -- never a retry or a bare re-pick. A `"consent"` failure records the third pre-connection refusal: a send-side disclosure gate refused because the set this run would send is not the one the exchange recorded agreeing to send (see [What the setup consent covers across runs](../MANAGED_EXCHANGE.md#what-the-setup-consent-covers-across-runs)). It is likewise benign and outside that framing. A `"handed-off"` failure records the fourth: the run found this device's copy [spent](#the-backup-marker-the-spent-state-and-the-import-marker-local-siblings-never-in-the-artifact) by an export and refused inside the run+rotate lock, before reading the input file and before connecting, rather than rotating a secret whose owner is now elsewhere. It is the single-owner invariant holding rather than a fault, so it too stays outside the desync/attack framing, and it is the record's own account of a run -- attended or scheduled -- that met a hand-off nobody was present to answer for. A `"custody-unreadable"` failure records the fifth, and it is that same refusal failing to read the entry it decides on: the sibling entry did not validate, or its store did not answer, so the run stopped in the same place rather than rotating on custody it could not establish. It is held apart from `"storage"` because the two leave different states behind -- a `"storage"` failure rotated a secret it could not save, which can leave the two parties holding different ones and is recovered by re-inviting, while this refusal precedes the handshake and rotates nothing, so nothing here is a desync and a fresh secret would replace one nothing moved. `"consent"`, `"terms-shortfall"`, `"handed-off"`, and `"custody-unreadable"` are the failure kinds a surface must **not** present as retryable: the same input determines the same disclosure and falls the same way short of the same keys, a handed-off copy refuses identically at every later run, and a run reads the same unreadable entry every time, so the remedy is the operator's, not another attempt's. A record written before a kind was added to the enum still reads -- an entry with `"input"` for a shortfall loads and tiers as the generic input state; the converse is the reader-rejects-unknown rule's consequence, an artifact with a kind this reader does not know being refused whole rather than read with the kind dropped. A **re-invite clears `lastRun`** in the same rotation transaction that advances the fresh secret: the re-invite is the recovery for the failure the entry recorded, so leaving it would re-derive a consumed tier at the next visit -- and once the import marker is cleared alongside, a stale `"auth"` failure would re-derive as the attack tier rather than the benign import one. A successful run instead advances `lastRun` to `"succeeded"`; only the re-invite recovery drops it. |

Everything in this table except `sharedSecret` is non-secret but not
non-sensitive: together the persisted fields disclose the partnership's
existence and shape -- who links with whom, over which field categories, on
what agreed schedule, whatever the document's operator-authored free-text
fields hold (see the `exchangeFile` row), and, when a handle is persisted,
from which named input file -- to any reader of the store. That
presence-and-shape disclosure, and why none of the secret-centric controls
reduce it, is analyzed in [Metadata at
rest](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape).

#### The connection block: credential-free by composition

For the browser path the document's connection block is the `webrtc` channel
restricted to its credential-free locator subset: `server` locator fields only
(`host`/`port`/`path` -- no `server.username`, no PeerJS `key`), and no
`turn`, `ice_provision`, or `provider_options` entries (a TURN entry holds
relay credentials, and the provider map is opaque and `@`-file-pathed). This
party's side lives in the local `side` field, not the document (see [Role: a
local `side` field](#role-a-local-side-field-not-the-document)). The full shared schema **can** represent those
credential-bearing fields, so the guarantee comes from composition, exactly as
in the mint layer: the record composer assembles the connection from a
credential-free locator input and persists the schema's parse result. The
downloadable-file mint path's credential-free input union covers only the
file-sync channels (a webrtc exchange is coordinated live, not from a
downloadable file), so core holds the composer's webrtc arm as three
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
the `"initiator"`). The document's `connection.role` field is not
used for this: no web path reads it, and the record does not change that -- the
document is persisted untouched. The field is not inert everywhere, which is why
the local `side` is not redundant with it: on the CLI, `role` is what a webrtc
run derives its own rendezvous peer id from, and `psilink exchange` refuses a
webrtc connection that has none (`apps/cli/src/protocol.ts`). A document the
web composes has no `role` at all -- the locator expansion writes only
`host`/`port`/`path` (see [EXCHANGE_FILE.md](EXCHANGE_FILE.md)) -- so the side a
browser record runs is knowable only from `side`.

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
rather than the v1 record with speculative, structurally always-absent
placeholders.

#### Edit-time re-derivation of `expires`

The `tokenMaxAgeDays` policy is a local field an operator may edit in place
(distinct from a run rotation or a re-invite). Editing it re-derives `expires`
conservatively, under one normative constraint: **an edit never moves `expires`
later**. The bound is a stored-credential exposure bound, so an in-place edit --
which does not rotate the secret -- must not stretch that credential's usable
life; a longer policy set by an edit takes effect only at the **next rotation's**
write-back, which restamps from the real advance instant.

The derivation needs the last-advance anchor -- the creation deposit, run
rotation, or re-invite the current `expires` was stamped from -- but that instant
is not persisted (the record holds only the resulting `expires` and
the policy). It is **reconstructed** as `current expires - previous
tokenMaxAgeDays`, exact whenever a **reconstructable bound** exists: a prior
policy and a parseable current `expires` together. The arms discriminate on that
bound-existence, not on policy-existence, so the import-reachable state
{`tokenMaxAgeDays` present, `expires` absent} -- a record with a policy but no
stamped bound -- falls to the edit-instant anchor exactly as an add-where-none
does, because there is no bound to reconstruct an anchor from. The new bound is
then:

- **Edit with a reconstructable bound in force** (a prior policy and a parseable
  current `expires`). `min(reconstructed anchor + new days, current expires)` --
  so a shorter policy recomputes an earlier bound from the anchor, and a longer
  policy keeps the current bound (the `min` floors it there, never moving
  `expires` later).
- **Edit with no reconstructable bound** -- no prior policy, or a policy but no
  parseable `expires` (the {policy present, bound absent} state, and the corrupt-
  `expires` case). No bound to reconstruct an anchor from, so the anchor is the
  **edit instant**: the bound is `edit instant + new days`, with no current bound
  to floor against. Introducing a bound where none was in force only tightens
  (unbounded to bounded).
- **Clearing the policy.** Drops `expires` entirely, matching the rotation
  write-back's `null` clear -- a dropped policy must not leave a stale bound armed.

A computed bound past the representable date range clears rather than storing a
nonsense value: an edit that refuses to extend a credential must never harden a
bounded secret into an unbounded one on a bad stamp, so clearing is the
conservative outcome (re-invite recovers a mistaken clear). The schema's day-count
cap makes this unreachable through the UI; the rule holds for a schema-bypassing
caller.

The decoupling has an real consequence, always in the **safe** (never-later)
direction. After a lengthen keeps the current bound, the reconstructed anchor no
longer matches the real advance instant: `current expires - new (longer) days`
lands **earlier** than the true anchor. A subsequent shorten therefore computes
from that earlier reconstructed anchor and can land a bound sooner than a run
rotation would have -- strictly the conservative direction, and recoverable by
re-invite if it lands an already-lapsed bound (the standing recovery for a lapsed
`expires`). The implementation of this derivation is
`apps/web/src/psi/managedTokenAgeEdit.ts`.

### The schedule object

The optional `schedule` object holds the partnership-agreed run cadence, the
run window the two runners meet in, and the miss bookkeeping the retry policy
reads. It is present only when the operator saved the exchange as recurring;
an attended-only exchange omits it. Under the no-free-text rule in [Record
shape](#record-shape) it discloses no more than the [metadata-at-rest
analysis](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape) covers.

| Field | Type | Notes |
| ----- | ---- | ----- |
| `anchor` | string (ISO 8601, UTC `Z`) | The instant of the first agreed window's open, the phase the recurrence counts from. Both parties persist the **same** `anchor`, agreed out-of-band with the rest of the schedule, so both runners compute the same window opens. Stored UTC; a local-time cadence ("09:00 Tuesdays") is resolved to UTC at save and re-resolved only when the operator edits the schedule, so a daylight-saving shift does not silently move an unattended window. |
| `intervalDays` | integer, **1 through 366** | The recurrence period in whole days: the run window opens every `intervalDays` after `anchor`. A whole-day integer covers the daily, weekly, and monthly-approximated (for example 28- or 30-day) cadences the persona runs; sub-day cadences are out of scope for a partnership coordinated out-of-band, and calendar-month recurrence (the drifting "1st of the month") is not modeled -- an integer period keeps both runners' window computation identical without a shared calendar library. The ceiling is an annual cadence, the longest a partnership recurrence means anything at; it is also what keeps every window a surface renders on a calendar that exists (see [Every admitted schedule renders](#every-admitted-schedule-renders)). |
| `windowSeconds` | integer, **1 through 43200** | The run window's width: window *n* is open from `anchor + n * intervalDays` for `windowSeconds`. The width is chosen to dwarf realistic clock skew between the two machines (see [Clock skew](#clock-skew-and-the-window-width)); a several-hour width is the intended range, not a several-minute one. The structural floor is one second, but schedule entry enforces a UX-level minimum of **one hour**: width is the only skew mitigation the design has, so a seconds-wide window would guarantee perpetual self-inflicted misses. The ceiling is twelve hours, which sits below the shortest period the `intervalDays` floor admits, so no schedule this schema accepts can place two windows over one instant. |
| `nextWindow` | string (ISO 8601, UTC `Z`) | The open instant of the next window the runner plans to attempt. Derived from `anchor`, `intervalDays`, and the run bookkeeping (advanced past a completed or missed window), it is persisted rather than recomputed so a reader -- the runtime waking, or a next-visit surface -- sees the planned attempt without replaying history. After a miss it is the **next** window, never a sooner off-schedule retry: retry-at-next-window is the whole retry policy (see [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#retry-and-repeated-misses)). A runtime that wakes to find it in the past applies the catch-up rule below before anything else (see [Catch-up on wake](#catch-up-on-wake)). |
| `consecutiveMisses` | integer, at least 0 | The count of consecutive agreed windows that passed without a completed handshake, **regardless of which side was absent**: a window this runner sat out waiting for a peer that never arrived counts exactly as one this runner itself slept through (the latter recorded retroactively; see [Catch-up on wake](#catch-up-on-wake)). A `"succeeded"` outcome resets it to 0; a `"missed"` outcome increments it; **any other outcome leaves it unchanged**, because only a no-show signals the two runners are not meeting. A handshake that ran and failed (`"failed"`/`"desynced"`) means the partnership *did* meet, so it is a desync/attack question, not a coordination-drift one; a benign pre-peer failure (an `"input"` or `"terms-shortfall"` refusal) is likewise not a partner no-show. It drives only the reporting of a repeated-miss coordination problem, whose escalated state fires at **two** consecutive misses (see [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#retry-and-repeated-misses)); it never pauses the schedule and never changes `nextWindow`'s cadence. |

The object holds no operator-facing recurrence label, no timezone name, and no
window-outcome history: `anchor` plus `intervalDays` plus `windowSeconds` fully
determine every past and future window, and `lastRun` already holds the most
recent outcome. `consecutiveMisses` is the only cross-window state the retry
policy needs.

Window *n* is the half-open interval from `anchor + n * intervalDays` to
`windowSeconds` later: an instant exactly at the close belongs to no window, so
a window is elapsed the moment it closes. Two consecutive windows never both
contain the same instant, which the two fields' own ceilings and floors settle
rather than a cross-field rule: the widest admitted `windowSeconds` is twelve
hours and the shortest admitted period is one day, so a width can never reach
the next open. Every open is computed by fixed-millisecond arithmetic
from the stored UTC `anchor`, never by a local-calendar date add -- a calendar
add moves the instant by the offset change on the week a party's zone shifts,
which is exactly when two runners can least afford to stop overlapping. The host
zone is read once, at entry, to resolve a local wall-clock cadence into `anchor`
(see the `anchor` row); no later computation reads it. Every stored instant
has the UTC designator, and one that does not -- from a hand edit or a
tampered artifact -- is refused rather than read against the host zone, which
would otherwise place the same record's windows differently on every machine.

The schedule is a **local-only** field, not part of the persisted
`exchangeFile` document: a reschedule is neither a terms change nor a credential,
so it must not force the re-invite a document change requires (see [Record
shape](#record-shape)), and the CLI would hold it inertly. Each party enters it
locally at save-as-recurring, agreed out-of-band exactly as the terms and the
setup secret are (see
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#invitation-contents-and-confidentiality)).
Normatively: neither the invitation wire format nor the exchange-file document
holds the schedule, and no schedule field is ever sent to a server or to the
partner over the wire. Two parties who enter mismatched values never share an
overlapping window and record mutual misses until they reconcile out-of-band --
a benign coordination failure, never a desync or an attack. The operational
framing is in
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#where-the-schedule-is-agreed-and-where-it-lives).

Entry is implemented in `apps/web/src/bench/scheduleEntryModel.ts` (the
validation, the resolution, and the cross-field condition) over the arithmetic in
`apps/web/src/psi/managedSchedule.ts`; the form itself is the local-fields editor
in `apps/web/src/bench/ManagedExchangeDetail.tsx`, which writes the schedule
through the store's one local-fields edit alongside the label and the max-age
policy.

#### What entry writes

Entry composes the whole object from four values the operator types -- the first
agreed window's local date and time of day, the period in days, and the width in
hours -- plus three rules that are entry's alone:

- **The anchor is resolved once.** The host zone is read here and nowhere else,
  turning the wall-clock cadence into the stored UTC `anchor` (see the `anchor`
  row). Re-opening the form reads the anchor back on the operator's own clock,
  and a save that left every cadence field as it was **writes no schedule at
  all** rather than resolving again: a wall clock a zone skips or repeats does
  not round-trip, so re-resolving on an unrelated save (a label edit, a max-age
  change) could walk the agreed instant away from the partner's. Omitting the
  field, rather than writing back the object the form opened on, is what keeps
  such a save off the runner's bookkeeping too: `nextWindow` and
  `consecutiveMisses` live in this same object and advance under a page left
  open, so a mount-time snapshot written back would rewind them to a window
  already accounted for. The carry-through is **per field**, not all-or-nothing:
  a save that edited one cadence field takes the anchor and the width from the
  stored object verbatim while the fields displaying them are untouched, and
  writes the rebuilt schedule because the operator moved something. The fields
  hold the cadence to the minute and the width to the hour, coarser than the
  record stores either, so re-deriving them from what they display would rewrite
  a stored value at a resolution the operator never saw -- an edit to the period
  alone silently moving an agreed anchor or width.
- **`nextWindow` is the first window not yet closed at the save**, not the
  anchor's own window. A cadence anchored to a date already past would otherwise
  hand [catch-up](#catch-up-on-wake) every window that elapsed before the
  partnership agreed the cadence, and count each one a miss it never had.
  Entering a cadence while one of its windows is already open plans **that**
  window, so the run in progress can meet it.
- **`consecutiveMisses` starts at 0** on an edited cadence. The stored count
  speaks for windows on the lattice the edit replaced.

Entry also enforces the field bounds in the table above as its own validation, so
an out-of-range value is refused at the field rather than at the store write, and
the width floor of one hour that the schema's structural floor does not state.
Those bounds hold what the operator **enters**. A width the record already
states -- one merely finer than the field's unit, 5400 seconds for an hour and a
half, or one below the floor from an import or a hand-edited record -- is shown
back as the exact value it is rather than rounded, and stands: the save holds
its seconds through untouched, and neither the unit nor the floor is applied to
it. Rewriting it would change what the partnership agreed without saying so, and
refusing it would block the form's other edits -- a label, a max-age policy -- on
a value the operator never typed. Only a width the operator changes takes entry's
bounds and the whole-hour rule the field asks for.

One cross-field condition is **reported rather than refused**. When
[`tokenMaxAgeDays`](#persisted-across-runs) is set and `intervalDays` is at or
past it, the stored secret lapses before the window that would have refreshed
it -- the partnership stops on a lapsed credential and recovery is a re-invite.
Entry states that in the bound's own terms ("must run or be renewed within N
days") and leaves the save available, since an operator who renews by hand is
entitled to the cadence. The policy remains opt-in and off by default, so the
condition is unreachable for an exchange that set no bound.

#### Every admitted schedule renders

Every surface that shows a window formats the instant directly and has no
fallback for one no calendar has. What makes that total is the pair of ceilings
on `intervalDays` and `windowSeconds`: the window containing an instant, and the
first window after it, both then land within one period plus one width of that
instant, which is inside the representable range for any clock reading a machine
can hold. A period or width past the ceilings is refused by the schema, so it
never reaches a surface as a record at all: the attended list read parses
strictly and rejects wholesale on it, so the whole read fails and the
saved-exchanges list routes to its read-failed recovery surface, whose separate
per-entry diagnostic read is where the offending record is identified and
discarded. The display derivation also refuses a reading instant within one
period plus one width of the end of the representable range, which is the other
half of the pair.

**The unattended read is per-entry, not strict.** A wake reads the store one
entry at a time: an entry this build cannot parse -- an out-of-bounds period or
width from an artifact imported or hand-edited before these ceilings existed, or
any other record an app upgrade invalidated -- is **skipped**, reported as its own
skip in the wake's diagnostic line, and every other due record still runs. Such an
entry stays unparseable until an operator discards it, so a wholesale rejection
here would be standing rather than transient: no exchange in the store would run
unattended for as long as the entry sat there, with nobody present to meet the
recovery surface. The skip costs one exchange its scheduled runs; the rejection
would cost all of them. The attended read stays strict precisely so the operator
does meet that surface, which is where a skipped entry is resolved.

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

A window is **unattempted** when no run bookkeeping falls inside it. A window
that does have a `lastRun` was met, so it takes that entry's verdict from the
`consecutiveMisses` row above rather than counting as a miss, and its own
bookkeeping stands rather than being overwritten by the catch-up's `"missed"`
entry. The same reading determines the window still open at the wake: a
`"succeeded"` run inside it satisfies it, so `nextWindow` advances past without
an attempt -- which is how an attended run inside an agreed window discharges
that window -- while a run that failed inside it does not, leaving the rest of
the window attemptable. Bookkeeping the wake cannot stand behind determines
nothing: a `lastRun` whose `at` is stamped ahead of the wake instant -- a
forward-skewed clock, or a hand-edited record -- discharges no window, whether
the window it names has opened or not, so the schedule keeps planning that
window and attempts it while it is open. Deferring the verdict to a later wake
is the conservative direction: no agreed window is skipped on a stamp from the
future, and none is counted as missed before its close.

Catch-up applies these verdicts **window by window, oldest first**, never as a
net over the span: a `"succeeded"` window resets `consecutiveMisses` to 0 and
only the windows after it rebuild the count, wherever in the run that window
sits -- including the window still open at the wake, whose recorded success
resets the count the elapsed windows before it raised.

One window the walk does not visit is read the same way before it starts: the
window immediately preceding `nextWindow`, whose recorded `"succeeded"` run
resets the count. That window is where a run the schedule advanced past as
`"unattempted"` lands its outcome -- the advance happens while the other
context's run is still in flight -- so without this reading a completed exchange
inside an agreed window could fail to discharge the miss run, and the escalation
threshold could be crossed a window early. The reach is exactly one window: a
success further back sits behind windows the walk has already counted on their
own evidence, and leaves them counted.

The rule keeps both fields accurate. `consecutiveMisses` reflects the true count
of elapsed misses whichever side was absent, and the runner lands on a live
window rather than replaying stale past ones. Crossing the two-miss escalation
threshold during catch-up fires the repeated-miss surface at the wake -- which
is how a persistently absent party learns of a miss pattern late rather than
never (see
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#retry-and-repeated-misses)).

The wake's bookkeeping write is **conditioned on the plan it read**: it lands
only while the stored `anchor`, `intervalDays`, `windowSeconds`, `nextWindow`,
and `consecutiveMisses` are still the ones the catch-up computed against, and is
dropped whole otherwise. Nothing serializes one wake's write against another's,
or against an operator's edit, so an unconditioned write could rewind
`nextWindow` and lower `consecutiveMisses` behind newer bookkeeping -- deferring
the two-miss escalation by exactly the misses it erased -- overwrite a re-plan
the operator had just made, or restore a count they had just cleared on the plan
the wake was running. A dropped write costs nothing: the next wake recomputes
the same rule against the stored plan.

The import path is the rule's second consumer: an imported backup holds the
snapshot's `nextWindow`, typically in the past by the time the artifact is
restored, and the first wake after an import applies the same catch-up --
elapsed windows counted, `nextWindow` advanced to a live window -- before any
attempt.

#### Occupying a due window

A window catch-up lands on and finds open is **occupied**, not waited out in one
call. The runner makes bounded re-attempts across it: each attempt waits for the
partner's runner up to the human-timescale budget both one-shot roles share,
clamped to what is left of the window, and the next attempt begins no sooner than
a fixed pacing interval after the last one started, up to a cap on attempts per
window. One window-long wait would put the whole window on a single broker
registration surviving that long; the pacing and the cap are what keep an attempt
that fails immediately from spending the window in a loop. The pacing interval is
itself bounded by the close, which ends the occupancy in any case.

**A limit of the occupancy.** The lock is held per attempt, not per window: an
attempt that spends its full peer wait outlasts the pacing interval, so the
next attempt takes the [single-writer lock](#the-secret-is-a-linear-resource)
back at once, but an attempt that fails fast leaves the lock free for the rest
of its pacing gap, and a window whose attempt cap runs out before the close
leaves it free for the tail (see
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#cross-tab-single-writer-locking-web-locks)).
An operator's own Run can take the lock in any such free interval and rotate
the shared secret, and the occupancy's later attempts then run against a
rotated record and can stamp their own `lastRun` over that run's success. A
designed inter-attempt yield is deferred rather than designed away, and it
cannot be added on its own: widening the free intervals widens that hazard, so
any future yield must arrive with a write-path rule on the shared attended
path -- a run that fails cannot overwrite a success stamped after that run
began, `lastRun` being monotonic on `at`.

An occupancy belongs to one record. Each wake dispatches every due record that is
not already occupying its window, so an exchange holding its own window open for
hours neither blocks nor delays a second exchange whose window opens during it.

Two boundaries the occupancy holds:

- **The window's close is reached as a no-show, never as an abort.** The last
  attempt's wait is clamped to the close, so a window nobody arrived in ends as
  the partner absence it is. Signalling the close through the run's abort instead
  would record the operator's own cancellation (see the `lastRun` `failureKind`
  row), which is a different fact.
- **Nothing is re-attempted once the data exchange began.** Past that phase
  boundary this run's payload could already have reached the partner, so a
  re-attempt would disclose a second time. The boundary gates the retry rather
  than the failure's kind.

Within those, an attempt is re-made only for a partner who never arrived and for
a failure with no determinate local cause. A lapsed `expires`, a copy an export
handed off, a hand-off state the run could not read, an unusable input, a
shortfall against the standing terms, a refused disclosure, a failed rotation
persist, and a handshake that failed closed each reproduce identically on the
next attempt, so each ends the window's occupancy where it happened.

The hand-off is the one of them a window can meet after starting cleanly, and it
is why the spent state is read per attempt rather than per tick: the runner's own
skip below reads it once when the wake begins, while the run path re-reads it
inside the [run+rotate lock](#the-secret-is-a-linear-resource) at the start of
every attempt. A hand-off confirmed while a window is open therefore refuses that
attempt outright rather than being re-attempted until the window closes; the
refusal itself is non-retryable and counts no partner miss, but a window that
already found the partner absent before it still folds to `"missed"` under the
table below.

The window's disposition folds every attempt it took, written once for the window
rather than once per attempt:

| Disposition | The window | `consecutiveMisses` | Advance has a `lastRun` |
| ----------- | ---------- | ------------------- | --------------------------- |
| `"succeeded"` | an attempt completed the exchange | reset to 0 | no -- the run recorded its own |
| `"missed"` | none did, at least one found the partner absent, and none failed in a way that proves the partner was met | incremented | no -- the run recorded its own |
| `"failed"` | its attempts failed, none of them on an absent partner -- or one of them proved the partner was met | unchanged | no -- the run recorded its own |
| `"unattempted"` | its last attempt was refused the single-writer lock, held by another context | unchanged | no -- the window has no bookkeeping |

The `"missed"` row folds rather than reading the last attempt because an attempt
that spent its whole peer wait has already answered the question the miss count
asks -- whether the two runners met in this window -- and pacing starts the next
attempt at once after a wait that long. Reading the last verdict alone would
therefore let one trailing transient failure record a window of no-show waits as
`"failed"`, which leaves the count untouched and loses the miss entirely.

A failure that **proves the partner was met** decides the same question the
other way, and outranks any absence the window found earlier: a handshake that
failed closed ran against a partner on the far end of an open channel, a
rotation persist fails only after that handshake yielded the rotated secret, and
any failure past the data-exchange boundary postdates both. Per the
[`consecutiveMisses`](#the-schedule-object) row, a partnership that met is a
desync/attack question rather than a coordination-drift one, so such a window
records `"failed"` and counts nothing. A failure with no determinate cause
proves nothing either way and leaves the fold to the absence above.

`"unattempted"` is the one disposition that is not an outcome the record can
hold, and the one that stands whatever the attempts before it found: another
context was running this very record, so the window is that context's to account
for rather than this runner's, and the schedule advances past it recording
neither an attempt nor a miss. The advance happens while that run is still in
flight, so its bookkeeping lands in a window already advanced past; a
`"succeeded"` one is credited at the next wake (see
[Catch-up on wake](#catch-up-on-wake)), while any other outcome it records leaves
the window uncounted. Every other disposition's `lastRun` is written by the run
itself, so the schedule advance has none and cannot contend with it.

Three records are passed over rather than attempted, each leaving its window
with no disposition at all -- the wake that finds the window elapsed counts it
exactly as one this runtime slept through:

- One this device has handed off (its local `spent` state), by either export.
- One with no persisted `inputFileHandle`, which has no unattended read of the
  input at all.
- One whose runtime stopped while the window was still open.

The rules above are implemented in `apps/web/src/psi/managedScheduleRunner.ts`;
the browser host that wakes them, and the installed-runtime gate that decides
whether it runs at all, are `apps/web/src/psi/managedScheduleRuntime.ts` and
`apps/web/src/components/ScheduledExchangeRunner.tsx`.

### Clock skew and the window width

The two runners never exchange a clock reading; each opens and closes its window
by its own machine clock against the shared `anchor` and `intervalDays`, so an
overlapping window depends on both clocks agreeing closely enough. The mitigation
is width, not synchronization: `windowSeconds` is chosen to dwarf realistic skew
(a several-hour window against the seconds-to-minutes skew of a machine with any
working time source), so two reasonably-set clocks overlap comfortably and only a
grossly wrong clock on one side turns a scheduled run into a benign miss. The
design adds no time-sync protocol; a persistently miss-producing clock is a
local operational problem the miss reporting (see
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#retry-and-repeated-misses)) points
the operator at, resolved by fixing the machine's time source, not by the app.

### Re-supplied each run

These are never persisted in the record. They are supplied at each run -- by
the scheduled runtime, or by the operator on an attended run.

| Input | Why it is not persisted |
| ----- | ----------------------- |
| The input file's contents | Never persisted -- the record holds a pointer at most (`inputFileHandle` above), never content. The file is read in the browser at each run and never uploaded, exactly as the one-shot flow reads it (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#invitation-contents-and-confidentiality)). See [The input file each run](../MANAGED_EXCHANGE.md#the-input-file-each-run). |
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

- **The rendezvous peer id.** Derived from the decoded secret under the role
  label the local `side` field selects; the construction is specified in
  [PROTOCOL.md](PROTOCOL.md#webrtc-rendezvous-peer-id-derivation). Because it
  derives from the secret, it changes with every rotation, so it cannot be a
  stored field -- storing it would strand a stale id after a rotation.
- **The rotated replacement secret.** Derived from the key-exchange session key
  (see [PROTOCOL.md](PROTOCOL.md#shared-secret-rotation)). It is written into
  `sharedSecret` by the persist-before-success step above; the derivation itself
  is core's.

The managed record introduces no new KDF, info string, or salt: it persists the
same 32-byte secret the invitation and rotation already define, and every
derived value uses the labels those constructions hold. The record's own at-rest hygiene
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
  The record's `id` is likewise not included: it is a device-local record
  identifier, not partnership data, and an import is a **take-over that mints a
  fresh local record**, not a copy of the source's identity. The artifact does
  not rotate -- it snapshots the secret current at export -- so a stale artifact
  stays usable until the partnership rotates past it or any `expires` it holds
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
  and `local` holds the browser-only fields the two CLI artifacts do not
  (`label`, `side`, `schedule`, `lastRun`, `tokenMaxAgeDays`). The artifact's own
  JSON keys are `camelCase`, by design: the `.psilink.key` file the CLI reads is
  itself `camelCase` JSON (`sharedSecret`, `expires`), parsed without a
  `snake_case` conversion, so a `camelCase` `key` block is what maps onto a valid
  key file with no renaming. Only the embedded `exchangeDocument` is `snake_case`,
  because the CLI loads it as YAML through `camelizeKeys`.
- **What a reconstructed `lastRun` can and cannot assert.** The `local.lastRun`
  block is validated against the record's own `lastRun` schema rather than a
  narrower one, so an artifact is accepted with every outcome and
  `failureKind` the [record shape](#persisted-across-runs) names, `"handed-off"`
  among them, and an import copies what it read onto the reconstructed record
  verbatim. That widens what the surfaces display and nothing else: the run
  path's custody refusal reads the [spent sibling
  entry](#the-backup-marker-the-spent-state-and-the-import-marker-local-siblings-never-in-the-artifact),
  never `lastRun`, so an artifact asserting `"handed-off"` misdescribes the tier
  shown for a record that is in the operator's own custody. It cannot make a
  record run that would otherwise refuse, and it cannot stop a refusal the spent
  entry earns.
- **CLI-separable format.** The record is the CLI's config-plus-key pair kept
  as one browser object, and its export stays consumable by the CLI toolchain
  rather than becoming a third format: the embedded `exchangeDocument` is a
  valid `psilink.yaml`; the `key` block's `sharedSecret` and `expires` pair maps
  onto a valid `.psilink.key` (the block can be lifted out verbatim -- the field
  names already match the key file's); and the `local` block's fields are cleanly
  separable and ignorable. This is a format-compatibility commitment, not a
  claim the embedded exchange runs there: the composed webrtc connection holds
  no `role`, the field the CLI derives its rendezvous peer id from and refuses a
  webrtc run without (see [Role: a local `side` field](#role-a-local-side-field-not-the-document)).
- **Plaintext, custody-protected.** The artifact is a plaintext credential file,
  not passphrase-encrypted. Passphrase encryption is not done: the
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
- **No anti-rollback.** The record has no rotation epoch and no history, and
  the handshake gives the partner no way to recognize a superseded copy, so a
  restored artifact (or a browser-profile/VM snapshot) silently re-arms whatever
  secret it holds: still-current (the captured-credential case above) or
  rotated-past (a guaranteed desync at the next run). Source invalidation on
  export is an operator-cooperation property, not a cryptographic one. A
  monotonic rotation epoch held in the record and checked in the handshake
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
  re-derived from `lastRun`, by the write-side rules below -- which also settle which
  export the state is about:
  - **A marking export binds the marker to the bytes it serialized.** The backup and
    migration exports read the current record, serialize the bytes they will download,
    and stamp the marker in one atomic store step (a cross-store
    read-serialize-and-mark), then download exactly those bytes, so the marker can only
    ever attest the secret the file carries. A stale tab or a stale in-memory record
    cannot mark a secret it did not serialize. Serializing inside the step is what binds
    the marker to bytes that exist: a step that resolved without serializing would leave
    a marker attesting bytes nothing produced, so it fails the export instead.
  - **The command-line export marks nothing.** What it writes is the CLI's own
    `psilink.yaml` and `.psilink.key`, which this app's import does not accept, so a
    marker stamped for it would present the record as restorable from files nothing
    here restores from. It takes a plain read of the record by `id` and leaves the
    marker -- present or absent -- exactly where it stood, whether the hand-off is
    confirmed or dismissed. The two exports are named apart where they are offered, so
    the operator chooses between "a file this browser restores from" and "the files
    the command line runs from" rather than between two downloads.
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
- **The spent state** (`spentAt`, an ISO 8601 UTC instant, and an optional
  `handoff` discriminator) records that an export handed this device's copy off.
  Two exports write it, and the discriminator is which one did:
  - the **migration export** ("take over on another device"), which writes
    `spentAt` alone, so an absent `handoff` reads as a migration spend;
  - the **command-line export**'s confirmed hand-off, which writes
    `handoff: "command-line"` beside it.

  Either way it transitions the source to a visible spent state -- no Run
  affordance, no scheduled runs, labeled with the handoff date -- so the
  operator-cooperation invalidation is visible at the one moment it is violable.

  **The run path enforces that state, not the surfaces that show it.** A surface
  reads the spent state when it loads and a wake reads it when it begins, and both
  readings are as old as whatever has happened since. So the run's own locked
  window re-reads it first of all: a run that finds this device's copy spent
  refuses -- before the input file is read and before any connection -- and records
  a `handed-off` `lastRun` rather than rotating a secret whose owner is elsewhere.
  Rotating would leave the new owner's first run meeting a partner that has moved
  on, which nothing short of a re-invite recovers, and no run makes that decision on
  the operator's behalf: the refusal is the whole response, with no override on the
  run path. Taking a handed-off exchange back is a deliberate act on that record's
  own surface, and remains future work (see the import refusal's stated limit
  below). A spend confirmed after a surface loaded, or between two attempts at one
  scheduled window, therefore stops the runs that follow it.

  The spend is **operator-attested, not dispatch-anchored**: a download dispatch
  (`anchor.click()`) gives no landing signal, so a cancelled or failed save must not
  spend the source. Each export downloads its files, then writes the spent state only
  after the operator confirms they are saved; a dismissed dialog leaves the source
  live and recoverable. The migration also marks the source backed-up on dispatch, so
  a migration-spent copy has a current artifact by construction; the command-line
  export marks nothing, so a copy spent that way holds whatever backup state it
  already had. The attestation is checked rather than taken on its word, and the
  check and the write are **one atomic store step** (a cross-store
  check-and-spend), as the backup marker's are: inside a single
  transaction spanning the record and sibling stores, the confirmation reads the
  record by `id`, compares the `sharedSecret` the files it downloaded hold, and
  writes the spent state only while the two match. A rotation -- whose own write
  spans the same two stores -- therefore lands either before that step, which then
  reads the rotated secret and refuses, or after a spend that was decided against
  the secret those files hold; it cannot land between the check and the write. So a
  rotation that persisted between the download and the attestation -- a run in any
  context, or a re-invite -- refuses the spend instead of recording one, since what
  would be handed over is a copy the partnership has already moved past, and a record
  gone from the store refuses on its own terms: there is no live copy left to spend,
  and none to download again either, so those refusals are reported apart and say
  different things.

  **A run in flight is excluded rather than checked.** That transaction decides a
  rotation that has already landed; a run still in flight has landed nothing for it
  to read -- the secret has not rotated yet, so the check would pass, and that run's
  own persist would then supersede the copy just handed over. So the spend takes the
  record's [run+rotate lock](#the-secret-is-a-linear-resource) with `ifAvailable`
  before it opens the transaction at all, and refuses while a run holds it, reporting
  a refusal of its own. The exclusion runs both ways from one lock: a run that begins
  while the spend holds it waits for the spend to finish (or, on the `ifAvailable`
  scheduled path, defers the attempt as `"unattempted"`), and then re-reads the spent
  state that spend wrote as its first act inside the lock, which is the refusal
  above. Spend and run are therefore mutually excluded rather than observing each
  other, and neither order leaves a handed-over copy behind a rotation.

  Stated limit: that exclusion is the Web Locks lock's, so it binds the contexts of
  one browser profile on one machine -- which is the whole scenario, both hand-off
  surfaces and both run paths of a record being that profile's, the record itself
  being origin-local to it. What it does not cover is what no lock could: a copy held
  under another profile, browser, or machine, which can only have got there through
  an export the operator took. Bounding that is migration-not-sync and operator
  cooperation (see [Single-owner invariant](#single-owner-invariant)), not this step.
  The spent state has no secret material and no epoch.

  **Revive by import is the migration spend's recovery, and only its.** The
  migration export downloads the artifact that clears its own spend (a
  **revive-in-place**: an import whose secret matches the spent record's updates
  that record's fields, keeps its `id` and input handle, clears the spent state,
  and marks it imported and backed-up, rather than installing a duplicate). The
  command-line export downloads the CLI's `psilink.yaml` and `.psilink.key`, which
  the import flow does not accept, so that hand-off leaves nothing of its own to
  import back: the two files are the exchange's backup of record, on the machine
  that runs it. That is why the surfaces reading the spent state branch on the
  discriminator rather than naming one recovery for both -- a spent copy is told
  the recovery its hand-off actually has.

  **The match is `spent` plus a secret match plus an absent `handoff`.** Revive keys
  on the absence rather than on an inequality against a known route, so a hand-off
  added later is gated by default instead of inheriting the migration's recovery. An
  artifact the operator exported from this browser before a command-line hand-off
  still has the secret that record was spent holding, and the import **refuses
  it**: it neither revives the spent record -- that would run a copy the hand-off gave
  away -- nor installs a fresh one, which would split one secret across a spent husk
  here and a live row beside it. Nothing is written. A handed-off match determines the
  import by itself: an artifact whose secret matches a handed-off record is refused
  even when a migration-spent record holds that secret too, and the refusal names the
  handed-off record. Where it fires, the refusal names the stored record and the
  recovery that record actually has -- the exchange runs from the files the
  hand-off saved, and bringing it back to this browser is a re-invite. A stated
  limit bounds the surface: the import affordance renders only beside an empty or
  unreadable listing, a handed-off record keeps the listing non-empty, and an
  unreadable store fails the revive's own parse before the refusal can be
  reported -- so the guard binds at the store's import path, and a fully supported
  surface for meeting it (an explicit re-take on the spent record) remains future
  work.

  **The refusal is scoped to this store's state at import**, and both of its
  conditions are the operator's to remove: the handed-off record must still be in
  this store, and its `sharedSecret` must still equal the artifact's. An artifact
  exported before a rotation the record then took holds an older secret and
  matches nothing, so it installs fresh; deleting the handed-off record removes the
  match on the same terms. Neither is prevented -- the refusal is an
  operator-cooperation property, not a cryptographic one, exactly as the revive
  below is. Neither leaves a durable second owner either: an older artifact's
  secret is already behind the partnership's, and a copy of the current secret
  diverges from the handed-off one at the first rotation either side makes, so the
  losing copy's next handshake fails and is reported through the import/desync tiering
  (recovery: re-invite).

  Reviving a migration spend remains an operator-cooperation property, not a
  cryptographic one: nothing in the protocol prevents a copied artifact or a profile
  snapshot from resurrecting a migrated copy -- the same caveat, with the same
  response (see
  [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#rollback-at-rest-copies-can-silently-resurrect)).
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
meaningless -- and the record schema is reader-rejects-unknown, so holding any of
them on the record would force a new `schemaVersion` or leak into the artifact.
Keeping them siblings makes their non-inclusion **structural**: the exporter reads
only the record. Deleting a managed exchange removes the record and its sibling
state together (see [Deleting a managed
exchange](../MANAGED_EXCHANGE.md#deleting-a-managed-exchange)).

## The accounting of disclosures

A managed exchange's **accounting of disclosures** is a second local sibling, in
its own origin-local store keyed by the record `id`: the
[self-attested exchange records](EXCHANGE_RECORD.md) this exchange's runs have
produced, accumulated in run order. It is what an operator populates a HIPAA
accounting of disclosures or a FERPA disclosure record from (see
[COMPLIANCE.md](../COMPLIANCE.md#hipaa-considerations)).

**An entry is a run's exchange record, verbatim.** Not a summary of one, and not
a second format beside it: every fact the accounting states -- the partner, the
governing agreement and the purpose of the disclosure under it, the categories
disclosed each way, the records this party exposed, the result size where the
record format's entitlement gate recorded one, and the instant -- is a field of
that record. What a surface renders is therefore a reading of the artifact, and a
fact the record does not hold is reported as not recorded rather than inferred
from elsewhere.

**Why it cannot be a record field.** The managed record's `lastRun` is a
timestamp and closed enums by design and keeps only the most recent run, so it
can hold no disclosure and no history; and an exchange record holds free text a
partner authored, which that field set excludes. The accounting is
therefore its own store, which also keeps it out of the export artifact
structurally, exactly as the three markers above are kept out.

**Shape.** One object per exchange: a `version`
(`psilink-disclosure-accounting/v1`, its own reader-rejects-unknown literal) and
`entries`, the exchange records oldest first. A stored value that fails
validation -- an unrecognized version, an unknown key, or an entry that is not a
valid exchange record -- rejects the whole read rather than loading the entries
that parsed: a partially-loaded accounting would still render, as a shorter and
quietly false account of what was disclosed, so the failure is reported as a
failure.

**When an entry is written.** Each run appends its record inside a single
strict-durability transaction, before the run reports its outputs. This is where
an **unattended** run's disclosure record lands: the per-run record is otherwise
offered only as a download at run completion, which requires an operator present,
so a scheduled run would otherwise leave no record of a disclosure it made. The
append is idempotent on the record's own binding nonce (per-exchange,
CSPRNG-generated, locally generated, so it identifies a run within this holder's
own log; see [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md#record-fields)), so a
retried write cannot inflate the count of disclosures the accounting reports. The
record is held to the exchange-record format on the way in, by the same validation
the read applies, and what is written is the parsed result: what is at rest is
structurally what the reader admits, so no field beyond the format can sit in the
store unseen, and a record the reader would reject is never written. A failed
append does not fail the run -- the disclosure has already happened and the
exchange's results stand -- and is reported as a notice instead.

**What it holds at rest, and retention.** The entries are the records' own
cleartext content: names, categories, references, and aggregate counts, never a
payload value, a linkage-field value, or a matched identifier. The `resultSize`
an entry holds is the intersection **cardinality** under the record format's
entitlement gate, not the intersection, so the managed record's no-match-result
rule is untouched -- but the accounting does add a growing, per-run set of
partner and agreement metadata to what a reader of the store learns (see
[Metadata at
rest](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)). It is bounded
only by the exchange's own run history: nothing prunes it, since a silently
dropped entry would falsify the account. Deleting the managed exchange deletes
its accounting in the same one-step delete, so an operator who must keep it
exports it first.

### What an exchange-record version bump does to a stored accounting

An entry is an exchange record, and the record format's version literal moves
with its field set; a reader rejects an unrecognized version rather than
migrating it, and no migration is offered pre-release (see
[EXCHANGE_RECORD.md](EXCHANGE_RECORD.md)). So a bump of
`EXCHANGE_RECORD_VERSION` invalidates the entries of every accounting already at
rest. Two consequences follow, and the second is the one that compounds:

- **The read refuses the whole value**, per the Shape rule above, so the
  accounting renders as unreadable rather than as an empty or shortened one.
- **The append refuses it too.** A run files its entry by reading the current
  accounting, appending, and writing back within one transaction, so the read
  failure is a write failure: the exchange goes on running and disclosing, and
  files nothing. A scheduled run's failed append raises the same notice any
  failed append raises, on a completion surface an unattended run does not open.

**The stored form survives the bump.** The accounting's own `version` is a
separate literal from the entries', and the envelope is validated without looking
inside an entry, so a bump leaves the envelope readable and the stored entries
returned verbatim. Only the per-entry validation refuses. This is what recovery
rests on, and it is pinned by a test driving both parses against a moved version
rather than asserted here.

**The unreadable state is a value in hand, not a failure to read.** One read
obtains the stored value in a single round trip and classifies it: a store that
does not open -- private mode with storage blocked, an engine without IndexedDB,
or a version-change open transiently held off by another tab's older connection
-- and a read transaction that does not complete are both *store-unavailable*,
which offers neither arm below. Only a value that was obtained and then refused by
the parses is *unreadable*. The split is the one the saved-exchanges list already
makes between a failed open and a failed read after one, and it is critical
twice over: the blocked-open condition is transient and self-healing, so routing
it to the reset would offer to destroy records over a condition that clears when
the other tab yields; and reading once means the validating parse and the
envelope-only parse see the same bytes, so the two readings of an accounting
cannot disagree.

**A refused value is then split by which side is behind.** A bump strands entries
only in one direction, and the refused entries' own `version` literals -- carried
in the same raw value the envelope parse returned -- say which one this is. Where
an entry names a later record format than the reading build admits, the entries
are not stranded: a build that reads them exists, and this page is running older
code than it. That is reachable in the deployed app, not hypothetical: the service
worker does not swap code under a running page (see
[../MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md)), so a tab left open across a
deployment reads what the newer build filed. It classifies as *stale-page*, whose
remedy is a reload; offering the reset there would destroy records the current
build reads. Only entries the reading build is ahead of are the *unreadable* state
the recovery below belongs to. A literal that cannot be ordered against this
build's -- another family, or no ordinal -- is not later, so a value nothing can
be concluded about keeps the reading that offers a way out. The append refuses in
both directions alike, since it re-reads through the same validating parse: a run
from a stale page discloses and files nothing, which is why that state's copy
states the consequence and not only the remedy.

The direction split reads only as far as an envelope this build admits. The
entry literals that decide it are read by the envelope-only parse, so a
later build that reshapes the envelope itself -- a bumped accounting `version`
literal, or any added envelope key, which the strict envelope schema refuses --
classifies here as *unreadable*, reset offered, even when its entries are newer
than this build. Nothing pins the envelope's shape across builds (the recovery
check pins the entry version literal alone), so an envelope change is a
compatibility decision that change must itself state: route the new envelope
through this direction split, or accept that pages of this build offer the
reset over the value it writes.

**The recovery offered is export then reset**, in that order, from the unreadable
state, and it never removes the exchange:

| Arm | What it does | What it does not do |
| --- | --- | --- |
| Stored-form export | Writes the envelope and its entries out as JSON, verbatim | Does not restore appendability, and asserts nothing about the entries |
| Accounting-scoped reset | Deletes the accounting value alone, so the next run starts a fresh accounting and the exchange can file again | Does not retain the entries; they are destroyed |

Neither alone covers the failure, which is why the surface orders them: the
export is the only thing that retains the record, and the reset is the only thing
that restores appendability. The reset is confirmed explicitly, names what is
destroyed and what is kept, and is never a read's side effect. When the stored
value is damaged past its envelope -- corruption rather than a version bump --
there is nothing to export and the surface says so rather than offering a
download it cannot honor. The export arm alone is offered from the stale-page
state as well: handing back stored bytes asserts nothing in either direction,
where the reset belongs to the direction that has records stranded.

Two shapes are not offered. **Migration** would rewrite a
self-attested artifact into a version it was not written under, which the
reader-rejects-unknown rule and the pre-release no-migration rule both exclude. A
**read-only legacy view** would render an earlier record's absent fields through
the current version's meaning of their absence -- the quietly false account the
whole-read rejection above exists to prevent. The export hands over stored bytes
and makes no claim about them; an extracted entry is an archival artifact, and a
build that does not recognize its version will not re-check it.

A bump is held to re-taking this decision by `npm run check:disclosure-recovery`,
which pins the record version literal and fails the move rather than letting it
ship past the obligation.

## See also

- [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md) - the managed exchange lifecycle: who it serves, the automation goal and platform envelope, durability contract, single-owner invariant, desync story, eviction survival, and the moment-anchored backup surfaces
- [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges) - the browser at-rest threat model for the persisted secret: the primary controls, the rollback and metadata-at-rest analyses, and the egress-hardening limits
- [EXCHANGE_FILE.md](EXCHANGE_FILE.md) - the exchange-file artifact and the credential-free endpoint locator the record composes from
- [PROTOCOL.md](PROTOCOL.md#shared-secret-rotation) - the shared-secret rotation and rendezvous-peer-id derivation constructions
- [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md) - the self-attested per-run disclosure record (a distinct artifact; the managed record is not a disclosure log, and the accounting of disclosures above accumulates these records rather than defining a log of its own)
</content>
