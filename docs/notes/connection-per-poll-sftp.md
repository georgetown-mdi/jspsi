---
title: "Connection-per-poll SFTP, and the reconnect posture beneath it"
---

# Connection-per-poll SFTP, and the reconnect posture beneath it

*Status: shipped. This note records the direction chosen for a slow-peer SFTP
transport mode and, underneath it, the mid-exchange reconnect posture the mode
depends on. The direction was reached by an independent four-lens expert panel
and its load-bearing claims were adversarially verified against the tree; see
[How this was decided](#how-this-was-decided). The normative mechanism is
specified in [FILE_SYNC.md](../spec/FILE_SYNC.md) and
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md), and the operator-facing
description lives in [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md); this note
is kept for the reasoning behind that direction. See
[docs/notes/README.md](README.md).*

## The scenario

One operator runs an asymmetric exchange. Their side connects over SFTP; the
partner reconciles files only about once an hour through a file-drop sync service,
so a single exchange spans hours. The partner's SFTP server enforces a hard
maximum-session-duration cap the operator cannot change -- a real drop was observed
about ten minutes in. A keepalive cannot beat a maximum-duration cap: it resets an
*idle* timer, but a session-lifetime cap drops on wall-clock regardless of traffic.
So a transport that holds one SSH session for the whole exchange loses that session
mid-run, over and over, once per inter-poll gap that outlasts the cap.

Today the SFTP transport does hold one session for the whole exchange: it dials
once during `open()`, the poll loop reschedules indefinitely on a plain timer while
the session sits idle, and it disconnects once at `close()`. The heartbeat
(`realPath(".")` on a fixed interval) keeps an idle session warm but is powerless
against the duration cap.

## What transparent reconnect already gives, and what it does not

Transparent mid-exchange reconnect (shipped as "Recover a dropped SFTP session
mid-exchange") wraps the server-driven SFTP ops so that, on a *clean* session
loss, the adapter re-dials -- reusing the pinned host-key fingerprint and stored
credentials with no re-prompt -- and re-issues the op before the loss is treated as
failed. Per-op idempotency resolvers make the re-issue safe (a landed delete maps
to success, a rename confirms its self-owned destination, a `createExclusive`
resolves its own `EEXIST`). Only a clean loss re-dials; a fatal protocol error, a
memory bound, and a host-key mismatch stay terminal, as does a liveness stall
except against a session the transport has already ended under (see
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md)).

For the scenario above this means the exchange **survives** each drop rather than
aborting on it: the session dies in each idle gap, and the next poll's first op
silently re-dials. That is a genuine robustness floor. But held-session recovery
must not be *infinite*: it is bounded by a cumulative budget, and it stays honest
about the difference between a transiently flaky link and a server that
structurally caps session lifetime.

**It is bounded by a cumulative budget, not infinite.** The default held-session
mode grants at most `max_reconnect_attempts` mid-exchange re-dials over the whole
exchange; once that budget is spent the next drop fails the exchange terminally
with an actionable message. The budget is **strictly cumulative** -- it does not
reset on a successful op -- because a server that caps session lifetime makes
progress every cycle, so a reset-on-progress budget would never bound it and would
silently slip back into infinite reconnect. A merely flaky link is served by
raising the budget; a server that genuinely caps session lifetime is served by
connection-per-poll (below), which does not hold a session across the idle gap and
so is not subject to the count.

**Genuine failures already terminate on their own bounds, too.** A re-dial against
a genuinely gone or credential-rotated endpoint exhausts the per-connect dialing
budget -- whose operative default is **three** retries (a fast-fail in seconds),
not the seven-day sanity ceiling that bounds only the config field -- and the op
then rejects, poll's catch emits an error, and the connection bridge makes that
terminal. A vanished or silent peer trips the receive-inactivity deadline, which is
set to `peer_timeout_ms` (default one hour). A stalled send is bounded by the same
peer-inactivity budget, armed afresh for each send's wait on the peer (see
[FILE_SYNC.md](../spec/FILE_SYNC.md)). These bounds terminate a dead channel
independently of the mid-exchange reconnection budget; the budget is what
additionally bounds the *succeeding-but-thrashing* case -- a server that re-dials
cleanly every cycle yet keeps capping the session -- which none of them catches.

