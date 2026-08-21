---
title: "Deduplicate: Which Side Carries the Multiplicity, and How Far It Reaches"
---

# Deduplicating matching semantics: the direction, the axis, and the round boundary

*Status: specified; built in the cascade, behind the standing refusal. The normative rules are in [PROTOCOL.md](../spec/PROTOCOL.md#deduplicating-cardinalities-many-to-x-matching), with the operator-facing term in [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#linkage_termsdeduplicate); a `deduplicate: true` term is still refused before any matching begins, so no exchange runs one. This note records why the rules have that shape, the alternatives weighed, and what stays open. See [docs/notes/README.md](README.md).*

This is design rationale. Nothing here binds an implementation; the normative rows live in the spec documents linked above, and this note does not restate them.

## The problem

`deduplicate` is schema-complete, exchanged, consented to, and refused at run time. What it was not was specified: the protocol document carried design intent rather than rows, and the surfaces describing the term disagreed about which DIRECTION the multiplicity runs -- a field comment reading "this party's records may match more than one of the partner's" against an operator-facing description of grouping one's own inputs. Those are opposite exchanges. Since nothing runs, the disagreement costs nothing at run time; it would have cost a great deal at implementation time, when two surfaces claiming opposite cardinalities are read as requirements.

## Why the declaring party is the "many" side

The direction is not free to choose: the term's name and its operator-facing question already fix it. A party is asked whether it wants to deduplicate ITS OWN inputs. Deduplicating one's own inputs means discovering that several of one's own rows are one individual, and the only evidence the exchange can offer for that is that those rows all name the same partner record. So the declaring party contributes several records per matched value, which is the "many" side. Reading it the other way -- one of my records matching several of the partner's -- would deduplicate the PARTNER's data and hand the grouping to the party that did not ask for it.

The requirement that a deduplicating party receive output falls out of the same reading rather than being a separate policy. The grouping is what the exchange produces for that party; a "many" party entitled to no output would have widened its own match, disclosed to its partner how its records group, and taken nothing back.

## Why the incidence is named once, ahead of two features

Two independent lines of work widen matching, and they widen it in opposite directions over the same object. `split_on` and `generate_fuzzy_comparisons` give one record several candidate VALUES for a key; `deduplicate` gives one value several RECORDS. Specified separately, each would have had to restate what a match means and how a value-level match becomes a record pair -- and two restatements drift.

Naming the `(record, value)` incidence and its attribution rule once, in terms neither feature owns, buys three things. Each feature's rule becomes a statement about one axis and reads the other's output rather than redefining it. The question "does this widening move a derived bound?" gets a structural answer instead of a case-by-case one: the values-per-record axis can raise a party's distinct-value count and therefore falsifies the premise the single-pass bounds rest on, while the records-per-value axis provably cannot. And the interface is fixed without deciding either fuzzy-comparison or fan-out design question -- both remain free to choose their own width, resolution, and cap.

## Why multiplicity is within-round

The consequential choice in this specification is whether a later, weaker key may add a link onto a record the other side already matched in an earlier round. Two readings were available.

**Within-round only** (the rule taken). A record on either side that appears in any of a round's candidate pairs leaves candidacy for every later round. A group is therefore formed by one key: the most precise key on which its members share a value with one partner record.

**Cross-round accumulation.** A matched record on the "one" side stays in candidacy, so a later key can attach further records of the many side to a group an earlier key opened.

Three things decided it for the within-round reading.

- It is the reading the protocol's existing per-round candidate filtering already describes, and the reading the sibling multiplicity axis was specified under: fan-out's removal on a potential match takes every record appearing in a round's candidate pairs out of candidacy whether or not it was paired. Two multiplicity features with opposite candidacy rules would be a poor pair to hand an implementer.
- It preserves the cascade's ordering premise. The keys are ordered most precise first, and removal is what makes an earlier key's verdict final. Keeping a matched record in candidacy means a weaker key can revise a stronger key's grouping, which inverts that premise.
- It is the lower-disclosure choice, and the reversible one. Accumulation keeps already-matched records contributing values to later rounds, so the partner observes matches on weaker keys against records the cascade would have removed. Nothing is implemented yet, so widening the rule later is a specification change with no deployed peer to reconcile; narrowing it later would take back a capability an operator had.

The cost is real and worth stating plainly rather than leaving to be discovered. A many-side record that holds no value for the key its duplicate group formed on -- a row missing the SSN its siblings matched by -- does not join the group by matching the same partner record on name and birth date later, because that partner record has left candidacy. Multi-key deduplication therefore groups on one key per group rather than accumulating evidence across keys. **This is the point in this specification most likely to be revisited**, and the change would be localized: the per-side candidacy rule, the candidate-set construction on the "one" side, and the disclosure row that follows from it.

## Why the many side collapses to a value and re-expands locally

A round's PSI set is a set of values, and the association map addresses positions in it. So the many side contributes each distinct value once and attributes a match on it to every one of its records holding that value, rather than entering the same value once per record. Entering it per record would give two indistinguishable positions for one value, which nothing downstream can attribute -- the re-expansion has to be local whatever the wire does.

That choice is what keeps the widening free of any frame change. The many side's set is no larger than a one-to-one party's would be (it is smaller, since duplicates collapse), so no derived bound moves, and the single-pass index table's one-value-per-cell shape already expresses everything a deduplicating party's records hold. The only thing that grows is the mapped-element list, which grows by the multiplicity the receiving party can compute from what it already holds -- so the growth is checked rather than merely tolerated.

## Why no strategy restriction, where fan-out took one

Fan-out is confined to `single-pass` because resolving it needs the PARTNER's grouping of matched values into records, and the cascade's per-round frames deliver that grouping only after the candidate sets it should have informed are already committed. It is tempting to assume a deduplicating cardinality inherits that confinement, since both are multiplicity features.

It does not, and the axis distinction is exactly why. Grouping one's OWN records by value needs only one's own data. Each party computes its own removals from its own round output, in the round, with no knowledge of how the partner's matched values group. There is no second computation to diverge from, so the cascade carries a deduplicating cardinality on the frames it already sends. The generalization it does need -- an expanded translated list -- is a length change to an existing frame, not a new shape.

## Why many-to-many stops at the pairing rules

The `(true, true)` pair is not hard to pair: both sides keep their duplicates and every candidate pair is accepted. What it is not, at that point, is an answer. A table where both sides carry multiplicity links records transitively, and turning it into something either party can act on means resolving it into entity clusters -- with all the care that transitive closure demands, since it can join two records through a third with no rule joining them directly.

That closure is a separate piece of work with its own disclosure question, so this specification stops where the pairing stops and `many-to-many` is refused with the rest. Fixing the pairing rules ahead of that work is still worth doing: it means the closure work inherits a defined table rather than defining one on its way past.

## Why the many side's per-value multiplicity stays a self-declaration

This is the question the specification left to the work that implements the cardinality, and the answer is that there is nothing to bind it against. The normative statement of the limit and the residual is in [Deriving one table from the exchanged association maps](../spec/PROTOCOL.md#deriving-one-table-from-the-exchanged-association-maps); the reasoning is here.

Two candidate quantities exist, and neither is one. The agreed terms describe what a linkage key is, never how a party's own rows duplicate under it. The only per-party figure that would is the duplication structure itself, which the protocol deliberately keeps off the wire -- it is the same fact [work minimization](../spec/PROTOCOL.md#role-resolution-and-work-minimization) declines to exchange -- so a bound derived from it would be advertised by exactly the party it binds, which is the self-declaration again with an extra frame.

That leaves the question of what overstating buys, and the answer is what makes recording the residual acceptable rather than merely unavoidable. Which of the receiving party's records matched is decided by that party's own round output, through the coverage rule; the returned list can repeat a position but cannot introduce one. So an overstated group adds no matched record, no disclosed column, and no membership fact on the receiving side. It repeats a row that side already pairs, inflates the overstater's own table with pairs naming its own rows, and is capped by the row count that party carried on the terms exchange.

The reason to write this down rather than close it is that the argument is contingent on where the matched-record set comes from. A change that let the returned list decide membership -- rather than confirming a set the receiving party computed -- would turn a cheap overstatement into a disclosure, and would be recognizable as one against this paragraph.

## What stays open

- **Cross-round accumulation**, above: the rule taken is the conservative one, and the case for the other is a real one.
- **The closure procedure** for `many-to-many`, and what it discloses.
- **Fan-out combined with a deduplicating cardinality.** The relaxed acceptance clause is specified and the two axes are defined to compose, but no exchange runs both today, and the combination deserves worked cases before it does.
- **How the grouping is surfaced.** A deduplicating result is several output rows against one partner row; what a result file and a result view make of that is a front-end question this note does not touch.
