---
title: "One consent summary for two acceptance surfaces"
---

# One consent summary for two acceptance surfaces

_Status: shipped. This note records why the invitation consent summary is a
shared display model in `@psilink/core` rather than one per surface, what each
classified line claims on that basis, and what the arrangement does and does not
guarantee. The escaping contract it rests on
is specified normatively in
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#display-sanitization-escape-format);
the operator-facing description of what `psilink accept` prints is in
[CLI.md](../CLI.md#offline-acceptance). See
[docs/notes/README.md](README.md)._

An acceptor has two ways in: the web app's consent screen and the CLI's
`psilink accept` prompt. Both show the inviter's proposed linkage terms and then
collect a yes. Under `psi` what is matched decides which identifiers are
disclosed, so every matching rule is part of what is being consented to -- and
each surface has to show all of them.

## The judgment is expensive and there is only one of it

Turning a decoded `LinkageTerms` into something an acceptor can decide on is not
a formatting problem. It involves deciding which fields bear on consent at all,
naming what each transform does to matching in plain language, resolving a
key element's field reference to a semantic type without exposing the
partner-authored field name, working out what a swap does on the receiving side,
bounding a partner-supplied parameter record, distinguishing a declared-but-empty
payload direction from an absent one, and marking a term the run does not apply.

None of that is per-surface. Two implementations of it would answer the same
questions differently and drift, which is the failure the arrangement removes:
`summarizeInvitation` produces a framework-agnostic display model, and each
surface only renders it. What stays per-surface is presentation -- the web's
progressive disclosure and accessibility structure, the CLI's indented outline.

## What the coverage check pins, and what it cannot

A shared classification table (`linkageTermConsentCoverage.ts`) records, per
`LinkageTerms` field, whether an acceptor's consent turns on it, and includes a
variant that differs from a base document at that field alone. A surface
_represents_ a field when it renders the two differently. Each surface runs that
probe set against its own output, in both directions: a field the surface does
not represent has to be recorded as a gap, and closing a gap without striking its
entry fails too.

The limit matters, because it is what makes sharing the summarizer critical
rather than merely tidy. The check pins REPRESENTATION -- does the field move
the output -- and never FIDELITY -- does the output say the same thing on
both surfaces. A second implementation of the judgment above would satisfy the
check while describing a transform's effect differently, or attaching a caveat
to the wrong term. One summarizer makes that class of drift unrepresentable
instead of merely detectable.

That reasoning generalizes past the summarizer, and the classification below is
where it was applied a second time. A sentence a surface authors for itself is a
second account, and the check cannot see it; a sentence both surfaces read from
one place has nothing to drift against.

## Enforced, or the partner's word

An acceptor reading either surface meets two unlike kinds of fact. Some the
exchange holds itself: it either runs that way or aborts. Others are what the
inviting party declared, shown faithfully and neither verified nor enforceable --
the self-asserted identity, the promise not to pass a result on, the data
standards a field commits to. Presenting the two alike invites the acceptor to
read a cooperative undertaking as a cryptographic guarantee, which is the error
worth spending screen space to prevent.

So each fact has a basis, `enforced` or `trust-contingent`, and the caveat
sentence that explains it. Both live in core beside the summary
(`consentFacts.ts`), keyed by a fact identifier; a surface looks the pair up
rather than stating one of its own.

WHICH facts a surface marks is still the surface's own. The received-columns
basis is marked on the CLI's line and not on the web's payload block, which shows
the set with no basis beside it. The two surfaces do not disagree there -- one of
them declines to state the fact rather than stating it differently -- and the
silence understates, which is the safe direction.

That silence is deliberate rather than pending. The clause the web's line held
before -- that any payload column would abort the exchange -- overstates on the
line it sat on: the commitment holds only where the invitation includes the column
set, so an empty set reads truer bare than qualified by a promise that does not
cover it. A fact's classification binds the surface that states the fact, not
every surface that shows the value.

That the classification is a KEYED TABLE, rather than a field on
`InvitationSummary`, follows from two properties a per-field flag cannot hold.
Not every classified fact is a summary field: the acceptor's own outbound columns
come from its own resolved metadata, never from the partner's token. And one
underlying field has two classifications at once -- the viewer's own
non-receipt is enforced, while the partner's non-receipt on the same
`output` pair rests on the partner's word. The shared consent-coverage
classification is the repo's existing precedent for the shape.

The partner's own result receipt is the second instance of that property, and it
is classified by VALUE rather than by field. A `yes` is enforced: the two
parties' output directions are compared as a mirror before data moves, and the
run then delivers the result to the party those agreed terms entitle to it, so
the disclosure is one the exchange makes rather than one the partner elects. What
the partner does with the result once it holds it is a limit on its USE and not on
whether the disclosure happens, so the fact's caveat sentence states that limit
rather than its marker. A `no` -- a result withheld from a partner -- stays
trust-contingent, because one-sided PSI gives this side nothing to impose it
with. Marking the disclosure that certainly happens as merely the partner's word
would be the same error as presenting the withholding as a guarantee, facing the
other way.

The caveat sentence is one shared string, not two agreeing ones. The web's copy
was the material to promote: every line holding this classification there is
markup-free text in a single element, so nothing about the markup forced a
per-surface wording, and the web's had already been reviewed. What stays
per-surface is only the fact line itself -- its label and value -- and the
structure around it: the web's tiers and disclosures, the CLI's indented outline.

A terminal has no styling budget, so where the web separates a caveat from its
headline by size and colour, the CLI marks the basis on the fact's own label and
puts the shared sentence on the line beneath. The marker vocabulary lives in the
same table, so a third surface inherits it rather than inventing a third.

## A line states what crosses; its marker states the basis

A payload direction the inviting party declares empty renders as a bare `(none)`
on both surfaces, with nothing after it.

The display distinguishes an explicit empty declaration from an absent one
structurally rather than in words. The line renders only for a DECLARED
direction; a direction the invitation leaves open prints no line at all and is
reconciled against the sender's own disclosure when the exchange runs. A reader
meeting `(none)` is therefore already looking at an explicit declaration, and a
clause saying so restates what the structure holds.

What such a clause adds beyond that restatement is worse than redundant. Payloads
are exchanged before either side reconciles what it received, so a violated
declaration aborts the exchange only after the values have crossed the wire -- an
enforcement that does not do what "would abort the exchange" sounds like at a
consent prompt, where an acceptor is deciding what it is willing to have leave the
machine.

So the line states what crosses, and whether the exchange holds that fact or the
inviting party merely declared it is the basis marker's job -- the division of
labour the classification above sets up. The enforcement mechanics, which party aborts
and that the abort follows transmission, are the operator's to know and are
stated in [CLI.md](../CLI.md#offline-acceptance), which has room to state them.

## One line, two bases: carried against declared

The received-columns line has two sources. Where the invitation carries the
disclosed subset, the line IS that subset -- the inviter's own transmission
predicate run over its own metadata, so the displayed set cannot drift from the
bytes that flow. Where it carries none -- an older or metadata-unknown mint, or the
inviter's own pre-mint preview of terms it has authored but not yet minted -- the
line falls back to the `payload.send` the inviter wrote.

Both are declarations; only one of them is enforced. An acceptance records the
CARRIED subset as what it will receive and the received payload is reconciled
against it, while the authored fallback records nothing -- and an absent
expectation is the lazy reconciliation path, whose absent-versus-empty semantics
are the spec's and are stated normatively with the payload step. A marker keyed on
"the invitation declared something" therefore puts `enforced` on a line where an
inviter may declare one set, transmit another, and not be stopped. Worse, which
source the line comes from is the INVITING party's choice, so a surface keyed on
the declaration lets a partner earn the `enforced` marker without earning the
check behind it.

So the fact splits in two, one entry per basis, selected on the provenance the
summary already knows. This is the second line to hold two classifications at
once, and it does so on a different axis than the first: the partner's result
receipt splits by the fact's VALUE, this one by where the displayed set came from.
The keyed table absorbs both without a conditional-basis mechanism, which is the
property that made a table the right shape to begin with.

The `(none)` reading above is unaffected. An authored `payload.send` that is empty
is not a declaration the display recognizes at all -- it prints no line, exactly as
a lazy direction does -- so a rendered `(none)` is always the carried case, and
always the strict commitment.

## What the marker understates, on purpose

The classification keys on the invitation, and the invitation is the same on both
acceptance paths. The enforcement is not. An offline acceptance writes a
configuration whose terms mirror the inviter's `payload.send` into this party's own
`payload.receive`, and the later `psilink exchange` falls back to that mirror as
its received-column commitment where no carried subset was recorded. The
authored-declaration case is therefore enforced on that path, and the line marks it
as the partner's word regardless.

That understatement is deliberate. The display is rendered at consent time, before
the run that follows is decided, and one marking serves both paths, so one of the
two is wrong in one of the two cases. Only one of those errors costs the operator
anything. An operator told psilink will stop a violation it will not stop plans
around a check that never runs -- the failure this classification exists to
prevent, and the same error as reading a cooperative undertaking as a
cryptographic guarantee. An operator told psilink will not stop something it does
stop has lost a reassurance and nothing else.

Making the display path-aware is not the way to close it: the path is a
property of what the operator does next, not of the invitation they are being
asked to consent to, and a marker that changed with the subcommand would be
stating two different bases for one unchanged fact.

## The outbound-send line, and what it stands behind

Both surfaces lead the acceptor with its OWN outbound columns, the
hardest-to-undo fact it consents to, and both state that nothing is sent when the
inviting party receives no result.

The run transmits nothing at all to a partner not entitled to the result: an empty
message goes on the wire where a payload would, so no column leaves the machine
whatever the acceptor's input file holds. Listing a set that never moves would
overstate the disclosure, under a marker asserting the exchange holds the fact.

That answer takes the line ahead of the two cases that would otherwise fill it,
and both surfaces apply the precedence the same way, so the case where they
overlap is not the case they diverge on. It comes ahead of the not-yet-known
forward reference, because the input file that reference points at cannot change
the answer, and pointing at it sends the operator to look for something that does
not bear on the question. It comes ahead of the empty set's own wording, because
where the acceptor discloses nothing both statements are true and the direction is
the one that survives the operator changing their file, while an empty disclosure
is a property of the metadata resolved for this acceptance alone.

The displayed direction and the run's own payload gate are one fact with an
aborting check between them, not two derivations that happen to agree. Acceptance
mirrors the invitation's output direction into this party's own terms, and the
compatibility check refuses a partner presenting terms that disagree with that
mirror, so the two cannot come apart without the exchange aborting.

Where columns ARE listed, the `enforced` marker stands behind a bound: the set is
derived from the acceptor's own resolved metadata through the same predicate the
payload step transmits on, so no column outside it leaves the machine under the
configuration this acceptance writes. One limit is stated beside the bound,
because it is the one the derivation does not reach -- an acceptance that keeps a
configuration already on disk runs on that file's stored metadata, which nothing
compares against the input the line was rendered from.

## The same line, read from the other seat

What the line turns on is the VIEWER's partner receiving a result, not the inviting
party's receipt as such, and the difference bites wherever a display serves both
seats. The inviter's own preview of the terms it is proposing reads the mirror: its
partner is the acceptor, which receives when the invitation shares its result. A
preview gated on the acceptor's own fact would blank a list of columns that do move,
so each side's direction is pinned by a control rendering the opposite one-sided
terms, where the columns must still be listed. The failure worth pinning against is
the suppression, not the over-statement: an operator who reads a column they will not
send is misinformed, while one who reads nothing where a disclosure happens is
misinformed and unaware there is anything to check.

Because the fact is viewer-relative, so is the sentence that states it -- "your
partner", "your file" -- and one wording therefore serves either seat. It is held
once beside the classification and rendered by each place that states it in prose:
the web consent screen's outbound block, the inviter's preview, and the acceptor's
column-picking step, which is the screen where the operator is actively marking what
to disclose and so the worst place to be told columns will be sent when none will.
That step states it in both of its channels, the visible panel and the live region
its disclosure controls speak through. A screen has one account, not one per sense:
where the two are gated separately, the ungated one leaves a sighted operator told
nothing is sent while a screen-reader user is told their columns are -- the same
divergence between surfaces, folded inside a single screen, and read by the operator
least able to check it against the other channel.
The CLI states the same fact as its line's value instead, in the label-and-value
shape its outline uses, which is the per-surface half the division above leaves to
the renderer. What is not left to a renderer is a fourth account of the fact: a
surface composing its own sentence is exactly the drift the shared table exists to
make unrepresentable.

## Two facts side by side, and where the comparison lives

The acceptor's own outbound columns and the inviting party's declared request sit
in the same part of the display, and nothing on either surface compares them. The
comparison is real, but it is not the display's. An inviter declaring it will
receive no payload column, against an input file whose metadata discloses some, is
a disagreement `psilink accept` states during the input-versus-terms checking it
already performs, before the terms display and the prompt, and one
`assertPayloadSendDisclosed` refuses at prepare time, before this party connects,
so the columns never cross rather than being rejected once they have arrived.

That refusal is keyed on direction, not on the declaration alone, which is what
lets it sit beside the display without contradicting it. A refusal keyed on the
declaration alone would fire even where the run transmits nothing, which is the
contradiction the gated lines elsewhere in this note exist to prevent: a screen
cannot say the exchange refuses to run directly above a line saying no payload is
sent. So the empty declared request is held against this party's own disclosure
only where this party's `output.shareWithPartner` says the partner receives the
matched result, the same entitlement the outbound-send gate reads. Where it does
not, nothing crosses whatever the metadata discloses, the line reads that no
payload is sent, and no warning is stated against it. `docs/spec/FILE_SYNC.md`
holds the normative rule and `docs/CLI.md` the per-path account of what
acceptance does after it states the conflict.

## Proposed is not applied

One setting an inviter may declare is not honored by today's exchange: the
per-element fuzzy-comparison expansion. `APPLIED_SETTINGS` is the single source of
truth for which, and the summary includes the resulting flags alongside each term
rather than leaving each renderer to consult it. A surface therefore cannot state
a matching behavior the run does not perform, and cannot forget the caveat for one
setting while stating it for another.

It does not change what is disclosed -- it changes match breadth -- so its caveat
sits one expand down with the headline it qualifies. A setting that stated a
DISCLOSURE guarantee would take the other placement: with the headline itself,
where a reader cannot take the guarantee as in force without also meeting what
qualifies it.

What a caveat SAYS follows what not applying the setting actually does. The fuzzy
expansion is a silent no-op that narrows the match, so its marker says only that
the expansion is proposed. A setting whose not-applying is a REFUSAL takes the
opposite copy -- naming the refusal and what to ask the inviter for -- and the two
must not be swapped: a caveat saying the run proceeds and reveals more than the
headline promised describes a run that does not happen, which is what one surface
once said about a count-only invitation while the other said the opposite.

The caveat copy is held once, beside the classification, and rendered twice --
for the same reason the classification is. Two surfaces authoring their own
account of the same unimplemented setting is how they came to say opposite things
about a proposed count-only exchange in the first place.

## The deduplicate disclosure statement

Deduplicated matching runs, so what its headline needs is not a caveat but a
statement of what it costs. The exchange discloses grouping the one-to-one match
does not, and the party that reads it is the party the result reaches. Where the
invitation shares the result, that is the acceptor, and the sentence beside the
duplicate-matches headline states three things the specification fixes: which
party learns it and about which of its own records, that what is learned is a
count and row positions rather than the matched value, and that the count is the
declaring party's own declaration rather than a figure any check binds.

The last of those is the one a surface would be tempted to drop, and dropping it
would state a guarantee no check makes. So it is not left to either surface's
discretion: the sentence is one string in core, and the consent-coverage
classification holds it as the copy BOTH surfaces must render for a
deduplicating document. The representation check alone could not catch its loss --
a surface that renders only "duplicate matches: yes" still moves when the term
moves -- which is exactly why the pin sits beside the classification rather than
in either surface's own test.

There are two such sentences, not one, because the invitation's output shape
decides which party reads the grouping and a deduplicating invitation can take
either shape. The schema requires a deduplicating party to receive output, so the
only remaining axis is whether it shares: both parties receive, or the inviting
party alone does. Under the second the acceptor is sent nothing, so the sentence
above would tell it what it learns from a table it never gets -- and the
unverified-count limit that sentence ends on has nothing to bound, the party
reading the count being the one that declared it. The sole-receiver sentence
states the disclosure that does happen: the result the inviting party takes away
groups several of its own records onto one of the acceptor's, and psilink
presents the acceptor none of it.

### Where the acceptor's non-receipt is held, and where it is not

That second half is display-scoped on purpose, and the surfaces say so. What
holds it is the entitlement gate on the table `runExchange` returns, so a
sole-receiver acceptance is handed none. The wire is not what holds it in
general. Under cascade the rounds carry the grouping to the acceptor's own
process -- its matched position repeated once per group member, against the
inviter's row indices. Under single-pass the one wire-level withholding can
reach it, since the sole receiver is the party entitled to output and role
resolution therefore makes the acceptor the sender that withholding covers, but
only where the acceptor transmits no payload column of its own; an invitation
requesting one leaves the table exchanged and the grouping in that party's
process again.

Stating the withholding as an absolute would put a trust-contingent fact under an
`enforced` headline, which is the one error this classification exists to
prevent. So the two halves are two facts. The STATEMENT says what psilink
presents, which is the display withholding this client makes. The limit -- that
the matching still carries the grouping to the acceptor's process wherever the
withholding above does not reach, so what its operator is shown rests on the
software that party runs -- is a
`trust-contingent` entry of its own in the shared table
(`duplicateGroupingDisplayLimit`), rendered beside the statement by both
surfaces. A limit that is a claim about software rather than about the run is
classified as one rather than left as an unmarked clause inside a sentence, which
is the same reason every other caveat in the table is an entry rather than prose
in a renderer.

The split is also what keeps the duplicate-matches marker where it belongs. That
marker states its headline's own fact, match multiplicity, which the run does
hold; the limit sitting past what the marker holds is a classified fact beside
it, in the other register, rather than something the headline's marker could be
treated as covering. Reclassifying the headline instead would understate a
multiplicity the exchange enforces in order to qualify a display fact standing
beside it -- the same division the partner's result receipt takes above and the
retain-mode line takes below.

That forced the pin to grow a shape axis of its own. It names copy a surface must
render for a variant document, so a term with two truthful sentences could
otherwise pin only what both shapes share -- which is neither sentence -- or pin
one and let the other shape render it. The classification names the shapes
instead, and each holds both the copy its variant owes and the copy it must not
include, so a surface rendering one sentence under every shape fails on the shape
whose run does not make that disclosure. Both surfaces are measured against the
same two pairs. The display limit rides those pairs too: the sole-receiver shape
owes it beside its statement, and the both-receive shape forbids it, since a
screen that presents the acceptor the grouping has no withholding to qualify.

Whichever sentence renders, its placement is the same rule the caveats follow,
applied to the headline it qualifies rather than to the setting's implementation
status: the duplicate-matches headline states match multiplicity, so it sits
inside a disclosure, and the sentence sits with it.

A direction note sits beside whichever statement the shape selects, and the pin
holds both, because what the setting discloses and whose records are grouped to
disclose it are separate facts a reader needs together. Acceptance derives the
accepting party's own `deduplicate` as false rather than adopting the
invitation's, so the pair an accepted deduplicating invitation resolves to is
one-sided by construction. A reader met only by the disclosure statement would
have no way to tell whether their own file is the one being grouped -- and the
invitation offers no control for the other direction, so the sentence names the
per-party configuration path that does.

That note states a second fact for the same reason it states the first: what
the derivation closes is the grouping, not the acceptor's own outbound
disclosure. More of the accepting party's records can match than in a one-to-one
run of the same two files -- disclosing their membership and any payload columns
that party sends -- on the inviting party's declaration alone. A note stating
only that the accepting party's records are not grouped would be treated as the setting
costing that party nothing, which is the reading the run does not support.

It states that outcome rather than the mechanism behind it. The mechanism -- a
value the inviting party holds on several rows is ambiguous under `one-to-one`
and drops out of the round, while a deduplicating run contributes it once and
matches -- is what makes the outcome true, and it is recorded in
[deduplicate-matching-semantics.md](deduplicate-matching-semantics.md) and beside
the constant rather than in the copy. A reader deciding whether to accept needs
what changes about their own disclosure, and a clause about dropped ambiguous
values asks them to derive that for themselves. Consent copy states the outcome;
the mechanism belongs where someone auditing the classification looks for it.

## The count-only tier

The exchange conducts a count-only run, so what both surfaces render for a `psi-c`
invitation is the tier stating what it discloses -- never a caveat qualifying the
algorithm away. The algorithm alone is what reaches the tier: no second flag can
hold half of it back, and none can be left set while the other clears.

The count-only disclosure statement itself is shared wording rather than a shared
placement. The web screen has it as the matching-method headline; the CLI
accept prompt names the algorithm there and prints the statement beneath it. Each
surface's render test pins the tier's own wording and placement, and the absence
of every one of its sentences from a `psi` invitation, so the presence is the
algorithm's doing rather than the fixture's.

Count-only is the mildest disclosure psilink offers and it is not zero disclosure,
which is why the tier is more than one replacement sentence. The intersection
count is itself a disclosure; each party's record count rides the terms exchange;
each round frame's element count says how well the key covers the dataset; and
where both parties are entitled to the count, one of them holds a number it did
not compute.

### The bases are the specification's, not this display's

[PROTOCOL.md](../spec/PROTOCOL.md#psi-c) assigns, per party, which halves of the
count-only claim the run holds and which rest on the partner, in this display's own
`enforced` / `trust-contingent` vocabulary. Each fact takes the row it belongs to
rather than a judgment made here, so a row reclassified in the specification and
not in the table is a divergence between what an implementation is specified to
guarantee and what an acceptor is told it guarantees.

- **What the run reveals** -- enforced. A party's own outcome is held by the
  cleared reveal flag, and its view of what the partner receives by the wire
  refusing a mismatched round; neither asks for the partner's cooperation.
- **What the rounds still disclose** -- enforced. The record and element counts
  above are disclosed however either party behaves, the same register as the
  own-membership disclosure a one-sided `psi` exchange has.
- **How the count reaches a party that did not compute it** -- trust-contingent.
  It arrives as the receiver's report, and psilink does not check it, exactly as
  the `psi` association-table return leg does not.
- **What a chosen input set defeats** -- trust-contingent. The claim protects a
  party against a partner contributing a genuine dataset; a crafted or differenced
  input set is accepted rather than prevented, so the protection rests on the
  partner's conduct even where the round itself is enforced.

The last of those is the one an acceptor could act on wrongly, so it is never
separated from the guarantee it bounds: a reader who takes "only a number" for the
safe option must not be able to reach that reading without meeting it. This is the
same placement rule the not-applied caveats follow, applied to a sentence that
bounds a setting the run does honor.

### Why the payload sentence names the algorithm

The outbound-send slot's existing sentence reasons from output entitlement -- the
partner receives no result, so nothing is transmitted to it. Under `psi-c` that
reasoning does not reach the fact: the algorithm includes no payload in either
direction whichever party the terms entitle to the count, and the refusal of a
terms document declaring one is fail-closed at three points
([PROTOCOL.md](../spec/PROTOCOL.md#psi-c)). So the slot states the algorithm as
the reason, and the sentence is a fact of the tier rather than a second reading of
the entitlement one. Stating the refusal where the operator is deciding what
leaves their machine is also where the specification puts it -- at the choice, not
as a surprise once the run aborts.

Each surface backs that sentence with a render-side refusal rather than printing
it over a contradiction: a `psi-c` whose viewer-side outbound set contains a
column, or whose invitation declares payload in either direction, throws instead
of rendering the guarantee. Those throws are a safety check and not the remedy. The
remedy is the actionable refusal ahead of them: a payload-declaring `psi-c`
document is refused wherever it is parsed, and an input-metadata payload column
wherever a surface holds this party's own metadata beside the agreed algorithm --
where the terms are authored, at the mint, and at the accept. An operator meets
the rule and what to change about it, not a raw render error.

The payload refusal is not the only one the tier's copy presupposes. The
spec's remaining `psi-c` shape refusals are held on the same footing: more than
one linkage key and `linkage_strategy: single-pass` would falsify the tier's own
copy -- the round-disclosure note speaks of one key's exactly-once values, and
the result note denies any record-by-record pairing -- and `deduplicate` is
refused by the count-only rule, a count-only run reporting a size rather than a
pairing for any multiplicity to widen. None of those
three -- more than one linkage key, single-pass, and deduplicate -- has a render
safety check, by decision rather than omission: the refusals reach them where the
terms are authored, at parse, and at accept, which is where a document that
breaks one is stopped.

That the CLI puts the whole tier in its twice-printed decision block,
beside the algorithm it prints there, is the same judgment read from
the other end: under `psi-c` what the run discloses IS the decision, so
these are the facts an operator answering the prompt has to have in front
of them rather than the terms they qualify. It costs length -- the block
below has a fixed budget of four lines plus the acceptor's own columns,
a retain disclosure adds roughly two wrapped lines to each printing for the
repeated fact plus a one-time ten-line caveat printed once in the outline
after the first printing, and a count-only exchange adds its tier to that --
and the trade is taken here and not for the single-pass note, because these
facts ARE what the count-only decision turns on rather than a qualification
of a term the block already names.

### Why the own-membership fact names the algorithm too

The honest-helper membership fact is the same error facing the other way, and it
is the one the tier does not merely qualify but contradicts. A one-sided `psi`
exchange discloses to the non-receiving partner which of its own records the
viewer also holds, however honestly that partner behaves, which is what puts the
fact in the run's register and on both surfaces wherever the partner receives no
result. A one-sided `psi-c` exchange discloses nothing of the kind: by the role
rule the entitled party IS the receiver, so the non-receiving partner is the
sender, and a count-only sender computes nothing from the round and is sent no
count-report frame ([PROTOCOL.md](../spec/PROTOCOL.md#psi-c)). Stated there, the
fact would tell an acceptor that a disclosure happens which the algorithm
forecloses -- directly under a headline saying only the count is revealed.

So the fact is scoped by the ALGORITHM and not by the linkage strategy: it holds
for a one-sided `psi` exchange under both strategies and for no `psi-c` exchange
at all. Both surfaces withhold it for any `psi-c` invitation, off the same reading
of the algorithm that reaches the tier's own five sentences -- one gate, so the
fact and its replacement cannot both be shown or both be missing. What a
count-only run does disclose is the tier's to state, and it already does: the
round disclosures beside the count, and the enforced half that hands neither
party a pairing.

## A fact that outlives the run, and the negative it does not state

The retain declaration is the first entry keyed on something the token holds
rather than on a term of the exchange: the inviting party's `retain_files`, which
makes the rendezvous location a permanent transcript instead of emptying it as each
message is consumed. Its wire form, the mint paths that stamp it, and why a
declared-but-never-applied flag stays inside the transport's detect-and-fail stance
are the spec's ([FILE_SYNC.md](../spec/FILE_SYNC.md#retain-mode-declaration-on-the-token)).
What is this table's is the classification and the copy.

The basis splits, and the split is the reason the entry has a caveat sentence
rather than only a marker. The mode AGREEMENT is the run's: both parties advertise
their setting in the hello and a disagreement aborts both sides before any data
moves, so an exchange that runs at all is one both parties ran in the declared mode
-- an acceptor cannot be walked into a transcript they did not consent to. What
becomes of that transcript once the run ends is not the run's at all: retain mode
deletes nothing, the location is the inviting party's, and psilink is not in the
decision. Marking the whole line `enforced` would let the second half be treated as the
first; splitting it into two entries would put two markers on one fact and invite a
reader to weigh them against each other. So the marker states the half the run
holds and the note states the half it does not, which is the shape
`partnerReceivesResult` already uses for a disclosure that happens and a use that
is not this tool's to govern.

**The negative is unstated by design.** A surface renders the fact where
retention is disclosed and nothing where it is not. An invitation declaring delete
mode, and one declaring nothing at all, render alike -- nothing -- and the two are
alike for different reasons that land in the same place. An absent declaration has
made no claim, so there is none to relay. A declared delete mode HAS made one, and
it is a claim this tool cannot stand behind: delete mode deletes as a protocol
step, not as a guarantee about the directory afterwards, and a run killed outright
or one that fails after the handshake leaves files behind in either mode. "Your
partner deletes the files" would be the same error the enforced marker exists to
prevent, facing the other way -- a reassurance stated as a guarantee no check
backs.

That is why the summary includes `disclosesRetainedFiles`, a one-way flag, rather
than the token's three-valued field. The narrowing happens once, at the summary,
where the reasoning is recorded; a renderer handed the raw value could reach the
`false` and word a cleanup promise around it, and no test over one surface would
notice the other had not. Naming the flag for the disclosure rather than for the
mode is the second half of the same move: `disclosesRetainedFiles === false` is treated
as "the invitation discloses no retention", which is true of every case it covers,
where an `inviterRetainsFiles === false` on the display model would be treated as the
claim itself.

**The declaration is not the only ground.** The same flag is true where the
invitation's connection endpoint has a split inbound/outbound directory pair,
whose shape the accepting side's own connection is seeded from -- and a split
directory cannot be configured without retain mode, so that acceptor runs in retain
mode whether or not the token said so. Deriving the display from the shape as well
as the declaration is what keeps the two halves of one acceptance from disagreeing:
the alternative is a party seeded into a permanent transcript by the endpoint it was
handed while the consent line, reading only the declaration, says nothing. The shape
test is not restated here -- the summary calls the same predicate the seeding calls
(`endpointRequiresRetainedFiles`), because a second copy of it is a copy that can
drift. The copy stays one fixed sentence over both grounds: a split rendezvous runs
in retain mode on both sides or not at all, so nothing in the sentence turns on
which ground raised it.

## Alternatives weighed

**Extend the CLI's own renderer in place.** Rejected: it would re-derive the
field-type labels, constraint phrasing, transform glossary, parameter cap, and
the proposed-versus-applied semantics -- the whole judgment above -- as a second
implementation the representation check cannot tell apart from the first.

**Reclassify the inviter's authored payload declaration as consent-irrelevant,
on the grounds that the received-columns line is better derived from the token's
carried disclosure predicate.** The assumption is right and the summary already acts
on it: the line derives from the carried `disclosedPayloadColumns` where the
invitation carries one, falling back to the authored declaration otherwise. That
makes reclassification unnecessary, and it would have cost measurement -- an
excluded field gets no probe at all, so the surfaces would stop being measured on
a field they do represent.

## What a renderer still owns

Two obligations do not transfer with the model.

A value the summary does not include is that renderer's own responsibility. The
CLI prompt leads with the acceptor's OWN outbound columns, read from the
operator's input file rather than from the partner's token; those reach no
display boundary of their own and are escaped where the renderer emits them,
which is their sink.

Joining is a renderer's decision and a renderer's hazard. The display sanitizer
neutralizes control, bidi, and non-ASCII code points but leaves a printable ASCII
comma intact, so a comma-joined list lets one partner-controlled name display as
two. Both surfaces render every such list one entry per line.

The basis markers inherit the same limit, and it is accepted rather than closed.
They are plain parenthesized ASCII, so a partner-controlled value can embed the
text of one: an inviter naming itself `Acme Health (enforced)` renders as
`inviting party (your partner's word): Acme Health (enforced)`. This is a
scanning hazard, not a spoof of the classification -- the authoritative marker
sits on the fixed first-party label at a fixed indent, ahead of the value, and
that line is itself marked as the partner's word -- so the reader who checks the
label still reads the right basis. Closing it properly means a marker vocabulary
no printable-ASCII value can imitate, which the terminal has no budget for; a
third surface inheriting this vocabulary inherits the limit with it.

Putting a fact back in front of the operator is also a renderer's decision, and
the shape it takes is the critical part. A terminal has no scrollback the
prompt can rely on: a default-terms invitation renders far past what a terminal
shows, so the operator answering the CLI prompt is reading the tail of the key
list, and the facts the decision turns on left the screen long before. The CLI
prints those
facts a second time, immediately above the prompt, from the SAME function that
prints them first.

That the two printings share a renderer rather than a subject is the whole of
it. A summary composing its own wording is a second account of the same facts,
and a second account can state something the first did not -- which is a real
defect, not a hypothetical one: an earlier attempt here did exactly that, and
pinning it took a bespoke check that each of its clauses also appeared above.
Byte-identical output needs no such check, because there is no second wording to
drift. It also inherits every property the first printing was already measured
to have, rather than restating them: each partner-controlled value stays behind
its fixed first-party label, on its own line, where it can neither begin a line
nor manufacture one.

What the repetition includes is a deliberate selection, and what it leaves out is
chosen rather than overlooked. The linkage strategy and, under single-pass, its
disclosure note are not among the repeated facts, though that note describes a
real disclosure the acceptor consents to. The note is 423 characters, about six
wrapped lines on an eighty-column terminal, and adding it would roughly double
the block in the common case -- a repetition long enough to scroll is the
condition this exists to fix. So one limit is that an operator who reads only the
repetition has not seen every disclosure-affecting term, and `docs/CLI.md` says
so where the operator will meet it. Closing that properly means shortening what
those terms say, not lengthening the block.

The block's own length is not bounded, and the mechanism degrades where that
bites. It is four lines plus one per column the acceptor discloses, because the
outbound-send list is repeated in full rather than as a count -- a count would be
a second wording, which is the whole thing this shape exists to avoid. So the
repetition is seven lines at three disclosed columns, forty-four at forty, and a
hundred and twenty-four at a hundred and twenty; past roughly nineteen columns it
scrolls on an eighty-by-twenty-four terminal, and the first thing to go is the
outbound-send list, which is the acceptor's hardest-to-undo consent. Where the
invitation also discloses retained files the block has one line more, about
two more wrapped, and the scroll point moves in to roughly seventeen. That count
comes from the operator's own file and not from the partner, so it is a limit of
the mitigation rather than something a partner can drive. No check holds a bound
here, because there is no bound to hold: the honest reading is that the
repetition helps most for the ordinary handful of disclosed columns and helps
less as that list grows.

Only the heading above the second printing depends on the path. Without
`--consent-to-terms` a prompt follows and the heading says so; with it nothing is
asked, and a heading that framed the block as something to decide on would be
inviting a decision already recorded. The block below either heading is
byte-identical, which is what keeps the two printings one wording rather than
two.

Nothing else may be written between the display and the question. That property
is a check rather than a sentence here: the accept path drives a real run,
captures the logger's output and the prompt stream's as one ordered transcript,
and asserts at the instant the prompt is called that the last thing the operator
saw is the last line the repeated block emits. Both routes are covered because
both are live -- the surface reaches the operator through the log on the default
routing and through the prompt's own stream where the log would miss it -- so a
check watching only one would pass while the other pushed the block off the
screen.

### A fact repeated, a caveat stated once

The block's budget and the length of a classified fact's caveat were weighed
against each other at the retain declaration, the one entry whose caveat is long
enough to decide the question. That sentence is 726 characters, ten wrapped lines
beneath the line it explains, so including it at both printings spends twenty
wrapped lines on a single fact -- enough on its own to move the scroll point from
roughly nineteen disclosed columns to seven, with the outbound-send list the
first thing over the edge. So the block repeats the FACT, at the one line that
states it, and the caveat is printed once, in the outline, directly beneath the
block's first printing.

The split follows from what each half is. The fact -- that the exchange keeps
its files as a permanent transcript rather than emptying the location as each
message is consumed -- is a decision the operator makes at this exact prompt, so
it belongs where the decision is answered. The caveat is the half the run does
not hold: what becomes of the transcript afterwards, and what the rendezvous
shows anyone who can read it. That is what an acceptor reads the outline for, and
meeting it a second time at the prompt buys them nothing the scrolled-away column
list does not cost them.

Nothing shortened stands in for the caveat in the block. An abridged sentence is
a second account of the fact, and a second account can state something the first
did not -- the defect the byte-identical repetition exists to make
unrepresentable, and one this surface has made before. So the line the block
repeats is the fact's own label and value and nothing new: one wording, at both
printings, with no abridgement for it to drift from.

The retain line is last in the block so the caveat lands under the line it
explains. Printed under whatever else the block reached, it would display as the
count-only tier's or the disproved citation's. That adjacency is a check rather
than a sentence here.

The single-pass disclosure note lands where it does under the same rule, and
lands differently because its two halves are not the retain entry's two halves.
Its fact is the linkage strategy, and `linkage strategy: single-pass` states no
disclosure on its own -- what the acceptor consents to is entirely in the 423
characters under it. There is no one-line half to repeat: a block including the
label alone would put a word in front of the operator that says nothing, and one
including the note would be back to lengthening the block. So both halves stay in
the outline, and the limit that leaves -- an operator who reads only the
repetition has not seen every disclosure-affecting term -- is stated in
[CLI.md](../CLI.md#offline-acceptance) rather than closed here.