**What cannot be told apart, and why that is the real gap.** The re-dialing itself
is visible: the transport warns at default verbosity on the first mid-exchange
re-dial, on the last one the budget permits, and at a rate-escalated cadence in
between, each line stating what remains of the budget, and the end-of-run reconnect
totals land on the operator's normal log rather than only on the opt-in machine
event stream. What the *code* still cannot draw, even with that signal in hand, is
the line between a **chronic-benign** drop (a server session cap: the re-dial
succeeds every cycle and the exchange progresses) and a **chronic-degraded** channel (the
re-dial succeeds but the exchange barely moves). The two are identical from the
code's vantage -- same clean loss, same successful re-dial -- so the warning can
report the thrash but not classify it, and only the operator, who knows the
partner's server, can say which one they are watching. Closing that gap therefore
needs either the operator's own judgment on the warning or an operator-supplied
**declaration** that drops are expected here. That declaration is precisely what the
opt-in mode below provides; the cumulative budget is what keeps an unjudged exchange
from thrashing indefinitely in the meantime.

Beyond observability, the `max_reconnect_attempts` field (default three) is what
bounds this recovery. Its value sizes a cumulative mid-exchange-reconnection budget
-- a counter separate from, but the same size as, the dialing-retry loop inside a
single `connect()` -- so the one knob whose name implies a reconnect ceiling
genuinely bounds the reconnecting an operator would want to bound, on top of each
connect's own dialing retries.

## The reconnect posture

Keep mid-exchange recovery on and survival-preserving, but bound it and make it
observable. Three properties define the default:

- **Bound it by a cumulative budget that fails terminally.** In the default
  held-session mode `max_reconnect_attempts` caps the cumulative number of
  mid-exchange reconnections; once it is spent the next drop ends the exchange with
  an actionable terminal error that names the partner-server drop, states the
  exhausted budget, and gives the two remedies. The budget is strictly cumulative
  and does not reset on progress -- a session-capping server makes progress every
  cycle, so a reset-on-progress budget would never bound it. This is the "not
  infinite by default" lever, expressed as the one knob whose name already promises
  it rather than a new field.
- **Make it observable.** Emit an operator-facing warning on the first mid-exchange
  re-dial that names the likely cause and the remedy, and escalate by rate so a
  chronic capper is loud without spamming a one-off. Surface the live reconnect
  count on the normal log, not only on the event stream. This makes the exchange's
  degradation visible to the operator before the budget is spent, rather than
  leaving it un-judgeable.
- **Give the capping-server case its own escape.** A server that structurally caps
  session lifetime would exhaust any held-session budget, so raising
  `max_reconnect_attempts` is the answer only for a transiently flaky link. The
  structural fix is connection-per-poll (below): its poll loop holds no session
  across the idle gap, so the loop ordinarily does not reach the cap, and its
  recovery re-dials are uncapped in every phase -- bounded instead by the
  peer-inactivity ceiling -- which is what carries a rendezvous the cap does cut.

The recoverable-versus-terminal taxonomy stays exactly as it is: it keys on the
session's post-drop state, not on message matching, and it is sound. This posture
change is independent of the mode below, applies to every SFTP exchange, and
directly answers the concern about a silent unbounded default; it should land
first.

## Connection-per-poll

For the slow-asymmetric-peer case, the structural fix is to stop holding a session
across the idle gap at all. In the mode, each poll cycle dials a fresh SFTP
connection, runs that cycle's batch of ops, and releases the connection before the
loop goes idle again. A cycle's session then need only survive that cycle's seconds,
so the poll loop ordinarily does not reach the server's duration or idle cap; there
is no held-but-secretly-dead window and no heartbeat to churn keepalives against a
corpse. The failure it does have -- a dial that fails -- fails loudly at one
well-understood seam and is handled by the ordinary connect-error path, rather than
silently on the next op against a cleared session.

The per-cycle lifetime is the **poll loop's** property, not the mode's as a whole.
The rendezvous that runs before the loop -- this party waiting for the partner to
join the exchange -- holds a single un-heartbeated session across its wait, so a
server cap cuts it there on a wait long enough to outlive the cap. What carries the
exchange through is the mode's uncapped recovery re-dial: the cumulative
`max_reconnect_attempts` budget is exempted in this mode, so a rendezvous that
outlives the cap re-dials as often as the cap cuts it and the exchange completes,
where the held-session default in the same scenario exhausts that budget and fails
terminally. Arming the heartbeat for the rendezvous would not close the gap -- a
keepalive defeats only an idle timer and is powerless against the
maximum-session-lifetime cap this mode exists for.

