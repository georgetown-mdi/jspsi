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
set to `peer_timeout_ms` (default one hour). A stalled send is bounded by its
time-to-live (also `peer_timeout_ms`). These bounds terminate a dead channel
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
  structural fix is connection-per-poll (below): it holds no session across the
  idle gap, so it never reaches the cap and its within-cycle recovery is bounded
  instead by the peer-inactivity ceiling.

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

- **Reconnect posture first.** Observability (a first-drop warning, a
  rate-escalated cadence after it, a warning on the last re-dial the budget
  permits, and the live count on the normal log) plus a
  cumulative `max_reconnect_attempts` budget that fails the exchange terminally when
  spent, so the field's name matches what it bounds: the cumulative number of
  mid-exchange reconnections in the default mode, on top of each connect's own
  dialing retries. This is independent of the mode, answers the
  silent-unbounded-default concern directly, and lets the operator observe the
  actual thrash before the budget is spent. The operator reference describes that
  bounded behavior rather than an unbounded or absent one.
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
  the normative lifecycle detail lands there when the mode ships.
- [CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md) -- the authenticated abort
  marker and the transport liveness/memory bounds this mode reconnects around.
- [COMMUNICATION.md](../spec/COMMUNICATION.md) -- the connection-lifecycle contract
  and the clean-close versus local-close classification.
- [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md) -- the operator-facing
  configuration reference where the mode and the corrected reconnect behavior are
  surfaced.
