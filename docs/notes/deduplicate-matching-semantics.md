---
title: "Deduplicate: Which Side Carries the Multiplicity, and How Far It Reaches"
---

# Deduplicating matching semantics: the direction, the axis, and the round boundary

*Status: specified, and run end to end under `cascade` for the one-sided cardinalities -- through the result file, the exchange record, and the consent surfaces that state what the widening discloses. The normative rules are in [PROTOCOL.md](../spec/PROTOCOL.md#deduplicating-cardinalities-many-to-x-matching), with the record's count and re-supply rows in [EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#result-size-under-a-deduplicating-cardinality) and the operator-facing term in [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#linkage_termsdeduplicate); `many-to-many`, and any deduplicating term under `single-pass`, stay refused before matching begins. This note records why the rules have that shape, the alternatives weighed, and what stays open. See [docs/notes/README.md](README.md).*

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

Only one direction is a residual, and reading the two together overstates what is open. The unbound quantity is the many side's declaration of the size of its OWN group. The opposite freedom -- its partner deciding which of the many side's records belong to one group, on the way back -- is closed by a check rather than recorded, because there the many side does hold something to check against: the position each of its own entries named. That is the difference between the two. A self-declared quantity has no local counterpart; a partner's regrouping of a list this party wrote has one, entry for entry.

The reason to write this down rather than close it is that the argument is contingent on where the matched-record set comes from. A change that let the returned list decide membership -- rather than confirming a set the receiving party computed -- would turn a cheap overstatement into a disclosure, and would be recognizable as one against this paragraph.

## Why the recorded result size is the pair count

Once the multiplicity reaches the surfaces downstream of the association table, "the result size" stops naming one number. A table with several links per record admits three readings -- its pair count, this party's matched-record count, and the partner's -- and the exchange record has one field. The normative row is in [EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#result-size-under-a-deduplicating-cardinality); the case for it is here.

The deciding property is cross-party agreement. Both parties end a cascade holding the same table, so the pair count is one figure they derive identically -- exactly as the result size is one figure under `one-to-one`. A matched-record count is not: the "many" side would record more than its partner, and two records of one exchange would state two different sizes with nothing in either saying which reading it took. That is a poor property for an artifact whose whole purpose is to stand alone in front of an auditor.

The second reason is what the field is for. A record supports an accounting of disclosures, and what was disclosed is a set of linkages: this record of mine set against that record of yours. Under multiplicity the entity count is smaller than the linkage count on one side and larger on the other, and it is the linkage count that says how much crossed. Reading it as entities would also make the figure depend on a quantity the protocol leaves as the many side's own self-declaration (see the section above), where the pair count is at least a quantity both parties checked each other's contribution to.

Recording both was considered and set aside. The distinct matched-record count is derivable by each holder from its own retained result, so a second field would tell that holder nothing it could not compute -- while adding a figure to the artifact it hands an auditor, and taking a format version bump to do it. A reader who wants the entity-level figure reads the result file.

## Why the repeated copies must agree rather than be committed per pair

A record that stands in several pairs has its values written down the result file once per pair and committed once, because the payload commitments bind one row per matched record while the file is one row per pair. Reproducing the committed rows from the file therefore means collapsing the copies -- and a collapse that simply kept the first copy would leave every later copy's value cells reproduced by nothing. Neither commitment would reach them: the association-table commitment binds the pairing, not the values, and the payload commitment binds a row those copies were never compared against. The rule taken is in [EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#no-data-snapshot-in-the-keys-data-minimization).

There were two ways to close that, and the difference between them is what the artifact costs. Committing the received payload per PAIR would match the file exactly and remove the collapse, but it changes the committed bytes: a format version bump, a commitment carrying the same information at the file's redundancy, and the loss of the property that a sender's payload-sent commitment and its receiver's payload-received commitment cover byte-identical data. Requiring the copies to agree costs nothing in the artifact and nothing on the wire, and it is not an approximation: the copies ARE the sender's one row, so any disagreement is an alteration of the retained file and is reported as one.

What that buys is worth stating plainly, because it is the property a reader of a verified record is entitled to assume: every value cell the result carries is reproduced by something the record binds. The first copy reproduces the committed row; every later copy has to equal it.

## Why the result file gains no local row-index column

The result file identifies this party's matched record by its identifier value, or by the local row index when the exchange used no identifier column ([PROTOCOL.md](../spec/PROTOCOL.md#output)). The re-supply path that reopens a record's commitments maps that first column back to an input row, and where the identifier column has duplicate values it maps every duplicate to the first occurrence -- so the reproduction is exact only for an identifier unique per row.

That edge predates any multiplicity, but a deduplicating exchange is where it stops being an edge. The input such an exchange sets out to group holds several rows for one individual, and if its identifier column names the individual rather than the row, those rows share a value by construction. The reconstruction then reproduces the first of them for every later one and the commitments report a mismatch -- a correct verdict on an unmodified pair of files, which is the worst kind.

Carrying this party's own row index in the result, beside the partner's, would close it: the re-supply would read the index directly instead of inferring it. It is deliberately not done here. It is a change to the shape of a file operators hold, script against, and hand to their own downstream systems; it moves the value columns' offset for every reader of every result, including results already written; and it widens what a result discloses in the identifier-free case not at all but in the identified case slightly, by carrying a second locator for each matched record. Those are its own decision with its own doc row, not a line to slide in beside a commitment fix.

What is done here instead is to make the condition legible where it is met: the reconstruction's duplicate-identifier warning states that a deduplicating input carries duplicates by construction when its identifier names the individual, that every later duplicate reproduces the first row's values, and that an identifier unique per row reproduces exactly. An operator reading it is reading it about their own files.

## What stays open

- **Cross-round accumulation**, above: the rule taken is the conservative one, and the case for the other is a real one.
- **The closure procedure** for `many-to-many`, and what it discloses.
- **A deduplicating cardinality under `single-pass`.** The per-side rules are specified for both strategies, but only the cascade matches one; single-pass refuses every deduplicating cardinality until its receiver's replay carries the widening.
- **The `deduplicate` term on the invite-and-accept path.** Acceptance REFUSES a deduplicating invitation rather than adopting the inviting party's declaration -- `deriveAcceptedLinkageTerms` in `packages/core/src/config/linkageTerms.ts` throws at accept time, before deriving terms or opening a connection. The term is per-party and nothing on an invitation binds it to what the inviter runs, so it is not a value an invitation can safely carry to the acceptor's own side of the cardinality; a deduplicating exchange is instead reachable from two separately authored configurations. The invitation surfaces are held closed to match: the mint surfaces refuse to author the term, and an invitation carrying it regardless is shown with the refusal stated on the consent surface ahead of the accept refusal that enforces it -- so what stays open is the authoring question, not what an operator meets. Closing it is a consent-surface decision -- putting the choice to the acceptor at accept time, about what a party agrees to on its own side of the cardinality -- and is left as a separate, owner-ratified follow-on rather than settled here.
- **The injectivity check under the single-resolver variant**, the limit stated in [PROTOCOL.md](../spec/PROTOCOL.md#deriving-one-table-from-the-exchanged-association-maps): the clause is derived from the candidacy rules the built resolver shape holds, and the send-everything variant would need it re-derived rather than carried across.
- **Fan-out combined with a deduplicating cardinality.** The relaxed acceptance clause is specified and the two axes are defined to compose, but no exchange runs both today, and the combination deserves worked cases before it does.
- **How the grouping is surfaced to a person.** The result FILE is settled -- one row per pair, [PROTOCOL.md](../spec/PROTOCOL.md#output) -- because the record's commitments are reproduced from it and it therefore could not stay a front-end question. What a result VIEW makes of a group, and whether an operator is shown the grouping as a grouping rather than as repeated rows, is untouched.
- **An exact local locator in the result.** Above: a local row-index column would make the re-supply exact under a duplicated identifier, at the cost of a result-file shape change; the condition is warned about instead.