The mode is a **hybrid**, not a replacement. The held-session default (with the
bounded, observable recovery above) stays right for fast and symmetric exchanges: a
full SSH handshake per cycle is negligible at a minutes-scale poll interval and
wasteful at the five-second default, so per-cycle dialing is only sane paired with a
long interval. Transparent recovery is retained underneath the mode as its safety
net -- a drop *inside* a batch, and one that cuts the rendezvous, are both still
re-dialed -- but it is demoted from the primary mechanism to a floor, because
per-poll has already removed the between-cycles drop it was carrying.

## The seam: an adapter-owned ephemeral session

The connect/disconnect bracket lives **inside the SFTP adapter**, as an ephemeral-
session mode driven by a cycle-boundary signal from the core loop -- not as a
connect/disconnect bracket threaded through the core poll orchestration.

Both placements need a boundary signal from core, because only the loop knows where
a cycle ends; the adapter cannot infer it. Given the signal is required either way,
the only real question is whether core *drives* connect and disconnect per cycle or
merely *notifies* a boundary and lets the adapter own the mechanism. Notifying is
the smaller change and the safer one:

- **Blast radius.** The adapter already owns connect and disconnect, host-key
  re-pinning, the heartbeat, retained connect options, credentials, and -- the key
  reuse -- a proven, already-security-reviewed re-dial-from-a-cleared-session path.
  An idle-release at a cycle boundary reuses that machinery; the delta is small.
  Driving the bracket from core would instead land connect/disconnect logic in the
  poll loop, the rendezvous coordinator, the send path, and the delicate `close()`
  teardown -- the most security-sensitive, most-recently-decomposed surface -- and
  would force core to re-supply and re-verify SFTP connect options it deliberately
  discards after `open()`.
- **Invariant ownership stays put.** The adapter's serialization of `end()`
  against an in-flight re-dial covers the session transitions themselves, not the
  operations riding on them, and needs nothing from how those operations are
  issued -- they are issued concurrently (see
  [CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md)). What makes it sound is the
  FIFO lock every session transition takes: each takes its queue slot
  synchronously at the call, so a transition runs behind whichever one holds the
  client rather than under it, whatever operations are in flight meanwhile. An
  idle release is one more transition on that lock, and keeping the lifecycle
  with the adapter keeps the lock with the transitions it orders. The correctness
  concern that the invariants live in core is met regardless: the teardown *ordering*
  guarantee stays in `close()` (below); what moves into the adapter is only the
  mechanism.
- **Testability.** The mode is unit-testable at the adapter boundary against the
  same surface the recovery path already grew, with no live server; the boundary
  signal is a single seam.

The boundary signal is modeled on the existing optional-capability pattern (the
inbound-frame-cap method core calls only when the transport implements it): core
invokes an optional release/ensure-connected method at the idle boundary, and a
transport that does not implement it is unaffected. The release must be
**non-terminal** -- it must not run the adapter's `end()` (which latches a sticky
`closing` flag that disables recovery for the rest of the adapter's life) and must
not clear the connection's in-memory session state (peer id, role, responsible-file
tracking). Preferring an explicit ensure-connected at the *start* of a cycle over a
lazy re-dial on the next op's rejection avoids spending one guaranteed-failed op per
boundary.

### Scope: SFTP-only

The capability is SFTP-only, not a general "ephemeral connection" abstraction on the
transport contract. Only the SFTP adapter holds a socket; the file-drop client is
already connectionless (its connect is a stateless access check and its disconnect a
no-op), so a general abstraction would buy nothing there and has no second consumer
to justify it. This also respects the monorepo layering: the socket-holding outlier
lives in the CLI app, so the mechanism should too, expressed as an optional method
the connectionless transports simply do not implement. If a second session-holding
transport ever appears, generalize then.

## Config surface

The mode is a **local, non-bilateral, explicit opt-in**. Three properties, each
load-bearing:

- **Local, not bilateral.** How one party dials changes nothing on the wire or in
  the shared directory state machine; the peer cannot observe or care. So the mode
  must *not* ride the bilateral mode-flag path that advertises a flag in the hello
  and fast-fails on mismatch. It is local tuning, in the family of the
  unilateral-directory-policy and outbound-path locators, not the retain/lockless
  bilateral axes. One party may cycle its session while the other holds one.
- **Explicit, not auto-derived.** Do not silently switch lifecycles off a poll
  interval crossing a threshold: an operator setting an interval for cadence would
  get a different session model by surprise, and the heuristic cannot know the
  server's cap so it cannot reliably infer when the mode is needed. Make it a flag;
  then *warn* (do not block, per the trusted-operator posture) when it is paired
  with a short poll interval, since per-cycle dialing at seconds-scale is wasteful.
- **SFTP-scoped, warn-not-block on the wrong channel**, folded into the existing
  helper that warns when an SFTP-only file-sync flag is set on another channel.

