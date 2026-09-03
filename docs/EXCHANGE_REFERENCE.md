---
title: "Exchange reference"
---

# Exchange reference

This document is the complete field-level reference for PSI-Link exchange specifications. It covers all fields in the four components - linkage terms, connection, metadata, and data standardization - including types, valid values, consistency rules, and examples. It does not cover how the PSI protocol uses these parameters (see [PROTOCOL.md](spec/PROTOCOL.md)), the threat model or authentication design (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md)), or the CLI commands that consume this file (see [CLI.md](CLI.md)). Intended for anyone configuring an exchange.

> Adding to this doc? Keep it conceptual and operational. Constant values, byte/wire layouts, algorithm steps, and the rationale behind them belong in the spec tier -- see [docs/spec/](spec/README.md), "Where does my content go?".

Exchange specifications are JSON or YAML documents that fully describe a PSI-Link exchange between two parties. They are consumed by both the web application and the CLI application. The web application provides an interactive editor for creating them; the CLI application accepts them as configuration files. A file the web app mints for download is an ordinary `psilink.yaml` validated against this same shared schema -- there is no web-specific format, no secret in the file, and the compatibility contract between a continuously-deployed web app and a pinned CLI is specified in [EXCHANGE_FILE.md](spec/EXCHANGE_FILE.md).

An exchange specification has four top-level components:

| Component | Required | Description |
|-----------|----------|-------------|
| `linkage_terms` | yes | What will be exchanged and how; verified by both parties |
| `connection` | yes | Where and how the exchange will take place |
| `metadata` | no | Descriptions of input fields and their roles |
| `standardization` | no | Data cleaning and standardizing transformations applied before linkage |

