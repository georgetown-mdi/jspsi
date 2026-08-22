---
title: "Managed (Recurring) Web Exchanges"
---

# Managed (recurring) web exchanges

This document describes the **managed exchange** lifecycle for the hosted web
application: how a two-party PPRL exchange, once set up, runs again on an agreed
schedule from the browser -- unattended where the platform allows -- without
re-authoring the terms or re-establishing a shared secret. Intended readers are
program officers, security reviewers, IT staff operating the hosted app, and
contributors.

It is the operational and conceptual counterpart to two companion documents: the
**managed exchange record** field-by-field shape in
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md), and the **browser
at-rest threat model** and egress-hardening limits in
[SECURITY_DESIGN.md](SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges).
It does not re-specify the record's byte-level shape, the KDF labels, or the CSP
directive syntax; those live in the spec tier.

> **Status.** The record, its rotating secret at rest, the recurring-exchange
> surfaces, the attended one-action re-run, and the installable offline app
> shell are built. Schedule entry, the
> scheduled window runner, and the between-visit OS notification are not, so
> every run is operator-initiated today and the automation described below is
> the design target rather than shipped behavior. Persisting a rotating secret
> at rest reverses the one-shot exchange's discard (see
> [SECURITY_DESIGN.md](SECURITY_DESIGN.md#recurring-web-exchanges-single-use-vs-managed)),
> so the remaining work stays gated on security review.

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
  on a server acting for the party. The installed-software path for scheduled
  runs remains the CLI plus a host scheduler such as cron. The console appliance
  is not a scheduling path -- it facilitates a single exchange (see
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
retry-at-next-window outcome** (see [A missed window is neither desync nor
attack](#a-missed-window-is-neither-desync-nor-attack)). The record persists
the agreed schedule and the retry bookkeeping
([MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md)).

The run windows both runners meet in, the retry policy for a missed one, and
the between-visit notification surface are designed under [The schedule and its
run windows](#the-schedule-and-its-run-windows) below; the record's closed
field layout for them is in
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#the-schedule-object).

## Installing the app

The hosted application is installable: it ships a complete web manifest and an
app-shell service worker, so a supporting browser offers to install it as an app
of its own.

### Why install it

Installation is not cosmetic. It is what supplies the runtime an unattended run
needs:

- **A window context that keeps running.** The exchange executes in the app's
  own window, not in a service worker (WebRTC is unavailable there).
- **Launch at sign-in**, where the browser offers it, so the runtime is present
  without the operator remembering to open it.
- **A durable home for the input-file pointer**, where the browser preserves an
  installed app's read permission across restarts rather than re-prompting.

### Enabling launch at sign-in

Chromium-based desktop browsers carry a per-app "start at sign-in" setting for an
installed app, offered from the installed app's own menu; it is the browser's
setting, not the application's, so psilink cannot turn it on and does not ask to.
A browser that does not offer it cannot be made to, and nothing here claims
otherwise -- that platform's degradation is the operator-initiated run named
under [The automation goal](#the-automation-goal-and-its-platform-envelope).

### What works with no network

The service worker caches the app shell and the build's static assets, so with no
connection at all the app still opens and reads the browser's own store:

- The app shell, the recurring-exchange list, and each exchange's detail render.
- **Running an exchange does not**, and says so rather than failing when pressed:
  a run is a live two-party session that needs both parties online at once.

How much of the app is offline-ready depends on how it is being used, and this is
one of the concrete reasons to install it:

- **Installed**, every screen is cached at launch, so all of them open offline
  whether or not the operator has visited them.
- **In an ordinary browser tab**, a screen becomes offline-ready once it has been
  opened with a connection. One that has not says so and names the recovery --
  open it once online -- rather than failing silently.

The worker is shell-only. It caches the app document and its build assets and
nothing else -- no exchange traffic passes through it, and no exchange work
happens in it.

### How a new version reaches an installed app

The application is continuously deployed, and an upgrade can invalidate a stored
record (whose recovery is [a fast re-invite](#recovery-fast-re-invite)), so an
installed copy must not pin itself to old code:

- Whenever the network is reachable, the app document comes from the network,
  so an online launch renders the deployment currently served.
- A new version installs in the background and takes over at the next launch of
  the app. When one is ready while the app is open, the app offers a reload
  rather than swapping code under a run in progress, and the browser asks the
  operator to confirm a reload pressed while a run is under way.
- An update replaces the app's cached code, not the browser's own storage: the
  recurring exchanges, their secrets, and the accounting stay in that storage,
  which is not the cache the worker manages. What an upgrade can still cost is a
  stored record the new version can no longer load, whose recovery is
  [a fast re-invite](#recovery-fast-re-invite).

## The schedule and its run windows

An unattended run takes two runners awake at the same time, and neither runner
can reach a server to be told when the other is ready. The schedule is what lets
both arrive at the same moment without any live coordination: it is a recurrence
and a window width both parties agree once, out-of-band, and then each runner
executes locally against its own clock.

### Where the schedule is agreed, and where it lives

The schedule is **partnership-level agreement, coordinated out-of-band**,
exactly as the linkage terms and the setup secret are (see
[SECURITY_DESIGN.md](SECURITY_DESIGN.md#invitation-contents-and-confidentiality)).
The two operators decide a cadence and a window together over their trusted
channel, and each enters it locally. Saving an exchange as recurring does not
yet offer schedule entry -- the record carries the field, but no surface sets
it. It is
**not** minted into the exchange-file document and **not** carried on the
invitation wire: the document is the shared terms-and-locator config, fixed for
the partnership -- changing the terms means setting up a new exchange, not
altering this one -- and a reschedule is neither a terms change nor a credential,
so the schedule is a local record field instead (the
`schedule` object; see
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#the-schedule-object)).
Nothing about the schedule is ever sent to a server or to the partner over the
wire; there is no server-side coordination anywhere in the design.

The cost of local-only entry is that each side types the same values by hand, so
a mistyped cadence or window on one side produces windows that never overlap.
That failure is benign and self-announcing: it shows up as mutual missed windows
(below), which the operators resolve out-of-band where they agreed the schedule
in the first place -- the same channel, the same reconciliation as any other
schedule drift.

### When a window opens and closes

The recurrence is an anchor instant plus a whole-day interval, and each window
stays open for the agreed width. Both parties persist the same anchor and
interval, so both compute the same window opens independently. The closed field
layout is in
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#the-schedule-object).

For an unattended handshake to happen inside a window, both runners must be
**awake and in the window at the same time**: each installed app runtime, kept
running since OS login, wakes at its own computed window open, derives the
rendezvous id from the current secret, and waits for the peer for the window's
duration. If both are present and the handshake completes, the run proceeds
through rotate-and-persist and the data exchange (see [The second
run](#the-second-run-end-to-end)). If the window elapses with no completed
handshake -- the peer never arrived, or arrived and left before this side did --
the window is recorded as **missed** and the runner advances to the next planned
window.

The window width is deliberately generous -- hours, not minutes -- for two
reasons. It absorbs clock skew between the two machines (the runners never
exchange a clock reading, so a wide window is what guarantees overlap despite
small clock differences; the honest bound is in
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#clock-skew-and-the-window-width)),
and it absorbs the ordinary slack of two independently-kept machines -- a laptop
that woke late, an app launched a few minutes after login. A missed window
carries no security meaning (see [A missed window is neither desync nor
attack](#a-missed-window-is-neither-desync-nor-attack)).

### Retry and repeated misses

The retry policy is **retry at the next agreed window**, and nothing sooner.
A miss does not trigger an off-schedule retry, a backoff, or an immediate
re-attempt: the next opportunity is simply the next window the recurrence
defines, because a sooner retry would need the partner's runner to also be
awake off-schedule, which the whole point of an agreed window is to avoid. When
both parties miss (neither runner ran), both advance to the next window and try
again there; when only one misses, the present party records a miss and also
advances -- so **whoever showed up records the miss**, and a one-sided absence
and a two-sided absence are the same benign outcome from each present party's
point of view. There is no "who retries" question to answer: neither party
retries early, and both simply meet again at the next window.

That bookkeeping is **one-sided by construction, and deliberately so**:
"whoever showed up records the miss" means the escalating surface below fires
on the party that keeps showing up -- exactly the party positioned to reach out
-- while a persistently absent party's runtime may never be awake to see
anything. The asymmetry is accepted because reconciliation needs only one side
to raise it, over the channel where the schedule was agreed. Nor is the absent
side left permanently ignorant: a runtime that wakes to find windows fully
elapsed counts each one as a miss and lands on the next live window (the
catch-up rule; see
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#catch-up-on-wake)),
so its own repeated-miss surface fires at that wake -- it learns late, but it
does learn.

A single miss is unremarkable and demands no action -- a laptop closed for the
evening, a machine mid-reboot at the window. What matters is a **pattern** of
misses, which means the partnership is no longer meeting: the partner has
stopped running the exchange, the schedules have drifted apart, or a machine's
clock is far enough off that its windows never overlap. That is a coordination
problem, and it is resolved **out-of-band, where the schedule was agreed** --
not by the app guessing. The record counts consecutive misses since the last
success (see
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#the-schedule-object)),
and once that count reaches the escalation threshold the next visit's surface
and the between-visit notification escalate to the coordination prompt, which
names **both** checks:
check with your partner, and check this machine's own clock -- a wrong local
time source produces exactly this pattern, and a no-IT operator pointed only at
the partner would never look at their own machine.

The threshold is a window count, not a wall-clock age, so it is deliberately
**cadence-relative**: on a monthly partnership the escalated state is months
away. That is accepted because each miss already
fires its own moment-anchored notification at its window (see [The between-visit
notification](#the-between-visit-notification)), so the operator is not in the
dark in the interim -- the threshold gates only the escalated
coordination-problem framing, not the operator's first knowledge of a miss.

#### Repeated misses surface, they do not auto-pause

A design question this raises: after enough consecutive misses, should the app
**automatically pause** the schedule (stop attempting until the operator
re-enables it), or only **surface** the problem and keep attempting on cadence?

This design chooses **surface-only, no auto-pause**, because for the no-IT
persona this feature serves the two failure modes are not symmetric:

- **Auto-pausing is silent, and the persona visits rarely.** A paused schedule
  stops trying with no visible signal, so a partnership that quietly stopped
  attempting is indistinguishable from a healthy one until the next in-person
  visit -- which may be weeks away. A silently paused schedule is a silently
  dead partnership.
- **Continuing to attempt costs almost nothing.** Each attempt against a partner
  who has gone away is one runner waking, reading and column-checking its input
  file, deriving a rendezvous id, and waiting out a window against a peer that
  never arrives: no wire traffic to a server, no secret exposure (the secret
  does not rotate on a miss), and one local file read. The input guard runs
  ahead of the rendezvous, not after it (see [The second
  run](#the-second-run-end-to-end)), so a no-show window costs that read.

The honest cost of not pausing is that the miss surface must itself be
trustworthy: if it read as noise the operator learned to ignore, endless quiet
retries would mask a dead partnership just as a silent pause would. That is why
the miss surface is **moment-anchored and escalating** -- one informational
note per miss at its window, the actionable coordination state only once the
pattern is real -- rather than a standing warning the operator clicks through
(the same discipline the backup surfaces follow; see [Moment-anchored backup
surfaces](#moment-anchored-backup-surfaces)).

The operator retains an explicit, manual control either way: deleting the
exchange stops all attempts (see [Deleting a managed
exchange](#deleting-a-managed-exchange)). A pause control and in-place schedule
editing arrive with the scheduling surface. What the design declines to do is make
that pause decision *for* the operator on a heuristic, because the failure mode
of a wrong automatic pause (a silently dead partnership) is worse for this
persona than the failure mode of not pausing (cheap, visible, ignorable
retries).

### The between-visit notification

Between visits the operator is not watching the app, so the "this ran / this
needs you" surface is an **OS-level notification** from the installed app -- the
platform's own notification, shown from the same app runtime that executes the
runs, the concept that reaches an operator who is not looking at a browser tab.
It is a concept-level surface here, not a wire or storage design: it reads the
same run bookkeeping the next-visit surfaces read and says the same things, just
sooner.

Four moments are worth a notification, and each maps to a state the design
already defines:

- **This ran, and your backup is now stale.** An unattended run rotates the
  secret with nobody present, which flips the derived backup state to "backup
  needed" (see [Moment-anchored backup surfaces](#moment-anchored-backup-surfaces)).
  The notification prompts the **re-export** at that moment rather than letting
  the standing backup silently drift stale until the next visit -- the
  between-visit form of the attended run's "download updated backup" step. It
  wires to the **existing** derived backup state and its transition; it does not
  introduce a second persistence-status track (see [Surviving storage
  eviction](#surviving-storage-eviction)).
- **This did not run: a missed window.** Each miss fires one quiet,
  informational notification at its window -- the run the operator expected did
  not happen, said honestly at its moment, with the next planned window named;
  no action is demanded, because the retry is automatic. A runtime that wakes to
  find windows already elapsed surfaces its accrued misses **once**, at the wake
  (the catch-up rule; see
  [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#catch-up-on-wake)),
  not one notification per slept-through window. Once the consecutive-miss count
  crosses the escalation threshold, the copy becomes the coordination prompt --
  check with your partner, and check this machine's own clock -- and further
  misses stop firing individually while that state stands (the in-app state
  carries it), so a dead partnership on a short cadence does not become a daily
  nag.
- **This needs you: the input file is missing or was rejected.** A benign
  pre-run input failure on an unattended run -- the handle's file gone at run
  start, or a refresh the column-shape guard rejects -- means no scheduled run
  can succeed until the operator re-points the handle or drops a conforming
  file, so it is actionable at its moment (see [The input file each
  run](#the-input-file-each-run)).
- **This needs you: what this run would send is not what was agreed.** A
  pre-connection disclosure refusal on an unattended run -- the input file this
  period discloses a different set of columns than the exchange recorded agreeing
  to send -- likewise blocks every later window, and for the same reason is never
  offered as retryable (see [What the setup consent carries across
  runs](#what-the-setup-consent-carries-across-runs)).
- **This needs you: a run failed with no benign explanation.** A handshake that
  ran and failed closed with no recorded benign cause (the Tier-2 case; see
  [Telling a desync from an attack](#telling-a-desync-from-an-attack)) is the
  one failure that needs the operator's out-of-band confirmation work, so it is
  worth surfacing between visits rather than waiting for the next visit.

Everything else stays quiet, and nothing repeats: each notification fires once
at its state's transition, and a condition already surfaced is carried by the
in-app state rather than re-announced at every subsequent wake (the in-app
surfaces follow the same discipline; see [Moment-anchored backup
surfaces](#moment-anchored-backup-surfaces)).

Because the notification is a concept over states the record already carries, a
platform without OS notifications loses only the *sooner* prompt: every one of
these states is still carried honestly to the operator's next in-app visit.

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
   An OS-level notification from the installed app is the "this ran / this needs
   you" surface between visits (see [The between-visit
   notification](#the-between-visit-notification)).

The **attended re-run** -- the degradations' path, available on any platform --
is the same run with the operator present: open the app (the exchange shows
quiet and green: last run succeeded, backed up as of its date), pick it, run;
confirm the input file (one action through the persisted handle, or
re-selection where no handle is held); the completion surface offers the
results and one more action, "download updated backup" -- the export, refreshed
because the secret just rotated, offered as the natural final step rather than
a later nagging prompt. On that path, with a fresh backup taken, **no standing
warnings are shown** -- green and quiet.

One notice can join those results: a re-run whose connection closed without the
partner confirming they took the final message says so beside them, in the same
words a one-shot run uses, because this side's own results are complete while
the partner's copy is in doubt (the exits and their wording:
[WEBRTC_TRANSPORT.md](spec/WEBRTC_TRANSPORT.md#the-clean-close)). It is raised
at the moment the close resolves, so it is a completion-surface notice for
whoever is present rather than a state the next visit reads -- the run
bookkeeping carries no close outcome.

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

The handle is a **live pointer to the path, not a snapshot**: each run reads
the file through the handle at run start and receives whatever file currently
exists at that path. Replacing the file at the agreed path with the current
period's extract **is** the data-refresh workflow -- an export job or the
operator drops the new file over the same name, and the next scheduled run
picks it up with no interaction. Because a `File` object obtained from a
handle is a point-in-time reference, the design reads through the handle at
each run rather than retaining `File` objects across runs: contents are always
current at run time.

A missing entry -- the file deleted, moved, or renamed away -- fails the run's
file read with a clean not-found before any connection is attempted: a third
benign state alongside expiry and the missed window, never routed through the
desync/attack framing. An unattended run records it in the run bookkeeping (a
benign `input` failure; see
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md)) and surfaces it
through the notification concept and the next visit's state; an attended visit
offers re-selection to re-point the handle. Because that state is harmless,
the same mechanics double as optional hygiene: an operator can remove the file
after a run completes and drop the next extract before the next window, so the
file -- and the persisted handle's read path to it -- has content only around
the run window (see
[SECURITY_DESIGN.md](SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)).

On every path -- unattended, one-action, or re-selection -- the app rejects an
input file whose columns cannot satisfy the standing terms: the record's
document carries the agreed terms' column shape, so a malformed or drifted
refresh is rejected as a benign pre-run problem, never silently linked -- a
cheap guard that catches the wrong-dataset case, though not a same-shaped
wrong file.

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

- **A committed browser write is not a flushed one.** The rotated-secret write
  asks the store for the strongest durability the engine offers and still cannot
  promise the bytes reached stable media: it survives a tab or renderer crash,
  but not necessarily an OS crash or power loss, and nothing in the browser
  matches the CLI's forced flush and directory flush (see
  [CREDENTIAL_STORAGE.md](spec/CREDENTIAL_STORAGE.md)). The transaction
  durability semantics this rests on are in
  [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#persist-before-success-ordering).
- The store can be **evicted wholesale** by the browser, silently, with no crash
  and no operator action (see [Surviving storage
  eviction](#surviving-storage-eviction)). The CLI's on-disk key file is not
  removed out from under it.

The ordering above therefore guarantees renderer-crash consistency; the OS-crash
and power-loss residual -- like eviction -- is covered by [fast
re-invite](#recovery-fast-re-invite) rather than by a stronger at-rest
guarantee. Browser at-rest durability is best-effort, and the design says so
rather than presenting the browser store as equivalent to a file on disk.

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

Moving a managed exchange to another device is **migration**: the source copy is
spent when the handover completes, so the secret is handed over, not duplicated.
There is deliberately no sync: syncing a linear secret across two live copies is
the exact fork the invariant forbids. Importing the artifact on the target
device installs the exchange there, and a spent source will not run again
without a fresh import or a re-invite. Framing the operation as "take over on
this device" rather than "copy to this device" is what keeps a single owner even
across a device change.

The two export intents are distinct in the UI even though the artifact is one
format. A **backup export** leaves the source live (see [the durability
backbone](#the-durability-backbone-exportimport)). A **migration export** is
"take over on another device": it downloads the artifact and then asks the
operator to attest that they saved it. The source is spent on that attestation
rather than at the moment of export, so a cancelled or failed save leaves the
source live and recoverable by exporting again; declining the attestation keeps
the exchange on this device. On confirmation the source record visibly
transitions to a spent, handed-off state -- no Run affordance, no scheduled
runs, labeled with the handoff date -- so the cooperation-not-cryptography
invalidation below is legible at the one moment it is violable. A spent record
can be deleted, or revived only by importing the artifact back.

The artifact is a **plaintext credential file in the operator's custody**.
Passphrase encryption is deliberately not done: the record must be usable with
nobody present to supply a passphrase at the moment of use. It is the browser
analog of handing over `psilink.yaml` plus `.psilink.key`, and it adopts the key
file's exact trust model: `.psilink.key` is a plaintext credential protected by
custody and storage permissions, not a passphrase (see [Key file
security](SECURITY_DESIGN.md#key-file-security)), and the export asks for the
same handling -- owner-only storage, never an unencrypted transmission channel,
an encrypted location or secrets manager if the operator wants encryption at
rest. The artifact does not rotate -- it snapshots the secret current at export
-- so a stale artifact stays usable until the partnership rotates past it or any
`expires` it carries (stamped when a max-age policy is set) lapses. Its shape
and the no-anti-rollback caveat are in
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#export-artifact).

The invalidation is an **operator-cooperation property, not a cryptographic
one**: nothing in the protocol prevents a copied artifact, a browser-profile
backup, or a VM snapshot from resurrecting a copy the UI spent. A captured or
duplicated export is therefore treated as a captured credential, live until the
partnership rotates past it, under the standard [compromise
response](SECURITY_DESIGN.md#compromise-response) (notify the partner
out-of-band, re-invite). Why the protocol cannot detect that resurrection, and
the deferred hardening that would, are in
[SECURITY_DESIGN.md](SECURITY_DESIGN.md#rollback-at-rest-copies-can-silently-resurrect).

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
resolved out-of-band where the schedule itself was agreed -- surfaced, not
auto-paused (see [Retry and repeated misses](#retry-and-repeated-misses)).

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
-- the failure surfaces as that specific benign state with its specific
recovery, which for each of them is re-invite, **without** the attack
checklist. The record's
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

The age bound is **opt-in and off by default** -- exactly the CLI's no-bound
default (see [Token age and rotation
policy](SECURITY_DESIGN.md#token-age-and-rotation-policy)). It is set at setup
and remains editable in place afterward, from the exchange's detail surface,
where it can also be cleared; an edit re-derives the bound conservatively and
never moves the stored secret's lapse later than it already stood. When the
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

The two sides recover differently, and only one has cleanup to do. The inviter
re-mints from its stored document, which rotates that record in place. The
acceptor cannot mint an invitation in the inviter's namespace, so it recovers by
accepting a fresh one -- and saving that accepted invitation adds a **new**
recurring exchange rather than updating the superseded one: nothing links an
accept to a stored partnership, and no duplicate is detected, merged, or retired.
The acceptor is left holding two records for one partnership, the superseded one
still offering a run that fails closed -- surfacing as the unexplained tier this
recovery exists to clear. So the acceptor's recovery names the step: delete the
superseded exchange once the fresh one is saved. It stays the operator's own act
on their own record store -- nothing is deleted for them, and nothing blocks the
second exchange from being saved.

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

## What the setup consent carries across runs

A managed exchange runs again on an agreement made once. The linkage terms and
the columns each side discloses are settled at setup and then **fixed for the
partnership** -- they are not edited in place, and changing them means setting
up a new exchange rather than altering this one (see [Where the schedule is
agreed, and where it lives](#where-the-schedule-is-agreed-and-where-it-lives)).
A scheduled or unattended run therefore presents nothing new to review, because
nothing about what is disclosed has changed: the same document, run against
whatever the standing input file holds this period (see [The input file each
run](#the-input-file-each-run)). The consent given at setup is what authorizes
every later run, and it keeps authorizing them because the terms it named
cannot be widened without a new exchange. What would need a fresh agreement --
different linkage columns, a different disclosed payload set, a different
partner -- is exactly what a managed exchange cannot be edited into. Agreeing
or changing a cadence is not in that class (a schedule is neither a term nor a
credential), and neither are this party's own local acts: pausing, deleting,
migrating the exchange to another device, or dropping the next extract at the
agreed path.

What the standing input file discloses is the one part of that agreement a
later period can move without anyone re-authoring anything: the set a run sends
is resolved from the file's own columns, so a refreshed extract with a changed
shape would send a set nobody agreed to. Two pre-connection gates hold it --
the set this party committed to send when the exchange was established, and the
set it confirmed for itself -- and a run whose resolved disclosure is not that
set is **refused before connecting**, in either direction: sending less than
was agreed is a mismatch no less than sending more.

That refusal is its own benign state, recorded as such in the run bookkeeping
(see [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md)) and never
routed through the desync/attack framing -- nothing connected, and nothing left
the device. It is also the one benign failure a surface must **not** present as
retryable: unlike a transport drop, a later attempt on the same file settles the
same disclosure, so the remedy is the operator's -- run the exchange with the
file whose columns were agreed, or set the exchange up again to settle a new
disclosure with the partner. Presenting it as a connection blip with retry copy
would leave a scheduled exchange failing every window with no step named.

A re-invite reopens **the secret, not the agreement**. On the inviter's side
nothing is re-authored: the fresh invitation is composed from the stored
document alone, carrying its linkage terms and its committed set of disclosed
columns over verbatim, and the setup secret is the only part newly minted --
alongside a rendezvous locator rebuilt from where the app is running and the
invitation's own fresh setup lifetime (see [Recovery: fast
re-invite](#recovery-fast-re-invite)). The accepting side is not a no-op,
though. Only the inviter can re-mint from a stored document, so the partner's
route is to accept a fresh invitation: it walks the accept flow again and
re-enters its own local fields -- its name, its metadata, its standardization
-- none of which are terms the two parties agreed. Its receive commitment lands
on the same set it originally agreed to because the re-invite carried that set
over, not because anything checks the new invitation against the old; no such
comparison exists, so an acceptor reviews a fresh invitation on its own merits,
exactly as at setup.

What a re-run is authenticated against is **continuity of the shared secret**,
and nothing else. Each side proves it holds the current rotated secret, the
handshake fails closed if either does not, and the rendezvous the two runners
meet at is itself derived from that secret -- so a run's whole claim to be the
agreed partnership is that the secret has descended unbroken from the one
exchanged at setup (see [Key-agreement
design](SECURITY_DESIGN.md#key-agreement-design)). What that does not include
is a verified counterparty identity: the exchange authenticates
possession of the secret, never who holds it, and no partner certificate or
fingerprint is checked on this path. A leaked or copied secret therefore
permits impersonation until the partnership rotates past it (see the
[compromise response](SECURITY_DESIGN.md#compromise-response)), and a handshake
that fails cannot by itself say whether the two sides drifted apart or someone
is attacking the exchange (see [Telling a desync from an
attack](#telling-a-desync-from-an-attack)).

What each run disclosed is accounted for **run by run**. Every successful run
produces the same self-attested exchange record a one-shot exchange does -- this
party's own local, unsigned account of what it disclosed on that run, carrying
no protected value (see [EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md)) -- and a
managed exchange files each of them in its own [accounting of
disclosures](#the-accounting-of-disclosures).

## The accounting of disclosures

Each managed exchange keeps its own accounting of what it has disclosed: one
entry per completed run, each entry that run's self-attested exchange record.
It is the per-exchange source an operator draws a HIPAA accounting of
disclosures or a FERPA disclosure record from (see
[COMPLIANCE.md](COMPLIANCE.md#hipaa-considerations)), and it is on the
exchange's own page, below its run history.

- **It is the records, not a summary of them.** An entry shows what that run's
  record says -- the partner, the governing agreement and the purpose of the
  disclosure under it, the categories of data that moved each way, how many
  records this party exposed, the result size where both parties received the
  result, and the instant -- and says "not recorded" where the record carries
  nothing, rather than inferring a value from elsewhere. It is self-attested and
  unsigned, exactly as the record is: an honest local account, not a signed or
  non-repudiable receipt.
- **A run files its own entry, present or not.** The entry is written as part of
  the run, before it reports its results. This is what an unattended run needs:
  the record file is otherwise offered only as a download when the run finishes,
  which requires somebody there to take it.
- **A run that did not complete is not in it.** Nothing was disclosed, so there
  is no record to file; the run history above says what happened instead.
- **It is exportable.** One action writes the whole accounting as a CSV, one row
  per run, for handing to a compliance reader.
- **It stays in this browser, and is deleted with the exchange.** Nothing prunes
  it -- a silently dropped entry would falsify the account -- and it is not
  carried in the export/import artifact, which migrates the runnable exchange
  rather than its history. Export the accounting before deleting or handing off
  the exchange; the record files offered at a run's completion stand in only for
  the runs somebody was there to download one from.

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
It is the same artifact, with the same custody model and the same
migration-not-sync semantics, as a device move (see [Export/import is migration,
not sync](#exportimport-is-migration-not-sync)): an import re-establishes the one
owner. A backup export differs only in leaving the source live.

Re-export is prompted by the attended run's completion surface and by the backup
state below; an unattended run rotates with nobody present, so its rotation flips
the backup state to actionable at the next visit.

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
notification from the installed app prompts a re-export sooner (see [The
between-visit notification](#the-between-visit-notification)). The frame
throughout: every honest statement appears at the moment it becomes true and
actionable.

The in-browser copy is treated as convenience and the exported credential
file as the durability of record, so an operator is never surprised by a silent
eviction they were implicitly told could not happen.

### Eviction recovery is the import flow

When the browser copy is gone -- evicted, or cleared with site data -- the
recovery affordance is the empty state itself, which offers the import of the
backup file the operator exported. Restoring after eviction and migrating to
a new device are the **same import operation** (consistent with
migration-not-sync): an import re-establishes the one owner, wherever it
runs. One honest limit: a wholesale eviction erases the evidence that
anything existed, so the app cannot always distinguish a first visit from a
post-eviction one -- which is exactly why the managed-exchange list's empty
state carries the import affordance standing, rather than surfacing it only
behind a detected loss.

## Deleting a managed exchange

Removing a managed exchange is a first-class, always-available action, and it
removes **everything the browser holds for it in one step**: the record, the
secret, the persisted input-file handle, the schedule, the run bookkeeping, and
its [accounting of disclosures](#the-accounting-of-disclosures) -- which is why
the confirm says to export the accounting first if it must be kept.
Deletion is local and unilateral -- it does not notify the partner, whose own
copy stands until they delete it or the partnership is re-established by
re-invite -- and it is not secret expiry: an age bound (when set) caps how long
the stored secret stays usable, while deletion removes this party's stored
information entirely, whatever the secret's state. One custody note: deletion
covers the browser's storage only; an exported backup file is under the
operator's own custody and is disposed of by the operator (see [Export/import is
migration, not sync](#exportimport-is-migration-not-sync) for what it remains
until then).

## See also

- [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md) - the record's shape (the exchange-file document plus local fields), the persist-before-success step sequence, and the export artifact's custody model
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges) - the browser at-rest threat model, the discard-secret reversal, the rollback and metadata-at-rest analyses, and the egress-hardening limits
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md#recurring-exchange-authentication) - the shared-secret rotation, `token_max_age_days`, and re-invite recovery the managed lifecycle reuses
- [EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md) - the self-attested per-run record of what this party disclosed, produced by every successful run
- [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#the-accounting-of-disclosures) - the accounting of disclosures' stored shape, its append rule, and its retention
- [COMPLIANCE.md](COMPLIANCE.md#hipaa-considerations) - how those per-run records serve an accounting of disclosures
- [DEPLOYMENT.md](DEPLOYMENT.md) - the hosted web app deployment posture and the reverse-proxy responsibilities
