---
title: "The built-in linkage rules: provenance, naming, and versioning"
---

# The built-in linkage rules: provenance, naming, and versioning

_Status: decided and built. The two sets are defined in
`packages/core/src/defaults/builtInLinkageTerms.ts` as
`DEFAULT_LINKAGE_FIELD_SET_NAME` / `DEFAULT_LINKAGE_FIELD_SET_VERSION` and
`DEFAULT_LINKAGE_KEY_SET_NAME` / `DEFAULT_LINKAGE_KEY_SET_VERSION`, and the
operator-facing description -- which paths use them and what each name covers
-- is in [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#the-built-in-rules).
Terms drawn from the sets cite them, in
[`linkage_terms.linkage_rule_set`](../EXCHANGE_REFERENCE.md#linkage_termslinkage_rule_set),
so the citation goes with the exchange and is written into each party's record;
what a citation does and does not assert is that field's to state. This note
records what the two sets are, why they are named apart, what the key set's
validation rests on, the criticisms on record against it, and why both names
are neutral. See [docs/notes/README.md](README.md)._

This is design rationale. Nothing here binds an implementation.

## What the names cover

The built-in rules are two artifacts with two names and two versions.

`baseline-pii` names the **linkage fields**: the five PII elements the built-in
rules work from -- `ssn`, `ssn4`, `first_name`, `last_name`,
`date_of_birth` -- each in its standardized form and with the constraints it
has. It is a substrate: it fixes what can be matched on and how each
element is cleaned and bounded, and says nothing about what constitutes a
match.

`hmis-keys` names the **linkage keys**: the fourteen combinations built from
those fields, applied in the order the set lists them. It is the specific
artifact -- which combinations count as a match, and in what cascade order.

Every built-in key is built from the fields of `baseline-pii`, so a citation of
the key set cites the field set with it. The reverse does not hold: the same
substrate supports key sets settled for other uses.

Everything else in a default terms document is a per-party choice made at the
time of the exchange and is outside both names: the party `identity`, the
`date`, the `algorithm`, the linkage strategy, the output preferences, and
`deduplicate`. Two parties can run these rules and still disagree about who
receives output; they cannot run `hmis-keys` and disagree about what a key is.

Terms derived from an input file leave out any key that input cannot supply, so
an exchange matches on a **subset** of the key set, never on an addition to it.
That is what makes describing a run by the set's name accurate: the name is an
upper bound on what was tried, and the terms document that travels with the
exchange still records exactly which keys ran.

## What zero-setup rests on

A zero-setup exchange authors nothing. Each party derives its terms from its own
input file, keeping the built-in keys that file can satisfy, and the two derived
documents are then cross-checked against each other. That works with no
authoring for one reason: every built-in key is built from `baseline-pii`, which
is the guaranteed-minimum PII both parties are sure to bring.

A built-in key over a field outside that substrate would strand the party whose
file does not include it -- `phone_number`, `email_address`, and `zip_code` are
recognized matchable types no built-in field covers. It would do so at run time,
as a cancelled exchange or as terms referencing a field they never declare, and
neither of those names its cause to an operator who authored nothing.

So the property is held by a check rather than by review:
`npm run check:zero-setup-keys` reads the two declared sets and fails a built-in
key whose elements leave the field set, or name a field a zero-setup input cannot
supply by semantic type. Widening the field set stays possible and stays an
explicit decision: its content is pinned, so widening it takes the version
decision below. What the check covers, and what it cannot see, are in the
script's own header.

## Why the fields and the keys are named apart

One name over both would attach the keys' provenance to the fields. The
validation on record, and both criticisms on record, are about which
combinations of PII count as a match -- a judgment made for a particular class
of system. The fields are the generic part: the same five elements, cleaned the
same way, underlie key sets settled for entirely different uses. Naming them
together would mean either extending a specific set's lineage to a substrate
that does not have it, or forcing a use-case-neutral name onto keys that are
use-case-specific.

It would also tie the two versions together. An added constraint would version
the keys, and a reordered cascade would version the fields, each making a
citation of the untouched artifact look stale for a reason that has nothing to
do with it.

## Why the sets are named at all

An anonymous rule set has two costs, and buying them off is what the names
are for. Neither is cosmetic.

**An edit would be silent.** These rules are the artifact a user of the
built-in defaults trusts. With nothing naming or versioning them, any edit --
adding a key, loosening a constraint, reordering the cascade -- changes what
that trust is in with no visible trace, and a user relying on "the defaults" a
year apart would be relying on two different things with no way to tell.

**Nothing else is citable.** Without a name, a data-governance reviewer asking
which rules a linkage matched on can be answered only by quoting fourteen key
combinations out of a config file, or by the unhelpfully circular "the
product's defaults". A name and a version is the artifact that fits in an
agreement, a review memo, or a disclosure log line.

## What the key set's validation rests on

The keys are not derived from a published linkage standard. Their basis is
**operational**: they were developed and validated with partner agencies of the
class the product primarily serves, running against their own administrative
records, and the key combinations the set ships with -- and the order they are
applied in -- are the ones that engagement settled on. That operational
validation is what a user of the built-in rules is relying on, and the whole
of the claim this repository records: no certification, no accreditation, and no
benchmark against a public gold-standard linked file.

Two limits on this note, stated rather than left to be inferred:

- **The engagement's identifying detail is kept out of this repository by
  design.** This repository is public; who the partners were, and what their
  data covered, is not the product's to publish (see [Why both names are
  neutral](#why-both-names-are-neutral)).
- **The underlying measurements are not published here.** No precision or recall
  figure, and no comparison against a named external standard, is on record in
  this repository. A written comparison of these keys against the standards used
  elsewhere for linkage of this class, and a stated evidence bar that any future
  built-in set would have to meet, are both still to be produced.

So what this note supports is the shape of the two sets, the fact that the
keys' provenance is operational validation rather than derivation from a
standard, and the criticisms below. It does not support a claim about measured
accuracy.

The field set has no validation lineage of its own. It is the generic
substrate -- five standardized PII elements with constraints -- and a substrate
is not a claim about matching accuracy: what was validated is which
combinations of it count as a match.

## Criticisms on record

Two criticisms are on record against the key set, and they point in opposite
directions. Both are recorded here because a reader deciding whether to run the
built-in rules should meet them at the same time as the validation claim, not
after adopting the keys.

**They are more permissive than the standards used elsewhere.** The
permissiveness is visible in the keys themselves. Two of them use no SSN
evidence at all -- `LN + FN + DOB`, and the same key with the two names swapped
to catch a reversed-name data entry error. Several match on a truncated name (a
three- or four-character last name, a first initial) rather than a full one, and
several substitute year-and-month of birth for a full date. Each of those is a
recall trade: it exists to match a record a stricter rule leaves unmatched, at
the cost of a wider door for a false match. A standard set for a lower tolerance
of false matches would be expected to challenge exactly those keys.

**Recognized matchable fields go unused.** `phone_number`, `email_address`, and
`zip_code` are semantic types the product recognizes, infers from column names,
and can match on -- and no built-in key references any of them. A party whose
data includes a phone number gets no matching value from it under the built-in
rules; it has to add a key itself. The gap is not an oversight to be closed
by adding keys casually: rules for those fields would have their own
precision/recall consequences and are not covered by the validation these keys
rest on, so they need their own grounding before they could ship as built-in.

What closes the gap without moving the set is offering those types beside it
rather than inside it. The web app's guided key list offers, turned off, one key
per such type its file supplies every element of, and says at the control that
turning one on departs from the validated set.

Each offered key is compound -- the type beside fields the built-in keys already
use -- and never the type alone, on two grounds that agree. A key
over a single identifier is a membership oracle: a party holding a candidate
value learns from the result whether its holder is in the other party's file,
which is the differencing exposure [SECURITY_DESIGN.md](../SECURITY_DESIGN.md)
scopes the guarantee against. And a contact value is a shared value in
program-application data -- one phone number or email address is shared across a
household, and across the people an organization files for -- so a key over one
alone reports different people as the same person. The shapes, the evidence
behind each, and the cascade position each has to sit at are derived in
`docs/notes/linkage-rule-grounding.md`.

One shape per type is the whole offer, not a builder over the types: any other
combination is a rule nothing here has grounded, and authoring one is what the
expert key editor is for. Terms with an added key are not drawn from the set,
so they cite none -- the departure reaches the accepting party's terms review,
not only the operator's screen.

A key over one of these types gets the type's recommended cleaning whichever
door authors it -- the guided offer's checkbox, an imported document, or the
expert key editor. The cleaning is per-party and is never sent, so the accepting
party derives its own from the terms it accepted: a party matching one of these
columns raw would hash `20001-1234` against a partner hashing `20001` and match
nothing, with neither side told. The editor seeds the recommended pipeline
instead, and an operator who wants other steps edits them in the data-prep
workbench, where the change is theirs and visible.

The accurate summary is that the key set is looser than some standards where it
matches, and narrower than the product's own capability in what it can match
on.

## Why both names are neutral

`baseline-pii` names the fields by what they are; `hmis-keys` names the keys by
the class of system they serve. Neither names who validated anything. That is by
design, for three reasons.

1. **The repository is public and the attribution is not the product's to
   publish.** Naming a validating partner in source code publishes an
   association that partner did not agree to publish, permanently and in a place
   nobody can retract it from. Attribution belongs in user-facing communications
   and in an agreement, where it can be made with the partner's consent and
   withdrawn. A system class is not an attribution: `hmis` states the kind of
   system the keys were settled for, which is a property of the keys, not the
   identity of anyone who ran one.
2. **Each name claims exactly the scope its artifact has.** The fields match on
   SSN, names, and date of birth, which is not specific to any jurisdiction or
   program: `baseline` says what they are -- the built-in substrate everything
   else starts from -- with no use case attached. The keys are the narrower
   thing, so their name states the use case rather than implying an
   applicability they have not been shown to have. A single name over both would
   have to be wrong in one direction: general enough for the fields and
   overclaiming for the keys, or accurate for the keys and misleadingly narrow
   for the fields.
3. **A name should not make a claim the repository cannot substantiate.**
   Calling either set "validated" or "certified" in its own identifier would put
   a claim into every citation of it that this repository holds no evidence for
   (see the limits above). These names say what the rules are for; the
   provenance is here, where it can be qualified.

The cost of a neutral name is that the trust anchor -- the engagement that
validated the keys -- is not visible from the identifier. That is what this note
is for, and it is why a citation of the built-in rules is properly a citation of
the names, their versions, and this note together.

## What the versions mean

`DEFAULT_LINKAGE_FIELD_SET_VERSION` and `DEFAULT_LINKAGE_KEY_SET_VERSION`
version the **content** of their own set, and move independently. Neither is
`linkage_terms.version`, which versions the terms document's schema, is
cross-checked between the parties, and travels on the wire; the three are
unrelated and happen to start at the same value.

The rule for editing, one per artifact:

- An edit to the fields -- a field added or dropped, a constraint loosened or
  tightened -- bumps the field set's version.
- An edit to the keys bumps the key set's version. A reorder counts: the order
  is the order the keys are applied in, so moving one changes which key claims a
  record that more than one would match, even though the same fourteen keys are
  present.

The recorded validation attaches to a name and a version together, so an edited
set keeping the old version would leave this note describing rules nobody ran
-- the exact failure the naming exists to prevent. A change that emits the same
fields and the same keys in the same order -- the file reorganized, a comment
rewritten, two properties written in the other order -- alters no rule, and is
the only kind that leaves a version alone. A key's own name is not in that
class: it travels in the terms document, which the two parties compare whole, so
two builds spelling a key differently cancel the exchange between them.

The edit that forgets the bump is the one this rule exists for, and nothing
about a rule written as prose fails when it is forgotten. So the rule is held
by a check: `npm run check:built-in-set-versions` digests each set's declared
content -- the fields with their constraints, the keys with their elements and
their cascade order -- and holds it to the pin `scripts/built-in-set-pins.json`
records for the version the source declares. Content that moved under a recorded
version fails, and a bump is asked to record the pin it ships. What moves the
digest, and what the check cannot see, are in the script's own header.

Two things the versions are not:

- **Not a compatibility negotiation.** Whether two parties' terms agree is
  decided by the terms document itself, field by field and key by key, exactly
  as it was before the sets had names. The citation goes beside those rules
  and is compared where both parties have one, but nothing is negotiated from
  it: two builds shipping different versions of a set do not reconcile them, and
  a party citing nothing is not held to the other's citation. What a version
  buys is that the artifact a record names is identifiable, not that a partner
  can be met halfway on it.
- **Not a migration ladder.** There is no path from one version of a set to
  another and no meaning attached to the semver components beyond ordering.