## Invariants under a cycling connection

Under per-cycle connects the in-memory protocol state (role, peer id, sequence
shadows, responsible-file and foreign-file bookkeeping) survives, because only the
socket cycles -- the process stays alive. On-disk state is authoritative by design
("the directory is the state machine"). Against that backdrop the three
lifetime-sensitive subsystems divide cleanly.

**One transition at a time, in request order.** The mode multiplies the points at
which the adapter dials a session or closes one: the first dial, the cycle-start
reconnect, the mid-exchange recovery re-dial, the idle-boundary release, and
teardown. ssh2-sftp-client keeps one connection-level listener set on one client,
so two of those running at once is unsafe in every combination -- two handshakes
kill each other, a handshake alongside a close hands the close's event to the
handshake's listeners, and a close alongside a handshake short-circuits on the
session that handshake has not restored yet and returns having ended nothing.

The adapter therefore owns a single FIFO lock over those transitions, and holds
it across the whole of each: a release holds it through its forced close, a dial
through its entire retry budget. Four properties follow, and they are what the
adapter's tests assert rather than what its prose claims:

- **Request order decides, not promise-reaction order.** A transition takes its
  queue slot synchronously when its method is called, so inserting an `await`
  anywhere on a transition path cannot change which transition wins.
- **No transition begins after teardown is latched.** `close()` latches before it
  enqueues, and the latch is read at one place -- inside the lock, once per
  transition -- so anything queued behind teardown is skipped, and anything
  already running is waited out by teardown's own position in the queue.
  Teardown has no privileged entry and pre-empts nothing.
- **The acquire is bounded by one fixed adapter-owned ceiling.** One number for
  all five kinds, and it bounds the WAIT rather than the transition being waited
  on -- so it owes nothing to the sibling's settings, nor to any premise about
  when ssh2 arms a connect deadline. A ceiling on the dial instead would put a
  teardown's wait at the dial's whole budget, around two minutes at the defaults
  and without a practical limit as the operator raises the connect timeout:
  neither teardown-scale nor a bound the wait owns. The transition being waited
  on stays unbounded here, because its ceiling is its caller's: core wraps a
  data-plane operation in the peer-inactivity budget and `close()` in its own
  shorter teardown budget, and forwards the two cycle-boundary signals unwrapped.
- **A waiter whose bound expires never proceeds into its own session action.** Not
  the dial, not the ssh2 client's `end()`, not the socket destroy: the transition
  it gave up on still holds the client, so proceeding would trade a bounded park
  for the overlap the lock exists to prevent. It abandons its OWN transition
  instead, through the transient-failure path it already owns -- the cycle-start
  dial reports a cycle to skip, the idle release that it released nothing, the
  recovery re-dial that no session is live for the re-issue, and the first dial,
  which has no value that could mean "no session was established", rejects. The
  waiter also leaves the queue chain intact: it gives up its turn without
  resolving its own slot, so its successor is admitted when the transition
  actually holding the client settles and not when the waiter walks away.
  Teardown is the single exception, and only in the narrow form: it may give up
  ssh2-sftp-client's `end()` -- which a live handshake beneath it resolves having
  closed nothing -- and close the transport from this side, which needs nothing
  from the peer and settles the very dial being waited on. That destroy is the one
  mechanism the adapter drives from outside the transition holding the client, and
  what makes it safe is the teardown latch rather than the destroy's own
  harmlessness: every transition behind the teardown skips its body, so the holder
  ahead of it is the only one that can be running.

Uniformity has three consequences worth stating rather than leaving to be
discovered.

**A cycle-boundary signal issued after teardown is latched waits the teardown out
before returning its "nothing to do" value.** It does not short-circuit on the
latch, because a second reading of that latch outside the lock is exactly the
distributed re-read the single in-lock read exists to avoid. Against a partner that
withholds its close, that wait is the teardown's own close bounds
(`CLIENT_CLOSE_TIMEOUT_MS` then `FORCED_CLOSE_TIMEOUT_MS`), which land inside the
acquire ceiling, so the signal waits the teardown out rather than giving up on it.
Past the ceiling the signal abandons instead, which is what keeps a transition
running AHEAD of the teardown -- a dial spending its whole connect budget -- from
reaching the signal at all. Neither signal is awaited by the teardown, so no cycle
can form: core stops the poll loop before it closes the transport, and its
`close()` never joins the loop. The integration suite drives the close half against
the partner that spends those bounds in full -- one that accepts the disconnect and
never closes the connection -- and pins the wait as bounded: about five seconds,
once, at the end of a run.

