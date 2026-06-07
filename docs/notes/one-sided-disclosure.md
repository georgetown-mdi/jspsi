---
title: "One-Sided Linkage Disclosure"
---

# One-sided linkage: what leaks, the alternatives, and why simple looks right for now

*Status: exploratory design note - no decision has been made. This exists to make the tradeoffs thinkable later, not to ratify a choice. See [docs/notes/README.md](README.md).*

When only one party is entitled to the result of a linkage, the other party still has to help compute it, and that help leaks a little about which of the helper's own records matched. This note maps what leaks, walks the realistic alternatives and what each of them leaks instead, and lays out why the current, deliberately simple approach looks like a defensible default for now.

It is design rationale. It does not change the protocol; it records the reasoning so the question does not have to be reworked from scratch the next time someone asks it. The discussion stays high level on purpose - the goal is to make the tradeoffs legible, not to pin down any one mechanism.

## The setup

Two roles matter. The **receiver** is the party that gets the result. The **sender** is the helper: it contributes its records so the receiver can find the matches, but it is not itself entitled to the answer.

A linkage runs as a sequence of rounds, one per linkage key, from the most precise key to the least. A key is a combined identifier - several pieces of personally identifying information concatenated together (name, date of birth, part of an SSN, and so on) - chosen to be precise enough that a match on it can be treated as definitive. When a record matches on a strong key it is set aside so it is not compared again on the weaker ones; the unmatched records "carry forward" to the next round. Setting matched records aside is an efficiency win, and it is also a privacy win *for the receiver*: it never sees that an already-matched record would also have matched on some weaker key.

Two facts hold throughout and are worth fixing in mind:

- The system assumes **honest-but-curious** partners operating under signed data-sharing agreements (the threat model the project adopts). They are not expected to tamper, but we still try to minimise what each side can learn.
- The size of each party's dataset is always revealed. So "the sender learns nothing" never means literally nothing - it means nothing about *which* records matched.

## What the protocol offers today

There are two ways to run a one-sided exchange, and they leak in opposite directions.

**The clean cascade.** The sender is told which of its records have already matched, so it can drop them from the later rounds. The receiver gets a clean, minimised result. The sender learns which of *its own* records matched and - because the rounds run in a publicly agreed precision order - roughly how strong each match was. It never learns which of the receiver's records they matched to.

It is worth naming precisely what leaks here, because it is easy to guard the wrong thing. The sensitive disclosure is *membership*: the sender knows its own record is, say, "Jane Doe," so "my record matched" tells it that the receiver also holds Jane Doe. The final association table - the pairing of the sender's records to the receiver's row numbers - adds almost nothing on top of that, because the receiver's row numbers are opaque integers that mean nothing without payload or identifiers attached, which a one-sided exchange withholds. So withholding the association table protects the *least* sensitive layer; the membership disclosure has already happened, round by round, and is intrinsic to dropping matched records. (The map does carry some signal in a few narrow cases - two of the sender's records mapping to one receiver row reveals the sender's own duplicates; row numbers that encode sort order leak rank; stable row numbers reused across exchanges can be correlated - but those are second-order.)

**Send-everything.** The sender is told nothing and simply contributes all of its records every round; the receiver tracks the one-to-one mapping itself. The sender learns nothing about matches - only the receiver's dataset size. The price is twofold: the full dataset moves across the wire every round, and the receiver sees more of the match structure within the overlap than it strictly needs - for example, that one of its records is also "close enough," under the agreed weaker rules, to additional sender records that the cascade would have suppressed.

One subtlety makes the sender's blindness real: the receiver must keep feeding its *full* set every round and never shrink it. If it dropped its own matched records to save bandwidth, the sender would watch the set shrink and read the per-round match counts straight off the size. Holding the size constant is what buys the blindness.

## Why you can't just shuffle the leak away

There is a tempting shortcut worth heading off. The cardinality-only variant the project has designed (PSI-C) hides *which* records are shared by having the sender shuffle the receiver's data before returning it, so the receiver can count matches but cannot identify them. The natural question is whether the same shuffle could hide which of the *sender's* records matched - keeping the clean cascade without ever telling the sender anything.

It cannot, for two reasons. First, in a full linkage the receiver is *supposed* to learn which records matched; a shuffle it could not see through would hide the answer from the receiver too, collapsing the linkage back into a cardinality count. Second, and more fundamentally, the leak we want to close is on the sender's side, and the sender owns both its records and its key. The matching encryption is deterministic by necessity - that is how equal records are recognised - so the sender can always re-encrypt any of its records and recognise it again, no matter how the pile is shuffled. Shuffling a party's own data in front of that same party hides nothing from it. (The blow-by-blow is in the parking lot.)

## The structural fork

Set the shuffle aside; the real obstacle is simpler. A clean later round requires that an already-matched record *not appear* in it, and only the owner of a record can leave that record out of its own input. So for the sender's matched records to be absent from the later rounds, the sender has to leave them out - which means it has to know which matched.

That is a fork with no free middle:

- **Keep the clean cascade**, and the sender necessarily learns which of its records matched, and roughly on which precision tier.
- **Keep the sender blind**, and nobody can drop its matched records, so it sends everything every round and the receiver sees the weaker matches the cascade would have suppressed.

You can sit anywhere between these - drop some tiers and not others - but every point trades one leak for the other in proportion. There is no point that is clean for the receiver and blind for the sender at the same time, as long as the protocol works by encrypting records and comparing them. That last clause is the whole constraint: the gating decision ("has this record already matched?") is computed from match results, and in an encrypt-and-compare design, acting on a result means someone has seen it.

## Alternatives, and what each leaks instead

Taking heavyweight secure computation as a known backstop (described below), the space between the two poles holds more than "pick your leak direction." There are three knobs: re-choreograph the same encryption engine, move the trust, or swap the primitive.

| Approach | What the sender learns | The receiver's extra disclosure | Cost / trust |
|---|---|---|---|
| Clean cascade | membership + rough tier | none (minimised) | cheap |
| Send-everything | dataset size only | fuller match structure in the overlap | high bandwidth |
| Send-everything + receiver self-censor\* | dataset size only | contention only | medium bandwidth |
| Batched / coarsened drops | membership + coarse tier | none | cheap |
| Both-sided + enforced discard | the result, then discards it | none | cheapest; trust is policy |
| Homomorphic-encryption PSI | next to nothing | contention only | heavy compute |
| Trusted hardware (enclave) | nothing beyond output + size | none | cheap compute; trust is hardware |
| Secure computation (circuit-PSI / MPC) | nothing | nothing | very heavy |

\* Worked out in discussion; should be validated before being relied on.

**Re-choreograph the same engine.**

- *Receiver self-censor (with chaff).* The receiver drops its own already-matched records from the later rounds and pads back to a constant size with records that match nothing. The sender stays blind (the size never moves), and the receiver stops learning the redundant weaker matches for records it has already matched. A residual remains - a still-unmatched receiver record colliding, under a weak rule, with a sender record already claimed by a stronger match - which cannot be removed without dropping the sender's record, and that takes us back to the cascade leak. This appears to narrow the receiver's disclosure substantially for only a bandwidth cost; because it was reasoned out rather than implemented, it should be validated before being relied on.
- *Batched or coarsened drops.* Tell the sender to drop in lumps rather than strictly round-by-round, or combine identifiers into fewer, stronger keys so there are fewer rounds. This keeps the cheap cascade but blurs the secondary "which tier" part of the leak.

**Move the trust.**

- *Enforced discard - "the tool is the trust boundary."* Run the exchange so the sender's software simply never writes or surfaces the result. Data-sharing agreements are written about what software persists and exposes, not about what could in principle be inferred from memory, so "the shipped tool produces no sender-side output" is a control a compliance reviewer can actually evaluate. Paired with send-everything there is genuinely nothing in the sender's memory to discover; paired with the clean cascade it leans on the operator not inspecting transient state. Either way the residual sits on the *malicious* side of the honest-but-curious line, which the threat model already excludes.
- *Trusted third party or trusted hardware.* Hand the matching to a mutually trusted party, or to a hardware enclave neither side can see into. Both relocate the trust rather than removing it.

**Swap the primitive.**

