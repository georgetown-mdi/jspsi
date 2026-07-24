---
title: "Connection-per-poll SFTP, and the reconnect posture beneath it"
---

# Connection-per-poll SFTP, and the reconnect posture beneath it

*Status: design settled, awaiting implementation. This note records the direction
chosen for a slow-peer SFTP transport mode and, underneath it, the mid-exchange
reconnect posture the mode depends on. The direction was reached by an independent
four-lens expert panel and its load-bearing claims were adversarially verified
against the tree; see [How this was decided](#how-this-was-decided). The normative
mechanism will be folded into [FILE_SYNC.md](../spec/FILE_SYNC.md) and
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md) when it ships, and surfaced to
operators through [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md); until then this
note is the design of record. See [docs/notes/README.md](README.md).*

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
mid-exchange") wraps every server-driven SFTP op so that, on a *clean* session
loss, the adapter re-dials -- reusing the pinned host-key fingerprint and stored
credentials with no re-prompt -- and re-issues the op before the loss is treated as
failed. Per-op idempotency resolvers make the re-issue safe (a landed delete maps
to success, a rename confirms its self-owned destination, a `createExclusive`
resolves its own `EEXIST`). Only a clean loss re-dials; a fatal protocol error, a
liveness stall, a memory bound, and a host-key mismatch stay terminal.

For the scenario above this means the exchange **survives** rather than aborting:
the session dies in each idle gap, and the next poll's first op silently re-dials.
That is a genuine robustness floor, and it is the right behavior to keep. But it
has three properties that make it the wrong resting *default* to leave unexamined.

**It is unbounded by design, and that is deliberate and correct.** The recovery
grants one fresh re-dial per op invocation with no cumulative lifetime cap. A
lifetime cap would be the obvious "don't reconnect forever" lever, and it is the
wrong lever: a partner that drops every ten minutes across a multi-hour exchange
would exhaust any fixed budget and defeat the feature in exactly the case it exists
for. The unboundedness must stay.

**Genuine failures already terminate -- unboundedness does not mask a dead
channel.** This is the crux, and it was verified against the tree. A re-dial
against a genuinely gone or credential-rotated endpoint exhausts the per-connect
dialing budget -- whose operative default is **three** retries (a fast-fail in
seconds), not the seven-day sanity ceiling that bounds only the config field -- and
the op then rejects, poll's catch emits an error, and the connection bridge makes
that terminal. A vanished or silent peer trips the receive-inactivity deadline,
which is set to `peer_timeout_ms` (default one hour). A stalled send is bounded by
its time-to-live (also `peer_timeout_ms`). So the "infinite" reconnect persists
*only* while re-dials keep succeeding **and** the peer keeps making progress within
each inactivity window -- that is, only while the exchange is genuinely alive. An
operator's instinct that "infinite reconnect when it is not known to be a failure
is acceptable" is correct, and the code already draws that line: a real failure is
not reconnected forever, it aborts within seconds to an hour.

**What cannot be told apart, and why that is the real gap.** The line the code
*cannot* draw without help is between a **chronic-benign** drop (a server session
cap: the re-dial succeeds every cycle and the exchange progresses) and a
**chronic-degraded** channel (the re-dial succeeds but the exchange barely moves).
Both present identically as "healthy, quietly reconnecting," and at plain default
verbosity there is no signal at all: the recovery path logs nothing per drop, and
the only trace, an aggregate reconnect count, is emitted solely on the opt-in
machine event stream, never on the operator's normal log. So an operator running a
six-hour exchange cannot distinguish one that is fine from one that is thrashing a
reconnect every cycle. Recognizing benign-versus-degraded from the code's own
vantage is not possible; it requires either **observability** (so the operator can
see the thrash and judge it) or an operator-supplied **declaration** that drops are
expected here. That declaration is precisely what the opt-in mode below provides.

One live legibility defect belongs to this same gap. The transport exposes a
`max_reconnect_attempts` field (default three) whose name promises control over
reconnection. It does not bound the number of mid-exchange recoveries -- it bounds
only the dialing-retry loop inside a single `connect()`. The one knob whose name
implies a
reconnect ceiling has no effect on the reconnecting an operator would want to bound.

