---
title: "Cascade Fan-Out Realization: Resolved"
---

# Cascade fan-out realization: resolved

_Status: resolved; the realization ships. A candidate set runs under
`linkage_strategy: cascade` as it does under `single-pass`, each party
resolving its own round from the grouping the round's two frames hold,
specified in
[PROTOCOL.md](../spec/PROTOCOL.md#linkage-strategies-cascade-and-single-pass)
("Linkage strategies: cascade and single-pass") and
[Fan-out runs under both linkage strategies](../spec/PROTOCOL.md#fan-out-runs-under-both-linkage-strategies).
This note records the design panel's finding on why the cascade's existing
frames could not support the naive realization, and the protocol sketch that
finding pointed at -- the sketch the shipped realization is built on. See
[docs/notes/README.md](README.md)._

This is design rationale. Nothing here binds an implementation; the normative
rows live in
[PROTOCOL.md](../spec/PROTOCOL.md#fan-out-matching-multi-value-key-candidates),
and this note does not restate them. The resolution rule fan-out realizes
under `single-pass`, the divergence hazard it closes, and the alternatives
weighed to reach that strategy choice are recorded in
[fan-out-matching-resolution.md](fan-out-matching-resolution.md); this note is
scoped to the cascade realization alone -- what that design left open on
purpose, and what a panel found when it examined it.

## The design considered

The cascade already runs a per-key exchange whose final step -- after every
key's round has closed -- remaps each round's matched value-level indices into
the partner's original row indices. That step already holds a record
grouping of matched values, and the cheapest-looking way to realize fan-out
under `cascade` was to reuse it directly: extend that existing final table
exchange to carry the matched-value record grouping the resolution rule needs,
so a cascade run could compute the same record-level association table
`single-pass` computes, without adding a frame or a round.

## The decisive defect

The final table exchange runs only once, after the whole per-key loop has
closed -- not once per round. Fan-out resolution decides which records leave
the candidate set for the NEXT round; a record whose candidate values matched
in round `j` must not enter round `j + 1`'s set at all. Grouping delivered on
the final exchange arrives after every round's candidate set was already
formed and committed, so it cannot drive that removal. Each party would still
have to prune its own round `j + 1` candidate set from information it does not
yet have, and a party pruning from its own record grouping alone diverges from
its partner whenever a value-level match is ambiguous across records on both
sides (the same divergence hazard
[fan-out-matching-resolution.md](fan-out-matching-resolution.md#the-divergence-hazard)
walks through for the strategy choice generally). The final-exchange route is
therefore not merely more disclosive than delivering the grouping earlier --
it is incorrect for the cascade's round-by-round removal semantics, because
the grouping arrives after the commitment it would need to inform.

A correct cascade fan-out has to extend the PER-ROUND frames instead of the
final one, so that round `j`'s resolution is known to both parties before
round `j + 1`'s candidate set is formed. That is the protocol sketch this
design panel left open: a per-round frame extension carrying the matched-value
record grouping inline with each round's own exchange, rather than deferred to
the final pass. It was not designed past that shape -- no frame layout, no
disclosure accounting, and no interaction with the round-symmetry checks were
worked out -- and it reaches into the innermost, most heavily
security-reviewed loop of the protocol, which is why it was left as a
direction rather than built.

## Why the refusal stood while the spec was written

Narrowing fan-out to `single-pass` closed the declared-but-inert path without
leaving any half-built cascade realization in place: a linkage-terms document
declaring a `cascade` fan-out was refused before any credential, terms, or data
moved, exactly like every other refused combination the schema admits.
Realizing cascade fan-out was a larger change to the round loop with no
correctness result worked out yet, not a gap in coverage of shipped behavior.
This note exists so that the spec started from the timing defect above rather
than re-discovering it, and reproduces the resolution rule
[PROTOCOL.md](../spec/PROTOCOL.md#fan-out-matching-multi-value-key-candidates)
already fixes rather than inventing a second one.

The refusal that remains is not the strategy's: a count-only exchange
refuses a candidate set for reasons of its own, while a both-sided
`deduplicate` resolves one under either strategy
([The combinations that stay unsupported](../spec/PROTOCOL.md#the-combinations-that-stay-unsupported)).

## What the spec had to resolve

The commitment-ordering defect above needed a per-round frame extension,
worked out to the level PROTOCOL.md normatively specifies its other wire
content, that delivers each round's matched-value record grouping to both
parties before the next round's candidate set forms, and that reproduces the
association table `single-pass` computes on the same inputs. That is what the
sections below settle, and what the realization implements.

## Where the design landed

PROTOCOL.md holds that per-round design, for a candidate set from any
producer.
[Per-round candidacy under cascade](../spec/PROTOCOL.md#per-round-candidacy-under-cascade)
opens it, and the four subsections after it fix the frame extension and its
checks
([The per-round grouping the two frames hold](../spec/PROTOCOL.md#the-per-round-grouping-the-two-frames-hold)),
[the normative double-match case](../spec/PROTOCOL.md#the-normative-double-match-case),
[what the cascade realization owes](../spec/PROTOCOL.md#what-the-cascade-realization-owes),
and
[the combinations that stay unsupported](../spec/PROTOCOL.md#the-combinations-that-stay-unsupported).
The disclosure the grouping pays is a row of
[The disclosure delta fan-out pays](../spec/PROTOCOL.md#the-disclosure-delta-fan-out-pays)
and its version consequence a paragraph of
[Wire-format deltas](../spec/PROTOCOL.md#wire-format-deltas-existing-frames-only-and-no-version-bump),
both sections above it. One reason stated above is
corrected there: round `j + 1`'s candidate sets do not diverge, each party
computing its own removals from its own round output and its own incidence,
and what a party cannot compute alone is the round's accepted pair set. The
timing defect stands as stated -- the final exchange presupposes the
resolution the grouping would compute, and forfeits the per-round fail-fast.

## The final pass is extended too

The sketch above moved the grouping off the final exchange and left that
pass's own shape alone. Measurement then found pairings one position per
accepted record cannot state: a candidate set under a one-sided deduplicating
cardinality reaches rounds where one record is accepted against two of the
partner's groups, and where one group splits across two of the partner's
records, both of which `single-pass` resolves on the same inputs. Three ways
out were weighed -- refusing those rounds and recording the boundary as
unsupported, scoping the single-pass equivalence to the shapes the narrower
entry can state, and extending the entry -- and the entry was extended, on the
ground that both parties commit over the association table, so a table that
depends on which strategy produced it invites a divergence claim between
partners.

[PROTOCOL.md](../spec/PROTOCOL.md#the-per-round-grouping-the-two-frames-hold)
holds the extended entry and the preconditions the pass reads it under, and
[the normative double-match case](../spec/PROTOCOL.md#the-normative-double-match-case)
holds a worked case of each shape; this note does not restate them. The finding above is
unaffected: what cannot ride the final exchange is still the grouping, and
what the final pass states is the resolution the per-round grouping already
produced.
