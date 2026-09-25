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
> surfaces, the attended one-action re-run, the installable offline app shell,
> schedule entry, the scheduled window runner, and the between-visit OS
> notification are built: an installed app runtime runs a due exchange
> unattended at its agreed window, and tells the operator what it left behind
> once they have turned notifications on. Every state reaches the next in-app
> visit whether or not they have. Persisting a rotating secret at rest reverses
> the one-shot exchange's discard (see
> [SECURITY_DESIGN.md](SECURITY_DESIGN.md#recurring-web-exchanges-single-use-vs-managed)),
> so work here stays gated on security review.

## Who this is for

The managed exchange serves the **small or no-IT organization** -- the audience
[DESIGN.md](DESIGN.md) names as often lacking the technical sophistication for
regular data linking, for whom the project works browser-first without
installed software. That organization cannot take the documented web-to-CLI
handoff (download an exchange file, run the CLI on a schedule), because the
handoff's destination is exactly the installed, IT-operated tooling it does not
have. The managed exchange gives that operator a recurring partnership without
leaving the browser.

The calibration is accurate in both directions. An organization **with** IT
support should still graduate to the CLI plus host cron -- the CLI remains the
stronger recurring tool: on-disk key-file durability instead of evictable
browser storage, an OS scheduler instead of a browser runtime kept alive, and
the hardened container deployment. The graduation point is when the
organization can vet and operate installed software at all. Every posture
choice in this document -- browser persistence with accurate eviction handling,
automation inside the operator's own browser runtime, a plaintext export under
operator custody -- is calibrated to the no-IT persona, not to the organization
that has better options.

## What "managed" adds, and what it does not

A one-shot web exchange is single-use: the browser runs the authenticated
exchange, derives the rotated secret, and **discards** it, so the exchange
cannot run again and nothing sensitive persists. A managed exchange instead
persists the rotated secret alongside this party's exchange-file document (the
standing terms and rendezvous locator -- the browser's `alcove.yaml` plus
`.alcove.key` analog) so the same partnership can run again later.

What managed **adds**:

- A **managed exchange record** in the browser (IndexedDB, origin-isolated) that
  survives runs, crashes, and restarts.
- A **rotating shared secret at rest** in that record, in place of the one-shot
  discard.