Beside them sit the optional top-level blocks documented below -- [`authentication`](#authentication), [`signing`](#signing), [`retention_disposition`](#retention_disposition) -- the three payload enforcement records (`outbound_payload_consent`, `disclosed_payload_columns`, `expected_payload_columns`), under the rules in [`linkage_terms.payload`](#linkage_termspayload), and the terms enforcement record [`expected_partner_deduplicate`](#expected_partner_deduplicate). psilink writes and refreshes all four for you on an online invite or accept, and you may also author them by hand in a recurring configuration. Any other top-level key is rejected at config-parse time with a user-facing error naming it, and no exchange runs until it is corrected: those enforcement records are optional, and an absent one means "nothing to enforce", so a misspelling that was quietly dropped would disable a consent or disclosure check with no signal. Unrecognized keys *inside* `linkage_terms`, `connection`, `metadata`, and `standardization` are dropped instead -- see [EXCHANGE_FILE.md](spec/EXCHANGE_FILE.md) for what each behavior means when a file minted by a newer web application is loaded by an older CLI.

## File references

Credential and opaque string fields in `psilink.yaml` support `@`-file references: a value beginning with `@` is read from the file at the given path rather than used literally. For example:

```yaml
connection:
  server:
    password: "@sftp.key"
```

Only the fields marked "`@`-file recommended" in their descriptions, together with the opaque `connection.provider_options` map, support this convention. Any other field is not treated as an `@`-file reference: a free-text field such as `linkage_terms.identity` or `retention_disposition`, or a local-path field such as `signing.identity_file`, keeps a leading `@` as a literal character rather than reading it as a file path.

---

## Linkage terms

Linkage terms are verified by both parties at the start of every exchange. After authentication, both parties swap their terms; if any fields are inconsistent, the exchange is cancelled. Fields marked as "soft" produce a warning and an updated set of terms are written out rather than an error.

The document's four free-text fields -- [`identity`](#linkage_termsidentity), the legal agreement's [`purpose`](#linkage_termslegal_agreement), a payload column's [`description`](#linkage_termspayload), and each [constraint `exclude`](#constraints) value -- share one shape rule beyond their 1024-character cap: none may carry a control character. Each is a single-line value that travels to the partner with the terms, and three of them go further: the two parties' identities, the purpose, and the payload column descriptions are written verbatim into both parties' [exchange records](spec/EXCHANGE_RECORD.md), which are kept and read long after the run. An `exclude` value reaches no record -- the record accounts for the fields matched on by name and semantic type, not for the constraints placed on them. So a NUL, an ESC, a tab, or a line break in any of the four is refused when the terms are read, whichever side authored them. Letters outside ASCII are untouched, so a name, a purpose, or a denylist value written in any script is fine.

The rule covers those four fields and no others. The string values of a [transform step's](#transform-steps) `params` -- a regex pattern, a replacement, a delimiter, a default -- are bounded at 1000 characters each and held to no character rule, because a step's bytes are its meaning; what neutralizes a control character in one of those is the display escaping psilink applies wherever it renders a value, the same seam that covers every other partner-supplied string on its way to a screen, a log, or an error.

### The built-in rules

Not every exchange authors its own linkage fields and keys. A zero-setup exchange, an invitation minted on the web app's quick path, and the template `psilink init` writes all fill them in for you, from the product's built-in rules. They are also where the web app's Advanced invite path starts, before you edit the keys.

The built-in rules are two named artifacts, versioned separately:

- **`baseline-pii`, version `1.0.0`** -- the linkage **fields**: five PII elements, `ssn`, `ssn4`, `first_name`, `last_name`, and `date_of_birth`, each in its standardized form and with the constraints it carries. This is the substrate keys are built from, and it is general-purpose: it says which PII the built-in rules work from and how each element is cleaned, not what constitutes a match.
- **`hmis-keys`, version `1.0.0`** -- the linkage **keys**: fourteen combinations of those fields, applied in the order the set lists them. Which combinations count as a match is specific to the class of system these keys were settled for, which is what the name states; the fields underneath them are not specific to it.

For an exchange that did not author its own, the key set is an upper bound on the rules that could have run, not the account of which did -- that account is the terms document's, below.

What the names do and do not cover:

- Between them they cover the linkage **fields** (with their constraints) and the linkage **keys**, and nothing else. Each version versions its own artifact: an edit to a field or a constraint is a new version of `baseline-pii`, and an edit to the keys -- including a reordering, since the order is the order they are applied in -- is a new version of `hmis-keys`.
- They do not cover the rest of the terms document. `identity`, `date`, `algorithm`, `linkage_strategy`, `output`, and `deduplicate` are each party's own choice on the day, and two parties can run the same rules while differing on them.
- A run matches on a **subset** of the key set, never on an addition to it: when the terms are derived from your input file, a key whose fields no column can supply is left out of them. The terms document that travels with the exchange still records exactly which keys ran, so it -- not either name -- is the authoritative account of any one exchange.

Terms drawn from these rules cite them, in the [`linkage_rule_set`](#linkage_termslinkage_rule_set) field below, so the citation travels with the exchange: it is in the invitation, on the wire, on the accepting party's terms review, and in each party's exchange record.

`phone_number`, `email_address`, and `zip_code` are matchable semantic types (see [Semantic types](#semantic-types)) that neither built-in artifact uses. To match on one, add it to your keys: the web app's Customize / Matching keys tab offers each one your file can supply inside a compound key -- the type beside fields the built-in keys already use, never on its own -- off until you turn it on, and expert key authoring builds any other key over them. Either way the resulting terms are an addition to the built-in set rather than a subset of it, so they cite no rule set.

What the key set's validation rests on, the criticisms recorded against it, what a zero-setup exchange rests on, and the rule for bumping either version are in [default-linkage-rule-set.md](notes/default-linkage-rule-set.md).

### `linkage_terms.version`

*Type:* string  
*Required:* yes  
*Consistency:* mandatory

A semver string identifying the schema of the linkage aggreement. Two versions are incompatible if no migration path exists from the lower version to the higher.

### `linkage_terms.identity`

*Type:* string  
*Required:* no, except under [`signing.mode: certificate`](#signingmode)  
*Consistency:* none

A free-text string identifying the party holding these terms. It is self-asserted: a party writes whatever string it likes and the protocol does nothing to vouch for it (hence `Consistency: none`). It is recorded, alongside the partner's, in the unsigned self-attested exchange record produced by every exchange that disclosed (see [Exchange record format](spec/EXCHANGE_RECORD.md)), where it is an unverified label. Parties may format this however they wish; common contents include name, organization, and contact information.

One string is not a label: the placeholder [`psilink init`](CLI.md#initialization) writes into a fresh template. A command that reads a label refuses that exact value -- alone in the field or on `--identity`, whitespace around it or not -- as firmly as it refuses none at all (see [Configuration](CLI.md#configuration)).

Omit the field to run unnamed. psilink supplies no label of its own -- not the account it runs as, not a placeholder -- so terms carrying no identity send none, the record omits its field rather than writing a stand-in, and every surface that shows a party name shows an absence marker in its place. Present, the value must be non-empty and within the length cap; an empty string is refused rather than read as an omission. The two commands that author a durable partnership, [`psilink invite`](CLI.md#offline-invitation) and [`psilink accept`](CLI.md#offline-acceptance), require a name at their own interface, so a configuration written by an acceptance always carries one. An exchange that signs receipts requires one too, and is refused before it runs without it: the certificate a party presents is trusted by the identity it used in the agreed terms, so an unnamed party leaves its partner nothing to check that certificate against (see [`signing.mode`](#signingmode)).

Under `certificate` signing mode this otherwise-free-text field is effectively pinned: it must match the identity bound into the party's signing certificate, or the partner rejects the receipt. A signed receipt therefore requires both parties to be named -- a certificate is trusted by the identity its holder used in the agreed terms, and an unnamed party has none for it to be authorized against -- so a run with signing configured refuses at terms agreement, before any linkage key or data crosses, rather than producing a receipt nobody can verify. The two commands that resolve an identity for an exchange surface a mismatch locally rather than leaving it to the partner's exchange: [`psilink fingerprint`](CLI.md#signing-identity-fingerprint) warns, whether it binds the certificate or only reads an existing one, and [`psilink exchange`](CLI.md#signing-identity-and-the-agreed-terms) refuses the run before any credential, terms, or data are sent -- an exchange under a divergent pair cannot leave both parties holding a verifiable receipt. See [Signing](#signing).

```yaml
linkage_terms:
  identity: "Jane Smith, Agency A, jsmith@agency-a.gov"
```

### `linkage_terms.date`

*Type:* ISO 8601 date string  
*Required:* yes  
*Consistency:* soft

Date these linkage terms were last modified. A mismatch produces a warning indicating that one party may have a stale copy.

### `linkage_terms.algorithm`

*Type:* enum: `psi` | `psi-c`  
*Required:* yes  
*Consistency:* mandatory

- `psi` -- reveals the intersection (matched records and their identifiers). Intended for operational data exchange.
- `psi-c` -- reveals only the cardinality of the intersection (how many records match).

A count-only exchange is one round over one key, so `psi-c` narrows what the rest of the document may say. Terms setting it are refused, naming what to change, when they declare any of:

- more than one entry in `linkage_keys`;
- `linkage_strategy: single-pass`;
- `deduplicate: true`;
- payload in either direction -- a non-empty `payload.send` or `payload.receive`, or [input metadata](#input-metadata) that would transmit a column (`is_payload: true` on a column whose `role` is not `ignored`).

The refusal happens where the terms are authored, where an invitation over them is minted, and where a received invitation is parsed or accepted. It is never resolved by narrowing the document to the count-only shape or by running it as `psi`; the reasoning is in [PROTOCOL.md](spec/PROTOCOL.md#psi-c). None of this constrains `psi` terms.

### `linkage_terms.linkage_strategy`

*Type:* enum: `cascade` | `single-pass`  
*Required:* yes (defaults to `cascade` when omitted)  
*Consistency:* mandatory

How the agreed linkage keys are matched between the two parties' records. Both strategies produce the same association table; they differ only in how the per-key matching is sequenced on the wire, and in what one party discloses to the other.

- `cascade` -- the default. Matches the keys one at a time, in order; each round excludes the records already matched by an earlier key. The number of network round trips grows with the number of keys.
- `single-pass` -- batches every key into one exchange and has the receiver reconstruct the cascade locally, so the round-trip count stays the same no matter how many keys there are. This makes a multi-key linkage practical over a high-latency channel (such as `filedrop` or `sftp`), where a chain of dependent rounds is prohibitively slow. It has a tighter scale ceiling than `cascade`; an exchange above that ceiling aborts cleanly on both parties with guidance on how to fit it (reduce the number of linkage keys or records, or split the dataset into smaller batches).

`single-pass` trades additional disclosure for the constant round-trip count: to reconstruct the cascade in one pass the receiver learns the sender's full per-key duplicate structure, so it sees matches on less precise keys the step-by-step cascade would have discarded. The emitted result is identical either way. Both parties must agree on the value or the exchange aborts. Choose `single-pass` when the round-trip saving outweighs that disclosure to the receiver. The wire shape and the exact disclosure are in [PROTOCOL.md](spec/PROTOCOL.md#linkage-strategies-cascade-and-single-pass); the ceiling and its derivation in [PROTOCOL.md](spec/PROTOCOL.md#the-single-pass-dataset-ceiling-receiver-memory-and-masking-compute).

One feature requires `single-pass`: matching on the several values a `split_on` produces runs under it only, so terms declaring a fan-out under `cascade` are refused rather than matched on one value (see [Fan-out (multi-value fields)](#fan-out-multi-value-fields)).

### `linkage_terms.output`

*Type:* object  
*Required:* yes  
*Consistency:* mandatory

```yaml
linkage_terms:
  output:
    expects_output: true       # this party expects to receive the result
    share_with_partner: false  # the other party expects to receive the result
```

If `share_with_partner` is `true`, the other party's terms must also have `expects_output: true`; a mismatch aborts the exchange.

`expects_output` must be `true` if this party's `deduplicate` is `true`.

PSI roles (sender / receiver) are derived from `output` after the terms exchange. Both parties carry their record counts on the terms exchange -- including when only one party has `expects_output: true` -- so each party's row count is put on the wire in every case, with no separate count round-trip. If exactly one party has `expects_output: true`, that party becomes the PSI receiver regardless of the counts. If both parties have `expects_output: true`, the party with the smaller dataset becomes the receiver and ties are broken in favour of the initiator -- a work-minimizing assignment derived in [`docs/spec/PROTOCOL.md`](spec/PROTOCOL.md#role-resolution-and-work-minimization).

### `linkage_terms.deduplicate`

*Type:* boolean
*Required:* yes  
*Consistency:* none

Whether or not to deduplicate the inputs of the party holding these terms. Setting it `true` says that several of THIS party's records may be matched to the same partner record -- the declaring party is the "many" side of the resulting match, and it deduplicates its own inputs by using the partner's data to group them. Each party independently decides whether to deduplicate its own records; the two values need not agree, and the pair decides the exchange's cardinality (`false`/`false` matches one-to-one, `true`/`false` many-to-one, `true`/`true` many-to-many). The matching procedure each cardinality runs, and the additional disclosure a deduplicating match makes, are in [`docs/spec/PROTOCOL.md`](spec/PROTOCOL.md#deduplicating-cardinalities-many-to-x-matching).

> **Both parties `true` takes the cascade:** `true` on BOTH parties resolves to many-to-many, where each party's records may group the other's. [`cascade`](#linkage_termslinkage_strategy) matches that pair; `single-pass` matches a one-sided deduplicating match only, and a both-sided pair naming it is refused before matching begins, on both parties, with a message naming the strategy to move to. No single party's terms carry the combination -- it takes both parties' `true` to resolve it -- so that refusal comes after the terms exchange and before any PSI round. What the terms exchange carries (each party's declared record count among it) has been disclosed by then; no linkage-key or payload data has moved. A many-to-one match, `deduplicate: true` on one party and `false` on the other, runs under either strategy.
>
> **What a both-sided match hands you:** the result file carries one row per matched pair under every cardinality, and where both parties group, those pairs resolve into [entity clusters](spec/PROTOCOL.md#the-many-to-many-entity-closure) -- a set of your records together with the partner records they link to. A cluster of `m` of your records and `n` of your partner's writes `m * n` rows; no column marks a cluster's boundary, and a reader that wants clusters computes them from the pairs. Both parties compute the same clusters from the one table, with nothing further exchanged for it. Which keys are worth matching on under that reading is [below](#choosing-linkage-keys-for-a-both-sided-match).
>
> **The run names what the pair resolved to:** nothing before the terms exchange can, since each party's value comes from its own file and the cardinality follows from the two together. So a run resolving to any deduplicating cardinality names it once the terms are agreed and before the first round -- on the CLI's log and its machine-interface warning stream, and among a browser seat's run notices, shown beside an attended run and written to the diagnostic log by an unattended scheduled one. What that notice says about the result follows the agreed [`output`](#linkage_termsoutput) as well as the cardinality: a party those terms give no result is told the pairs land with its partner rather than in a file of its own. A both-sided run whose two declared record counts project a pair table past the advisory bound adds an advisory naming that projection and what each side contributes to it, so you can tell which side drives it; the bound and its derivation are in [PROTOCOL.md](spec/PROTOCOL.md#deriving-one-table-from-the-exchanged-association-maps). Neither notice refuses anything and the run continues; the projection is the largest table those counts admit rather than a prediction of the match.
>
> **Each party's own value, however the exchange is set up:** an invitation carries the inviting party's `deduplicate` and nothing more. Accepting derives the accepting party's own value as `false` rather than adopting the invitation's, so an accepted deduplicating invitation runs many-to-one with the inviting party as the "many" side, and the consent display states what that discloses, that the accepting party's own records are not grouped, and that more of the accepting party's records can still match than a one-to-one run of the same two files would. The inviting party's own side is held to what its invitation declared: an acceptance retains that value, and a partner presenting a different one when the exchange runs is refused before any key or payload moves. Two parties that each authored their own configuration file have no such declaration between them -- the values differ by design there, which is what makes one of them the "many" side -- so that pair runs as written. An accepting party that wants its own records grouped declares it in its own configuration file: each party's value comes from its own file, and both run `psilink exchange`. Where both files declare it, the exchange is the both-sided one above. That binding runs one way only: nothing records an inviting party's expectation of its partner's value, so a party that accepted a deduplicating invitation and later declares `deduplicate: true` in its own configuration file runs the both-sided match, which the inviting party sees when the two parties' terms meet at the run.

```yaml
linkage_terms:
  deduplicate: false
```

Any party indicating `true` must have `expects_output: true`: the grouping a deduplicating match produces is delivered only in the output, so a "many" party that received none would have widened its own match for nothing. The requirement to receive output is already captured by the cross-party `output` consistency check, so no separate consistency check is applied to this field.

The partner may still be the one with `expects_output: false`. Where it is, the deduplicating party is the only one resolving the match and takes on the uniqueness rule the partner would otherwise have applied to its own values, so that each of its own records is still matched to at most one partner record. That obligation and the rest of the procedure are specified in [`docs/spec/PROTOCOL.md`](spec/PROTOCOL.md#deduplicating-cardinalities-many-to-x-matching). Both parties declaring `true` therefore both receive the result: the grouping exists only in the output, and the pair has no runnable shape in which one of them goes without it.

#### Choosing linkage keys for a both-sided match

A cluster is the set of records that shared one value under one linkage key, so a cluster is only as good as the key that formed it: a key that is not near-unique where it is present groups records that are not one individual, and the result hands that grouping to both parties as a single entity. The rules for authoring [`linkage_keys`](#linkage_termslinkage_keys) under a both-sided match, and the closure they follow from, are in [`docs/spec/PROTOCOL.md`](spec/PROTOCOL.md#the-many-to-many-entity-closure).

### `expected_partner_deduplicate`

*Type:* boolean
*Required:* no
*Consistency:* none (a local record, never exchanged)

A top-level key of `psilink.yaml`, a sibling of `linkage_terms` rather than a member of it: the [`deduplicate`](#linkage_termsdeduplicate) an accepted invitation declared for the *inviting* party's own side. It is what makes the paragraph above hold for a configuration rather than only for the moment of acceptance -- an accepting party keeps the declaration here, and an exchange run from this file refuses a partner presenting any other value at the terms exchange, before any key or payload moves. Every accept path records it: `psilink accept`, online and offline, and the browser's managed and console flows.

Do not confuse it with `linkage_terms.deduplicate` beside it, which is *your own* side. Accepting sets your own value to `false` whatever the invitation declared, so the two legitimately differ, and the run reads the binding only from this key.

Omit it for an exchange you and your partner each authored from your own configuration files: there is no declaration between you, the differing pair is what makes one of you the "many" side, and an absent key holds the partner to nothing. Do not add one by hand to make a partner's setting "official" -- it records what an invitation stated, and a value you chose yourself would abort an honest exchange.

```yaml
linkage_terms:
  deduplicate: false

expected_partner_deduplicate: true
```

### `linkage_terms.linkage_fields`

*Type:* array  
*Required:* yes  
*Consistency:* mandatory

The linkage fields define the standardized form of each PII element that participates in linkage. Each field has a name, a semantic type, and optional constraints. The name is a unique identifier used by linkage key elements and data standardizing transformations.

Constraints are not enforced by the application -- they are standards that both parties independently commit to meeting when preparing their data. The application warns when a value violates a constraint it can test at the value level (`exclude`, `allowed_characters`, and `valid_only`), but it never transforms the data to satisfy it. In the future, it may be an option to upgrade these warnings to errors.

`affixes_allowed` is the exception: it is a documentary standard with no clean value-level test -- nothing in a cleaned name distinguishes a suffix that was removed from one that was never present -- so it is never checked and never warns. It is a statement of what each party commits to having done to its data, verified between the parties rather than by the application.

Social Security Numbers must be formatted as `XXXXXXXXX` (nine-character numeric string, no dashes). Dates of birth must be formatted as `YYYYMMDD`. Converting raw input to these formats is the responsibility of each party's data standardization.

```yaml
linkage_terms:
  linkage_fields:
    - name: ssn
      type: ssn
      constraints:
        valid_only: true
        exclude:
          - "123456789"
          - "111111111"
    - name: ssn4
      type: ssn4
    - name: first_name
      type: first_name
      constraints:
        affixes_allowed: false
        allowed_characters: 'A-Z '
    - name: first_name_raw
      type: first_name
    - name: last_name
      type: last_name
      constraints:
        affixes_allowed: false
        allowed_characters: 'A-Z '
    - name: date_of_birth
      type: date_of_birth
```

#### Fields fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Identifier referenced by linkage key elements and standardization outputs |
| `type` | string | yes | The type of PII this field represents (see [Semantic types](#semantic-types)) |
| `constraints` | object | no | Data standards both parties commit to meeting when preparing this field |

#### Semantic types

| Value | Description |
|-------|-------------|
| `ssn` | Social Security Number (9-character string) |
| `ssn4` | Last four digits of SSN; distinct from `ssn` because some parties only possess the last four digits |
| `first_name` | Given name |
| `last_name` | Family name |
| `date_of_birth` | Date of birth |
| `phone_number` | Phone number |
| `email_address` | Email address |
| `zip_code` | US ZIP code; canonical form is 5 digits, zero-padded |
| `identifier` | Column that indexes a party's own records; never matchable |
| `other` | A column whose PII type is none of the above |

The first eight values are the complete type set for a `linkage_fields[].type`. The last two, `identifier` and `other`, are additionally valid for a `metadata[].type` -- inference assigns them to an `_id`-suffixed column and to an otherwise unrecognized column, respectively -- but are not linkage-field types: a `linkage_fields[].type` set to either is rejected.

Additional types will be added as their use case arises.

A ZIP column is inferred as `zip_code` from any of its recognized names (`zip` and its spellings; the complete table is in [DEFAULT_STANDARDIZATION.md](spec/DEFAULT_STANDARDIZATION.md#type-inference-from-column-names)). Like `phone_number` and `email_address`, it is a matchable type with no built-in linkage key, so an inferred ZIP column is used for matching only when a key references it and is not sent as payload unless you mark it so. A ZIP code on its own is a weak identifier -- it matches everyone who shares an area -- so it does its work inside a compound key alongside a name or a date of birth.

#### Constraints

| Field | Type | Applies to | Description |
|-------|------|------------|-------------|
| `valid_only` | boolean | `ssn`, `ssn4` | Data must conform to Social Security Administration [rules](https://www.ssa.gov/kc/SSAFactSheet--IssuingSSNs.pdf) for valid SSNs |
| `valid_only` | boolean | `date_of_birth` | Must be a valid date |
| `exclude` | array of strings | any | Values that must not appear in the data; useful for filtering placeholder values such as `123456789` and `111111111` for SSNs |
| `allowed_characters` | string | name fields | Regex character class; characters outside it must have been removed |
| `affixes_allowed` | boolean | name fields | If false, honorifics (Mr., Dr., etc.) and suffixes (Jr., III, etc.) are expected to have been removed |

The table above is the complete set of constraints. A constraint not listed for a given semantic type is ignored rather than rejected: the schema silently drops the unrecognized key (for example, `allowed_characters` on an `ssn` field is stripped, not flagged as an error).

---

### `linkage_terms.linkage_keys`

*Type:* array  
*Required:* yes  
*Consistency:* mandatory

An ordered list of linkage keys applied in sequence from most to least precise. Each round of the PSI protocol matches only records not yet resolved in a prior round. Each element references a linkage field by name and may optionally specify transformations applied to that field's canonical value before it is concatenated into the key.

The name of each linkage key must be unique. The elements within any linkage must either reference a unique linkage field or have an alias that is unique. Each element's `field` must name a declared linkage field (a `name` from `linkage_terms.linkage_fields`); a key that references an undeclared field is rejected when the terms are decoded, rather than silently collapsing to an empty key at exchange time.

```yaml
linkage_terms:
  linkage_keys:
    - name: "SSN4 + Last Name + DOB"
      elements:
        - field: ssn4
        - field: last_name
        - field: date_of_birth
    - name: "SSN + Last Name (4) + First Initial"
      elements:
        - field: ssn
        - field: last_name
          transform:
            - function: substring
              params:
                start: 1
                length: 4
        - field: first_name
          transform:
            - function: substring
              params:
                start: 1
                length: 1
    - name: "SSN, all two-digit transpositions"
      elements:
        - field: ssn
          generate_fuzzy_comparisons: transpositions
```

#### Key fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable name for this key |
| `elements` | array | yes | Data elements combined to form the key |
| `swap` | array | no | An array of two field names (or element `name` values) for which the receiver swaps their data elements for this key (see below) |

#### Element fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `field` | string | yes | Name of a linkage field from `linkage_terms.linkage_fields` |
| `name` | string | no | Optional alias for this element; used when the same field appears more than once in a key, or as the target of a `swap` |
| `transform` | array | no | Sequence of transformation steps applied to the canonical field value before concatenation into the key |
| `generate_fuzzy_comparisons` | string | no | Method for generating additional values for fuzzy matching: `transpositions` generates every two-position transposition of the value, all pairs of positions and not adjacent ones alone; `edit_distances` generates all single-character deletions, matching values within one edit distance; `adjacent_years` generates dates +/- 1 year from the input. Applied after any transformation. An element declaring one costs the candidate values its expansion can reach toward the [`single-pass`](#linkage_termslinkage_strategy) dataset ceiling, in place of 1, and that count follows the width the element's own `transform` bounds its value to: a `substring` to 10 characters costs 11 for `edit_distances` and 46 for `transpositions`, while an element whose transforms bound no width costs what the full 128-character expansion limit reaches (129 for `edit_distances`). `adjacent_years` costs 3 whatever the width. Terms are refused up front when one key's elements stack expansions past the candidates a single row can be assembled for, so bounding a fuzzed element's value with a transform that fixes its width -- a `substring` to a length, a `phonetic` code, a `parse_date` layout -- is what admits a key declaring more than one of them; the arithmetic is in [PROTOCOL.md](spec/PROTOCOL.md#the-width-bound-a-per-key-candidate-cap-the-terms-declare) |

**Bounding a `transpositions` element.** Its count is one candidate per pair of the value's positions, so it grows with the square of the width: 46 candidates at 10 characters. An element declaring `transpositions` must bound its value with a `transform` that fixes its width -- a `substring` to a length, a `phonetic` code, a `parse_date` layout -- and terms whose element bounds none are refused before the exchange runs. The widest width a single element may declare, and the tighter bound two stacked elements must each meet, are derived in [PROTOCOL.md](spec/PROTOCOL.md#which-party-expands-full-variant-and-deletion-neighbourhood-expansions).

**Which party expands.** `transpositions` and `adjacent_years` enumerate the whole set of values one transposition, or one year, away from the record's own, so one party enumerating is enough for a pair that far apart to match: they are generated by the receiving party alone, and the result is the same whichever party that turns out to be. `edit_distances` is generated by both parties, because two values a substitution apart meet only where each side's deletions overlap. Nothing about this is authored -- it follows from the method named -- and the reasoning is in [one-sided-fuzzy-expansion.md](notes/one-sided-fuzzy-expansion.md).

> **Not yet implemented:** `generate_fuzzy_comparisons` is accepted by the schema, but the expansion (transpositions, edit distances, adjacent years) is not generated at key-building time yet, so authoring it has no effect on matching today. It is not silently inert to the partner, though: an invitation carrying it shows the setting on the accepting party's consent display marked as proposed and not yet applied, so the partner weighs the term you authored rather than the narrower matching the run performs. A fuzzy term is not refused -- the run proceeds and simply matches without the expansion. Working fuzzy keys are targeted for the 1.0 release; see [ROADMAP.md](ROADMAP.md).

#### Transform steps

Each step in a `transform` array applies one function from the cleaning and standardizing function library. Steps are applied in order.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `function` | string | yes | Name of the function to apply (see Available functions in the [Data standardization](#data-standardizing-transformations) section) |
| `params` | object | no | Function-specific parameters |

#### Swapped keys

When a `swap` array is present, the receiver transmits a linkage key generated with the two named elements swapped, while the sender generates a linkage key with un-swapped elements. A `swap` target names an element by that element's effective identifier: its `name` if it declares one, otherwise its `field`. An element that declares a `name` is referenced by that `name`, not by its `field`. For example, a key might match first name swapped with last name to catch data entry errors where the names are reversed at one agency. Each `swap` target must resolve to an element of the same key by this rule; a target matching no element in its key is rejected when the terms are decoded, rather than silently doing nothing at exchange time.

**Matching in either order.** Once fuzzy matching is generated at key-building time (the note under [Element fields](#element-fields)), the receiver transmits BOTH orders -- the authored one and the swapped one -- so records whose two values agree and records whose two values are reversed both match, which is what a swap is authored for. Only the receiver does so: the two orders are the whole set of arrangements the pair admits, so one party transmitting both is enough for either arrangement to meet the sender's single key, and the result is the same whichever party resolves to the receiver ([one-sided-fuzzy-expansion.md](notes/one-sided-fuzzy-expansion.md)). A swapped key costs two candidate values per record toward the [`single-pass`](#linkage_termslinkage_strategy) dataset ceiling, in place of one, multiplied by whatever its elements declare. Until that flip, the receiver transmits the swapped order alone, so a swapped key matches the reversed arrangement and not the one that agrees.

The two elements a `swap` names must also declare the same [`generate_fuzzy_comparisons`](#element-fields) -- both the same value, or neither one. A swap moves the field references and leaves each element's own expansion where it is, so a pair declaring different expansions would widen a column one way on the party that swaps and another on the party that does not. A mismatched pair is rejected when the terms are decoded.

The same rule binds the pair's [`transform`](#element-fields): both positions must declare the same pipeline -- the same steps with the same parameters, or neither one a pipeline at all. A swap moves the field references and leaves each element's own transform where it is, so only a pair whose transforms agree compares like-normalized values on both sides of the swapped key. It is also what makes the key's verdict independent of which party is the receiver: that role is settled per run from the two parties' record counts, not written into the terms, so a pair with differing transforms would match on one run and not the next with no change to the agreed document. A mismatched pair is rejected when the terms are decoded.

Two spellings of the same pipeline are the same pipeline: an omitted `transform` and an empty list both mean "apply nothing", and a step's `params` keys are compared without regard to the order they were written in. Give the swapped pair one transform, the one the slot calls for. Cleaning that belongs to a column rather than to the slot -- a source system that stores one of the two fields differently -- goes in that column's [data standardizing transformation](#data-standardizing-transformations), which each party writes for its own input and applies before any key is built.

### `linkage_terms.linkage_rule_set`

*Type:* object  
*Required:* no  
*Consistency:* mandatory when both parties declare one

The named rule set the `linkage_fields` and `linkage_keys` above were drawn from -- a citation, not a specification. It names two artifacts and their content versions: `field_set` for the fields, `key_set` for the keys. [The built-in rules](#the-built-in-rules) are the one set psilink ships.

```yaml
linkage_terms:
  linkage_rule_set:
    field_set:
      name: "baseline-pii"
      version: "1.0.0"
    key_set:
      name: "hmis-keys"
      version: "1.0.0"
```

Every path that fills in your fields and keys for you writes this citation: a zero-setup exchange, the template `psilink init` writes, the web app's quick and Advanced invite paths, and the console's Direct exchange, whose confirm screen shows it in the terms it infers from your file. It travels wherever the terms do -- into the invitation, onto the wire, onto the accepting party's terms review, and into each party's exchange record, which is what lets "which rules did this linkage match on" be answered by a name and a version.

What it does and does not settle:

- **It is not what the exchange runs on.** The `linkage_fields` and `linkage_keys` are, and they are cross-checked between the parties field by field and key by key. A run matches on a subset of the cited set, never on an addition to it, so a citation is an upper bound on what was tried.
- **It is not vouched for, but it is checked where it can be.** Your partner's citation is text your partner wrote, and nothing resolves a partner's set name to content. What psilink can do is compare a name it recognizes against the rules the same document declares, one half at a time: a half naming a set this build ships is checked and reported as matching or **not** matching, and a half naming anything else is reported as unchecked. The accepting party's terms review shows that verdict beside each half, and a citation the build has disproved is a warning there rather than a refusal -- the exchange still runs on the declared keys and fields, which are what both parties are held to, and which the same screen shows. Each party's own exchange record carries the same verdict beside the citation it kept ([Exchange record format](spec/EXCHANGE_RECORD.md#the-rule-set-citation)).
- **Omit it for rules you author yourself.** Rules you author can cite only the built-in set -- there is no way to select another -- and citing a set your rules were not drawn from misdescribes them. A terms document you import keeps the citation its own author wrote, including one naming a set psilink does not ship; the web Advanced invite path drops that citation as soon as the rules stop being drawn from the set it names, exactly as it drops the built-in citation when you edit your way out of the rules it seeded from. It tells you when it will not carry an imported citation and why -- your edits moved the rules out of the cited set, the terms declare no key to claim provenance for, or the document cited the set psilink ships over rules that are not it -- and leaves you free to create the invitation without it.
- **A configuration file keeps the citation you edit past.** Editing `linkage_fields` or `linkage_keys` in `psilink.yaml` leaves the citation the file was written with in place, so the CLI checks it wherever it reads those terms and warns when the file's own rules no longer support it -- see [a rule-set citation that no longer fits](CLI.md#a-rule-set-citation-that-no-longer-fits).
- **Two parties that both cite a set must cite the same one**; a mismatch cancels the exchange before any data moves. A party that cites none is not held to the other's, which is what lets hand-authored rules meet an identical named set. A `psilink accept` that reuses a configuration already at the path applies the same rule when it compares that file against the invitation, so a citation the two disagree on is reported with the other terms differences and stops the acceptance, rather than passing there and cancelling the run later.

### `linkage_terms.legal_agreement`

*Type:* object  
*Required:* no  
*Consistency:* mandatory if present

Reference to the legal data sharing agreement authorizing this exchange, the purpose of the disclosure under it, and the agreement's expiration date. A single agreement can authorize several purposes; `purpose` is a brief readable statement of the one this exchange is for, carried in cleartext into the exchange record so the record stands alone as a HIPAA 164.528 accounting / FERPA 99.32 disclosure-log entry. All three fields are required when the block is present, and `reference`, `purpose`, and `expiration_date` are each cross-checked against the partner's; a mismatch cancels the exchange. The check is byte-exact, so both parties must configure identical text -- including the same Unicode normalization form; the same wording in a different normalization counts as a mismatch. If `expiration_date` has passed, the exchange fails before any data is transmitted.

```yaml
linkage_terms:
  legal_agreement:
    reference: "MOU-2025-0042"
    purpose: "Audit and evaluation of the State tutoring program"
    expiration_date: "2027-12-31"
```

### `linkage_terms.payload`

*Type:* object  
*Required:* no  
*Consistency:* mandatory if present

Additional data columns transmitted after the intersection is identified, over the established encrypted channel. Each party independently specifies what they will send and what they expect to receive. Column descriptions sent to the partner constitute a data dictionary.

```yaml
linkage_terms:
  payload:
    send:
      - name: "enrollment_date"
        description: "Date of program enrollment (YYYY-MM-DD)"
      - name: "benefit_amount"
        description: "Monthly benefit amount in USD"
    receive:
      - name: "case_id"
        description: "Partner agency case identifier"
```

A party that declares it receives no output (`output.expects_output: false`) may not list `payload.receive` columns: it cannot receive payload for matched records it never gets, so the combination is refused. A non-receiving party is sent no payload and refuses any it is sent regardless, so a non-receiving helper never receives the partner's disclosed columns. It may still `send` payload (to a partner that does receive output).

Five fields govern payload, and they sit at two different levels of the file. `payload.send` and `payload.receive` are members of this `linkage_terms.payload` block: they are the exchanged data dictionary -- what this party will disclose, and what it expects to receive -- and are cross-checked as a mirror, one party's `send` against the other's `receive`.

**`expected_payload_columns`, `disclosed_payload_columns`, and `outbound_payload_consent` are top-level keys of `psilink.yaml`, siblings of `linkage_terms`, not members of `payload` or of `linkage_terms`.** The level is load-bearing rather than cosmetic: `linkage_terms` and `payload` both strip keys they do not recognize, so one of these three nested inside either is dropped silently at parse -- no error, no warning, and the disclosure lock-in it was meant to establish simply does not exist. Check the indentation when you author one by hand.

The three are per-party local records that are never exchanged, cross-checked against the partner, or folded into the agreed-terms hash (each is deliberately kept out of the mirror). What they do is hold the actual runtime disclosure to what was promised, or consented to, at setup:

- **`payload.send`** -- the columns this party discloses, exchanged with the partner as a data dictionary. It must agree exactly with what this party's [input metadata](#input-metadata) actually transmits (`is_payload: true` and `role` not `ignored`, the single source of truth for disclosure); a `send` that over- or under-declares that set is refused before the exchange runs, so the dictionary shown for consent and written into the [exchange record](spec/EXCHANGE_RECORD.md) matches the bytes that flow. Empty is strict and absent is lazy, as for the three fields below: omitting `send` is exempt (the guided and default paths author none while metadata still transmits), while an explicit `send: []` declares that this party discloses nothing. It is held to that whenever the partner is entitled to the matched result. Accepting an invitation that declares `receive: []` gives you exactly that `send: []`, because the two are mirrored -- so a partner that asks for nothing, paired with an input file whose extra columns default to transmitted, is refused locally, before any credential, terms, or data are sent, naming the columns. Mark them `is_payload: false` (or `role: ignored`), or ask for a corrected invitation. A partner entitled to no result is sent no payload at all, so there the same pair runs and transmits nothing rather than being refused; a `send` that names columns is still held to the disclosed set in either direction, since that dictionary is exchanged, consented to, and recorded whatever moves.
- **`payload.receive`** -- what this party expects to be disclosed. Omitting it is lazy ("take whatever I am given") and that direction is not cross-checked; declaring it -- including an explicit empty `receive: []`, which asserts the partner discloses nothing -- is strict, and any divergence from the partner's `send` aborts the exchange before data moves. This empty-is-strict, absent-is-lazy convention lets an invitation be authored without the inviter knowing the partner's columns: the inviter declares only its `send`, the accepting party adopts that as its own `receive`, and the inviter takes whatever the partner's metadata turns out to disclose. Laziness relaxes only this declaration check, never what is disclosed -- each sender's own metadata always governs what it sends.
- **`expected_payload_columns`** (local, receive-side) -- the set this party locked in as what it will receive, checked against the *actually-received* columns at runtime after the payload exchange; a divergence aborts the exchange (the partner promised one disclosure and delivered another). It is set from an invitation's carried disclosed subset at accept time, or crystallized from a first observed exchange (an online inviter, or a `--save` run), and falls back to `payload.receive` for an authored recurring config. Same empty-is-strict, absent-is-lazy semantics.
- **`disclosed_payload_columns`** (local, send-side) -- the disclosed set this party promised, the send-side mirror of `expected_payload_columns`. It is checked at prepare time, before any credential, terms, or data are sent: if the current metadata can no longer produce exactly that set the run fails fast, naming the offending column(s), rather than under- or over-delivering and having the partner abort mid-exchange. Every invite path (re)records it, so re-inviting after editing your data keeps the promise in step and it cannot go stale.
- **`outbound_payload_consent`** (local, send-side) -- what an *accepting* party confirmed about its own outbound columns. An invitation authors what its sender discloses and, usually, nothing about what it will receive, so nothing in it authors the accepting party's own outbound set: that set comes from your input file, where a column psilink does not recognize is transmitted by default. Accepting records what it showed you (`status: confirmed` with the columns, or `status: pending` where it had no input file to resolve them from), and a run that resolves a different set -- wider or narrower -- shows it and asks again before any credential, terms, or data are sent, or refuses (exit 64) where there is no terminal to ask on. Omit it for an exchange whose outbound columns you authored yourself, such as one you invited a partner to; a run then sends whatever your metadata discloses, as `disclosed_payload_columns` holds it to what you promised.

All three sit beside `linkage_terms`, not inside it:

```yaml
linkage_terms:
  payload:
    send:
      - name: "enrollment_date"
    receive:
      - name: "case_id"

expected_payload_columns:
  - case_id
disclosed_payload_columns:
  - enrollment_date
outbound_payload_consent:
  status: confirmed
  columns:
    - enrollment_date
```

In practice you rarely author them: every path that establishes an exchange writes the ones it owns. Accepting an invitation records what the invitation disclosed and what the acceptance showed you; inviting records the subset the token published, and re-inviting refreshes it; a `--save` run crystallizes what the first exchange actually carried. Each is refreshed by the operation that could invalidate it, so the file cannot promise one disclosure while the exchange performs another. What you author by hand is the pair inside `payload`; what you review before an unattended run is these three.

The runtime lock-in mechanism, the wire field an invitation carries, the accepting party's own consent record, and how the observe-then-persist paths reach the same lock-in are specified in [EXCHANGE_FILE.md](spec/EXCHANGE_FILE.md#payload-disclosure-consent).

---

## Connection

Specifies the communication channel and server addresses. The partner shared secret is configured separately, in the top-level [`authentication`](#authentication) block; for WebRTC, the inviter/acceptor peer-addressing role is [`connection.role`](#connectionrole).

### `connection.channel`

*Type:* enum: `webrtc` | `sftp` | `filedrop`  
*Required:* yes

The communication channel for the exchange. See [COMMUNICATION.md](COMMUNICATION.md) and [DEPLOYMENT.md](DEPLOYMENT.md) for infrastructure requirements for each channel.

| Value | Description |
|-------|-------------|
| `sftp` | Parties connect to a shared SFTP server and exchange files there |
| `webrtc` | Both parties connect via a PeerJS peer-coordination server and exchange data over a WebRTC data channel |
| `filedrop` | Parties exchange files through a locally-mounted directory (e.g. a network folder backed by an SFTP server, to which their partner connects directly) |

### `connection.path`

*Type:* string  
*Required:* filedrop only, unless the split [`inbound_path`/`outbound_path`](#connectioninbound_path--connectionoutbound_path) pair is used instead  
*Applies to:* `filedrop`

Absolute path to the shared directory on the local filesystem, used in shared mode (one directory both parties read and write). Both parties must be able to read and write files in this directory. Use `file://` URLs with the CLI for zero-setup exchanges. Mutually exclusive with the `inbound_path`/`outbound_path` pair; supply exactly one of the two forms.

```yaml
connection:
  channel: filedrop
  path: /mnt/sftp-share/exchanges/agency-a-agency-b
```

### `connection.inbound_path` / `connection.outbound_path`

*Type:* string  
*Required:* no (the split alternative to a single shared directory)  
*Applies to:* `filedrop` (top-level) and `sftp` (under `server`, see below)

A *split* configuration for deployments where the inbound and outbound folders are separate -- a managed share, or an SFTP server with distinct drop and pickup directories -- so a single shared path cannot describe the exchange. This party reads the peer's files from `inbound_path` and writes its own to `outbound_path`; the two parties' folders are bridged by the deployment (one party's outbound is the other's inbound). Each party's directory choice is its own and is not constrained by the peer's.

Rules:

- Set both halves together, or neither; `inbound_path` and `outbound_path` are mutually exclusive with the single `path` (filedrop) / `server.path` (sftp).
- The two directories must differ. This is checked by the same textual normalization at config validation and again when the connection opens (both channels), so a pair that resolves to one directory fails to parse rather than only failing later at connect time: differences that are only redundant separators, `.` segments, a trailing slash, or -- for filedrop -- backslashes are caught. Equivalences that cannot be settled client-side are NOT caught and are the operator's responsibility to keep distinct: `..` segments (which may cross a symlink), case (Windows filesystems are case-insensitive), and -- for SFTP -- a relative path versus the absolute path it expands to under the login home.
- A split configuration requires retain mode (`options.retain_files: true`), which in turn requires `lockless_rendezvous: true` and `timestamp_in_filename: true`. Retain mode is what keeps the exchange working across a one-way or delete-suppressing bridge and preserves an auditable record of what flowed each way; see [docs/spec/FILE_SYNC.md](spec/FILE_SYNC.md#split-inboundoutbound-directories).
- filedrop paths must be absolute (as `path` is). SFTP paths may be absolute or relative, as `server.path` allows. Retain mode requires a fresh directory, which is enforced for *both* directories; an SFTP login-home is usually not empty, so pointing a split directory at it will often be rejected by that check.

```yaml
# File-drop with separate inbound and outbound folders
connection:
  channel: filedrop
  inbound_path: /mnt/share/from-partner
  outbound_path: /mnt/share/to-partner
  options:
    retain_files: true
    lockless_rendezvous: true
    timestamp_in_filename: true
```

**From the CLI.** Pass `--outbound-path DIR` on the zero-setup exchange, `psilink invite`, `psilink accept`, or `psilink exchange` to configure a split directory without hand-writing the pair. The directory the command already names becomes the inbound directory -- the server URL or positional path for the zero-setup, invite, and accept commands, or the loaded config's directory for `psilink exchange` -- and `--outbound-path` becomes the outbound. It applies to both `sftp` and `filedrop` and rejects an outbound equal to the inbound, under the same rules a hand-written config is validated against. It requires retain mode: pass `--retain-files` (which implies `--lockless-rendezvous` and `--timestamp-in-filename`), or, for `psilink exchange`, have `retain_files: true` in the config it reads. Each party sets its own `--outbound-path`; it is a per-party choice, not negotiated with the peer.

```sh
# Zero-setup file-drop with split directories: read the peer's files from
# from-partner, write your own to to-partner, retaining a transcript of both.
psilink --retain-files --outbound-path /mnt/share/to-partner \
  file:///mnt/share/from-partner records.csv results.csv
```

**Mirror relationship across an invitation.** When an invitation carries a split-directory endpoint, the acceptor's seeded connection block starts as the inviter's *mirror image*: the acceptor's `inbound_path` is taken from the inviter's `outbound_path` and its `outbound_path` from the inviter's `inbound_path`, because one party's outbound is the other's inbound. The invitation conveys this role swap, so neither operator hand-edits which folder is inbound. The seeded block also carries the retain-mode options a split exchange requires, so it is runnable once the credential placeholders are filled in. `psilink invite` emits the inviter's own pair verbatim onto the endpoint, so the swap is applied at exactly one place, on the accepting side.

This keeps a Docker mount layout fixed. The two container mounts can stay constant -- for example `/data/in` and `/data/out` -- and the invitation, not a per-side config edit, decides which the party reads and which it writes. The folder *names* may still need a manual edit in an asymmetric topology, where the two parties' paths -- or even channels -- differ (one party syncing a local `file:///` directory up to a server the other reaches over `sftp://`): the swap fixes the *roles*, and the concrete paths, host, and channel are reconciled by the operator through the normal accept reconcile flow. An SFTP login-home (unset) path has no concrete value to mirror, so such an endpoint conveys the roles with no suggested path rather than failing.

### `connection.server`

*Type:* object  
*Required:* yes (webrtc and sftp only)  
*Applies to:* `webrtc`, `sftp`

The primary server for the exchange. For WebRTC this is the PeerJS peer coordination server; for SFTP this is the SFTP host. A URL may be supplied as a convenience and will be decomposed into its component fields; the component fields are the authoritative form. The component fields are percent-decoded from the URL form, so author a reserved or non-ASCII character percent-encoded in the URL (for example a space as `%20`); it is stored decoded.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | yes | Hostname or IP address |
| `port` | integer | no | Port number; defaults to the protocol standard (443 for HTTPS/WSS, 22 for SFTP) |
| `path` | string | no | URL path for WebRTC signaling; remote working directory (shared mode) for SFTP |
| `inbound_path` | string | SFTP only | Inbound (peer-written) remote directory for a split-directory exchange; see [`connection.inbound_path` / `connection.outbound_path`](#connectioninbound_path--connectionoutbound_path). Set with `outbound_path`; mutually exclusive with `path`; requires retain mode |
| `outbound_path` | string | SFTP only | Outbound (self-written) remote directory for a split-directory exchange; the companion to `inbound_path` |
| `username` | string | SFTP-consumed; accepted but unread on webrtc | Username for server authentication |
| `key` | string | WebRTC only | PeerJS API key for private PeerJS servers; omit when using a public server. Defaults to `peerjs`, the key a PeerJS deployment serves under unless it is configured otherwise |
| `secure` | boolean | WebRTC only | Whether the signaling socket is opened over TLS (`wss:`) rather than plain `ws:`. Defaults to `true`; signaling carries the derived rendezvous ids and both parties' candidate addresses, so plaintext is a deliberate choice for a server reached without a network in between (a loopback or test broker), never one an omission produces. A browser peer has no equivalent field: it takes the scheme from the page it was served over. The `port` default follows it -- 443 when secure, 80 otherwise -- and `path` defaults to `/` |

#### SFTP server authentication

SFTP requires at most one primary authentication method alongside `username`. `private_key_passphrase` is a companion to `private_key` and is invalid without it.

| Field | Type | Description |
|-------|------|-------------|
| `password` | string | Password authentication; `@`-file recommended |
| `private_key` | string | Path to SSH private key; `@`-file recommended |
| `private_key_passphrase` | string | Passphrase for an encrypted private key; only valid with `private_key`; `@`-file recommended |
| `keyboard_interactive` | boolean | Answer the server's `keyboard-interactive` authentication prompts with `password`, in addition to offering the direct `password` method; only valid with `password`. Enable this for a server that disables the SSH `password` method but accepts the same password over `keyboard-interactive`. Every prompt is answered with the same configured password, so it cannot satisfy a multi-prompt or one-time-code challenge. Default `false`. Applies to the CLI `sftp` channel only. |
| `host_key_fingerprint` | string or list | OpenSSH SHA256 host-key fingerprint (`SHA256:<43 standard base64 chars>`, the `+`/`/` alphabet OpenSSH emits, not base64url), or a non-empty list of them. When set, the server's host key is verified before authentication and the connection is rejected unless it matches one of the listed fingerprints. A list gives zero-downtime host-key rotation: pin the incoming key alongside the current one during the rekey window so either is accepted with no failed exchange in between, then drop the old entry after the cutover. When absent, the connection is **refused** (fail-closed): an interactive run instead establishes the pin on first use -- any command that opens the SFTP connection (`exchange`, an online `invite`/`accept`, or a zero-setup exchange) prompts with the presented fingerprint and, on confirmation, records it -- while a non-interactive run fails closed. So this field is typically pinned out-of-band or populated automatically on the first interactive run; see [CLI.md](CLI.md#sftp-host-key-trust). `@`-file supported (per entry). Applies to the CLI `sftp` channel only. |

```yaml
# WebRTC example
connection:
  channel: webrtc
  server:
    host: api.peerjs.com
    port: 443

# SFTP example
connection:
  channel: sftp
  server:
    host: sftp.example.org
    port: 22
    path: /exchanges/agency-a-agency-b/
    username: psilink
    private_key: "@/run/secrets/id_ed25519"
    host_key_fingerprint: "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s"

# File-drop example (network-mounted folder)
connection:
  channel: filedrop
  path: /mnt/sftp-share/exchanges/agency-a-agency-b

# SFTP host-key rotation: pin the incoming key alongside the current one for the
# rekey window so either is accepted, then drop the old entry after the cutover.
connection:
  channel: sftp
  server:
    host: sftp.example.org
    host_key_fingerprint:
      - "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s" # current
      - "SHA256:0PNQ1x9Pe3aaFqkPq0n8Uihhi8nN2nx2nKQ0gWqXm8s" # incoming
```

#### On-demand server provisioning

When the primary server is allocated on demand rather than always running, a `provision` sub-object can be added to `server`. It describes the endpoint that brings the server up before either party connects. There are two modes:

**Lifecycle provisioning**: the server has a fixed, known address but is started on demand to avoid consuming resources between exchanges. The static `host` and other `server` fields are present alongside `provision` in both parties' configs; `provision` is the call that wakes the server. Both parties may call the same endpoint independently before connecting.

**Address-returning provisioning**: the endpoint allocates a fresh resource and returns its address. Because the address is unknown until provisioning runs, this is asymmetric: the provisioning party (conventionally the inviter) calls the endpoint during exchange setup via the web application, and the resulting static `server` fields are written into the other party's config before either party runs the CLI. At run time the provisioning party's config retains `server.provision`; the other party's config has only static `server` fields.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | yes | Hostname of the provisioning API |
| `port` | integer | no | Port; defaults to 443 |
| `path` | string | no | API path |
| `auth` | object | no | Authentication credentials (see [HTTP service authentication](#http-service-authentication-auth)) |

> **Not yet implemented:** `server.provision` is accepted by the schema, and its `auth` credentials resolve their `@`-file references, but no connect path calls the endpoint. A config carrying it connects straight to the static `server` fields, so the server must already be running. Provision it out-of-band until the call is wired in.

```yaml
# Lifecycle provisioning: wake a serverless PeerJS instance before connecting
connection:
  channel: webrtc
  server:
    host: peerjs.example.org
    port: 443
    provision:
      host: api.example.org
      path: /peerjs/start
      auth:
        bearer: "@provision.key"
```

### `connection.role`

*Type:* string (`inviter` | `acceptor`)  
*Required:* no  
*Applies to:* `webrtc`

Records this party as the inviter or acceptor. This is a peer-addressing concern specific to the WebRTC transport -- which is why it lives on the connection config rather than in the channel-agnostic top-level [`authentication`](#authentication) block -- and is orthogonal to the PSI protocol roles, which are determined by [`linkage_terms.output`](#linkage_termsoutput). For `sftp` and `filedrop` this field is not part of the schema and is silently dropped.

**Required on a `webrtc` connection the CLI runs, and the two parties must differ.** Each party's deterministic PeerJS peer ID is derived from the shared secret and its own `inviter`/`acceptor` label, and it dials the ID the other's label derives, so this field is what tells a party which end it is. A CLI configuration missing it is a usage error before anything is dialed, and one where both parties set the same value fails at the coordination server with an ID collision. It also fixes the key-exchange role each party takes (`acceptor` -> initiator, `inviter` -> responder), so it must not be edited to "fix" a connection: swapping it swaps which peer ID this party registers under.

`psilink invite` and `psilink accept` set the field themselves on every WebRTC connection block they write -- `inviter` from the inviting side, `acceptor` from the accepting side -- so the two parties to one exchange hold complementary roles with neither operator authoring it. A `ws://`/`wss://` URL to `psilink invite` builds the webrtc connection block, saves it, and mints an invitation carrying that same host/port/path as the endpoint the partner dials; `psilink accept` seeds its own connection block from that endpoint. See [Inviting over WebRTC](CLI.md#inviting-over-webrtc).

The web application supplies the same label from its own flow rather than from this field.

```yaml
connection:
  channel: webrtc
  server:
    host: api.peerjs.com
  role: inviter
```

### `connection.stun`

*Type:* array  
*Required:* no  
*Applies to:* `webrtc`

STUN servers for ICE candidate gathering. Each entry is a string in `stun:` or `stuns:` URI format. Mutually exclusive with `ice_provision`; if `ice_provision` is present, `stun` is invalid.

> **Honored by the CLI only.** The CLI builds its peer connection from `stun` and `turn`, and a configured list replaces the built-in default rather than adding to it, so the list you author is the list used. The browser client still builds its peer connection with a fixed set of STUN servers and no TURN entry, so on a web-conducted exchange these fields change no candidate the browser gathers. See [CLI.md](CLI.md#stun-and-what-it-discloses) for the default that applies when neither is set, what it discloses, and the idiom for gathering host candidates only.

```yaml
connection:
  stun:
    - "stun:stun.example.org:3478"
    - "stuns:stun2.example.org:5349"
```

### `connection.turn`

*Type:* array  
*Required:* no  
*Applies to:* `webrtc`

TURN servers for the case where a direct peer-to-peer connection cannot be established. Credential type `hmac-sha1` indicates how a deployment MINTS a time-limited credential rather than how a client presents one -- the minted value is still sent as the password -- so both types take the same shape here. Mutually exclusive with `ice_provision`; if `ice_provision` is present, `turn` is invalid.

The CLI passes these entries to its peer connection (the browser client does not -- see [`connection.stun`](#connectionstun)), but **no exchange has been driven through a real relay**: the path is configured and unproven. Do not build a deployment that depends on relayed connectivity until it has been verified in your environment.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes | TURN server URI (`turn:` or `turns:`) |
| `username` | string | yes | TURN username |
| `credential` | string | yes | TURN credential; `@`-file recommended |
| `credential_type` | enum | no | `password` (default) \| `hmac-sha1` |

```yaml
connection:
  turn:
    - url: "turns:turn.example.org:443"
      username: alice
      credential: "@/run/secrets/turn.key"
```

### `connection.ice_provision`

*Type:* object  
*Required:* no  
*Applies to:* `webrtc`

A provisioning endpoint that returns a complete set of ICE servers -- STUN and TURN combined -- for the current exchange. Both parties name the same endpoint and call it independently, so each may receive different time-limited credentials pointing to the same infrastructure. This matches the API shape of commercial ICE credential services such as Twilio Network Traversal Service. Mutually exclusive with static `stun` and `turn`.

The endpoint is not called by either application. The web client ignores it (see [`connection.stun`](#connectionstun)); the CLI refuses a connection that sets it, rather than ignoring it and silently falling back to a default the operator did not choose -- list the servers directly under `stun` and `turn` instead.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | yes | Hostname of the ICE credential API |
| `port` | integer | no | Port; defaults to 443 |
| `path` | string | no | API path |
| `auth` | object | no | Authentication credentials (see [HTTP service authentication](#http-service-authentication-auth)) |

```yaml
connection:
  ice_provision:
    host: nts.twilio.com
    path: /v1/credentials/ice
    auth:
      username: your-twilio-account-sid
      password: "@/run/secrets/twilio.key"
```

### `connection.proxy`

*Type:* object  
*Required:* no  
*Applies to:* `sftp`

A WebSocket-to-TCP proxy that tunnels the SFTP connection through HTTPS. This field is determined by the client's network capabilities, not the server: a browser-based client requires it because browsers cannot open raw TCP connections, while a CLI client connects natively and omits this field. The two parties' configs will therefore differ here even when connecting to the same server.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | yes | Proxy hostname |
| `port` | integer | no | Port; defaults to 443 |
| `path` | string | no | Proxy path |
| `auth` | object | no | Authentication credentials (see [HTTP service authentication](#http-service-authentication-auth)) |

### HTTP service authentication (`auth`)

The `server.provision`, `ice_provision`, and `proxy` objects each accept an optional `auth` sub-object. Exactly one authentication method may be specified. `username` and `password` must appear together; neither is valid alone.

| Field | Type | Description |
|-------|------|-------------|
| `bearer` | string | Bearer token; `@`-file recommended |
| `username` | string | Username for HTTP Basic authentication |
| `password` | string | Password for HTTP Basic authentication; `@`-file recommended |

```yaml
connection:
  server:
    host: peerjs.example.org
    provision:
      host: api.example.org
      path: /peerjs/start
      auth:
        bearer: "@/run/secrets/provision.key"
```

### `connection.options`

*Type:* object  
*Required:* no

Channel-agnostic and channel-specific tuning parameters. A configuration warning is made if fields specific to a channel are given that do not apply to the active one.

#### Shared options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `peer_timeout_ms` | integer | 3600000 | Milliseconds to wait for the partner at any single step before giving up, applied both to the initial rendezvous and to each message exchanged during the protocol; if the partner goes silent past this window the exchange fails with a transport error. The effective limit is the minimum of this and the remaining shared-secret lifetime. Must be a positive integer. It does not govern teardown, which runs on a short fixed budget of its own that this value caps only if you set it lower -- and capping the wait does not shorten the close, so a very small value can leave the command printing its teardown line a little after its final output. See [SFTP connection teardown](#sftp-connection-teardown). The 3600000 default is the file-sync (`sftp`, `filedrop`) one. On `webrtc` an absent field is not that default: the transport's own three budgets apply -- 600000 at the rendezvous, 30000 for the data channel to open once both parties' session descriptions have been exchanged, and 3600000 of silence on the open channel -- and a value set here replaces all three. |
| `server_connect_timeout_ms` | integer | 30000 | Milliseconds to wait during each connection attempt to the primary exchange server. Must be a positive integer (zero is not a meaningful "no timeout"). |
| `max_reconnect_attempts` | integer | 3 | Maximum number of times to retry dialing the connection within a single connection attempt after a fast transient failure (for example, while a share or its permissions are still settling), each attempt bounded by `server_connect_timeout_ms`. A timed-out attempt is terminal and is not retried, and so is a key exchange that fails because the server accepts only algorithms this host's crypto provider cannot perform; the same negotiation failure on a host missing nothing is retried like any transient (see [Key-exchange algorithms and the host's crypto provider](#key-exchange-algorithms-and-the-hosts-crypto-provider)). The same value also caps how many sessions the exchange may lose mid-exchange in the default held-session mode: on the SFTP channel a clean session drop mid-exchange (typically a server-enforced session or idle limit) is transparently re-dialed -- reusing the pinned host key and stored credentials -- and the interrupted operation re-issued, so the exchange survives it, but only for this many lost sessions over the whole exchange, after which the next loss ends the exchange with a terminal non-zero error naming this budget and the two remedies (raise this setting for a flaky link; set [`connection_per_poll`](#sftp-only-options) for a server that caps session lifetime). Every lost session spends one, whether its re-dial succeeded, failed, or was refused because the budget was already spent -- and the error reports the run's lost-session tally against this budget rather than a count of re-dials made. That mid-exchange budget is a separate counter of the same size as the dialing-retry loop (the two do not share one tally), is strictly cumulative (it does not reset on progress), does not apply to `connection_per_poll` mode, and is not charged for the teardown abort-marker write. Zero is a valid value and means what it says on both counters: connect once without a dialing retry, and treat the first mid-exchange drop as terminal. Other unrecoverable conditions (a fatal protocol error, a rejected host key, or the peer-timeout budget) also end the exchange terminally. Bounded above by a sanity ceiling (one retry per second for seven days). |

#### SFTP and file-drop options

These options apply to both `sftp` and `filedrop` channels.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `poll_interval_ms` | integer | 5000 | Milliseconds between checks for the partner's uploaded file. The default is conservative so it stays within SFTP servers' anti-flood/DoS limits; because per-round encryption dominates an exchange's wall-clock time, a multi-second interval adds negligible latency. Lower it (for example to 100 ms) only for a local mount, CI, or a demo against a controlled server. The `--polling-frequency` CLI flag overrides this at runtime and accepts a sub-second value such as `100ms` (see [CLI configuration](CLI.md#configuration)). |
| `timestamp_in_filename` | boolean | false | When `true`, each outgoing message filename also encodes a UTC timestamp and a per-session sequence number (see [Message filenames](#message-filenames)). Useful for filename-based logging in sync-mediated environments where the sync tool stamps files with the transfer time rather than the original creation time. |
| `lockless_rendezvous` | boolean | false | When `true`, the rendezvous handshake uses an ack-handshake barrier (`<id>-hello.json` plus a zero-length acknowledgment marker `<myId>-<peerId>-hello-ack.json` named after the peer hello it acknowledges) instead of the default atomic lock-file race (`<id>-hello.json` + `<peer1>-<peer2>-lock.json`). Required on sync-mediated transports that lack atomic exclusive-create or deletion visibility during rendezvous (e.g. a cloud sync service reconciling two local mirrors where both sides "win" a local create). Both parties must set this identically. The setting is advertised in the hello payload, and a mismatch fails fast at rendezvous with a clear error naming each side's setting, rather than stalling until the peer timeout. The detection mechanism, including its best-effort symmetric guarantee, is specified in [FILE_SYNC.md](spec/FILE_SYNC.md#bilateral-configuration-detect-and-fail-never-negotiate). The operational sync glob in lockless mode is `<myId>-*` (upload) / `<partnerId>-*` (download), which covers hello, ack, and message files while excluding in-flight `temp-*.tmp` writes. |
| `peer_id` | string | - | A stable, human-readable identifier for this party. Appears in every filename this party writes (hello, message, ack) and in server-side logs and transcripts. When unset, a UUID is generated at construction time. **Recommended for unattended and scheduled runs**, where it turns the leftover a killed run leaves into an immediate start-up refusal naming the file rather than a failed run (see [Directory exclusivity](#directory-exclusivity)); note that a stable id also makes this party's runs linkable to each other in the partner's logs. Requires `timestamp_in_filename: true`; a reused stable id without a timestamp segment can collide with a leftover file from a crashed prior session. The two parties must use distinct ids, and neither may be the other's id extended by `-` (e.g. `"site"` and `"site-2"` are rejected at rendezvous; see [FILE_SYNC.md preconditions](spec/FILE_SYNC.md#preconditions-for-a-correct-exchange)). Spaces and `-` are permitted within a `peer_id`. The value `"temp"` is reserved. Filesystem-unsafe characters (`/` and NUL on all platforms; `<`, `>`, `:`, `"`, `\`, `|`, `?`, `*` on Windows NTFS) are not validated but may cause errors at the transport layer. |
| `retain_files` | boolean | false | When `true`, the receiver writes an [acknowledgment marker](#acknowledgment-markers) after consuming each message rather than deleting it, and the sender gates its next write on that marker rather than on the message file disappearing. Once rendezvous completes, no exchange file is deleted as a protocol step and the shared directory becomes a permanent transcript; a rendezvous that fails before it completes is the exception and clears its own files (see [Directory exclusivity](#directory-exclusivity)). Requires `timestamp_in_filename: true` -- without it, every message from the same party would share a filename and a retained transcript would overwrite itself. Also requires `lockless_rendezvous: true` -- lock rendezvous is delete-based and cannot produce the whole-directory no-delete transcript retain mode guarantees. The CLI `--retain-files` flag implies both `--lockless-rendezvous` and `--timestamp-in-filename` when those are not already set. Both parties must set this flag identically, advertised and fast-failed exactly as `lockless_rendezvous` above. An invitation minted while it is on **declares it to the partner**, who is shown the retained transcript on their acceptance display before they consent -- so a partner is told what the exchange leaves behind rather than meeting it at a failed run. The declaration is disclosure only: it sets nothing on the accepting side, which still configures its own half here, and a mismatch still fails at the same place. (When both flags differ at once -- only possible as `retain=true`/`lockless=true` versus both `false`, since `retain_files` implies `lockless_rendezvous` -- the error names the `retain_files` mismatch, which a single rerun realigns.) **Each exchange needs a fresh directory**, enforced before the run: a stale message or ack marker from a prior session would corrupt or stall it. Reusing a retain directory is a deliberate CLI-only recovery; see [Directory exclusivity](#directory-exclusivity) for the guard, the flags that clear it, and what they discard. |
| `unexpected_files` | enum | mode-coupled (see description) | How to handle a file that appears in the shared directory *during* the message loop and is neither recognized as part of this exchange nor an in-flight temporary write of its own -- a sign the directory is being shared with another process or session, or that a sync tool produced a conflict copy or partial download (see [Directory exclusivity](#directory-exclusivity)). One of `error` (fail with a usage error (exit 64) naming the file and the directory path), `warn` (log once per distinct file name and continue), or `ignore` (skip silently). **Local, not bilateral**: detecting a foreign file is an observation of one's own directory view, needs no peer agreement, and carries none of the mismatch-stall risk of `lockless_rendezvous`/`retain_files`; the two parties may use different values. When unset the effective default is mode-coupled: `error` on plain delete-mode transports (ordinary `sftp`/`filedrop`) and `warn` when `retain_files` or `lockless_rendezvous` is set -- those flags signal a sync-mediated transport that legitimately produces transient conflict copies and partial downloads mid-session, where a hard fail would abort exactly the exchanges retain mode targets. An explicit value always overrides the mode-coupled default. This setting governs foreign-file detection only; a malformed *protocol* file (a peer-prefixed, message-shaped name a correctly configured peer cannot produce) is always reported regardless of this setting. |

#### SFTP-only options

These options apply to the `sftp` channel only. Setting one on `filedrop` (which holds no session) or any other channel is accepted but has no effect, and the CLI warns that it is ignored.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `connection_per_poll` | boolean | false | When `true`, a fresh SFTP session is opened at the start of each poll cycle and released before the loop goes idle again, instead of holding one session for the whole exchange. Because each cycle's session then needs only survive that cycle's seconds, the poll loop ordinarily does not reach a server's maximum-session-duration or idle cap. When to set it is below; the session model it runs under is in [FILE_SYNC.md](spec/FILE_SYNC.md#session-lifetime-across-an-idle-boundary), and what a run counts and warns about in [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#sftp-mid-exchange-session-recovery). |

**When to set `connection_per_poll`.** Set it when the partner's SFTP server enforces a session-lifetime limit you cannot change and a single exchange spans many idle poll gaps -- a slow peer that reconciles the directory only occasionally, so an exchange lasts hours. Pair it with a minutes-scale `poll_interval_ms`: the mode pays a full SSH handshake every cycle, negligible at a long interval and wasteful at a short one, so a sub-minute interval draws a CLI warning, as does the `--connection-per-poll` flag with no long `--polling-frequency`.

It is a local choice, not a bilateral one: how this party dials is invisible to the peer, so the two parties may set it differently and a difference cannot fail the rendezvous. Two idle stretches still hold a session even under the mode -- the rendezvous wait, and a boundary reached while one of this side's operations is still unsettled -- and a server cap that cuts either is transparently re-dialed, so the exchange completes either way. Leave it unset for an ordinary exchange against a server with no session cap.

#### SFTP connection teardown

Closing an SFTP connection is a two-party act: this side disconnects, and the partner's server closes the connection. Some servers accept the disconnect and then go quiet, leaving it half-open. psilink bounds that wait in **both session modes**, the default held session and [`connection_per_poll`](#sftp-only-options): past a short fixed teardown bound it closes the connection from this side and the command finishes normally.

What you may see, at the end of a run and at most once:

- An informational line naming what left the connection open and stating that this side closed it. It is not an error and it is no verdict on the run -- this close is the last step of teardown, so it changes neither the results nor the exit code, and a run that failed for another reason draws the same line.
- A warning in its place when this side could not close it either. The connection is then left to the operating system, it may stay half-open, and the command may not exit on its own. The warning names what could not be done and where to check what changed; like the line, it is no verdict on the run.
- Nothing at all against a server that closes normally.

Do not read either as the mid-exchange release warning `connection_per_poll` can draw from the same class of server: that one names an idle boundary in the *middle* of an exchange and is paced and totalled. The bound, the forced close behind it, and the run accounting are specified in [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#sftp-mid-exchange-session-recovery).

#### Message filenames

On the `sftp` and `filedrop` channels each party writes its outgoing messages as files in the shared directory; the partner polls for them. A message is the digit-terminal case of the [filename grammar](#filename-grammar) below, which defines the byte-count segment and the size gate the receiver applies to it. Two concrete shapes exist, selected by `timestamp_in_filename`.

With `timestamp_in_filename` unset (the default), the format is:

```
<id>-<byteCount>.json
```

With `timestamp_in_filename: true`, the filename additionally carries a timestamp and counter:

```
<id>-<YYYYMMDDTHHMMSS>-<NNN>-<byteCount>.json
```

`<YYYYMMDDTHHMMSS>` is the UTC write time in compact ISO 8601 form (no colons or hyphens, so it is Windows-safe and sorts lexicographically by time). `<NNN>` is a per-session counter that starts at `000`, is zero-padded to three digits, and increments with each message sent; it widens to four or more digits only after the 1000th message of a session.

In-flight writes use a temporary `.tmp` file that is renamed to the final `.json` name only once the write completes, so a sync tool watching `*.json` never observes a partial file under its final name. Handshake files (`<id>-hello.json`, `<peer1>-<peer2>-lock.json`, and the rendezvous [acknowledgment marker](#acknowledgment-markers)) are separate from message files; how they sequence a rendezvous is in [FILE_SYNC.md](spec/FILE_SYNC.md).

#### Acknowledgment markers

An acknowledgment marker is a zero-length file the receiver writes to signal that it has taken a message or a hello, in place of deleting it. Two kinds exist and they share one shape: under `retain_files: true` the receiver writes one after consuming each message, and under `lockless_rendezvous: true` each party writes one for the peer hello it has seen. Its terminal segment is the `ack` type word rather than a digit string, so it is never mistaken for a message even though a consumed message's `<NNN>` and `<byteCount>` appear mid-name:

```
<receiverId>-<senderId>-<YYYYMMDDTHHMMSS>-<NNN>-<byteCount>-ack.json   # a consumed message
<myId>-<peerId>-hello-ack.json                                         # a peer hello
```

Each is named after the file it acknowledges, prefixed with the id of the party that wrote it, so the two parties' markers never collide and either party can construct the name it is waiting for rather than parsing what is on disk.

Because no exchange file is ever deleted, the directory accumulates each message and its ack on every transport -- including those, such as SFTP, that do support deletion -- so it is a durable transcript, not only a workaround for transports that cannot propagate deletions. The hellos and acks of a completed rendezvous persist in it too; a rendezvous that fails instead clears the failing party's own hello and ack (see [Directory exclusivity](#directory-exclusivity)). The transcript accumulates with no in-protocol cleanup; retention, rotation, and archival are out-of-band operator responsibilities.

How the marker is constructed and gated on, and the retain-mode close-time behavior, are part of the transport state machine and are specified in [FILE_SYNC.md](spec/FILE_SYNC.md#phase-2----message-loop-retain-mode).

#### Directory exclusivity

The shared directory (SFTP path or local filedrop path) must be **dedicated exclusively**, for protocol-grammar files, to a single active exchange between exactly two parties. Both channels treat the directory as a private communication channel: each party reads and deletes files written by the other, and the rendezvous protocol uses filename presence as a synchronization signal.

A third process writing protocol-grammar files -- `<id>-hello.json`, `<peer1>-<peer2>-lock.json`, a `<id>-...-ack.json` marker, or a message-shaped `<id>-<digits>.json` -- into the same path during an active session will cause the exchange to abort with a diagnostic error. Separate concurrent exchanges must use separate directories.

**Foreign (non-protocol) files are tolerated.** A file whose name does not match the protocol grammar -- an unrelated file, or a sync tool's conflict copy or partial download -- does not abort the exchange. Foreign files present at session start are snapshotted and ignored for the session; one that first appears mid-session is handled by [`unexpected_files`](#connectionoptions) (`error`/`warn`/`ignore`). The protocol never deletes a foreign file. The exclusivity requirement is therefore on the protocol-grammar namespace, not on the directory as a whole. Note that a foreign file whose name coincidentally matches the message grammar (`<peerId>-<digits>.json`) is *not* foreign -- it is treated as a protocol message and rejected -- so this tolerance covers genuinely non-grammar names only.

**Every exchange starts from a fresh directory, and the guard enforces it.** Before a run begins, the directory must be empty of protocol files except for at most one peer hello -- the file a partner who arrived first legitimately leaves. Foreign, non-protocol files are tolerated and do not count. The rule applies in both message-loop modes, but it is what protects retain mode in particular, where a stale message or ack marker from a prior session would be mis-consumed against the receiver's counter or would prematurely release the sender's gate, corrupting or stalling the exchange with no error.

**Recovering a contaminated or reused directory (CLI-only).** When a prior run crashed, or a bilateral-mode mismatch left protocol files behind, that guard refuses the next run (exit 64). The refusal names the directory, how many offending files it found, and as many of their names as fit the operator-facing display budget -- a long path is shortened before the names are, and a name too long to show whole is counted rather than shown in part; the directory itself is the full list. Remove those files after confirming no other session is using the path, or re-run with `--sweep-exchange-files`.

What the leftover kinds tell you:

- **A lock file (`-lock.json`), a joining sentinel (`-joining.json`), a message, or a hello under your own `peer_id`** usually means a previous exchange was terminated by SIGKILL, an out-of-memory kill, or power loss before its cleanup ran.
- **An ack marker (`-ack.json`)** means a crashed lockless rendezvous, or -- in retain mode, which never deletes -- a directory reused for a second exchange. If a live lockless peer may still be mid-rendezvous, wait for it to complete or time out before retrying rather than clearing the directory underneath it.

`--sweep-exchange-files` deletes every protocol file (this party's and the peer's) and starts a fresh exchange; foreign files are left untouched, and the interrupted run is not resumed. The sweep refuses if the directory shows a retain-mode signal -- it will not silently destroy a durable audit transcript -- so clearing such a directory requires the additional `--force-retain-sweep`, which permanently discards the prior transcript. These two flags are **CLI-only and invocation-scoped**: they are not `connection.options` keys and cannot be set in `psilink.yaml` ("always sweep" is not a state to persist). `--force-retain-sweep` requires `--sweep-exchange-files` and is rejected on its own. What the sweep deletes and what it refuses is specified in [FILE_SYNC.md](spec/FILE_SYNC.md#the-five-enforcement-sites).

**If both parties sweep, expect a failed round, then retry.** Passing `--sweep-exchange-files` says you are sure no other session is using the directory. The protocol cannot check that for you: it has no way to tell a live partner's files from a crashed run's leftovers. The entry guard names the flag to whoever hits it, so both parties tend to reach for it at once. When they do, one sweep deletes files the other party has just written and neither run finishes: one waits out its peer timeout for a partner that is gone, the other reports files that were already deleted. In the default (non-retain) mode each of those runs points at this as a likely cause alongside its own error. Those failed runs do leave the directory clear, so the recovery is to run the exchange again from both sides with no sweep flag. If a sweep instead reported that it could not delete every file, resolve that error first -- the directory may be only partly cleared. What a sweep of a live partner leaves behind is described in [FILE_SYNC.md](spec/FILE_SYNC.md#invariants).

- **To skip the failed round**, one party sweeps and stays in the exchange while the other starts afterwards with no sweep flag. Nothing printed marks the moment that second start is safe -- the `sweeping ...` line goes out before the deletions do, and a directory with nothing to delete draws no line at all -- so the two operators have to agree the order between themselves and check the directory's contents (the named leftovers gone, a single hello present) rather than a log line.

**One kind of leftover needs no flag.** A run that fails after the partner handshake leaves an abort marker (`<id>-abort.json`) so the waiting partner learns of the failure instead of sitting out its inactivity timeout. In the default (non-retain) mode the next run in the same directory clears it at start-up, whichever party's failure left it, so a plain retry is never blocked by one; in retain mode nothing is cleared automatically and a leftover marker is refused along with the transcript until you pass both flags above. One thing to time: if the partner may still be running the failed exchange, let it poll once before you retry. A retry clears the marker, and a partner that had not yet read it then sits out its full inactivity timeout instead of failing fast. Who writes the marker, who may remove it, and why its reader is neither are in [FILE_SYNC.md](spec/FILE_SYNC.md#file-taxonomy).

**A failed rendezvous leaves no leftover at all.** A party whose rendezvous fails before it completes -- it waited out the peer timeout, or the directory turned out to be contaminated -- removes the hello it wrote and the acknowledgment it wrote for a partner hello it had seen, in retain mode as well as the default. So retry into the same directory rather than clearing it by hand. Two cases still leave files behind, both covered above: a bilateral-mode mismatch deliberately leaves both hellos in place so each party reads the other's setting, and a run killed outright never reaches its own cleanup. Why removing these files is right in retain mode is in [FILE_SYNC.md](spec/FILE_SYNC.md#phase-1----terminal-rendezvous-failure).

**A hello left by a killed run is the leftover to know about.** A run killed outright (SIGKILL, an out-of-memory kill, power loss) leaves its own `<id>-hello.json` behind, and because the party id is a fresh value per run unless you set [`peer_id`](#connectionoptions), the next run reads that file as a *partner's* hello rather than its own. Nothing can tell the two apart from the directory alone, so that run cannot succeed. What you do about it:

- **Default (lock) rendezvous.** The run fails in the key exchange, with an error naming the leftover as the likely cause rather than blaming your partner. It consumed the file on the way through, so the directory is already clear and a straight re-run is the recovery.
- **`lockless_rendezvous` (and therefore `retain_files`).** The run fails well inside the peer timeout, naming the file and asking you to re-run. Do that first: a partner whose transport is simply slow completes the re-run, while genuine residue fails it identically every time. Only once the re-run confirms it should you delete the named file, or pass `--sweep-exchange-files`, whose assertion is the one you are making by hand. The run itself never deletes it -- a hello it cannot prove is its own is not its to remove. On a `peer_timeout_ms` too small to hold that window -- under about 30 seconds, or a handful of poll intervals -- none of the above applies: the window never arms, and the run instead reports the ordinary peer timeout with no leftover named. [FILE_SYNC.md](spec/FILE_SYNC.md#phase-1----entry-present-peer-hello) has the exact floor.

Setting [`peer_id`](#connectionoptions) avoids all of this, which is why it is recommended for unattended and scheduled runs: the leftover then carries your own id and is refused at start-up on the filename alone. Do not reach for `--sweep-exchange-files` on a schedule instead -- it asserts no concurrent session is using the directory, which an unattended run is in no position to assert on every invocation. How the entrant distinguishes the two cases, and the bounded window it waits, are in [FILE_SYNC.md](spec/FILE_SYNC.md#phase-1----entry-present-peer-hello).

#### Filename grammar

Every protocol file on `sftp` and `filedrop` channels is named `<id>-...-<token>.json`, where `<token>` is the final `-`-delimited segment before `.json`:

- If `<token>` is all digits, the file is a **message** and `<token>` is its declared byte count. Parsing is right-anchored so a party id containing hyphens does not affect extraction.
- Otherwise `<token>` is a **type word** naming the file kind: `hello` (rendezvous hello), `ack` (see [Acknowledgment markers](#acknowledgment-markers)), `joining` (the lock-path joiner-arrival sentinel `<id>-joining.json`, briefly present while the joiner deletes the peer hello and renames the sentinel to its own hello), `lock` (the rendezvous tiebreaker `<peer1>-<peer2>-lock.json`, created in lock mode -- the default `lockless_rendezvous: false` -- when both hellos coexist and one party wins the atomic exclusive-create race; both sides encode the two ids in hello-filename order so they reconstruct the same name), or `abort` (the marker `<id>-abort.json` a failing party leaves for its partner, described under [Directory exclusivity](#directory-exclusivity) above). A typed file is never read as a message; the receiver's message scan ignores any file whose terminal segment is non-numeric, so a message ack's mid-name `<NNN>`/`<byteCount>` digits do not route it as a message.

The receiver only reads files whose on-disk size matches the declared byte count, so a partially synced message file is never consumed prematurely.

### `connection.provider_options`

*Type:* object  
*Required:* no  
*Applies to:* `sftp` (accepted on `webrtc` but inert: no WebRTC transport reads it, held by `npm run check:webrtc-provider-options-unread`; see [WEBRTC_TRANSPORT.md](spec/WEBRTC_TRANSPORT.md#ice))

An opaque key-value map of additional, non-security transport-tuning options for the underlying transport library. Keys and values are defined by the package providing the connection implementation. `@`-file pathing is supported here as well.

Unlike every other map in this spec, the keys here are **not** case-normalized: they are passed exactly as written, so author them in the casing the underlying transport library expects rather than snake_case. For the SFTP channel they are forwarded to `ssh2-sftp-client`, whose options are camelCase.

For the SFTP channel this map is **not** a verbatim passthrough: it is filtered through a default-deny allowlist before reaching `ssh2-sftp-client`. The connection target, credentials, and host-key-verification settings are derived solely from the structured [`connection.server`](#connectionserver) fields and **cannot** be set or overridden here -- so `host`, `port`, `username`, `password`, `private_key`/`privateKey`, `passphrase`, `host_verifier`/`hostVerifier`, `host_hash`/`hostHash`, and the connection-redirecting `sock`/`authHandler` options are all rejected if placed in `provider_options`. Only these benign tuning options are honored:

- `keepaliveInterval`, `keepaliveCountMax` -- SSH-level keepalive cadence.
- `strictVendor` -- ssh2's server-vendor strictness toggle.
- `algorithms` -- accepted, but filtered to its `cipher`, `hmac`, `kex`, and `compress` sub-categories; the `serverHostKey` sub-category is dropped, as host-key-type negotiation is a host-key-trust decision and not operator-overridable here.

Any other key (including `readyTimeout`, which is set from [`connection.options.server_connect_timeout_ms`](#connectionoptions) instead) is ignored, with a warning naming the dropped key. This keeps the opaque escape hatch useful for transport tuning while ensuring it can never weaken where psilink connects, what credentials it presents, or whether the server's host key is trusted.

#### Key-exchange algorithms and the host's crypto provider

The SSH key-exchange algorithms psilink offers are always narrowed to exclude those built on a primitive it probes for and the running process cannot perform -- today that means X25519, the one primitive in ssh2's offer whose absence is a failure mode in practice. On a host whose OpenSSL provider omits X25519 -- a FIPS-configured provider is the case that arises in practice -- every key exchange built on it is withheld from the offer, so the negotiation settles on an algorithm both ends can complete instead of on one that fails mid-handshake. This needs no configuration and no flag: psilink asks the crypto provider rather than looking for a "FIPS mode". On a host that can perform everything, the offer is unchanged.

The narrowing applies to `algorithms.kex` set here as well -- offering an algorithm the process cannot perform is never useful. Three consequences to be aware of when you set it:

- If some of the algorithms you list survive, the rest are dropped with a warning naming how many and why.
- If **none** survives, the connection is refused with an error rather than falling back to the defaults. List at least one algorithm outside the unavailable set, or remove the setting and let psilink offer everything else.
- An **empty** list is not an empty offer: SSH reads it as "algorithms unspecified", so psilink warns that the setting selects nothing and offers the defaults minus the unavailable algorithms, exactly as if you had left it out.

When a server accepts only algorithms this host cannot perform -- a server restricted to `curve25519-sha256`, reached from a host without X25519 -- no configuration can bridge it. The connection fails with an error naming the missing primitive, so the remedy (a key exchange enabled server-side, or a different host) is clear rather than reading as a server misconfiguration. It fails at the first attempt: nothing about the outcome can change between attempts, so [`max_reconnect_attempts`](#connectionoptions) is not spent re-dialing it. Under [`connection_per_poll`](#sftp-only-options) the same holds for the session each poll cycle opens: the exchange ends at that cycle with the same error, rather than skipping cycles until [`peer_timeout_ms`](#connectionoptions) ends the run reporting partner silence.

---

## Authentication

*Type:* object  
*Required:* no (see note below)  
*Applies to:* all channels (`webrtc`, `sftp`, `filedrop`)

Optional top-level block, a sibling of [`signing`](#signing). It holds the partner shared-secret trust mechanism and is channel-agnostic -- the same shape applies to every channel. It mixes two kinds of field:

- **Runtime-injected secret state** (`shared_secret`, `expires`): loaded from the key file (`.psilink.key`) and added to the in-memory representation before the exchange runs. These never appear in `psilink.yaml` and must not be edited manually. If `shared_secret`, `sharedSecret`, or `expires` are present in the configuration file, the CLI emits a warning and ignores them; values from the key file always take precedence.
- **Operator-policy fields**: settable in `psilink.yaml`. `token_max_age_days` is the first (see the field table below). The loader leaves these for schema validation; the schema honors a recognized policy field and rejects an unrecognized key (see the unknown-key note below).

`shared_secret` is required for recurring exchanges run via the `exchange` command. If the key file (`.psilink.key`) is absent, the CLI aborts before any connection is attempted. Zero-setup exchanges (the default, subcommand-less invocation) rely on transport-layer authentication instead and do not use a key file.

**Provisioning the key file from an invitation.** When you compose an exchange in the web application, you download a configuration file that -- like every `psilink.yaml` -- never carries the secret. Pass `--invitation CODE` to `psilink exchange` to complete your local provisioning from the invitation code (the same code `psilink accept` takes) in the same command that runs the exchange: the CLI decodes and validates the code (checksum, schema, and expiry), writes your key file with the invitation's shared secret and expiry, and then runs the exchange normally. Keep the code out of shell history with the `@`-file form, `--invitation @code.txt`. A malformed or expired code fails before anything is written. `--invitation` is refused if a key file already exists at the key path: the secret rotates after your first exchange, so the original code can no longer establish a valid key -- run without `--invitation` to use the existing one, or re-invite to establish a new secret. The secret rides only the invitation code and never the downloaded file; the fail-closed provisioning ordering and the channel-binding rule an accepting tool honors are specified in [EXCHANGE_FILE.md](spec/EXCHANGE_FILE.md).

Taken together, the `authentication` block is never required in a configuration file -- its only fields today are key-file-injected. It is required for the in-memory objects used for recurring exchanges, and it is optional for zero-setup exchanges.

The shared secret is automatically rotated after each successful authentication handshake: both parties independently derive the replacement from the key-exchange session key using HKDF, so no extra round-trip is required. The CLI persists the new secret automatically; library consumers of `authenticateConnection` are responsible for persisting `rotatedSecret` from the returned `AuthResult` to their own storage. If the exchange fails before a successful handshake, the existing secret remains valid. If the handshake succeeds but the data exchange subsequently fails, both parties already hold the rotated secret and can retry without re-inviting. If the handshake succeeds but the new secret cannot be persisted (e.g., a disk-write error), both parties may be out of sync: the partner may already hold the rotated secret, making the old secret invalid. In that case both parties must re-invite. Invitation tokens carry a default expiration of 1 hour; what a rotation-generated secret carries is governed by [`token_max_age_days`](#authenticationtoken_max_age_days).

| Field | Type | In `psilink.yaml` | Description |
|-------|------|-------------------|-------------|
| `shared_secret` | string | never; loaded from `.psilink.key` | Shared secret; a base64url-encoded 32-byte value (43 characters). Do not set manually. |
| `expires` | string (ISO 8601) | never; loaded from `.psilink.key` | Expiration of `shared_secret` -- either an invitation's bounded lifetime or a `token_max_age_days` stamp; the two are not distinguished and are enforced identically. Absent for a persistent token with no max-age policy. Do not set manually. |
| `token_max_age_days` | integer (positive) | yes (operator policy) | Maximum age, in days, to stamp onto a rotated token. See [`authentication.token_max_age_days`](#authenticationtoken_max_age_days). |

The loader strips only the injected fields (`shared_secret`/`expires`) from this block, warning when they are set; the value from the key file always wins. Any other key is left for schema validation, and -- unlike the sibling spec blocks, which strip unrecognized keys -- the `authentication` schema is **strict**, as the document's top level is: an unrecognized key (for example a misspelled `token_max_age_dayss`) is rejected at config-parse time with a user-facing error, and no exchange runs until it is corrected. This block is validated strictly, rather than stripping like the blocks beside it, because it holds an operator security *policy*: `token_max_age_days` is a max-age enforcement control, and a typo that `strip` would silently discard would disable the control with no signal to the operator. Failing closed forces the typo to be fixed before any exchange runs. (The injected secret value is protected separately by the warn-and-strip above; the strictness here is about surfacing a typo in a policy key, not about trust in the secret. Partner-controlled inputs, such as the invitation locator, are validated strictly for a different reason -- there an extra key could smuggle a value past the allowlist.)

WebRTC peer addressing (the `inviter`/`acceptor` distinction) is configured separately, via [`connection.role`](#connectionrole); it is a transport concern, not a partner-trust one, and so is not part of this block.

Why `authentication` and `signing` are two separate blocks (rather than one trust block) is explained in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#recurring-exchange-authentication).

### `authentication.token_max_age_days`

*Type:* integer (positive, at most 36500 -- about 100 years)  
*Required:* no

An operator-policy field, not key-file-injected. Rotation tokens written after each successful exchange carry no expiration by default, on the assumption that active partnerships exchange frequently. A dormant partnership (a monthly cadence, a holiday gap) could otherwise hold a valid token indefinitely. When `token_max_age_days` is set, a successful exchange stamps `expires` = (the moment of rotation) + `token_max_age_days` days into the rotated `.psilink.key`, bounding a token's age independently of exchange frequency.

The stamp is enforced at the next `psilink exchange`, which reads the token's `expires` at load time:

- If `expires` is in the past, the CLI aborts before opening any connection or attempting the key exchange, with an error naming the expired time and directing both parties to re-invite.
- If the token is within `token_max_age_days / 3` days of expiry, the CLI emits a warning before the exchange. The warning is suppressed when that exchange succeeds (rotation stamps a fresh, farther-out `expires`); it is shown only when no successful rotation refreshed the token, where it is actionable.

`expires` enforcement is independent of `token_max_age_days`: a token whose `expires` is already set -- whether by this policy or by an invitation's bounded lifetime -- is honored even if the field is later unset. Setting or changing `token_max_age_days` affects only tokens stamped by subsequent rotations. The invitation lifetime and the max-age policy are two sources writing the same `expires`; psilink does not record which produced a given value and enforces both identically (an expired token of either origin aborts the exchange and directs both parties to re-invite). The reasoning, and why no provenance marker is stored, are in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#token-age-and-rotation-policy).

```yaml
authentication:
  token_max_age_days: 30
```

---

## Signing

Optional. Configures signing of exchange receipts and the trust in the partner's signing identity. Absent in exchanges that do not sign receipts. The block carries only non-secret references: the signing **private key is never in the config** -- it lives in a separate owner-read-only identity file (see `signing.identity_file`). The only field that crosses the trust boundary, `signing.partner_fingerprint`, is a public value (a hash of a public certificate). The trust model and certificate format are specified in [PROTOCOL.md](spec/PROTOCOL.md#signing-identity-and-certificate-pinning) and [SECURITY_DESIGN.md](SECURITY_DESIGN.md#receipt-signing-identities).

### `signing.mode`

*Type:* string (`none` | `session-derived` | `certificate`)  
*Required:* yes, when a `signing` block is present

The receipt signing mode. `none` signs no receipt (only the unsigned self-attested record is produced). `session-derived` is a MAC under the shared key-exchange session key -- tamper-evident but not non-repudiation and not third-party verifiable; it is not yet implemented, and a configuration selecting it is refused as a configuration error before the exchange runs rather than left to complete unsigned. `certificate` signs with this party's long-lived signing identity and is the only mode that yields third-party-verifiable non-repudiation; it requires `signing.partner_fingerprint` and a named party ([`linkage_terms.identity`](#linkage_termsidentity)), and a configuration omitting either is refused before the exchange runs for the same reason. Under `certificate` mode an authenticated CLI exchange produces a dual-signed receipt: both parties sign the same terms and data-flow facts and swap signatures over the connection, each verifying the partner's pinned certificate before its signature (see [PROTOCOL.md](spec/PROTOCOL.md#the-signed-receipt-step)). A stored dual-signed receipt is verified again later with [`psilink verify-receipt`](CLI.md#verifying-the-signed-record).

### `signing.identity_file`

*Type:* string (path)  
*Required:* yes under `certificate` mode; not otherwise

Path to this party's signing identity file (the P-256 private key plus its self-signed certificate). There is no default: the identity is a long-lived credential reused across every exchange and partner, so where it lives is the operator's custody decision and psilink resolves no location of its own. Give it the home a credential gets -- a mounted directory of its own, separate from the read-write one the rotating key file needs, so this one can be read-only:

```yaml
signing:
  mode: certificate
  identity_file: /run/signing/psilink-signing-identity.json
```

This is a local path, not an [`@`-file reference](CLI.md#configuration). A leading `~` (or `~/`) is expanded to the home directory, so an operator who names one is honoured exactly -- what psilink does not do is choose the home directory itself.

The file is created owner-read-only by [`psilink fingerprint --identity-file`](CLI.md#where-the-signing-identity-lives), which is the one command that writes it; an exchange and [`psilink verify-receipt`](CLI.md#a-verified-verdict-needs-both-certificates-anchored) only read it, and write nothing beside it, so the directory can be mounted read-only for everything but that creating run. Regenerate the identity deliberately with `psilink fingerprint --force`, which invalidates any fingerprint a partner has pinned.

Certificate mode with no `identity_file` is refused as a configuration error before the exchange runs (exit 64), naming both spellings of the path and `mode: none` as the way to run unsigned meanwhile. Like the partner-fingerprint requirement below, it is a cross-field rule rather than part of the `signing` block's schema, so a partially-authored config still parses. `psilink verify-receipt` refuses nothing: with no path configured it leaves this party's own certificate slot unanchored and grades the verdict `INCOMPLETE` at exit 0.

### `signing.partner_fingerprint`

*Type:* string (43-character unpadded base64url SHA-256)  
*Required:* yes under `certificate` mode; not otherwise

The partner's pinned certificate fingerprint, obtained from the partner via `psilink fingerprint` and a trusted out-of-band channel. A presented partner certificate is trusted only if its self-signature verifies and its fingerprint matches this value; a mismatched value rejects the partner's certificate (and therefore any receipt it carries) with a clear error. The fingerprint is not secret, but the channel that carries it must be authentic. It stays valid until the partner deliberately regenerates its identity.

Certificate mode with no pin is refused as a configuration error before the exchange runs (exit 64), because such a run cannot finish: the two parties swap signatures after their data has already crossed, and a partner certificate presented with nothing to check it against is rejected there -- leaving the exchange terminated with no result and no receipt on this side, and only the exchange record of the disclosure it had already made. Run `mode: none` until the partner's fingerprint is in hand. The requirement is not part of the `signing` block's schema, so a partially-authored config -- no partner fingerprint yet -- still parses wherever the schema is used; `psilink fingerprint` needs only `identity_file`, which it reads from the raw config text rather than through the schema.

```yaml
signing:
  mode: certificate
  identity_file: /run/signing/psilink-signing-identity.json
  partner_fingerprint: iWD-ZB69Oz6gOpaX_OoC7sD8ohIZj2lETC9qbl-IbPg
  receipt_output: ./receipts/agency-a-receipt.json
```

### `signing.receipt_output`

*Type:* string (path)  
*Required:* no

Where the dual-signed receipt is written under `certificate` mode. Optional; when omitted the CLI writes it to a timestamped `psilink-receipt-<stamp>.json` in the working directory (the stamp matching the exchange record's), so repeated exchanges accumulate an audit trail. The file is written owner-only. It holds no payload contents and no private keys -- only public certificates, signatures, and the terms and data-flow attestation -- so it does not reveal the matched data or leak whether either direction carried a payload. It does bind both parties' identities and the agreed terms (that is its purpose, a mutually non-repudiable attestation), so it is not anonymous; share it by copying the file when handing it to a partner or auditor. What a holder does and does not learn is enumerated in [EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md#receipt-privacy-properties).

Under `certificate` mode a receipt is accepted only if the identity the partner used in its agreed terms is the one the presenting certificate authorizes -- an exact match of the full identity over the same canonical bytes the record commits to and the receipt signs, checked against the agreed-terms identity rather than the certificate's own carried value. A party that uses a different identity string than the one bound into its certificate needs a new certificate (a deliberate regeneration); see [PROTOCOL.md](spec/PROTOCOL.md#signing-identity-and-certificate-pinning).

---

## Retention and disposition

Optional. A self-facing operator note for the [self-attested exchange record](spec/EXCHANGE_RECORD.md): where this party files its copy of the result and under what retention schedule it is held or disposed of. It is purely local -- written into **this** party's record only, never swapped with the partner, cross-checked, or folded into the agreed-terms hash (unlike [linkage terms](#linkage-terms)) -- so the two parties' notes are independent and need not match. Metadata only: it must carry no protected, linkage-field, or payload value.

### `retention_disposition`

*Type:* string  
*Required:* no  
*Consistency:* none (per-party; not exchanged)

A free-text pointer recorded verbatim in the exchange record, so an auditor can see from the record alone where the result (the association table and any received payload) went and under what retention schedule -- without hunting that information down separately. When present it must be non-empty; omit the field entirely to record no pointer (its absence is explicit, not an empty string). Because the record is unsigned and local, retention and access control of the record itself remain the holder's responsibility.

```yaml
retention_disposition: "Filed in Agency A association DB (links.prod); retained 6 years per records schedule RM-7, then purged."
```

---

## Input metadata

Optional field-level descriptions of the input dataset. If omitted, semantic types are inferred from column names. If no identifier columns are specified, output row indices reference positions in the input file.

When metadata is inferred (no explicit `metadata` block), an empty (zero-length) column name in the input is rejected at intake with a clear error, the same way an explicit `metadata` `name` is rejected at config parse (see the `name` field below). A trailing comma, a blank cell, or a leading delimiter in a CSV header row produces such an unnamed column; because an empty name cannot be used for linkage, identification, or payload, the file is refused up front rather than silently dropping the column's audit record during the exchange. Name the column or remove the empty header field. The web app surfaces the same rejection at its file-intake surfaces (the quick and Advanced invite paths and the acceptor's file step).

The length ceiling on a column name is enforced on the inferred path too, but only where the name is actually carried: a column the metadata transmits (`is_payload: true` with a role other than `ignored`) whose name is longer than the ceiling is refused during data preparation, before any credential, terms, or data are sent. A party whose partner is entitled to no result (`output.share_with_partner: false`) transmits no column at all, so the bound does not apply to it. A payload column's name travels with its values -- the partner refuses a longer one when it parses the payload, and the exchange record cannot record it -- so the exchange could not complete. Shorten the header, or set the column not to transmit. A column used only for matching or ignored carries its name nowhere, so an over-long header on one of those is no obstacle and the file is not refused over it. The record identifier is not exempt: an inferred identifier column keeps `is_payload: true` and is transmitted (see the identifier rows below), so its name is bounded like any other payload column unless the column is set not to transmit. The web app applies the same bound where the columns are marked to send, so an oversized name is refused before anything is transmitted rather than after. `psilink invite` applies it where it reads a disclosed set from an input file's header, naming the offending column positions and the ceiling as a usage error (exit 64) before the invitation is printed or a configuration or key file is written, so an invitation never publishes a column the exchange it commits to could not carry.

`metadata` is a list of column entries directly, not an object wrapping one:

```yaml
metadata:
  - name: "LAST_NAME"
    type: last_name
    role: linkage
    is_payload: false
    description: "Legal last name as recorded at enrollment"
  - name: "DOB"
    type: date_of_birth
    role: linkage
    is_payload: false
  - name: "CLIENT_ID"
    type: identifier
    role: identifier
    is_payload: false
    description: "Internal client identifier"
  - name: "PROGRAM_START_DATE"
    type: other
    role: payload
    is_payload: true
    description: "Date client enrolled in the program"
  - name: "COUNTY"
    type: other
    role: ignored
    is_payload: false
    description: "Present in the input but excluded from this exchange"
```

### Column fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Column name in the input CSV; must be non-empty, at most 256 characters, and unique within the metadata block (matched case-sensitively). A violation is rejected at config parse |
| `type` | string | yes | Semantic type (see [Semantic Types](#semantic-types) above) |
| `role` | enum | yes | `linkage`, `identifier`, `payload`, or `ignored` |
| `is_payload` | boolean | yes | Whether this column is transmitted as payload data after the intersection is identified |
| `description` | string | no | Human-readable description; shared with partner for payload columns |

**Authoring a `metadata` block is all-or-nothing per column.** `type`, `role`, and `is_payload` are each required on every column the block lists; there is no per-field fallback, and a column missing any of them is rejected at config parse. Inference is the alternative to authoring, not a filler for a partial block: it runs only when the whole `metadata` block is absent, over the input file's header row.

What inference assigns, when it runs:

| Column | `type` | `role` | `is_payload` |
|--------|--------|--------|--------------|
| A recognized linkage name (`ssn`, `dob`, `first_name`, `phone`, `email`, `zip`, and their aliases) | the matching semantic type | `linkage` | `false` |
| `id` or `identifier` | `identifier` | `identifier` | `true` |
| A name ending in `_id` | `identifier` | `identifier` when it is the header's only `identifier`-typed column, otherwise `payload` | `true` |
| Anything else | `other` | `payload` | `true` |

The complete list of column names that infer each type, with the role and payload default each assigns, is in [DEFAULT_STANDARDIZATION.md](spec/DEFAULT_STANDARDIZATION.md#type-inference-from-column-names).

Both identifier rows produce `type: identifier`, and that type is what decides the `role`: a header carrying exactly one `identifier`-typed column roles it `identifier` whatever its name, so a lone `case_id` indexes the records. A header carrying several gives `role: identifier` to a column named `id` or `identifier` when one is present, and to no column at all otherwise -- two `_id` columns and nothing else leaves both roled `payload`, so none of this party's columns indexes its own records in the result.

The two identifier rows are the ones to check before an exchange: an inferred identifier column is transmitted, so a party that does not intend to disclose its own record keys authors a `metadata` block and sets `is_payload: false` on them. Inference never assigns `ignored` -- that role is opt-in only.

`role` and `is_payload` are partially independent. A column used for linkage or as an identifier can also carry `is_payload: true`, meaning it participates in the PSI protocol *and* is transmitted as payload for matched members. For example, a phone-number column can have `role: linkage` and `is_payload: true` so that it both links records and is delivered to the partner for matched rows. A column that is neither used for linkage nor an identifier is there to be sent, so give it `role: payload` and `is_payload: true` -- which is also what inference assigns to an unrecognized column.

`role: ignored` is the explicit opposite of that default: a column present in the input but used for nothing. An ignored column is never used for linkage, never treated as an identifier, and never transmitted as payload -- the role wins over `is_payload`, so an ignored column is not sent even if it carries `is_payload: true`. Use it to keep a column in the input file (so the file need not be edited) while declaring that this exchange must not touch it. Inference never assigns `ignored`; it must be set explicitly.

Matching participation requires `role: linkage`. A column's standardized value is hashed into a linkage key only when it is roled `linkage` and its semantic `type` matches a linkage field -- or an explicit [data standardizing transformation](#data-standardizing-transformations) whose `input` is a `role: linkage` column names the field. A column roled `identifier`, `payload`, or `ignored` never participates in matching, even when its `type` matches a linkage field and even when an explicit transformation names it: `role` is the single, explicit statement of whether a column is used for matching, and it wins. This keeps matching distinct from transmission (`is_payload`, above) -- a column that should both match and be sent to the partner is `role: linkage` with `is_payload: true`, the one combination that does both. A field left with no `role: linkage` column of its type is reported as unsatisfiable before the exchange runs, never silently dropped.

---

## Data standardizing transformations

Optional per-column transformations applied before linkage key generation. Conceptually, each transformation reads one input column, applies a sequence of steps, and writes the result under a linkage field name. In implementation, a transformation is a map between an input index and a set of output strings, which lazily computes values and caches results. The `output` name of a data standardizing transformation must match the `name` of a field in `linkage_terms.linkage_fields`.

```yaml
standardization:
  - output: last_name      # matches linkage_terms.linkage_fields[].name
    input: LAST_NAME
    steps:
      - function: remove_affixes
      - function: remove_punctuation
      - function: to_upper_case

  - output: date_of_birth
    input: DOB
    steps:
      - function: parse_date
        params:
          input_format: "MM/DD/YYYY"
          output_format: "YYYYMMDD"

  - output: ssn
    input: SSN_RAW
    steps:
      - function: remove_dashes
      - function: null_if
        params:
          values: ["000000000", "123456789", "111111111"]

  - output: last_name_variants   # fan-out: one row -> multiple PSI entries (single-pass only, see Fan-out below)
    input: LAST_NAME
    steps:
      - function: to_upper_case
      - function: split_on
        params:
          delimiter: "[-\\s]"
          include_original: true  # keep "SMITH-JONES" as well as "SMITH", "JONES"
```

Each linkage field may have at most one data standardization transformation. Fields not covered by an explicit transformation are given an identity transformation and connected to a linkage field by matching the field's semantic type against the input column's metadata.

A configuration that authors no `standardization` at all is cleaned by the per-type defaults instead. Their exact step sequences, parameters, and results -- a cross-party contract, since both parties must derive identical keys -- are specified in [DEFAULT_STANDARDIZATION.md](spec/DEFAULT_STANDARDIZATION.md).

When an exchange configuration authors its own `standardization`, that standardization is treated as authoritative: if it contradicts the linkage terms -- a transformation `output` naming no declared linkage field, or a `steps` entry naming an unknown `function` -- it fails closed (the CLI exits 64) with a message naming the offending output or function, rather than warning and proceeding past the contradiction. A direct `exchange`, and any run that mints no invitation, is refused during data preparation, before any credential, terms, or data are sent. On `exchange` that preparation precedes every connection the run makes, the first-use host-key probe of an unpinned SFTP configuration included; on a zero-setup run that probe is the one connection preceding the refusal, and it presents no credential (see [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#sftp-host-key-verification)). A config-source `psilink invite` is refused at mint time, before the token is disclosed, so an inconsistent configuration never yields an invitation the same config's later `exchange` would reject. A configuration that authors no `standardization` reconstructs the default per-type cleaning from its metadata and terms, so it is unaffected by this check.

A `split_on` step fails closed at the same points under any `linkage_strategy` but `single-pass`, whether it sits in a `standardization` or in a linkage key's element transform: matching on the several values it produces runs under single-pass alone, so the exchange is refused rather than run with the narrower matching the other strategy would deliver (see [Fan-out (multi-value fields)](#fan-out-multi-value-fields)). The web app authors no `split_on` at all: its cleaning-step menu does not offer the function, and a terms document that declares one -- in a cleaning step or a linkage key's element transform -- blocks generation and is refused at the mint, whatever strategy it names. A fan-out is therefore authored in a configuration file, as the example above does, and run with `psilink exchange` or minted with `psilink invite`.

### Transformation fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `output` | string | yes | Name of a linkage field from `linkage_terms.linkage_fields` |
| `input` | string | yes | Column name in the raw input CSV |
| `steps` | array | no | Steps applied in order; if omitted the raw value is used unchanged |

### Step fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `function` | string | yes | Name of the function to apply (see Available functions below) |
| `params` | object | no | Function-specific parameters |

### Unicode normalization

Before the first step of any transformation runs, the input value is normalized to Unicode NFC (Normalization Form C). This is unconditional and applies to every field, including those given an identity (no-`steps`) transformation. Because the cleaned string becomes the PSI set element verbatim, two parties holding the same logical value in different normalization forms -- for example an accented name stored precomposed (NFC) on one side and decomposed (NFD) on the other, the common split between macOS filesystems and most databases -- would otherwise produce different bytes and silently fail to match. Author pipelines assuming their input is already NFC; `to_upper_case`, `to_lower_case`, and `remove_accents` therefore operate on a normalized input (though `to_upper_case` can itself re-emit non-NFC for a few code points, which the steps that match against an intermediate value compensate for; see the note below). NFC, not NFKC, is used: canonical equivalents are merged while visually-distinct compatibility characters (ligatures, full-width forms) are preserved.

The same guarantee extends to the strings you supply in step `params` and to linkage key element transforms. Literal values a step injects into or compares against the data -- `null_if` values, a `coalesce` default, a `replace_regex` replacement, and a `pad_left` character -- are normalized to NFC, and the fully assembled key string is normalized once more after its elements are concatenated. Regex *patterns* (`replace_regex`, `extract_regex`, `filter_regex`, `split_on`) are applied exactly as written and are not normalized, because normalizing a pattern could change what it matches; author any non-ASCII in a pattern in NFC so it matches the NFC data.

The `to_upper_case` step can emit a non-NFC sequence for six code points even from NFC input -- for example its result on the Greek `U+0390` is the decomposed `U+0399 U+0308 U+0301`. (`to_lower_case` does not exhibit this, but a future case-folding step could.) The steps that match your authored value, pattern, or delimiter against an intermediate value (`null_if`, `filter_regex`, `extract_regex`, `replace_regex`, `split_on`, and `parse_date`) therefore normalize the value they inspect to NFC before matching, so an exclusion, filter, extraction, replacement, split, or date parse authored in NFC behaves correctly even when it follows a case-fold. `null_if` and `filter_regex` pass the original value downstream unchanged; the steps that derive a new value do so from the normalized form.

### Null propagation

A step may produce `null` to signal that the record has no valid value for this field. Once a step produces `null`, all subsequent steps are skipped and the field is absent from the record's PSI entry for any linkage key that references it. This is the intended mechanism for enforcing `exclude` constraints declared in a linkage field: a `null_if` step actively removes excluded values rather than merely warning.

`coalesce` is the only function that acts on `null`: it substitutes a literal default, allowing a pipeline to recover from an earlier null-producing step.

### Fan-out (multi-value fields)

The `split_on` function produces `set<string>` instead of a single `string`. When a transformation ends with a set, the field carries multiple candidate values. Each value generates a separate PSI entry for the row, but all entries retain the original row identifier so that a match resolves back to the source row.

**Cross-product**: when a linkage key references multiple fan-out fields, the key strings are the cartesian product of those fields' value lists. A `split_on` on both `first_name` and `last_name` with two parts each produces four key strings per row. The total count can grow quickly, so it is capped at the width the agreed terms declare for that key -- 20 candidate values for each of the key's elements that splits, multiplied together. A row producing more than that width contributes none of them to that key's round: it sits that key out exactly as a row with no value does, remains eligible for later keys, and the drop is warned. Terms can put every row over the cap, so the warnings are bounded: a key's round names the first few dropped rows one line each and closes with a single line carrying that key's totals, rather than one line per dropped row. The cap is what keeps the exchange's frame and memory limits derivable from the record counts the two parties exchange; it is specified, with that arithmetic, in [PROTOCOL.md](spec/PROTOCOL.md#fan-out-matching-multi-value-key-candidates).

**`single-pass` only**: fan-out runs under [`linkage_strategy: single-pass`](#linkage_termslinkage_strategy). Terms that declare a `split_on` under the default `cascade` are refused -- when authored or minted into an invitation, at data preparation, and again once both parties' terms are agreed -- rather than run with matching on one candidate. Choosing fan-out therefore also means choosing single-pass, whose larger disclosure (the receiver sees the sender's full per-key value structure) and tighter dataset ceiling are described under that term. A key whose element splits also costs 20 toward that ceiling in place of 1, so a template with one such key carries proportionally fewer records; a fan-out you author in your own `standardization` instead multiplies the record count you declare, which costs the same and is what keeps it off the wire; the arithmetic is in [PROTOCOL.md](spec/PROTOCOL.md#the-width-bound-a-per-key-candidate-cap-the-terms-declare).

**What the accepting party is told**: an invitation whose linkage keys split a value marks each such key element as matching on several values, and states the consequences the acceptor consents to -- matching per candidate, the record leaving the later keys once any candidate matches, and the candidate grouping the single-pass receiver is handed. Under any other strategy that same invitation states the refusal instead. A fan-out authored in your own `standardization` is not on that surface at all: a standardization is per-party and local, and no invitation carries one.

**Match resolution for fan-out**: when several PSI entries derived from the same row match in one linkage key's round, the parties do NOT communicate to resolve it. Both derive the same record-level pairing locally from what the exchange already carries: each round's matches are lifted to record pairs, a deterministic rule accepts at most one pair per record, and every record whose candidates matched at all leaves the candidate set for later keys -- so an individual matches once or not at all, and one whose evidence was contradictory ends unmatched rather than matching on a less precise key. The rule, its ordering, and the disclosure fan-out adds are specified in [PROTOCOL.md](spec/PROTOCOL.md#fan-out-matching-multi-value-key-candidates).

**Distinction from `generate_fuzzy_comparisons`**: fan-out at the standardization stage and `generate_fuzzy_comparisons` on a key element both generate multiple PSI entries per row, but they serve different purposes. Standardization fan-out reflects that a field legitimately has multiple canonical values (e.g. a hyphenated name and its parts). `generate_fuzzy_comparisons` generates approximate variants of a single canonical value to tolerate data entry errors (e.g. digit transpositions in an SSN). Only one match is expected from a `generate_fuzzy_comparisons` expansion; multiple matches from the same row in a standardization fan-out may all be meaningful.

### Available functions

Parameter names below are written in snake_case in YAML (e.g. `input_format`, `include_original`), following the same convention as the rest of the spec; they are normalized for the function library internally. Unlike `connection.provider_options`, a `params` block is not opaque and its keys are not passed verbatim.

**Regex patterns run under a linear-time engine.** The four regex functions (`replace_regex`, `extract_regex`, `filter_regex`, and `split_on`) take a `pattern` (a `delimiter` for `split_on`) that is compiled and run per row over the full dataset. Because a partner authors these patterns and they execute on your data, they run under a linear-time regular-expression engine (RE2 semantics) rather than the JavaScript engine, so no pattern can hang the application through catastrophic backtracking -- this is guaranteed by construction, not screened for. The cost is a restricted **dialect**: a pattern may use the common syntax (character classes, anchors, quantifiers, groups, alternation, and Unicode classes) but not the features that require backtracking -- backreferences and lookarounds -- and a few escapes and class semantics differ from JavaScript. A pattern outside the dialect is rejected at terms validation, before any row is processed. A pattern with nested quantifiers (e.g. `(a+)+`) is accepted and runs in linear time like any other, because no pattern the dialect admits can hang the application; `parse_date` runs on the same engine, so an `input_format` with many adjacent variable-width tokens is likewise bounded by construction. The permitted syntax, the JavaScript divergences, and the exact operation semantics are specified normatively in [PROTOCOL.md](spec/PROTOCOL.md#transform-regular-expression-dialect).

#### String transformation

| Function | Description | Parameters |
|----------|-------------|------------|
| `remove_non_ascii` | Remove all characters outside of the ASCII set, including emojii and symbols | - |
| `remove_punctuation` | Remove ASCII punctuation and symbols | - |
| `remove_dashes` | Remove hyphens | - |
| `replace_separators_with_spaces` | Replace hyphens, apostrophes, ampersands, slashes, and underscores with spaces | - |
| `squash_spaces` | Replace instances of multiple space characters together with a single space | - |
| `trim_whitespace` | Remove leading and trailing whitespace | - |
| `to_upper_case` | Convert to uppercase | - |
| `to_lower_case` | Convert to lowercase | - |
| `remove_accents` | Remove accents and other diacritics, ASCII-ifying the text; re-normalizes to NFC after the diacritic strip | - |
| `remove_affixes` | Remove name titles (Mr., Dr., ...) (and suffixes (Jr., III, ...) | - |
| `substring` | Extract a substring | `start` (integer, 1-indexed, required; negative counts from end), `length` (positive integer, required) |
| `parse_date` | Reformat a date string | `input_format` (default `MM/DD/YYYY`), `output_format` (default `YYYYMMDD`), each at most 256 characters; an empty `output_format` is refused, since it would render every date to the empty string; tokens: `YYYY`, `YY`, `MM`, `DD` |
| `pad_left` | Left-pad the value with a fill character up to a target length; pass-through if already at or above the length | `length` (positive integer, required; capped at 256 in a linkage key element's `transform`, uncapped in a `standardization` step), `char` (single character, default `"0"`) |
| `phonetic` | Apply a phonetic encoding | `algorithm`: `soundex` (default); result is a 4-character string, or `null` for a value carrying no letters |
| `replace_regex` | Replace all regex matches | `pattern` (required), `replacement` (default `""`) |
| `extract_regex` | Keep the first capture group, or the whole match if the pattern has none; produce `null` if there is no match or the result is empty | `pattern` (required) |

The year may be written with the four-digit `YYYY` token or the two-digit `YY` token; in an `input_format` either supplies the year component. A `YY` value is resolved to a four-digit year against a fixed cutoff shared by both parties, so they always resolve it to the same year and derive the same key without anything to agree on. The cutoff is a fixed constant rather than "the most recent past year", so a two-digit year can resolve to a year not yet reached; this does not affect linkage because both parties resolve it identically. In an `output_format` a `YY` is emitted literally (only `YYYY`/`MM`/`DD` are substituted), so it collapses the year to a constant. The exact cutoff and its window are specified in [PROTOCOL.md](spec/PROTOCOL.md#transform-regular-expression-dialect).

A `parse_date` step whose `input_format` cannot supply a complete date -- for example `MM/DD`, which carries no year -- drops every record rather than reformatting it, so a linkage key whose element transform relies on it can never match. This holds for any data, so it is settled before the exchange runs rather than surfacing only as an empty result afterward: an exchange is refused unless every agreed linkage key is satisfiable and live, so one key dead this way stops the run whatever the other keys can still do. The remedy is out of band -- agree terms over the keys and fields both files can supply, and run under those. The CLI reports the refusal before any connection or credential, and the web acceptor's confirm-columns step flags the key.

A `substring` step whose declared window reads nothing is dead the same way, and is refused the same way. A `start` or `length` left out, and a `start` of `0`, open no window at all; a `length` of `0` closes the window where it starts. Either way the step slices nothing and produces no value, so every record drops. A negative `length` -- outside the positive length the table calls for, but declarable in a document arriving from a partner -- joins them wherever its window can never open: when `start` and `length` sum to `1` or more (a `start` of `4` with a `length` of `-3`), and on a `start` of `-1`, which reads from the last character onward, with any negative `length`. A window that merely overshoots the values a particular file carries -- a `start` past the end of every short value, or a negative `length` reaching back past the start of a short one -- is not this: whether it reads anything is the data's answer, so it is left to the coverage warnings rather than refused.

The browser editor applies the same grading to both shapes when an invitation is CREATED, badging the key and holding Generate shut, so a key that matches nothing does not reach a partner as an invitation minted there.

#### Null-producing (filter) functions

| Function | Description | Parameters |
|----------|-------------|------------|
| `null_if` | Produce `null` if the value matches | `value` (single string) or `values` (array of strings) |
| `filter_regex` | Produce `null` if the value does not match the pattern | `pattern` (required) |

#### Recovery

| Function | Description | Parameters |
|----------|-------------|------------|
| `coalesce` | Replace `null` (or an empty list after filtering) with a literal default | `default` (string) |

#### Fan-out

> **`single-pass` only:** matching on the values `split_on` produces runs under [`linkage_strategy: single-pass`](#linkage_termslinkage_strategy); an exchange declaring one under any other strategy is refused before it runs. See [Fan-out (multi-value fields)](#fan-out-multi-value-fields).

| Function | Description | Parameters |
|----------|-------------|------------|
| `split_on` | Split the value on a regex delimiter, producing `Set<string>` | `delimiter` (regex pattern, required), `include_original` (boolean, default `false`) |

When `split_on` finds no delimiter it returns the value as a single-element set; when `include_original` is `true` the unsplit value is prepended to the parts. In both cases the value is the NFC-normalized form, consistent with the other derive-type steps (see [Unicode normalization](#unicode-normalization) above); this differs from the original bytes only when an upstream step such as `to_upper_case` left a non-NFC intermediate.

Steps following `split_on` are applied element-wise across all parts. Null-producing steps filter individual elements; if all elements are filtered the field becomes `null` and `coalesce` may recover it.

---

## Full example

An end-to-end annotated specification covering every component is planned; see [ROADMAP.md](ROADMAP.md). For the linkage-terms component, the web application's Expert authoring surface in the Matching keys tab exports the terms as a JSON or YAML document (and imports one back, round-tripped through the same validation), which serves as a GUI-produced reference. The per-section snippets above are the working reference for the rest.

## See also

- [DESIGN.md](DESIGN.md) - overview of exchange specification purpose and its four components
- [EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md) - the self-attested exchange record this specification's governance fields and `retention_disposition` pointer feed into
- [DEFAULT_STANDARDIZATION.md](spec/DEFAULT_STANDARDIZATION.md) - the per-type default cleaning pipelines and the column-name inference table, for a configuration that authors no `standardization` or `metadata` block
- [PROTOCOL.md](spec/PROTOCOL.md) - how linkage terms parameterize the PSI protocol
- [COMMUNICATION.md](COMMUNICATION.md) - how `connection` fields map to channel infrastructure
- [DEPLOYMENT.md](DEPLOYMENT.md) - operating the supporting services referenced in `connection` fields
- [CLI.md](CLI.md) - CLI commands and configuration files that consume this specification
