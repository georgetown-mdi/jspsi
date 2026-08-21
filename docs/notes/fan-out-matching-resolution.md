---
title: "Fan-Out Matching: Local Resolution, and the Strategy It Runs Under"
---

# Fan-out matching: why resolution is local, single-pass, and greedy

*Status: built under `single-pass`. The construction is normatively specified in [PROTOCOL.md](../spec/PROTOCOL.md#fan-out-matching-multi-value-key-candidates), with the operator-facing description in [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#fan-out-multi-value-fields); a fan-out declared under any other strategy is refused before the exchange runs, and the cascade realization stays open work. This note records why the rules have that shape, the alternatives weighed and set aside, and what remains open. See [docs/notes/README.md](README.md).*

This is design rationale. Nothing here binds an implementation; the normative rows live in the spec documents linked above, and this note does not restate them.

## The problem, and the two constraints that shape it

A fan-out transform gives one individual several candidate values for one linkage key: a hyphenated surname becomes the whole name plus each part, so one record enters a round with three ways to match instead of one. That is a widening -- it exists to catch the same person recorded two ways -- and the matching layer as it stood took one value per record per round, so a splitting row was refused rather than silently matched on nothing.

Two constraints were fixed before any design was weighed, and everything below follows from them:

1. **A record that might match on several values is removed in a cascade.** Once one of an individual's candidate values matches, that individual cannot double-match, and it leaves the candidate set for the later, less precise keys.
2. **No additional protocol messages.** Pruning is local, computed from what the existing message flow already carries. Extending the content of a frame the exchange already sends is in scope; adding a frame or a round is not.

Constraint 2 is what makes this a protocol question rather than a matching-code question. Constraint 1 is what makes it a *resolution* question: the moment two of an individual's values can match two of the partner's records, something has to decide which pairing is the link, and both parties have to decide it the same way or their association tables disagree.

## The divergence hazard

Own-side pruning is not enough, and the smallest counterexample is worth carrying. Take value-level matches `(a1, b1)`, `(a1, b2)`, `(a2, b2)`, where `a1` and `a2` are values of one party's records and `b1` and `b2` values of the other's, and suppose `a1` and `a2` belong to different records on the first party while `b1` and `b2` belong to different records on the second.

Each side sees the pair list at the level of *values*, and each side knows how its OWN values group into records. Neither knows how the partner's matched values group. A greedy that prunes using only its own grouping therefore keeps a different pair set on each side, and the two parties end the exchange with different tables -- or, in the lockstep cascade, trip the round-symmetry checks and abort. Record-level resolution needs the grouping of matched values into records on BOTH sides. That requirement, not the pruning itself, is what selected the strategy.

## Why single-pass only

Single-pass has exactly one resolver. The receiver holds the sender's full per-key structure -- which of the sender's records hold which distinct values -- replays the cascade locally, and returns the sender's half of the resolved table in message 3. There is no second computation to diverge from: both parties' tables are the same artifact, and the ragged multi-valued cell the fan-out needs is precisely the "extend an existing frame's content" that constraint 2 permits.

The cascade cannot reach the same place on its existing frames, and the reason is a timing defect rather than a disclosure one. The cascade's per-round exchange carries positions in that round's candidate set; the translation of matched positions into the partner's original row indices happens AFTER the per-key loop has closed, in the final mapped-element passes (`exchangeMappedElements` in `packages/core/src/link.ts`). Fan-out resolution is exactly what decides which records leave the candidate set for the NEXT round. Grouping delivered on the final frames therefore arrives after every candidate set it was supposed to inform was already committed: the two sides can remove different records at round `j` and diverge, which is the hazard above with the clock added.

So the alternative that looked cheapest -- carry the matched-value record grouping on the cascade's existing final table exchange -- is not merely more disclosive, it is incorrect for the cascade removal semantics. A correct cascade fan-out has to extend the PER-ROUND frames instead, so that round `j`'s resolution is known before round `j+1`'s candidate set is formed. That is a larger change, and it lands in the innermost security-reviewed loop of the protocol. It remains open as future work and would be its own protocol-version event; the resolution rule is fixed normatively now precisely so that work reproduces this table rather than inventing a second one.

Narrowing the feature to one strategy also reuses machinery that already exists and is already symmetric. `linkage_strategy` is a mandatory-consistency agreed term, so a strategy-conditional refusal narrows the standing `split_on` refusal rather than inventing a control: both parties refuse in lockstep from the agreed pair.

**The cost, stated plainly.** `cascade` is the schema default and the web application's ordinary path. Fan-out therefore becomes a feature an operator opts into a *different strategy* to get, inheriting single-pass's larger disclosure (the receiver sees the sender's whole per-key value structure and the weaker-key matches the lockstep cascade filters out) and its tighter dataset ceiling. That coupling is a real reduction in reach, which is why it is stated in the disclosure rows of the spec rather than left for an operator to discover.

One asymmetry in the refusal deserves its own line, because it is the one place a strategy refusal is not symmetric: a field-level fan-out lives in a party's own data standardization, which is per-party and local and which no invitation carries. The partner cannot derive that refusal from the agreed terms, so it has to land in front of the operator at preparation time -- before a connection exists to leave hanging -- and, if it somehow reaches the run boundary, as an abort carrying its reason rather than a silent decline. An element-transform fan-out rides the agreed terms and needs no such handling.

## Why a greedy sweep, in (sender row, receiver row) order

Any deterministic, side-symmetric order would do; the choice matters only because it decides which of two ambiguous matches wins, and that has to be fixed rather than emergent. Three properties decided it:

- **Role-derived components.** Sender and receiver are fixed for the exchange by role resolution, from counts both parties hold. An order phrased in terms of "local" and "partner" rows would name different things on the two sides; one phrased in sender/receiver names the same thing on both. This matters even though only the receiver resolves today, because it is what lets a future cascade realization compute the identical order.
- **It is an order the frames already carry.** Message 3's local half is the sender's own rows in ascending order, and that ascending order is enforced at the single-pass seam. Ordering the sweep sender-major means the resolution order and the frame's canonical order are one order rather than two.
- **It reduces to today's behavior.** On single-valued inputs each round's candidate pairs form a partial one-to-one correspondence, so the sweep accepts every pair whatever the order. The rule therefore changes no fan-out-free run, which is what lets the strategies' existing byte-identical-table claim stand unqualified.

A maximum-cardinality matching would pair more records in an ambiguous round than a greedy sweep does. It was set aside: it needs a canonical tiebreak anyway (so it does not avoid this decision, only adds to it), it is materially more work in the innermost replay, and "more pairs" is not obviously the better answer when the ambiguity means the evidence was contradictory. The greedy's bias is legible -- the lowest-numbered sender record wins its lowest-numbered candidate -- and legibility is worth more here than cardinality.

Resolution being value-order-independent is deliberate too. An earlier instinct is to sweep in the order the values appear, which is what the current single-pass replay effectively does; that order is an artifact of a hash map's insertion sequence and of the sorted position of encrypted elements, neither of which an independent implementation reproduces. Naming row indices instead makes the rule reproducible from the frames alone.

## Removal on a potential match, and its cost

Constraint 1 is implemented as: every record appearing in ANY of round `j`'s record-level candidate pairs leaves candidacy for rounds after `j`, accepted or not. The consequence worth naming is that a record whose candidates matched but which lost the sweep ends the exchange unmatched -- it does not fall through to a less precise key.

That is the intended reading of the cascade, not a compromise. The keys are ordered most precise first; a record whose candidates produced contradictory evidence on a precise key has not earned a match on a weaker one. The alternative -- returning a contradicted record to candidacy -- would let an individual match on the weakest key in the set precisely because the strong keys disagreed about them, which inverts the cascade's whole ordering premise.

## Why the element path fans out too

`split_on` can be authored in two places: a data standardization step (a field-level fan-out) and a linkage key element's transform. The element path is easily mistaken for one that *collapses* a fan-out by joining the parts. It does not: `applyElementTransform` in `packages/core/src/standardization.ts` refuses a multi-candidate result outright, and its own comment says why joining would be wrong -- a joined string matches a value neither party's data holds, which is not the several-independent-candidates behavior the terms declare. So there is no collapsing behavior to preserve, and the decision is simply whether the element path fans out when the feature lands or stays refused forever.

It fans out. The two surfaces already share one refusal, one recovery message, and one consent glossary line; an operator who writes `split_on` in an element transform means the same thing they mean in a standardization step. Keeping them different would mean two semantics, two width bounds, and a permanent asymmetry to explain in the reference. The key builder already assembles a cross-product over per-element candidate lists, so the element path's candidates enter at their element's position in that product, and the width cap applies to the assembled product either way.

The consent surface follows the same decision, and it carries both cases rather than one: an element declaring a fan-out earns a breadth marker where the strategy matches its candidates, since the element fans out and the marker must say so, and keeps the "not supported" marker where the exchange refuses the terms outright, since a run that does not happen has no breadth to name.

## The width bound: value, and what happens above it

The bound exists because the single-pass cap arithmetic rests on a premise fan-out breaks: that `keyCount * recordCount` upper-bounds a party's distinct-value count. With several values per cell that premise is false, and every derived frame and element bound loses its footing. So a per-(record, key) candidate cap is not hygiene here; it is what restores the derivation from authenticated state.

**Why 20.** The project already fixes 20 as the point at which one row's cross-product is wide enough to weaken the privacy of a dual-party-output exchange (the existing operator advisory warns there). Making the normative cap that same number means the bound and the advisory agree, rather than introducing a second unrelated figure that would need its own privacy rationale. 20 also covers the honest shapes -- a hyphenated name plus a compound field is sixteen candidates at four parts each -- and it is a normative constant in the same class as the single-pass cell budget: raising it costs rows linearly and needs no wire change.

**Why exceeding it drops the record from the round rather than failing the run.** The transforms are partner-authored while the values expanded are this party's own rows. A refusal would therefore hand a partner a way to end an exchange by authoring a delimiter that shatters one local value -- a fragile, remotely-triggerable failure on an unattended scheduled run. Dropping the record for that key is the treatment an absent (`NULL`) realization already gets: the record sits the key out, stays eligible for later keys, and the operator is warned. It also makes the bound hold *by construction* on every input, which is what the cap arithmetic needs; a bound enforced by an abort is only sound if the abort always precedes the frame it protects.

Truncating the candidate set to the first 20 was rejected outright. Which candidates survived would then decide which matches happen, on an ordering no operator authored and no consent surface describes.

The separate resource refusal on the assembled key-string count (1024 per row) stays where it is. It bounds the allocation of one row's cross-product, sits above this candidacy cap, and after this change binds only the other candidate producer.

## Why the width rides an advertised integer

The cap alone does not restore the arithmetic, because a bound of "at most 20 per cell" applied unconditionally would cut every exchange's admissible dataset by twenty, fan-out or not. The bound has to be conditional on whether a party actually declares a fan-out -- and that is where the local standardization gets in the way. Element-transform fan-outs ride the agreed terms, so both parties see them; field-level fan-outs live in a per-party standardization the partner never sees. There is nothing in the agreed terms from which a receiver can derive the sender's field-level fan-out.

So each party advertises one integer, its effective key count, on the terms-exchange envelope beside the record count it already carries there. Three properties made that acceptable:

- **It is an existing frame.** Constraint 2 permits extending one; the envelope already carries per-party, per-run metadata of exactly this kind.
- **It is a declared value, not an observed one.** The integer follows from the party's configuration, not from how widely its data actually splits, so it discloses "I declare a fan-out on some keys" rather than a data fact. An observed maximum would leak the shape of the data, in the same family as the distinct-value count the protocol deliberately never exchanges.
- **It is checkable.** Its range, its divisibility, and its floor against the fan-out the agreed terms already imply are all verifiable by the partner, and a violation is a protocol abort like any other bad partner count. Under-advertising is self-harming: the party's own frame is then rejected by the cap it advertised.

A fan-out-free exchange advertises its plain key count, so every derived bound is numerically what it is today. That was a hard requirement: this work must not move a single number for the exchanges that do not use it.

**A derivation that tightens.** Bounding the advertised value at a multiple of the key count keeps the single-pass gate's product exact in a double, but leaves materially less headroom than the raw key count does. The invariant that pins that headroom is therefore pinned against the effective key count rather than the raw key count, and it is a live constraint on any future raise of either the candidate cap or the maximum linkage-entry count. The arithmetic and its figures are the spec's, under **The exact-integer premise tightens** in [the width bound](../spec/PROTOCOL.md#the-width-bound-a-per-record-key-candidate-cap).

## Why the width stays a notice, not a consented term

A related question left open by the advertised-integer design above is whether the width itself should be promoted further: not merely disclosed at the run boundary, but carried in `linkage_terms`, refused by both parties symmetrically on a mismatch before anything runs, and stated on both consent surfaces. The three-panelist design panel that converged 3-0 on PR #969's notice mechanism routed that question to the maintainer rather than deciding it themselves; PR #969 shipped the run-boundary notice as the interim mechanism while the question was open. The maintainer decided against consent, for three reasons.

`split_on` field-level fan-out is a party-local data-standardization decision -- per-party, record-dependent, and carried by no invitation, the asymmetry already noted above. The partner cannot derive its width from the agreed terms, so a consented width for it would be a declared CAP one party states about its own local standardization, not a FACT the terms already fix the way the element-transform width is. Agreeing on a cap adds a field and a symmetric refusal without removing the underlying asymmetry: the partner still has nothing to check the declared cap against but the declaring party's own say-so, which is exactly what today's advertise-and-notice path already delivers, without the new field.

Element-transform fan-out, by contrast, already rides the agreed terms. `effectiveKeyCount` is `sum(w[j])` over the agreed keys, with `w[j]` set by whether either party's standardization OR the agreed element transforms declare a fan-out on key `j` ([the width bound](../spec/PROTOCOL.md#the-width-bound-a-per-record-key-candidate-cap)). The element-transform-only floor -- `declaredEffectiveKeyCount` with no local standardization supplied -- is exactly the value both parties can already compute from the terms they hold, before either advertises a width. That class is consented by construction and needs no new terms field to become visible.

Finally, the authenticated ceiling gates already bind width symmetrically over each party's own authenticated `{effectiveKeyCount, recordCount}` pair (`slots = effectiveKeyCount * recordCount`, same section), and the run-boundary notice discloses precisely the gap those gates admit but the terms alone do not show: a partner running wider than the agreed terms imply. Promoting width into `linkage_terms` would widen a `PROTOCOL_VERSION`-covered surface for no ambiguity the specification above does not already remove -- the gates already bound it, and the notice already names it.

The notice therefore stays the disclosure mechanism. No new terms field, no new symmetric refusal, and no consent-surface change follow from this decision; `partnerWidthAboveAgreedNotice` (`packages/core/src/protocolSetup.ts`) needs no follow-on work here.

## Why the ragged layout is chosen per sender, not per key

The index table could carry the count prefix only on the keys that actually fan out, keeping the other keys' cells at four bytes. It is not specified that way. A per-key layout means the receiver has to know WHICH of the sender's keys are ragged, which means advertising a per-key vector rather than one integer -- more wire content, more validation surface, and a frame whose layout varies within itself. Choosing the layout once per sender, from a value both parties already hold, keeps one decode path and one bit of state; the cost is a four-byte prefix on cells that did not need one, which stays a minority of a frame dominated by encrypted values.

## What stays open

- **Cascade fan-out**, via extended per-round frames. It is the door this design deliberately leaves open rather than closes, and it inherits the resolution rule rather than choosing one.
- **The other candidate producer.** `generate_fuzzy_comparisons` produces per-record candidate sets by the same mechanism and is expected to reuse this candidacy, resolution, and width machinery. Its own bound and its interaction with the 1024-key-string cap are that work's to reconcile.
- **Deduplicating cardinalities.** The rules here specify the one-to-one case. A many-to-X resolution defines itself through the same cardinality seam, and the sweep's "at most one pair per record" step is the part it replaces.
