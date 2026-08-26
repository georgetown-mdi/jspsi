---
title: "Bounding the Value a Transform Produces"
---

# Bounding the value a transform produces: a local ceiling, and a refusal

_Status: decided and built, by a 3-panelist design panel. The control, its enforcement points, its constants, and the limits it does not close are specified in [CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md) (Unbounded transform-parameter rejection); this note records why the mechanism is the one it is. See [docs/notes/README.md](README.md)._

The linkage terms a partner authors carry element transforms that this party runs over its own rows. The bounds on those terms cap what the partner may WRITE -- a param's content length, a `pad_left` length, a date format's length -- and a bound of that shape says nothing about what a row DERIVES from it: a `replace_regex` replacement is a substitution template whose match-context sequences re-insert the local cell at every match position, and steps compose, each fed the previous one's output. The spec carries the measurements. This note records the two questions the choice turned on and how they were settled.

## Which closer

Two were available.

- **Neutralize the amplifying `$`-sequences** in a partner-supplied replacement, so `$'` and `` $` `` no longer re-insert the match's context.
- **Bound the produced value** with a fixed ceiling, refusing an exchange that crosses it.

The second was adopted. The first changes what a `replacement` MEANS between the two parties: it is a wire-semantics delta, pulling in `PROTOCOL_VERSION` and the cross-implementation transform vectors, and it makes a legitimate (if unusual) authoring silently derive something else. The ceiling changes no wire semantics at all -- an in-range value is preserved verbatim, every sequence keeps its meaning -- and it is unilateral, which matters for a control whose whole purpose is that this party does not have to trust the terms it agreed to. It also generalizes: neutralizing one pair of sequences bounds one amplifier, where a ceiling on the output bounds every amplifier, including one a later standardizing function introduces.

The same reasoning that made the param content bound uniform across every string param -- a per-amplifier bound is dodged by routing content through a param no measurement covered -- is why the ceiling sits on the OUTPUT rather than on the replacement.

## Where it sits, and what happens when it fires

One invariant, three enforcement points, all on the partner-authored path: inside the element transform (the value the element reads, and every step's output), on the row's projected assembled key-string length, and on the candidates as they accumulate toward that same total. Checking the element's incoming value is what bounds an element that declares no transform at all; checking every step's output is what keeps every step's input bounded, so composition cannot compound past the ceiling. The projection limb is the one that bounds the fuzzy expansion's replicated bytes, which is why no fuzzy-specific byte cap sits beside it.

A projection is reachable only once every candidate exists, so on its own it bounds the key strings a row assembles and not the set they are assembled from. A step that runs over an expanded candidate set allocates one output per candidate before any check reads the set, which is the whole per-row total over again with no factor bounding it. Charging each candidate to a running total as it lands puts the same invariant where the allocation happens; what is left live is the total the assembled key strings carry plus the single candidate in flight when it crosses.

Two properties of that total are what keep it a bound on the row's live bytes rather than a second, tighter cap on the work reaching it. It charges what the candidate set RETAINS, because a duplicate the set collapses is carried into no key string: a transform that maps every value of a multi-value cell onto one string is a legitimate authoring, and charging it per realized value would end an exchange over a row whose assembled key is a couple of thousand characters. And it is ONE total for the row rather than one per element, because the elements' candidate sets are all live together when the cross-product is projected; a total restarted at each element bounds the row at the cap times the element count instead, which is the same unbounded-until-assembly shape the projection has. The spec carries both measurements.

The fate on exceedance is a refusal, not a clamp and not a dropped row. Both parties must derive byte-identical keys, so a value shortened to fit would match nothing and would surface as a mismatch against the canonically hashed agreement -- the same reason every transform-parameter control refuses rather than trims. The one exception is coherence rather than principle: at the seam where a declared fan-out producer's width already drops the row, the byte limb takes that same fate, so a row cannot take two different fates depending on which limb of one projection fired. The seam is the assembled limbs' alone -- the accumulating bound fires with the row's later elements still unrun, so the provenance that would choose the drop is not yet known, and partial knowledge resolves fail-closed.

## The costs accepted

- **The ceiling fires on the operator's own data**, which the parameter controls never do. An honest long free-text cell ends the exchange, so the refusal has to be a good message: it names the element, the step position, the row, and the remedy, and it names none of the value.
- **A partner can still abort a run deterministically** by tuning an amplifier to cross the ceiling, and learns one coarse bit about the local data's magnitude per consented exchange from whether it does. That trade was taken deliberately: an abort is visible and attributable to whoever authored the step, where a narrowed linkage -- a row quietly dropped, a value quietly clamped -- is neither.
- **A single candidate's amplification is still allocated once** before the output check refuses it. What bounds that transient is the ceiling on the step's input; the spec carries the measurement and the point where the engine's own string limit takes over. What bounds the row is the accumulating total beside it, so the transient is one candidate's rather than one per candidate the row realized.

## Considered and left alone

- **A tighter ceiling.** The constant is generous by design -- far above any legitimate key element -- because the cost of binding an honest exchange is paid by the operator, and the aggregate a partner can still drive is a bounded constant factor rather than an unbounded one.
- **Bounding the operator's own standardization pipeline.** Its config and its data both belong to the operator; nothing partner-influenced sizes it, so it stays out of scope.
