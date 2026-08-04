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

## Proposed is not applied

Three settings an inviter may declare are not honored by today's exchange: the
count-only algorithm, deduplicated matching, and the per-element fuzzy-comparison
expansion. `APPLIED_SETTINGS` is the single source of truth for which, and the
summary carries the resulting flags alongside each term rather than leaving each
renderer to consult it. A surface therefore cannot state a matching behavior the
run does not perform, and cannot forget the caveat for one setting while carrying
it for another.

The three are not equally urgent, and the surfaces place their caveats
accordingly. A proposed count-only algorithm states a DISCLOSURE guarantee the
run does not honor -- not applying it means the exchange reveals more than the
headline promises -- so its caveat sits with the headline itself. Deduplication
and fuzzy comparison change match multiplicity and breadth, not what is
disclosed, and not applying them makes the run match less than proposed, which
is the safe direction.

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
display boundary of their own and are escaped at the log call, which is their
sink.

Joining is a renderer's decision and a renderer's hazard. The display sanitizer
neutralizes control, bidi, and non-ASCII code points but leaves a printable ASCII
comma intact, so a comma-joined list lets one partner-controlled name read as
two. Both surfaces render every such list one entry per line.
