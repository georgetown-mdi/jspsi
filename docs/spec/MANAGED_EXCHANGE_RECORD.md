---
title: "Managed Exchange Record"
---

# Managed exchange record

This document specifies the **managed exchange record**: the browser-persisted
state that lets a two-party PPRL exchange run again on a later schedule from the
web application, without re-authoring the exchange or re-establishing a shared
secret. It covers the record's field-by-field shape -- what persists across runs
versus what the operator re-supplies each run -- the field types, and the
key-derivation implications of the persisted secret. It is the
implementation-level complement to the **Managed exchange lifecycle** overview in
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md), which says what the feature is for,
its durability and single-owner contract, and its threat posture; this document
covers the on-disk (in-browser) shape those properties are enforced over. It does
not cover the browser at-rest threat model (see
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges)),
the exchange-file artifact the record is composed from (see
[EXCHANGE_FILE.md](EXCHANGE_FILE.md)), the invitation wire format (see
[FILE_SYNC.md](FILE_SYNC.md)), or the shared-secret rotation construction (see
[PROTOCOL.md](PROTOCOL.md#shared-secret-rotation)). Intended readers are security
auditors and implementors.

> **Design spike.** This record and the contract it fixes are the output of a
> gating design spike; the recurring-exchange epic implements against the shape
> below. The persist-before-success ordering and the single-owner invariant are
> normative for that implementation, not aspirational.

## What the record is, and what it deliberately is not

A managed exchange record is the minimal state a party's own browser retains so
that a recurring exchange with the same partner, over the same terms, can be run
again. It is **not** a saved copy of the exchange's inputs or outputs:

- **It never holds the input CSV, nor any row value derived from it.** The input
  data is read from a file the operator re-selects each run (see [Re-supplied
  each run](#re-supplied-each-run)); a managed record holds no second copy of it.
  This mirrors the CLI, where `psilink.yaml` references data by path and never
  embeds it, and the exchange-record artifact commits to data rather than
  embedding it (see [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md)).
- **It never holds a match result.** The intersection and any received payload
  are the run's output, handled under the operator's data governance, not
  folded back into the managed record.
- **It holds exactly one live shared secret at a time.** The secret is a linear
  resource (see [The secret is a linear
  resource](#the-secret-is-a-linear-resource)); the record stores the current
  rotated value and no history of prior values.

## Record shape

The record is a single JSON-serializable object, persisted in the browser's
IndexedDB under the app's origin. `camelCase` on the TypeScript side; the
persisted key names below are the normative field names.

### Persisted across runs

These fields survive a run, a crash, a tab close, and a browser restart. They
are the standing definition of the managed exchange.

| Field | Type | Notes |
| ----- | ---- | ----- |
| `schemaVersion` | string literal | A single recognized literal for v1 (for example `psilink-managed-exchange/v1`); a reader rejects an unrecognized value rather than migrating it, matching the reader-rejects-unknown rule the exchange-record and verification-keys files follow (see [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md)). |
| `id` | string (UUID) | A locally-generated identifier for this managed exchange, distinct from any rendezvous id. Used only to name the record in local UI; never sent on the wire. |
| `label` | string | An operator-supplied display name for the partnership. Local only; never sent. |
| `agreedTerms` | object | The linkage terms both parties validated: the same `linkage_terms` / `metadata` / `standardization` shape a minted exchange file carries (see [EXCHANGE_FILE.md](EXCHANGE_FILE.md)), reflecting the inviter's column **shape** and the disclosed payload column **names**, never a row value (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#invitation-contents-and-confidentiality)). Persisted because both parties agreed to them once and re-run against them; a change requires a re-invite, not an in-place edit. |
| `connectionEndpoint` | object | The credential-free `ConnectionEndpoint` locator (`channel === "webrtc"` for the browser path): the public rendezvous locator only. By construction it carries no credential and no server-identity material (the endpoint sub-schema rejects both; see [EXCHANGE_FILE.md](EXCHANGE_FILE.md)). Persisted so a re-run reaches the same meeting point without re-supply. |
| `handshakeRole` | enum (`"responder"` \| `"initiator"`) | This party's fixed exchange/handshake role, the same role the web assigns today (`"responder"` for the inviter, `"initiator"` for the acceptor). Persisted because it determines which rendezvous id this party listens on versus dials. |
| `sharedSecret` | string (base64url, 43 chars / 32 bytes) | The **current** rotated shared secret, matching `SHARED_SECRET_REGEX` (see [EXCHANGE_FILE.md](EXCHANGE_FILE.md)). This is the one at-rest secret in the record. Rotated after every successful run and re-persisted before the run is treated as succeeded (see [Persist-before-success ordering](#persist-before-success-ordering)). |
| `expires` | string (ISO 8601, UTC `Z`) or absent | The instant after which `sharedSecret` must not be used, when a bound is in force. Absent means no bound. One field, one meaning to every consumer, exactly as the CLI key file's single `expires` (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#two-sources-one-expires)); a managed record stamps it from the max-token-age policy below rather than from an invitation's setup lifetime, which is consumed at provisioning. |
| `tokenMaxAgeDays` | integer or absent | The operator's max-token-age policy for this exchange, the browser analog of the CLI `authentication.token_max_age_days`. When set, each successful run stamps `expires` this many days out onto the rotated secret. Absent means no system-enforced maximum age. |
| `observedPartnerFingerprint` | string or absent | Reserved for the SFTP host-key reconciliation seam; unused on the WebRTC-only browser path today (a WebRTC party observes no SSH host key, so it reconciles to no divergence -- see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#transport-layer-authentication)). Present in the shape so a future file-sync managed exchange has a place for it without a schema break. |
| `lastRun` | object or absent | Non-secret run bookkeeping: `at` (ISO 8601 UTC), `outcome` (`"succeeded"` \| `"failed"` \| `"desynced"`), and an optional `note`. Never a match result, a count, or any row value -- only the local operational status the persistence-status and desync UX read (see [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md)). |

### Re-supplied each run

These are never persisted in the record. The operator (or the operator's
environment) supplies them at each run.

| Input | Why it is not persisted |
| ----- | ----------------------- |
| The input CSV / data file | The record holds no second copy of the input data (an acceptance criterion of the spike). The operator re-selects the file each run; it is read in the browser and never uploaded, exactly as today's one-shot flow reads it (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#invitation-contents-and-confidentiality)). |
| Any connection credential | The `webrtc` locator carries no credential by construction, and the browser mints no credential; there is nothing to persist. A future file-sync managed exchange would reference a credential the same way the CLI does (by out-of-band-provisioned reference), never embed it. |
| The live rendezvous / peer id | Derived fresh each run from `sharedSecret` and `handshakeRole` via HKDF (see [Derived, never stored](#derived-never-stored)); storing it would duplicate a value that changes with every rotation. |
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
window today; see [Desync detection and
recovery](../MANAGED_EXCHANGE.md#desync-detection-and-recovery)). The guard on a
single device is a cross-tab single-writer lock over the run+rotate critical
section (Web Locks); export/import between devices is **migration, not sync** (the
source copy is invalidated on export). Both are specified in
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#single-device-ownership).

### Persist-before-success ordering

The rotated secret must be durably persisted **before** this party treats the run
as succeeded and before it signals success to the peer, so a crash cannot leave
the two parties on different secrets with no record of the newer one. Concretely,
within a single run:

1. The handshake completes and yields the `AuthResult`
   (`{ sessionKey, rotatedSecret, applyEncryption }`; see
   [PROTOCOL.md](PROTOCOL.md#shared-secret-rotation)).
2. `sharedSecret` (and `expires`, if `tokenMaxAgeDays` is in force) is written to
   IndexedDB and the write is **awaited to durable completion** (the
   transaction's `complete` event) before step 3.
3. Only then does the party proceed to the data exchange and, on completion,
   mark `lastRun.outcome = "succeeded"`.

This is the browser analog of the CLI's persist-then-exchange ordering, where the
key file is written (through an atomic, fsync-durable path) immediately after the
handshake rotates the secret and before the data exchange runs (see
[CREDENTIAL_STORAGE.md](CREDENTIAL_STORAGE.md#posix-write-discipline)). The
browser cannot match the CLI's `fsync`-level durability guarantee -- an IndexedDB
`complete` event means the transaction is committed to the durability the browser
and OS provide, not a forced platform-media flush -- and the storage can be
evicted entirely out from under the app (see
[MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#surviving-storage-eviction)). The
ordering is therefore the crash-consistency contract that is achievable, and the
recovery for the residual gap is fast re-invite, not a stronger at-rest
guarantee.

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
  is core's, unchanged by this record.

No new KDF, info string, or salt is introduced by the managed record: it persists
the same 32-byte secret the invitation and rotation already define, and every
derived value uses the existing labels above. The record's own at-rest hygiene
(see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges))
is a secondary control layered over that secret, not a change to how it is
derived or rotated.

## See also

- [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md) - the managed exchange lifecycle: durability contract, single-owner invariant, desync story, eviction survival, and persistence-status UX
- [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges) - the browser at-rest threat model for the persisted secret and the CSP egress allowlist
- [EXCHANGE_FILE.md](EXCHANGE_FILE.md) - the exchange-file artifact and the credential-free endpoint locator the record composes from
- [PROTOCOL.md](PROTOCOL.md#shared-secret-rotation) - the shared-secret rotation and rendezvous-peer-id derivation constructions
- [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md) - the self-attested per-run disclosure record (a distinct artifact; the managed record is not a disclosure log)
