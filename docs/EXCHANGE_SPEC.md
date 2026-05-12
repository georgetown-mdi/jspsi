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
| `linkage_terms` | yes | What will be exchanged and how; verified by both parties |
| `connection` | yes | Where and how the exchange will take place |
| `metadata` | no | Descriptions of input fields and their roles |
| `cleaning` | no | Data transformations applied before linkage |

## File references

Any string value in `config.yaml` that begins with `@` is read from the file at
the given path rather than used literally. For example:

```yaml
connection:
  authentication:
    pake_token: "@secret.key"
```

This is the recommended approach for credentials to avoid embedding sensitive
material in the configuration file itself.

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

PSI roles (sender / receiver) are derived from `output` after the terms
exchange. If exactly one party has `expects_output: true`, that party
becomes the PSI receiver. If both parties have `expects_output: true`,
the application exchanges record counts over the established connection
and assigns the party with the smaller dataset as the receiver
(minimising data transmitted); ties are broken in favour of the initiator
becoming the receiver.

### `linkage_terms.deduplicate`

*Type:* boolean
*Required:* yes  
*Consistency:* none

Whether or not to deduplicate the inputs of the party holding these terms.
Deduplication results in multiple inputs potentially being matched to the same
output. Each party independently decides whether to deduplicate its own records;
the two values need not agree.

```yaml
linkage_terms:
  deduplicate: false
```

Any party indicating `true` must have `expects_output: true`. The requirement
to receive output is already captured by the cross-party `output` consistency
check, so no separate consistency check is applied to this field.

In a many-to-one exchange where the "one" party has `expects_output: false`,
the "many" party (with `deduplicate: true`) is additionally responsible for
enforcing uniqueness on the "one" party's side, ensuring that each partner
record is matched to at most one of its own records.

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
| `name` | string | yes | Identifier referenced by linkage key elements and cleaning transformation outputs |
| `semantic_type` | string | yes | The type of PII this field represents (see Semantic types) |
| `constraints` | object | no | Data standards both parties commit to meeting when preparing this field |

#### Semantic types

| Value | Description |
|-------|-------------|
| `ssn` | Social Security Number (9-character string) |
| `ssn_last4` | Last four digits of SSN; distinct from `ssn` because some parties only possess the last four digits |
| `first_name` | Given name |
| `last_name` | Family name |
| `date_of_birth` | Date of birth |
| `phone_number` | Phone number |
| `email_address` | Email address |
| `other` | Catch-all for other types |

Additional types will be added as their use case arises.

#### Constraints

