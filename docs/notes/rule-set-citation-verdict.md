---
title: "A False Rule-Set Citation in the Acceptor's Record"
---

# A false rule-set citation in the acceptor's record: annotate, refuse, or drop

_Status: resolved - built. The mechanism is normatively specified in [EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#the-writing-partys-verdict); this note records the three directions weighed and why the built one was chosen. See [docs/notes/README.md](README.md)._

A linkage-terms document may cite the named rule set its fields and keys were drawn from. The citation moves with the terms: an accepting party adopts the inviter's terms, keeps the citation, and copies it into its own exchange record - the artifact an operator populates a HIPAA accounting of disclosures or a FERPA disclosure record from. So an invitation citing a set psilink ships, over rules psilink can prove are not that set, wrote an unqualified false provenance claim into the acceptor's own governance artifact.

The predicate that catches it already existed. `isDrawnFromLinkageRuleSet` decides whether a document's rules are drawn from a set - byte-exact on fields, cascade-order on keys - and the shipped set is one this build holds. What it did not do was run anywhere on the exchange path: it ran only in the web invite editors, deciding whether rules edited after being seeded from a set could still cite it.

## The three directions

**Refuse the terms.** Reject an invitation whose citation this build disproves, at the point the accepting party derives its terms. It never enters the record because the exchange never happens.

**Drop the citation.** Keep accepting, but strip the refuted citation from the derived terms, so the acceptor's record simply holds none.

**Annotate the citation.** Keep it verbatim in the terms and in the record, and record beside it what this party found when it checked.

## Why annotation

Refusal is evadable, over-broad, and brittle at once. A party wanting the citation's weight without its content only has to cite a version this build does not ship: a human still takes the name as provenance, and an unresolvable name is exactly the case refusal cannot reach. Meanwhile it hard-blocks the truthful-but-stale citation - a partner one version behind - and it blocks on build drift with no override, in a system where the true key list is on the same consent screen as the name. The project's own posture places a hard refusal on remote content an operator cannot inspect; here the operator can read the declared keys and fields directly, beside the name, which is the case the warn-and-guide posture is for.

Dropping is worse than either. Stripping the citation launders the partner's claim: the record then shows a party that cited nothing, when in fact it cited a set falsely, and the record can no longer tell an auditor which of the two happened. On a recurring exchange it also recreates the ambiguity every run, since the partner keeps sending the citation and the record keeps quietly discarding it.

Annotation keeps the claim and adds the finding. The record states what the declaring party asserted and what the writing party's own check made of it, which is what an accounting of disclosures is for.

## What the annotation had to be

Three properties fell out of the choice, and each is a normative row in the spec rather than a matter of taste.

**Three states, not two.** With a two-state flag, "not contradicted" would cover both "checked and matched" and "could not check" - so the absence of a warning would be taken as verification precisely where nothing was verified. `unchecked` is a distinct claim from `consistent`.

**Per half.** The field set and the key set are named and versioned independently, and a document can truthfully cite the shipped field set while its keys are not the shipped key set. A single verdict over both halves would either overstate the bad half or understate the good one.

**The writing party's own verdict, not a property of the terms.** The check runs against the sets the writing build ships, so two parties on different builds may write different verdicts for one run. That is a real asymmetry and the spec states it rather than leaving a reader to assume the two records agree the way the citation itself does. Nothing compares the verdicts, and none of this touches the terms hash: the verdict is written locally, after the agreement.

The consent surfaces follow the same shape - a marker and a caveat per half, warning where a citation is disproved and never refusing - so an acceptor reads the finding before consenting rather than discovering it in the record afterwards. The declared keys and fields remain what the exchange holds both parties to; nothing here changes which fields or keys a run uses, or what it discloses.
