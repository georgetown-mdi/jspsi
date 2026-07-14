---
title: "Managed Exchange Record"
---

# Managed exchange record

This document specifies the **managed exchange record**: the browser-persisted
state that lets a two-party PPRL exchange run again on a later schedule from the
web application, without re-authoring the exchange or re-establishing a shared
secret. It covers the record's field-by-field shape -- what persists across runs
versus what the operator re-supplies each run -- the field types, the
key-derivation implications of the persisted secret, and the export artifact's
passphrase keying and rollback caveats. It is the
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
| `label` | string, at most 120 characters (enforced at write) | An operator-supplied display name for the partnership. Local only; never sent -- but disclosed to any reader of the store (see [Metadata at rest](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)), so it must name the partnership and nothing more: no agreement numbers, contact details, or other sensitive counterparty detail. The cap is a generous display bound that also keeps the record from accumulating free-text narrative. |
| `agreedTerms` | object | The linkage terms both parties validated: the same `linkage_terms` / `metadata` / `standardization` shape a minted exchange file carries (see [EXCHANGE_FILE.md](EXCHANGE_FILE.md)), reflecting the inviter's column **shape** and the disclosed payload column **names**, never a row value (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#invitation-contents-and-confidentiality)). Persisted because both parties agreed to them once and re-run against them; a change requires a re-invite, not an in-place edit. |
| `connectionEndpoint` | object | The credential-free `ConnectionEndpoint` locator (`channel === "webrtc"` for the browser path): the public rendezvous locator only. By construction it carries no credential and no server-identity material (the endpoint sub-schema rejects both; see [EXCHANGE_FILE.md](EXCHANGE_FILE.md)). Persisted so a re-run reaches the same meeting point without re-supply. |
| `handshakeRole` | enum (`"responder"` \| `"initiator"`) | This party's fixed exchange/handshake role, the same role the web assigns today (`"responder"` for the inviter, `"initiator"` for the acceptor). Persisted because it determines which rendezvous id this party listens on versus dials. |
| `sharedSecret` | string (base64url, 43 chars / 32 bytes) | The **current** rotated shared secret, matching `SHARED_SECRET_REGEX` (see [EXCHANGE_FILE.md](EXCHANGE_FILE.md)). This is the one at-rest secret in the record. Rotated after every successful run and re-persisted before the run is treated as succeeded (see [Persist-before-success ordering](#persist-before-success-ordering)). |
| `expires` | string (ISO 8601, UTC `Z`) or absent | The instant after which `sharedSecret` must not be used, when a bound is in force. Absent means no bound. One field, one meaning to every consumer, exactly as the CLI key file's single `expires` (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#two-sources-one-expires)); a managed record stamps it from the max-token-age policy below rather than from an invitation's setup lifetime, which is consumed at provisioning. |
| `tokenMaxAgeDays` | integer or absent | The operator's max-token-age policy for this exchange, the browser analog of the CLI `authentication.token_max_age_days`. When set, each successful run stamps `expires` this many days out onto the rotated secret. Unlike the CLI's no-bound default, a managed record is **created with a default value** (the value is fixed at implementation time, within the security-review gate): a dormant exchange does not rotate, so the age bound is the only exposure cap on an idle stored secret (see [The primary controls](../SECURITY_DESIGN.md#the-primary-controls)). Absent means the operator explicitly removed the bound. |
| `observedPartnerFingerprint` | string or absent | Persists, across runs, the partner-advertised host-key fingerprint that core's host-key reconciliation already observes live during the authenticated post-handshake exchange (`hostKeyReconciliation` in `@psilink/core`); the reconciliation itself is implemented and running today -- only the cross-run persistence is new. Always absent on the WebRTC-only browser path (a WebRTC party observes no SSH host key, so it reconciles to no divergence -- see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#transport-layer-authentication)); present in the shape so a future file-sync managed exchange persists it without a schema break. |
| `lastRun` | object or absent | Run bookkeeping the persistence-status and desync UX read (see [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md)): `at` (ISO 8601 UTC), `outcome` (`"succeeded"` \| `"failed"` \| `"desynced"`), and, for a non-succeeded outcome, an optional `failureKind` (`"auth"` \| `"transport"` \| `"storage"` \| `"cancelled"`). Every field is a timestamp or a closed enum -- there is deliberately **no free-text field**, so the record structurally cannot carry a match result, a count, or a row value; the constraint is the type, not a prose promise. |

Everything in this table except `sharedSecret` is non-secret but not
non-sensitive: together the persisted fields disclose the partnership's
existence and shape -- who links with whom, over which field categories, on
roughly what schedule -- to any reader of the store. That presence-and-shape
disclosure, and why none of the secret-centric controls reduce it, is analyzed
in [Metadata at rest](../SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape).

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

The rotated secret must be durably persisted **before** this party begins the
data exchange -- the first peer-visible act after the handshake. The protocol
has no discrete peer-visible success signal to gate on: both sides rotate at
handshake completion, and the exchange's terminal act is a fire-and-forget final
send, so the data exchange itself is what the persist must precede. Concretely,
within a single run:

1. The handshake completes and yields the `AuthResult`
   (`{ sessionKey, rotatedSecret, applyEncryption }`; see
   [PROTOCOL.md](PROTOCOL.md#shared-secret-rotation)).
2. `sharedSecret` (and `expires`, refreshed from `tokenMaxAgeDays`) is written to
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
  is core's, unchanged by this record.

No new KDF, info string, or salt is introduced by the managed record's run-time
lifecycle: it persists the same 32-byte secret the invitation and rotation
already define, and every derived value uses the existing labels above. The one
new keyed construction is the export artifact's passphrase encryption, below.
The record's own at-rest hygiene (see
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges))
is a secondary control layered over that secret, not a change to how it is
derived or rotated.

## Export artifact

The managed record can be exported to a file for device migration and
eviction recovery (see [the durability
backbone](../MANAGED_EXCHANGE.md#the-durability-backbone-encrypted-exportimport)).
The artifact's shape and keying:

- **Contents.** The persisted record fields above, including the current
  `sharedSecret` and `expires`. The artifact does not rotate -- it snapshots the
  secret current at export -- so the `expires` it carries is what caps a stale
  artifact's usefulness, and the export-freshness UX prompts a re-export after
  each rotation.
- **Keying.** The record bytes are encrypted with an AEAD under a key derived
  from an operator-supplied passphrase via a memory-hard password KDF, with a
  fresh random salt (and the KDF parameters) stored in the artifact header. The
  exact KDF instantiation and parameters are fixed at implementation time,
  inside the managed lifecycle's security-review gate. Export/import is an
  **attended** operation -- the operator is present to type the passphrase -- so
  the unattended-decrypt constraint that demotes at-rest encryption of the live
  record does not apply here; the passphrase is never persisted.
- **Honest strength.** The encryption protects the artifact at rest in the
  operator's custody (a downloads folder, backup media). It does not protect
  against an in-origin adversary present at export or import time, who can read
  the secret or capture the passphrase directly.
- **No anti-rollback.** The record carries no rotation epoch and no history, and
  the handshake gives the partner no way to recognize a superseded copy, so a
  restored artifact (or a browser-profile/VM snapshot) silently re-arms whatever
  secret it holds: still-current (a live credential -- treat a captured export
  as a captured token under the [compromise
  response](../SECURITY_DESIGN.md#compromise-response)) or rotated-past (a
  guaranteed desync at the next run). Source invalidation on export is an
  operator-cooperation property, not a cryptographic one. A monotonic rotation
  epoch carried in the record and checked in the handshake would let a party
  detect a stale or forked peer; it is noted as future core hardening, deferred
  alongside the grace-window mitigation (see
  [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#rollback-at-rest-copies-can-silently-resurrect)).

## See also

- [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md) - the managed exchange lifecycle: durability contract, single-owner invariant, desync story, eviction survival, and persistence-status UX
- [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges) - the browser at-rest threat model for the persisted secret: the primary controls, the rollback and metadata-at-rest analyses, and the egress-hardening limits
- [EXCHANGE_FILE.md](EXCHANGE_FILE.md) - the exchange-file artifact and the credential-free endpoint locator the record composes from
- [PROTOCOL.md](PROTOCOL.md#shared-secret-rotation) - the shared-secret rotation and rendezvous-peer-id derivation constructions
- [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md) - the self-attested per-run disclosure record (a distinct artifact; the managed record is not a disclosure log)
