---
title: "The SFTP adapter's session, boundary and operation state machines"
---

# The SFTP adapter's session, boundary and operation state machines

*Status: shipped. This note records the state-machine model behind the SFTP
adapter's session accounting -- what a session, a boundary and an operation each
are, and the decisions taken when the three were named -- and the reasoning that
produced it. The normative rows the model yielded are specified elsewhere: what
each bound protects and what each trigger counts in
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#sftp-mid-exchange-session-recovery),
the idle-boundary outcome partition in
[FILE_SYNC.md](../spec/FILE_SYNC.md#session-lifetime-across-an-idle-boundary),
and the operator-facing surface in
[EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#sftp-only-options). This note
states the model and the rationale, not the rows. See
[docs/notes/README.md](README.md).*

The model was named because the adapter's accounting defects were being
discovered piecemeal -- one review round finding a site that ended a session and
recorded nothing, the next finding one that reported two genuine losses as one --
and each was being fixed where it was found, as a symptom rather than as the
single missing model underneath all of them.

## Three machines, one lock

The adapter runs three state machines, and conflating them is what let the
defects hide. The first has a spine of its own; the other two had none, their
partitions living only in control flow -- which is what this model names.

| machine | instances | guarded by | spine |
| --- | --- | --- | --- |
| session | one per adapter | the FIFO transition lock | `runTransition`, `SessionTransitionKind` |
| boundary | one per `releaseForIdle()` invocation | the session machine's lock | `releaseForIdle` |
| operation | one per data-plane call | nothing -- concurrent by design | `runOperation` |

The session machine's spine -- the transition lock, its five kinds, the
exhaustive `ABANDONED_TRANSITION_DISPOSITION` record, and the
`assertTransitionHeld` identity chokepoint -- was already sound and is left
alone. What the model adds is a named outcome for the boundary
machine, one entry point and one span for the operation machine, and one place
where a session's end is recorded.

## The session machine

### States

These names are the model's, not a type the adapter declares. What the code
holds is the transition kind in flight, ssh2-sftp-client's session property,
the generation the ledger holds live, and the boundary reading; a state below is
a reading over those.

| state | meaning | how it reads |
| --- | --- | --- |
| `Unconnected` | no connect has succeeded | `originalConnectOptions` unset |
| `Dialing(kind)` | a transition is dialing | `transitionInProgress.kind` is `connect`, `ensureConnected` or `redialForRecovery` |
| `Live(g)` | generation `g` established and usable | the session property set, `SftpAdapterLedger.liveGeneration` equal to `g` |
| `LiveOverEndedTransport(g)` | the session property set over a transport either half of which has ended | `holdsSessionOverEndedTransport`, over `sessionTransportEnded` |
| `Releasing(g)` | the idle release holds the lock | `transitionInProgress.kind` is `releaseForIdle` |
| `Released` | no session, and a release of this side's took it | `SESSION_BOUNDARY_READINGS` reports `releaseTookTheSession` |
| `Lost` | no session, and the partner or a fault ended it | no session, with the boundary reading `notReleased` |
| `TearingDown` / `Closed` | terminal, single-use | `closing`, `terminalClose` |

The generation is the accounting's unit, and it is not the session property:
`liveGeneration` says a generation is outstanding and uncharged, not that a
session is usable. The gap between the two is exactly the interval a partner-side
drop occupies before anything on this side observes it -- which is why the idle
release, finding no session, still has to ask whether the generation it would be
ending is live.

`Released` and `Lost` are not declared states: they remain one nullable session
property plus the three-valued `SessionBoundary` reading. What the model changed
is that the reading is derived from the boundary outcome through one exhaustive
projection, rather than assigned independently at each site that reaches one.

### Events

Every concrete signal the adapter can take maps to exactly one event. This is the
answer to what separates a partner loss from a deliberate release.

| event | the concrete signal | observed at |
| --- | --- | --- |
| `DialSucceeded(g)` | a dial completes its post-connect sequence | `connectLocked`, via `SftpAdapterLedger.dialSucceeded` |
| `DialRetried` | the dialing loop re-attempts past the first | `connectLocked`, via `countConnectRetry` |
| `DialFailed(fatal?)` | retry exhausted; a `"Host denied"` rejection is fatal, as is a key exchange this process cannot perform | `connectLocked`'s retry predicate, and `isFatalDialError` at the cycle-start dial |
| `PartnerDropObserved(g)` | an operation rejects and the trigger reads a loss | `shouldRecoverFromSessionLoss`, charged in `redialForRecovery` |
| `PartnerDropAbsorbedByDial(g)` | a dial completes with `g` still live and its session already gone | `connectLocked`, ahead of the advance |
| `SessionReplacedByDial(g)` | a dial completes with `g`'s session still live -- a repeat `connect()` on an open connection | the same site |
| `PartnerFinAtBoundary(g)` | the peer's FIN already consumed at release entry | `releaseSessionForIdle`'s entry classification |
| `PartnerDropAbsorbedAtBoundary(g)` | this side's write half ended without this release | the same classification |
| `PartnerDropFoundAtBoundary(g)` | no session at release entry, with `g` still live | `releaseSessionForIdle` |
| `BoundaryOverEndedGeneration` | no session at release entry, with `g` already ended | the same site |
| `DeliberateRelease(g)` | the release drove `end()`, the `'close'` landed, neither half pre-ended | `releaseSessionForIdle` |
| `ForcedRelease(g)` | the close withheld past the bound, and the destroy cleared the session | `forceCloseEndedTransport` |
| `ReleaseClosedNothing` | the transport still writable after the wait, or a destroy that did not clear | `releaseSessionForIdle`'s two degraded tails |
| `Teardown(g)` | the connection's terminal close | `end`, `forceCloseTerminalTransport` |
| `FatalSession(g)` | the guarded `'error'` listener fires | `attachFatalErrorListener` |
| `TransitionDeclined(kind)` | the bounded acquire wait expired | `runTransition` |
| `TransitionSkipped(kind)` | teardown was latched at the front of the queue | `runTransition` |
| `BoundaryHeld` | an operation this side issued was still unsettled | `runTransition` |

### Transitions, and the invariant

| event | from | to | ends a generation | loss cause | recovery arm |
| --- | --- | --- | --- | --- | --- |
| `DialSucceeded` | Dialing | `Live(g)` | -- | -- | -- |
| `DialRetried` | Dialing | Dialing | -- | -- | -- |
| `DialFailed` | Dialing | `Unconnected` / `Lost` | -- | -- | the caller's |
| `PartnerDropObserved` | `Live` / `LiveOverEndedTransport` | `Lost` | yes | `partner` | re-dial and re-issue |
| `PartnerDropAbsorbedByDial` | `Lost` | `Live(g+1)` | yes | `partner` | the dial itself |
| `SessionReplacedByDial` | `Live(g)` | `Live(g+1)` | yes | `deliberate` | -- |
| `PartnerFinAtBoundary` | Releasing | `Lost` | yes | `partner` | the next cycle-start dial |
| `PartnerDropAbsorbedAtBoundary` | Releasing | `Released` | yes | `partner` | the next cycle-start dial |
| `PartnerDropFoundAtBoundary` | Releasing | `Lost` | yes | `partner` | the next cycle-start dial |
| `BoundaryOverEndedGeneration` | Releasing | unchanged | no | -- | -- |
| `DeliberateRelease` | Releasing | `Released` | yes | `deliberate` | the next cycle-start dial |
| `ForcedRelease` | Releasing | `Released` | yes | the entry classification's | the next cycle-start dial |
| `ReleaseClosedNothing` | Releasing | `Live(g)`, unchanged | no | -- | -- |
| `Teardown` | any | `Closed` | yes | `teardown` | the teardown re-dial, exempt |
| `FatalSession` | `Live` | `Closed` | yes | `fatal` | none, terminal |
| `TransitionDeclined` / `TransitionSkipped` / `BoundaryHeld` | queued | unchanged | no | -- | -- |

> **INV-L1 -- no generation leaves the live state without exactly one recorded
> loss cause.**

This is the model's single critical invariant, and it is the one thing the
adapter's review history rediscovered over and over. It is held **structurally**
rather than by assertion: every dial charges whatever end is still pending before
advancing, and `SftpAdapterLedger.dialSucceeded` raises rather than silently
replacing a generation that is still live.

That structure replaces a check the model originally proposed for it. A sum
balance over the ledger -- the recorded losses equalling the generations ended --
was measured to be an arithmetic identity of the ledger itself: losses rise only
where the live generation clears, and the ended count is derived from that same
field, so the sum holds whatever the adapter does and a missed or mis-attributed
charge cannot move it. What the tests pin instead is WHICH cause each driven end
charged, per cause and per scenario.

## The boundary machine

> **A boundary is one invocation of `releaseForIdle()`.** It has exactly one
> outcome, drawn from a total and mutually exclusive partition, recorded exactly
> once, by one recorder.

`IdleBoundaryOutcome` holds that partition, in eleven members. The mode being
off is **not** a boundary and not a member: the release returns before it enqueues
anything, so a held-session run records nothing here rather than recording a
no-op outcome. What each outcome is reached by, and what session it leaves the
poll loop, is specified in
[FILE_SYNC.md](../spec/FILE_SYNC.md#session-lifetime-across-an-idle-boundary);
what each one counts, charges and warns is a row in the trigger table in
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#what-the-accounting-counts).

Two facts the partition makes visible that scattered control flow could not:

- **The ordinary release needs a counter of its own**, or the forced-release
  total has no denominator: an operator reading "43 boundaries closed from this
  side" cannot tell 43-of-43 from 43-of-4300. `releasedBoundaryCount` is that
  denominator, summing the outcomes at which the release itself closed the
  session -- the ordinary release, the release over a transport already
  half-ended, and the forced close.
- **A boundary the peer had already closed still has to be recorded as a
  boundary**, separately from the loss it charges. Skipping the record is the
  right answer to the exemption question and a silence on the accounting one;
  splitting the outcome from its projections answers both without a fourth
  `SessionBoundary` variant.

Without one partition, that single question spreads over three vocabularies --
the transition's own arms, `SessionBoundary`'s three values, and a set of private
counters agreeing with neither -- which is how one boundary can move a counter,
leave a reading, and charge a loss on three different theories of what it was.

**The recorded value is the outcome; everything else is a projection of it.**
`SessionBoundary` is one -- through the exhaustive `IDLE_BOUNDARY_SESSION_READING`
record -- and whether the outcome ended a generation is a second, through
`IDLE_BOUNDARY_ENDS_THE_GENERATION`. The counter it moves is a third. A future
outcome must state every answer or it does not compile, which is the
exhaustive-`Record` pattern the adapter already uses for its abandon
dispositions, extended to the event.

One outcome is not a projection of the rest, by design. A forced close leaves
the entry classification standing, because the forcing says how the boundary
concluded, not who ended the transport beneath it -- so a partner drop this side
had to force closed stays charged to the partner rather than being exempted as a
deliberate release.

## The operation machine

> **An operation is one call into a `FileTransportClient` data-plane method that
> the adapter issues to the server.**

Two axes describe it. The first is which machinery it passes through: the
recovery-wrapped operations, and the ones counted outstanding but held outside
recovery by a contract of their own. The second is its re-issue policy, applied
only on the second attempt so that a delete-absent, rename-destination-exists or
own-`EEXIST` reading cannot leak into first-attempt semantics.

Both axes are held in one value at one entry point. `OperationRecoverySpec`
has three arms -- `verbatim` for an operation whose re-run is the whole policy,
`reissued` for one holding its own idempotency relaxation as a closure, and
`none` for one that never enters recovery -- and `runOperation` is where each
operation states its arm. The policies themselves are documented normatively in
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#re-issuing-an-operation).

The lifecycle:

```
Issued -> OnWire -> Settled(ok | err)
Issued -> OnWire -> SessionLost -> Recovering{ redial -> reissue -> [probe] }
                                -> Settled(ok | err) | Indeterminate
```

`Outstanding` is issued-and-not-settled, and is exactly what the idle boundary's
precondition reads. **The span is one per operation, opened at issue and closed
at final settlement**, recovery arm included -- not the per-attempt bracket, and
not a second span the recovery arm opens for itself.

That single span is the model's answer to a window the rejected two-span shape
leaves open. With the recovery arm opening a second span nested inside the
per-attempt bracket, there is an interval between the first attempt's bracket
settling and that arm opening its own in which the count reads zero, so a
boundary entering there is not held and can close the very session the recovery
is about to use. The model closed it structurally rather than documenting it:
with one span there is no reading of the count that names the window, because the
window does not exist. What the outstanding hold covers, and the two
directions in which issued-and-unsettled departs from on-the-wire, are in
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#the-outstanding-operation-hold-on-an-idle-boundary).

Three round trips the adapter issues sit outside the operation classification
entirely -- the heartbeat's keepalive, a listing's post-settle handle close, and
the cleanup drain's re-issue -- and that exclusion set is a check rather than a
claim: `scripts/sftp-tracked-round-trips.test.mjs` and
`scripts/sftp-operation-spans.test.mjs` parse the adapter and fail on any
request-issuing site the per-attempt bracket, or the operation span above it,
does not cover and their allowances do not name. What each analysis decides, and
where it stops, is in
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#the-outstanding-operation-hold-on-an-idle-boundary).

## The ledger

`SftpAdapterLedger` is one object holding the whole of an adapter's session
accounting: the generations, the live one, the per-cause loss rows, the
per-outcome boundary rows, the outstanding gauge and its hold stretches, the
retry tallies, and the shared warn cadence. It is transport-blind by design --
no ssh2 or ssh2-sftp-client type reaches it, and it holds no session, socket or
client state -- so everything in it is this side's own integer and the end-of-run
summary and the machine metrics event can read it back without a disclosure
question.

**The central move is where the charge happens.**

> **The accounting unit is the generation being ENDED, charged in the transition
> that ends it -- never in the operation arm that observes it.**

The alternative the model rejected charges from the first recovery arm to reach a
gate, keyed to a generation captured in the operation's closure and filtered by a
monotonic high-water mark over the generations already charged. Charging at the
site that ends the generation gives the same once-per-loss property more
robustly, and dissolves three defects of that arrangement at once:

| defect | the rejected arrangement | as shipped |
| --- | --- | --- |
| the monotonic gate silently drops a genuine loss | an arm holding a generation below the high-water mark passes through unrecorded, so two losses report as one | there is no such mechanism. `recordLoss` is called by the site that ends the generation, and its own generation check is what makes the charge once-per-loss -- no high-water mark, no accounted-generation set |
| the budget is read before the re-dial and spent after | what holds the cap is the transition queue's coalescing rather than the check | the read and the charge live in one critical section under the transition lock, in `chargeRecoveredSessionLoss` |
| a failed recovery re-dial charges nothing | the budget bounds successful recoveries | the LOSS is charged, so a re-dial that fails spends its unit like any other -- which is what the exhaustion message already tells the operator |

The operator-visible consequence of the third row is stated for what it is: the
budget bounds sessions lost, so a drop whose attempted re-dial fails spends a
unit, and at `max_reconnect_attempts=3` a fourth drop is refused outright --
`chargeRecoveredSessionLoss` charges the loss and raises the exhaustion error
before any dial is attempted, which the cap-boundary unit case pins as no
further connect call. A budget bounding successful re-dials would have left
that fourth drop one more attempt. This is the smallest arrangement under
which the budget means what its own message says.

The public getters are projections over those rows, and the ones that predate the
ledger are kept verbatim, which is what kept the scope of impact near zero: the
reconnect total is the connect-time retries plus the partner losses, its
mid-exchange sub-count is the partner losses alone, and the boundary counts read
their own rows. Two readings have a getter that the counters underneath them
never had -- the released-boundary denominator above, and the declined cycle
re-dials, which no summary totalled.

The warn cadence is one primitive rather than a copy of the same predicate per
warn stream -- a shape that had already produced one copy spelled with its sense
inverted relative to the rest. `pacedWarn` takes the caller's own running total
for that condition rather than keeping a tally of its own, so every stream is
paced on exactly the number its message quotes and the two cannot drift apart.

One outcome is unpaced by design. The degraded tail where the release's own
`end()` left the transport still writable is the one outcome with no run total,
so every occurrence is its own record rather than one in ten.

## Decisions taken

The technical calls the model determined. Each is critical in the code as
shipped.

| # | decision |
| --- | --- |
| D1 | Charge the loss at the transition that ENDS the generation, never in the arm that observes it. |
| D2 | Delete the monotonic high-water mark outright. No replacement, and no accounted-generation set. |
| D3 | The cumulative-budget check and its charge live in one critical section under the transition lock. |
| D4 | The outstanding span opens at the operation's single entry point, outside recovery. The arm's second span goes, and the uncovered window closes rather than being documented. |
| D5 | `IdleBoundaryOutcome` is the recorded event; the session reading, the generation-ending answer and the counter are all exhaustive projections of it. |
| D6 | Keep the existing public getters as projections, and keep the outstanding-operation reading under its own name. |
| D7 | Do not touch the transition lock, the abandon dispositions, the ssh2-internals resolvers, the deferred-cleanup record, or the SFTP test-server harness. |
| D8 | Do not split the adapter module by line count. |
| D9 | The unbracketed round-trip set stays a parse check, never a comment. |
| D10 | The terminal close's single-use rule stays adapter-local, in the memoized `terminalClose`, rather than becoming a `FileTransportClient` contract change. |

## Which document owns what

Stated once, so the model does not get re-litigated a tier at a time.

| document | owns |
| --- | --- |
| [FILE_SYNC.md](../spec/FILE_SYNC.md#session-lifetime-across-an-idle-boundary) | when the loop's session exists, and the idle-boundary outcome partition |
| [CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#sftp-mid-exchange-session-recovery) | what is counted, capped, exempt and bounded |
| [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#sftp-only-options) | when an operator should choose the mode |
| [CLI_EVENTS.md](../spec/CLI_EVENTS.md) | the machine event field's contract |
| this note | the model, the decisions, and why each was taken |

A new bound, trigger or boundary outcome appends a ROW to the table that owns it,
rather than a clause to a paragraph.

## Implementation record

The model was ratified on 2026-08-02 and landed in three changes: the ledger and
the counter consolidation (#663), the event model and the loss accounting (#665),
and the tabulation of the specification sections that hold the normative rows
(#666).

Three things shipped differently from the model as first written, each for a
reason measured during implementation:

- The boundary partition shipped with eleven members rather than ten. A boundary
  finding the session already gone has to distinguish a generation still live
  (a partner drop this boundary is the first thing to observe) from one already
  ended and charged, so `alreadyEnded` joined `noSession`; and the mode being off
  is not a boundary, so it is not a member at all.
- INV-L1 shipped as a structural property with per-cause test pins rather than as
  the proposed sum check, which measurement showed to be an identity of the
  ledger.
- The one degraded release tail with no run total warns unpaced.

## See also

- [CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#sftp-mid-exchange-session-recovery) --
  the normative recovery section: the trigger table, the bounds table, the
  re-issue policies, and the outstanding-operation hold.
- [FILE_SYNC.md](../spec/FILE_SYNC.md#session-lifetime-across-an-idle-boundary) --
  the per-cycle session lifetime the boundary machine runs under, and the
  outcome partition's normative rows.
- [connection-per-poll-sftp.md](connection-per-poll-sftp.md) -- the note beneath
  this one: why the mode exists, and the reconnect posture it rests on.
- [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#sftp-only-options) -- the
  operator-facing configuration surface and what the run reports.
- [DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md) -- the ssh2 and
  ssh2-sftp-client internals the session machine's readings rest on, and what a
  version bump must re-verify.