## The reconnect posture

Keep mid-exchange recovery on and survival-preserving. Keep it uncapped by a
lifetime count. Change two things about the default:

- **Make it observable.** Emit an operator-facing warning on the first
  mid-exchange re-dial that names the likely cause and the remedy, and escalate by
  rate so a chronic capper is loud without spamming a one-off. Surface the live
  reconnect count on the normal log, not only on the event stream. This turns a
  silent, un-judgeable exchange into one whose degradation the operator can see.
- **Let the operator bound it, opt-in.** Offer a give-up ceiling on a
  drops-per-window or wall-clock basis -- default off, so the shipped survival
  guarantee is unchanged -- that ends the exchange with an actionable terminal
  message when tripped. This is the "not infinite by default" lever the maintainer
  wants, expressed as a rate/deadline the slow-peer case survives, rather than a
  lifetime count it would exhaust.

The recoverable-versus-terminal taxonomy stays exactly as it is: it keys on the
session's post-drop state, not on message matching, and it is sound. This posture
change is independent of the mode below, applies to every SFTP exchange, and
directly answers the concern about a silent unbounded default; it should land
first.

## Connection-per-poll

For the slow-asymmetric-peer case, the structural fix is to stop holding a session
across the idle gap at all. In the mode, each poll cycle dials a fresh SFTP
connection, runs that cycle's batch of ops, and releases the connection before the
loop goes idle again. A session then need only survive one cycle's seconds, so it
never reaches the server's duration or idle cap; there is no held-but-secretly-dead
window and no heartbeat to churn keepalives against a corpse. The failure it does
have -- a dial that fails -- fails loudly at one well-understood seam and is handled
by the ordinary connect-error path, rather than silently on the next op against a
cleared session.

The mode is a **hybrid**, not a replacement. The held-session default (with the
bounded, observable recovery above) stays right for fast and symmetric exchanges: a
full SSH handshake per cycle is negligible at a minutes-scale poll interval and
wasteful at the five-second default, so per-cycle dialing is only sane paired with a
long interval. Transparent recovery is retained underneath the mode as the
within-cycle safety net -- a drop *inside* a batch is still re-dialed -- but it is
demoted from the primary mechanism to a bounded floor, because per-poll has already
removed the between-cycles drop it was carrying.

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
- **Invariant ownership stays put.** The single-party appliance issues one op at a
  time; the adapter's serialization of `end()` against an in-flight re-dial is
  sound only because of that serial issuance. Keeping the lifecycle with the
  adapter keeps that invariant with its owner. The correctness concern that the
  invariants live in core is met regardless: the teardown *ordering* guarantee
  stays in `close()` (below); what moves into the adapter is only the mechanism.
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

The concrete flag name is deferred to the maintainer's separate CLI-naming
exercise; this note does not coin one. When it is settled it becomes a single
source of truth across the schema field, the CLI flag, and the operator docs.

## Invariants under a cycling connection

Under per-cycle connects the in-memory protocol state (role, peer id, sequence
shadows, responsible-file and foreign-file bookkeeping) survives, because only the
socket cycles -- the process stays alive. On-disk state is authoritative by design
("the directory is the state machine"). Against that backdrop the three
lifetime-sensitive subsystems divide cleanly.

