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
recovers, how the design survives silent browser storage eviction, and the
moment-anchored backup surfaces that keep an operator honestly informed without
training click-through. It opens with who the feature serves and the normative
second-run journey; the failure machinery follows.

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
> so it is security-review-gated. Its four decisions were ratified at owner
> sign-off on 2026-07-14 and recorded under [Decision
> record](#decision-record-owner-sign-off-2026-07-14); the epic's implementation
> items remain subject to the security-review gate.

## Who this is for

The managed exchange serves the **small or no-IT organization** -- the audience
[DESIGN.md](DESIGN.md) names as often lacking the technical sophistication for
regular data linking, for whom the project works browser-first without
installed software. That organization cannot take the documented web-to-CLI
handoff (download an exchange file, run the CLI on a schedule), because the
handoff's destination is exactly the installed, IT-operated tooling it does not
have. The managed exchange gives that operator a recurring partnership without
leaving the browser.

The calibration is honest in both directions. An organization **with** IT
support should still graduate to the CLI plus host cron -- the CLI remains the
stronger recurring tool: on-disk key-file durability instead of evictable
browser storage, true unattended scheduling instead of an operator-initiated
re-run, and the hardened container deployment. The graduation point is when
runs need to happen unattended, or as soon as the organization can vet and
operate installed software at all. Every posture choice in this document --
browser persistence with honest eviction handling, operator-initiated runs, a
plaintext export under operator custody -- is calibrated to the no-IT persona,
not to the organization that has better options.

## What "managed" adds, and what it does not

Today a web exchange is single-use: the browser runs the authenticated exchange,
derives the rotated secret, and **discards** it, so the exchange cannot run again
and nothing sensitive persists. A managed exchange instead persists the rotated
secret alongside this party's exchange-file document (the standing terms and
rendezvous locator -- the browser's `psilink.yaml` plus `.psilink.key` analog)
so the same partnership can run again later.

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

## The second run, end to end

The managed exchange is judged by its second run -- the first thing the feature
does that today's app cannot. The normative happy path, coordinated with the
partner out-of-band as every run is:

1. **Open the app.** The managed exchanges list shows the partnership, quiet
   and green: last run succeeded, backed up as of its date (see
   [Moment-anchored backup surfaces](#moment-anchored-backup-surfaces)).
2. **Run.** The operator picks the exchange and starts the run.
3. **Re-select the input file.** The app prompts for this run's input file --
   the one thing the record never persists.
4. **The run completes.** Rendezvous, handshake, rotate-and-persist, data
   exchange: the machinery of the sections below, none of it operator-visible
   when it works.
5. **The completion surface offers the results and the refreshed backup.** The
   result artifacts, as today's one-shot flow offers them, plus one more
   action: "download updated backup" -- the export, refreshed because the
   secret just rotated, offered as the natural final step of the run rather
   than a later nagging prompt.

On this path, with a fresh backup taken, **no standing warnings are shown** --
green and quiet. Every warning surface in this document is reserved for the
moment its condition is true and actionable.

### File re-selection is deliberate (v1)

Re-prompting for the input file each run is a position, not a gap (a spike
position, for owner review). Persisting a file handle for re-permission
(`FileSystemHandle` in IndexedDB) is effectively Chromium-only, while Safari is
a primary concern of this design's eviction analysis; and re-selection keeps
the record holding **zero persisted reference to participant data** -- not even
a filename. A persisted-handle re-permission flow is a possible later
enhancement, not designed here.

Re-selection carries a wrong-file risk: the operator can pick a file the
partnership does not expect. The record's document already carries the agreed
terms' column shape, so the app rejects a selected file whose columns cannot
satisfy the standing terms -- a cheap guard worth naming, though it catches the
wrong-dataset case, not a same-shaped wrong file.

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
copies is the exact fork the invariant forbids. An export produces a credential
file (see [Export/import as the durability
backbone](#the-durability-backbone-exportimport)); importing it on
the target device installs the exchange there, and the source, having invalidated
its copy on export, will not run again without a fresh import or a re-invite.
Framing the operation as "take over on this device" rather than "copy to this
device" is what keeps a single owner even across a device change.

The two export intents are distinct in the UI even though the artifact is one
format. A **backup export** leaves the source live (see [the durability
backbone](#the-durability-backbone-exportimport)). A **migration export** is
"take over on another device": the source record visibly transitions to a
spent, handed-off state -- no Run affordance, labeled with the handoff date --
so the cooperation-not-cryptography invalidation below is legible at the one
moment it is violable. A spent record can be deleted, or revived only by
importing the artifact back.

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

> **Decision (ratified at owner sign-off, 2026-07-14).** Ship the first
> managed release with **implicit-only** desync detection plus an explicit,
> honest recovery affordance (below), and adopt the grace window as a **core-level**
> change in a later, separately-reviewed step -- do not invent a web-only grace
> window. Rationale: a grace window widens the active-impersonation window for a
> leaked secret (it accepts an extra, older secret), so it is a threat-model
> change that belongs in core where both the CLI and the web app inherit one
> reviewed implementation, not a web-first divergence; and the recovery path
> (fast re-invite) already closes the operational gap without it, so the first
> release is not blocked on it. The anticipated core shape is a brief
> **two-secret rotation window** -- retaining the previous secret during
> rotation -- which stays deferred and is deliberately not designed here. This
> was decided as a threat-model call (desync-resilience against
> impersonation-window width), not a convenience toggle.

### Telling a desync from an attack

Until a grace window exists, the design cannot *cryptographically* distinguish a
desync from an attack -- both are the same failed handshake. What the managed UX
does is **tier the response by what the record already knows**, so the operator
faces the full confirmation machinery only when nothing else explains the
failure.

**Tier 1: local evidence explains the failure.** When the record holds a benign
explanation -- a recorded persist failure on the last run (the structured
`failureKind` bookkeeping), a detected restore-from-backup or import since the
last successful run, or a lapsed age bound (which never even reaches here; see
[Expiry is its own state](#expiry-is-its-own-state-never-routed-through-attack-framing))
-- the failure surfaces as that specific benign state with its specific recovery
(re-invite, or import-then-run), **without** the attack checklist. The record's
run bookkeeping is structured enums precisely so this tier can be derived
rather than guessed.

**Tier 2: no local explanation.** A handshake failure with no recorded benign
cause gets the full out-of-band confirmation. The managed record still supplies
context -- an established partnership that has succeeded many times reads
differently from one that never completed a run -- but the operator must now do
real work, because naming benign causes first is exactly the reading an active
impersonator wants the operator to reach, and "did you also see a failure" is a
question an adversary who just caused the failure can predict will be answered
yes. The confirmation is therefore delivered as a **forwardable, pre-filled
out-of-band message** the operator sends to the partner -- not prose the
operator synthesizes under stress -- asking the partner:

- to confirm their identity on the out-of-band channel, not just reply;
- what their own tool reported, and when -- establishing that a real failure
  occurred on the partner's side, rather than inferring it from this side's
  failure alone;
- whether they ran the exchange from more than one place (a second browser or
  profile, another device, a restored backup): an accidental self-fork is
  indistinguishable at the other party from an attack (see [Single-device
  ownership](#single-device-ownership)), and this question is the only way to
  surface it.

The partner's reply feeds a **two-outcome gate**, not a free-form judgment:
"the partner confirmed a real failure on their side" proceeds to re-invite;
"something does not add up" is treated as compromise and routes to the
[compromise response](SECURITY_DESIGN.md#compromise-response). The honest
framing is unchanged from the CLI's posture: the tool surfaces the failure and
structures the confirmation, but the operator, not the tool, makes the
desync-versus-attack call out-of-band.

### Expiry is its own state, never routed through attack framing

A lapsed age bound (`expires` in the past) is detected **before** any
connection or handshake, so it is never ambiguous: it surfaces as its own
unambiguous, benign state with plain re-invite copy -- mirroring the CLI's
distinct expired-token error, which names re-invitation rather than the generic
out-of-sync guidance -- and is never delivered through the desync/attack
framing above.

The age bound itself is a **visible cadence setting, not an invisible
implementation constant**. At creation the exchange surfaces it with its
cadence implication -- "this exchange must run or be renewed within N days" --
and the operator can adjust it against their known cadence, over a sane
default. The security rationale is unchanged: a dormant exchange does not
rotate, so this bound is the only exposure cap on an idle stored secret (see
[The primary controls](SECURITY_DESIGN.md#the-primary-controls)); the default's
value remains flagged for security review, and the visible, adjustable
creation-time surface is a spike position for owner review.

### Recovery: fast re-invite

The recovery path is **fast re-invite**, the same recovery the CLI uses for a lost
or out-of-sync token (see
[SECURITY_DESIGN.md](SECURITY_DESIGN.md#recurring-exchange-authentication)). Both
parties discard the desynced secret and re-establish one from a fresh invitation.
"Fast" means the managed exchange retains everything a re-invite needs that is
**not** the secret -- the exchange-file document, with its terms and rendezvous
locator -- so a re-invite reuses the standing definition and only re-mints and
re-exchanges the setup secret, rather than re-authoring the exchange from
scratch. This makes re-invite cheap enough to be the honest first-line recovery,
which is what lets the first release ship without the grace window.

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
deliberately and is part of what the decision record below ratifies.

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
  On WebKit a granted `persisted()` flag must **not** let the backup state below
  read as covered: the grant does not reliably exempt the ITP cap. The design
  requests persistence but never assumes it.
- General **storage-pressure eviction** can clear non-persistent origins under
  disk pressure regardless of browser.
- In practice the most common loss mode is none of the above but the operator (or
  an IT policy) **clearing site data** -- a deliberate action that takes the
  record with it, and another reason the export below, not the browser store, is
  the durability of record.

### The durability backbone: export/import

Because in-browser persistence can vanish silently, the **durability backbone is
an export the operator holds outside the browser**, not the IndexedDB copy. The
managed exchange can be exported to a file the operator keeps in their own
secure storage and re-imported to reconstitute the exchange after an eviction.
This is the same artifact and the same migration-not-sync semantics as a device
move (see [Export/import is migration,
not sync](#exportimport-is-migration-not-sync)): an import re-establishes the one
owner.

The artifact is a **plaintext credential file in the operator's custody** --
deliberately (a decision revised at owner sign-off; the spike originally
proposed passphrase encryption). It is the browser analog of handing over
`psilink.yaml` plus `.psilink.key`, and it adopts the key file's exact trust
model: `.psilink.key` is a plaintext credential protected by custody and
storage permissions, not a passphrase (see [Key file
security](SECURITY_DESIGN.md#key-file-security)), and the export asks for the
same handling -- owner-only storage, never an unencrypted transmission channel,
an encrypted location or secrets manager if the operator wants encryption at
rest, exactly per the key file's backup guidance. A captured or copied export
is a captured credential until the partnership rotates past it (see the
[compromise response](SECURITY_DESIGN.md#compromise-response)). The artifact
does not rotate -- it snapshots the secret current at export -- so the
`expires` it carries is what caps a stale artifact's usefulness, and re-export
after each rotation is carried by the run-completion backup refresh and the
backup state below. The artifact's shape and the no-anti-rollback caveat are
specified in
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#export-artifact).

### Moment-anchored backup surfaces

Eviction is silent, so the UI must not be -- but a warning that is always on
trains the operator to click through the one that matters. The design therefore
collapses persistence status into **one derived backup state**, surfaced at the
moments it changes rather than as standing chrome:

- **Backed up.** A current export exists (taken since the last rotation): the
  exchange shows a quiet, green "backed up as of <date>" and nothing else. The
  browser's storage grant (`navigator.storage.persisted()`) is never its own
  displayed line -- the operator cannot act on it except by exporting, which
  the backup state already covers -- and on WebKit a granted `persisted()` must
  never suppress the actionable state below (the grant does not reliably exempt
  the ITP cap).
- **Backup needed.** No current export exists: none was ever taken, or the
  secret has rotated since the last one (an export from before the last
  rotation restores a stale secret and lands in the desync recovery above).
  The exchange shows one actionable state: "Back up this exchange".

The refresh is offered where it is natural: the run-completion surface's
"download updated backup" (see [The second run](#the-second-run-end-to-end)) is
the moment the previous backup went stale, so taking it there keeps the happy
path green and quiet. An operator who skips it sees the backup state flip to
actionable on the next visit -- a state, not a nag. The frame throughout:
every honest statement appears at the moment it becomes true and actionable.

The in-browser copy is still treated as convenience and the exported credential
file as the durability of record, so an operator is never surprised by a silent
eviction they were implicitly told could not happen.

### Eviction recovery is the import flow

When the browser copy is gone -- evicted, or cleared with site data -- the
recovery affordance is the empty state itself: "This exchange's browser copy
was cleared. Restore from your backup file [Import], or re-invite your
partner." Restoring after eviction and migrating to a new device are the
**same import operation** (consistent with migration-not-sync): an import
re-establishes the one owner, wherever it runs. One honest limit: a wholesale
eviction erases the evidence that anything existed, so the app cannot always
distinguish a first visit from a post-eviction one -- which is exactly why the
managed-exchange list's empty state carries the import affordance standing,
rather than surfacing it only behind a detected loss.

## Decision record (owner sign-off 2026-07-14)

The spike's four decisions -- the epic's three open questions plus a fourth the
security-review panel added on the export artifact -- were ratified at owner
sign-off on 2026-07-14: decisions 1 and 3 as proposed, decisions 2 and 4 in the
revised form recorded below. The epic's implementation items remain subject to
the security-review gate
([CONTRIBUTING](../CONTRIBUTING.md#dependency-policy)).

1. **Grace window: adopt later, in core, not web-first. (Ratified as
   proposed.)** The first managed release ships implicit-only desync detection
   plus the honest recovery affordance; core's deferred grace-window mitigation
   comes later as a separately-reviewed core change that both apps inherit. It
   is a threat-model change (it widens the active-impersonation window for a
   leaked secret), and fast re-invite already closes the operational gap. The
   anticipated core shape is a brief two-secret rotation window -- retaining
   the previous secret during rotation -- which stays deferred and is not
   designed here. See [The grace-window question](#the-grace-window-question).

2. **Record schema: persist this party's whole exchange-file document plus the
   rotating secret. (Revised at sign-off.)** The record's core is the
   exchange-file document verbatim -- the shared CLI config schema, per the
   no-parallel-format contract in [EXCHANGE_FILE.md](spec/EXCHANGE_FILE.md) --
   plus the secret and the local-only fields the file deliberately does not
   carry (`sharedSecret`, `expires`, `tokenMaxAgeDays`, the label, and the run
   bookkeeping): CLI parity, `psilink.yaml` plus `.psilink.key` as one browser
   record. This replaces the spike's original decomposed field set, which was
   that document taken apart -- an accidental parallel format. The exclusions
   stand unchanged: the input CSV and any credential never persist (the
   document is composed credential-free exactly as the mint layer composes a
   downloadable file), and a persisted document is subject to the
   exchange-file versioning policy, so an app upgrade can invalidate a stored
   record and the recovery is re-invite. Full field list, composition rule, and
   versioning note: [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md).

3. **Egress: ship the `connect-src` allowlist as hardening; the
   never-on-a-server property is not mechanically enforceable against in-origin
   script. (Ratified as proposed -- itself the security-review revision of the
   spike's original mechanical-enforcement claim.)** `connect-src` governs
   fetch/XHR/WebSocket/EventSource/beacon egress but **not** the negotiated
   WebRTC peer/relay transport, downloads, clipboard, or navigation, and no
   shipped CSP directive can allowlist STUN/TURN hosts or peers. For the app's
   own code the property is enforced by design and review; the `connect-src`
   allowlist ships as hardening that narrows an injected script's exfiltration
   surface; no first-party runtime egress guard is added (an in-origin attacker
   bypasses first-party code by construction); and the primary control against
   in-origin script remains XSS prevention plus the already-accepted in-origin
   exposure. See [Egress hardening and its
   limits](SECURITY_DESIGN.md#egress-hardening-and-its-limits).

4. **Export artifact: a plaintext credential file under operator custody; no
   anti-rollback. (Revised at sign-off: passphrase encryption dropped.)** The
   export is the record itself -- the browser analog of handing over
   `psilink.yaml` plus `.psilink.key` -- and adopts the CLI key file's trust
   model: a plaintext credential protected by custody and storage permissions,
   not a passphrase. A captured or copied export is a captured credential until
   the partnership rotates past it (compromise response: confirm with the
   partner out-of-band, re-invite). The artifact does not rotate; the embedded
   `expires` caps a stale artifact's usefulness, and the export-freshness UX
   prompts re-export after rotation. Source invalidation on export remains
   operator cooperation, not cryptography; the no-anti-rollback statement and
   the deferred rotation-epoch hardening stand. See [Export
   artifact](spec/MANAGED_EXCHANGE_RECORD.md#export-artifact) and
   [Rollback](SECURITY_DESIGN.md#rollback-at-rest-copies-can-silently-resurrect).

### Spike positions since sign-off (for owner review)

A second review panel (product, operator-UX, architecture) drove revisions that
take new positions beyond the ratified record. They are spike positions, not
ratified decisions:

- **File re-selection each run (v1).** No persisted file handles; the record
  keeps zero persisted reference to participant data; persisted-handle
  re-permission is a possible later enhancement. See [File re-selection is
  deliberate (v1)](#file-re-selection-is-deliberate-v1).
- **Column-shape guard on the selected file.** The app rejects an input file
  whose columns cannot satisfy the standing terms, using the shape the record
  already carries.
- **The export format is CLI-handoff separable.** The artifact stays cleanly
  separable into the CLI's two artifacts (config file and key file) so a
  future file-sync managed record can be handed to the CLI/appliance for
  scheduled runs -- a compatibility commitment of the format, not v1 behavior.
  See [Export artifact](spec/MANAGED_EXCHANGE_RECORD.md#export-artifact).
- **The age bound is a visible, adjustable creation-time setting** over a sane
  default; the default's value remains flagged for security review. See
  [Expiry is its own state](#expiry-is-its-own-state-never-routed-through-attack-framing).

## See also

- [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md) - the record's shape (the exchange-file document plus local fields), the persist-before-success step sequence, and the export artifact's custody model
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges) - the browser at-rest threat model, the discard-secret reversal, the rollback and metadata-at-rest analyses, and the egress-hardening limits
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md#recurring-exchange-authentication) - the shared-secret rotation, `token_max_age_days`, and re-invite recovery the managed lifecycle reuses
- [DEPLOYMENT.md](DEPLOYMENT.md) - the hosted web app deployment posture and the reverse-proxy responsibilities
