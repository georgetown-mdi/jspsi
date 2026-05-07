---
title: "Exchange Specification Reference"
---

# Exchange specification reference

Exchange specifications are JSON or YAML documents that fully describe a
PSI-Link exchange between two parties. They are consumed by both the web
application and the CLI application. The web application provides an interactive
editor for creating them; the CLI application accepts them as configuration
files.

An exchange specification has four top-level components:

| Component | Required | Description |
|-----------|----------|-------------|
| `linkage_terms` | yes | What will be exchanged and how; verified by both
parties |
| `connection` | yes | Where and how the exchange will take place |
| `metadata` | no | Descriptions of input fields and their roles |
| `cleaning` | no | Data transformations applied before linkage |

---

## Linkage terms

Linkage terms are verified by both parties at the start of every exchange. After authentication, both parties swap their terms; if any fields are inconsistent,
the exchange is cancelled. Fields marked as "soft" produce a warning and an
updated set of terms are written out rather than an error.

### `linkage_terms.version`

*Type:* string  
*Required:* yes  
*Consistency:* mandatory

A semver string identifying the schema of the linkage aggreement. Two versions
are incompatible if no migration path exists from the lower version to the
higher.

### `linkage_terms.identity`

*Type:* string  
*Required:* yes  
*Consistency:* none

A free-text string identifying the party holding these terms. Included
verbatim in the non-repudiation receipt. Parties may format this however they
wish; common contents include name, organization, and contact information.

```yaml
linkage_terms:
  identity: "Jane Smith, Agency A, jsmith@agency-a.gov"
```

### `linkage_terms.date`

*Type:* ISO 8601 date string  
*Required:* yes  
*Consistency:* soft

Date these linkage terms were last modified. A mismatch produces a warning
indicating that one party may have a stale copy.

### `linkage_terms.algorithm`

*Type:* enum: `psi` | `psi-c`  
*Required:* yes  
*Consistency:* mandatory

- `psi` — reveals the intersection (matched records and their identifiers).
Intended for operational data exchange.
- `psi-c` — reveals only the cardinality of the intersection (how many records
match). Intended for research and program planning.

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

If `share_with_partner` is `true`, the other party's terms must also have
`expects_output: true`; a mismatch aborts the exchange.

`expects_output` must be `true` if this party's `deduplicate` is `true`.

### `linkage_terms.deduplicate`

*Type:* boolean
*Required:* yes  
*Consistency:* mandatory

Whether or not to deduplicate the inputs of the party holding these terms.
Deduplication results in multiple inputs potentially being matched to the same
output.

```yaml
linkage_terms:
  deduplicate: false
```

Any party indicating `true` must have `expects_output: true`.

### `linkage_terms.fields`

*Type:* array  
*Required:* yes  
*Consistency:* mandatory

The linkage fields define the standardized form of each PII element that
participates in linkage. Each field has a name, a semantic type, and optional
constraints. The name is a unique identifier used by linkage key elements and
data cleaning transformation outputs to refer to this field.

Constraints are not enforced by the application — they are standards that both
parties independently commit to meeting when preparing their data. The
application will warn if a constraint is violated, but it will not transform the
data to satisfy it. In the future, it may be an option to upgrade these warnings
to errors.

Social Security Numbers must be formatted as `XXXXXXXXX` (nine-character
numeric string, no dashes). Dates of birth must be formatted as `YYYYMMDD`.
Converting raw input to these formats is the responsibility of each party's
data cleaning transformations.

```yaml
linkage_terms:
  fields:
    - name: ssn
      semantic_type: ssn
      constraints:
        valid_only: true
        exclude:
          - "123456789"
          - "111111111"
    - name: ssn4
      semantic_type: ssn_last4
    - name: first_name
      semantic_type: first_name
      constraints:
        affixes_allowed: false
        allowed_characters: 'A-Z '
    - name: first_name_raw
      semantic_type: first_name
    - name: last_name
      semantic_type: last_name
      constraints:
        affixes_allowed: false
        allowed_characters: 'A-Z '
    - name: date_of_birth
      semantic_type: date_of_birth
```

#### Fields fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Identifier referenced by linkage key elements and
cleaning transformation outputs |
| `semantic_type` | string | yes | The type of PII this field represents (see
Semantic types) |
| `constraints` | object | no | Data standards both parties commit to meeting
when preparing this field |

