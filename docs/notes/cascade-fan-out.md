---
title: "Cascade Fan-Out Realization: Directed, Spec Pending"
---

# Cascade fan-out realization: directed, spec pending

_Status: directed, spec pending. `split_on` fan-out ships under
`linkage_strategy: single-pass` only; linkage terms declaring a fan-out under
`cascade` are refused at validation, specified in
[PROTOCOL.md](../spec/PROTOCOL.md#linkage-strategies-cascade-and-single-pass)
("Linkage strategies: cascade and single-pass") and
[Fan-out runs under single-pass only](../spec/PROTOCOL.md#fan-out-runs-under-single-pass-only),
and that refusal stays the shipped behavior until the realization lands. This
note records the design panel's finding on why the cascade's existing frames
cannot support the same realization and the protocol sketch weighed for a
future cascade fan-out. The finding is that the naive approach is defective,
not that fan-out under `cascade` is infeasible, and the sketch below is the
basis for the spec item "Specify cascade fan-out as per-round resolution
frames", which precedes the implementation and takes the realization
forward. See [docs/notes/README.md](README.md)._

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

## Why the refusal stands until the spec lands

Narrowing fan-out to `single-pass` and refusing it under `cascade` closes the
declared-but-inert path without leaving any half-built cascade realization in
place: a linkage-terms document declaring a `cascade` fan-out is refused
before any credential, terms, or data moves, exactly like every other refused
combination the schema admits. Realizing cascade fan-out is a larger,
protocol-version-covered change to the round loop with no correctness result
worked out yet, not a gap in coverage of shipped behavior; that result is
what "Specify cascade fan-out as per-round resolution frames" covers, and it
precedes the implementation. This note exists so that the spec starts from the
timing defect above rather than re-discovering it, and reproduces the
resolution rule
[PROTOCOL.md](../spec/PROTOCOL.md#fan-out-matching-multi-value-key-candidates)
already fixes rather than inventing a second one.

## What the spec must resolve

A cascade spec that resolves the commitment-ordering defect above -- a
per-round frame extension, worked out to the level PROTOCOL.md normatively
specifies its other wire content, that delivers each round's matched-value
record grouping to both parties before the next round's candidate set forms,
and that reproduces the byte-identical association table `single-pass`
computes on the same inputs -- is what "Specify cascade fan-out as per-round
resolution frames" covers, as a protocol-version event. Until that spec
lands, the `cascade` refusal stands as the shipped behavior.