- *Homomorphic-encryption PSI.* The receiver queries under encryption and the sender computes blind, learning next to nothing - not even the receiver's exact dataset size. It is tuned for the lopsided shape a one-sided exchange often has (a small querying side, a large helping side).
- *Secure computation (circuit-PSI / MPC).* The matching and the running "already matched?" bookkeeping happen inside a computation neither side can see into. Done fully, the sender learns nothing about which of its records matched, and with dummy padding not even how many. This is the only approach that genuinely *removes* the leak rather than relocating or blurring it - and it is a different engine, not an addition to the current one. The project already records this direction as the route for threshold and weighted matching ([DESIGN.md](../DESIGN.md#multiple-potential-matches)); the same core would address this disclosure at the same kind of cost.

## The deployment envelope prunes the list

Several of those alternatives do not survive the project's own constraints. The tool is meant to run in a standard browser, on hardware agencies already have, using software already commonly approved - and on datasets large enough (up to the tens of millions of records the design targets) that the in-browser budget is already tight.

Under that envelope:

- Trusted hardware is out. A browser has no access to an enclave, and enclaves need specific silicon and an attestation chain.
- Homomorphic-encryption PSI and full secure computation are not feasible in the browser at this scale today. Both are heavy, and the available libraries still demand expert tuning rather than dropping in.

So the heavyweight fixes are not merely more than the current threat model warrants - in the browser they are simply off the table. What fits the envelope is exactly the in-engine choreographies plus the policy and operational controls: which cascade, how much to blur, and enforced non-output backed by the agreement.

The binding constraint is the browser, not the project as a whole. The command-line and container path has native compute and no sandbox, so if the threat model ever hardened to a malicious adversary, a heavier crypto core would more plausibly live there - at the cost of splitting behaviour between the two front ends.

## Status and current leaning

No decision has been taken here beyond "worth revisiting" - this note exists to make the tradeoffs thinkable later, not to ratify a choice. That said, where the reasoning currently points:

Under the honest-but-curious model the project adopts, the residual leak in the clean-cascade approach looks acceptable - a helper learning which of *its own* records matched, and roughly how strongly, is a modest disclosure between agencies that have already agreed to share the overlap. The clean cascade is also what the implementation does today. Combined with the deployment envelope - which rules the heavyweight alternatives out in the browser regardless - the leaning is to keep the simple in-engine approach for now. The live levers would be the choreography choice, the blurring measures, and enforced non-output on the helper's side. The secure-computation route, already scoped for threshold and weighted matching, is where to look if the model ever hardens - most plausibly in the command-line path rather than the browser.

Turning any of this into an actual decision (and perhaps the first ADR) is the open task.

## Folding this into the live documentation

This note now lives in `docs/notes/` (tracked, but exploratory). A few thoughts on whether and how to promote it further, offered for review rather than as a settled structure:

- **Separate the decision from the rationale.** The project's convention is that decisions - including deferred and negative ones - and their resolution path belong in the docs that are read proactively, while the supporting reasoning can live elsewhere. Two things here would be decisions if taken, and would deserve a stated home: (a) whether one-sided exchanges accept that the helper learns its own membership, mitigated by key design, blurring, and enforced non-output; and (b) whether the heavyweight fixes are deferred not only on cost but because the browser envelope rules them out, with the secure-computation route reserved for a hardened threat model and most likely the command-line path.
- **Natural homes.** The leakage analysis would sit most naturally as an appendix to the security material - it is fundamentally "what is disclosed, to whom, under the threat model." The choreography options sit closer to the protocol material. One workable split: a short, decision-level paragraph in the security document linking out to a longer "disclosure and alternatives" appendix (this note, trimmed) kept alongside the design docs.
- **Promote the conclusions, keep the mechanics as rationale.** The high-level tradeoff table and any eventual decision are worth promoting; the detailed mechanics (the shuffle argument, the self-censor construction) are rationale and can stay in an appendix or in this note so they do not clutter the operational text.
- **Keep it self-contained.** Whatever lands in the live docs should state its own terms - receiver and helper, the cascade, the always-revealed-size caveat - rather than depending on a chain of cross-references, so a compliance reader can follow it in a single pass.

## Parking lot (cut for review)

Content trimmed from the body, kept here so nothing is lost. Re-incorporate or discard as you see fit.

### Detailed shuffle mechanics

*Why the shuffle works in the cardinality variant.* A shuffle only hides something if the party looking at it cannot undo it. In the cardinality variant the receiver gets its own records back encrypted under the *sender's* key. The receiver does not hold the sender's key, so it cannot take one of its own records, work out what that record would look like under the sender's key, and go find it in the pile. The order is genuinely opaque to it; counting is all it can do. (The permutation is what destroys the positional correspondence; the inability to recognise data encrypted under a key you do not hold is what makes that permutation impossible to undo. Both are needed.)

*Why it does not carry over to a full linkage.* Two separate reasons, both fatal. First, in a full linkage the receiver is *supposed* to learn which records matched - so a shuffle it could not undo would hide the answer from the receiver as well, turning the full linkage back into the cardinality-only variant; there is nothing to gain by aiming the shuffle at the receiver. Second, the leak we want to close is on the sender's side, and a shuffle cannot reach it: the matching encryption is deterministic, the sender holds its own records and its own key, so it can always re-encrypt any record and recognise it no matter how the pile is shuffled. (The implementation already leans on this in the ordinary case: the sender permutes its own records before sending and reverses the permutation locally - unremarkable precisely because a party can always undo a permutation of its own data.) And there is no clever salt that escapes this: anything that stopped the sender recognising its own record would also change the encrypted value, which would break matching for everyone.

### Detailed self-censor construction (unverified)

Round 1 (strongest key): the receiver sends all N records and learns its matches. Round 2 (a weaker key): the receiver wants to find matches for its still-unmatched records without re-learning anything about the ones already matched, so it sends the weak-key values of the unmatched records plus chaff padded up to N, where the chaff is constructed to match nothing. The sender, seeing N records both rounds, learns only the constant size. The receiver no longer sees the redundant weaker matches for its already-matched records. What remains is the "contention" case: a still-unmatched receiver record R' that matches, under the weak rule, a sender record already claimed by a stronger match to a different receiver record. R' is unmatched (so the receiver would not have dropped it) and the claimed sender record is the sender's to drop (so the receiver cannot remove it), which is why this residual cannot be closed without returning to the clean-cascade leak. The contention signal is largely about near-duplicates and data quality, arguably the least sensitive thing on the menu - but the whole construction needs validation before it is trusted.

### Chaff caveat

Adding dummy records to noise the counts needs care: chaff that can never match noises only the input *sizes*, not the match counts, while chaff that *does* match has to be constructed so it never corrupts the real result. (The self-censor construction above relies only on the safe, never-matching kind.)

## See also

- [DESIGN.md](../DESIGN.md#multiple-potential-matches) - the secure-computation extension already scoped for threshold and weighted matching, which would also address this disclosure.
