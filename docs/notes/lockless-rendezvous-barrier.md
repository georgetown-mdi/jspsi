---
title: "An Asymmetric Single-Writer Rendezvous Barrier"
---

# An asymmetric single-writer rendezvous barrier: weighed and set aside

_Status: weighed and set aside. The barrier the file-sync transport runs is the
symmetric two-ack one specified in
[FILE_SYNC.md](../spec/FILE_SYNC.md#phase-1----rendezvous-lockless-path), which
is normative; this note records the leaner barrier considered against it, why
the shipped one is correct without the change, and what would reopen the
question. Nothing here is scheduled or binding. See
[docs/notes/README.md](README.md)._

## The design considered

The lockless rendezvous completes when each party has seen an acknowledgment of
its own hello, so a completed rendezvous puts two hellos and two acks on the
directory. The leaner shape folds one of the acks into the message that follows
it:

- Both parties publish their hello, unchanged.
- Roles come from lexicographic hello-filename order, which is already how the
  lockless path assigns them.
- The lexicographic loser writes one barrier file and goes to receive.
- The winner waits for that file and then sends its first protocol message,
  which doubles as its own acknowledgment. The winner writes no ack.

The barrier file is the existing zero-byte ack marker named after the winner's
hello, not a new symbol in the filename grammar: the loser's file is exactly
what the rendezvous already writes there, so the entry guard, the retain-mode
sweep, the message-scan discriminant, and the loop's file recognizer all accept
it unchanged. A new symbol would cost a new grammar arm and a taxonomy
row reconciled column by column across the [five enforcement
sites](../spec/FILE_SYNC.md#the-five-enforcement-sites), for no functional gain.
The properties the lockless path rests on survive either way: roles stay
deterministic and symmetric, the barrier has a single writer so no atomic
exclusive-create is needed, and nothing is deleted.

## What it would buy, and what it would not

One control file per exchange, and nominally one half round trip. The saving
deserves a measurement, because the deployment behind it is agencies
reconciling a shared folder through a sync service on an hour-scale cycle: a
saved cycle there is an hour of wall clock, not a rounding error.

The half round trip appears not to be on the critical path. _Confidence:
reasoned from the protocol's structure, not measured._ Neither party can send
its first protocol message until it holds evidence that the peer saw its own
hello, and that evidence costs two propagation legs -- the hello out, an
acknowledgment back -- under both barrier shapes; the message itself is the
third. What the change removes is the other party's acknowledgment, which
nothing on the critical path waits for: it lets the receiving side finish
rendezvous a cycle earlier, and that side's next act is to wait for a message
that is further out regardless. One fewer file, and no sync cycle saved.

## Why the shipped rendezvous is correct without it

The symmetric barrier completes, and the arm the change would delete is not
idle. The party waiting for the acknowledgment of its own hello is the party
that runs the bounded entry-hello window, and receiving that acknowledgment is
the rendezvous-time observation that clears an entry-present hello from the
connection's residue attribution
([FILE_SYNC.md](../spec/FILE_SYNC.md#phase-1----entry-present-peer-hello)
specifies both). Both exist for the case these deployments actually walk into: a
directory holding a previous failed run's leftovers, cleaned by hand when an
exchange is first established rather than never occurring.

A loser that writes its barrier and drops straight to receive gives those up for
its own side. Entering a directory holding only stale residue, it would complete
a rendezvous with nobody, stall in the key exchange until the peer timeout, and
report generic partner silence -- where the shipped shape fails inside that
window and names the file to remove. That is the wrong direction on the path the
deployment walks most, and it is a regression against a shipped guarantee rather
than merely weaker attribution.

Two further costs stand against the change. The barrier's shape is not
advertised in the hello envelope, unlike the rendezvous and retain-mode flags
that produce an immediate bilateral-mismatch error naming both sides' settings,
so a mixed-build pair has no fast fail: it fails closed, but as a stall to the
peer timeout with nothing pointing at version skew -- for two agencies upgrading
on independent schedules, the worst available failure mode. And the change is a
flag day on the wire either way, reconciled across all five enforcement sites
and re-tested across the mode matrix.

## What would reopen it

Any one of:

- a timing measurement -- the mode matrix driven against a simulated sync period,
  comparing cycles to first delivered message under both barrier shapes --
  coming back with a real saved cycle, which would make the win hours rather
  than a file;
- a re-scope as an advertised hello-envelope flag, which removes the flag-day
  stall, at the cost of being a third negotiated mode rather than a barrier
  tweak;
- an unrelated change that makes the barrier's shape critical for some other
  reason.

In every case the remedy for the loser's lost fast fail ships with the change
and is not optional: the loser stays in its bounded loop after writing its
barrier, watching for the winner's first message file to APPEAR -- presence
only, by the message-scan grammar discriminant, never opening it -- bounded by
the same entry-hello window and attributed through the same machinery. It costs
no wire-format change and no latency, since that side was going to wait for the
message regardless. Its real cost is the thing to weigh: the rendezvous site
acquires a dependency on the message-scan site's filename grammar, which the
current split of the five enforcement sites avoids by design.