**Whether a same-tick release and `close()` run the release or skip it turns on
whether the queue was idle.** A release requested on an idle queue starts
immediately and is waited out by the teardown behind it; one requested while a
dial is in flight is still queued when `close()` latches, so it is skipped
entirely. This is the ordering rule above rather than a special case -- the latch
is read where a transition reaches the front -- and both outcomes are safe, since
teardown closes the session either way.

**The lock is not mode-gated, and two orderings in the default held-session
mode turn on it.** The two cycle-boundary signals return before enqueuing when
the mode is off, so the default mode reaches no transition of theirs -- but its
`connect()` and its `close()` take the lock exactly as they do here. A teardown
concurrent with the FIRST dial never runs ssh2-sftp-client's `end()` under that
handshake, which is the overlap the lock exists to stop and the reason it covers
both modes; it waits the handshake out only as far as the acquire ceiling, past
which it destroys the transport and cuts the handshake short. A `connect()`
issued while a teardown is IN FLIGHT parks for that teardown's own bounds before
refusing the re-open, rather than refusing at once: the refusal is identical
either way, and shortening it with a pre-acquire reading of the latch would buy
back the second, out-of-lock reading this design replaced, in exchange for a
faster failure on a path nothing in the tree takes -- core's `open()` and
`close()` are not concurrent. A `connect()` after a teardown has SETTLED does
not park at all: the queue is drained, so it enters its critical section in the
same tick and the refusal is immediate.

**The boundary itself: the release owns the end state, not the partner.** Closing
a connection is nominally a two-party act -- this side disconnects, the server
closes the connection -- and a server that accepts the disconnect and then goes
quiet never completes it. The transport is ended on this side while the session
stands in name only: it can carry nothing, yet a cycle that reads it as live would
skip its dial and ride its first operation to the per-operation liveness deadline,
which ends the exchange. That is exactly the slow, idiosyncratic partner the mode
exists for, so the mode does not depend on the partner's cooperation to finish a
release. Past its bound the release closes the transport from this side, so every
idle boundary ends with the session gone and every cycle begins by dialing a fresh
one. Inside the poll loop that silence costs one release bound per cycle, an
operator warning on the same rate-escalated cadence a chronic mid-exchange re-dial
gets, and a total in the end-of-run summary -- rather than the exchange. Forcing
says how the boundary concluded, not who ended the transport beneath it, so it
does not by itself make the loss this side's: a boundary forced over a partner
drop this side had already observed is still counted and warned as that drop,
while one forced over an ordinary deliberate release is exempt as any release is
([CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#sftp-mid-exchange-session-recovery)
carries the per-outcome rule).

The same partner silence at TEARDOWN is a defect of the SFTP transport itself,
which this mode neither causes nor escapes, so it is bounded where it lives
rather than here. `close()` ends the connection for good through
ssh2-sftp-client's own `end()`, which settles only from a close this partner does
not send; that wait carries its own short bound, and past it the adapter closes
the connection from this side, so a completed exchange finishes teardown and the
process exits. The bound is mode-independent -- it holds in the default
held-session mode exactly as it does here -- and the mode's contribution is only
that its own per-cycle releases never END in that state.

**Rendezvous handshake -- test-hardening, given two placement rules.** The hello,
the zero-length ack, the lock-path joining sentinel, and the lock are committed
files that outlive any session, and no reconnect clears the in-memory role and peer
id (nor does `close()`). So a release across a steady-state idle gap loses nothing. Two rules
make this hold and are the substance of the verification work: the one-time entry
guard and directory sweep must run exactly once, never re-entered on a later cycle
(a second entry would see this party's own hello and reject the directory as
unclean, or a re-run sweep would delete the party's own just-written files); and no
reconnect may reset the in-memory session state.

Where the boundary and a publish meet, the poll loop's own publishes are safe and
a concurrent send's are not. Each publish is a
contiguous run of ops with no idle wait in the middle -- a message is a temp write
then an atomic rename; an ack is a zero-length put then a rename; the joiner
sentinel is a put, a delete, then a rename; the hello is written directly to its
final name and relies on the reader's partial-sync gate rather than a rename; a
lock is a single atomic exclusive create at the transport seam. None of them
straddles an idle wait, so a publish the POLL LOOP itself performs cannot be torn
by the boundary that follows it. The boundary is not a global idle point, though:
`send()` has no mutual exclusion with `poll()`, so a release can fall while a
send's publish is in flight. An op that reaches the transport at or after the
release is serialized against it at the adapter's recovery chokepoint, which
re-establishes the session before the op's first attempt -- queued behind the
release on the transition lock, so it runs on the far side of the close rather
than racing it. An op already on the wire is covered by the release's own
precondition rather than by any gate at op entry: a boundary reached with a counted
operation outstanding closes nothing, so the op completes on the session it was
issued against and the first boundary past its settlement releases as usual. Each
boundary a held op straddles costs the mode one idle gap, draws no warning -- a
concurrent send straddling a boundary is ordinary -- and adds no wait anywhere:
the release returns rather than draining the operation. The run's totals are kept
and stated once at the end, as the forced and declined releases' are. What the
count covers, how that set differs from what is on the wire, what bounds the hold,
the ops for which nothing does, and what the totals measure, are in
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md).

One op is outside both of those, and it is the cleanup delete a torn send sweeps
its own temp with. Its never-reject contract keeps it outside the recovery
chokepoint, so it reaches no gate at op entry; and issued after the boundary
rather than before it, it is not an outstanding op the release could have held
the boundary for. Against a released session it therefore removes nothing --
while resolving, so the caller in core cannot tell. Nothing else in the run
sweeps that temp: it is in no responsible-file set, and the entry guard that
recognizes the shape ran before the loop started. The adapter is the only layer
that can tell a no-op cleanup from a performed one, so it is the layer that
records one and re-issues it at its next re-establishment, which is also why this
does not become a precondition spread over core's call sites. Only that temp
shape is recorded: `safeDelete` is also handed durable protocol files and names
the peer wrote, and a re-issue deferred to a later point could reach a different
file at such a name. The mechanism, the shape narrowing, and the bounds on both
the record and the drain are in
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md).