| Field | Type | Applies to | Description |
|-------|------|------------|-------------|
| `valid_only` | boolean | `ssn`, `ssn_last4` | Data must conform to Social Security Administration [rules](https://www.ssa.gov/kc/SSAFactSheet--IssuingSSNs.pdf) for valid SSNs |
| `valid_only` | boolean | `date_of_birth` | Must be a valid date |
| `exclude` | array of strings | any | Values that must not appear in the data; useful for filtering placeholder values such as `123456789` and `111111111` for SSNs |
| `allowed_characters` | string | name fields | Regex character class; characters outside it must have been removed |
| `affixes_allowed` | boolean | name fields | If false, honorifics (Mr., Dr., etc.) and suffixes (Jr., III, etc.) are expected to have been removed |

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
| `field` | string | yes | Name of a linkage field from
`linkage_terms.fields` |
| `name` | string | no | Optional alias for this element; used when the same field appears more than once in a key, or as the target of a `swap` |
| `transform` | array | no | Sequence of transformation steps applied to the canonical field value before concatenation into the key |
| `generate_fuzzy_comparisons` | string | no | Method for generating additional values for fuzzy matching: `transpositions` generates all two-digit transpositions; `edits` generates all single-character deletions up to `max_length`, matching values within one edit distance; `adjacent_years` generates dates +/- 1 year from the input. Applied after any transformation |

#### Transform steps

Each step in a `transform` array applies one function from the cleaning
function library. Steps are applied in order.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `function` | string | yes | Name of the function to apply (see Available functions in the Data cleaning section) |
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

Specifies the communication channel, server addresses, and authentication
material.

### `connection.channel`

*Type:* enum: `webrtc` | `sftp`  
*Required:* yes

The communication channel for the exchange. See [DESIGN.md](DESIGN.md)
and [DEPLOYMENT.md](DEPLOYMENT.md) (NOTE: doc TBD) for infrastructure
requirements for each channel.

### `connection.server`

*Type:* object  
*Required:* yes

The primary server for the exchange. For WebRTC this is the PeerJS peer
coordination server; for SFTP this is the SFTP host. A URL may be supplied as a
convenience and will be decomposed into its component fields; the component
fields are the authoritative form.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | yes | Hostname or IP address |
| `port` | integer | no | Port number; defaults to the protocol standard (443 for HTTPS/WSS, 22 for SFTP) |
| `path` | string | no | URL path for WebRTC signaling; remote working directory for SFTP |
| `username` | string | no | Username for server authentication |
| `key` | string | WebRTC only | PeerJS API key for private PeerJS servers; omit when using a public server |

#### SFTP server authentication

SFTP requires exactly one primary authentication method alongside `username`.
`private_key_passphrase` and `certificate` are companions to `private_key` and
are invalid without it.

| Field | Type | Description |
|-------|------|-------------|
| `password` | string | Password authentication; `@`-file recommended |
| `private_key` | string | Path to SSH private key; `@`-file recommended |
| `private_key_passphrase` | string | Passphrase for an encrypted private key; only valid with `private_key` |
| `certificate` | string | Path to SSH certificate; only valid with `private_key`; enables certificate-based authentication |
| `host_key_fingerprint` | string | Optional expected server host key fingerprint for host verification |
| `known_hosts` | string | Optional path to a `known_hosts` file; alternative to `host_key_fingerprint` |

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
    host_key_fingerprint: "SHA256:..."
```

#### On-demand server provisioning

When the primary server is allocated on demand rather than always running, a
`provision` sub-object can be added to `server`. The application calls the
provisioning endpoint before attempting to connect. There are two modes:

**Lifecycle provisioning**: the server has a fixed, known address but is started
on demand to avoid consuming resources between exchanges. The static `host` and
other `server` fields are present alongside `provision` in both parties'
configs; `provision` is the call that wakes the server. Both parties may call
the same endpoint independently before connecting.

**Address-returning provisioning**: the endpoint allocates a fresh resource and
returns its address. Because the address is unknown until provisioning runs,
this is asymmetric: the provisioning party (conventionally the invitor) calls
the endpoint during exchange setup via the web application, and the resulting
static `server` fields are written into the other party's config before either
party runs the CLI. At run time the provisioning party's config retains
`server.provision`; the other party's config has only static `server` fields.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | yes | Hostname of the provisioning API |
| `port` | integer | no | Port; defaults to 443 |
| `path` | string | no | API path |
| `auth` | object | no | Authentication credentials (see [HTTP service authentication](#http-service-authentication-auth)) |

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

### `connection.authentication`

*Type:* object  
*Required:* no

Shared PAKE token for SPAKE2 mutual authentication. If omitted for SFTP, trust
is delegated to the SFTP server's access controls rather than establishing an
independent encrypted session.

The token is automatically rotated after each successful exchange: a replacement
is generated locally and transmitted to both parties over the authenticated
channel during the receipt step, taking effect only after both parties confirm
receipt. If the exchange fails before confirmation, the existing token remains
valid. The replacement token carries no expiration; any expiration on the prior
token is not inherited. The CLI stores the current token in `secret.key`
alongside `config.yaml` and references it via the `@`-file convention; the value
should not be edited manually.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pake_token` | string | yes | Shared SPAKE2 token; `@`-file recommended |
| `role` | enum | WebRTC only | `invitor` \| `acceptor`; used to derive deterministic PeerJS peer IDs from the shared token so both parties know each other's address without out-of-band communication. Orthogonal to the PSI protocol roles, which are determined by `linkage_terms.output` |
| `expires` | ISO 8601 datetime string | no | Expiration for this token; the exchange is aborted before the PAKE handshake begins if the current time is past this value. Tokens embedded in invitations carry a default expiration of 1 hour; tokens generated by rotation carry none. |

```yaml
connection:
  authentication:
    pake_token: "@.psilink/secret.key"
    role: invitor
    expires: "2026-05-15T17:00:00Z"
```

TODO: Encoding, minimum entropy requirements, and generation procedure. The web
application generates tokens using the browser's `crypto.getRandomValues`.

### `connection.stun`

*Type:* array  
*Required:* no  
*Applies to:* `webrtc`

STUN servers used for ICE candidate gathering. Each entry is a string in `stun:`
or `stuns:` URI format. Mutually exclusive with `ice_provision`; if
`ice_provision` is present, `stun` is invalid.

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

TURN servers used when a direct peer-to-peer connection cannot be established.
Credential type `hmac-sha1` indicates time-limited credentials generated via a
shared secret rather than a static password. Mutually exclusive with
`ice_provision`; if `ice_provision` is present, `turn` is invalid.

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

A provisioning endpoint that returns a complete set of ICE servers — STUN and
TURN combined — for the current exchange. Called at the start of each CLI run;
both parties call the same endpoint independently and may receive different
time-limited credentials pointing to the same infrastructure. This matches the
API shape of commercial ICE credential services such as Twilio Network
Traversal Service. Mutually exclusive with static `stun` and `turn`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | yes | Hostname of the ICE credential API |
| `port` | integer | no | Port; defaults to 443 |
| `path` | string | no | API path |
| `auth` | object | no | Authentication credentials
(see [HTTP service authentication](#http-service-authentication-auth)) |

```yaml
connection:
  ice_provision:
    host: nts.twilio.com
    path: /v1/credentials/ice
    auth:
      username: "@/run/secrets/twilio_sid"
      password: "@/run/secrets/twilio.key"
```

### `connection.proxy`

*Type:* object  
*Required:* no  
*Applies to:* `sftp`

A WebSocket-to-TCP proxy that tunnels the SFTP connection through HTTPS. This
field is determined by the client's network capabilities, not the server: a
browser-based client requires it because browsers cannot open raw TCP
connections, while a CLI client connects natively and omits this field. The two
parties' configs will therefore differ here even when connecting to the same
server.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | yes | Proxy hostname |
| `port` | integer | no | Port; defaults to 443 |
| `path` | string | no | Proxy path |
| `auth` | object | no | Authentication credentials (see [HTTP service authentication](#http-service-authentication-auth)) |

### HTTP service authentication (`auth`)

The `server.provision`, `ice_provision`, and `proxy` objects each accept an
optional `auth` sub-object. Exactly one authentication method may be specified.
`username` and `password` must appear together; neither is valid alone.

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

Protocol-specific tuning parameters. A configuration warning is made if fields
for one channel are given when the other channel is active.

#### WebRTC options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ice_timeout_ms` | integer | 5000 | Milliseconds to wait for ICE candidate gathering before failing |
| `max_message_size` | integer | 65536 | Maximum data-channel message size in bytes |

#### SFTP options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `poll_interval_ms` | integer | 30000 | Milliseconds between checks for the partner's uploaded file |
| `poll_timeout_ms` | integer | 3600000 | Total milliseconds to wait for the partner before giving up |
| `compression` | boolean | false | Enable SSH compression |
| `transfer_chunk_size` | integer | 32768 | Bytes per read/write chunk |

### `connection.provider_options`

*Type:* object  
*Required:* no

An opaque key-value map passed verbatim to the underlying transport library.
Keys and values are defined by the package providing the connection
implementation. `@`-file pathing is supported here as well.

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
| `semantic_type` | string | no | Semantic type (see Semantic Types above); inferred from name if omitted |
| `role` | enum | no | `linkage`, `identifier`, or `payload`; inferred if omitted |
| `is_payload` | boolean | no | Whether this column is transmitted as payload data after the intersection is identified; defaults to `true` when `role` is `payload`, `false` otherwise |
| `description` | string | no | Human-readable description; shared with partner for payload columns |

`role` and `is_payload` are partially independent. A column used for linkage or
as an identifier can also carry `is_payload: true`, meaning it participates in
the PSI protocol *and* is transmitted as payload for matched members.
For example, a phone-number column can have `role: linkage` and
`is_payload: true` so that it both links records and is delivered to the partner
for matched rows. Any column that is not used for linkage or identification must
have `is_payload: true`; the application will treat such a column as
`role: payload` if no role is specified.

---

## Data cleaning transformations

Optional per-column transformations applied before linkage key generation.
Conceptually, each transformation reads one input column, applies a sequence of
steps, and writes the result under a linkage field name. In implementation, a
transformation is a map between an input index and a set of output strings,
which lazily computes values and caches results. The `output` name of a data
cleaning transformation must match the `name` of a field in
`linkage_terms.fields`.

```yaml
cleaning:
  - output: last_name      # matches linkage_terms.fields[].name
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

  - output: ssn
    input: SSN_RAW
    steps:
      - function: remove_dashes
      - function: null_if
        params:
          values: ["000000000", "123456789", "111111111"]

  - output: last_name_variants   # fan-out: one row → multiple PSI entries
    input: LAST_NAME
    steps:
      - function: to_upper_case
      - function: split_on
        params:
          delimiter: "[-\\s]"
          include_original: true  # keep "SMITH-JONES" as well as "SMITH", "JONES"
```

Each linkage field may have at most one data cleaning transformation. Fields not
covered by an explicit data cleaning transformation are given an identity transformation and connected to a linkage field by matching the field's semantic
type against the input column's metadata.

### Transformation fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `output` | string | yes | Name of a linkage field from `linkage_terms.fields` |
| `input` | string | yes | Column name in the raw input CSV |
| `steps` | array | no | Steps applied in order; if omitted the raw value is
used unchanged |

### Step fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `function` | string | yes | Name of the function to apply (see Available functions below) |
| `params` | object | no | Function-specific parameters |

### Null propagation

A step may produce `null` to signal that the record has no valid value for this
field. Once a step produces `null`, all subsequent steps are skipped and the
field is absent from the record's PSI entry for any linkage key that references
it. This is the intended mechanism for enforcing `exclude` constraints declared
in a linkage field: a `null_if` step actively removes excluded values rather
than merely warning.

`coalesce` is the only function that acts on `null`: it substitutes a literal
default, allowing a pipeline to recover from an earlier null-producing step.

### Fan-out (multi-value fields)

The `split_on` function produces `set<string>` instead of a single `string`.
When a cleaning transformation ends with a set, the field carries multiple
candidate values. Each value generates a separate PSI entry for the row, but all
entries retain the original row identifier so that a match resolves back to the
source row.

**Cross-product**: when a linkage key references multiple fan-out fields, the
key strings are the cartesian product of those fields' value lists. A
`split_on` on both `first_name` and `last_name` with two parts each produces
four key strings per row. The total count can grow quickly; a warning is issued
when a single row generates more than 20 key strings for one linkage key.

**Match resolution for fan-out**: when more than one PSI entry derived from the
same original row appears in the intersection for a given linkage key round,
the correct behavior depends on the output mode. In a single-party-output
exchange the receiver can carry the row forward without informing the sender;
no inconsistency arises because the sender never learns the intersection result.
In a dual-party-output exchange utilizing a deterministic cascade and the
filtering of candidate records, the parties must communicate to determine
whether the multiple matches are distinct or conflated — that is, whether a
third piece of evidence resolves the apparent link. This additional
communication violates the protocol's privacy guarantee that nothing is learned
about records outside the intersection. Users who employ fan-out transformations
in a dual-party-output exchange are warned about this consequence.

When exactly one fan-out entry matches, the original row is accepted and all
its fan-out variants are removed from the candidate set for subsequent rounds.

**Distinction from `generate_fuzzy_comparisons`**: fan-out at the cleaning
stage and `generate_fuzzy_comparisons` on a key element both generate multiple
PSI entries per row, but they serve different purposes. Cleaning fan-out
reflects that a field legitimately has multiple canonical values (e.g. a
hyphenated name and its parts). `generate_fuzzy_comparisons` generates
approximate variants of a single canonical value to tolerate data entry errors
(e.g. digit transpositions in an SSN). Only one match is expected from a
`generate_fuzzy_comparisons` expansion; multiple matches from the same row in a
cleaning fan-out may all be meaningful.

### Available functions

#### String transformation

| Function | Description | Parameters |
|----------|-------------|------------|
| `remove_punctuation` | Remove all non-alphanumeric, non-space characters | — |
| `remove_dashes` | Remove `-` characters | — |
| `trim_whitespace` | Remove leading and trailing whitespace | — |
| `to_upper_case` | Convert to uppercase | — |
| `to_lower_case` | Convert to lowercase | — |
| `remove_accents` | Remove accents and other diacritics, ASCII-ifying the text | — |
| `strip_titles` | Remove name honorifics (Mr., Dr., …) and suffixes (Jr., III, …) | — |
| `substring` | Extract a substring | `start` (0-indexed, required), `length` (required) |
| `parse_date` | Reformat a date string | `input_format` (default `MM/DD/YYYY`), `output_format` (default `YYYYMMDD`); tokens: `YYYY`, `MM`, `DD` |
| `phonetic` | Apply a phonetic encoding | `algorithm`: `soundex` (default); result is a 4-character string |
| `replace_regex` | Replace all regex matches | `pattern` (required), `replacement` (default `""`) |
| `extract_regex` | Keep only the first capture group; produce `null` if no match | `pattern` (required) |

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

| Function | Description | Parameters |
|----------|-------------|------------|
| `split_on` | Split the value on a regex delimiter, producing `string[]` | `delimiter` (regex pattern, required), `include_original` (boolean, default `false`) |

When `split_on` finds no delimiter the value is returned unchanged as a
single-element list. When `include_original` is `true` the unsplit value
is prepended to the parts.

Steps following `split_on` are applied element-wise across all parts.
Null-producing steps filter individual elements; if all elements are filtered
the field becomes `null` and `coalesce` may recover it.

---

## Full example

TODO: A complete, annotated exchange specification document in YAML and JSON
covering all components and the most common configurations.
