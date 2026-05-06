---
title: "Exchange Specification Reference"
---

# Exchange specification reference

Exchange specifications are JSON or YAML documents that fully describe a PSI-Link exchange between two parties. They are consumed by both the web application and the CLI application. The web application provides an interactive editor for creating them; the CLI application accepts them as configuration files.

An exchange specification has four top-level components:

| Component | Required | Description |
|-----------|----------|-------------|
| `agreement` | yes | What will be exchanged and how; verified by both parties |
| `connection` | yes | Where and how the exchange will take place |
| `metadata` | no | Descriptions of input fields and their roles |
| `cleaning` | no | Data transformation pipelines applied before linkage |

---

## Exchange agreement

The Exchange Agreement is verified by both parties at the start of every exchange. After authentication, both parties swap their copies; if any mandatory field differs, the exchange is cancelled. Fields marked as "soft" produce a warning and an updated agreement output rather than an error.

### `agreement.version`

*Type:* string  
*Required:* yes  
*Consistency:* mandatory

A semver string identifying the schema of this Exchange Agreement. Two versions are incompatible if no migration path exists from the lower version to the higher; in that case the exchange fails before any data is transmitted.

### `agreement.identity`

*Type:* string  
*Required:* yes  
*Consistency:* none

A free-text string identifying the party holding this agreement. Included verbatim in the non-repudiation receipt. Parties may format this however they wish; common contents include name, organization, and contact information.

```yaml
agreement:
  identity: "Jane Smith, Agency A, jsmith@agency-a.gov"
```

### `agreement.date`

*Type:* ISO 8601 date string  
*Required:* yes  
*Consistency:* soft

Date this Exchange Agreement was last modified. A mismatch produces a warning indicating that one party may have a stale copy.

### `agreement.algorithm`

*Type:* enum: `psi` | `psi-c`  
*Required:* yes  
*Consistency:* mandatory

- `psi` — reveals the intersection (matched records and their identifiers). Intended for operational data exchange.
- `psi-c` — reveals only the cardinality of the intersection (how many records match). Intended for research and program planning.

### `agreement.output`

*Type:* object  
*Required:* yes  
*Consistency:* mandatory

```yaml
agreement:
  output:
    expects_output: true       # whether this party expects to receive the result
    share_with_partner: false  # whether the other party should also receive the result
```

If `share_with_partner` is `true`, the other party's agreement must also have `expects_output: true`; a mismatch aborts the exchange.

`expects_output` must be `true` if this party's `multiplicity` is `many`.

If exactly one party's `expects_output` is `true`, that party acts as the receiver and the other as the sender. If both parties declare `expects_output: true`, roles are assigned dynamically by exchanging dataset sizes and minimizing the total amount of data that needs to be transmitted.

### `agreement.multiplicity`

*Type:* enum: `one` | `many`  
*Required:* yes  
*Consistency:* mandatory

The multiplicity of links for the party holding this agreement. The combined multiplicity of the exchange is inferred when both agreements are compared.

```yaml
agreement:
  multiplicity: one
```

Multiplicity determines how the cascade algorithm handles records after each round.

Any party indicating `many` must have `expects_output: true`.

### `agreement.linkage_keys`

*Type:* array  
*Required:* yes  
*Consistency:* mandatory

An ordered list of linkage keys applied in sequence from most to least precise. Each round of the PSI protocol matches only records not yet resolved in a prior round.

```yaml
agreement:
  linkage_keys:
    - name: "SSN4 + Last Name + DOB"
      elements:
        - semantic_type: ssn_last4
          constraints:
            ssa_rules: false
        - semantic_type: last_name
          constraints:
            max_length: 10
            affixes_allowed: false
            allowed_characters: 'A-Z '
        - semantic_type: date_of_birth
    - name: "SSN, all two-digit transpositions"
      elements:
        - semantic_type: ssn
          generate_combinations: transpositions
          constraints:
            ssa_rules: true
            exclude:
              - "123456789"  # common placeholder, not a valid assignment
              - "111111111"  # common placeholder, not a valid assignment
```

#### Linkage key fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Human-readable name for this key |
| `elements` | array | yes | Data elements combined to form the key |
| `swap` | array | no | An array of two elements by `semantic_type` or `name` for which the receiver or sender will swap their data elements for this key (see below) |

#### Element fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `semantic_type` | string | yes | The type of PII (see Semantic types) |
| `name` | string | no | Optional name allowing the same `semantic_type` to be used in multiple elements within the same linkage rule |
| `generate_combinations` | string | no | Method for generating additional values for fuzzy matching: `transpositions` generates all two-digit transpositions; `deletions` generates all single-character deletions up to `max_length`, matching values within one edit distance |
| `constraints` | object | no | Data standards this party commits to meeting when preparing their data |

#### Semantic types

| Value | Description |
|-------|-------------|
| `ssn` | Social Security Number (9 digits) |
| `ssn_last4` | Last four digits of SSN |
| `first_name` | Given name |
| `last_name` | Family name |
| `date_of_birth` | Date of birth |
| `phone_number` | Phone number |
| `email_address` | Email Address |