The re-issue that drain makes is then the one op still owing a settlement that the
release may TEAR, and that inverts the rule above for it alone. (A listing's
best-effort handle close is unbracketed too and a boundary tears that as readily,
but it is fired after the listing has settled, so nothing is owed for it: its loss
is the leaked handle a withheld close callback already costs, and in this mode the
session ends at that boundary anyway.) The reason is what a counted best-effort
sweep would cost this mode: against a server that accepts DELETE and never
answers it, a counted re-issue is outstanding at every boundary, every boundary
therefore closes nothing, and every live session left behind is another
re-establishment that drains and re-issues again -- the per-cycle session the mode
exists for, gone for the rest of the run, and reachable without a failed publish
at all, since the entry sweep hands the cleanup delete every temp-shaped name a
server-supplied listing offers. Uncounted, the release simply closes over the
re-issue; the torn delete rejects, which offers the path back to the record, and the
next re-establishment tries again. That is the same deferral the record already
is, so the tear costs the cleanup nothing but a cycle. It is safe to tear where an
ordinary op is not because a DELETE of this party's own temp has no half-state:
the server unlinked the file or it did not, and the re-issue treats an absent file
as the success it is. The same reading is why the retry is BUDGETED rather than
standing: a delete the partner will never let succeed is indistinguishable from
one it will, so the only way not to retry the first forever is to stop retrying
either after a few cycles, which costs the second nothing a healthy run notices.

That budget belongs to a RECORDING and not to the path, which is what its
give-up is scoped to: nothing about a path is remembered once its recording ends,
so a path offered again is recorded again with the whole budget. What that costs
depends on who offers it, and the sweep that turns up an undeletable temp runs at
rendezvous entry, once per exchange rather than once per cycle -- so such a temp
is recorded once and costs a few round trips for the whole run. Paying that per
cycle instead is what a caller re-offering the same path every cycle would cost,
which is worth re-checking before one is written. It is bounded amplification
either way, the record's own cap being what
bounds how many such recordings stand at once, and the alternative is worse: a
tombstone remembering the given-up path would occupy a cap slot, which is exactly
how a peer could crowd the send path's own cleanups out of the record. What the
budget is not is the thing that keeps the per-cycle session -- that is the
re-issue being uncounted, which holds whether or not the retry is budgeted.

**Close, drain, and the authenticated abort marker -- real code, the one genuine
gap.** At teardown the last cycle's connection is already released, but `close()`
still needs a live session to drain the final terminal frame and to write the
authenticated abort marker. The marker write is already recovery-covered: `close()`
awaits it before the adapter's terminal `end()`, so it is issued while the session
is still recovery-eligible. The drain is not safe by default: it races a directory
listing against a bounded window (the terminal-frame-drain timeout, or the smaller
remaining peer budget), and that window encloses the transport op that would trigger
a re-dial -- so a re-dial charged against it can time the drain out and drop the
terminal frame to the cleanup fallback. The mode must therefore ensure a connection
is established *before* the drain deadline starts, so the handshake cost is not
billed to the drain budget; and the boundary release must be non-terminal so the
sticky `closing` latch does not disable the recovery the marker write leans on.
Getting this wrong silently regresses the fast-fail abort guarantee -- the waiting
peer would ride the full peer timeout instead of failing fast on the marker. This
is code, and it belongs in the implementation, not in verification.