#### Semantic types

| Value | Description |
|-------|-------------|
| `ssn` | Social Security Number (9-character string) |
| `ssn_last4` | Last four digits of SSN; distinct from `ssn` because some
parties only possess the last four digits |
| `first_name` | Given name |
| `last_name` | Family name |
| `date_of_birth` | Date of birth |
| `phone_number` | Phone number |
| `email_address` | Email address |

TODO: Full enumeration of supported semantic types.

#### Constraints

| Field | Type | Applies to | Description |
|-------|------|------------|-------------|
| `valid_only` | boolean | `ssn`, `ssn_last4` | Data must conform to Social
Security Administration
[rules](https://www.ssa.gov/kc/SSAFactSheet--IssuingSSNs.pdf) for valid SSNs |
| `valid_only` | boolean | `date_of_birth` | Must be a valid date |
| `exclude` | array of strings | any | Values that must not appear in the data;
useful for filtering placeholder values such as `123456789` and `111111111` for
SSNs |
| `allowed_characters` | string | name fields | Regex character class;
characters outside it must have been removed |
| `affixes_allowed` | boolean | name fields | If false, honorifics (Mr., Dr.,
etc.) and suffixes (Jr., III, etc.) are expected to have been removed |

TODO: Full constraint schema with valid values for each field.

---

### `linkage_terms.keys`

*Type:* array  
*Required:* yes  
*Consistency:* mandatory

An ordered list of linkage keys applied in sequence from most to least precise.
Each round of the PSI protocol matches only records not yet resolved in a prior
round. Each element references a linkage field by name and may optionally
specify transformations applied to that field's canonical value before it is
concatenated into the key.

The name of each linkage key must be unique. The elements within any linkage
must either reference a unique linkage field or have an alias that is unique.

```yaml
linkage_terms:
  keys:
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
                start: 0
                length: 4
        - field: first_name
          transform:
            - function: substring
              params:
                start: 0
                length: 1
    - name: "SSN, all two-digit transpositions"
      elements:
        - field: ssn
          generate_combinations: transpositions
```

#### Key fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable name for this key |
| `elements` | array | yes | Data elements combined to form the key |
| `swap` | array | no | An array of two field names (or element `name` values)
for which the receiver swaps their data elements for this key (see below) |

#### Element fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `field` | string | yes | Name of a linkage field from
`linkage_terms.linkage_fields` |
| `name` | string | no | Optional alias for this element; used when the same
field appears more than once in a key, or as the target of a `swap` |
| `transform` | array | no | Sequence of transformation steps applied to the
canonical field value before concatenation into the key |
| `generate_fuzzy_comparisons` | string | no | Method for generating additional
values for fuzzy matching: `transpositions` generates all two-digit
transpositions; `edits` generates all single-character deletions up to
`max_length`, matching values within one edit distance; `adjacent_years`
generates dates +/- 1 year from the input. Applied after any transformation |

#### Transform steps

Each step in a `transform` array applies one function from the cleaning
function library. Steps are applied in order.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `function` | string | yes | Name of the function to apply (see Available
functions in the Data cleaning section) |
| `params` | object | no | Function-specific parameters |

#### Swapped keys

When a `swap` array is present, the receiver transmits a linkage key generated
with the two named elements swapped, while the sender generates a linkage key
with un-swapped elements. Element names are matched first against element `name`
values, then against `field` names. For example, a key might match first name
swapped with last name to catch data entry errors where the names are reversed
at one agency.

### `linkage_terms.legal_agreement`

*Type:* object  
*Required:* no  
*Consistency:* mandatory if present

Reference to the legal data sharing agreement authorizing this exchange. If
`expiration_date` has passed, the exchange fails before any data is transmitted.

```yaml
linkage_terms:
  legal_agreement:
    reference: "MOU-2025-0042"
    expiration_date: "2027-12-31"
```

### `linkage_terms.payload`

*Type:* object  
*Required:* no  
*Consistency:* mandatory if present

Additional data columns transmitted after the intersection is identified, over
the established encrypted channel. Each party independently specifies what they
will send and what they expect to receive. Column descriptions sent to the
partner constitute a data dictionary.

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

---

## Connection

NOTE: All of the Connection section is a sketch and shouldn't be referenced for
implementation.

Specifies the communication channel and any authentication material.

### `connection.channel`

*Type:* enum: `webrtc` | `sftp`  
*Required:* yes

The communication channel for the exchange. See [DESCRIPTION.md](DESCRIPTION.md)
and [DEPLOYMENT.md](DEPLOYMENT.md) for infrastructure requirements for each
channel.

### `connection.servers`

*Type:* array  
*Required:* yes

Channel-specific server configuration.

#### WebRTC servers

```yaml
connection:
  channel: webrtc
  servers:
    - type: peer_coordination
      url: "https://coord.example.org"
    - type: stun
      url: "stun:stun.example.org:3478"
    - type: turn
      url: "turn:turn.example.org:443"
      username: "TBD"
      credential: "TBD"
```

#### SFTP servers

```yaml
connection:
  channel: sftp
  servers:
    - host: sftp.example.org
      port: 22
      username: psilink
      path: /exchanges/agency-a-agency-b/
```

TODO: Full schema for SFTP authentication methods (password, SSH key,
certificate).

### `connection.authentication`

*Type:* object  
*Required:* no

Shared PAKE token for SPAKE2 mutual authentication. If omitted for SFTP, trust
is delegated to the SFTP server's access controls rather than establishing an
independent encrypted session.

```yaml
connection:
  authentication:
    pake_token: "<base64-encoded shared secret>"
```

TODO: Encoding, minimum entropy requirements, and generation procedure. The web
application generates tokens using the browser's `crypto.getRandomValues`.

---

## Input metadata

Optional field-level descriptions of the input dataset. If omitted, semantic
types are inferred from column names. If no identifier columns are specified,
output row indices reference positions in the input file.

```yaml
metadata:
  columns:
    - name: "LAST_NAME"
      semantic_type: last_name
      role: linkage
      description: "Legal last name as recorded at enrollment"
    - name: "DOB"
      semantic_type: date_of_birth
      role: linkage
    - name: "CLIENT_ID"
      role: identifier
      description: "Internal client identifier"
    - name: "PROGRAM_START_DATE"
      role: payload
      description: "Date client enrolled in the program"
    - name: "COUNTY"
      role: ignored
```

### Column fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Column name in the input CSV |
| `semantic_type` | string | no | Semantic type (see Semantic Types above);
inferred from name if omitted |
| `role` | enum | no | `linkage`, `identifier`, `payload`, or `ignored`;
inferred if omitted |
| `description` | string | no | Human-readable description; shared with partner
for payload columns |

---

## Data cleaning transformations

NOTE: This whole section is a sketch and shouldn't be referenced for
implementation.

Optional per-column transformation applied before linkage key generation. Each
transformation takes one input column, applies a sequence of functions, and
produces a named output. The `output` name must match the `name` of a linkage
field defined in `linkage_terms.linkage_fields`; this is how the application
knows which standardized field each transformation produces.

```yaml
cleaning:
  - output: last_name      # matches linkage_terms.linkage_fields[].name
    input: LAST_NAME
    steps:
      - function: strip_titles
      - function: remove_punctuation
      - function: to_upper_case

  - output: date_of_birth
    input: DOB
    steps:
      - function: parse_date
        params:
          input_format: "MM/DD/YYYY"
          output_format: "YYYYMMDD"

  - output: ssn4           # produced from full SSN when only ssn4 is needed
    input: SSN
    steps:
      - function: remove_dashes
      - function: substring
        params:
          start: 5
          length: 4
```

### Available functions

| Function | Description | Parameters |
|----------|-------------|------------|
| `remove_punctuation` | Strip all punctuation characters | — |
| `trim_whitespace` | Remove leading and trailing whitespace | — |
| `to_upper_case` | Convert to uppercase | — |
| `to_lower_case` | Convert to lowercase | — |
| `parse_date` | Reformat a date string | `input_format`, `output_format` |
| `substring` | Extract a substring | `start` (0-indexed), `length` |
| `phonetic` | Apply a phonetic algorithm | `algorithm`: `soundex` \|
`metaphone` \| TBD |
| `strip_titles` | Remove name prefixes and suffixes | TBD |

TODO: Full function library with parameter schemas, error behavior (e.g., what
happens when `parse_date` receives a value that does not match `input_format`),
and examples.

---

## Full example

TODO: A complete, annotated exchange specification document in YAML and JSON
covering all components and the most common configurations.
