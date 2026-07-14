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

It is the operational and conceptual counterpart to two companion documents: the
**managed exchange record** field-by-field shape in
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md), and the **browser
at-rest threat model** and egress-hardening limits in
[SECURITY_DESIGN.md](SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges).
It does not re-specify the record's byte-level shape, the KDF labels, or the CSP
directive syntax; those live in the spec tier. Intended readers are program
officers, security reviewers, IT staff operating the hosted app, and
contributors.

> **Design spike.** This document is the output of a gating design and security
> spike for the recurring-exchange epic. It reverses a deliberate invariant --
> today the web app discards the rotated secret so a web exchange is single-use
> (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md#recurring-web-exchanges-single-use-vs-managed)) --
> so it is security-review-gated. Four decisions in it are recommendations that
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
write is awaited to completion, **before** this party begins the data exchange --
the first peer-visible act after the handshake. The protocol has no discrete
"success" signal to hold back: both sides rotate at handshake completion, and the
exchange's terminal act is a fire-and-forget final send, so the data exchange
itself is what the persist must precede. The order is: handshake completes ->
rotated secret persisted and the write awaited -> data exchange proceeds -> local
success recorded. This is the browser analog of the CLI's write-then-exchange
ordering, where the key file is written through an atomic, fsync-durable path
immediately after the handshake rotates the secret and before the data exchange
runs (see [Key file security](SECURITY_DESIGN.md#key-file-security)). The exact
step sequence and the store transaction it awaits are in
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#persist-before-success-ordering).

What the ordering buys is precisely scoped: it eliminates **this party's
contribution** to the desync window. After the handshake, a crash on this side
leaves this party either on the old secret (persist not committed; it retries
from the old secret) or durably on the new one -- never advanced into the
exchange with the new secret held only in volatile memory. It cannot eliminate
the two-sided residual: the partner's own persist can fail independently, and
neither side can know whether the other's save succeeded -- the CLI states the
same one-sided limit when its key-file write fails after rotation. That residual
is what the desync recovery below exists for.

### The honest durability limit

The browser cannot match the CLI's on-disk durability, and the contract says so
plainly rather than implying parity:

- An IndexedDB transaction's `complete` event does **not** mean the bytes reached
  stable media. Under the default (relaxed) durability it fires once the write is
  visible in-process -- before OS writeback -- so it survives a tab or renderer
  crash but not necessarily an OS crash or power loss. The rotated-secret write
  therefore requests strict durability (see
  [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#persist-before-success-ordering)),
  which narrows but does not close that gap and is honored variably across
  engines; nothing in the browser matches the CLI's forced flush and directory
  flush (see [CREDENTIAL_STORAGE.md](spec/CREDENTIAL_STORAGE.md)).
- The store can be **evicted wholesale** by the browser, silently, with no crash
  and no operator action (see [Surviving storage
  eviction](#surviving-storage-eviction)). The CLI's on-disk key file is not
  removed out from under it.

The ordering above therefore guarantees renderer-crash consistency; the OS-crash
and power-loss residual -- like eviction -- is covered not by a stronger at-rest
guarantee but by the same recovery the CLI uses for a lost or desynced token:
**fast re-invite** (see [Desync detection and
recovery](#desync-detection-and-recovery)). The managed design is honest that
at-rest durability in a browser is best-effort and that re-invite is the
backstop, rather than presenting the browser store as equivalent to a file on
disk.

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
tabs on one device cannot fork the secret by racing a run. The lock is a
same-profile **liveness guard**, not a persistent claim: it is auto-released when
the holding tab or worker is destroyed, and it is taken without `steal: true` --
a steal would defeat the single-writer property it exists to provide. Web Locks
is origin-scoped and same-profile, so it guards concurrency **within one browser
profile on one device** -- exactly the scope where two tabs are a realistic
accident. It does **not** and cannot guard against a second physical device or a
second browser profile holding a copy; the durable single-owner property rests on
migration-not-sync (below), not on the lock.

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

The invalidation is an **operator-cooperation property, not a cryptographic
one**, and the design says so plainly: nothing in the protocol prevents a copied
artifact, a browser-profile backup, or a VM snapshot from resurrecting a copy
the UI "invalidated" -- the record keeps no rotation epoch, and the partner has
no way to distinguish a restored copy from the owner. A captured or duplicated
export is therefore treated as a captured credential, live until the partnership
rotates past it, under the standard [compromise
response](SECURITY_DESIGN.md#compromise-response) (notify the partner
out-of-band, re-invite). A monotonic rotation epoch carried in the record and
checked in the handshake would let a party detect a stale or forked peer; it is
noted as possible future core hardening, deferred alongside the grace window
(see [SECURITY_DESIGN.md](SECURITY_DESIGN.md#rollback-at-rest-copies-can-silently-resurrect)).

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
forcing a re-invite. The deferral is recorded in [Key-agreement
design](SECURITY_DESIGN.md#key-agreement-design), and the mitigation is **not
implemented anywhere today** (neither the CLI nor core accepts a previous
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

That out-of-band confirmation has to do real work, because naming benign causes
first is exactly the reading an active impersonator wants the operator to reach.
It must establish more than "did you also see a failure" (which an adversary who
just caused the failure can predict will be answered yes):

- **Verify the partner's identity** on the out-of-band channel, not just receive
  a reply.
- **Establish that a real failure occurred on the partner's side** -- what the
  partner's own tool reported, and when -- rather than inferring it from this
  side's failure alone.
- **Ask whether the partner ran the exchange from more than one place** (a second
  browser or profile, another device, a restored backup): an accidental self-fork
  is indistinguishable at the other party from an attack (see [Single-device
  ownership](#single-device-ownership)), and this question is the only way to
  surface it.

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

Cheap recovery has a cost that must be named. Every re-invite puts a fresh live
setup secret on the out-of-band channel, so over a partnership's life the
invitation-confidentiality requirement (see [Invitation contents and
confidentiality](SECURITY_DESIGN.md#invitation-contents-and-confidentiality)) is
**ongoing, not one-time** -- each re-invite is a fresh invitation-in-transit
exposure on a channel whose security must still hold. And an adversary who can
provoke handshake failures, or who is exploiting the desync ambiguity itself,
can farm an operator who re-invites on autopilot for fresh secrets over a
channel the adversary may already have compromised. The confirmation checklist
above is what breaks that loop -- it is why the confirmation must verify a real
partner-side failure rather than rubber-stamp the benign reading. This trade --
cheap recovery against repeated secret-in-transit exposure -- is accepted
deliberately and is part of what the sign-off below ratifies.

## Surviving storage eviction

Browser storage is not durable the way a file on disk is. The design must survive
**silent** eviction, not just crashes.

### The eviction threat

- **Safari Intelligent Tracking Prevention (ITP)** deletes a site's script-writable
  storage (IndexedDB included) after roughly **seven days of Safari use without a
  first-party user interaction** (a click or other gesture) on the site. Script
  activity and background runs do not reset that clock, and pure wall-clock idle
  while Safari itself goes unused does not necessarily trip it -- but a monthly
  cadence comfortably exceeds the window in ordinary use, so the practical
  takeaway stands: under Safari the managed record can simply be gone by the next
  scheduled run, with no crash and no warning.
- **`navigator.storage.persist()` is best-effort.** Requesting persistent storage
  can exempt a site from eviction, but the grant is **not guaranteed**: Firefox
  prompts the user, Chromium grants or denies silently on engagement heuristics
  (installed PWA, bookmarked, high engagement), and a grant can later be revoked.
  On WebKit a granted `persisted()` flag must **not** suppress the eviction-risk
  warning below: the grant does not reliably exempt the ITP cap. The design
  requests persistence but never assumes it.
- General **storage-pressure eviction** can clear non-persistent origins under
  disk pressure regardless of browser.
- In practice the most common loss mode is none of the above but the operator (or
  an IT policy) **clearing site data** -- a deliberate action that takes the
  record with it, and another reason the export below, not the browser store, is
  the durability of record.

### The durability backbone: encrypted export/import

Because in-browser persistence can vanish silently, the **durability backbone is
an encrypted export the operator holds outside the browser**, not the IndexedDB
copy. The managed exchange can be exported to an encrypted artifact (a file the
operator keeps in their own secure storage) and re-imported to reconstitute the
exchange after an eviction. This is the same artifact and the same
migration-not-sync semantics as a device move (see [Export/import is migration,
not sync](#exportimport-is-migration-not-sync)): an import re-establishes the one
owner.

The artifact is encrypted under a **passphrase the operator supplies at export
time**. Export/import is an attended operation -- the operator is present to
type the passphrase -- so the unattended-decrypt constraint that demotes at-rest
encryption of the live record (see the [at-rest threat
model](SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges))
does not apply to it, and the passphrase is never persisted. Its strength is
stated honestly: it protects the artifact at rest in the operator's custody (a
downloads folder, backup media) and does nothing against an in-origin adversary
present at export or import time, who can read the secret or capture the
passphrase directly. The artifact does not rotate -- it snapshots the secret
current at export -- so the `expires` it carries is what caps a stale artifact's
usefulness, and the export-freshness prompt below asks for a re-export after
each rotation. The keying construction and the no-anti-rollback caveat are
specified in
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#export-artifact).

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

The spike settles the epic's three open questions -- plus a fourth decision the
security-review panel added on the export artifact -- with the recommendations
below. Each is a threat-model or scope decision, so each is flagged for owner
and security-review sign-off before the dependent epic items begin.

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

3. **Egress: ship the `connect-src` allowlist as hardening; the never-on-a-server
   property is not mechanically enforceable against in-origin script. (Revised by
   security review.)** The spike's original recommendation claimed a reviewed
   `connect-src` allowlist mechanically backs the never-on-a-server claim; the
   security-review panel corrected the platform facts: `connect-src` governs
   fetch/XHR/WebSocket/EventSource/beacon egress but **not** the negotiated
   WebRTC peer/relay transport, downloads, clipboard, or navigation, and no
   shipped CSP directive can allowlist STUN/TURN hosts or peers. The revised
   decision: for the app's own code the property is enforced by design and
   review; the `connect-src` allowlist ships as hardening that narrows an
   injected script's exfiltration surface; no first-party runtime egress guard
   is added (an in-origin attacker bypasses first-party code by construction);
   and the primary control against in-origin script remains XSS prevention plus
   the already-accepted in-origin exposure. See [Egress hardening and its
   limits](SECURITY_DESIGN.md#egress-hardening-and-its-limits). Sign-off is
   sought because this replaces the mechanical-enforcement claim the owner was
   originally asked to ratify.

4. **Export artifact: passphrase-encrypted, attended, no anti-rollback.** The
   export/import artifact is encrypted under an operator-supplied passphrase at
   export time -- an attended operation, so the unattended-decrypt limit that
   demotes at-rest encryption of the live record does not apply to it. Source
   invalidation on export is an operator-cooperation property, not a
   cryptographic one: the record carries no rotation epoch, so a copied or
   restored artifact silently re-arms the secret it holds, and a captured export
   is treated as a captured credential under the compromise response. The
   artifact does not rotate; the persisted `expires` caps a stale artifact's
   usefulness, and the export-freshness UX prompts re-export after rotation. A
   monotonic rotation epoch checked in the handshake is deferred future core
   hardening, alongside the grace window. See [Export
   artifact](spec/MANAGED_EXCHANGE_RECORD.md#export-artifact) and
   [Rollback](SECURITY_DESIGN.md#rollback-at-rest-copies-can-silently-resurrect).
   Sign-off is sought because this fixes the export's protection level and
   accepts the no-rollback residual.

## See also

- [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md) - the record's field-by-field shape, the persist-before-success step sequence, and the KDF-derivation implications
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges) - the browser at-rest threat model, the discard-secret reversal, the rollback and metadata-at-rest analyses, and the egress-hardening limits
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md#recurring-exchange-authentication) - the shared-secret rotation, `token_max_age_days`, and re-invite recovery the managed lifecycle reuses
- [DEPLOYMENT.md](DEPLOYMENT.md) - the hosted web app deployment posture and the reverse-proxy responsibilities