**Retain-mode whole-directory bookkeeping -- test-hardening.** Responsible-file
tracking, the foreign-file snapshot, and the receive-sequence shadows are all
in-memory on the connection object and independent of the socket; retain never
deletes, so the on-disk sequence stays authoritative and the shadow stays aligned
across a reconnect. No foreign-file false positive arises, because a reconnect
re-lists the same on-disk contents the held model already re-lists every poll. The
verification is a test that a mid-loop reconnect neither re-enters the entry
snapshot nor resets the sequence shadow.

## Whether a dial can still be deferred

ssh2 defers a `Client.connect()` issued on a socket that is still WRITABLE: the
attempt is registered behind `once('close', ...)`, and no `readyTimeout` is armed
for it, so nothing on psilink's side bounds it. No dial path this mode drives
reaches that state, and that is a check rather than a claim:
`apps/cli/test/integration/dialDeferral.test.ts` drives each path and censuses
the socket beneath every dial the adapter issues, failing on a writable one, on
a dial that does not settle, and on the live-session gate ceasing to fire.

What follows is the measurement that check came from -- DRIVING each path
against the real stack (the in-process ssh2 1.17.0 server, ssh2-sftp-client
12.1.1, and the production `SSH2SFTPClientAdapter`, with the partner's close
withheld), not reading the library:

- **Cycle-start re-dial** (`ensureConnected`): every dial is issued on a socket
  already `destroyed: true, closed: true`, settling in 219-232 ms. A full driven
  exchange across three forced idle boundaries made four dials, all on destroyed
  sockets, none on a writable one.
- **Teardown pre-drain reconnect** (`close()` reaching `ensureConnected`): one
  dial, on a destroyed socket, 221 ms.
- **Recovery re-dial** (`withSessionRecovery` reaching `redialForRecovery`): fires
  against a withheld-close partner, on a destroyed socket. The gate admits a SET
  session whose transport has ENDED -- exactly what that partner leaves behind --
  and the re-dial retires that torn transport before dialing its replacement.
  Against a normally-closing partner it also fires, on a destroyed socket, in
  219 ms -- the control that proved the driving works, and the arm the library
  reaches by clearing the session itself. ssh2-sftp-client's session property
  does not clear on a withheld close; the gate admits the ENDED transport rather
  than the cleared session, which is what makes this path reachable at all.

Two barriers hold it there, and the forced close is load-bearing in both -- the
first barrier's recovery arm reaches its dial only after one, and the second is
about the state they leave:

1. **No dial gate puts a dial on a live transport.** `ensureConnected` returns
   early on a set session (measured returning true in 0 ms with the transport
   live), and `shouldRecoverFromSessionLoss` refuses a set session unless its
   transport has ended. The session is not set exactly while the transport is
   live: the withheld-close partner this note describes throughout leaves it set
   over an ENDED one. That is the one set-session loss the gates admit to a dial,
   and what carries the conclusion there is the re-dial's own ordering --
   `redialForRecovery` retires the torn transport before it dials, so that dial
   too is issued over a destroyed socket rather than a writable one.
   ssh2-sftp-client's own "An existing SFTP connection is already defined" guard
   rejects any dial that reaches it with the session still set, a redundant
   backstop behind both.
2. **Neither state a withheld close can leave defers.** A withheld close leaves
   an ENDED transport, which the forced closes destroy -- and a dial on
   `writableEnded: true, destroyed: false` completes in ~220 ms, as does one on a
   destroyed socket. "Ended but still writable" is not a deferring state.

