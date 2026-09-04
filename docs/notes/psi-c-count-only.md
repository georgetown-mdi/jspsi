---
title: "Count-Only Linkage (PSI-C): Construction, Narrowing, and Reporting"
---

# Count-only linkage: why psi-c is one key, one round, and library-native

*Status: decided and built. The construction described here is normatively specified in [PROTOCOL.md](../spec/PROTOCOL.md#psi-c) and its record rows in [EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#count-only-psi-c-records); core conducts the run and both authoring surfaces offer the algorithm. This note records why the construction has that shape, what it replaced, and the alternative that was weighed and not adopted. See [docs/notes/README.md](README.md).*

This is design rationale. Nothing here binds an implementation; the normative rows live in the two spec documents linked above, and this note does not restate them.

## What psi-c is for

Two agencies deciding whether to build a linkage want one number before they negotiate: how many people do we both have? A count-only exchange answers that and nothing else. It is a **pre-agreement** instrument, and that is the fact from which most of the decisions below follow. The exchange that establishes the business case runs before the data-sharing agreement exists -- so it runs at the point where the honest-but-curious assumption the rest of the system leans on is least supported, and where a disclosure is least recoverable if it turns out to have been more than the parties intended.

That framing rules out one tempting instinct: treating psi-c as "psi, but with less output". A count-only exchange is not a linkage whose result was withheld. It is a different disclosure, run under different conditions, and it is specified as its own narrow thing rather than as a mode of the general algorithm.

## The sketch that was removed

The earlier design sketch described psi-c as the ordinary cascade with a shuffle: the sender permutes the receiver's doubly-encrypted values before returning them, the receiver counts matches without being able to name them, and rounds over several keys combine because the sender applies a **round-consistent** permutation each time -- the same value occupies the same permuted slot every round, so a match found in round two can be excluded from round three.

That round-consistency is the whole mechanism, and it is also the defect. A permutation that is stable across rounds is a stable per-record pseudonym. The receiver sees slot indices that mean the same thing from one round to the next, and the receiver chooses its own inputs. So it can invert the pseudonym one value at a time: run a round whose live content is a single candidate padded with values the sender cannot hold, observe which slot lights up, and that slot is now bound to a known plaintext for every later round. The count has been converted into membership, one record per round, with nothing on the wire distinguishing the probe from a legitimate input.

The two properties are not separable -- the cross-round dedupe capability and the de-anonymization vector are the same mechanism. There is no version of the sketch that keeps the multi-key combination and drops the vector, because the combination is exactly what requires the pseudonym to be stable. So the sketch was removed rather than repaired, and multi-key count-only is left unspecified rather than specified with a caveat.

The sketch's shuffle was never as critical as it appeared to be. [one-sided-disclosure.md](one-sided-disclosure.md) already works through why shuffling a party's own data in front of that same party hides nothing from it: the matching encryption is deterministic by necessity, so a party can always re-encrypt and recognize its own values however the pile is reordered. The shuffle in the sketch was aimed at the other direction -- hiding the sender's records from the receiver -- but it inherits the same problem the moment the receiver, not the sender, is the one choosing what goes into the round.

## Why the library-native cardinality mode instead

The vendored PSI library already has a count-only mode: both parties construct their base-function objects with the reveal-intersection flag cleared, and the receiver asks for the intersection **size** rather than the intersection. Choosing that over anything hand-built rests on three properties, each confirmed by driving the real library rather than by reading it:

1. **It is exact.** Over a `Raw` setup the reported size equals the true overlap. (The library also offers probabilistic setup structures, which do not; [PROTOCOL.md](../spec/PROTOCOL.md#psi-c) pins `Raw` for psi-c and says why the inexactness matters more here than under `psi`.)
2. **The mode is on the wire, not in a local convention.** The flag rides the request, and a server and client constructed with different flags cannot complete a round at all. So a count-only party cannot be drawn into a revealing round by a partner that quietly set its own flag, and the failure is a refusal rather than a silent resolution to either mode.
3. **The identifier-revealing operations become unavailable.** With the flag cleared, the client calls that return matched positions or an association table throw. A count-only receiver's own software cannot produce a pairing even if a later code path asks for one -- the property is held by the library rather than by a discipline psilink has to keep.

All three hold identically on the WebAssembly build and on the native N-API addon, so the property does not depend on which backend a party happens to run. What differs is only diagnostic quality: the native addon names the condition, while the WebAssembly binding reports the same refusals as an opaque marshalling error, so a run path has to translate the throw into an actionable abort rather than passing the message through.

Point 2 is the one that decided it. A construction whose count-only property is enforced by the wire is worth more than one whose property rests on both parties choosing to run the correct code, particularly for an exchange whose whole purpose is to run before there is a signed agreement to lean on. Nothing psilink could compose on top of the general PSI round would have that property without re-deriving it.

One property of the library's operation is a trap rather than a gift: the size it reports is that of the MULTISET intersection, so a value repeated on both sides contributes the smaller of the two multiplicities. The cascade's own rule drops a within-dataset duplicate from the round entirely, which is the stricter behavior and the one that makes a count comparable to a real linkage -- so the spec makes applying that filter a requirement rather than leaving it as a habit inherited from the cascade code.

The cost of the choice is the narrowing in the next section. It was judged the right trade: an exact, wire-enforced count over one key is a better instrument for the pre-agreement question than a multi-key count that comes with a de-anonymization vector, and the pre-agreement question rarely needs more than one key to answer.

## The single-key narrowing

psi-c is one round over one key, cascade only. Multi-key count-only, single-pass count-only, deduplicating count-only, and payload in either direction are all refused rather than narrowed to the specified shape.

The refusals are fail-closed at three points -- authoring or invitation mint, local prepare, and the agreed-terms run boundary -- for one reason: every softer option is worse. Silently narrowing an over-broad psi-c term to its first key would deliver a different count than the operator agreed to, under a record that says the operator's terms were honored. Deriving the wider result and then discarding the excess would mean the receiver's process held the identifiers the algorithm exists to withhold. Downgrading to a `psi` run would reveal matched identifiers under terms that asked for a count, which is the exact substitution the whole algorithm is a defense against.

This is a real narrowing of psi-c's charter relative to the removed sketch, which described a multi-key count. What that forecloses is exact: a count over several linkage keys is something an operator might want, and psi-c will not provide it. If it is ever built it has to arrive either as an accurately labelled derived-output mode of `psi` -- where the receiver holds the identifiers and reports only a count, a weaker property that the record and the consent surfaces would have to state as such -- or as a new construction with its own analysis. It cannot arrive as `psi-c` without reintroducing the vector above, because `psi-c` now names a specific wire-enforced property.

## Count reporting: who learns the number

The receiver computes the count; the sender learns nothing about it from the round. Whether the number travels back is decided by the agreed output entitlement, and the specified rule is a single count-report frame from receiver to sender in the both-entitled case and no frame at all otherwise ([PROTOCOL.md](../spec/PROTOCOL.md#psi-c) has the normative rule).

The consequence to state plainly is that the sender's copy of the count is the receiver's word. psilink does not stop a receiver that reports a different number. That is the same posture as the association-table return leg under `psi`, where the sender's half of the pairing likewise arrives as the receiver's report, so this is not a new class of trust -- but it is stated rather than left for a reader to assume a mutually-computed figure.

**Where that is stated, and to whom.** The consent tier states it to both seats at accept time, because acceptance cannot tell either party which seat it will take -- the role follows from record counts neither side has exchanged yet. The completion surfaces can: by then the seat is resolved, so the sender's number shows the caveat again where it is read, and the receiver's does not. Repeating it for a receiver would be worse than redundant -- it would be false, since a receiver's count comes from a round the wire enforces to be count-only, not from a partner. That asymmetry is the reason the caveat lives at the seat rather than beside every count: a warning that fires on the enforced case teaches an operator to discount it on the trust-contingent one.

"Where it is read" is more than one place. A completed exchange states the count twice: once in the result surface, which shows the full caveat, and once in the disclosure ledger's receive row, which is the condensed record of what the exchange did and the part an operator is most likely to skim or screenshot. A ledger that repeated the figure without saying who produced it would put the number in front of the reader stripped of the fact that qualifies it, and the shorter copy would be the more durable one. So the receive row closes with its own row-sized provenance clause on a partner-reported count -- what produced the number -- while the result surface keeps the sentence explaining what that means. The two are one vocabulary at two lengths rather than two wordings of the caveat, and the receiver's row, like the receiver's result surface, shows neither.

**The alternative weighed, and not adopted.** When both parties are entitled to output, the exchange could run **role-swapped double rounds**: each party takes the receiver role once, each computes its own count from its own round, and the two values are exchanged only to be compared, with a divergence aborting the exchange. Neither party would then hold a number it took on the other's word, and a receiver that lied would be caught by the comparison rather than believed.

It was not adopted, for two reasons. It doubles the elliptic-curve work of the exchange -- the expensive part -- to remove a trust dependency the system already accepts in the same shape elsewhere; and the abort-on-divergence it buys is not the guarantee it first appears to be, since a party willing to misreport a count is equally able to contribute a different input set to its own round, which the comparison cannot detect. The dissent is recorded here rather than discarded: it is a coherent design, and if psi-c ever needs a checkable count -- for a setting where the number itself carries contractual weight -- this is where to start, not from scratch.

## Why the threat-model scope is stated plainly

The count-only property protects the sender against a receiver that contributes a genuine dataset. It does not protect the sender against a receiver that chooses its input set: one live candidate padded with values the sender cannot hold turns a count of 0 or 1 into a membership answer, and two runs differing in one value do the same by subtraction. Both sit a step beyond honest-but-curious, both are accepted rather than prevented, and [PROTOCOL.md](../spec/PROTOCOL.md#threat-model-scope-of-the-count-only-claim) says so in the specification rather than in a footnote.

Stating it there is by design. A count-only exchange reads, to a non-specialist, like the safe option -- and it is offered specifically to program officers weighing whether to share data at all, who are the readers least equipped to supply the missing caveat themselves. An algorithm whose selling point is "you learn only a number" has to state, in the same place, what a partner can do with the freedom to decide which numbers to ask for. The accurate framing is that psi-c bounds what the protocol hands over, not what a determined partner can arrange to be handed.

## See also

- [PROTOCOL.md](../spec/PROTOCOL.md#psi-c) - the normative construction, refusals, wire shape, and threat-model scope
- [EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#count-only-psi-c-records) - the count-only record rows and what the signed receipt attests
- [one-sided-disclosure.md](one-sided-disclosure.md) - why a shuffle does not hide a party's own data from that party, and the one-sided disclosure tradeoffs psi shares
- [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#threat-model) - the honest-but-curious model the scope above is stated against