- **Scheduled, unattended runs** as the design goal: once an exchange is
  managed and a schedule agreed, runs happen with nobody present, on the
  platforms that can support it -- with an attended one-action re-run as the
  named degradation (see [The automation
  goal](#the-automation-goal-and-its-platform-envelope)).
- **The results of those runs kept for the next visit**, since nobody is present
  to download them -- which puts linkage results at rest in the browser, bounded
  by a stated retention, by a size above which nothing is kept, by a control that
  clears them now, and by deleting the exchange (see [Where a scheduled run's
  results go](#where-a-scheduled-runs-results-go)).

What managed does **not** add:

- **No server-side execution.** Automation runs in the operator's own browser
  runtime -- an installed app kept running on the operator's machine -- never
  on a server acting for the party. The installed-software path for scheduled
  runs remains the CLI plus a host scheduler such as cron (see [Scheduling the
  run](CLI.md#scheduling-the-run)). The console is not a scheduling
  path -- it facilitates a single exchange (see
  [SECURITY_DESIGN.md](SECURITY_DESIGN.md#single-party-console-trust-boundary)).
- **No second copy of the input data.** The record never holds the input file's
  contents or any row value. Where the platform allows, it holds a file
  **handle** -- a pointer to the operator's file, not a copy (see
  [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md)). A scheduled
  run's kept results are the one thing at rest that does hold row values, and
  they are the run's OUTPUT rather than a copy of the input.
- **No server-side persistence.** There is one persistence target: the browser,
  origin-isolated, never a server. There is no profile-split persistence provider
  to choose between.

### When a column name stops the save

The stored document holds every column name the exchange declares, bounds each
one's length, refuses a name holding an invisible control or text-direction
character, and refuses a name a second column already uses. The length bound is
in
[CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#application-layer-parsed-input-bounds)
and the character class in its
[name-class rule](spec/CHANNEL_SECURITY.md#linkage-terms-name-class-character-rule).
The bound covers **every** declared column, including one the exchange never
sends: a wide vendor export whose header exceeds it can run as a one-off
exchange and still not be storable as a recurring one.

The save says which column. The offer names the column's position in the file,
shows the name itself, and states which of those rules it broke, so the fix is
the header row rather than a retry -- the same document is refused every time.
The one-off exchange that just completed is unaffected; nothing was stored.

## The automation goal and its platform envelope

The design goal is a **fully automated recurring exchange**: once an exchange
is managed and its schedule agreed with the partner, runs happen unattended.
Browser automation is inherently a compromise against installed software, and
the compromises are accepted -- what is not accepted is settling for an
attended flow where the platform can support an unattended one.

**The primary path is an installed PWA on Chromium.** The app is installed
and launched at OS login (or otherwise kept running), and the exchange executes
in the app's own window context: WebRTC is unavailable to service workers, and
Periodic Background Sync's short opportunistic windows cannot support a live
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

The surfaces say which of these the operator is looking at rather than
describing the capability in general. A schedule shown in the installed app
says the app meets its windows itself; the same schedule shown in an ordinary
tab says the tab never runs it on its own and names installing as the way to
get that. A record this browser holds no input-file pointer for says so in
either runtime, since nothing can read the input with nobody present.

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

### Incognito and Guest windows on Chrome 153 through 155

**Do not create or open a recurring exchange in an Incognito or Guest window on
Chrome 153 through 155.** Use an ordinary window. Opening a saved exchange in
one of those windows stops the browser itself, closing every window open in
it -- the other sites' windows included, not just this one.

- **The cause is a browser defect**, not a limit of this application. An
  Incognito or Guest window holds browser storage in memory, and on those
  versions reading a stored file pointer back out of memory-held storage
  terminates the browser process
  ([crbug 562119515](https://issues.chromium.org/issues/562119515)). Opening a
  saved exchange is exactly that read: the record keeps a pointer to the input
  file rather than a copy (see [The input file each
  run](#the-input-file-each-run)). Chromium 156.0.8064.0 is the first fixed
  build.
- **Ordinary windows and the installed app are unaffected**, on every version.
  Their storage is on disk, and an installed app does not run in an Incognito
  or Guest profile.
- **The application cannot warn you before it happens.** No browser interface
  reports that a window is Incognito or Guest, and a page cannot catch the
  browser stopping underneath it.

This limit is removed once Chromium 156, or a 154 build holding the fix, is the
stable channel.

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

Chromium-based desktop browsers have a per-app "start at sign-in" setting for an
installed app, offered from the installed app's own menu; it is the browser's
setting, not the application's, so Alcove cannot turn it on and does not ask to.
A browser that does not offer it cannot be made to, and nothing here claims
otherwise -- that platform's degradation is the operator-initiated run named
under [The automation goal](#the-automation-goal-and-its-platform-envelope).

### What works with no network

The service worker caches the app shell and the build's static assets, so with no
connection at all the app still opens and reads the browser's own store:

- The app shell, the recurring-exchange list, and each exchange's detail render.
- **Running an exchange does not**, and says so rather than failing when pressed:
  a run is a live two-party session that needs both parties online at once.
- **Starting one does not either**: every create or launch that opens a live run
  is held with that same reason, at the button that would start it. The quick
  path's entries stay open and say so up front, because reading an invitation and
  authoring an exchange file for the command-line tool reach no partner from
  here.

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
  operator to confirm a reload pressed while a run is under way. Declining that
  confirmation keeps the run and leaves the new version waiting, so the offer
  stands and reloading later still applies it.
- A scheduled run never applies a waiting version. Applying one is a reload, and
  the confirmation a reload raises during a run has nobody to answer it in an
  unattended runtime, so the offer is left standing for whoever opens the app and
  the waiting version takes over at the next launch either way.
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
channel, and each enters it locally, under **Local settings** on the exchange's
own page: the date and time of the first agreed window on their own clock, how
often a window opens, and how long it stays open. Scheduling is off until
someone enters one, and turning it off again returns the exchange to
attended-only without touching anything else. The schedule is
**not** minted into the exchange-file document and **not** part of the
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
rendezvous id from the current secret, and waits for the peer across the window
-- in repeated bounded waits rather than one wait as long as the window, so no
window rides on a single rendezvous surviving for hours. If both are present and
the handshake completes, the run proceeds through rotate-and-persist and the
data exchange (see [The second run](#the-second-run-end-to-end)). If the window
elapses with no completed handshake -- the peer never arrived, or arrived and
left before this side did -- the window is recorded as **missed** and the runner
advances to the next planned window.

The window width is generous by design -- hours, not minutes -- for two
reasons. It absorbs clock skew between the two machines (the runners never
exchange a clock reading, so a wide window is what guarantees overlap despite
small clock differences; the accurate bound is in
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#clock-skew-and-the-window-width)),
and it absorbs the ordinary slack of two independently-kept machines -- a laptop
that woke late, an app launched a few minutes after login. A missed window
has no security meaning (see [A missed window is neither desync nor
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

That bookkeeping is **one-sided by construction**: "whoever showed up records
the miss" means the escalating surface below fires on the party that keeps
showing up -- exactly the party positioned to reach out -- while a persistently
absent party's runtime may never be awake to see anything. The asymmetry is
accepted because reconciliation needs only one side to raise it, over the
channel where the schedule was agreed. Nor is the absent side left permanently
ignorant: a runtime that wakes to find windows fully elapsed counts each one as
a miss and lands on the next live window (the catch-up rule; see
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

The threshold is a window count, not a wall-clock age, so it is
**cadence-relative** by design: on a monthly partnership the escalated state is
months away. That is accepted because each miss already fires its own
moment-anchored notification at its window (see [The between-visit
notification](#the-between-visit-notification)), so the operator is not in the
dark in the interim -- the threshold gates only the escalated
coordination-problem framing, not the operator's first knowledge of a miss.

#### Repeated misses surface, they do not auto-pause

A design question this raises: after enough consecutive misses, should the app
**automatically pause** the schedule (stop attempting until the operator
re-enables it), or only **report** the problem and keep attempting on cadence?

This design chooses **report-only, no auto-pause**, because for the no-IT
persona this feature serves the two failure modes are not symmetric:

- **Auto-pausing is silent, and the persona visits rarely.** A paused schedule
  stops trying with no visible signal, so a partnership that quietly stopped
  attempting is indistinguishable from a healthy one until the next in-person
  visit -- which may be weeks away. A silently paused schedule is a silently
  dead partnership.
- **Continuing to attempt is cheap, and what it costs is bounded.** A
  window against a partner who has gone away is not one attempt but a bounded
  series of them -- the window's width divided by the per-attempt wait for the
  peer, up to a cap (see [Occupying a due
  window](spec/MANAGED_EXCHANGE_RECORD.md#occupying-a-due-window)). Each attempt
  re-reads and column-checks the input file through the persisted handle, since
  the input guard runs ahead of the rendezvous rather than after it (see [The
  second run](#the-second-run-end-to-end)), and registers a peer at the
  peer-coordination server under the rendezvous id derived from the record's
  current secret -- which a miss does not rotate, so a partnership that has
  stopped meeting re-registers the *same* id at every attempt of every window.
  The cost is therefore repeated local file reads plus a repeating registration
  pattern at the server the partnership already rendezvouses through. No payload
  leaves the device, nothing of the exchange is sent anywhere, and the secret is
  neither exposed nor rotated.

The full cost of not pausing is that the miss surface must itself be
trustworthy: if it read as noise the operator learned to ignore, endless quiet
retries would mask a dead partnership just as a silent pause would. That is why
the miss surface is **moment-anchored and escalating** -- one informational
note per miss at its window, the actionable coordination state only once the
pattern is real -- rather than a standing warning the operator clicks through
(the same discipline the backup surfaces follow; see [Moment-anchored backup
surfaces](#moment-anchored-backup-surfaces)).

One thing does stop the attempts, and it is not a heuristic: the operator's own
"something does not add up" answer at a failure gate holds every window after it
until they clear it (see [Telling a desync from an
attack](#telling-a-desync-from-an-attack)). Those windows are recorded as skipped
rather than missed, so they never build the pattern the coordination prompt reads.

The operator retains an explicit, manual control either way: deleting the
exchange stops all attempts (see [Deleting a managed
exchange](#deleting-a-managed-exchange)). A pause control and in-place schedule
editing arrive with the scheduling surface. What the design declines to do is make
that pause decision *for* the operator on a heuristic, because the failure mode
of a wrong automatic pause (a silently dead partnership) is worse for this
persona than the failure mode of not pausing (cheap, visible, ignorable
retries).

### Where a scheduled run's results go

A scheduled run produces the same results file an attended run produces, with
nobody there to download it. It has two places to put that file, and the operator
chooses between them where they put the exchange on a schedule:

- **A folder they grant**, which the run writes the results into. This is the
  path the app offers first, because the results land where the operator's own
  filesystem protections apply rather than in browser storage.
- **This browser**, which is what happens without such a folder and whenever the
  granted folder cannot be written to. The exchange's own page then offers the
  file at the operator's next visit.

Keeping the file one way or the other is on by default: an unattended run that
delivered nothing would leave the operator with outcome bookkeeping and never the
results the run existed to produce.

**The folder is granted while the operator is there.** A browser hands a site a
folder only under the operator's own gesture, so the grant is taken at schedule
entry, and re-pointed the same way. At run time the app only checks whether the
grant still stands -- it never asks, because there is nobody to answer. A grant
the browser will not honour with nobody present, one the operator revoked, and a
write that fails all land the results in the browser instead, and the next visit
says which happened rather than reporting a plain success. A result too large for
this browser to keep lands nowhere at all, and the state recorded in its place
names which of them preceded it too. The folder's own name and the file written
into it are what the visit names.

**A folder used for nothing else** is the practice to follow: while the grant
stands the site can read and write everything in that folder, not only the
results it writes there (see
[SECURITY_DESIGN.md](SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)).
Deleting the exchange drops the grant with the record.

What keeping the file in the browser means for the operator, stated where they
put an exchange on a schedule and again where they collect the results:

- **The rows are at rest in the browser.** The kept file is the matched
  identifiers and the payload values the partner disclosed, unencrypted, in reach
  of any script running on the site and of anyone who can read the machine's
  disk. It is the one thing a managed exchange keeps that is not presence and
  shape (see
  [SECURITY_DESIGN.md](SECURITY_DESIGN.md#results-of-a-scheduled-run-at-rest)).
- **They stay at least 30 days, counted from the run**, and are removed the next
  time the app reads or writes the store -- opening this exchange's page, or a
  later run that keeps results of its own. That is not a timer: an exchange
  nobody revisits, and that never runs again, keeps the bytes on disk past the
  30 days until one of those happens.
- **Deleting the exchange removes them at once**, in the same one step that
  removes everything else (see [Deleting a managed
  exchange](#deleting-a-managed-exchange)).
- **Downloading them does not remove them.** The download is a copy; the
  retention, the clear, or the delete is what removes the kept file.
- **A run this browser would not store the results of says so.** The operator
  meets that state at the next visit, beside the run's date, rather than finding
  nothing where results should be -- and the run itself stands: it rotated the
  secret and filed its disclosure.
- **There is a size this browser will not keep**, and it is the size of file the
  app will read: 200 MB, the same cap the intake dropzones apply. A result above
  it is kept whole or not at all -- nothing is kept and nothing is trimmed to fit
  -- and the next visit meets that state, the size the file weighed, and what to
  do about the granted folder, which takes a result of any size: choose one where
  none is granted, grant it again where the run could not use the grant with
  nobody present, or check the folder still exists and has room where the write
  failed. The run itself stands here too.
- **A clear control removes what is kept here, now.** One step removes the
  results, the notes saying where results were written, and the states recorded
  where results were not kept, without deleting the exchange. Results already in
  a folder stay in it, and the accounting of disclosures is untouched.

**A run heading for a result too large to keep is warned about first.** Once an
exchange has run, the app projects how large a result a further run on the same
terms would produce -- the two record counts the parties declared, multiplied,
one result row per matched pair -- and where that is above what this browser
keeps, it says so where the operator enters the schedule and again in the run
history. It is a worst case, so it warns while a narrower result of the same
shape would still fit; the remedy either way is the folder grant, which the size
does not apply to. The arithmetic and the measurement behind it are in
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#the-parked-results-of-a-scheduled-run).

Each unattended run leaves its own entry, so two runs between visits leave two
files -- in the granted folder as in the browser, each named by the exchange's
label and its own run's date and time, so a later run never overwrites an earlier
one and two exchanges granted the same folder stay told apart. Only the results
are kept; the run's disclosure record is already in [the accounting of
disclosures](#the-accounting-of-disclosures), and a count-only run or one whose
agreed terms give this party no output has no file to keep.

The attended re-run is unchanged: the operator is present, and the completion
screen hands the results over as it always has.

### The between-visit notification

Between visits the operator is not watching the app, so the "this ran / this
needs you" surface is an **OS-level notification** from the installed app -- the
platform's own notification, shown from the same app runtime that executes the
runs, the one surface that reaches an operator who is not looking at a browser
tab. It introduces no status of its own: it reads the same run bookkeeping the
next-visit surfaces read and says the same things, just sooner.

Seven moments are worth a notification, and each maps to a state the design
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
  not happen, said accurately at its moment, with the next planned window named;
  no action is demanded, because the retry is automatic. A runtime that wakes to
  find windows already elapsed reports its accrued misses **once**, at the wake
  (the catch-up rule; see
  [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#catch-up-on-wake)),
  not one notification per slept-through window. Once the consecutive-miss count
  crosses the escalation threshold, the copy becomes the coordination prompt --
  check with your partner, and check this machine's own clock -- and further
  misses stop firing individually while that state stands (the in-app state
  holds it), so a dead partnership on a short cadence does not become a daily
  nag.
- **This did not run: the window was skipped.** While a compromise response
  stands on the exchange, every due window is skipped rather than attempted (see
  [Telling a desync from an attack](#telling-a-desync-from-an-attack)), so the
  notification names what stopped the runs and the acknowledgement that starts
  them again. It reports a standing state rather than an occurrence, so the
  windows after the first say nothing further while it stands.
- **This needs you: the input file is missing or was rejected.** A benign
  pre-run input failure on an unattended run -- the handle's file gone at run
  start, or a refresh that cannot satisfy the standing terms -- means no
  scheduled run can succeed until the operator re-points the handle, drops a
  conforming file, or decides new terms with the partner, so it is actionable at
  its moment (see [The input file each run](#the-input-file-each-run)).
- **This needs you: what this run would send is not what was agreed.** A
  pre-connection disclosure refusal on an unattended run -- the input file this
  period discloses a different set of columns than the exchange recorded agreeing
  to send -- likewise blocks every later window, and for the same reason is never
  offered as retryable (see [What the setup consent covers across
  runs](#what-the-setup-consent-covers-across-runs)).
- **This needs you: a file is too large for a browser exchange.** A set of
  values the run had to send was over the bound one WebRTC message holds, so
  the run refused to send it; the same files build the same set at every
  window, so it is never offered as retryable (see [An input too large for one
  WebRTC message](#an-input-too-large-for-one-webrtc-message)).
- **This needs you: a run failed with no benign explanation.** A handshake that
  ran and failed closed with no recorded benign cause (the Tier-2 case; see
  [Telling a desync from an attack](#telling-a-desync-from-an-attack)) is the
  one failure that needs the operator's out-of-band confirmation work, so it is
  worth reporting between visits rather than waiting for the next visit.

Everything else stays quiet, and nothing repeats: each notification fires once
at its state's transition, and a condition already reported is held by the
in-app state rather than re-announced at every subsequent wake (the in-app
surfaces follow the same discipline; see [Moment-anchored backup
surfaces](#moment-anchored-backup-surfaces)). What holds a condition to one
notification is the runtime's own memory of what it last said about each
exchange, so a runtime relaunched while a state stands can say it once more.

Because the notification reports states the record already holds, a platform
without OS notifications loses only the *sooner* prompt: every one of these
states is still reported accurately at the operator's next in-app visit.

#### Turning notifications on

**The operator asks, and the app never asks first.** The permission prompt
follows a press of "Notify me between visits", offered with the recurring
exchanges the notifications would be about -- a prompt at first load is refused
once by an operator who has no idea yet what it is for, and a browser that has
been refused cannot be asked again. The control is shown only in the installed
app runtime, the only one that runs a schedule with nobody present. Once on,
each notification names the exchange by its operator-set label.

**Every refusal degrades to the next visit.** A denied permission, a prompt
dismissed without an answer, a browser with no notification API, and an operator
who never turns it on all leave the same behaviour: nothing is shown between
visits, nothing in the app claims otherwise, and every state is reported at the
next in-app visit. A denial is reported where the control was, naming the
browser settings that are the only way back, since the app cannot ask again.

Turning it off is the same control. The choice is remembered in this browser,
beside nothing else: it is a device preference, not part of an exchange, so it
does not travel in an export and a second device decides for itself.

## The second run, end to end

The managed exchange is judged by its second run -- the first thing the feature
does that the one-shot flow cannot. On the primary path the second run is
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
5. **The outcome lands in the run bookkeeping**, the disclosure is filed to this
   exchange's accounting, and the **results are written to the folder the
   operator granted**, or kept in the browser for them to collect at their next
   visit where there is no such folder (see [Where a scheduled run's results
   go](#where-a-scheduled-runs-results-go)). The next visit's surfaces hold the
   result of all that: the results themselves, the refreshed-backup prompt (the
   secret rotated), or the failure state. An OS-level notification from the
   installed app is the "this ran / this needs you" surface between visits (see
   [The between-visit notification](#the-between-visit-notification)).

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
bookkeeping holds no close outcome.

An attended re-run has a third ending: the wait for the partner runs out and
nobody arrives, so no handshake is attempted and nothing leaves this device.
That is the benign no-show a missed window records, and the surface names it as
one -- the partner was not there, this device is not at fault -- rather than
sending the operator to check their own connection. Where this device already
holds a reason its stored secret may no longer be the partnership's, that
reason is what the run reports instead (see [A missed window is neither desync
nor attack](#a-missed-window-is-neither-desync-nor-attack)).

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
the file through the handle at run start and receives whatever file exists at
that path. Replacing the file at the agreed path with the current period's
extract **is** the data-refresh workflow -- an export job or the operator puts
the new file at the same name, and the next scheduled run picks it up with no
interaction. The pointer follows the name rather than the file that stood
there when it was picked, so every way a tool or a person writes the refresh
reaches the run:

- The file **overwritten in place**.
- A **temporary file written beside it and renamed over the name** -- what an
  export job, an editor, or a sync client typically does.
- The file **deleted and created again** at the same name.
- The file **moved aside to an archive name**, with the new extract written in
  its place: the run reads the new extract, not the archived copy.

The record also holds the field delimiter the operator chose at the file step, so an unattended run splits the refreshed file's fields the way the operator does and writes its result file the same way. It is local to this party: the partner's file is read by whatever that party chose.

A refresh costs a run only when the run lands inside it rather than after it:
between a delete and the new file's arrival there is nothing at the path, so
that run fails its read as a missing file instead of running on last period's
data. Overwriting the file or renaming over the name leaves no such moment.

A `File` the platform hands back is the file as it stood at that instant:
once the file underneath it changes, reading that `File` fails rather than
returning either period's contents. The design therefore reads through the
handle at each run start and retains no `File` across runs -- a run reads the
current file or fails, never last period's data.

A missing entry -- the file deleted, moved, or renamed away -- fails the run's
file read with a clean not-found before any connection is attempted: a third
benign state alongside expiry and the missed window, never routed through the
desync/attack framing. An unattended run records it in the run bookkeeping (a
benign `input` failure; see
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md)) and reports it
through the notification concept and the next visit's state; an attended visit
offers re-selection to re-point the handle. Because that state is harmless,
the same mechanics double as optional hygiene: an operator can remove the file
after a run completes and drop the next extract before the next window, so the
file -- and the persisted handle's read path to it -- has content only around
the run window (see
[SECURITY_DESIGN.md](SECURITY_DESIGN.md#metadata-at-rest-presence-and-shape)).

On every path -- unattended, one-action, or re-selection -- the app rejects an
input file that cannot satisfy the standing terms: the record's document holds
the agreed terms, and the guard holds the file to the same rule the run boundary
does -- every declared linkage key satisfiable, none declaring cleaning that
drops every record -- so a malformed or drifted refresh is rejected as a benign
pre-run problem, never silently linked. It catches the wrong-dataset case, though
not a same-shaped wrong file -- one state of which, last period's extract still
standing at the path, the schedule section names on its own (see [An input that
has not changed since the last
run](#an-input-that-has-not-changed-since-the-last-run)).

That shortfall is a state of its own on the run surface, held apart from the file
that could not be read: the same file falls the same way short of the same keys
however many times it runs, so the alert copy and the affordances beside it --
the recovery block and the saved-exchanges footer -- point at the two ways
forward: a file covering every agreed key, or terms decided with the partner
over the keys both files can supply. The run control itself is not withheld;
it stays enabled on the input source and the device's connectivity alone, the
same as any other state. The copy names no key or field: the shortfall's detail
is partner-authored.

It is a state of its own in the run bookkeeping too -- its own `failureKind`,
distinct from the unreadable file's (see
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md)) -- so an
unattended run that met it shows the same two ways forward at the operator's
next visit, rather than the re-pick that would refuse identically. That is the
case the split exists for: nobody was watching when it failed.

The bookkeeping holds one thing more about a shortfall: whether the file read as
a single column, the shape a file separated by something other than the delimiter
this exchange reads it by comes out as. Where it did, the next visit and the
between-visit notification state the separator as the way forward instead of the
agreed keys -- there is nothing to decide with the partner, and copy sending the
operator to do so would not reach the remedy. The separator is one of the
exchange's **Local settings**: choosing a different one there re-reads the input
file with it and says whether the file then covers every agreed key, before the
change is saved.

#### An input too large for one WebRTC message

A set of values a run sends travels as one WebRTC message, and the party
holding it refuses to send one over the bound the partner's side accepts (see
[PROTOCOL.md](spec/PROTOCOL.md#the-memory-ceiling-and-the-csv-intake-cap)): at
run start from the input's own record count, before connecting, or at a round
from the set it built, which tells the partner the run stopped. A later round
can meet it after earlier rounds have run, so this state claims nothing about
what the run sent.

It is a state of its own, held apart from a connection problem: reconnecting
sends the same set, so no surface offers a retry. The remedy is to split the
input into smaller files and set up one exchange for each, or, where the set
was the partner's, for the partner to split theirs.

- **On the run screen**, an attended run shows the refusal's own message: the
  set's size, the bound, whose input it was, and what to do.
- **At the next visit and in the between-visit notification**, the bookkeeping
  holds the state but no size (it holds no counts), so they state the bound
  and the remedy.

#### An input that has not changed since the last run

An extract left standing at the agreed path is the one refresh failure nothing
else reports: the file reads, satisfies every agreed key, and links last
period's rows again. The exchange's schedule section names it. Where the
pointed-at file's last-changed instant predates this exchange's last successful
run, the section states both instants and the move that clears them -- put this
period's extract at that file's name before the next window opens.

Each way of replacing the file above moves that instant, so what the note reads
is a refresh that did not happen rather than one this browser could not see.

It warns and guides; it bars nothing. The run control stays enabled, the agreed
cadence stands, and an unattended window still runs -- an operator re-sending
last period's data on purpose is a decision this device cannot make for them.
The note says only what is true of the file and what to do about it.

Every reading that is not a readable instant raises nothing here, keeping the
state it already has: a browser holding no pointer re-selects the file at each
run, a file that is missing or unreadable fails the run as the benign input
state above, and a read permission no longer standing is neither prompted for
nor reported twice. An exchange with no successful run recorded has no instant
to compare against and shows nothing, and an attended-only exchange, which has
no schedule section at all, is never read for one.

## The durability and crash-consistency contract

The persisted secret is a **linear resource**: after each successful run both
parties derive the same replacement secret and retire the old one, so there is
exactly one live secret between the two parties at any moment. That property makes
the ordering of persistence and success critical.

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

### The durability limit

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
window from "begin this run" through the success that run records -- the exchange
with the partner included. Two tabs of the same origin cannot both enter it: the
second waits or is refused, so a scheduled run and an operator-opened tab -- or
two tabs -- on one device cannot fork the secret by racing a run, and no two of
them exchange with the partner for one record at the same time.

A hand-off's confirmation takes the same lock before it spends this device's copy,
so a hand-off and a run exclude each other as two runs do. Whichever takes the lock
first wins the ordering: a confirmation meeting a run is refused and told to wait,
and a run meeting a confirmation waits for it and then finds the copy handed off.
A re-invite's mint takes it on the same terms before it replaces the secret, so a
run and a fresh invitation cannot each write a secret the other discards.

On the scheduled path that refusal lasts as long as the run window does. Each
attempt holds the lock across its whole wait for the partner, and the next
attempt begins as soon as the last one's wait ends, so a runner occupying a
window holds the lock essentially continuously from the window's open to its
close -- hours, at the widths the design intends. An operator who opens the app
during an occupied window and runs the exchange by hand is told a run is already
in progress, and keeps being told for as long as an attempt holds the lock. That
is the single-writer property working as intended rather than a fault. An
attempt's wait for the partner is clamped to the window's close, but a handshake
that completes just before the close holds the lock through the payload exchange
that follows, so the operator's Run is available again once the exchange in
flight settles -- which can be after the window is over.

The lock is a same-profile **liveness guard**, not a persistent claim: it is
auto-released when the holding tab or worker is destroyed, and it is taken
without `steal: true` -- a steal would defeat the single-writer property it
exists to provide. Web Locks
is origin-scoped and same-profile, so it guards concurrency **within one browser
profile on one device** -- exactly the scope where a racing second context is a
realistic accident. It does **not** and cannot guard against a second physical
device or a second browser profile holding a copy; the durable single-owner
property rests on migration-not-sync (below), not on the lock.

### Export/import is migration, not sync

Moving a managed exchange to another device is **migration**: the source copy is
spent when the handover completes, so the secret is handed over, not duplicated.
There is no sync by design: syncing a linear secret across two live copies is
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
invalidation below is clear at the one moment it is violable. A record spent this
way can be deleted, or revived only by importing the artifact back. What its
earlier scheduled runs left in this browser is still collected on that page: the
hand-off takes the exchange's future runs, not the results already at rest here
(see [Where a scheduled run's results
go](#where-a-scheduled-runs-results-go)).

**A hand-off refuses a copy a run has already superseded.** Confirming either
hand-off -- the device migration here, or the command-line export below --
re-reads the stored record first, and refuses unless what was downloaded still
holds the exchange's current secret. A run rotates that secret at its
handshake, so a run that reaches the partner between the download and the
attestation supersedes what was downloaded: confirming it would hand the new
owner a copy whose first run meets a partner that has moved on, and only a
re-invite recovers the pair. The refusal says so, nothing is spent, and the
remedy is to download the exchange again -- from where the refusal is shown,
which is the download button beside the command-line panel's confirmation and
"Keep it on this device" then "Move to another device" on the migration screen.
An exchange that has gone from this browser entirely -- deleted, or cleared with
the browser's storage -- refuses the same attestation for a different reason, and
says that instead: there is nothing here to hand over and nothing here to
download again.

**And a run refuses a copy a hand-off has already given away.** The refusal runs
both ways, on the run path itself rather than on what a screen last read: a run
that finds this browser's copy spent stops before reading the input file and
before connecting, so a hand-off confirmed while a run surface stood open, or
between two attempts at one scheduled window, is not overtaken by the run that
follows it. There is no override -- the exchange runs where the hand-off took
it. An attended run refused that way leaves the surface on the handed-off state
straight away, naming the hand-off that spent the copy and what it left behind,
rather than an error the operator has to reload past.

A run that cannot read that state at all refuses on the same terms and says so
in its own words: this browser could not read the note it keeps beside the
exchange, so the run stopped before reading the input file and before
connecting. It is not reported as a rotation this device failed to save, and it
offers no re-invite. Nothing rotated, so the two parties are not out of step
and a fresh secret would replace one nothing moved; the note that did not read
is what has to become readable, and running the exchange again meets the same
note until it does.

Ahead of that refusal, both hand-offs -- and the downloads that start them --
are withheld while this tab is running the exchange, and while a run in any
other context holds the [single-writer
lock](#cross-tab-single-writer-locking-web-locks), which is how a second tab's
run or a scheduled one reaches them. The surface names the run as the reason;
the hand-offs return when this tab's run ends or, for another context, when that
run ends and releases its lock.

That withholding is a reading of the lock taken every so often, so it can miss a
run that starts between two readings. Nothing rests on it: confirming a hand-off
takes the run's own lock before it spends anything, and a run holding that lock
refuses the confirmation in the same words the withholding uses. Waiting is the
whole remedy -- confirm again once the run is over, and the exchange hands over
unless that run rotated the secret, which is the refusal above and its own
remedy. A confirmation that spends and a run that rotates therefore exclude each
other rather than racing, in either order.

The artifact is a **plaintext credential file in the operator's custody**.
Passphrase encryption is not done, by design: the record must be usable with
nobody present to supply a passphrase at the moment of use. It is the browser
analog of handing over `alcove.yaml` plus `.alcove.key`, and it adopts the key
file's exact trust model: `.alcove.key` is a plaintext credential protected by
custody and storage permissions, not a passphrase (see [Key file
security](SECURITY_DESIGN.md#key-file-security)), and the export asks for the
same handling -- owner-only storage, never an unencrypted transmission channel,
an encrypted location or secrets manager if the operator wants encryption at
rest. The artifact does not rotate -- it snapshots the secret current at export
-- so a stale artifact stays usable until the partnership rotates past it or any
`expires` it holds (stamped when a max-age policy is set) lapses. Its shape
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

### Exporting to the command line

The graduation the calibration in [Who this is for](#who-this-is-for) names has
its own action on the exchange's detail surface: a collapsed **Run this from the
command line instead** panel, beside the backup panel. It hands the exchange to
`alcove exchange` under the host's own scheduler, and it is a migration by
another route -- the single-owner rule applies to it unchanged.

It downloads **two files rather than one archive**, because the two are handled
differently once they land:

- `alcove.yaml` -- the agreed terms and the rendezvous address. No secret.
- `.alcove.key` -- this exchange's shared secret, in plain text, under the key
  file's own custody rules ([Key file
  security](SECURITY_DESIGN.md#key-file-security)).

Saved into one folder, the two are what the emitted invocation opens: the CLI
reads both at its default paths, so the command includes no path from any
machine and needs no flag. The panel shows that invocation beside the cron and
Task Scheduler lines that run it daily.

The spend is **operator-attested**, exactly as a device migration's is: two
downloads are two chances for a save to fail, and a click gives no landing
signal, so the browser copy stays live and runnable until the operator confirms
both files landed. Confirming spends it; declining keeps the exchange here, and
the operator can export again. No path hands the secret to a scheduler and leaves
a second live owner behind.

On every later visit the browser names that hand-off rather than a migration's:
the recovery a migration has -- import the artifact back -- has nothing to act on
here, because the two files are the CLI's own, not the artifact. An older browser
backup does not stand in for them either. Importing an artifact exported before the
hand-off is **refused** while the handed-off exchange is still listed here and the
artifact has the secret it was spent holding: importing it would either run a
copy this browser gave away or leave that copy live beside the spent one, and one
owner holds a recurring exchange's secret. The refusal names the exchange and
what it has instead: it runs on the machine holding those two files from then
on, and the way back to this browser is the take-back on that exchange's own
page, below.

Those two conditions bound it, and an import outside them installs an ordinary
fresh exchange:

- **An artifact older than the last rotation** has a secret no spent record
  here holds, so nothing matches it.
- **Deleting the handed-off exchange** takes away the record the match is made
  against -- the operator's own choice, and the same cooperation every
  single-owner rule here rests on.

Neither leaves two copies running side by side for long. An older artifact
already has a secret the partnership has moved past, and a copy of the current
one diverges from the handed-off files the moment either side runs and rotates,
so the losing copy's next run fails its handshake and is exposed through
[Desync detection and recovery](#desync-detection-and-recovery), whose recovery
is a fresh invitation.

Two things do not travel with the files:

- **The schedule.** The agreed run window is a browser-record field the CLI does
  not read, so the cron entry or scheduled task is the schedule from then on --
  set to the window the partner expects.
- **The accounting of disclosures**, as with a device migration: export it as CSV
  before confirming if it is needed.

The STUN disclosure moves rather than begins. A managed connection names no STUN
server -- it is a credential-free rendezvous locator by composition -- so a
managed run already falls back to a built-in STUN default to discover its own
public address, in this browser as on the command line, disclosing that address
and the fact of a session to that server (no exchange content). What the hand-off
changes is **whose** address is disclosed -- the scheduling machine's rather than
this browser's -- and that the CLI names it in a warning on every run. Naming a
`stun` server in the exported `alcove.yaml` is what replaces the default.

The two files have the current secret, but they are a backup for the command line,
not for this browser: reconstituting a browser copy after an eviction is the artifact
import ([Eviction recovery is the import
flow](#eviction-recovery-is-the-import-flow)), which these two files are not. The
pair can be imported back ([Bringing a command-line configuration
back](#bringing-a-command-line-configuration-back)), but it is the command line's
working copy: every run there rewrites `.alcove.key` with the secret it rotated
to. So -- unlike the backup and migration exports -- taking this one **marks nothing**: the
exchange's backup state is exactly what it was before, whether the operator confirms
the hand-off or declines it. A backup indicator reading green is a promise that a file
this browser restores from exists, and these files are not that file. The panel says
so where it offers them, so the two kinds of export are told apart before either is
downloaded. An operator who declines the hand-off and keeps running here still needs
an ordinary backup; one who confirms it has handed the exchange over, and the two
files are its backup of record from then on.

### Taking it back from the command line

An exchange handed to the command line can be brought back. The scheduled job was
abandoned, the machine is going away, or the operator simply wants to run it here
again: the handed-off exchange's own page offers **Take this exchange back**, and
it is the only way back -- an old backup file is refused, for the reasons above.

Taking it back is one deliberate step with a confirmation, not a quiet reversal,
because two things have to be true and only the operator knows them:

- **The scheduled run there is stopped.** If both keep running, each run changes
  the shared secret and whichever copy rotates second leaves the other unable to
  connect to the partner.
- **Whether it has run there since the hand-off.** Every command-line run changes
  the shared secret and writes the new one back into `.alcove.key`, so after a run
  that file holds the secret the partner expects and this browser's stored one does
  not. The confirmation asks for that file together with the `alcove.yaml` beside
  it, both in one pick, from the folder the exchange was handed off to; this
  browser picks the exchange back up where the command line left it. The key file
  names no exchange, so the `alcove.yaml` is what is checked: files stating other
  terms, or the other side's files, are refused and nothing changes. Nothing can
  tell an older copy of the key file from the current one, though, and the file
  chosen replaces the only copy of the secret this browser has, so an older copy
  leaves the exchange unable to connect and a fresh invitation the only way back.

Where nothing has run there since the hand-off, no file is needed: the secret
stored here is still the partnership's. Where the files cannot be got at all, take
the exchange back without it and create a fresh invitation for the partner from the
same page -- the recovery for any secret this browser cannot match ([Recovery: fast
re-invite](#recovery-fast-re-invite)).

An exchange taken back either way counts as restored until a run succeeds here. So
if a command-line run did happen after all, and the secret stored here is behind the
partner's, the next run's failure reports that benign state and its re-invite
recovery instead of sending you to check with your partner out of band ([Telling a
desync from an attack](#telling-a-desync-from-an-attack)).

Declining the confirmation writes nothing: the exchange stays handed off, and the
files on the other machine stay its backup of record. The exchange comes back as
it was -- same terms, same label, same schedule, same accounting of disclosures --
because none of that ever left this browser. The schedule is the one thing to
settle by hand: the cron entry or scheduled task that was meeting the agreed window
is no longer the one meeting it, so remove it there.

### Bringing a command-line configuration back

An `alcove.yaml` written for the command line imports here on its own, without
its key file, whichever channel it runs over. What lands is a
**configuration-only** exchange: the agreed terms, the connection, and the local
settings, with no shared secret. It is for the operator who would rather set an
exchange up in a browser than author YAML, and run it where the data and the
scheduler are -- read the file in, edit what is editable, download it again, run
it there.

The list's one import control takes it, whether the list is empty, holds
exchanges already, or cannot be read; the same control takes a backup file
([Eviction recovery is the import
flow](#eviction-recovery-is-the-import-flow)).

**To run the exchange in this browser, choose its `.alcove.key` too**, in the
same pick as the `alcove.yaml`. Its name starts with a dot, so the file chooser
may hide it until hidden files are shown. The pair lands as an exchange that runs
here, and the import says so before you open it; an `alcove.yaml` chosen alone
lands as the configuration only, and its page says that instead. Before the
first run here, stop the scheduled command-line run of the same exchange: each
run on either side changes the shared secret, and the copy that falls behind can
no longer connect to your partner. What the pair import takes and refuses:

- **The key file Alcove wrote.** A file that is not JSON, holds no shared
  secret or one Alcove would not write, has an `expires` that is not a date and
  time, or holds any other field is refused, saying which, and nothing is
  imported. The refusal never shows what the file holds.
- **Only an exchange this browser runs.** An sftp or filedrop configuration, or
  one whose `signing` block asks for a receipt, is refused with its key file;
  import the `alcove.yaml` on its own to edit it here. A `signing` block with
  `mode: none` asks for none, so it runs here and is kept as written.
- **One copy of an exchange.** An exchange is recognized by its shared secret. If
  this browser already runs the exchange the key file belongs to, nothing is
  imported and the refusal names it. If you handed it off to the command line
  from here, the import refuses and names the way back: open it from the list and
  choose "Take this exchange back", with these two files. An exchange moved to
  another device from here comes back as the same entry in the list, unless the
  files are for the other side of it -- your partner's -- which is refused.
- **An exchange you already have, after its secret changed.** A key file the
  command line has rotated since the exchange left this browser matches no
  secret here, and a configuration imported alone holds none. So when an
  exchange in the list was handed off to the command line, moved to another
  device, or imported as a configuration only, and has the same terms and the
  same side as the files, the import stops and names it. You can take the files
  into it -- taking a handed-off exchange back, restoring a moved one, or
  completing a configuration with its key file -- add them as a new exchange
  instead, or cancel. Two separate exchanges can share terms and side, so
  nothing is taken in without your answer. Before taking a handed-off exchange
  back, stop its scheduled run on the command line.

The secret is kept only in this browser's stored copy of the exchange, as for an
exchange set up here; the import marks the exchange as restored, and it reads as
needing a backup until you export one.

A configuration imported alone **does not run in this browser**. It sits in the same list as
the exchanges that do, with Open in place of Run, and its own page says why in
place of the Run and schedule controls:

- **A webrtc configuration** has no key file here: without the secret the
  partnership rotates, there is nothing here to connect with.
- **An sftp or filedrop configuration** runs over a channel this browser does
  not conduct -- it runs live browser exchanges (webrtc) only. The page names the
  channel and says to run the exchange with Alcove on the command line; a key
  file would not change that.
- **A configuration with a `signing` block** in `certificate` or
  `session-derived` mode asks for a signed exchange receipt, which this browser
  does not produce. The page and the list name `signing` as the part this app
  cannot run, on any channel; a key file would not change that either.

Nothing about the exchange on the other machine changes by importing its
configuration -- it keeps running there, from the files it already has.

What the import accepts is what this app can hold:

- **A file Alcove itself would load.** A hand-edited configuration that no
  longer matches the format Alcove reads is refused naming the fields to fix,
  spelled as the file spells them, so the operator goes back to the line rather
  than to the app.
- **A connection this app can hold.** A webrtc connection may hold what this
  app composes for it, a rendezvous address; a TURN credential, an ICE
  provisioning block, or a PeerJS server key is refused by field name, since
  this browser runs a webrtc exchange and could not apply them. A filedrop
  connection holds its folders and `options`. An sftp connection is held whole
  -- host, port, username, folders, `options`, `host_key_fingerprint`,
  `keyboard_interactive`, `proxy`, and `provider_options` -- since
  nothing here runs it and each setting goes back into the file Alcove runs.
- **A `signing` block, held unchanged.** The mode, `identity_file`,
  `partner_fingerprint`, and `receipt_output` are kept exactly as the file
  writes them -- an `@` in a path is text, and this browser opens no file it
  names -- with no editor here, and the exported configuration states the block
  as the imported one did. The exchange runs with Alcove.
- **Credentials as `@path` references, never as values.** An sftp `password`,
  `private_key`, or `private_key_passphrase`, the `bearer` or `password` of a
  `proxy` block's `auth`, and a `password`, `passphrase`,
  `privateKey`, or `private_key` key in `provider_options`, in any letter case
  and at any depth, is held when the file writes it as `@` and a path, and
  refused, by field name, when the file writes any other value, a number or
  `true` included: this browser does not store a secret. The refusal
  says to put the value in a file of its own and write the setting as `@` and
  that file's path. Any other `provider_options` setting, such as a cipher
  list, is held as written.
- **No shared secret.** A configuration naming one in its `authentication` block
  is refused: the secret comes in only from the `.alcove.key` chosen beside it.
  Alcove reads the secret from `.alcove.key` and refuses it in `alcove.yaml`
  for the same reason.
- **A `role` on a webrtc connection.** The configuration has to say which side of
  the partnership this party takes; the command line refuses a webrtc connection
  that names none, and so does this. An sftp or filedrop connection has no `role`.

What is editable is what a browser-run exchange edits in place: the label; the
maximum age for the exchange's secret, which the exported configuration holds as
`authentication.token_max_age_days` for the command-line run to apply; and the
three settings of the file that are this party's alone -- which of its own columns
its result file holds (`include_own_columns`), how its input file separates fields
(`csv_delimiter`), and its retention note (`retention_disposition`).
The agreed terms are read-only here as everywhere else -- exchanging on different
terms is a new exchange, agreed with the partner. An import that is not edited
exports back to the same configuration, and an edited one exports back with the
edits and every other setting as the file stated it.

The page states three more things where they apply:

- **The settings it keeps without showing them.** Every setting of the file
  other than the connection, the agreed terms, and the settings it edits --
  `metadata`, a connection's `options`, an sftp connection's
  credential references, host-key pin, and the rest -- is kept unchanged and
  named, in the file's own snake_case, with a pointer to the file as the place to
  edit it.
- **The files it names by `@path`.** This browser never opens the file an
  `@path` names. The page warns, naming each such setting and never its path,
  that the alcove.yaml it hands back keeps the reference as the file wrote it
  and Alcove reads that file on the machine that runs the exchange; the export
  panel repeats the names.
- **A pending outbound payload consent.** A configuration whose
  `outbound_payload_consent` is pending is refused by Alcove at any run that
  shares results with the partner until the columns are confirmed, which it asks
  for at a terminal. The page says so, so a scheduled run is not the first place
  the operator meets that refusal.

An SFTP configuration that names no credential or no host key exports without
one: the export panel says to add `private_key` or `password` (as an `@path`),
`host_key_fingerprint`, or both under `connection.server` before running it.

## Desync detection and recovery

A rotation desync is the failure the contract above is built to avoid, but it
cannot be driven to zero (a wholesale eviction between rotation and the next run,
or a migration mishandled by the operator, can still strand the two parties on
different secrets). The design must let a party tell a desync apart from an attack
and recover quickly.

### Detection: an implicit generic failure

When the two parties hold different secrets, the authenticated handshake simply
**fails closed** -- the same failure a wrong secret, a tampered frame, or an
active impersonation attempt produces. That shows as one generic
authentication failure with no way to distinguish "we rotated out of sync" from
"someone is attacking this exchange": the web handshake wrapper re-tags every
trust failure as a single `security`-kind error (on the one-shot and managed
flows, see
[SECURITY_DESIGN.md](SECURITY_DESIGN.md#recurring-web-exchanges-single-use-vs-managed)). A managed
exchange makes this ambiguity operationally sharper than the one-shot flow does,
because a desync is a recurring-partnership event an operator will hit in
normal operation, not a one-time setup slip.

### A missed window is neither desync nor attack

A run the partner never arrives for is a **no-show, not a failed handshake**:
nothing authenticated and nothing failed closed, because there was no one to
fail against. A scheduled run reaches that state when an agreed window passes
with the partner's runner absent; an attended run reaches the same state when
its own wait for the partner expires with the operator watching. Either way it
is recorded as its own benign outcome in the run bookkeeping (a `"missed"`
outcome; see [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md)),
and it never reaches the out-of-band confirmation the tiering below reserves
for a handshake that ran and failed closed. The recovery is another attempt
with both parties present: the next agreed window's automatic retry, or the
operator running the exchange again once their partner is ready.

A window the runner skipped is not a no-show either, and is not recorded as one:
nothing waited for the partner, because the operator's own answer at a failure
gate held the window (see [Telling a desync from an
attack](#telling-a-desync-from-an-attack)).

A no-show is no evidence of a desync -- and no evidence against one. Both
rendezvous ids derive from the shared secret, so two sides holding different
secrets wait on addresses the other is not using, and each records a no-show,
every time, for as long as the desync stands. The no-show is therefore the
reading of last resort: where this device already holds a standing reason its
secret may no longer be the partnership's -- a restore since the last
successful run, a one-sided persist failure, or a lapsed bound -- the run
reports that state and its re-invite recovery instead. Where it does not, the
no-show state names the persistent case in its own copy, so a partner who was
demonstrably at their machine at an agreed time and still never arrived is
pointed at a re-invite rather than at another wait.

That outranking belongs to the run that meets the no-show, and it weighs the
standing reason as the stored record holds it at that run's launch -- read
before the run, so the run's own bookkeeping is never what it reads. The
reading is therefore per run, not per visit: a persist failure one run records
is the standing reason the next run in the same visit weighs. Where that
persist failure's own bookkeeping write did not land -- the write is
best-effort, and the storage that failed the rotation can fail it too -- there
is no standing reason to read, and the no-show is treated as itself. Where the
launch read itself fails, or finds no record to read, the run falls back to
the record the run surface already holds, for that run alone.

A no-show's own bookkeeping entry replaces the previous one and records no
failure kind, so the entry that held a one-sided persist failure or a
failed-closed handshake is gone from the record the moment a no-show is stamped.
The evidence is not: both are also raised as a **standing condition** beside that
entry, which no run stamp reaches (see [A standing condition outlives the run
that raised it](#a-standing-condition-outlives-the-run-that-raised-it)), so the
recurring-exchanges list line, the exchange's own page, and a later run all still
read it. The other two reasons live outside the entry as well -- a lapsed bound
is the record's own `expires`, and a restore since the last success its import
marker, which a standing failed-closed handshake is read against exactly as a
freshly recorded one is.

### A standing condition outlives the run that raised it

Two failures have a remedy the operator must carry out with their partner rather
than on this device: a rotation this device could not save, which may have left
the two parties on different secrets, and a handshake that failed closed with
nothing to explain it. Both are recorded as a run's `failureKind`, and a run's
bookkeeping holds one run -- so the next stamp, a benign no-show above all,
replaces it. Left there, the confirmation the tiering below reserves for exactly
this class would be asked for once and never again: every visit after the first
no-show would read "your partner did not arrive" and stop.

So the evidence is **raised as a standing condition** as well, beside the run
bookkeeping, where no later run's stamp reaches it. It carries the instant of the
run that raised it and which of the two failures it was, and nothing else. The
first one stands: a later failure of the same class leaves it as it is, because
answering it is a single act over everything that stood before -- and the message
the operator forwards names that later failure beside the first, so the partner
checks their own logs for both occasions.

Three things clear a standing condition, and nothing else does:

- **The operator's explicit clear-and-acknowledge**, on the exchange's own page.
  For a handshake failure nothing explains, that control is the two-outcome gate
  below: a partner who confirms their identity and a real failure on their side
  clears the condition, with the re-invite still offered as the remedy, and a
  reply that does not add up clears nothing and records the compromise response
  on the exchange instead. Where the record already holds the explanation -- a
  persist failure, or a restore since the last success -- there is no attack
  checklist to pass: the page states the condition and its re-invite recovery,
  and a short acknowledgement clears it.
- **A re-invite**, which drops it with the run bookkeeping in the same rotation
  that installs the fresh secret. It is the recovery the condition asked for.
- **Deleting the exchange**, which takes it along with the record.

A no-show never clears one, and neither does a successful run on its own. The
success is tempting to read as the all-clear, and it is not one: it rules out
neither a third party who tried and moved on nor an accidental self-fork, which
are exactly the two readings the confirmation exists to separate. The operator
settles it, or a re-invite does.

One window needs the condition raised twice over. A store failure can span a
run's rotation write and its own best-effort bookkeeping write, and then recover
in time to answer the schedule's advance -- leaving the plan moved past a window
that neither ran nor recorded anything at all. So the window's own write carries
the condition its run raised, as a second chance at the evidence the run could
not persist.

A pattern of missed windows is a coordination problem, resolved out-of-band
where the schedule itself was agreed -- reported, not auto-paused (see [Retry
and repeated misses](#retry-and-repeated-misses)).

### The grace window

A grace-window mitigation for a rotation desync -- on a handshake failure,
briefly also accept the **previous** rotated secret, so a one-sided persist
failure self-heals on the next run instead of forcing a re-invite -- is a
core-level change deferred to a later, separately-reviewed step, and is **not
implemented anywhere** (neither the CLI nor core accepts a previous secret; the
only current handling is the re-invite recovery procedure). The first managed
release ships with implicit-only detection plus the explicit recovery
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
failure from an unattended run is reported through the same tiers at the
operator's next visit.

**Tier 1: local evidence explains the failure.** When the record holds a benign
explanation -- a recorded persist failure on the last run (the structured
`failureKind` bookkeeping), a detected restore-from-backup or import since the
last successful run, or a lapsed age bound (which never even reaches here; see
[Expiry is its own state](#expiry-is-its-own-state-never-routed-through-attack-framing))
-- the failure shows as that specific benign state with its specific
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
  expose it.

The partner's reply feeds a **two-outcome gate**, not a free-form judgment:
"the partner confirmed a real failure on their side" proceeds to re-invite;
"something does not add up" is treated as compromise and routes to the
[compromise response](SECURITY_DESIGN.md#compromise-response). The accurate
framing is the CLI's posture: the tool reports the failure and structures the
confirmation, but the operator, not the tool, makes the desync-versus-attack
call out-of-band.

Once given, a compromise response is kept with the exchange, wherever it was
given: a later run that fails the same way does not put the question again, a
reload and the next visit find it as the operator left it, and no control on the
exchange's page offers a fresh invitation while it stands -- neither the
failure's own recovery nor the configuration section's re-invite on the same
terms -- since minting one on that channel is the act the response names as the
wrong one. A page left open from before the answer was given is held by the same
rule: the write that would rotate the secret reads the exchange itself and
refuses, so a second tab cannot mint past an answer it never saw.

The schedule is held by it as well. A window that falls due while the response
stands is **skipped**: the runner connects to nobody and rotates nothing, since a
scheduled run would put the secret the operator flagged back on the channel they
flagged it over, with nobody present to see it. The skip is recorded as the
window's own outcome rather than a partner's absence, so it counts toward no miss
pattern and reaches no coordination prompt (see [Retry and repeated
misses](#retry-and-repeated-misses)); the exchange's page names it in the run
history, and the between-visit notification says it once while the answer stands.
The schedule resumes at the next due window the moment one of the three acts
below clears the answer.

Running the exchange from the page is left available under the response, with its
warning standing over the control. The difference is who decides: an attended run
is the operator's own act, taken with what the response says in front of them,
while a scheduled one would be taken by a machine with nobody watching.

It is kept where the standing condition is kept, so exactly the three acts that
clear a standing condition clear it too, and nothing else does. The one the
exchange's page offers under a response is the acknowledgement that the partner
confirmed the failure on another channel: it settles the condition, the response
goes with it, and the fresh invitation is on offer again for the operator to
send. That ordering -- reach the partner another way first, then re-invite -- is
what the response is for.

The answer covers the failure it was given at. Where a run since then failed the
same way, that later failure is one the operator has confirmed nothing about, so
the acknowledgement puts its gate rather than the invitation: the two-outcome
gate is asked once per failure, and no control mints while one of them is
unanswered.

A run in flight withholds the same two controls for an unrelated reason and on
its own schedule: while a run of this exchange is under way anywhere in the
browser profile -- this tab, another tab, or its schedule -- a fresh invitation
would replace the secret the run is connecting on, so neither control mints one
until the run ends. Nothing here is answered away the way the compromise
response is: the withhold lifts on its own once the run finishes, whatever it
finished with. Nothing rests on the reading: the mint's own write takes the run's
lock before it replaces the secret, so a run started since the page last read that
state refuses the mint in the same words the withholding uses. The control
re-checks the reading at the click as well, which puts the reason on screen
without waiting for that refusal.

### Expiry is its own state, never routed through attack framing

A lapsed age bound (`expires` in the past) is detected **before** any
connection or handshake, so it is never ambiguous: it shows as its own
unambiguous, benign state with plain re-invite copy -- mirroring the CLI's
distinct expired-token error, which names re-invitation rather than the generic
out-of-sync guidance -- and is never delivered through the desync/attack
framing above.

The age bound is **opt-in and off by default** -- exactly the CLI's no-bound
default (see [Token age and rotation
policy](SECURITY_DESIGN.md#token-age-and-rotation-policy)). It is set at setup
and remains editable afterward, from the exchange's detail surface, where it
can also be cleared; an edit re-derives the bound conservatively and never
moves the stored secret's lapse later than it already stood. When the operator
sets one, the exchange shows its cadence implication -- "this exchange must run
or be renewed within N days" -- for the operator to weigh against the
partnership's known cadence. Where the exchange also has an agreed schedule,
that weighing is done for them: a cadence whose next window opens at or past
the bound is reported as a problem at entry, since the stored secret would
lapse before the window that would have refreshed it. It is stated rather than
refused -- an operator who renews by hand is entitled to that cadence -- and it
is unreachable for an exchange that set no bound. Opt in for a dormant
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
scratch. This makes re-invite cheap enough to be the first-line recovery,
which is what lets the first release ship without the grace window.

The two sides recover differently, and only one has cleanup to do. The inviter
re-mints from its stored document, which rotates that record in place. The
acceptor cannot mint an invitation in the inviter's namespace, so it recovers by
accepting a fresh one -- and saving that accepted invitation adds a **new**
recurring exchange rather than updating the superseded one: nothing links an
accept to a stored partnership, and no duplicate is detected, merged, or retired.
The acceptor is left holding two records for one partnership, the superseded one
still offering a run that fails closed -- showing as the unexplained tier this
recovery exists to clear. So the acceptor's recovery names the step: delete the
superseded exchange once the fresh one is saved. It stays the operator's own act
on their own record store -- nothing is deleted for them, and nothing blocks the
second exchange from being saved.

Cheap recovery has a cost that must be named. Every re-invite puts a fresh live
setup secret on the out-of-band channel, so over a partnership's life the
invitation-confidentiality requirement (see [Invitation contents and
confidentiality](SECURITY_DESIGN.md#invitation-contents-and-confidentiality))
is **ongoing, not one-time** -- each re-invite is a fresh invitation-in-transit
exposure on a channel whose security must still hold. And an adversary who can
provoke handshake failures, or who is exploiting the desync ambiguity itself,
can farm an operator who re-invites on autopilot for fresh secrets over a
channel the adversary may already have compromised. The confirmation checklist
above is what breaks that loop -- it is why the confirmation must verify a real
partner-side failure rather than rubber-stamp the benign reading. This trade --
cheap recovery against repeated secret-in-transit exposure -- is accepted by
design.

## What the setup consent covers across runs

A managed exchange runs again on an agreement made once. The linkage terms and
the columns each side discloses are decided at setup and then **fixed for the
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
migrating the exchange to another device, dropping the next extract at the
agreed path, or changing which of its own columns its result file holds, how its
input file separates fields, or its retention note -- none of the three changes
what is sent.

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
retryable: unlike a transport drop, a later attempt on the same file determines
the same disclosure, so the remedy is the operator's -- run the exchange with
the file whose columns were agreed, or set the exchange up again to decide a
new disclosure with the partner. Presenting it as a connection blip with retry
copy would leave a scheduled exchange failing every window with no step named.

A re-invite reopens **the secret, not the agreement**. On the inviter's side
nothing is re-authored: the fresh invitation is composed from the stored
document alone, reusing its linkage terms and its committed set of disclosed
columns verbatim, and the setup secret is the only part newly minted --
alongside a rendezvous locator rebuilt from where the app is running and the
invitation's own fresh setup lifetime (see [Recovery: fast
re-invite](#recovery-fast-re-invite)). The accepting side is not a no-op,
though. Only the inviter can re-mint from a stored document, so the partner's
route is to accept a fresh invitation: it walks the accept flow again and
re-enters its own local fields -- its name, its metadata, its standardization
-- none of which are terms the two parties agreed. Its receive commitment lands
on the same set it originally agreed to because the re-invite reused that set,
not because anything checks the new invitation against the old; no such
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
party's own local, unsigned account of what it disclosed on that run, holding
no protected value (see [EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md)) -- and a
managed exchange files each of them in its own [accounting of
disclosures](#the-accounting-of-disclosures).

## The accounting of disclosures

Each managed exchange keeps its own accounting of what it has disclosed: one
entry per run that sent this party's payload, each entry that run's
self-attested exchange record.
It is the per-exchange source an operator draws a HIPAA accounting of
disclosures or a FERPA disclosure record from (see
[COMPLIANCE.md](COMPLIANCE.md#hipaa-considerations)), and it is on the
exchange's own page, below its run history.

- **It is the records, not a summary of them.** An entry shows what that run's
  record says -- the partner, the governing agreement and the purpose of the
  disclosure under it, the categories of data that moved each way, how many
  records this party exposed, the result size where both parties received the
  result, and the instant -- and says "not recorded" where the record holds
  nothing, rather than inferring a value from elsewhere. It is self-attested and
  unsigned, exactly as the record is: an accurate local account, not a signed or
  non-repudiable receipt.
- **A run files its own entry, present or not.** The entry is written as part of
  the run, before it reports its results. This is what an unattended run needs:
  the record file is otherwise offered only as a download when the run finishes,
  which requires somebody there to take it.
- **A run that stopped after sending is in it, and is marked.** Cancelling a run
  does not call back the payload already handed to the transport, and neither
  does a connection dropping, so the disclosure is accounted for either way. Such
  an entry is marked where the page lists entries and states that delivery to
  your partner is not confirmed and that the run wrote you no result file, so an
  accounting drawn from the list does not take it for a completed disclosure. Its
  columns each way are what the run had sent and what had arrived when it
  stopped, which the entry names as such; a result size beside them is the
  intersection the exchange had computed, not a result you were handed. A run
  whose exchange completed and whose record was filed before a local
  output-build step failed instead keeps an entry with outcome completed,
  unmarked, while the run history says the run did not complete and no result
  file was written.
- **A run that stopped before sending is not in it.** Nothing was disclosed, so
  there is no record to file; the run history above says what happened instead.
- **It is exportable.** One action writes the whole accounting as a CSV, one row
  per run, for handing to a compliance reader.
- **It stays in this browser, and is deleted with the exchange.** Nothing prunes
  it -- a silently dropped entry would falsify the account -- and it is not
  included in the export/import artifact, which migrates the runnable exchange
  rather than its history. Export the accounting before deleting or handing off
  the exchange; the record files offered at a run's completion stand in only for
  the runs somebody was there to download one from.

### When a run's record is missing from the accounting

A run can disclose and still fail to file its record -- this browser's storage
refuses the write, or the run could not build a record at all. The run raises a
message about it while it happens, which needs somebody there; a scheduled run
has nobody. So the run also leaves a note beside the accounting, and the
exchange's page shows it at your next visit, above the entries:

- **The accounting says what it is short.** Where it lists entries, it states how
  many further runs disclosed with no entry here, so a count of entries is never
  read as a count of disclosures. An accounting exported while that stands is
  short those runs.
- **Where the run's record was kept, you can add it.** The note holds that run's
  own record, so one action files it into the accounting and the note goes.
  Adding the same run twice cannot double an entry.
- **Where no record was kept, the page says so plainly.** Nothing can add the
  entry -- the record was never built -- so no control is offered for it. Record
  that disclosure in your own compliance material; the run history above names
  the run.
- **Where the run's record cannot be read by this version, the page says that
  instead.** The record is still stored; this version of the app will not read
  it, so it cannot be added to the accounting either. That run is recorded in
  your own compliance material too.
- **It is deleted with the exchange**, like the accounting itself, and it is not
  in the export/import artifact.

Filing can fail for the same reason the run's own filing did. The commonest is an
accounting this version of the app cannot read: clear it first (below), then add
the records again.

Occasionally this browser can store nothing at all -- it is out of space, or its
database will not open -- and then even the note cannot be written. The page says
at least one run of this exchange could not be recorded; that run cannot be added
to the accounting afterwards. Free space on the device so the next run can file
its record.

The marker names the exchange and nothing else, so finding which run it stands
for takes two places, neither of them certain. The run history keeps only the
most recent run, so a marker written for an earlier one is not named there. The
run also reported the failure to the browser's diagnostic log as it happened --
the developer-tools console, whose detail
[DEPLOYMENT.md](DEPLOYMENT.md#diagnosing-web-connection-failures) describes --
and that log holds it for as long as the browser keeps it. Where neither names
the run, the exchange's schedule and the accounting's own entries bound when it
happened; record the disclosure in your own compliance material either way.

That last-resort marker has a limit of its own: it holds at most 20 exchanges and
stays small on purpose, because a browser out of space is what it is written
under. Past that, or where the browser refuses even that much, nothing is kept
and no page can tell you the run happened -- so treat a browser that has run out
of space as the thing to fix, not a state to keep exchanging through. A marker is
shown once, on the exchange's page, and is cleared once that page has shown
it, whether or not anyone was there to read it. An exchange page left open
unattended can clear the marker that way, so check both places above if in
doubt.

### When an app upgrade leaves an accounting unreadable

An upgrade can change the format of the records an accounting is made of. When
that happens the accounting page says so instead of showing entries, because a
partly-read accounting would understate what was disclosed. Two things are true
in that state, and the second is the one to act on:

- The entries are still stored. They were valid when they were written; this
  version of the app will not read them.
- The exchange cannot add to them either. It keeps running and keeps disclosing,
  and none of those runs files a record here until the accounting is cleared.

The page offers the way out, in the order to take it. Neither step alone is
enough: the download is the only way to keep the records, and clearing is the
only way to let the exchange file again.

1. **Download the stored records.** You get the accounting in the form it was
   stored in, with nothing lost. It is a file for your own records -- keep it
   with your compliance material. It is not a run's record file, so neither the
   verify page nor this app will read it back.
2. **Start a fresh accounting.** This deletes the stored records permanently and
   lets the exchange file its disclosures again from its next run. It asks you to
   confirm, and it keeps the exchange itself -- the agreed terms, the stored
   secret, the schedule, and the run history are untouched. You do not have to
   delete the exchange to recover its accounting.

A cleared accounting displays as empty until the next run files into it. Where
the run history beside it records a completed run, the page names the two ways
an accounting is emptied -- clearing it here, or restoring the exchange from an
export or backup file, which does not hold one -- rather than reporting that no
run has completed.

Occasionally the stored records are damaged past the point where even that
download is possible. The page says so rather than offering a download it cannot
deliver; what remains is any record file you downloaded when a run finished, and
clearing the accounting still lets the exchange file again.

### When the accounting could not be read right now

A different message -- that the accounting could not be read **right now** --
means this browser's storage did not answer, not that anything is wrong with what
it holds. The usual cause is another tab running an older version of the app,
which holds the storage for a while and then lets go.

Nothing is offered to clear, because nothing is known to be damaged. Close any
other tab this app is open in and use the page's own "try reading it again"; a
page reload works too, but it would end a run in progress.

### When this page is the older version

The skew runs both ways. A new deployment does not replace the code of a page that
is already open, so a tab left open across one goes on running what it loaded
with. If a newer version has filed records for this exchange since, that page
cannot read them -- and says so as what it is: **this page is running an older
version of Alcove**.

Nothing is wrong with the records, and clearing them is not offered here: a
version of the app that reads them exists, and this page is not it. Reload the
page to use it, and reload before running -- a run started from a page in this
state discloses and files no record, the same way the stranded state above does.
If a run is under way, reloading ends it. The stored-records download stays
available in the meantime; it is for your own files, and this page cannot read it
back.

If a reload lands this page again, the newer version is no longer being served
-- a deployment rolled back past the record-format change -- and the reload
remedy cannot converge. Every further run from this build keeps disclosing and
filing nothing, so do not leave the exchange running in this state. Take the
stored-records download first; after that, deleting the exchange is the one
exit this build offers, and the downloaded records stay intact for a build that
reads them.

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
collapses persistence status into **one derived backup state**, shown at the
moments it changes rather than as standing chrome:

- **Backed up.** A current export exists (taken since the last rotation): the
  exchange shows a quiet, green "backed up as of <date>" and nothing else. The
  browser's storage grant (`navigator.storage.persisted()`) is never its own
  displayed line -- the operator cannot act on it except by exporting, which
  the backup state already covers -- and on WebKit a granted `persisted()` must
  never suppress the actionable state below (the grant does not reliably exempt
  the ITP cap). The export that counts is the artifact one, which this browser
  imports back: the command-line hand-off's two files are not it, and taking them
  leaves this state exactly where it stands (see [Exporting to the command
  line](#exporting-to-the-command-line)).
- **Backup needed.** No current export exists: none was ever taken, or the
  secret has rotated since the last one (an export from before the last
  rotation restores a stale secret and lands in the desync recovery above).
  The exchange shows one actionable state: "Back up this exchange".

The refresh is offered where it is natural: on an attended run, the
run-completion surface's "download updated backup" (see [The second
run](#the-second-run-end-to-end)) is the moment the previous backup went stale,
so taking it there keeps that path green and quiet. An unattended scheduled run
rotates the secret with nobody present, so a scheduled exchange's standing
export goes stale between visits **by design**; the backup state states that
accurately -- actionable at the next visit, a state, not a nag -- and an OS-level
notification from the installed app prompts a re-export sooner (see [The
between-visit notification](#the-between-visit-notification)). The frame
throughout: every accurate statement appears at the moment it becomes true and
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
runs. The one control takes either file the operator may hold and routes it by
what the file is: the backup artifact restores the exchange, and a command-line
`alcove.yaml` lands as a configuration-only exchange instead, or as one that
runs here when its `.alcove.key` is chosen with it ([Bringing a
command-line configuration
back](#bringing-a-command-line-configuration-back)). One limit: a wholesale
eviction erases the evidence that
anything existed, so the app cannot always distinguish a first visit from a
post-eviction one -- which is exactly why the managed-exchange list's empty
state has the import affordance standing, rather than exposing it only
behind a detected loss. The same control stands beside a populated list and an
unreadable one.

**A backup is checked against the exchange it holds, not against the rest of
the list.** A backup file holds one exchange, so importing it never depends on
what else is listed, and no refusal asks you to clear the list first. What
happens depends on that one exchange (the rules:
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#reconciling-a-backup-import)):

- **Moved from here to another device**: the listed entry is restored in place.
  Its row also offers "Restore from backup", which takes only the backup
  downloaded when it moved and refuses any other file. It restores without the
  question below, and names any other listed entry with the same terms and
  side.
- **Not in this browser**: it is added as a new entry.
- **Already running here with the backup's secret**: nothing is imported, and
  the refusal names the entry to open instead.
- **Handed off to the command line from here**: nothing is imported, and the
  refusal names the take-back on that exchange's page.

An exchange that has run since the backup was taken has a newer secret than the
file, so the secret no longer finds it. When listed exchanges have the same
agreed terms and the same side as the backup, the import stops and names them
all at once: open an entry if it is the same exchange -- a second copy falls
behind the first time either one runs -- or add the backup beside them if it is
a separate exchange with the same terms. Nothing is imported until you choose.

**A refused file says why it was refused.** The artifact's schema
rejects an unknown key and an unknown version outright (see
[MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md), "Export
artifact"), so a backup exported by a newer build than the page is running is
refused as surely as a wrong or altered file is -- and the operator cannot tell
which from the file in front of them. The import therefore separates the two: a
file whose bytes do not parse leaves only the file itself to check, while a
document the schema rejects names the version difference first and states both
ways past it, reloading the page for the current version or exporting the backup
again from the device that wrote the file. A backup written in the app's
previous artifact format is the one case with neither way out: it is refused as
an older file, and the way on is a new exchange set up with the partner.

**The import says which grants this browser does not hold.** An artifact holds the
exchange, not the two pointers into this device that the record also keeps: the
input file each run reads, and the folder a scheduled run writes its results to
(see [The input file each run](#the-input-file-each-run) and [Where a scheduled
run's results go](#where-a-scheduled-runs-results-go)). A restored exchange
therefore has neither until the operator chooses them again here. Left unsaid,
what would report it is a scheduled run -- which stops without an input file, and
keeps its results in the browser without a folder -- a whole window after the
import that lost them. The import states it instead, while the operator is still
standing there, naming only the grants the source record actually had and
offering the way to the exchange where both are chosen. A record revived in
place on the profile that handed it off keeps the grants it already had, so what
the import names is whatever that record does not hold: nothing when it still
holds both, and the one grant it lost when it lost one.

## Deleting a managed exchange

Removing a managed exchange is a fully supported, always-available action, and
it removes **everything the browser holds for it in one step**: the record, the
secret, the persisted input-file handle, the schedule, the run bookkeeping, its
[accounting of disclosures](#the-accounting-of-disclosures), and any [results a
scheduled run kept](#where-a-scheduled-runs-results-go) -- which is why the
confirm says to download those results and export the accounting first if they
must be kept.
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
- [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#the-accounting-of-disclosures) - the accounting of disclosures' stored shape, its append rule, its retention, and the note a run leaves where its record was not filed
- [COMPLIANCE.md](COMPLIANCE.md#hipaa-considerations) - how those per-run records serve an accounting of disclosures
- [DEPLOYMENT.md](DEPLOYMENT.md) - the hosted web app deployment posture and the reverse-proxy responsibilities