The library mechanism itself still exists, which is the part to carry forward
rather than discard: a second `connect()` on a live socket does not settle, and
its precondition is narrower than "an open connection". The measured figures and
the exact precondition are a normative pin row in
[DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md#upgrading-the-sftp-stack-ssh2--ssh2-sftp-client),
which defers to this note for the two barriers above and the caveats below.

What the verdict, and the check that carries it, do not cover:

- **Scope.** Three named paths plus one real-exchange census were driven, and the
  check drives the same three. "No path can" is not proven in general, so a new
  dial path needs a case of its own.
- **The session-lifetime premise.** The dial gates rest on ssh2-sftp-client never
  clearing its session property while the transport is live. The evidence is
  positive (the property stayed set on a half-open transport for 20 s) but is not
  a proof. The check reaches it only indirectly: a version that cleared the
  property over a live transport would put a dial on a writable socket, which the
  census fails on.
- **A true half-close server.** A server that sends its FIN and then never
  completes the close is not reproducible with this harness: the withheld-close
  control silences both `end` and `destroy` on the server socket, so it cannot
  produce a server FIN without a close. That is the one shape in which the
  session might clear while the socket is briefly still writable. Not observed,
  not ruled out.
- **The pre-forced-close baseline.** The original measurement (a connect started
  at 7021 ms and still unsettled 39 s later) predates the forced close and was
  not reproduced; that revision was not rebuilt.
- **The native-sshd backend.** The withheld-close control is in-process only.

## What a forced close does across a mid-handshake dial

The teardown that gives up its wait closes the transport with a handshake live
beneath it, which is exactly the shape reviewers have read out of the library's
source and got wrong. So it was DRIVEN, against the same real stack: a server that
accepts the TCP connection and then stops writing, so the client's dial hangs,
established but never ready (`stallHandshakeOnConnect` in
`apps/cli/test/sftpServer/sessionControls.ts`).

What the run shows about the library -- that `end()` closes nothing
mid-handshake, that the destroy settles the parked attempt rather than
abandoning it, and what that rejection looks like -- is a normative pin row in
[DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md#upgrading-the-sftp-stack-ssh2--ssh2-sftp-client),
with the measured figures and the re-verify instruction on a bump. That row
defers to this note for the driven measurement and its limits, which are the
residue below.

- **The destroy is silent.** At default verbosity it draws no WARN and no ERROR of
  its own -- in particular not the "ssh2 client error outside an operation" line.
  What it does produce is the settled sibling's rejection, and whether that reaches
  the operator is the adapter's own doing: the cycle-start re-dial riding it reads
  the teardown latch before it warns, and a recovery re-dial's caller surfaces the
  loss it was recovering from instead of that rejection, so the only operator-facing
  line on this path is the deliberate one. The cycle-start half is asserted against
  the real stack at the CLI's default log level, because a mocked dial that stays
  parked through the destroy never reaches the line at all.

The bound itself rests on none of this: it is a fixed ceiling on the wait, so
whether ssh2 arms its connect deadline per attempt changes when the sibling gives
up, never when the waiter does.

Its limits, on the same terms as the section above. The control suppresses server
writes as the connection is accepted, which ssh2 does only after answering the
identification string, so what was driven is a server that answers that line and
then goes quiet; one that stalls once the key exchange is under way is a
different, unmeasured shape. And it is in-process only -- a native sshd cannot be
told to stall its handshake.

## How this was decided

The seam, scope, config shape, and reconnect posture were settled by an independent
panel of four expert-model lenses reasoning from first principles with no seeded
answer -- reliability and failure-mode, distributed-systems and protocol
correctness, transport and systems architecture, and operator experience and config
surface. They converged on the posture (observable and bounded so a held session cannot
reconnect forever), on connection-per-poll as the structural fix kept
as a hybrid, on the local non-bilateral explicit opt-in, and -- three of four,
including the architecture and reliability leads -- on the adapter-owned seam; the
lone dissent for a core-owned seam rested on a concern (invariants live in core)
that the adapter seam satisfies by keeping the teardown ordering in `close()`. The
load-bearing factual claims underneath the decision -- the operative dialing-retry
default of three, the surrounding bounds that terminate genuine failures, the
recovery's then-absent default-verbosity signal, the sticky `closing` latch, the
drain-budget exposure, and the publish-shape safety of an idle-aligned boundary --
were then adversarially verified against the tree as it stood.

## See also

- [FILE_SYNC.md](../spec/FILE_SYNC.md) -- the file-sync transport state model whose
  rendezvous, drain, abort-marker, and retain invariants this mode must preserve;
  the normative session-lifetime detail is specified there.
- [CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md) -- the authenticated abort
  marker and the transport liveness/memory bounds this mode reconnects around.
- [COMMUNICATION.md](../COMMUNICATION.md) -- the connection-lifecycle contract.
- [connection-error-kind-taxonomy.md](connection-error-kind-taxonomy.md) -- the
  clean-close versus local-close classification.
- [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md) -- the operator-facing
  configuration reference where the mode and the corrected reconnect behavior are
  surfaced.