**Rendezvous handshake -- test-hardening, given two placement rules.** The hello,
the zero-length ack, the lock-path joining sentinel, and the lock are committed
files that outlive any session, and the in-memory role and peer id are cleared only
at `close()`. So a release across a steady-state idle gap loses nothing. Two rules
make this hold and are the substance of the verification work: the one-time entry
guard and directory sweep must run exactly once, never re-entered on a later cycle
(a second entry would see this party's own hello and reject the directory as
unclean, or a re-run sweep would delete the party's own just-written files); and no
reconnect may reset the in-memory session state. The boundary must also never fall
mid-publish. Each publish the transport performs is a contiguous run of ops with no
idle wait in the middle -- a message is a temp write then an atomic rename; an ack
is a zero-length put then a rename; the joiner sentinel is a put, a delete, then a
rename; the hello is written directly to its final name and relies on the reader's
partial-sync gate rather than a rename; a lock is a single atomic exclusive create
at the transport seam. Since none of these straddles an idle wait, a boundary
aligned to the loop's idle points cannot tear one. A within-batch drop mid-publish
remains covered by the retained recovery resolvers.

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

## The work that follows

The downstream slices:

- **Reconnect posture first.** Make mid-exchange recovery observable (first-drop and
  rate-escalated warnings, the live count on the normal log) and optionally
  ceilinged (opt-in drops-per-window or wall-clock give-up, default off), and clarify
  the misleading reconnect-attempts field -- operators misread it as bounding
  mid-exchange recovery when it bounds only the per-connect dialing-retry loop, so
  its documented meaning matches what it bounds (a rename would be breaking, a
  separate naming call). This
  is independent of the mode, answers the silent-unbounded-default concern directly,
  and lets the operator observe the actual thrash before the mode is even built. The
  operator reference currently states, wrongly since transparent recovery shipped,
  that there is no reconnection after a mid-exchange drop; that line must be
  corrected here.
- **Implement the lifecycle.** The adapter ephemeral-session mode reusing the
  recovery machinery, the core idle-boundary signal, the non-terminal release that
  never latches the `closing` flag (so recovery stays enabled across cycles), and the
  ensure-connected-before-drain teardown change.
  The teardown change is code and lives here, not in verification.
- **Verify the invariants**, in two slices: rendezvous-across-disconnect (entry-once
  placement, durable handshake files, mid-publish safety) and retain bookkeeping
  (sequence and foreign-snapshot alignment across cycles).
- **CLI and config surface.** The local, non-bilateral, explicit opt-in described
  above, SFTP-scoped with the warn-not-block helper and the short-interval warning,
  outside the bilateral-mismatch machinery. The flag name is the maintainer's
  naming exercise.
- **Documentation.** The operational description and the named slow-peer use case in
  the operator reference, the lifecycle and boundary detail in the spec tier, and
  the correction of the stale reconnect line (if not already done in the first
  slice).
- **Test harness.** The integration server needs a capability it lacks: force a
  session drop after N ops or N seconds, and enforce a maximum-session/idle cap that
  drops after a bound. This exercises the within-cycle recovery, the per-poll
  boundary, and the drain-across-reconnect teardown, and reproduces the operator's
  actual failure to prove per-poll survives where the held session thrashes. A
  handshake-count assertion guards against the mode being enabled at the short
  default interval. This is a test-infrastructure item on its own board.

## How this was decided

The seam, scope, config shape, and reconnect posture were settled by an independent
panel of four expert-model lenses reasoning from first principles with no seeded
answer -- reliability and failure-mode, distributed-systems and protocol
correctness, transport and systems architecture, and operator experience and config
surface. They converged on the posture (observable and optionally rate/deadline-
bounded, never lifetime-capped), on connection-per-poll as the structural fix kept
as a hybrid, on the local non-bilateral explicit opt-in, and -- three of four,
including the architecture and reliability leads -- on the adapter-owned seam; the
lone dissent for a core-owned seam rested on a concern (invariants live in core)
that the adapter seam satisfies by keeping the teardown ordering in `close()`. The
load-bearing factual claims underneath the decision -- the operative dialing-retry
default of three, the surrounding bounds that terminate genuine failures, the silent-at-
default-verbosity recovery, the sticky `closing` latch, the drain-budget exposure,
and the publish-shape safety of an idle-aligned boundary -- were then adversarially
verified against the current tree.

## See also

- [FILE_SYNC.md](../spec/FILE_SYNC.md) -- the file-sync transport state model whose
  rendezvous, drain, abort-marker, and retain invariants this mode must preserve;
  the normative lifecycle detail lands there when the mode ships.
- [CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md) -- the authenticated abort
  marker and the transport liveness/memory bounds this mode reconnects around.
- [COMMUNICATION.md](../spec/COMMUNICATION.md) -- the connection-lifecycle contract
  and the clean-close versus local-close classification.
- [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md) -- the operator-facing
  configuration reference where the mode and the corrected reconnect behavior are
  surfaced.
