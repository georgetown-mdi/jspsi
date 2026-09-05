---
title: "Default Standardization and Type Inference"
---

# Default standardization and type inference

An exchange that authors no `standardization` block does not skip cleaning: the
cleaning is reconstructed from the input metadata and the linkage terms, one
fixed pipeline per semantic type. This document specifies those pipelines -- the
exact ordered steps, their parameters, and the value each produces -- and the
column-name table that assigns a semantic type, a role, and a payload default
when no `metadata` block is authored either.

It is the spec-tier complement to
[Data standardizing transformations](../EXCHANGE_REFERENCE.md#data-standardizing-transformations)
and [Input metadata](../EXCHANGE_REFERENCE.md#input-metadata) in
[EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md), which say what a
transformation is, how an operator authors one, and what each configuration
field means; this document says what the defaults do, step by step, so a
reviewer or an independent implementor can reproduce them without reading the
source. It does not cover the step functions themselves (see
[Available functions](../EXCHANGE_REFERENCE.md#available-functions)), the
regular-expression dialect they execute under or the normative `parse_date`
semantics (see
[PROTOCOL.md](PROTOCOL.md#transform-regular-expression-dialect)), or the rule
that binds a linkage field to an input column (see
[PROTOCOL.md](PROTOCOL.md#linkage-participation-the-role-axis)). Intended
readers are implementors, security auditors, and maintainers changing a
pipeline.

The step sequences, the worked examples, the alias table, and the date-format
inference parameters below are checked against the shipped registries by
`packages/core/test/config/defaultStandardizationDoc.test.ts`: an edit to either side
that is not mirrored in the other fails the unit suite.

## Cross-party invariant

A standardized value is the byte string hashed into the PSI set element (see
[Key input data](PROTOCOL.md#key-input-data)). Two parties therefore match a
record only when their pipelines agree byte for byte: a single differing step
yields different keys, and the pair matches nothing on that key. Nothing
reports this. A missed match is indistinguishable from an absent record, so a
divergence shows as a quietly smaller intersection rather than an error.

Three consequences follow, and they are what make these pipelines a protocol
surface rather than a local formatting choice.

- **A change to any step sequence in this document is wire-affecting.** Both
  parties must run releases with the same sequence. Changing one is a
  breaking protocol change even though no wire format moves.
- **Nothing in the handshake detects a divergence.** The two parties exchange
  and hash their linkage terms (the agreed-terms hash covers those, and the
  terms state a field's `type` and `constraints`, not its cleaning); each
  party's standardization -- authored or reconstructed -- stays local and is
  neither sent nor committed to. Agreement on the pipelines comes from both
  sides running the same specification, not from a check at run time.
- **A per-party parameter is legitimate only when the output is canonical.**
  The one instance is the `date_of_birth` input format, which each party infers
  from its own file's layout (see
  [Date-format inference](#date-format-inference)). It is safe because every
  input layout is reformatted to the same `YYYYMMDD` output. A step whose
  parameter changed the *output* form could not be inferred per party this way.

## When the defaults apply

The defaults are reconstructed when an exchange specification has no
`standardization` block. An authored block is authoritative and replaces them
entirely: there is no per-field merge, no default step is appended to an
authored pipeline, and a linkage field the block leaves uncovered falls back to
the identity transformation over its bound column -- the raw value, unchanged --
not to the pipeline below.

Reconstruction produces one transformation per linkage field, in the order the
terms declare the fields:

- The field's **input column** is resolved by the binding rule shared with the
  dataset builder and the satisfiability pre-flight: absent an authored
  transformation, the first `role: linkage` column whose semantic `type` equals
  the field's type (see
  [Linkage participation](PROTOCOL.md#linkage-participation-the-role-axis)). A
  field that binds to no column yields no transformation and is reported as
  unsatisfiable before the exchange runs.
- The field's **steps** are the pipeline this document lists for the field's
  semantic type. Every type a linkage field may declare has one, so the
  reconstruction never leaves a matching field uncleaned. The two
  metadata-only types (`identifier` and `other`) have no pipeline and are not
  linkage-field types; a column of either is never hashed into a key.

Two behaviors of the pipelines as a whole are specified elsewhere and apply to
every sequence below: the input value is normalized to Unicode NFC before the
first step (see
[Unicode normalization](../EXCHANGE_REFERENCE.md#unicode-normalization)), and a
step that produces `null` ends the pipeline, excluding the record from every
linkage key that references the field (see
[Null propagation](../EXCHANGE_REFERENCE.md#null-propagation)).

## Per-type pipelines

Each pipeline below is written as the `steps` array of a data standardizing
transformation, in the on-disk snake_case form: pasting one under an authored
transformation for a column of that type reproduces the default cleaning
exactly.

The worked examples give the standardized result for a raw cell value. Both
columns are JSON scalars, so whitespace is visible and `null` is the no-value
result -- the record has no value for this field and is dropped from every
linkage key referencing it.

### `ssn`

```yaml
steps:
  - function: trim_whitespace
  - function: remove_non_ascii
  - function: remove_dashes
  - function: replace_regex
    params:
      pattern: "[^0-9]"
      replacement: ""
  - function: null_if
    params:
      value: ""
  - function: pad_left
    params:
      length: 9
  - function: filter_regex
    params:
      pattern: "^\\d{9}$"
  - function: null_if
    params:
      values: ["000000000", "111111111", "123456789"]
```

Result: exactly nine digits. Every non-digit is removed (dashes, spaces, dots,
parentheses), a cell that cleans to empty is dropped, a short value is
zero-padded to nine for an SSN stored without its leading zero, and anything
that is not nine digits after padding -- ten digits, say -- is dropped. Three
placeholder values are then dropped.

The empty-value drop precedes `pad_left` by design: without it a blank cell
would pad to `"000000000"` and be dropped only as a side effect of that value
appearing in the placeholder list, so an operator who tuned the list for their
own data would silently reintroduce the blank-cell match.

The pipeline applies no Social Security Administration structural rule: an
area, group, or serial that the SSA never issues passes through. The
`valid_only` constraint the default `ssn` field declares is a data-quality
signal reported against the cleaned dataset (see
[Constraints](../EXCHANGE_REFERENCE.md#constraints)), not a step here.

| Input | Result |
| ----- | ------ |
| `"078-05-1120"` | `"078051120"` |
| `"  078 05 1120  "` | `"078051120"` |
| `"12345678"` | `"012345678"` |
| `"1234567890"` | `null` |
| `"123-45-6789"` | `null` |
| `"abc"` | `null` |

### `ssn4`

```yaml
steps:
  - function: trim_whitespace
  - function: remove_non_ascii
  - function: remove_dashes
  - function: replace_regex
    params:
      pattern: "[^0-9]"
      replacement: ""
  - function: null_if
    params:
      value: ""
  - function: pad_left
    params:
      length: 4
  - function: extract_regex
    params:
      pattern: "(\\d{4})$"
  - function: filter_regex
    params:
      pattern: "^\\d{4}$"
  - function: null_if
    params:
      values: ["0000"]
```

Result: exactly four digits. The pipeline accepts either a bare last-four value
or a full nine-digit SSN and takes the trailing four digits in both cases, so a
column holding whole SSNs and one holding only the last four standardize to the
same value once both are declared `ssn4`. A cleaned-empty cell is dropped before
padding, a short value is zero-padded to four, and the all-zero serial is
dropped.

| Input | Result |
| ----- | ------ |
| `"6789"` | `"6789"` |
| `"123-45-6789"` | `"6789"` |
| `"89"` | `"0089"` |
| `"0000"` | `null` |
| `"abcd"` | `null` |

### `first_name`

```yaml
steps:
  - function: trim_whitespace
  - function: remove_accents
  - function: remove_non_ascii
  - function: to_upper_case
  - function: replace_separators_with_spaces
  - function: remove_affixes
  - function: remove_punctuation
  - function: squash_spaces
  - function: trim_whitespace
  - function: filter_regex
    params:
      pattern: "[A-Z]"
```

Result: an uppercase ASCII value whose word separators are single spaces, with
honorifics and generational suffixes removed, matching the
`allowed_characters: "A-Z "` and `affixes_allowed: false` constraints the
default name fields declare.

Order determines the meaning here:

- `remove_accents` runs **before** `remove_non_ascii` so an accented letter
  folds to its base letter rather than being deleted -- e-acute becomes `E`,
  not nothing. A letter with no ASCII base (a Greek or Cyrillic character) is
  deleted by the following step.
- `replace_separators_with_spaces` runs **before** `remove_punctuation` so a
  hyphen, apostrophe, ampersand, slash, or underscore becomes a token boundary
  instead of vanishing: `"O'Brien"` becomes `"O BRIEN"`, not `"OBRIEN"`. Both
  parties must therefore tokenize identically for a hyphenated name to match.
- The closing `filter_regex` drops a value containing no letter at all, which is
  what removes a cell that cleaned to empty or to punctuation alone.

Digits are not punctuation and are not removed: a value containing one keeps
it.

| Input | Result |
| ----- | ------ |
| `"  Jose  "` | `"JOSE"` |
| `"Dr. Mary-Jane"` | `"MARY JANE"` |
| `"O'Brien"` | `"O BRIEN"` |
| `"Ann_Marie"` | `"ANN MARIE"` |
| `"5"` | `null` |
| `"   "` | `null` |

### `last_name`

```yaml
steps:
  - function: trim_whitespace
  - function: remove_accents
  - function: remove_non_ascii
  - function: to_upper_case
  - function: replace_separators_with_spaces
  - function: remove_affixes
  - function: remove_punctuation
  - function: squash_spaces
  - function: trim_whitespace
  - function: filter_regex
    params:
      pattern: "[A-Z]"
```

The `last_name` and `first_name` sequences are identical, step for step and
parameter for parameter; the notes under [`first_name`](#first_name) apply
unchanged. They are listed separately because they are two independent
defaults: a change to one is not automatically a change to the other.

| Input | Result |
| ----- | ------ |
| `"van der Berg"` | `"VAN DER BERG"` |
| `"Smith Jr."` | `"SMITH"` |
| `"Alesund"` | `"ALESUND"` |
| `"!!!"` | `null` |

### `date_of_birth`

```yaml
steps:
  - function: trim_whitespace
  - function: remove_non_ascii
  - function: parse_date
    params:
      input_format: "MM/DD/YYYY"
      output_format: "YYYYMMDD"
```

Result: eight digits, `YYYYMMDD`. A value the input format cannot parse is
dropped, as is one that parses to a date the calendar does not have; the
normative parsing, two-digit-year, and calendar-check rules are in
[PROTOCOL.md](PROTOCOL.md#transform-regular-expression-dialect).

`output_format` is fixed at `YYYYMMDD` -- it is the cross-party canonical form,
and changing it changes every date key. `input_format` is the one default
parameter that varies per party.

#### Date-format inference

`MM/DD/YYYY` is the value used when no format is supplied. An exchange that
authors no `standardization` supplies one instead: it infers the layout from
the values of the `role: linkage` `date_of_birth` column the field binds to, so
a file written `YYYY-MM-DD` is parsed as written rather than dropped wholesale.

Inference starts with every candidate in the table below. For each non-empty
value at least one candidate parses, every candidate that does not parse it is
eliminated; a value no candidate parses is skipped as noise. Scanning stops as
soon as one candidate remains or the scan cap of non-empty values is reached,
and the result is the earliest surviving candidate in the table's order. That
order is the tie-break, and a tie means every survivor agrees with the values
seen -- a column whose days are all 12 or under leaves `MM/DD/YYYY` and
`DD/MM/YYYY` both standing, and the earlier one wins.

Inference yields nothing when it eliminated no candidate at all -- an empty
column, or one whose every value was noise -- and the pipeline then keeps the
`MM/DD/YYYY` above. The same fallback applies when the input declares no
`role: linkage` `date_of_birth` column for the field to bind to.

| Parameter | Value |
| --------- | ----- |
| Candidate input formats, in elimination order | `MM/DD/YYYY`, `YYYY-MM-DD`, `YYYYMMDD`, `MM-DD-YYYY`, `MM/DD/YY`, `YYYY/MM/DD`, `DD/MM/YYYY`, `DD-MM-YYYY` |
| Maximum non-empty values scanned | `1000` |

Because the inferred format only tells the parser how to read this party's own
file, and every candidate produces the same `YYYYMMDD` output, two parties
holding differently formatted dates still derive identical keys. The examples
below use the `MM/DD/YYYY` default.

| Input | Result |
| ----- | ------ |
| `"01/02/1990"` | `"19900102"` |
| `"1/2/1990"` | `"19900102"` |
| `"1990-01-02"` | `null` |
| `"02/30/1990"` | `null` |

### `phone_number`

```yaml
steps:
  - function: trim_whitespace
  - function: remove_non_ascii
  - function: replace_regex
    params:
      pattern: "[^0-9]"
      replacement: ""
  - function: replace_regex
    params:
      pattern: "^1(\\d{10})$"
      replacement: "$1"
  - function: filter_regex
    params:
      pattern: "^\\d{10}$"
```

Result: exactly ten digits. Formatting characters are removed, a leading US
country code on an eleven-digit number is stripped, and anything that is not
ten digits afterwards is dropped. The pipeline assumes the North American
ten-digit form: an international number of another length is dropped rather
than normalized, and no country other than `1` is recognized.

| Input | Result |
| ----- | ------ |
| `"(202) 555-0123"` | `"2025550123"` |
| `"+1 202 555 0123"` | `"2025550123"` |
| `"12025550123"` | `"2025550123"` |
| `"555-0123"` | `null` |

### `email_address`

```yaml
steps:
  - function: trim_whitespace
  - function: remove_non_ascii
  - function: to_lower_case
  - function: filter_regex
    params:
      pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"
```

Result: a lowercased address of the shape `local@domain.tld`. The filter is a
shape test, not a validator: it requires one `@` with a dotted right-hand side
and no whitespace, and admits addresses no mail system would accept.

`remove_non_ascii` precedes the filter, so a non-ASCII character in an address
is deleted rather than causing the value to be dropped -- an internationalized
address is truncated to its ASCII characters. Both parties do the same, so such
an address still matches itself; it does not match a partner's copy that was
already stored in an ASCII form.

| Input | Result |
| ----- | ------ |
| `"  Jane.Doe@Example.COM  "` | `"jane.doe@example.com"` |
| `"a@b.c"` | `"a@b.c"` |
| `"not-an-email"` | `null` |

### `zip_code`

```yaml
steps:
  - function: replace_regex
    params:
      pattern: "[^0-9]"
      replacement: ""
  - function: substring
    params:
      start: 1
      length: 5
  - function: null_if
    params:
      value: ""
  - function: pad_left
    params:
      length: 5
```

Result: exactly five digits. Stripping every non-digit subsumes a leading trim
and a non-ASCII removal, so neither appears as its own step; keeping the first
five digits collapses a ZIP+4 to its five-digit prefix; and the closing pad
restores the leading zero on a New England ZIP stored as a number. The
empty-value drop before `pad_left` mirrors the `ssn` pipeline -- `substring`
already yields `null` for an empty slice, so it adds no coverage on its own and
is retained as the explicit statement of the rule.

Unlike `ssn` there is no placeholder drop: `00000` is a real ZIP (USPS
bulk/dummy addresses, and the floor of the zero-padding above), not a sentinel.

Note the width: a value of more than five digits keeps its first five rather
than being dropped, which is the one default pipeline that truncates instead of
refusing. A nine-digit ZIP+4 written without its separator therefore
standardizes to the same value as the five-digit form.

| Input | Result |
| ----- | ------ |
| `"20057"` | `"20057"` |
| `"20057-1234"` | `"20057"` |
| `"  2057  "` | `"02057"` |
| `"00000"` | `"00000"` |
| `"abc"` | `null` |

## Type inference from column names

When an exchange specification has no `metadata` block, each input column's
semantic type, role, and payload default are inferred from its name. The lookup
is on the whole column name lowercased -- an exact match against the table
below, never a substring or prefix test -- so `zip` infers but `zip_area` does
not.

| Semantic type | Column names that infer it | `role` | `is_payload` |
| ------------- | -------------------------- | ------ | ------------ |
| `ssn` | `ssn`, `social_security_number`, `social` | `linkage` | `false` |
| `ssn4` | `ssn4` | `linkage` | `false` |
| `first_name` | `first_name`, `firstname`, `fname` | `linkage` | `false` |
| `last_name` | `last_name`, `lastname`, `lname` | `linkage` | `false` |
| `date_of_birth` | `date_of_birth`, `dateofbirth`, `dob` | `linkage` | `false` |
| `identifier` | `identifier`, `id` | `identifier` | `true` |
| `phone_number` | `phone_number`, `phonenumber`, `phone` | `linkage` | `false` |
| `email_address` | `email_address`, `emailaddress`, `email` | `linkage` | `false` |
| `zip_code` | `zip_code`, `zipcode`, `zip`, `zip5`, `zip_5` | `linkage` | `false` |

Each multi-word type lists its snake_case spelling and its no-separator
spelling, so a single-token column export (`firstname`, `dateofbirth`) infers
as well as a separated one.

Two rules sit outside the table:

- A name absent from the table but ending in `_id` infers `type: identifier`,
  `role: payload`, `is_payload: true`.
- Any other unrecognized name infers `type: other`, `role: payload`,
  `is_payload: true`.

A second pass then decides which column indexes this party's own records: a
header with exactly one `identifier`-typed column promotes that column to
`role: identifier` whatever its name, and a header with several leaves the
promotion to a column literally named `id` or `identifier` if one is present,
and to no column at all otherwise. The operator-facing consequences of that --
that an inferred identifier column is transmitted -- are in
[Input metadata](../EXCHANGE_REFERENCE.md#input-metadata).

Two properties of these assignments are critical for matching. Every
inferred linkage type has `is_payload: false`, so a column inferred into
matching is not also disclosed to the partner unless the operator says so; and
matching participation still requires `role: linkage`, so a column inferred
`identifier` or `payload` never reaches a key however its type reads (see
[Linkage participation](PROTOCOL.md#linkage-participation-the-role-axis)).

## See also

- [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md) - the configuration
  reference these defaults substitute for: the transformation and step schemas,
  the step-function catalog, and the metadata block
- [PROTOCOL.md](PROTOCOL.md) - the regex dialect and `parse_date` semantics the
  steps run under, the field-to-column binding rule, and how a standardized
  value becomes a linkage key
- [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md) - the bounds on partner-authored
  transform patterns and parameters
