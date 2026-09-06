---
title: "One-Sided Fuzzy Expansion"
---

# One-sided fuzzy expansion: which party enumerates the variants

_Status: decided and built, behind the `APPLIED_SETTINGS.fuzzyComparisons` flag the expansion itself sits behind. The normative rows -- the classification, the expanding party, the ceilings, and the refusals -- are in [PROTOCOL.md](../spec/PROTOCOL.md#which-party-expands-full-variant-and-deletion-neighbourhood-expansions); this note records the model behind them and what was set aside. See [docs/notes/README.md](README.md)._

Fuzzy linkage keys were described in one breath -- "generate the variants of the value and intersect the widened sets" -- as though transposing two digits of an SSN and comparing single-character edits were one mechanism. They are two, and the difference decides how many parties execute the expansion. Getting it wrong is not a crash: it is a run that quietly costs twice the work, or one that quietly matches fewer records than the agreed terms describe.

## The two shapes

A **full-variant** expansion enumerates the entire set of values at a stated distance from the record's own: every two-position transposition, the year either side of a date, the day and month of a date exchanged, the two orders of a swapped element pair. Because the set is complete, a partner holding any value in it meets this record on the partner's own exact value. One party enumerating is sufficient.

A **deletion neighbourhood** enumerates the single-character deletions of the value. That is not the set of values one edit away -- it is the shorter half of it. A substitution or an insertion between two records is reached only where the two parties' deletions land on the same shorter string, so both parties must expand. The full variant set for edit distance 1 is not an alternative at any width: it is the alphabet times the length, over an alphabet the terms do not bound.

## Why one party, and not both, for a full variant

Symmetry is the intuitive reading and it is wrong on three counts.

**It buys no match.** A shared candidate needs one variant from one side, not one from each. If `b` is a transposition of `a`, then `a`'s variant set already contains `b`, which is the value `b`'s own party contributes unexpanded.

**It doubles the cost.** Each party's variant set is its own work, its own value slots against the single-pass dataset ceiling, and its own share of the frame.

**It widens what matches.** Every additional candidate is a string that can collide with a THIRD record. Two records that are each a transposition away from a common variant are two transpositions apart -- a distance the terms did not declare, and one an operator reading "matches a transposed digit" would not expect to have consented to. The symmetric reading inflates false positives in exactly the way the precision requirement on linkage keys exists to prevent.

None of this applies to the deletion neighbourhood, where the second party's expansion is what makes the first party's reach anything at all.

## Which party, and why that does not have to be agreed

The expanding party is the resolved PSI receiver -- the role both parties already determine from the record counts they exchanged, with no new negotiation, no term, and no wire byte. The `swap` directive has been keyed on that same role since it was specified, so this extends a precedent rather than setting one.

It is NOT an agreed term, by design. A term naming the expanding party would have to be authored, consented to, hashed into the agreed terms, and kept consistent with a role the two parties resolve per run from data neither authored -- and it would buy nothing, because the classification is a function of the kind alone and both parties compute it identically from terms they already hold.

## Why the role may flip between runs, and why that is harmless

Role resolution reads the exchanged record counts, so a recurring exchange whose datasets grow at different rates can resolve the opposite roles on two consecutive runs. The intersection does not move, because each full-variant relation is an **involution**: `b` is a transposition of `a` exactly when `a` is a transposition of `b`; a one-year shift and the two orders of a swapped pair are the same. A day/month exchange is one over the calendar dates and only there: the generator emits nothing for an input that is not a real date, so both readings of every pair it produces are dates and each maps back to the other. So `a`'s variants contain `b` exactly when `b`'s variants contain `a`, and the pair meets whichever party expanded.

That is why nothing here holds the role steady across runs. Pinning it would need a term, a negotiation, or a stored decision, all to preserve a property the arithmetic already gives.

## The swap is a full variant

A key's `swap` names two elements whose values may have been entered the wrong way round at one agency. Exchanging them on the receiver alone matches the reversed record and LOSES the record that agrees -- the arrangement most of the data is in. The fix is the same shape as the transposition one: the receiver assembles both orders, the sender assembles the authored one, and the pair meets in either arrangement. Two orders are the whole set the pair admits, so the involution and the one-sidedness hold unchanged, and the consent surface's claim that a swap matches the two elements in either order becomes true rather than aspirational.

It is delivered at the key-read layer rather than as a fuzzy kind because the expansion sees one element's value at a time and cannot reach a sibling's, and because a swap REPLACES a key's arrangement where a fuzzy kind widens one element.

## What the asymmetry costs, stated rather than closed

Both parties declare the RECEIVER-case width for every key, because the width is fixed by the agreed terms before either party holds the other's record count. A party that turns out to be the sender therefore declares slots it does not fill. The cost is permissiveness and frame size -- an exchange can be refused at a party's own single-pass ceiling that would in fact have fit -- and never a wrong match. Sizing the declaration to the resolved role instead would make the width depend on data the terms do not include, which is the property the whole width derivation exists to avoid.

The all-pairs transposition enumeration is quadratic in the value's width, so declaring it means bounding that width with a transform. The refusals that enforce that, and the arithmetic of stacking two of them in one key, are normative and live in the spec.
