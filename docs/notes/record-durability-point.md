---
title: "When a Disclosure Record Becomes Owed"
---

# When a disclosure record becomes owed: the durability point, and what a terminated run's record says

_Status: resolved - built. The rule is normatively specified in [EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#when-a-record-is-owed) and [PROTOCOL.md](../spec/PROTOCOL.md#self-attested-record); this note records the options weighed and why the built one was chosen. See [docs/notes/README.md](README.md)._

An exchange ends in two steps that are easy to conflate: the payload exchange, after which both parties hold the result, and the signed-receipt swap, which collects evidence about the exchange that just happened. A record of what this party disclosed was built between them and returned at the end, so a swap that terminated the run discarded a complete record of a disclosure that had provably occurred. The failure case in which an operator most needs a disclosure-log entry was the one that produced none.

The mechanism was never in dispute. The question this note records is the semantic one: at what point the record becomes owed, and what a record means when the run it describes did not finish.

## The durability point

Three points were available.

**When the run returns.** The behavior as it stood. It is defensible only if the record is read as "a receipt for a completed exchange", and it is not: the record is an accounting-of-disclosures artifact, and an accounting is over disclosures, not over runs that went well. It also makes the artifact's existence turn on a step that has nothing to do with the disclosure -- a partner's certificate, a pin the operator typed, a connection that held for one more frame.

**When the payload exchange completes.** The point at which the disclosure the record attests has provably happened: keys exchanged and matched, payload columns sent and received, and nothing afterwards able to undo any of it. The protocol already says as much about the swap -- "aborting does not undo the data exchange" -- and the record is precisely the artifact that says the data was exchanged.

**Earlier, at some point inside the matching.** Rejected. A partial disclosure has no honest record: the record commits to the payloads in both directions and to the pairing, and a run cut off mid-cascade has no settled value for any of them. There is a genuine residual here, stated rather than closed: a run that dies before the payload exchange finishes discloses linkage-key material and records nothing. Recording that would need a different artifact attesting a different thing, not an earlier build of this one.

The second was taken. It is the only one of the three under which the artifact's existence tracks the fact it attests.

## What a terminated run's record must not be

A record of a terminated run readable as a completed run's would be worse than no record at all -- it would put a disclosure in the log under a claim its writer never made. Three shapes were weighed for the distinction.

**A distinguished filename.** Cheapest, and rejected. The record is designed to stand on its own when it is handed to an auditor or copied into an agency's own system, and a filename does not travel with a document.

**The absent run binder.** A terminated run could simply omit the `receiptBinder`, since this party exchanged no receipt. Rejected on two counts. It does not distinguish: a record with no binder is also exactly what a completed run with no signing identity writes, which is most runs. And it is not true -- by the swap's wire ordering the partner may hold a completed receipt bearing this run's binder, and a record that dropped the value would leave that genuine receipt reading as unpaired against it.

**A stated outcome on the record.** Built. Every record carries an `outcome`, and a terminated one keeps its binder beside it, so the two fields say different things: the binder says which run a receipt would belong to, and the outcome says whether this party got one.

Stating it on every record, rather than marking only the terminated case, follows the format's own rule for a load-bearing fact -- a count-only run commits its empty payloads explicitly rather than by omission, for the same reason. It costs a format-version move, which the field set would have required either way.

## What it does not change

The receipt's all-or-nothing rule is untouched: a terminated swap still writes no partial or unverifiable dual-signed record, and the record is not one -- it is the separate unsigned artifact, and it attests only what this party itself disclosed. The run still fails, with its own exit code; keeping the record is not a rescue of the exchange. And the record's own build stays non-fatal, so a run whose record cannot be built reports that and loses nothing else.
