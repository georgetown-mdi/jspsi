---
title: "When a Disclosure Record Becomes Owed"
---

# When a disclosure record becomes owed: the durability point, and what a terminated run's record says

_Status: resolved - built. The rule is normatively specified in [EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#when-a-record-is-owed) and [PROTOCOL.md](../spec/PROTOCOL.md#self-attested-record); this note records the options weighed and why the built one was chosen. See [docs/notes/README.md](README.md)._

An exchange ends with the payload exchange, after which both parties hold the result, and then a short tail: the received-payload check that holds the partner's transmitted columns to what this party consented to receive, and the signed-receipt swap that collects evidence about the exchange that just happened. A record of what this party disclosed was built after that tail and returned at the end, so anything in the tail that terminated the run discarded a complete record of a disclosure that had provably occurred. The failure case in which an operator most needs a disclosure-log entry was the one that produced none.

The mechanism was never in dispute. The question this note records is the semantic one: at what point the record becomes owed, and what a record means when the run it describes did not finish.

## The durability point

Four points were available.

**When the run returns.** The behavior as it stood. It is defensible only if the record is read as "a receipt for a completed exchange", and it is not: the record is an accounting-of-disclosures artifact, and an accounting is over disclosures, not over runs that went well. It also makes the artifact's existence turn on a step that has nothing to do with the disclosure -- a partner's certificate, a pin the operator typed, a connection that held for one more frame.

**When the payload exchange completes.** The point at which both payloads have moved: keys exchanged and matched, payload columns sent and received, and nothing afterwards able to undo any of it. It leaves the asymmetric window the next point closes, since the initiator sends before it receives.

**When this party's own payload crosses.** Taken. It is the first point at which the fact the record attests -- that this party disclosed its payload to the partner -- is true, so it is the point under which the artifact's existence tracks that fact most closely. It is a boundary rather than a step, and the region it opens is held by a single enclosing guard around everything that follows the send, so a step joins the rule by being in the region rather than by joining a window of its own.

**Earlier, at some point inside the matching.** Rejected. A partial disclosure has no accurate record: the record commits to the payloads in both directions and to the pairing, and a run cut off mid-cascade has no fixed value for any of them. Recording that would need a different artifact attesting a different thing, not an earlier build of this one.

## What the send point costs, and what it does not

The rejection above sets the bar the send point had to clear: every value the record commits to must be fixed by the time the region opens. At the send they are. The pairing and this party's own payload are built before the frame goes out, and the third -- the partner's payload -- has a fixed value on a run cut there, namely nothing received, which the record commits to as an empty payload. That commitment is true of what this party received and does not distinguish a cut before the reply from a partner that transmitted no payload; the specification states that limit ([EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#when-a-record-is-owed)), and the distinction stays available to the caller conducting the run, which is where a partial-disclosure notice is composed.

Distinguishing it in the document instead was weighed and not taken. It needs a second `outcome` value, an omittable received-payload commitment, or both, and every one of those is a format-version move and an at-rest invalidation -- the same price the note weighs for a second value under "One outcome value for the whole region" -- bought for a reader who, on this record, already knows the run terminated and already cannot tell which step ended it.

The structural cost the point does carry is the one this note weighed before it was taken: the payload-exchange step has to report its partial progress, since a caller that only sees the partner's payload or a throw cannot tell whether its own payload crossed. The step reports it as it happens, so the record-owed region opens on the send itself rather than on anything inferred afterwards.

## The residual window it leaves

A send the transport rejects discloses nothing the record would commit to, so the region does not open on it and no record is owed -- what the operator gets there is the run's own error and its entry on the machine-readable event stream, as for every failure before the send. The linkage-key material an earlier cut discloses is likewise outside what this artifact attests.

## What a terminated run's record must not be

A record of a terminated run readable as a completed run's would be worse than no record at all -- it would put a disclosure in the log under a claim its writer never made. Three shapes were weighed for the distinction.

**A distinguished filename.** Cheapest, and rejected. The record is designed to stand on its own when it is handed to an auditor or copied into an agency's own system, and a filename does not stay with a document.

**The absent run binder.** A terminated run could simply omit the `receiptBinder`, since this party exchanged no receipt. Rejected on two counts. It does not distinguish: a record with no binder is also exactly what a completed run with no signing identity writes, which is most runs. And it is not true -- by the swap's wire ordering the partner may hold a completed receipt bearing this run's binder, and a record that dropped the value would leave that genuine receipt displaying as unpaired against it.

**A stated outcome on the record.** Built. Every record states an `outcome`, and a terminated one keeps its binder beside it, so the two fields say different things: the binder says which run a receipt would belong to, and the outcome says whether this party got one.

Stating it on every record, rather than marking only the terminated case, follows the format's own rule for a required fact -- a count-only run commits its empty payloads explicitly rather than by omission, for the same reason. It costs a format-version move, which the field set would have required either way.

## One outcome value for the whole region

The durability point being a boundary leaves a second question: whether each way the tail can end gets its own outcome value. It does not. `receipt-swap-terminated` is written for every termination past this party's payload send -- a reply that never arrives or arrives malformed, and the received-payload refusal, as much as a pin refusal or a transport drop in the swap -- and the value is named for the step those failures most often come from rather than for the only one it covers.

Two alternatives were weighed. **A second value naming the reconciliation** distinguishes the causes at the price of widening the accepted value set, which the record's format version moves with: a reader rejects an unrecognized `outcome` rather than migrating it, so every added value is a format decision and an at-rest invalidation, not a labelling one. **A cause field beside the outcome** avoids the value set but puts free-form failure attribution into an artifact whose whole discipline is that it states only what its writer can attest about its own disclosure.

Neither is bought by the question the field exists to answer. An accounting of disclosures asks whether a disclosure occurred and whether this party came away with a receipt for it, and one value answers that for the whole region. Which failure produced the termination is a run-diagnosis question, and the run log and the machine-readable event stream are where it is answered -- they hold the error and its kind, which the record does not.

The residual is stated rather than closed: the value's name is narrower than its meaning, so a reader who takes the literal at face value would infer a step the run may not have reached. The specification states the coverage and the limit at the point the value is defined; renaming it would be the same format move the extra value costs, for a smaller gain.

## What it does not change

The receipt's all-or-nothing rule is untouched: a terminated swap still writes no partial or unverifiable dual-signed record, and the record is not one -- it is the separate unsigned artifact, and it attests only what this party itself disclosed. The run still fails, with its own exit code; keeping the record is not a rescue of the exchange. And the record's own build stays non-fatal, so a run whose record cannot be built reports that and loses nothing else.
