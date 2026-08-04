---
title: "One consent summary for two acceptance surfaces"
---

# One consent summary for two acceptance surfaces

_Status: shipped. This note records why the invitation consent summary is a
shared display model in `@psilink/core` rather than one per surface, and what
that arrangement does and does not guarantee. The escaping contract it rests on
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
`LinkageTerms` field, whether an acceptor's consent turns on it, and carries a
variant that differs from a base document at that field alone. A surface
_represents_ a field when it renders the two differently. Each surface runs that
probe set against its own output, in both directions: a field the surface does
not represent has to be recorded as a gap, and closing a gap without striking its
entry fails too.

The limit is worth naming, because it is what makes sharing the summarizer load-
bearing rather than merely tidy. The check pins REPRESENTATION -- does the field
move the output -- and never FIDELITY -- does the output say the same thing on
both surfaces. A second implementation of the judgment above would satisfy the
check while describing a transform's effect differently, or attaching a caveat to
the wrong term. One summarizer makes that class of drift unrepresentable instead
of merely detectable.

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

So each fact carries a basis, `enforced` or `trust-contingent`, and the caveat
sentence that explains it. Both live in core beside the summary
(`consentFacts.ts`), keyed by a fact identifier; each surface looks the pair up
and renders it, and neither states one of its own.

That the classification is a KEYED TABLE, rather than a field on
`InvitationSummary`, follows from two properties a per-field flag cannot carry.
Not every classified fact is a summary field: the acceptor's own outbound columns
come from its own resolved metadata, never from the partner's token. And one
underlying field carries two classifications at once -- the viewer's own
non-receipt is enforced, while the partner's non-receipt on the same
`output` pair rests on the partner's word. The shared consent-coverage
classification is the repo's existing precedent for the shape.

The caveat sentence is one shared string, not two agreeing ones. The web's copy
was the material to promote: every line carrying this classification there is
markup-free text in a single element, so nothing about the markup forced a
per-surface wording, and the web's had already been reviewed. What stays
per-surface is only the fact line itself -- its label and value -- and the
structure around it: the web's tiers and disclosures, the CLI's indented outline.

A terminal has no styling budget, so where the web separates a caveat from its
headline by size and colour, the CLI marks the basis on the fact's own label and
puts the shared sentence on the line beneath. The marker vocabulary lives in the
same table, so a third surface inherits it rather than inventing a third.

## Proposed is not applied

Three settings an inviter may declare are not honored by today's exchange: the
count-only algorithm, deduplicated matching, and the per-element fuzzy-comparison
expansion. `APPLIED_SETTINGS` is the single source of truth for which, and the
summary carries the resulting flags alongside each term rather than leaving each
renderer to consult it. A surface therefore cannot state a matching behavior the
run does not perform, and cannot forget the caveat for one setting while carrying
it for another.

The three are not equally urgent, and the surfaces place their caveats
accordingly. A proposed count-only algorithm states a DISCLOSURE guarantee, so
its caveat sits with the headline itself, where a reader cannot take the
guarantee as in force without also meeting the caveat. Deduplication and fuzzy
comparison change match multiplicity and breadth, not what is disclosed, so their
caveats sit one expand down with the headlines they qualify.

What each caveat SAYS follows what not applying the setting actually does, and the
three are not alike there. The count-only algorithm and deduplication are refused
at the exchange boundary, so an invitation carrying either aborts before any
identifier is revealed; their caveats name that refusal and what to ask the
inviter for. A caveat saying the run proceeds and reveals more than the headline
promised describes a run that does not happen -- which is what one surface said
about a count-only invitation while the other said the opposite. The fuzzy
expansion has no such refusal: it is a silent no-op that narrows the match, so its
marker says only that the expansion is proposed, and a refusal claim there would be
the same error facing the other way.

That the count-only caveat is a moving target is the reason it is pinned by a
render test on both surfaces: when the count-only run path lands, both flip to the
count-only disclosure statement together, as a deliberate edit rather than a silent
divergence.

The caveat copy is carried once, beside the classification, and rendered twice --
for the same reason the classification is. Two surfaces authoring their own
account of the same unimplemented setting is how they came to say opposite things
about a proposed count-only exchange in the first place.

## Alternatives weighed

**Extend the CLI's own renderer in place.** Rejected: it would re-derive the
field-type labels, constraint phrasing, transform glossary, parameter cap, and
the proposed-versus-applied semantics -- the whole judgment above -- as a second
implementation the representation check cannot tell apart from the first.

**Reclassify the inviter's authored payload declaration as consent-irrelevant,
on the grounds that the received-columns line is better derived from the token's
carried disclosure predicate.** The premise is right and the summary already acts
on it: the line derives from the carried `disclosedPayloadColumns` where the
invitation carries one, falling back to the authored declaration otherwise. That
makes reclassification unnecessary, and it would have cost measurement -- an
excluded field gets no probe at all, so the surfaces would stop being measured on
a field they do represent.

## What a renderer still owns

Two obligations do not transfer with the model.

A value the summary does not carry is that renderer's own responsibility. The
CLI prompt leads with the acceptor's OWN outbound columns, read from the
operator's input file rather than from the partner's token; those reach no
display boundary of their own and are escaped where the renderer emits them,
which is their sink.

Joining is a renderer's decision and a renderer's hazard. The display sanitizer
neutralizes control, bidi, and non-ASCII code points but leaves a printable ASCII
comma intact, so a comma-joined list lets one partner-controlled name read as
two. Both surfaces render every such list one entry per line.

Putting a fact back in front of the operator is also a renderer's decision, and
the shape it takes is the load-bearing part. A terminal has no scrollback the
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

What the repetition carries is a deliberate selection, and what it leaves out is
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
outbound-send list, which is the acceptor's hardest-to-undo consent. That count
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