TBD: Full enumeration of supported semantic types.

#### Constraints

Constraints are not enforced by the application — they are standards that both parties independently commit to meeting when preparing their data. The application will warn if a constraint is violated, but it will not transform the data to satisfy it. Each party is responsible for ensuring their data conforms before running the exchange.

Dates of birth must be formatted as `YYYYMMDD` and Social Security Numbers as `XXXXXXXXX` (a nine-character string, not a number). Converting raw input to these formats is the responsibility of each party's data cleaning pipeline.

| Field | Type | Applies to | Description |
|-------|------|------------|-------------|
| `ssa_rules` | boolean | `ssn`, `ssn_last4` | Data must conform to Social Security Administration [rules](https://www.ssa.gov/kc/SSAFactSheet--IssuingSSNs.pdf) for valid SSNs) |
| `exclude` | array of strings | any | Values that must not appear in the data; useful for filtering placeholder values such as `123456789` and `111111111` for SSNs |
| `max_length` | integer | name fields | Field must be truncated to at most this length |
| `allowed_characters` | string | name fields | Regex character class; characters outside it must have been removed |
| `affixes_allowed` | boolean | name fields | If false, honorifics (Mr., Dr., etc.) and suffixes (Jr., III, etc.) are expected to have been removed |

TBD: Full constraint schema with valid values for each field.

#### Swapped keys

When a `swap` array is present, the receiver transmits a linkage key generated with the two named elements swapped, while the sender generates a linkage key with un-swapped elements. For example, a key might match first name swapped with last name to catch data entry errors where the names are reversed at one agency.

### `agreement.legal_agreement`

*Type:* object  
*Required:* no  
*Consistency:* mandatory if present

Reference to the legal data sharing agreement authorizing this exchange. If `expiration_date` has passed, the exchange fails before any data is transmitted.

```yaml
agreement:
  legal_agreement:
    reference: "MOU-2025-0042"
    expiration_date: "2027-12-31"
```

### `agreement.payload`

*Type:* object  
*Required:* no  
*Consistency:* mandatory if present

Additional data columns transmitted after the intersection is identified, over the established encrypted channel. Each party independently specifies what they will send and what they expect to receive. Column descriptions sent to the partner constitute a data dictionary.

```yaml
agreement:
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

TBD: All of the Connection section is a sketch and shouldn't be referenced for implementation.

Specifies the communication channel and any authentication material.

### `connection.channel`

*Type:* enum: `webrtc` | `sftp`  
*Required:* yes

The communication channel for the exchange. See [DESCRIPTION.md](DESCRIPTION.md) and [DEPLOYMENT.md](DEPLOYMENT.md) for infrastructure requirements for each channel.

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

TBD: Full schema for SFTP authentication methods (password, SSH key, certificate).

### `connection.authentication`

*Type:* object  
*Required:* no

Shared PAKE token for SPAKE2 mutual authentication. If omitted for SFTP, trust is delegated to the SFTP server's access controls rather than establishing an independent encrypted session.

```yaml
connection:
  authentication:
    pake_token: "<base64-encoded shared secret>"
```

TBD: Encoding, minimum entropy requirements, and generation procedure. The web application generates tokens using the browser's `crypto.getRandomValues`.

---

## Input metadata

Optional field-level descriptions of the input dataset. If omitted, semantic types are inferred from column names. If no identifier columns are specified, output row indices reference positions in the input file.

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
| `semantic_type` | string | no | Semantic type (see Semantic Types above); inferred from name if omitted |
| `role` | enum | no | `linkage`, `identifier`, `payload`, or `ignored`; inferred if omitted |
| `description` | string | no | Human-readable description; shared with partner for payload columns |

---

## Data cleaning pipelines

TBD: This whole section is a sketch and shouldn't be referenced for implementation.

Optional per-column transformation pipelines applied before linkage key generation. Each pipeline takes one input column, applies a sequence of functions, and produces a named cleaned output. Linkage key elements reference cleaned outputs by name.

```yaml
cleaning:
  - output: "clean_last_name"
    input: "LAST_NAME"
    steps:
      - function: remove_punctuation
      - function: trim_whitespace
      - function: to_upper_case

  - output: "clean_dob"
    input: "DOB"
    steps:
      - function: parse_date
        params:
          input_format: "MM/DD/YYYY"
          output_format: "YYYY-MM-DD"

  - output: "ssn4"
    input: "SSN"
    steps:
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
| `phonetic` | Apply a phonetic algorithm | `algorithm`: `soundex` \| `metaphone` \| TBD |
| `strip_titles` | Remove name prefixes and suffixes | TBD |

TBD: Full function library with parameter schemas, error behavior (e.g., what happens when `parse_date` receives a value that does not match `input_format`), and examples.

---

## Full example

TBD: A complete, annotated exchange specification document in YAML and JSON covering all components and the most common configurations.
