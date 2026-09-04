---
title: "Binding a Signed Receipt to One Run"
---

# Binding a signed receipt to one run: which artifact holds the shared value

_Status: resolved - built. The mechanism is normatively specified in [EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#pairing-a-receipt-to-one-run) and [PROTOCOL.md](../spec/PROTOCOL.md#verifying-a-stored-dual-signed-record); this note records the two directions weighed and why the built one was chosen. See [docs/notes/README.md](README.md)._

An exchange produces two on-disk artifacts: the unsigned, self-attested exchange record each party writes for its own audit log, and - when a signing identity is configured - one dual-signed receipt both parties sign. Verifying the receipt established who signed it and under which agreed terms, but not which _run_ of a recurring partnership it belonged to: every value an offline verifier could check repeats byte for byte from one run to the next. One run's genuine receipt therefore displayed as "verified" beside another run's record.

Closing that needs one value derived from a single run present in both artifacts. Two directions were available, and the choice was not obvious enough to inherit.

## The two directions

**Fold a shared value into the signed receipt content.** The spec's own example was the record's per-exchange binding nonce. That nonce is generated locally by each party, so the two parties' records for one run hold _different_ nonces - while the receipt content is byte-identical across parties by construction and admits only facts both parties derive byte-identically. Folding in "the record's nonce" therefore means folding in _both_ nonces, exchanged during the receipt step, which:

- adds a wire exchange to the signing step and orders record minting strictly before it, where today the receipt is independent of the record build by design (a party whose local record build fails can still sign a receipt);
- moves the signed format: a new receipt `version` and a new content domain, because the signed bytes change;
- admits into the signed content a value each party _asserts_ rather than derives. The content's stated invariant is mutual derivability, and an asserted nonce weakens it: a party could sign one nonce and write another into its record. That only breaks its own pairing, but it is a real loosening of what a signature over the content means.

**Write the receipt's existing binder into the record.** The receipt content already includes a per-run `binder`: `HKDF-SHA-256` over the run's session key with the initiator-role label, which both parties derive identically with no extra messages. The record is built in the same place, with the session key already in hand. Writing that value into the record:

- changes only the unsigned record format, leaving the signed receipt's bytes, version, and content domain untouched - so every existing receipt and every cross-implementation signed-byte vector stays valid;
- adds no wire traffic and no ordering constraint beyond deriving the binder before the record is built;
- keeps the shared value one both parties _derive_, which is the property the receipt content was designed around.

## The decision

The second direction was built. It closes the same gap for a strictly smaller change: one optional field in the unsigned format against a signed-format revision plus a new wire exchange, and it holds the mutual-derivability property that the first direction would have had to bend. The privacy delta is nil in both cases and stated in the spec rather than left implied - the binder is a one-way output over a session key the receipt already publishes, so a record holding it discloses no more than the receipt beside it does. Its one new capability is the intended one: telling that a given record and a given receipt are the same run.

The record's field is present exactly when the run derived a binder, which is what lets its absence mean something rather than nothing: a record that omits it records an exchange that never got as far as a binder, so a receipt read beside it is contradicted rather than merely unpaired-with. Deriving one and holding a receipt are not the same event, since a run can derive the binder and then terminate in the swap, and the presence rule that follows from that is [EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#when-a-record-is-owed)'s to state. Both artifacts' readers therefore had to be able to tell "no record supplied" from "a record that holds none", which is why the verification input distinguishes the two rather than collapsing both to "absent".

## Mismatch is a refusal; a missing record is not

The second question was whether a pairing failure refuses the receipt or is reported as a weaker line beside a verdict that still passes. It is a refusal - a `failed` verdict, exit 1 on the CLI - because a mismatch is a positive contradiction: two artifacts that cannot be from one run. Reporting "verified" over a receipt that provably does not belong to the record beside it is the defect this work closes, and an advisory line would leave it open.

That does not put a holder of one artifact in the wrong. The check has a distinct third state for "no record supplied", which contradicts nothing: it holds the verdict at `incomplete` and never fails it, exactly as the agreed-terms hash already behaves when the verifier cannot supply it. The consequence is that a receipt verified alone does not reach `verified`: it reaches `incomplete`, with a line naming the exchange record as the remedy. That is the accurate reading rather than a regression: without the run's record, which run the receipt attests is open, and the module's standing rule is that a check which did not run is never reported as one that passed.

What the pairing does not reach: a party holding both artifacts could write a matching binder into a record of its own. The record is unsigned and self-attested, so its contents were never evidence against anyone, and the pairing claims only what it checks - that the receipt is the one this record names. A binder substituted into both artifacts at once stays detectable only during the live exchange, where each party derives the value independently.

## See also

- [EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md#pairing-a-receipt-to-one-run) - the normative outcomes, the record field, and the privacy reasoning
- [PROTOCOL.md](../spec/PROTOCOL.md#verifying-a-stored-dual-signed-record) - where the check sits among the verification's other checks
