---
title: "Grounding the Built-In Linkage Rules: Comparison, Candidate Rules, and an Evidence Bar"
---

# Grounding the built-in linkage rules: comparison, candidate rules, and an evidence bar

_Status: proposal, pending adoption. Nothing here is adopted and nothing here is
shipped: the built-in field and key sets are unchanged, and what they are, what
their validation rests on, and the criticisms on record against them are in
[default-linkage-rule-set.md](default-linkage-rule-set.md). This note supplies
the three things that one records as still to be produced -- a comparison of the
built-in keys against named external standards and operating practice, candidate
rules for the three recognized matchable fields no built-in key uses, and the
evidence a candidate built-in set would have to show before it could ship. See
[docs/notes/README.md](README.md)._

This is design rationale. Nothing here binds an implementation.

## How to read the citations

Every claim below is sourced to a primary document. Those documents live in a
**host-local reference library that is not part of this repository** and is not
distributed with it, so a citation here does not resolve for every reader.

Each is therefore cited by title, year, and the filename it uses in that
library (`research/linkage/<filename>`), and every source named is a public
document whose title and year are enough to find it independently. Where a claim
rests on a secondary reading rather than a primary document, the note says so in
the sentence that makes the claim. The full list, with what each one is, is in
[Sources](#sources).

Three of the sources have limits that several claims below depend on:

- The published PPRL token sets are read from **shipped code and configuration**,
  not from a specification their authors wrote. linkja publishes no key spec, and
  Datavant publishes no enumeration of its numbered tokens; what is citable is
  what the software emits.
- The three NCHS methodologies fetched here are **probabilistic** linkages with a
  short deterministic pre-pass. They do not run an ordered key cascade, so they
  cannot directly adjudicate a question about cascade order; where this note
  draws on them for that question, it says the inference is analogical.
- Two of the per-key measurement sources report **precision and recall within a
  blocked candidate set on one institution's data**. They are the only per-key
  figures published anywhere, and they are not a benchmark.

## What is being compared

The built-in rules are two artifacts: the `baseline-pii` field set (five
standardized PII elements) and the `hmis-keys` key set (fourteen key combinations
over them, applied in the order the set lists). Both are declared in
`packages/core/src/defaults/builtInLinkageTerms.ts`; what they cover and how they are
versioned is [default-linkage-rule-set.md](default-linkage-rule-set.md), and this
note does not restate either.

Two properties are compared, and they are separate questions:

- **Membership** -- which combinations of PII count as a match.
- **Cascade order** -- which key claims a record that more than one key would
  match. Under the default `cascade` strategy each round excludes the records an
  earlier key already matched, so order is matching behavior and not
  presentation; the strategies and what each discloses are in
  [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#linkage_termslinkage_strategy).

The shape of the shipped key set, as a reader of the comparison needs it:
twelve of the fourteen keys have SSN evidence (ten a full SSN, two the last four
digits) and two have none; ten have a last name and four do not; eight have a
first name in some form. Every key is over the five-element substrate, and no key
references `phone_number`, `email_address`, or `zip_code` -- the three matchable
semantic types the product recognizes and no built-in field covers.

## The standards, and what each of them is

A comparison is only as good as its claim about what it is comparing to. The
sources fall into four classes, and only two of them contain matching rules at
all.

### HUD HMIS is a collection and export standard, not a matching standard

The standard psilink's primary user class exports from defines **what is
collected and how it is coded**, and by design does not define how records are
matched. Its nearest approach is the Personal Identifier element, which names a
candidate field pool -- Name, Social Security Number, Date of Birth, Race and
Ethnicity, Veteran Status -- and then hands the whole decision to the vendor:
there is a one-to-one relationship between the identifier and those elements "or
a combination of these that provides a high degree of confidence that multiple
client records represent the same individual" (HMIS Data Dictionary, 5.08). No
weights, no order, no threshold, and no definition of "high degree of
confidence". The one imperative about matching anywhere in the standards is
graded down to a suggestion: software "must allow for the entry of partial SSNs
and should allow for the effective matching of partial SSNs", with administrators
told to work with their vendor to understand how their own system does it (HMIS
Data Standards Manual, 3.02).

So HMIS cannot be compared against on membership or order. What it does
determine is what the built-in keys have to work with, and there it is decisive
on four points:

1. **A partial SSN is normal, not degraded.** PATH, CoC, and ESG projects "are
   only required to collect the last four digits of the SSN" and are "not
   penalized" for stopping there (Data Standards Manual, 3.02). An SSN4-only
   record is compliant collection.
2. **HUD's own hashed export already has the SSN4 construction.** In a hashed
   CSV export the SSN field is the "concatenation of the unhashed last 4 digits
   of the SSN followed by SHA-256 hash of the full SSN", with a lower-case `x`
   filling any missing digit before hashing; names are exported as the hash of
   their SOUNDEX; and exactly four fields are hashed, "and no others", which
   leaves date of birth in the clear (HMIS CSV Format Specifications, Hash
   Status).
3. **A partial SSN is not necessarily an SSN4.** The export field is
   `^[0-9xX]{9}$`, and HUD contemplates a hole in any position: "Because missing
   digits may appear in any one of the nine placeholders, it is critical for the
   system to have a mechanism to indicate which digits were missing" (Data
   Dictionary, 3.02).
4. **Names are permitted to be fabricated, and the record says so.** Name Data
   Quality code 2 covers "a placeholder name such as a street name or code name
   for street outreach clients or a name modification made for security reasons",
   and codes 8 and 9 are for a "false name/made up name" entered solely to create
   a record. HUD's own example of a code name is "Redhat Tenthstreetbridge",
   later edited to "Robert" (Data Standards Manual, 3.01). An approximate date of
   birth is the same phenomenon in a stricter shape: where the client cannot
   recall month or day, the instruction is to "record an approximate date of '01'
   for month and '01' for day", with a Continuum permitted to keep a different
   house filler.

Points 1 and 2 are the counterpart the built-in `ssn4` field was said to lack.
Point 4 is a hazard the comparison returns to below: it is a **shared
convention**, and a shared convention manufactures agreement that is not
evidence.

### The health-sector attribute analyses

Two health-sector documents grade identifiers rather than publishing rules, and
between them they supply most of the quantitative footing this note has for the
three unused fields.

**The Sequoia Project's identity-management framework** rates every candidate
attribute on completeness, validity, distinctiveness, comparability and
stability, measured against one health system's six-and-a-half-million-record
master patient index. The rows that matter here:

| Attribute | Completeness | Validity | Distinctiveness | Stability |
| --- | --- | --- | --- | --- |
| SSN | 61.40% | 60.92% | 98.0% | High |
| Date of birth | 98.18% | 97.38% | 0.8% | Very High |
| Last name | 99.85% | 99.84% | 5.1% | High |
| First name | 99.85% | 99.33% | 3.1% | High |
| Primary phone number | 90.68% | 87.26% | 51.6% | Medium |
| Work phone number | 20.28% | 19.79% | 51.6% | Low |
| Postal code | 92.31% | 92.0% | 0.6% | Low |
| Street address | 95.00% | 94.61% | 44.4% | Low |

There is **no email row**: email appears only as a future candidate. The
framework's own verdict on the two fields it does grade is that they earn their
place only in company -- "Postal code and primary telephone number also look
promising when combined with other demographics ... Even though postal code by
itself if not highly distinctive, the fact of it being numerical and collected by
most organizations can make it an attractive trait, when combined with other
traits, for patient matching" (the "if not" is the source's own typo). It also
warns the other way: "More data do not necessarily mean better patient matching
results ... traits with poor validity and comparability may cause a decrease in
matching performance."

Its second table is the closest published measurement to a psilink cascade rung.
Seven trait combinations were scored for completeness (the share of records
having every trait) and uniqueness (the share of matches resolving to a single
person):

| Combination | Completeness | Uniqueness |
| --- | --- | --- |
| First + last + date of birth | 98.2% | 95.7% |
| ... + sex | 98.2% | 95.9% |
| ... + sex + ZIP5 | 91.1% | 99.2% |
| ... + sex + phone | 76.2% | 99.5% |
| ... + sex + middle name | 59.9% | 98.9% |
| ... + sex + middle initial | 60.0% | 97.7% |
| ... + sex + SSN4 | 61.9% | 99.7% |

Read against a cascade: adding ZIP5 costs 7.1 points of reach to buy 3.3 points
of uniqueness, adding a phone costs 22.0 to buy 3.6, and adding an SSN4 costs
36.3 to buy 3.8. The framework then ordered the *phone* rule at highest
precedence, above both the SSN4 rule and the ZIP rule, and does not say why.

**Pew's patient-matching report** is qualitative on the same fields, and the
useful part is its caveats rather than its recommendations. Its one hard number
is availability over time across nine health systems: email rose from 9% to 54%
of records between 2005 and 2014 while SSN fell from 83% to 50%. Its
recommendation section calls a phone number "a persistent and unique data
element", which its own body text contradicts ten pages earlier -- phone
verification "is still limited in its ability to improve matching because
patients may change numbers, share them with other individuals, or fail to
effectively respond to requests for verification" -- and which its own finding on
the population psilink serves contradicts harder: of 421 homeless adults studied
in 2017, 94% owned a cellphone, but "most had experienced high phone and phone
number turnover in the preceding three months".

**The 2014 federal patient-matching report** adds the only published
false-positive figures that include a ZIP. On a 42,000-record sample, first name
plus last name plus birth year plus ZIP gave about one possible false match in
3,500; on an 80-million-record file, last name alone ran at 98% false positives,
adding date of birth brought it to 33%, and adding first name, ZIP and the last
four SSN digits brought it to one in 39 million. It also records the field's own
disagreement about stability: organizations "disagree on which data attributes are
stable, with each noting situations where nearly every data attribute would be
unstable", and phone and address were reported "less transient" in rural areas
than urban ones.

**Project US@** is the one federal specification aimed squarely at one of the
three fields, and it is address-only -- it says nothing at all about phone or
email. Two of its normative rules transfer directly. It prescribes an explicit
missing sentinel and forbids matching on it: where a component is unknown the
field should be blank, and if it is not blank then `UNKNOWN` must be entered, and
"Patient matching algorithms SHOULD NOT match on the value UNKNOWN". And it types
a shelter as a business address, with a separate optional flag for a patient
known to be homeless whose guidance is to collect "any available data from the
patient (e.g., ZIP Codes may valuable)" -- ONC's own judgement that where the
address is unusable, the ZIP is the fragment worth keeping.

### The operating cascades

Three published deterministic cascades are close enough in shape to compare
against.

**Maryland's longitudinal data system**, read here through a secondary survey
rather than from its own publication, runs a numbered deterministic cascade it
calls *orders*, tried strictest first, stopping at the first that hits and
recording which one it was: (1) everything agrees exactly including SSN,
(2) keep the SSN requirement while dropping corroborating fields in turn,
(3) SSN only, (4) name and date of birth with no SSN at all. Fuzzy matching and
then clerical review take what the cascade misses. This is the closest published
analogue to the built-in cascade, and its order is the opposite arrangement: every
SSN-bearing rule sits above the no-SSN name-and-date rule, and the SSN-only join
survives only as a named weaker rule *below* the corroborated one.

**The Census Bureau's person-key system**, also read through that secondary
survey, is a cascade of modules in which a record stops as soon as it earns a
key. Its exact *Verification* module runs only for a record that has an SSN, and
assigns a key only when the SSN **and** the name **and** the date of birth
agree; a record without an SSN, or one that failed verification, falls through
to probabilistic search modules on name, date of birth, sex and address. One of
those passes swaps first and last name by design to catch a reversed entry --
and it is placed late, after the modules that do not.

**NCHS's linkages** run a two-pass deterministic SSN stage before a fourteen-pass
probabilistic stage. The deterministic stage is a genuine strictest-first
cascade with first-match-claims semantics -- full SSN first, then last-four, with
survey participants "excluded from the second pass ... if they were
deterministically linked in the first pass" -- and it demands **more**
corroboration of the weaker key, not less: a ratio of agreeing to non-missing
identifiers above one half for the full SSN, above two thirds plus at least five
agreeing fields for the last four.

Two things these cascades do NOT determine, stated plainly because it would be
easy to over-read them:

- **None publishes per-position precision.** No source in this library publishes
  an ordered cascade with a measured false-match rate per position. That is
  genuinely unpublished, not merely unfetched, and it is exactly the measurement
  an order argument would want.
- **The NCHS fourteen passes are not a cascade.** They are "multiple, overlapping
  blocking passes", combined afterwards, with pass-local scores explicitly "not
  comparable"; the best link is selected by probability, then by SSN quality, then
  at random -- never by pass order. Any ordering inference from them is
  analogical.

### The PPRL token sets

The exact-key deployments publish sets, not cascades, and this is the sharpest
structural difference between them and the built-in rules.

**linkja** emits eleven hashes per record: one over the site's own patient
identifier, four identity hashes with no SSN, and six with one. The
SSN-bearing hashes are generated *alongside* the others, guarded by a single
condition -- "Only perform SSN hashes when SSN is set" -- rather than instead of
them. The set has no order or priority: matching is a separate component. Two
details matter for the comparison. First, linkja's variants are aimed at named
error modes: a swapped name order, a transposed day and month, a date off by one
day, a date off by one year, and a first name truncated to three characters --
the same catalogue of failures the built-in keys address with truncations and a
swap. Second, and more consequential, **linkja's "SSN" is the last four digits**:
its normalization strips non-digits and keeps the rightmost four, so every
SSN-bearing linkja hash is an SSN4 hash.

**The N3C linkage's shipped configuration** generates eighteen tokens per record
over a nine-column input of record id, first name, last name, date of birth,
gender, SSN, ZIP, email and cellphone. Its three SSN-bearing tokens are `SSN +
Gender + DOB`, `SSN + DOB`, and `SSN + First Name`. Eight tokens have a ZIP,
four at three digits and four at five, and every one of the eight also has a
last name. Email appears in exactly one token (`First Name + Email`) and
cellphone in exactly one (`First Name + Cell Phone Number`).

**CODI** specifies a field set -- including household ZIP and street address as
required, household phone and email as optional -- and then declines to specify
keys at all: "The exact details of the obfuscation or the data elements used are
not specified by this IG", and "The exact procedures for determining a match are
not specified in this implementation guide."

All three treat a missing field the same way psilink does -- the property that
makes the two-party restatement below work: a missing or invalid field yields
**no token for every key that uses it**, never a null value or a downweighted
comparison. The N3C guide states it with a worked example -- if only gender is
invalid and every other field is valid, the token that uses gender "will not be
generated for that record".

## Membership: where the built-in set sits

### Where it has a direct counterpart

Most of the built-in set is unremarkable against published practice, and saying
so is part of an accurate comparison. The relation column states which way each
published key differs from the built-in one, because "counterpart" alone hides
whether the published key is the same key, a stricter one, or a looser one.

| Built-in key shape (positions) | Published key | Relation |
| --- | --- | --- |
| SSN + last name + date of birth (1, and 4 and 6 with the last name truncated) | linkja `fnamelnamedobssn` / `lnamefnamedobssn`; N3C `token_39` (`SSN + DOB`) | The linkja hashes add a full first name and have only an SSN4 in linkja's normalization, so they are stricter; `token_39` drops the last name, so it is looser |
| SSN + truncated first name + date of birth (7) | linkja `fname3lnamedobssn`; N3C `token_6` | Both truncate the first name to three characters the same way, and both are stricter: each adds a full last name, and `token_6` a gender and a ZIP3 |
| SSN4 keys (8, 9) | linkja's entire SSN-bearing set; NCHS's second deterministic pass; HUD's own hashed-export SSN construction | A counterpart for the SSN4 construction rather than for the key shape: linkja's SSN4 hashes all have both whole names |
| Year-and-month in place of a full date (5, 9, 13, 14) | N3C `token_18` | The same coarsening. linkja does not coarsen: for the same class of date error it emits extra whole-date variants -- transposed day and month, date off by one day, date off by one year |
| Last name + first name + date of birth (10) | N3C `token_38` | The same key. Measured only in its gender-bearing variant, Bernstam's Token 4 |
| The name-swapped twin (11) | linkja `lnamefnamedob*`; the Census person-key system's swapped-name pass (a secondary reading) | The same device |
| SSN + first name + a date component, no last name (12 to 14) | N3C `token_16` (`SSN + First Name`) | Looser: the token has no date component at all, so each built-in key refines it. Bernstam measured the token at 99.6% precision, 61.1% recall |

The built-in keys at positions 12 to 14 have often been described as having no
published counterpart; the accurate statement sits between that and a match.
`SSN + First Name` is a shipped token in the N3C configuration and one of the
eight tokens Bernstam scored, and each of the three built-in keys is that token
plus a date component -- a whole date at position 12, a year and month at 13 and
14, with 14 also truncating the first name. They are refinements of a measured
token, not instances of it. Every pair a built-in key matches, `token_16` would
match too, so the token's measured false pairs bound the built-in keys' from
above; the 99.6% precision figure itself does not transfer, because the added
date component removes true matches along with false ones and precision is a
ratio of the two. It is an upper-bound analogy on the false-match rate, not a
figure these keys inherit.

### Where it is more permissive

Three divergences are real, and each is a recall trade bought at a wider door.

**Truncated names have keys that published sets keep whole.** Five built-in
keys match on a three- or four-character last name, and two on a first initial.
The published sets truncate too, but they truncate the *first* name and keep the
last name whole: linkja's `fname3lnamedob*` and N3C's `token_6` and `token_7`
both take the first three characters of the given name against a full family
name. No linkja hash and no N3C token truncates the last name. The nearest
published set that truncates a surname is Australia's SLK-581, a single fixed key
built from letters of both names plus date of birth and sex, which -- on a
secondary reading of a six-dataset comparison against unions of match-keys -- fell
as low as 24% recall on one file and 7% precision on another.

**Two keys have no SSN evidence at all**, which is stricter-sounding than it is:
N3C's `token_38` (`Last Name + First Name + DOB`) is exactly the first of the
two, the second being its name-swapped twin, and the NCHS eligibility rule for
linkage requires only two of the three groups
`{SSN, name, date of birth}`, so a name-plus-date record with no SSN is fully
eligible there too. What is unusual is not the key's existence but its position,
which is the cascade-order question below.

**Four keys have no last name.** Positions 7 and 12 to 14 pair an SSN with a
first name (whole or truncated to three characters) and a date of birth (whole or
coarsened to year and month). N3C's `token_16` is the nearest published shape,
and it is looser rather than equal: `SSN + First Name`, with no date component at
all. Where the published sets differ is that a key of theirs with no last
name is anchored on something high-cardinality -- an SSN in `token_5`,
`token_16` and `token_39`, an email or a cell phone in `token_29` and `token_30`
-- and is never *also* coarsened: `token_16` has a whole first name and
nothing else, where built-in position 14 has a three-character first name
against a year and month. That combination -- SSN plus three characters of a
given name plus year and month of birth -- has no counterpart in any set read
here.

### Where it diverges in kind

**No gender.** Gender is a standard corroborator in the one published set that
collects it: nine of the eighteen N3C tokens have it, including the SSN-bearing
`token_5` (`SSN + Gender + DOB`), and Bernstam's Tokens 1, 2, 4, 5 and 7 all
have it. It is not universal -- N3C's `token_16` and `token_39` have an SSN and
no gender, and linkja has no gender field at all -- but the built-in field set has
no gender element, so every built-in analogue of a gender-bearing key has one
fewer corroborating field. The evidence on what that costs cuts both ways and is
set out under cascade order below: gender is the field Grannis credits, with
first name, for protecting against the dominant SSN error, and it is the field
NCHS dropped from
scoring after finding it had "minimal contribution as a scoring variable and is
highly correlated with first name agreement".

**No phonetic encoding.** N3C (`token_2`, `token_24`) and HUD's own hashed export
have a phonetic name form, HUD by hashing the SOUNDEX of each name component.
linkja does not: its shipped hashes use whole names, a name-order swap, a
three-character first name and date perturbations, with no phonetic step anywhere
in its normalization. The built-in keys have none either, using prefix truncation
instead, and that is a defensible divergence rather than a gap. On a secondary
reading of the one controlled study of cleaning, Soundex on surnames raised that
field's recall from 98.8% to 99.5% while cutting the share of its matches that
were correct by 65%; on a secondary reading of a federal evaluation of commercial
matching systems, the vendor token set that returned more false pairs than true
ones on the cleanest data was driven by a phonetic name token. Truncation makes
the same trade with a smaller and more predictable window.

**No standardization difference is being papered over.** The three unused fields
already have shipped standardization pipelines producing exactly the forms the
published token sets consume -- a ten-digit phone, a lowercased address, a
five-digit ZIP with its leading zero restored (see
[DEFAULT_STANDARDIZATION.md](../spec/DEFAULT_STANDARDIZATION.md#zip_code)). What
is missing is keys, not substrate.

### Where it is narrower than its own capability

`phone_number`, `email_address`, and `zip_code` are recognized, inferred from
column names, standardized, and matchable -- and no built-in key uses any of
them. The candidate rules below are the answer to what could, and what evidence
would have to come first.

## Cascade order

### The question, stated

The built-in keys are applied in the order the set declares, and a record matched
by an earlier key is excluded from every later round. Order therefore decides
which key claims a record that more than one would match, and it can change the
match set rather than only its attribution: a record claimed by an earlier key
is no longer available to a later one that would have paired it with a different
partner record.

Two order facts about the shipped set matter before the evidence, and both are
checkable against the declaration:

- The two keys with no SSN evidence (`LN + FN + DOB` and its name-swapped
  twin) sit at positions 10 and 11, ahead of three SSN-bearing keys at 12 to 14.
- A key with an SSN but no last name already sits at position 7
  (`SSN + FN3 + DOB`), ahead of both. So the set does not in fact place all of
  its no-last-name keys below the name keys; it places one above and three below.

### What the published cascades order on

Where a published cascade exists, it is ordered strictest-first on the strength
of its SSN evidence, and the no-SSN name rule is its floor rather than its
middle. Maryland's four orders, on the secondary reading above, run from
everything-agrees down to SSN-only and only then to name-and-date-with-no-SSN.
The Census person-key system, on that same secondary reading, runs its exact
SSN-and-name-and-date verification first and everything else after. NCHS's
deterministic pre-pass runs full SSN, then last-four, and demands *more*
corroboration of the weaker key, and places its swapped-name handling late, as
the Census system does on that same secondary reading.

Set against that, the built-in order is the opposite arrangement at positions 10
to 14. Nothing in this library publishes an ordered cascade that places a no-SSN
name key above an SSN-bearing one.

### What the per-key measurements say

The order argument the cascades make is not, however, an argument from measured
precision, because no cascade publishes precision per position. The measurements
that do exist are per-KEY, from unordered token sets, and they point the other
way.

| Key | Precision | Recall | Fill |
| --- | --- | --- | --- |
| Last + first + gender + DOB | 99.9% | 64.8% | 99.99% of pairs |
| Last + first-3 + gender + DOB | 98.5% | 88.6% | 99.99% |
| Last + first initial + gender + DOB | 97.9% | 90.3% | 100% |
| SSN + gender + DOB | 99.7% | 87.7% | 3.89% |
| SSN + first name | 99.6% | 61.1% | 3.89% |
| Cell phone alone | 95.6% | 52.1% | 68.01% |

Two readings follow, and both are narrow. First, the whole-name-plus-date key is
measured as the **most precise** of the eight tokens scored -- more precise than
either SSN-bearing token -- which is the reverse of the intuition that an SSN key
is by construction the stricter one. Second, the SSN-plus-first-name token, which
the built-in keys at positions 12 to 14 refine by adding a date component,
measures at 99.6% precision, so a key of roughly that shape is not weak in
absolute terms either -- an analogy for those keys rather than a measurement of
them, on the reading set out in the membership comparison. Sequoia's
uniqueness column orders the same way at the top: a name-and-date key plus SSN4
reaches 99.7% and a name-and-date key plus a phone reaches 99.5%, and Sequoia
placed the phone rule above the SSN4 rule.

The limits on both readings are real and should travel with them. The precision
figures come from deduplicating one institution's records inside a blocked
candidate set, against a manually adjudicated truth; the two SSN tokens were
scored on the 3.89% of pairs where both records had an SSN. Sequoia's figures
are one health system's internal analysis, and the framework says so: "It remains
to be determined how these introspectively-derived rules would work across
organizational boundaries."

### The SSN failure mode nobody's ordering rule addresses

The oldest per-identifier study in this library found that using an SSN as the
exclusive linkage variable produced error rates of 9.2% and 4.7% at two
hospitals, and then characterized what the errors were. The most common was a
spousal mix-up -- 56% and 39% of errors -- "in that a female of one record was
linked to a male record sharing the same last name", almost certainly a
guarantor's number recorded for the beneficiary. Its conclusion names the remedy:
"Additional linkage identifiers such as gender and first name help to avoid
incorrect links between beneficiaries and guarantors", and "Linkage criteria that
include SSN combined with variables from both name and birth date maximize the
match rate while keeping the false positive rate near zero."

That is a direct complication for any rule of the form "an SSN must be
corroborated by a last name". The dominant SSN error *shares* the last name. In
that study's own key comparison, `SSN + last name + first name` produced seven
and two incorrect links (98.7% and 99.3% specificity), while `SSN + phonetic
first name + birth month + gender` and the no-SSN
`last + first + month + day + year + gender` key each produced **zero** incorrect
links at both hospitals. Its gold standard was built from SSN-agreeing pairs, so
the false pairs it scored against are precisely SSN collisions -- the population
where a name-and-date key is at its best -- and its no-SSN key includes gender and
a full date of birth, neither of which the built-in `LN + FN + DOB` has.

A last-name corroboration rule for a degraded SSN does exist in the literature,
in NCHS's survey-to-death-index methodology, read here through a secondary survey
rather than from the methodology itself: a class for pairs disagreeing on
three or more digits zeroes the SSN weight outright and requires last name and
sex to agree, on the reasoning that the number is either miskeyed or the
spouse's. Two qualifications belong with it. It is from the death-index
methodology, not from the three NCHS Medicaid and HUD methodologies fetched here,
which have no such rule -- their SSN thresholds (eight digits for one purpose,
fewer than five for another, seven for a third) all govern estimation and error
measurement rather than a veto. And it pairs the last name with **sex**, which
NCHS elsewhere dropped from scoring after finding it had "minimal contribution as
a scoring variable and is highly correlated with first name agreement".

### What does not transfer: two-party exact intersection

Every error model above comes from linking a file against a reference file, or
deduplicating one file, in clear text. A two-party exact-key intersection is a
different failure geometry, and three differences change what the evidence means.

**A false match must be SHARED.** A match happens only when both parties
independently derive the same key string. An error confined to one party does not
create a false match -- it destroys the key and costs a missed match instead. A
false match therefore requires either a genuine collision (two different people
whose true values agree on every element of the key) or an error present in
*both* files. The wife recorded under her husband's SSN at one agency and again
at the other is, under intersection, a correct match on a wrong number; the same
record matched against a reference file holding the husband is a false link. So
the reference-file error rates are an upper bound here, not an estimate.

**Shared error is not rare, and standards manufacture it.** The mechanisms that
put the same wrong value in two files are exactly the ones a shared operating
context supplies: a client repeating a code name, a document copied between
agencies, and above all a shared convention. HUD's approximate-date rule --
record `01` for month and `01` for day -- is a convention that makes two
independently-collected records agree on a date neither one knows, and a Continuum
running a different house filler makes its own local pool of agreement instead.
`baseline-pii` excludes two placeholder SSNs by constraint and requires validity,
which handles the analogous SSN case; nothing analogous bounds a filler date or a
placeholder name, and the data-quality codes that would flag both are not
matchable fields.

**A missing field yields no key, not a zero weight.** A record whose value for
any element of a key is absent contributes nothing to that key's round and stays
eligible for later keys. That is the same behavior the published token sets have,
and it has a measurement consequence the per-record fill columns hide: a key's
reach is the JOINT fill across both parties. The phone token's per-record fill
was 94.6% and its **pair** fill was 68.01%. A candidate rule's reach must be
quoted as a pair fill rate or it is overstated.

There is also a fourth difference, of a different kind. The published cascades
lean on a reference file that holds every name a person ever had -- the Census
system's alternate-name reference data and the death index's father's-surname
retrieval criterion, both secondary readings. A rule that demands a name
alongside a perturbed number can afford to, because it never lost the earlier
name. Two administrative files with
one name each cannot import that rule without paying for it in the people whose
surname changed between their two records.

### The disposition is open

This section sets out the evidence on both sides and does not, by design, decide
the built-in cascade's order. The choice between reordering the set (a content
change, taking a key-set version bump) and re-documenting it (the order is
deliberate and the precision claim in the source comment is what is wrong) is a
decision for the maintainer, not for this note.

## Candidate rules for the unused fields

### The substrate already exists

Nothing needs to be built to standardize these three. The shipped pipelines
already produce exactly the forms the published token sets consume -- ten digits
for a phone with a leading US country code stripped, a lowercased `local@domain`
shape, and a five-digit ZIP with a ZIP+4 truncated to its prefix and a New
England leading zero restored
([DEFAULT_STANDARDIZATION.md](../spec/DEFAULT_STANDARDIZATION.md#zip_code)). What
is missing is keys.

### A constraint that governs all three candidates

None of these fields can enter the BUILT-IN zero-setup set as things stand. The
zero-setup property holds because every built-in key is over the
guaranteed-minimum substrate both parties are sure to bring; a key over a field
outside it strands the party whose file does not have it, at run time, on an
operator who authored nothing. That property is held by a check rather than by
review, and the check fails a built-in key naming any of these three fields
(`npm run check:zero-setup-keys`; see
[default-linkage-rule-set.md](default-linkage-rule-set.md)). A candidate rule
over them is therefore necessarily a rule of an ALTERNATE selectable set, not an
addition to the default -- or it takes a deliberate widening of the field set,
whose consequences for zero setup would have to be argued separately.

A second constraint follows from the cascade. A candidate key that is a strict
refinement of an existing key -- the same elements plus one more -- matches a
subset of what the looser key matches, so it must be placed ABOVE that key or it
can never fire. Three of the candidates below are strict refinements of the
built-in `LN + FN + DOB` key -- the two ZIP forms and the compound phone form --
so each of those is a placement decision as much as a membership decision. The
rest stand in no refinement relation to any built-in key:
`LN + FN + YOB + MOB + ZIP5` coarsens the date while adding a ZIP, so it is
neither narrower nor wider, and the two thin contact keys share no shape with any
built-in key at all.

### The bearing of the served population, stated once

**HUD's standards collect no client phone number, no client email address, and
no client ZIP code.** There is no "last permanent address" element; the only ZIP
in the standards is the project's, and the only client geography is a Continuum
of Care code covering a county or a region. A party exporting from a standard
HMIS therefore has none of these three fields to bring, whatever rules exist for
them. That does not make the rules pointless -- the counterparty in an
HMIS-to-Medicaid exchange is a claims system that does have a ZIP, and an HMIS
implementation may collect contact information outside the federal elements --
but it does mean a candidate rule's realistic pair fill rate on this user class
is bounded by whichever side has the field, which is at most one of them.

### `zip_code`

**Never alone, and never without a name.** The evidence here is unusually
consistent. ZIP's distinctiveness is measured at 0.6% -- lower than every other
attribute graded except sex, race, ethnicity and the name suffix. All eight
ZIP-bearing tokens in the N3C configuration have a last name and a first-name
component; none stands alone. And the key-design analysis of frequency attacks
on hashed match-keys found that two- and three-attribute keys retain a discrete
frequency
distribution, with frequencies approaching uniform only "with match-keys with
four or more attributes".

Candidate shapes, in the order they would have to sit relative to the existing
keys:

| Candidate | Basis | Placement |
| --- | --- | --- |
| `LN + FN + DOB + ZIP5` | N3C `token_26` exactly; the measured `FN+LN+DoB+Sex+ZIP5` combination reached 99.2% uniqueness at 91.1% completeness | Above `LN + FN + DOB`, which it refines |
| `LN + FN + DOB + ZIP3` | N3C `token_3` exactly; ZIP3 trades locating power for tolerance of a move within a metro | Above `LN + FN + DOB`, below the ZIP5 form |
| `LN + FN + YOB + MOB + ZIP5` | N3C `token_18` without gender; recovers a day-of-birth error at the cost of a coarser date | Below both, and below `LN + FN + DOB` |

**Precision rationale.** Adding a ZIP5 to a name-and-date key bought 3.3 points
of uniqueness in the one published measurement, and the only published
false-positive figures that include a ZIP put first name plus last name plus
birth year plus ZIP at about one false match in 3,500 on a 42,000-record file.
Both are consistent with ZIP as a corroborator that meaningfully narrows a
name-and-date collision -- which is precisely where the built-in set's exposure
is, since `LN + FN + DOB` is a key two different people can satisfy correctly.

**Recall rationale, and the caution.** ZIP's stability is rated **Low**, and the
one longitudinal figure in this library is severe: in a state voter file, street
address changed in 47.7% of records between snapshots eight years apart. A
general-population master patient index was observed to go stale at about 1% per
month across name, address and phone jointly. For a population defined by housing
instability, and for whom the recorded ZIP may be a shelter's, both the churn and
the sharing run worse than any of these figures, and neither has been measured.
The federal address specification's own advice for a patient known to be homeless
is nonetheless that the ZIP is the fragment worth collecting.

**What is not known.** No m/u value, precision, or recall for ZIP alone has been
published in any sector. The one methodological rule that is published is
conditioning: a ZIP agreement probability is computed only over pairs whose state
of residence agrees, "i.e., if state was not in agreement then it would be
assumed that ZIP code would also not agree" -- a rule with no direct analogue in
an exact-key design, but a warning that ZIP agreement is not independent of the
geography around it.

### `phone_number`

**The one contact field with a published measurement, and the least stable one
for this population.** A cell-phone-alone token measures at 95.6% precision and
52.1% recall at a 68.01% pair fill rate -- the lowest precision of the eight
tokens scored, and the only one below 97%. The one published exclusion of a phone
token is the study authors' own evaluation choice, not a vendor policy: they
assembled the multi-token combinations they scored themselves, "by considering
common matching strategies across sites", and their note on the combination they
called Net Tokens says tokens based on email, phone, or address "are often most
prone to error on input". It has the weight of one research team's judgement
about their own experiment, and not even consistently: the combination they
defined retains the address-bearing token that same note excludes. The one
shipped configuration that has a phone pairs it with a first name
(`First Name + Cell Phone Number`).

Candidate shapes:

| Candidate | Basis | Placement |
| --- | --- | --- |
| `LN + FN + DOB + phone` | The measured `FN+LN+DoB+Sex+Phone` combination reached 99.5% uniqueness at 76.2% completeness, the highest-precedence rule in that framework | Above `LN + FN + DOB`, which it refines |
| `FN + phone` | N3C `token_30` exactly; a recall rule for records a name-and-date key misses | Low; a thin key by construction |

**Precision rationale.** A ten-digit phone is high-cardinality, so a compound key
with one inherits most of its discriminating power -- distinctiveness is
measured at 51.6%, second only to SSN and street address. The compound form is
where the evidence is; the standalone form is measured and is the weakest key in
the corpus.

**Recall and sharing, which are the reasons for caution.** Phone stability is
rated Medium for a primary number and Low for a work number, and the population
evidence is the sharpest caveat in this note: 94% of a studied group of homeless
adults owned a cellphone, and most had experienced high phone and phone-number
turnover in the preceding three months. Sharing is worse than churn for
precision, because a shared number is a *shared* value and therefore survives the
two-party test: one health system named cell phone and previous address as
helpful attributes precisely "because it links patients to a household", which is
the benefit in their setting and the failure mode in this one. A shelter's or a
case manager's number on many client records is the same mechanism at a larger
fan-out. **No published figure exists for how often a phone number is shared
across people, in any sector.**

### `email_address`

**The weakest evidence of the three, and the only one with a stated security
objection.** No precision, recall, m/u weight, or stability figure for email as a
matching field exists anywhere in this library. The one shipped configuration
that includes it has a single token (`First Name + Email`), unmeasured. The one
published exclusion of an email token is the same evaluation choice made for
phone, by the same study authors about their own combination and on the same
error-prone-on-input reasoning; no vendor policy on email is cited here either.
Mirel et al.'s NHCS-to-NDI evaluation has no email-bearing token at all --
its token selection was restricted to tokens for which "the full complement of
PII in the survey data were available," and no email field appears among either
source's identifiers anywhere in the paper -- so it neither supports nor indicts
the `FN + email` shape, and the measurement this section calls for remains
outstanding. The attribute analysis that grades every other candidate gives
email no row at all and rates it the hardest tier to standardize. The one
document that recommends it does so on a rising-availability argument alone --
9% to 54% of records over nine years -- and the federal matching report
classifies it as untested and warns that these attributes "are often used to
establish a patient's identity through knowledge-based authentication ... As
such, the capture and exchange of these data attributes may contribute to
decreased security of consumer information."

Candidate shape, if any: `FN + email`, the shipped token, placed low. The
argument for it is structural rather than measured -- an email address is
high-cardinality and near-unique when present and correct, which is the same
property that makes `SSN + first name` a defensible key. The arguments against it
are that the property is unmeasured, that a family or household address defeats
it in exactly the shared way a household phone does, and that the shipped
standardization is a shape test rather than a canonicalization: it lowercases and
trims, and does not fold plus-addressing or dots, so two parties holding the same
person's address in two alias forms produce two different keys.

**Recommendation for this field, as a matter of sequencing rather than of
judgement about the field:** email is the candidate where a measurement would
have to come before a rule, because there is no published figure to reason from
at all.

## The acceptance-evidence bar

### What the bar is, and what it is not

Two things have to be said before the bar itself, because both are critical
and both are easy to get wrong by citation.

**Neither methodological authority sets a numeric pass-mark, and both say so.**
The reporting guidance states plainly that it "does not set minimum standards or
criteria for information that should be provided nor is it a checklist or
protocol". The evaluation guide never attaches a number to "too low": its
thresholds "are generally selected in the context of a specific linkage or
analysis", and it makes the point twice that a measured low error rate is not
itself a pass, because "whether these differences were large enough to introduce
bias into results depends on the relationship between these variables and the
parameters of interest".

So the bar below is a **measurement and disclosure obligation** -- what must be
measured, on what, and reported alongside -- and not a threshold. Any numeric
pass-mark psilink adopts would be psilink's own invention, defensible only by an
argument about the harm of a false match in this setting, and this note does not
propose one.

**The state of practice is worse than the guidance.** Of forty-five published
studies linking Medicaid claims to birth certificates, four mentioned any
validation study and "none of the studies provided results of the validation
exercises"; the review found that studies "often lacked sufficient details on the
matching process for outside researchers to replicate", with statements about
code availability "rarely available". The published Medicaid-claims-to-homeless-services
match closest to psilink's own two-sector pairing does not state its matching
method at all -- no identifiers, no keys, no order, no match rate -- and its
entire quality assessment is one clause: SSNs were unavailable, "although manual
inspection of the matches indicates that those that matched appeared accurate".
A bar that asks for the triad below therefore asks for more than the field
routinely publishes.

### The triad

Three measurements, which the two guidance documents agree on:

1. **A gold-standard comparison** on some subset where the truth is knowable,
   reporting precision (positive predictive value) and recall (sensitivity)
   rather than specificity or F-measure, which are misleading where non-matches
   vastly outnumber matches.
2. **A linked-versus-unlinked comparison**, broken out by demographic group and
   not reported only in total, using standardized differences rather than
   p-values because linkage samples are large enough to make any difference
   significant.
3. **A sensitivity analysis** re-running the headline result under stricter and
   looser matching -- which for a cascade means running it with the weaker keys
   removed, and reporting how the result moves.

The published worked example of the third shows the trade rather than asserting
it: tightening one linkage moved false matches from 0.9% to 0.3% and 0.1% while
missed matches moved from 0.4% to 10.7% and 51.5%, and the strictest arm lost an
association that was real in the gold standard. Stricter is not automatically
safer.

### The substitute-truth recipe, and why it flatters

Administrative linkages rarely have labelled truth, but wherever some pairs
have a strong identifier a serviceable substitute is available at no cost: run
the weaker keys against the pairs the strong identifier has already decided, and
count how often they would have been wrong. The weakest keys' error rate stops
being an unknown.

Its bias must be stated with every number it produces, in both of the forms the
sources give it:

- **The subset is better-kept than the file.** The evaluation guide's own
  worked example found its gold-standard subset had a lower unlinked rate than
  the cohort overall, and generalizes the point: "records with high quality data
  may differ systematically from those of poorer quality data".
- **The subset is demographically skewed, measurably.** On a secondary reading,
  Census person-key assignment rates run 6 to 16 points lower for Hispanic
  records, 16 to 34 points lower for non-citizens, and 5 to 10 points lower for
  people in poverty. A calibration subset defined by having a verified
  identifier measures error best for the people who link best.

For an HMIS-class file there is a second-order version of the same problem: a
benefit-program subset inverts the usual skew, covering the low-income stratum
well and almost nobody else, because an SSN is a federal condition of
eligibility and the state agency must submit it for verification. Either way the
error rate measured on the subset reaches the rest of the file only by
extrapolation, and the extrapolation is an assumption, not a measurement.

### Per-key ablation, and its one precedent

The bar should require the marginal contribution of each key: the set measured
with that key removed, reporting what recall it added and what precision it cost.

State accurately what this requirement rests on. **None of the evaluation guidance
requires it**, and none of the linkage evaluations read here performs it, with
one exception: Mirel et al.'s hashed-token re-run of a hospital-to-death-records
linkage (2016 NHCS to 2016/17 NDI) against its own clear-text linkage as truth.
Its ablation unit is the observed token COMBINATION, not the individual token:
the paper tabulates the 29 unique combinations of tracked tokens that actually
appeared among the returned pairs, so a weak token such as Token 1 is only
charged for the pairs where no stronger token (an SSN-bearing Token 5 or 16) also
matched -- if one had, that pair would appear under a different, mixed-token row
instead. The cut rule is a pre-stated mechanical threshold, fixed in the methods
before the results were run: drop any combination whose false positives exceed
50% of its false positives plus true positives. Four combinations crossed that
line -- Token 1 alone, Token 2 alone, Tokens 1 and 7 together, and Tokens 1 and 2
together -- and all four rest on first or last name, sex, and date of birth, with
no SSN-bearing token in the mix. (The paper never defines what its numbered
tokens concatenate; the definitions are in a figure this library holds only as an
image, so no claim about which of them is phonetic or first-initial is
supportable from the text held here.) Removing those four combinations moved the
full result set from 93.8% precision and 98.7% recall to 98.9% precision and
97.8% recall, and the paper reports the cost beside the gain: 11,515 false
positives were removed at the price of 1,738 true positives, which is the entire
reason recall fell. That is the shape of the measurement, and it is the reason to
require it: the combinations that cost the most precision were exactly the
coarsened, no-SSN kind the built-in set has several of.

For a cascade, one methodological point makes the requirement stricter than it
sounds. A key's marginal contribution is what it adds AFTER the earlier keys have
claimed their records, so an ablation has to be run with the cascade in place. A
key measured standalone can look valuable and contribute nothing in position.

### What a two-party exact-key evaluation must add

Four requirements follow from the intersection geometry rather than from the
guidance, and they are additions this note proposes rather than citations:

- **Report pair fill, not record fill.** A key's reach is the joint availability
  of its fields across both parties.
- **Enumerate the shared-error modes and test them explicitly.** A filler date
  prescribed by a collection standard, a code name a client repeats, and a
  placeholder value both agencies inherited from the same document are the errors
  that survive intersection. A unilateral typo is not; it costs recall.
- **Measure precision on the population that will actually be intersected**, not
  on a dedupe of one file, because a dedupe's candidate set is generated by
  blocking rules that have no counterpart in a two-party exchange.
- **Emit the per-key attribution the reporting guidance asks for.** The guidance
  asks the linker to attach to each pair "the step in the algorithm at which the
  records were linked (e.g. pass-identifier)", and to make available "descriptions
  of how the linkage was done" and error estimates alongside. psilink already
  runs and records per-key stages, so this is a disclosure question rather than a
  measurement one, and it is the input every downstream statistical correction
  for linkage error requires.

### The bar, in one list

A candidate built-in set should not ship without:

1. Precision and recall on a gold-standard or substitute-truth subset, per key
   and for the set, with the subset's construction and its selection bias stated.
2. The pair fill rate of each key, on data representative of both parties.
3. A per-key ablation run inside the cascade, in the set's declared order.
4. A linked-versus-unlinked comparison broken out by demographic group.
5. A sensitivity analysis over stricter and looser variants of the set.
6. An enumeration of the shared-error modes tested, and what each contributed.
7. A stated cascade order with the reason each key sits where it does.

Numbers 2, 3, 6 and 7 are the two-party and cascade-specific additions. Numbers
1, 4 and 5 are the field's triad. None of the seven has a pass-mark, and
adopting one is a separate decision.

## What the evidence does not settle

The gaps below are absences confirmed by search, not searches not yet run. They
bound what any of the above can claim.

- **No per-position precision for any published cascade.** No source publishes an
  ordered key cascade with a measured false-match rate per position.
- **No m/u value, precision, or recall for ZIP alone, phone in a compound key, or
  email in any form**, in any sector. The published method for a ZIP agreement
  probability exists; the value does not.
- **No sharing rate for a phone number or an email address across people**, and
  nothing at all on a shelter or case-manager number appearing on many client
  records.
- **No residential-mobility or ZIP-stability figure for a highly mobile
  population.** The available churn figures are a general-population master
  patient index and a state voter file.
- **No obtainable evaluation corpus for a two-party PPRL product.** No public
  gold-standard linked file, benchmark, test corpus, or synthetic generator is
  named in any source read here. Every holder of labelled truth gates it behind
  proposal review, an institutional review board, and a data use agreement, and
  the evaluation guide states the general condition: gold standards "are often
  only available to the data linkers and not to researchers".
- **No baseline for this user class.** No published HMIS-class linkage reports a
  precision or recall figure a candidate set could be measured against.

One further limit, of a different kind. This library has two analyses of
re-identification attacks on hashed match-keys, and both assume an adversary
holding exchanged or published tokens **together with clear-text
quasi-identifiers** -- a three-digit ZIP, a gender, a birth year -- or a
plain-text database of similar frequency structure. Their key-design conclusions
are quoted above where they bear on composition. Whether their threat model
reaches a two-party PSI exchange is a question about psilink's protocol that this
note does not decide and should not be read as deciding.

## Sources

Every source below is a public document. The filename is the name it uses in
the host-local reference library described at the top of this note; the title and
year are what identify it independently.

**Collection and export standards.** HUD HMIS Data Standards Manual, Data
Dictionary, and CSV Format Specifications, FY2026 (`hud-hmis-data-standards-manual.pdf`,
`hud-hmis-data-dictionary.pdf`, `hud-hmis-csv-format-specifications.pdf`), with
the HUD Exchange pages for data elements 3.01, 3.02 and 3.03
(`hud-hmis-universal-data-elements-name-ssn-dob.md`, fetched 2026-08-25). HUD's
homelessness and health data sharing toolkit
(`hud-homelessness-and-health-data-sharing-toolkit.pdf`) is operating context,
not a rule set.

**Health-sector attribute analyses.** The Sequoia Project, *A Framework for
Cross-Organizational Patient Identity Management*, v3.1, 2018
(`sequoia-2018-framework-patient-identity-management-v31.pdf`) -- Tables 6 and 7.
Pew Charitable Trusts, *Enhanced Patient Matching Is Critical to Achieving Full
Promise of Digital Health Records*, 2018 (`pew-2018-enhanced-patient-matching.pdf`);
its technical appendices do not exist as a separate publication. ONC, *Patient
Identification and Matching Final Report*, 2014
(`onc-2014-patient-identification-and-matching-final-report.pdf`). ONC, *Project
US@ Technical Specification*, v1.0 (`onc-project-us-at-technical-specification-v1.0.pdf`).

**Per-key measurements.** Bernstam et al., "Real-world matching performance of
deidentified record-linking tokens", 2022
(`bernstam-2022-deidentified-record-linking-token-performance.md`) -- Tables 1, 2
and 3. Grannis, Overhage and McDonald, "Analysis of Identifier Performance using
a Deterministic Linkage Algorithm", AMIA 2002
(`grannis-2002-identifier-performance-deterministic-linkage.pdf`) -- Tables 2, 3
and 4. Avoundjian et al., "Comparing Methods for Record Linkage for Public Health
Action", 2020 (`avoundjian-2020-comparing-methods-record-linkage-public-health.md`).
Grannis et al., manual evaluation of record linkage across four real-world
datasets, 2024 (`grannis-2024-manual-evaluation-record-linkage-four-real-world-datasets.md`).

**PPRL key and token sets.** linkja-hashing shipped key definitions, assembled
from repository source, 2026 (`linkja-hashing-shipped-key-definitions.md`) -- read
as evidence of what linkja does, not as a specification linkja published. CODI
FHIR PPRL Implementation Guide (`codi-fhir-pprl-implementation-guide.md`). N3C /
Regenstrief Linkage Honest Broker site engagement packet, v6, 2021
(`n3c-regenstrief-linkage-honest-broker-site-engagement-packet.pdf`) -- Appendix H
is the token list. Datavant Tokenization User Guide, 2023
(`datavant-tokenization-user-guide.pdf`); the vendor publishes no enumeration of
its numbered tokens, so the eighteen tokens cited here are the N3C
configuration's selection. No vendor recommendation about which tokens to combine
is cited anywhere in this note: the exclusion of phone- and email-based tokens
quoted under the candidate rules is Bernstam et al.'s own evaluation choice about
their own experiment, recorded in their Table 1.

**Operating methodologies.** NCHS-CMS T-MSIS Medicaid linkage methodology
(`nchs-cms-tmsis-medicaid-linkage-methodology.pdf`), NCHS 2016 NHCS-CMS Medicaid
linkage methodology (`nchs-2016-nhcs-cms-medicaid-linkage-methodology.pdf`), and
NCHS-HUD linked data methodology (`nchs-hud-linked-data-methodology.pdf`). The
NCHS survey-to-death-index rule quoted under cascade order is from the NHANES-III
matching methodology, cited in the survey below rather than fetched here.

**Evaluation guidance.** Gilbert et al., GUILD: "Guidance for Information about
Linking Data sets", 2018
(`gilbert-2018-guild-guidance-for-information-about-linking-datasets.md`) --
Table 1. Harron et al., "A guide to evaluating linkage quality for the analysis of
linked data", 2017 (`harron-2017-guide-to-evaluating-linkage-quality.md`) --
Box 1 and Table 2.

**Evaluations and the corpus question.** Mirel, Resnick, Aram and Cox, "A
methodological assessment of privacy preserving record linkage using survey and
administrative data", 2022 (`mirel-2022-pprl-linkage-quality-sjiaos.txt`, fetched
2026-08-25) -- Table 1, Table 2, pp. 7-9. ASPE/NCHS PPRL evaluation, NHCS to
Medicaid T-MSIS, final report, 2024
(`aspe-2024-pprl-evaluation-nhcs-medicaid-tmsis-final-report.pdf`). RAND for
ASPE, *Linking Medicaid Claims, Birth Certificates, and Other Sources*
(`aspe-linking-medicaid-claims-birth-certificates-other-sources.pdf`). Nescott,
Metraux, McDuffie and Brown, "Matching Medicaid Claims and Encounters and the
Community Management Information System Databases", *Delaware Journal of Public
Health*, 2023 (`delaware-2023-matching-medicaid-claims-to-community-mis-housing.md`).

**Key-design consequences of frequency structure.** Vidanage et al., graph and
frequency attacks on multiple dynamic match-key encoding, 2020
(`vidanage-2020-graph-matching-attack-pprl.md`). Eliazar et al., re-identification
risk of PPRL encodings shared with de-identified demographics, 2025
(`eliazar-2025-token-count-reidentification-risk.md`).

**Secondary source.** *Record Linkage in Practice: Connecting K-12,
Postsecondary, and Workforce Data* (`real-world-linkage-survey.md`), a survey held
in the same library. The Maryland cascade, the Census person-key system, the
NHANES-III SSN rule, the Australian fixed-key comparisons, the Census person-key
differentials, the controlled study of name cleaning, and the federal evaluation
of commercial matching systems are cited through it; each names its own
underlying publication, and this note has not re-verified those against the
originals.
