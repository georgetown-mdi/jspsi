---
title: "Managed (Recurring) Web Exchanges"
---

# Managed (recurring) web exchanges

This document describes the **managed exchange** lifecycle for the hosted web
application: how a two-party PPRL exchange, once set up, can be run again on a
later schedule from the browser without re-authoring the terms or
re-establishing a shared secret. It covers the durability and crash-consistency
contract for the rotating secret, the single-device ownership invariant and its
rationale, how a party distinguishes a rotation desync from an attack and
recovers, how the design survives silent browser storage eviction, and the honest
persistence-status UX that keeps an operator aware of where their durability
stands.

It is the operational and conceptual counterpart to two spec-tier documents: the
**managed exchange record** field-by-field shape in
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md), and the **browser
at-rest threat model** and the CSP egress allowlist in
[SECURITY_DESIGN.md](SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges).
It does not re-specify the record's byte-level shape, the KDF labels, or the CSP
directive syntax; those live in the spec tier. Intended readers are program
officers, security reviewers, IT staff operating the hosted app, and
contributors.

> **Design spike.** This document is the output of a gating design and security
> spike for the recurring-exchange epic. It reverses a deliberate invariant --
> today the web app discards the rotated secret so a web exchange is single-use
> (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md#recurring-web-exchanges-single-use-vs-managed)) --
> so it is security-review-gated. Three decisions in it are recommendations that
> require owner and security-review sign-off; each is flagged inline and gathered
> under [Decisions requiring sign-off](#decisions-requiring-sign-off).

## What "managed" adds, and what it does not

Today a web exchange is single-use: the browser runs the authenticated exchange,
derives the rotated secret, and **discards** it, so the exchange cannot run again
and nothing sensitive persists. A managed exchange instead persists the rotated
secret (and the standing terms and rendezvous locator) in the browser so the same
partnership can run again later.

What managed **adds**:

- A **managed exchange record** in the browser (IndexedDB, origin-isolated) that
  survives runs, crashes, and restarts.
- A **rotating shared secret at rest** in that record, replacing the deliberate
  discard.
- A **run-again** action that re-runs against the persisted terms and rendezvous,
  after the operator re-supplies the input file.

What managed does **not** add:

- **No unattended scheduling in the browser.** Reliable unattended scheduling is
  out of scope for the console appliance -- that is the CLI plus host cron (see
  [SECURITY_DESIGN.md](SECURITY_DESIGN.md#single-party-appliance-trust-boundary)).
  The browser offers a handoff and an operator-initiated re-run, not a background
  scheduler.
- **No second copy of the input data.** The record never holds the input CSV or
  any row value; the operator re-selects the input file each run (see
  [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md)).
- **No server-side persistence.** There is one persistence target: the browser,
  origin-isolated, never a server. There is no profile-split persistence provider
  to choose between.

## The durability and crash-consistency contract

The persisted secret is a **linear resource**: after each successful run both
parties derive the same replacement secret and retire the old one, so there is
exactly one live secret between the two parties at any moment. That property makes
the ordering of persistence and success load-bearing.

### Persist-before-success

Within a run, the rotated secret is written durably to the browser store, and the
write is awaited to completion, **before** this party treats the run as succeeded
and before it signals success to the peer. The order is: handshake completes ->
rotated secret persisted and the write awaited -> data exchange proceeds ->
success recorded. This is the browser analog of the CLI's write-then-exchange
ordering, where the key file is written through an atomic, fsync-durable path
immediately after the handshake rotates the secret and before the data exchange
runs (see [Key file security](SECURITY_DESIGN.md#key-file-security)). The exact
step sequence and the store transaction it awaits are in
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#persist-before-success-ordering).

The point is to eliminate the window in which one party has advanced to the new
secret while the other has no durable record of it. If the persist is awaited
first, a crash after the handshake leaves this party either on the old secret
(persist not yet committed -- both parties re-run from the old secret, no desync)
or on the new secret (persist committed -- the party can complete or re-run from
the new secret). What must never happen is completing the run and telling the peer
so while the new secret is only in volatile memory.

### The honest durability limit

The browser cannot match the CLI's on-disk durability, and the contract says so
plainly rather than implying parity:

- An IndexedDB transaction `complete` event means the write reached the
  durability the browser and OS provide for that store, **not** a forced
  platform-media flush (`fsync` / `F_FULLFSYNC`). The CLI's key-file write forces
  a flush and a directory flush for cross-write crash ordering (see
  [CREDENTIAL_STORAGE.md](spec/CREDENTIAL_STORAGE.md)); the browser exposes no
  equivalent.
- The store can be **evicted wholesale** by the browser, silently, with no crash
  and no operator action (see [Surviving storage
  eviction](#surviving-storage-eviction)). The CLI's on-disk key file is not
  removed out from under it.

The residual gap is therefore covered not by a stronger at-rest guarantee but by
the same recovery the CLI uses for a lost or desynced token: **fast re-invite**
(see [Desync detection and recovery](#desync-detection-and-recovery)). The
managed design is honest that at-rest durability in a browser is best-effort and
that re-invite is the backstop, rather than presenting the browser store as
equivalent to a file on disk.

## Single-device ownership

Because the secret is a linear resource, a managed exchange is owned by **one
device**. Two devices (or two runners) that both hold the secret and both run
fork it permanently: the first to run rotates, and the other's copy is instantly
stale with no way to reconcile automatically (there is no grace window today; see
[Desync detection and recovery](#desync-detection-and-recovery)). Single-device
ownership is stated as an invariant, not a recommendation.

Two mechanisms uphold it:

### Cross-tab single-writer locking (Web Locks)

The **run+rotate** critical section is guarded by a single-writer lock (the Web
Locks API, `navigator.locks`) keyed to the managed record's id, held for the whole
window from "begin this run" through "rotated secret durably persisted". Two tabs
of the same origin cannot both enter it: the second waits or is refused, so two
tabs on one device cannot fork the secret by racing a run. Web Locks is
origin-scoped and same-profile, so it guards concurrency **within one browser
profile on one device** -- exactly the scope where two tabs are a realistic
accident. It does **not** and cannot guard against a second physical device or a
second browser profile holding a copy; that is what migration-not-sync (below)
addresses.

### Export/import is migration, not sync

Moving a managed exchange to another device is **migration**: the act of
exporting **invalidates the source copy**, so the secret is handed over, not
duplicated. There is deliberately no sync: syncing a linear secret across two live
copies is the exact fork the invariant forbids. An export produces an encrypted
artifact (see [Encrypted export/import as the durability
backbone](#the-durability-backbone-encrypted-exportimport)); importing it on
the target device installs the exchange there, and the source, having invalidated
its copy on export, will not run again without a fresh import or a re-invite.
Framing the operation as "take over on this device" rather than "copy to this
device" is what keeps a single owner even across a device change.

## Desync detection and recovery

A rotation desync is the failure the contract above is built to avoid, but it
cannot be driven to zero (a wholesale eviction between rotation and the next run,
or a migration mishandled by the operator, can still strand the two parties on
different secrets). The design must let a party tell a desync apart from an attack
and recover quickly.

### Detection: today only an implicit generic failure exists

When the two parties hold different secrets, the authenticated handshake simply
**fails closed** -- the same failure a wrong secret, a tampered frame, or an
active impersonation attempt produces. Today that surfaces as one generic
authentication failure with no way to distinguish "we rotated out of sync" from
"someone is attacking this exchange": the web handshake wrapper re-tags every
trust failure as a single `security`-kind error (on the one-shot and managed
flows, see
[SECURITY_DESIGN.md](SECURITY_DESIGN.md#recurring-web-exchanges-single-use-vs-managed)). A managed
exchange makes this ambiguity operationally worse than the one-shot flow does,
because a desync is now a recurring-partnership event an operator will hit in
normal operation, not a one-time setup slip.

### The grace-window question

Core carries a **deferred-not-foreclosed** grace-window mitigation for a rotation
desync: on a handshake failure, briefly also accept the **previous** rotated
secret, so a one-sided persist failure self-heals on the next run instead of
forcing a re-invite. It is documented as deferred in the key-agreement design and
is **not implemented anywhere today** (neither the CLI nor core accepts a previous
secret; the only current handling is the re-invite recovery procedure). The open
question the spike must answer is whether this program pulls that mitigation
forward or ships with implicit-only detection first.

> **Recommendation (requires owner + security-review sign-off).** Ship the first
> managed release with **implicit-only** desync detection plus an explicit,
> honest recovery affordance (below), and adopt the grace window as a **core-level**
> change in a later, separately-reviewed step -- do not invent a web-only grace
> window. Rationale: a grace window widens the active-impersonation window for a
> leaked secret (it accepts an extra, older secret), so it is a threat-model
> change that belongs in core where both the CLI and the web app inherit one
> reviewed implementation, not a web-first divergence; and the recovery path
> (fast re-invite) already closes the operational gap without it, so the first
> release is not blocked on it. This is flagged for the owner and security review
> because it trades desync-resilience against impersonation-window width and must
> be decided as a threat-model call, not a convenience toggle.

### Telling a desync from an attack

Until a grace window exists, the design cannot *cryptographically* distinguish a
desync from an attack -- both are the same failed handshake. What it can do, and
what the managed UX does, is present the operator with the **context** that
disambiguates them in practice:

- The managed record knows this is an **established** partnership that has
  succeeded before and knows the timing of the last successful run and last
  rotation. A failure right after a run that this device recorded as succeeded,
  against a partner that has succeeded many times, reads very differently from a
  failure on a partnership that never completed a run.
- The failure copy is specialized for a managed exchange: rather than the generic
  "could not verify your partner", it names the two benign, common causes (a
  one-sided rotation failure on the last run, or storage evicted between runs) and
  the malicious one (someone with the secret reaching the rendezvous first), and
  directs the operator to confirm out-of-band with the partner before
  re-inviting -- the same out-of-band confirmation the CLI's out-of-sync recovery
  and compromise response both rest on (see [Key file
  security](SECURITY_DESIGN.md#compromise-response)).

The honest framing is: the tool surfaces that authentication failed and gives the
operator the context to judge cause, but the operator, not the tool, makes the
desync-versus-attack call out-of-band. This is unchanged from the CLI's posture
and is not weakened by managing the exchange.

### Recovery: fast re-invite

The recovery path is **fast re-invite**, the same recovery the CLI uses for a lost
or out-of-sync token (see
[SECURITY_DESIGN.md](SECURITY_DESIGN.md#recurring-exchange-authentication)). Both
parties discard the desynced secret and re-establish one from a fresh invitation.
"Fast" means the managed exchange retains everything a re-invite needs that is
**not** the secret -- the agreed terms and the rendezvous locator -- so a re-invite
reuses the standing definition and only re-mints and re-exchanges the setup
secret, rather than re-authoring the exchange from scratch. This makes re-invite
cheap enough to be the honest first-line recovery, which is what lets the first
release ship without the grace window.

## Surviving storage eviction

Browser storage is not durable the way a file on disk is. The design must survive
**silent** eviction, not just crashes.

### The eviction threat

- **Safari Intelligent Tracking Prevention (ITP)** deletes a site's script-writable
  storage (IndexedDB included) after roughly **seven days without user
  interaction** with the site. A monthly recurring exchange sits idle far longer
  than that between runs, so under Safari the managed record can simply be gone by
  the next scheduled run, with no crash and no warning.
- **`navigator.storage.persist()` is best-effort.** Requesting persistent storage
  can exempt a site from eviction, but the grant is **not guaranteed**: browsers
  gate it on heuristics (installed PWA, bookmarked, high engagement) and can
  decline or later revoke it. The design requests it but must not assume it was
  granted.
- General **storage-pressure eviction** can clear non-persistent origins under
  disk pressure regardless of browser.

### The durability backbone: encrypted export/import

Because in-browser persistence can vanish silently, the **durability backbone is
an encrypted export the operator holds outside the browser**, not the IndexedDB
copy. The managed exchange can be exported to an encrypted artifact (a file the
operator keeps in their own secure storage) and re-imported to reconstitute the
exchange after an eviction. This is the same artifact and the same
migration-not-sync semantics as a device move (see [Export/import is migration,
not sync](#exportimport-is-migration-not-sync)): an import re-establishes the one
owner. The encryption is what keeps the exported secret from being a plaintext
credential sitting in the operator's downloads; its construction and the honest
limits of at-rest encryption for an unattended secret are in
[SECURITY_DESIGN.md](SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges).

### Honest persistence-status UX

The operator is told, plainly and continuously, how durable their managed
exchange actually is -- eviction is silent, so the UI must not be:

- **Persistence-grant status.** The UI shows whether the browser granted
  persistent storage (`navigator.storage.persisted()`), and when it did not, says
  so and points at the export backbone rather than implying the in-browser copy
  is safe.
- **Eviction-risk warning for idle recurring exchanges.** A managed exchange whose
  cadence exceeds the platform's idle-eviction window (notably Safari's ~7 days)
  is flagged as at risk of silent deletion between runs, with the encrypted export
  named as the durability guarantee.
- **Export freshness.** Because the export is the real backbone, the UI tracks
  whether the current secret has been exported since the last rotation and prompts
  an operator whose export is stale -- an export from before the last rotation
  restores a stale secret and itself triggers the desync recovery above.

The persistence-status UX is deliberately pessimistic: it treats the in-browser
copy as convenience and the encrypted export as the durability of record, so an
operator is never surprised by a silent eviction they were implicitly told could
not happen.

## Decisions requiring sign-off

The spike settles the epic's three open questions with the recommendations below.
Each is a threat-model or scope decision, so each is flagged for owner and
security-review sign-off before the dependent epic items begin.

1. **Grace window: adopt later, in core, not web-first.** Ship the first managed
   release with implicit-only desync detection plus the honest recovery
   affordance; adopt core's deferred grace-window mitigation as a later,
   separately-reviewed core change that both apps inherit. It is a threat-model
   change (it widens the active-impersonation window for a leaked secret), and
   fast re-invite already closes the operational gap, so the first release is not
   blocked on it. See [The grace-window question](#the-grace-window-question).

2. **Record-schema boundary: terms + rendezvous locator + one rotating secret
   persist; the input file and all credentials are re-supplied.** A managed record
   persists the agreed terms, the credential-free rendezvous locator, the fixed
   handshake role, the current rotating secret (with any `expires` and
   `token_max_age_days` policy), and non-secret run bookkeeping -- and nothing
   else. The input CSV is never a persisted field, and the record holds no second
   copy of the input data. The full field list and the persisted-versus-re-supplied
   split are in
   [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md). Sign-off is
   sought because this boundary is what keeps a persisted-state feature from
   quietly becoming an at-rest data store.

3. **Egress enforcement: a reviewed CSP `connect-src` allowlist is the mechanical
   backstop; no additional runtime egress guard is warranted.** A formal, reviewed
   Content-Security-Policy with an explicit `connect-src` allowlist (the app's own
   origin plus the exact signaling and STUN/TURN endpoints the exchange needs)
   mechanically forbids the browser from opening a connection to any other host,
   which is what backs the "exchange data never reaches a server" claim; a
   separate runtime egress interceptor would duplicate that guarantee less
   reliably and is not warranted. The directive set and why the browser enforces
   it are in
   [SECURITY_DESIGN.md](SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges).
   Sign-off is sought because this is the mechanical enforcement of the
   never-on-a-server property and the allowlist's exact contents are a security
   call.

## See also

- [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md) - the record's field-by-field shape, the persist-before-success step sequence, and the KDF-derivation implications
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges) - the browser at-rest threat model, the discard-secret reversal, and the CSP egress allowlist
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md#recurring-exchange-authentication) - the shared-secret rotation, `token_max_age_days`, and re-invite recovery the managed lifecycle reuses
- [DEPLOYMENT.md](DEPLOYMENT.md) - the hosted web app deployment posture and the reverse-proxy responsibilities
