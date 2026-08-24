---
title: "The built-in linkage rule set: provenance, naming, and versioning"
---

# The built-in linkage rule set: provenance, naming, and versioning

_Status: decided and built. The set is defined in
`packages/core/src/defaults/linkageTerms.ts` as
`DEFAULT_LINKAGE_RULE_SET_NAME` and `DEFAULT_LINKAGE_RULE_SET_VERSION`, and the
operator-facing description -- which paths use it and what the name covers -- is
in [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#the-built-in-rule-set).
Nothing about an exchange changes because the set has a name: the identifier is
not in an invitation, on the wire, or in an exchange record. This note records
what the set is, what its validation rests on, the criticisms on record against
it, and why the name is neutral. See [docs/notes/README.md](README.md)._

This is design rationale. Nothing here binds an implementation.

## What the name covers

`baseline-pii` names two things and nothing else: the **linkage fields** the
built-in defaults declare, with the constraints each carries, and the **linkage
keys** built from them. Version `1.0.0` versions that content.

Everything else in a default terms document is a per-party choice made at the
time of the exchange and is outside the name: the party `identity`, the `date`,
the `algorithm`, the linkage strategy, the output preferences, and
`deduplicate`. Two parties can run `baseline-pii` and still disagree about who
receives output; they cannot run `baseline-pii` and disagree about what a key
is.

The set as shipped is five fields -- `ssn`, `ssn4`, `first_name`, `last_name`,
`date_of_birth` -- and fourteen keys, applied in the order the set lists them.
Terms derived from an input file leave out any key that input cannot supply, so
an exchange matches on a **subset** of the set, never on an addition to it. That
is what makes describing a run by the set's name honest: the name is an upper
bound on what was tried, and the terms document that travels with the exchange
still records exactly which keys ran.

## Why the set is named

An anonymous rule set carries two costs, and buying them off is what the name is
for. Neither is cosmetic.

**An edit would be silent.** The set is the artifact a user of the built-in
rules trusts. With nothing naming or versioning it, any edit to the fields or
keys -- adding a key, loosening a constraint, reordering the cascade -- changes
what that trust is in with no visible trace, and a user relying on "the
defaults" a year apart would be relying on two different things with no way to
tell.

**Nothing else is citable.** Without a name, a data-governance reviewer asking
which rules a linkage matched on can be answered only by quoting fourteen key
combinations out of a config file, or by the unhelpfully circular "the product's
defaults". A name and a version is the artifact that fits in an agreement, a
review memo, or a disclosure log line.

## What the validation rests on

The set is not derived from a published linkage standard. Its basis is
**operational**: it was developed and validated with partner agencies of the
class the product primarily serves, running against their own administrative
records, and the fields, constraints, and key combinations it ships with are the
ones that engagement settled on. That field validation is what a user of the
built-in rules is relying on, and it is the whole of the claim this repository
records: no certification, no accreditation, and no benchmark against a public
gold-standard linked file.

Two limits on this note, stated rather than left to be inferred:

- **The engagement's identifying detail is deliberately not in this
  repository.** This repository is public; who the partners were, and what their
  data covered, is not the product's to publish (see [Why the name is
  neutral](#why-the-name-is-neutral)).
- **The underlying measurements are not published here.** No precision or recall
  figure, and no comparison against a named external standard, is on record in
  this repository. A written comparison of this set against the standards used
  elsewhere for linkage of this class, and a stated evidence bar that any future
  built-in set would have to meet, are both still to be produced.

So what this note supports is the set's shape, the fact that its provenance is
field validation rather than derivation from a standard, and the criticisms
below. It does not support a claim about the set's measured accuracy.

## Criticisms on record

Two criticisms are on record, and they point in opposite directions. Both are
recorded here because a reader deciding whether to run the built-in rules should
meet them at the same time as the validation claim, not after adopting the set.

**It is more permissive than the standards used elsewhere.** The permissiveness
is visible in the set itself. Two of its keys carry no SSN evidence at all --
`LN + FN + DOB`, and the same key with the two names swapped to catch a
reversed-name data entry error. Several match on a truncated name (a three- or
four-character last name, a first initial) rather than a full one, and several
substitute year-and-month of birth for a full date. Each of those is a recall
trade: it exists to match a record a stricter rule leaves unmatched, at the cost
of a wider door for a false match. A standard set for a lower tolerance of false
matches would be expected to challenge exactly those keys.

**Recognized matchable fields go unused.** `phone_number`, `email_address`, and
`zip_code` are semantic types the product recognizes, infers from column names,
and can match on -- and no key in this set references any of them. A party whose
data carries a phone number gets no matching value from it under the built-in
rules; it has to author a key itself. The gap is not an oversight to be closed
by adding keys casually: rules for those fields would carry their own
precision/recall consequences and are not covered by the validation this set
rests on, so they need their own grounding before they could ship as built-in.

The honest summary is that the set is looser than some standards where it
matches, and narrower than the product's own capability in what it can match on.

## Why the name is neutral

`baseline-pii` names the set by what it is, not by who validated it. That is a
deliberate choice, for three reasons.

1. **The repository is public and the attribution is not the product's to
   publish.** Naming a validating partner in source code publishes an
   association that partner did not agree to publish, permanently and in a place
   nobody can retract it from. Attribution belongs in user-facing communications
   and in an agreement, where it can be made with the partner's consent and
   withdrawn.
2. **The set is general-purpose.** It matches on SSN, names, and date of birth,
   which is not specific to any jurisdiction or program. A name encoding the
   validating engagement would suggest a narrower applicability than the set
   actually has, and would date badly the first time the set is used somewhere
   else.
3. **A name should not carry a claim the repository cannot substantiate.**
   Calling the set "validated" or "certified" in its own identifier would put a
   claim into every citation of it that this repository holds no evidence for
   (see the limits above). `baseline-pii` says what the rules are for; the
   provenance is here, where it can be qualified.

The cost of a neutral name is that the trust anchor -- the engagement that
validated the set -- is not visible from the identifier. That is what this note
is for, and it is why a citation of the set is properly a citation of the name,
the version, and this note together.

## What the version means

`DEFAULT_LINKAGE_RULE_SET_VERSION` versions the **content** of the set. It is
not `linkage_terms.version`, which versions the terms document's schema, is
cross-checked between the parties, and travels on the wire; the two are
unrelated and happen to start at the same value.

The rule for editing: an edit to the fields or the keys bumps the version in the
same change. The recorded validation attaches to the name and version together,
so an edited set carrying the old version would leave this note describing rules
nobody ran -- the exact failure the naming exists to prevent. A change that only
renames a key, or reorders the file without changing which keys are produced, is
not a content change and is the only kind that leaves the version alone.

Two things the version deliberately is not:

- **Not a compatibility negotiation.** It is not exchanged and is not checked
  against the partner's. Whether two parties' terms agree is decided by the
  terms document itself, key by key, exactly as before.
- **Not a migration ladder.** There is no path from one version of the set to
  another and no meaning attached to the semver components beyond ordering.
