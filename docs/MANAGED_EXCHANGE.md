---
title: "Managed (Recurring) Web Exchanges"
---

# Managed (recurring) web exchanges

This document describes the **managed exchange** lifecycle for the hosted web
application: how a two-party PPRL exchange, once set up, runs again on an agreed
schedule from the browser -- unattended where the platform allows -- without
re-authoring the terms or re-establishing a shared secret. It covers the
automation goal and its platform envelope, the durability and crash-consistency
contract for the rotating secret, the single-device ownership invariant and its
rationale, how a party tells a rotation desync from an attack (and a missed run
window from either) and recovers, how the design survives silent browser
storage eviction, the moment-anchored backup surfaces that keep an operator
honestly informed without training click-through, and the one-action deletion
of an exchange's stored information. It opens with who the feature serves; the
failure machinery follows.

It is the operational and conceptual counterpart to two companion documents: the
**managed exchange record** field-by-field shape in
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md), and the **browser
at-rest threat model** and egress-hardening limits in
[SECURITY_DESIGN.md](SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges).
It does not re-specify the record's byte-level shape, the KDF labels, or the CSP
directive syntax; those live in the spec tier. Intended readers are program
officers, security reviewers, IT staff operating the hosted app, and
contributors.

> **Status.** The managed exchange lifecycle is not yet implemented. It reverses
> a deliberate invariant -- a web exchange is single-use today, the browser
> discarding the rotated secret (see
> [SECURITY_DESIGN.md](SECURITY_DESIGN.md#recurring-web-exchanges-single-use-vs-managed)) --
> so the epic's implementation is gated on security review.

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
browser storage, an OS scheduler instead of a browser runtime kept alive, and
the hardened container deployment. The graduation point is when the
organization can vet and operate installed software at all. Every posture
choice in this document -- browser persistence with honest eviction handling,
automation inside the operator's own browser runtime, a plaintext export under
operator custody -- is calibrated to the no-IT persona, not to the organization
that has better options.

## What "managed" adds, and what it does not

A one-shot web exchange is single-use: the browser runs the authenticated
exchange, derives the rotated secret, and **discards** it, so the exchange
cannot run again and nothing sensitive persists. A managed exchange instead
persists the rotated secret alongside this party's exchange-file document (the
standing terms and rendezvous locator -- the browser's `psilink.yaml` plus
`.psilink.key` analog) so the same partnership can run again later.

What managed **adds**:

- A **managed exchange record** in the browser (IndexedDB, origin-isolated) that
  survives runs, crashes, and restarts.
- A **rotating shared secret at rest** in that record, in place of the one-shot
  discard.
- **Scheduled, unattended runs** as the design goal: once an exchange is
  managed and a schedule agreed, runs happen with nobody present, on the
  platforms that can carry it -- with an attended one-action re-run as the
  named degradation (see [The automation
  goal](#the-automation-goal-and-its-platform-envelope)).

What managed does **not** add:

- **No server-side execution.** Automation runs in the operator's own browser
  runtime -- an installed app kept running on the operator's machine -- never
  on a server acting for the party. The installed-software paths for scheduled
  runs remain the CLI plus host cron and the console appliance (see
  [SECURITY_DESIGN.md](SECURITY_DESIGN.md#single-party-appliance-trust-boundary)).
- **No second copy of the input data.** The record never holds the input file's
  contents or any row value. Where the platform allows, it holds a file
  **handle** -- a pointer to the operator's file, not a copy (see
  [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md)).
- **No server-side persistence.** There is one persistence target: the browser,
  origin-isolated, never a server. There is no profile-split persistence provider
  to choose between.

## The automation goal and its platform envelope

The design goal is a **fully automated recurring exchange**: once an exchange
is managed and its schedule agreed with the partner, runs happen unattended.
Browser automation is inherently a compromise against installed software, and
the compromises are accepted -- what is not accepted is settling for an
attended flow where the platform can carry an unattended one.

**The first-class path is an installed PWA on Chromium.** The app is installed
and launched at OS login (or otherwise kept running), and the exchange executes
in the app's own window context: WebRTC is unavailable to service workers, and
Periodic Background Sync's short opportunistic windows cannot carry a live
exchange, so an open app runtime -- not a service-worker wakeup -- is the
mechanism. At the agreed window the runtime re-reads the input file through the
record's persisted `FileSystemFileHandle` under its persistent read permission
(a pointer, never a copy; see [The input file each
run](#the-input-file-each-run)), and the run executes, rotates, and persists
per the durability contract below, with nobody present.

Degradations are named, not design floors:

- **No installed PWA** (an ordinary Chromium tab): the run is
  operator-initiated -- one action, through the persisted handle.
- **No File System Access API** (Safari, Firefox): the run is attended and the
  operator re-selects the input file.

**An unattended run takes two parties.** A WebRTC exchange is live: both
parties' runners must be awake in an overlapping window, so the run schedule is
partnership-level agreement, coordinated out-of-band exactly as the terms are.
A partner whose runner does not arrive in the agreed window is a **benign
retry-at-next-window outcome**, recorded in the run bookkeeping -- never a
desync and never an attack (see [A missed window is neither desync nor
attack](#a-missed-window-is-neither-desync-nor-attack)). The record persists
the agreed schedule and the retry bookkeeping
([MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md)).

Scope: this document fixes the automation goal, the platform envelope, and what
the record persists to support them; the detailed scheduling and
window-coordination design (run windows, retry policy, notification surfaces)
is later, separately-designed work and is neither foreclosed nor duplicated
here.

## The second run, end to end

The managed exchange is judged by its second run -- the first thing the feature
does that the one-shot flow cannot. On the first-class path the second run is
**scheduled**, and nobody is present:

1. **The window arrives.** The installed app runtime, running since OS login,
   begins the run under the single-writer lock (see [Single-device
   ownership](#single-device-ownership)).
2. **The input file is re-read** through the persisted handle, no prompt, and
   rejected if its columns cannot satisfy the standing terms (see [The input
   file each run](#the-input-file-each-run)).
3. **Rendezvous and handshake** with the partner's runner, awake in the same
   agreed window; a no-show partner is a recorded miss, retried next window.
4. **Rotate-and-persist, then the data exchange** -- the durability contract
   below, unchanged by nobody watching.
5. **The outcome lands in the run bookkeeping**, and the next visit's surfaces
   carry it: the results, the refreshed-backup prompt, or the failure state.
   An OS-level notification from the installed app is the natural "this ran /
   this needs you" surface between visits; its design belongs to the later
   scheduling and installed-app work.

The **attended re-run** -- the degradations' path, available on any platform --
is the same run with the operator present: open the app (the exchange shows
quiet and green: last run succeeded, backed up as of its date), pick it, run;
confirm the input file (one action through the persisted handle, or
re-selection where no handle is held); the completion surface offers the
results and one more action, "download updated backup" -- the export, refreshed
because the secret just rotated, offered as the natural final step rather than
a later nagging prompt. On that path, with a fresh backup taken, **no standing
warnings are shown** -- green and quiet. Every warning surface in this document
is reserved for the moment its condition is true and actionable.

### The input file each run

Where the File System Access API exists (Chromium), the record persists the
input file's `FileSystemFileHandle`, with persistent read permission where the
platform grants it (an installed app), so an unattended run reads the standing
file with nobody present and an attended re-run is one action plus at most a
permission re-prompt. The handle is a persisted **pointer** to the operator's
file, never a copy of its contents -- the no-second-copy invariant is about
content and holds unchanged -- and it lives in the same origin-isolated record
as everything else the exchange persists (shape and caveats:
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md)). Browsers
without the API (Safari, Firefox) re-select the file each attended run.

On every path -- unattended, one-action, or re-selection -- the app rejects an
input file whose columns cannot satisfy the standing terms: the record's
document carries the agreed terms' column shape, a cheap guard that catches the
wrong-dataset case, though not a same-shaped wrong file.

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
device** -- on the scheduled path, the one machine whose installed app runtime
executes the runs. Two devices (or two runners) that both hold the secret and
both run fork it permanently: the first to run rotates, and the other's copy is
instantly stale with no way to reconcile automatically (there is no grace
window; see [Desync detection and
recovery](#desync-detection-and-recovery)). Single-device ownership is stated
as an invariant, not a recommendation.

Two mechanisms uphold it:

### Cross-tab single-writer locking (Web Locks)

The **run+rotate** critical section is guarded by a single-writer lock (the Web
Locks API, `navigator.locks`) keyed to the managed record's id, held for the whole
window from "begin this run" through "rotated secret durably persisted". Two tabs
of the same origin cannot both enter it: the second waits or is refused, so a
scheduled run and an operator-opened tab -- or two tabs -- on one device cannot
fork the secret by racing a run. The lock is a
same-profile **liveness guard**, not a persistent claim: it is auto-released when
the holding tab or worker is destroyed, and it is taken without `steal: true` --
a steal would defeat the single-writer property it exists to provide. Web Locks
is origin-scoped and same-profile, so it guards concurrency **within one browser
profile on one device** -- exactly the scope where a racing second context is a
realistic accident. It does **not** and cannot guard against a second physical
device or a second browser profile holding a copy; the durable single-owner
property rests on migration-not-sync (below), not on the lock.

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
spent, handed-off state -- no Run affordance, no scheduled runs, labeled with
the handoff date -- so the cooperation-not-cryptography invalidation below is
legible at the one moment it is violable. A spent record can be deleted, or
revived only by importing the artifact back.

The invalidation is an **operator-cooperation property, not a cryptographic
one**, and the design says so plainly: nothing in the protocol prevents a copied
artifact, a browser-profile backup, or a VM snapshot from resurrecting a copy
the UI "invalidated" -- the record keeps no rotation epoch, and the partner has
no way to distinguish a restored copy from the owner. A captured or duplicated
export is therefore treated as a captured credential, live until the partnership
rotates past it, under the standard [compromise
response](SECURITY_DESIGN.md#compromise-response) (notify the partner
out-of-band, re-invite). A monotonic rotation epoch carried in the record and
checked in the handshake would let a party detect a stale or forked peer; it is a
future core hardening, deferred alongside the grace window
(see [SECURITY_DESIGN.md](SECURITY_DESIGN.md#rollback-at-rest-copies-can-silently-resurrect)).

## Desync detection and recovery

A rotation desync is the failure the contract above is built to avoid, but it
cannot be driven to zero (a wholesale eviction between rotation and the next run,
or a migration mishandled by the operator, can still strand the two parties on
different secrets). The design must let a party tell a desync apart from an attack
and recover quickly.

### Detection: an implicit generic failure

When the two parties hold different secrets, the authenticated handshake simply
**fails closed** -- the same failure a wrong secret, a tampered frame, or an
active impersonation attempt produces. That surfaces as one generic
authentication failure with no way to distinguish "we rotated out of sync" from
"someone is attacking this exchange": the web handshake wrapper re-tags every
trust failure as a single `security`-kind error (on the one-shot and managed
flows, see
[SECURITY_DESIGN.md](SECURITY_DESIGN.md#recurring-web-exchanges-single-use-vs-managed)). A managed
exchange makes this ambiguity operationally sharper than the one-shot flow does,
because a desync is a recurring-partnership event an operator will hit in
normal operation, not a one-time setup slip.

### A missed window is neither desync nor attack

A scheduled run the partner's runner never arrives for is a **no-show, not a
failed handshake**: nothing authenticated and nothing failed closed, because
there was no one to fail against. It is recorded as its own benign outcome in
the run bookkeeping (a `"missed"` outcome; see
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md)) and retried at
the next agreed window, and it never enters the desync/attack framing below --
exactly as expiry never does. Only a handshake that actually ran and failed
reaches that framing. A pattern of missed windows is a coordination problem,
resolved out-of-band where the schedule itself was agreed.

### The grace window

A grace-window mitigation for a rotation desync -- on a handshake failure,
briefly also accept the **previous** rotated secret, so a one-sided persist
failure self-heals on the next run instead of forcing a re-invite -- is a
core-level change deferred to a later, separately-reviewed step, and is **not
implemented anywhere** (neither the CLI nor core accepts a previous secret; the
only current handling is the re-invite recovery procedure). The first managed
release ships with implicit-only detection plus the explicit, honest recovery
affordance below.

The grace window belongs in core rather than the web app, and later rather than
first, because it is a threat-model change: it widens the active-impersonation
window for a leaked secret (it accepts an extra, older secret), so both the CLI
and the web app should inherit one reviewed implementation rather than diverge on
a web-first version. Fast re-invite already closes the operational gap without
it, so the first release is not blocked on it. The anticipated core shape is a
brief **two-secret rotation window** -- retaining the previous secret during
rotation -- which stays deferred and is not designed here.

### Telling a desync from an attack

Without a grace window, the design cannot *cryptographically* distinguish a
desync from an attack -- both are the same failed handshake. What the managed UX
does is **tier the response by what the record already knows**, so the operator
faces the full confirmation machinery only when nothing else explains the
failure. The tiers read the record's evidence, not the operator's presence: a
failure from an unattended run surfaces through the same tiers at the
operator's next visit.

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
framing is the CLI's posture: the tool surfaces the failure and structures the
confirmation, but the operator, not the tool, makes the desync-versus-attack
call out-of-band.

### Expiry is its own state, never routed through attack framing

A lapsed age bound (`expires` in the past) is detected **before** any
connection or handshake, so it is never ambiguous: it surfaces as its own
unambiguous, benign state with plain re-invite copy -- mirroring the CLI's
distinct expired-token error, which names re-invitation rather than the generic
out-of-sync guidance -- and is never delivered through the desync/attack
framing above.

The age bound is an **optional, operator-set creation-time policy, and it
defaults to off** -- exactly the CLI's no-bound default (see [Token age and
rotation policy](SECURITY_DESIGN.md#token-age-and-rotation-policy)). When the
operator sets one, the exchange surfaces its cadence implication -- "this
exchange must run or be renewed within N days" -- for the operator to weigh
against the partnership's known cadence. The reason to opt in is a dormant
partnership: rotation caps exposure only for an exchange that actually runs, so
an idle stored secret has no automatic exposure bound unless a max-age is set
(see [The primary controls](SECURITY_DESIGN.md#the-primary-controls)).

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
deliberately.

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

The artifact is a **plaintext credential file in the operator's custody**.
Passphrase encryption is deliberately not done: the record must be usable with
nobody present to supply a passphrase at the moment of use. The artifact
is the browser analog of handing over `psilink.yaml` plus `.psilink.key`, and it
adopts the key file's exact trust model: `.psilink.key` is a plaintext credential
protected by custody and storage permissions, not a passphrase (see [Key file
security](SECURITY_DESIGN.md#key-file-security)), and the export asks for the
same handling -- owner-only storage, never an unencrypted transmission channel,
an encrypted location or secrets manager if the operator wants encryption at
rest, exactly per the key file's backup guidance. A captured or copied export
is a captured credential until the partnership rotates past it (see the
[compromise response](SECURITY_DESIGN.md#compromise-response)). The artifact
does not rotate -- it snapshots the secret current at export -- so a stale
artifact stays usable until the partnership rotates past it or any `expires` it
carries (stamped when a max-age policy is set) lapses. Re-export is prompted by
the attended run's completion surface and by the backup state below; an
unattended run rotates with nobody present, so its rotation flips the backup
state to actionable at the next visit. The artifact's shape and the
no-anti-rollback caveat are specified in
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

The refresh is offered where it is natural: on an attended run, the
run-completion surface's "download updated backup" (see [The second
run](#the-second-run-end-to-end)) is the moment the previous backup went stale,
so taking it there keeps that path green and quiet. An unattended scheduled run
rotates the secret with nobody present, so a scheduled exchange's standing
export goes stale between visits **by design**; the backup state carries that
honestly -- actionable at the next visit, a state, not a nag -- and an OS-level
notification from the installed app is the concept for prompting a re-export
sooner (its design belongs to the later scheduling and installed-app work). The
frame throughout: every honest statement appears at the moment it becomes true
and actionable.

The in-browser copy is treated as convenience and the exported credential
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

## Deleting a managed exchange

Removing a managed exchange is a first-class, always-available action, and it
removes **everything the browser holds for it in one step**: the record, the
secret, the persisted input-file handle, the schedule, and the run bookkeeping.
Deletion is local and unilateral -- it does not notify the partner, whose own
copy stands until they delete it or the partnership is re-established by
re-invite -- and it is not secret expiry: an age bound (when set) caps how long
the stored secret stays usable, while deletion removes this party's stored
information entirely, whatever the secret's state. One custody note: deletion
covers the browser's storage only; an exported backup file is under the
operator's own custody, is disposed of by the operator, and remains a
credential until the partnership rotates past it (see [the durability
backbone](#the-durability-backbone-exportimport)).

## See also

- [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md) - the record's shape (the exchange-file document plus local fields), the persist-before-success step sequence, and the export artifact's custody model
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges) - the browser at-rest threat model, the discard-secret reversal, the rollback and metadata-at-rest analyses, and the egress-hardening limits
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md#recurring-exchange-authentication) - the shared-secret rotation, `token_max_age_days`, and re-invite recovery the managed lifecycle reuses
- [DEPLOYMENT.md](DEPLOYMENT.md) - the hosted web app deployment posture and the reverse-proxy responsibilities
</content>
