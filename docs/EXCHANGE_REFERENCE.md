---
title: "Exchange Specification Reference"
---

# Exchange specification reference

This document is the complete field-level reference for PSI-Link exchange specifications. It covers all fields in the four components - linkage terms, connection, metadata, and data standardization - including types, valid values, consistency rules, and examples. It does not cover how the PSI protocol uses these parameters (see [PROTOCOL.md](spec/PROTOCOL.md)), the threat model or authentication design (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md)), or the CLI commands that consume this file (see [CLI.md](CLI.md)). Intended for anyone configuring an exchange.

Exchange specifications are JSON or YAML documents that fully describe a PSI-Link exchange between two parties. They are consumed by both the web application and the CLI application. The web application provides an interactive editor for creating them; the CLI application accepts them as configuration files.

An exchange specification has four top-level components:

| Component | Required | Description |
|-----------|----------|-------------|
| `linkage_terms` | yes | What will be exchanged and how; verified by both parties |
| `connection` | yes | Where and how the exchange will take place |
| `metadata` | no | Descriptions of input fields and their roles |
| `standardization` | no | Data cleaning and standardizing transformations applied before linkage |

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

### `linkage_terms.version`

*Type:* string  
*Required:* yes  
*Consistency:* mandatory

A semver string identifying the schema of the linkage aggreement. Two versions are incompatible if no migration path exists from the lower version to the higher.

### `linkage_terms.identity`

*Type:* string  
*Required:* yes  
*Consistency:* none

A free-text string identifying the party holding these terms. It is self-asserted - a party writes whatever string it likes and the protocol does nothing to vouch for it (hence `Consistency: none`). It is recorded, alongside the partner's, in the self-attested exchange record produced after every successful exchange (see [Exchange record format](spec/EXCHANGE_RECORD.md)), where -- because that record is unsigned -- it is an unverified label. It is also included verbatim in the non-repudiation receipt (receipt assembly is a planned 1.0 feature and is not yet wired up; see [ROADMAP.md](ROADMAP.md)), where it carries evidentiary weight only under a certificate-backed signature; there it must exactly match the identity bound into the presenting party's certificate, so under that mode this otherwise-free-text field is effectively pinned to what the party's signing certificate carries (see [Signing](#signing) and [Signing identity and certificate pinning](spec/PROTOCOL.md#signing-identity-and-certificate-pinning)). Under a session-derived receipt it remains an unverified label. Parties may format this however they wish; common contents include name, organization, and contact information.

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

- `psi` — reveals the intersection (matched records and their identifiers). Intended for operational data exchange.
- `psi-c` — reveals only the cardinality of the intersection (how many records match). Intended for research and program planning.

> **Not yet implemented:** the `psi-c` algorithm is not yet fully implemented. It is targeted for a release after 1.0; see [ROADMAP.md](ROADMAP.md). Use `psi` for now.

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

PSI roles (sender / receiver) are derived from `output` after the terms exchange. If exactly one party has `expects_output: true`, that party becomes the PSI receiver. If both parties have `expects_output: true`, the application exchanges record counts over the established connection and assigns the party with the smaller dataset as the receiver (minimising data transmitted); ties are broken in favour of the initiator becoming the receiver.

### `linkage_terms.deduplicate`

*Type:* boolean
*Required:* yes  
*Consistency:* none

Whether or not to deduplicate the inputs of the party holding these terms. Deduplication results in multiple inputs potentially being matched to the same output. Each party independently decides whether to deduplicate its own records; the two values need not agree.

```yaml
linkage_terms:
  deduplicate: false
```

Any party indicating `true` must have `expects_output: true`. The requirement to receive output is already captured by the cross-party `output` consistency check, so no separate consistency check is applied to this field.

In a many-to-one exchange where the "one" party has `expects_output: false`, the "many" party (with `deduplicate: true`) is additionally responsible for enforcing uniqueness on the "one" party's side, ensuring that each partner record is matched to at most one of its own records.

### `linkage_terms.linkage_fields`

*Type:* array  
*Required:* yes  
*Consistency:* mandatory

The linkage fields define the standardized form of each PII element that participates in linkage. Each field has a name, a semantic type, and optional constraints. The name is a unique identifier used by linkage key elements and data standardizing transformations.

Constraints are not enforced by the application — they are standards that both parties independently commit to meeting when preparing their data. The application will warn if a constraint is violated, but it will not transform the data to satisfy it. In the future, it may be an option to upgrade these warnings to errors.

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

Additional types will be added as their use case arises.

#### Constraints

| Field | Type | Applies to | Description |
|-------|------|------------|-------------|
| `valid_only` | boolean | `ssn`, `ssn4` | Data must conform to Social Security Administration [rules](https://www.ssa.gov/kc/SSAFactSheet--IssuingSSNs.pdf) for valid SSNs |
| `valid_only` | boolean | `date_of_birth` | Must be a valid date |
| `exclude` | array of strings | any | Values that must not appear in the data; useful for filtering placeholder values such as `123456789` and `111111111` for SSNs |
| `allowed_characters` | string | name fields | Regex character class; characters outside it must have been removed |
| `affixes_allowed` | boolean | name fields | If false, honorifics (Mr., Dr., etc.) and suffixes (Jr., III, etc.) are expected to have been removed |

The table above is the complete set of constraints. Constraints not listed for a given semantic type are not accepted by the schema; for example, `allowed_characters` on an `ssn` field is a validation error.

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
| `field` | string | yes | Name of a linkage field from
`linkage_terms.linkage_fields` |
| `name` | string | no | Optional alias for this element; used when the same field appears more than once in a key, or as the target of a `swap` |
| `transform` | array | no | Sequence of transformation steps applied to the canonical field value before concatenation into the key |
| `generate_fuzzy_comparisons` | string | no | Method for generating additional values for fuzzy matching: `transpositions` generates all two-digit transpositions; `edit_distances` generates all single-character deletions up to `max_length`, matching values within one edit distance; `adjacent_years` generates dates +/- 1 year from the input. Applied after any transformation |

#### Transform steps

Each step in a `transform` array applies one function from the cleaning and standardizing function library. Steps are applied in order.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `function` | string | yes | Name of the function to apply (see Available functions in the [Data standardization](#data-standardizing-transformations) section) |
| `params` | object | no | Function-specific parameters |

#### Swapped keys

When a `swap` array is present, the receiver transmits a linkage key generated with the two named elements swapped, while the sender generates a linkage key with un-swapped elements. A `swap` target names an element by that element's effective identifier: its `name` if it declares one, otherwise its `field`. An element that declares a `name` is referenced by that `name`, not by its `field`. For example, a key might match first name swapped with last name to catch data entry errors where the names are reversed at one agency. Each `swap` target must resolve to an element of the same key by this rule; a target matching no element in its key is rejected when the terms are decoded, rather than silently doing nothing at exchange time.

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

A party that declares it receives no output (`output.expects_output: false`) may not list `payload.receive` columns: it cannot receive payload for matched records it never gets, so the combination is rejected at parse and compatibility time. A non-receiving party may still `send` payload.

**Cross-party reconciliation (lazy `receive`).** The two parties' payload declarations are checked as a mirror -- one party's `send` against the other's `receive` -- but each direction is checked only when the *receiving* party declares a `receive`. A party that omits `payload.receive` accepts whatever the partner sends ("take whatever I am given"), so that direction is not cross-checked; a party that declares `payload.receive` requires the partner's `send` to match it exactly, or the exchange aborts before any data moves. This is what lets an invitation be authored without the inviter knowing the partner's columns: the inviter declares only its `send` and leaves `receive` open, the accepting party adopts the inviter's `send` as its own `receive` (so it validates exactly what it will get) and discloses its own `send` from its [input metadata](#input-metadata), and the inviter takes whatever that turns out to be. A zero-setup or direct `exchange` that authors no payload is lazy on both sides; a recurring exchange whose loaded configs declare `receive` on both sides is checked strictly in both directions. Laziness relaxes only this declaration check -- never what is disclosed: each party's own metadata still governs what it sends, so a lazy receiver only ever receives what the partner's own consented metadata transmits, and receiving is not a disclosure.

`payload.send` is a data dictionary: it states what flows, but whether a column's values are actually transmitted is governed by that column's [input metadata](#input-metadata) (`is_payload` and `role`), which is the single source of truth for disclosure. The two must agree. Every column named in `payload.send` must be one its metadata actually transmits -- `is_payload: true` with `role` not `ignored`. A `send` entry whose column is `is_payload: false`, `role: ignored`, or absent from the metadata over-declares: the dictionary exchanged with the partner, shown for consent, and written into the [exchange record](spec/EXCHANGE_RECORD.md) would claim a column that never flows. This is rejected up front (exit 64). When the column metadata is in hand as the invitation is generated -- a config with an explicit `metadata` block, or the web editor -- the rejection happens at mint, so the token and the partner's consent screen never carry the over-declared column. When the metadata is instead left to be inferred from the exchange's input (so it is not known at mint), the rejection happens during data preparation, before any connection is made -- as it also does for the paths that mint no invitation (a zero-setup or direct `exchange` run, and the accepting party). The mismatch can only over-declare -- it never transmits a column that was not declared -- so no value is disclosed beyond the dictionary; the check guards consent and record accuracy, not confidentiality.

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

**Mirror relationship across an invitation.** When an invitation carries a split-directory endpoint, the acceptor's seeded connection block starts as the inviter's *mirror image*: the acceptor's `inbound_path` is taken from the inviter's `outbound_path` and its `outbound_path` from the inviter's `inbound_path`, because one party's outbound is the other's inbound. The invitation conveys this role swap, so neither operator hand-edits which folder is inbound. The seeded block also carries the retain-mode options a split exchange requires, so it is runnable once the credential placeholders are filled in. (Emitting a split-directory endpoint from `psilink invite` is the inviter-side complement and is still pending -- see [CLI.md](CLI.md) "Current CLI limitations"; the acceptor mirror-swap applies to any invitation that does carry such an endpoint.)

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
| `username` | string | no | Username for server authentication |
| `key` | string | WebRTC only | PeerJS API key for private PeerJS servers; omit when using a public server |

#### SFTP server authentication

SFTP requires at most one primary authentication method alongside `username`. `private_key_passphrase` is a companion to `private_key` and is invalid without it.

| Field | Type | Description |
|-------|------|-------------|
| `password` | string | Password authentication; `@`-file recommended |
| `private_key` | string | Path to SSH private key; `@`-file recommended |
| `private_key_passphrase` | string | Passphrase for an encrypted private key; only valid with `private_key`; `@`-file recommended |
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

When the primary server is allocated on demand rather than always running, a `provision` sub-object can be added to `server`. The application calls the provisioning endpoint before attempting to connect. There are two modes:

**Lifecycle provisioning**: the server has a fixed, known address but is started on demand to avoid consuming resources between exchanges. The static `host` and other `server` fields are present alongside `provision` in both parties' configs; `provision` is the call that wakes the server. Both parties may call the same endpoint independently before connecting.

**Address-returning provisioning**: the endpoint allocates a fresh resource and returns its address. Because the address is unknown until provisioning runs, this is asymmetric: the provisioning party (conventionally the inviter) calls the endpoint during exchange setup via the web application, and the resulting static `server` fields are written into the other party's config before either party runs the CLI. At run time the provisioning party's config retains `server.provision`; the other party's config has only static `server` fields.

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

### `connection.role`

*Type:* string (`inviter` | `acceptor`)  
*Required:* no  
*Applies to:* `webrtc`

Identifies this party as the inviter or acceptor. Used to derive deterministic PeerJS peer IDs from the shared secret so both parties reach each other without an out-of-band address exchange. This is a peer-addressing concern specific to the WebRTC transport -- which is why it lives on the connection config rather than in the channel-agnostic top-level [`authentication`](#authentication) block -- and is orthogonal to the PSI protocol roles, which are determined by [`linkage_terms.output`](#linkage_termsoutput). For `sftp` and `filedrop` this field is not part of the schema and is silently dropped.

The partner shared secret itself is configured separately, in the top-level [`authentication`](#authentication) block.

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

STUN servers used for ICE candidate gathering. Each entry is a string in `stun:` or `stuns:` URI format. Mutually exclusive with `ice_provision`; if `ice_provision` is present, `stun` is invalid.

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

TURN servers used when a direct peer-to-peer connection cannot be established. Credential type `hmac-sha1` indicates time-limited credentials generated via a shared secret rather than a static password. Mutually exclusive with `ice_provision`; if `ice_provision` is present, `turn` is invalid.

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

A provisioning endpoint that returns a complete set of ICE servers — STUN and TURN combined — for the current exchange. Called at the start of each CLI run; both parties call the same endpoint independently and may receive different time-limited credentials pointing to the same infrastructure. This matches the API shape of commercial ICE credential services such as Twilio Network Traversal Service. Mutually exclusive with static `stun` and `turn`.

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
| `peer_timeout_ms` | integer | 3600000 | Milliseconds to wait for the partner at any single step before giving up, applied both to the initial rendezvous and to each message exchanged during the protocol; if the partner goes silent past this window the exchange fails with a transport error. The effective limit is the minimum of this and the remaining shared-secret lifetime. Must be a positive integer: a zero is rejected at parse time, since it would fire every transport wait immediately and disable this liveness budget. Connection teardown after a completed exchange is bounded separately and short, not by this value. |
| `server_connect_timeout_ms` | integer | 30000 | Milliseconds to wait during each connection attempt to the primary exchange server. Must be a positive integer: a zero is rejected at parse time, since it is not a meaningful "no timeout" (it fails a `filedrop` connect against a healthy mount immediately and disables the `sftp` connect timeout). |
| `max_reconnect_attempts` | integer | 3 | Maximum number of times to retry the initial connection after a fast transient failure (for example, while a share or its permissions are still settling), each attempt bounded by `server_connect_timeout_ms`. A timed-out attempt is terminal and is not retried, since a retry cannot recover an unresponsive server or mount; there is no reconnection after a connection drops mid-exchange. Bounded above by a sanity ceiling (one retry per second for seven days): a value past it is rejected at parse time, since against a fast-failing endpoint the retries pace at a one-second floor and a much larger count is only a self-inflicted hang. |

#### SFTP and file-drop options

These options apply to both `sftp` and `filedrop` channels.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `poll_interval_ms` | integer | 100 | Milliseconds between checks for the partner's uploaded file. The default is tuned for local-network mounts and CI; raise it (for example, to 1000-5000 ms) for public SFTP servers to reduce request load. |
| `timestamp_in_filename` | boolean | false | When `true`, each outgoing message filename also encodes a UTC timestamp and a per-session sequence number (see [Message filenames](#message-filenames)). Useful for filename-based logging in sync-mediated environments where the sync tool stamps files with the transfer time rather than the original creation time. |
| `lockless_rendezvous` | boolean | false | When `true`, the rendezvous handshake uses an ack-handshake barrier (`<id>-hello.json` plus a zero-length acknowledgment marker `<myId>-<peerId>-hello-ack.json` named after the peer hello it acknowledges) instead of the default atomic lock-file race (`<id>-hello.json` + `<peer1>-<peer2>-lock.json`). Required on sync-mediated transports that lack atomic exclusive-create or deletion visibility during rendezvous (e.g. a cloud sync service reconciling two local mirrors where both sides "win" a local create). Both parties must set this identically. The setting is advertised in the hello payload, and each party compares the peer's advertised value against its own wherever it reads a peer hello: a mismatch fails fast **at rendezvous, symmetrically on both parties** (in either arrival order), with a clear error naming each side's setting, rather than stalling until the peer timeout. (The symmetric half is best-effort: it presumes the advertising hello write lands. If that write itself fails, the detecting party still fails locally with the clear error, but its peer degrades to the peer timeout -- never worse than the pre-advertisement behavior. See [FILE_SYNC.md](spec/FILE_SYNC.md#bilateral-configuration-detect-and-fail-never-negotiate).) The operational sync glob in lockless mode is `<myId>-*` (upload) / `<partnerId>-*` (download), which covers hello, ack, and message files while excluding in-flight `temp-*.tmp` writes. |
| `peer_id` | string | — | A stable, human-readable identifier for this party. Appears in every filename this party writes (hello, message, ack) and in server-side logs and transcripts. When unset, a UUID is generated at construction time. Requires `timestamp_in_filename: true`; a reused stable id without a timestamp segment can collide with a leftover file from a crashed prior session. The two parties must use distinct ids, and neither may be the other's id extended by `-` (e.g. `"site"` and `"site-2"` are rejected at rendezvous; see [FILE_SYNC.md preconditions](spec/FILE_SYNC.md#preconditions-for-a-correct-exchange)). Spaces and `-` are permitted within a `peer_id`. The value `"temp"` is reserved. Filesystem-unsafe characters (`/` and NUL on all platforms; `<`, `>`, `:`, `"`, `\`, `|`, `?`, `*` on Windows NTFS) are not validated but may cause errors at the transport layer. |
| `retain_files` | boolean | false | When `true`, the receiver writes a zero-length acknowledgment marker after consuming each message rather than deleting it; the sender gates its next write on observing that marker rather than on the message file disappearing. No exchange file is deleted as a protocol step; the shared directory becomes a permanent transcript. Requires `timestamp_in_filename: true` -- without it, every message from the same party would share a filename and a retained transcript would overwrite itself. Also requires `lockless_rendezvous: true` -- lock rendezvous is delete-based and cannot produce the whole-directory no-delete transcript retain mode guarantees. The CLI `--retain-files` flag implies both `--lockless-rendezvous` and `--timestamp-in-filename` when those are not already set. Both parties must set this flag identically. Like `lockless_rendezvous`, the setting is advertised in the hello payload and compared at rendezvous: a mismatch fails fast **symmetrically on both parties** (in either arrival order) with a clear error naming each side's setting, rather than stalling until the peer timeout; like `lockless_rendezvous`, the symmetric half is best-effort, contingent on the advertising write landing (see [FILE_SYNC.md](spec/FILE_SYNC.md#bilateral-configuration-detect-and-fail-never-negotiate)). (When both flags differ at once -- only possible as `retain=true`/`lockless=true` versus both `false`, since `retain_files` implies `lockless_rendezvous` -- the error names the `retain_files` mismatch, which a single rerun realigns.) **A fresh directory is required for each exchange and is enforced**: with no sweep flag, `synchronize()` requires the directory to be empty except for at most one peer hello (foreign, non-protocol files are tolerated) and throws a `UsageError` on any other pre-existing *protocol* file (a leftover message, ack marker, lock file, or self-hello from a prior session; an orphaned `temp-<uuidv4()>.tmp` from a crashed in-flight write is swept, not rejected, while a foreign `temp-*.tmp` whose stem is not a v4 UUID is a non-protocol file and is tolerated like any other foreign name); otherwise a stale message would be mis-consumed against the per-session sequence counter and a stale ack marker could prematurely release the sender. To deliberately reuse a retain directory, `--sweep-exchange-files --force-retain-sweep` wipes the prior transcript first -- a CLI-only recovery (see [Directory exclusivity](#directory-exclusivity)). See [Acknowledgment markers](#acknowledgment-markers). |
| `unexpected_files` | enum | mode-coupled (see description) | How to handle a file that appears in the shared directory *during* the message loop and is neither recognized as part of this exchange nor an in-flight `temp-<uuidv4()>.tmp` write -- a sign the directory is being shared with another process or session, or that a sync tool produced a conflict copy or partial download (see [Directory exclusivity](#directory-exclusivity)). One of `error` (fail with a usage error, exit 64, naming the file and the directory path), `warn` (log once per distinct file name and continue), or `ignore` (skip silently -- the prior behavior). **Local, not bilateral**: detecting a foreign file is an observation of one's own directory view, needs no peer agreement, and carries none of the mismatch-stall risk of `lockless_rendezvous`/`retain_files`; the two parties may use different values. When unset the effective default is mode-coupled: `error` on plain delete-mode transports (ordinary `sftp`/`filedrop`) and `warn` when `retain_files` or `lockless_rendezvous` is set -- those flags signal a sync-mediated transport that legitimately produces transient conflict copies and partial downloads mid-session, where a hard fail would abort exactly the exchanges retain mode targets. An explicit value always overrides the mode-coupled default. This setting governs foreign-file detection only; a malformed *protocol* file (a peer-prefixed, message-shaped name a correctly configured peer cannot produce) is always reported regardless of this setting. |

#### Message filenames

On the `sftp` and `filedrop` channels each party writes its outgoing messages as files in the shared directory; the partner polls for them. Every message filename ends in `.json`, and the last `-`-delimited segment before the extension is a decimal byte count: the exact size of the serialized message. The receiver compares that declared count against the file's on-disk size and reads the file only once the two match, so a partially synced file is never read as a complete message. Because the byte count is always the final segment, parsing is right-anchored and a party id containing hyphens does not affect extraction.

With `timestamp_in_filename` unset (the default), the format is:

```
<id>-<byteCount>.json
```

With `timestamp_in_filename: true`, the filename additionally carries a timestamp and counter:

```
<id>-<YYYYMMDDTHHMMSS>-<NNN>-<byteCount>.json
```

`<YYYYMMDDTHHMMSS>` is the UTC write time in compact ISO 8601 form (no colons or hyphens, so it is Windows-safe and sorts lexicographically by time). `<NNN>` is a per-session counter that starts at `000`, is zero-padded to three digits, and increments with each message sent; it widens to four or more digits only after the 1000th message of a session.

In-flight writes use a temporary `.tmp` file that is renamed to the final `.json` name only once the write completes, so a sync tool watching `*.json` never observes a partial file under its final name. Handshake files (`<id>-hello.json`, `<peer1>-<peer2>-lock.json`, the lockless acknowledgment marker `<myId>-<peerId>-hello-ack.json`) are separate from message files and are documented in [FILE_SYNC.md](spec/FILE_SYNC.md).

#### Acknowledgment markers

When `retain_files: true`, the receiver writes a zero-length acknowledgment marker immediately after validating each message and before emitting it to the application layer. The marker is named after the message it acknowledges -- the writer's id, then the consumed message's name, then the `ack` type word -- so its terminal segment is `ack` (not a digit string) and it is never mistaken for a message even though the message's `<NNN>` and `<byteCount>` appear mid-name:

```
<receiverId>-<senderId>-<YYYYMMDDTHHMMSS>-<NNN>-<byteCount>-ack.json
```

This is the same construct as the lockless rendezvous ack (`<myId>-<peerId>-hello-ack.json`), applied to a message instead of a hello. The marker is **zero-length and matched by name existence**: it carries no body, so there is no byte-count gate and nothing to read. Because the name is a pure function of the acknowledged message's fixed name, the sender locates it by *constructing* the expected name from the message it sent -- it never parses the two ids back out of the marker -- and waits for that exact name to appear. Reprocessing the same message re-derives the identical name, so a transient retry creates no duplicate marker.

The receiver never deletes the consumed message file. The message and its ack both persist, and the directory accumulates one of each per exchanged message on every transport -- including those, such as SFTP, that do support deletion. This is what makes the directory a durable transcript rather than only a workaround for transports that cannot propagate deletions.

In `retain_files` mode `close()` does not delete exchange files; the directory is the transcript. This includes the rendezvous artifacts: each party's `-hello.json` and the lockless `-hello-ack.json` marker persist alongside the messages and their acks, so the transcript is not only message and ack files. The only file ever removed is an in-flight `temp-*.tmp` write, which is cleaned up inline on error.

The transcript accumulates with no in-protocol cleanup; retention, rotation, and archival are out-of-band operator responsibilities.

#### Directory exclusivity

The shared directory (SFTP path or local filedrop path) must be **dedicated exclusively**, for protocol-grammar files, to a single active exchange between exactly two parties. Both channels treat the directory as a private communication channel: each party reads and deletes files written by the other, and the rendezvous protocol uses filename presence as a synchronization signal.

A third process writing protocol-grammar files -- `<id>-hello.json`, `<peer1>-<peer2>-lock.json`, a `<id>-...-ack.json` marker, or a message-shaped `<id>-<digits>.json` -- into the same path during an active session will cause the exchange to abort with a diagnostic error. Separate concurrent exchanges must use separate directories.

**Foreign (non-protocol) files are tolerated.** A file whose name does not match the protocol grammar -- an unrelated file, or a sync tool's conflict copy or partial download -- does not abort the exchange. Foreign files present at session start are snapshotted and ignored for the session; one that first appears mid-session is handled by [`unexpected_files`](#connectionoptions) (`error`/`warn`/`ignore`). The protocol never deletes a foreign file. The exclusivity requirement is therefore on the protocol-grammar namespace, not on the directory as a whole. Note that a foreign file whose name coincidentally matches the message grammar (`<peerId>-<digits>.json`) is *not* foreign -- it is treated as a protocol message and rejected -- so this tolerance covers genuinely non-grammar names only.

**Recovering a contaminated or reused directory (CLI-only).** When a prior run crashed, or a bilateral-mode mismatch left protocol files behind, the entry guard rejects the next run, naming the offending files. Re-run with `--sweep-exchange-files` to delete every protocol file (this party's and the peer's) and start fresh; foreign files are left untouched. The sweep refuses if the directory shows a retain-mode signal -- it will not silently destroy a durable audit transcript -- so clearing such a directory requires the additional `--force-retain-sweep`, which permanently discards the prior transcript. These two flags are **CLI-only and invocation-scoped**: they are not `connection.options` keys and cannot be set in `psilink.yaml` ("always sweep" is not a state to persist). `--force-retain-sweep` requires `--sweep-exchange-files` and is rejected on its own. See [FILE_SYNC.md](spec/FILE_SYNC.md#the-five-enforcement-sites).

#### Filename grammar

Every protocol file on `sftp` and `filedrop` channels is named `<id>-...-<token>.json`, where `<token>` is the final `-`-delimited segment before `.json`:

- If `<token>` is all digits, the file is a **message** and `<token>` is its declared byte count. Parsing is right-anchored so a party id containing hyphens does not affect extraction.
- Otherwise `<token>` is a **type word** naming the file kind: `hello` (rendezvous hello), `ack` (a zero-length acknowledgment marker: the lockless rendezvous ack of a peer hello, and the retain-mode ack of a consumed message), `joining` (the lock-path joiner-arrival sentinel `<id>-joining.json`, briefly present while the joiner deletes the peer hello and renames the sentinel to its own hello), or `lock` (the rendezvous tiebreaker `<peer1>-<peer2>-lock.json`, created in lock mode -- the default `lockless_rendezvous: false` -- when both hellos coexist and one party wins the atomic exclusive-create race; both sides encode the two ids in hello-filename order so they reconstruct the same name). A typed file is never read as a message; the receiver's message scan ignores any file whose terminal segment is non-numeric, so a message ack's mid-name `<NNN>`/`<byteCount>` digits do not route it as a message.

The receiver only reads files whose on-disk size matches the declared byte count, so a partially synced message file is never consumed prematurely.

### `connection.provider_options`

*Type:* object  
*Required:* no  
*Applies to:* `webrtc`, `sftp`

An opaque key-value map of additional, non-security transport-tuning options for the underlying transport library. Keys and values are defined by the package providing the connection implementation. `@`-file pathing is supported here as well.

Unlike every other map in this spec, the keys here are **not** case-normalized: they are passed exactly as written, so author them in the casing the underlying transport library expects rather than snake_case. For the SFTP channel they are forwarded to `ssh2-sftp-client`, whose options are camelCase.

For the SFTP channel this map is **not** a verbatim passthrough: it is filtered through a default-deny allowlist before reaching `ssh2-sftp-client`. The connection target, credentials, and host-key-verification settings are derived solely from the structured [`connection.server`](#connectionserver) fields and **cannot** be set or overridden here -- so `host`, `port`, `username`, `password`, `private_key`/`privateKey`, `passphrase`, `host_verifier`/`hostVerifier`, `host_hash`/`hostHash`, and the connection-redirecting `sock`/`authHandler` options are all rejected if placed in `provider_options`. Only these benign tuning options are honored:

- `keepaliveInterval`, `keepaliveCountMax` -- SSH-level keepalive cadence.
- `strictVendor` -- ssh2's server-vendor strictness toggle.
- `algorithms` -- accepted, but filtered to its `cipher`, `hmac`, `kex`, and `compress` sub-categories; the `serverHostKey` sub-category is dropped, as host-key-type negotiation is a host-key-trust decision and not operator-overridable here.

Any other key (including `readyTimeout`, which is set from [`connection.options.server_connect_timeout_ms`](#connectionoptions) instead) is ignored, with a warning naming the dropped key. This keeps the opaque escape hatch useful for transport tuning while ensuring it can never weaken where psilink connects, what credentials it presents, or whether the server's host key is trusted.

---

## Authentication

*Type:* object  
*Required:* no (see note below)  
*Applies to:* all channels (`webrtc`, `sftp`, `filedrop`)

Optional top-level block, a sibling of [`signing`](#signing). It holds the partner shared-secret trust mechanism and is channel-agnostic -- the same shape applies to every channel. It mixes two kinds of field:

- **Runtime-injected secret state** (`shared_secret`, `expires`): loaded from the key file (`.psilink.key`) and added to the in-memory representation before the exchange runs. These never appear in `psilink.yaml` and must not be edited manually. If `shared_secret`, `sharedSecret`, or `expires` are present in the configuration file, the CLI emits a warning and ignores them; values from the key file always take precedence.
- **Operator-policy fields**: settable in `psilink.yaml`. `token_max_age_days` is the first (see the field table below). The loader leaves these for schema validation; the schema honors a recognized policy field and rejects an unrecognized key (see the unknown-key note below).

`shared_secret` is required for recurring exchanges run via the `exchange` command. If the key file (`.psilink.key`) is absent, the CLI aborts before any connection is attempted. Zero-setup exchanges (the `zero-setup` command) rely on transport-layer authentication instead and do not use a key file.

Taken together, the `authentication` block is never required in a configuration file -- its only fields today are key-file-injected. It is required for the in-memory objects used for recurring exchanges, and it is optional for zero-setup exchanges.

The shared secret is automatically rotated after each successful authentication handshake: both parties independently derive the replacement from the key-exchange session key using HKDF, so no extra round-trip is required. The CLI persists the new secret automatically; library consumers of `authenticateConnection` are responsible for persisting `rotatedSecret` from the returned `AuthResult` to their own storage. If the exchange fails before a successful handshake, the existing secret remains valid. If the handshake succeeds but the data exchange subsequently fails, both parties already hold the rotated secret and can retry without re-inviting. If the handshake succeeds but the new secret cannot be persisted (e.g., a disk-write error), both parties may be out of sync: the partner may already hold the rotated secret, making the old secret invalid. In that case both parties must re-invite. Invitation tokens carry a default expiration of 1 hour; rotation-generated shared secrets carry none by default, unless [`token_max_age_days`](#authenticationtoken_max_age_days) is set, in which case each rotation stamps an expiration that many days out.

| Field | Type | In `psilink.yaml` | Description |
|-------|------|-------------------|-------------|
| `shared_secret` | string | never; loaded from `.psilink.key` | Shared secret; a base64url-encoded 32-byte value (43 characters). Do not set manually. |
| `expires` | string (ISO 8601) | never; loaded from `.psilink.key` | Expiration of `shared_secret` -- either an invitation's bounded lifetime or a `token_max_age_days` stamp; the two are not distinguished and are enforced identically. Absent for a persistent token with no max-age policy. Do not set manually. |
| `token_max_age_days` | integer (positive) | yes (operator policy) | Maximum age, in days, to stamp onto a rotated token. See [`authentication.token_max_age_days`](#authenticationtoken_max_age_days). |

The loader strips only the injected fields (`shared_secret`/`expires`) from this block, warning when they are set; the value from the key file always wins. Any other key is left for schema validation, and -- unlike the sibling spec blocks, which strip unrecognized keys -- the `authentication` schema is **strict**: an unrecognized key (for example a misspelled `token_max_age_dayss`) is rejected at config-parse time with a user-facing error, and no exchange runs until it is corrected. This block alone is validated strictly because it alone holds an operator security *policy*: `token_max_age_days` is a max-age enforcement control, and a typo that `strip` would silently discard would disable the control with no signal to the operator. Failing closed forces the typo to be fixed before any exchange runs. (The injected secret value is protected separately by the warn-and-strip above; the strictness here is about surfacing a typo in a policy key, not about trust in the secret. Partner-controlled inputs, such as the invitation locator, are validated strictly for a different reason -- there an extra key could smuggle a value past the allowlist.)

WebRTC peer addressing (the `inviter`/`acceptor` distinction) is configured separately, via [`connection.role`](#connectionrole); it is a transport concern, not a partner-trust one, and so is not part of this block.

Why `authentication` and `signing` are two separate blocks (rather than one trust block) is explained in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#recurring-exchange-authentication).

### `authentication.token_max_age_days`

*Type:* integer (positive, at most 36500 -- about 100 years)  
*Required:* no

An operator-policy field, not key-file-injected. Rotation tokens written after each successful exchange carry no expiration by default, on the assumption that active partnerships exchange frequently. A dormant partnership (a monthly cadence, a holiday gap) could otherwise hold a valid token indefinitely. When `token_max_age_days` is set, a successful exchange stamps `expires` = (the moment of rotation) + `token_max_age_days` days into the rotated `.psilink.key`, bounding a token's age independently of exchange frequency. When it is omitted, rotated tokens carry no expiry (the unchanged default).

The stamp is enforced at the next `psilink exchange`, which reads the token's `expires` at load time:

- If `expires` is in the past, the CLI aborts before opening any connection or attempting the key exchange, with an error naming the expired time and directing both parties to re-invite.
- If the token is within `token_max_age_days / 3` days of expiry, the CLI emits a warning before the exchange. The warning is suppressed when that exchange succeeds (rotation stamps a fresh, farther-out `expires`); it is shown only when no successful rotation refreshed the token, where it is actionable.

`expires` enforcement is independent of `token_max_age_days`: a token whose `expires` is already set -- whether by this policy or by an invitation's bounded lifetime -- is honored even if the field is later unset. Setting or changing `token_max_age_days` affects only tokens stamped by subsequent rotations. The invitation lifetime and the max-age policy are two sources writing the same `expires`; psilink does not record which produced a given value and enforces both identically (an expired token of either origin aborts the exchange and directs both parties to re-invite). The reasoning, and why no provenance marker is stored, are in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#two-sources-one-expires).

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

The receipt signing mode. `none` signs no receipt (only the unsigned self-attested record is produced). `session-derived` is a MAC under the shared key-exchange session key -- tamper-evident but not non-repudiation and not third-party verifiable. `certificate` signs with this party's long-lived signing identity and is the only mode that yields third-party-verifiable non-repudiation. (Receipt assembly and the receipt swap are not yet wired up; this field, the signing identity, and the trust checks below are in place today.)

### `signing.identity_file`

*Type:* string (path)  
*Required:* no

Path to this party's signing identity file (the Ed25519 private key plus its self-signed certificate). Defaults to `~/.psilink/signing-identity.json` -- a per-user location, because one identity is reused across every exchange and partner. A leading `~` (or `~/`) is expanded to the home directory, so the value below works verbatim. The file is created lazily and owner-read-only by `psilink fingerprint` and is loaded thereafter; regenerate it deliberately with `psilink fingerprint --force` (which invalidates any fingerprint a partner has pinned).

### `signing.partner_fingerprint`

*Type:* string (43-character unpadded base64url SHA-256)  
*Required:* no (but required, in practice, to verify a partner under `certificate` mode)

The partner's pinned certificate fingerprint, obtained from the partner via `psilink fingerprint` and a trusted out-of-band channel. A presented partner certificate is trusted only if its self-signature verifies and its fingerprint matches this value; an absent or mismatched value rejects the partner's certificate (and therefore any receipt it carries) with a clear error. The fingerprint is not secret, but the channel that carries it must be authentic. It stays valid until the partner deliberately regenerates its identity.

```yaml
signing:
  mode: certificate
  identity_file: ~/.psilink/signing-identity.json
  partner_fingerprint: iWD-ZB69Oz6gOpaX_OoC7sD8ohIZj2lETC9qbl-IbPg
  receipt_output: ./receipts
```

### `signing.receipt_output`

*Type:* string (path)  
*Required:* no

Where signed receipts / evidence are written. Optional; the CLI falls back to a documented default when omitted.

Under `certificate` mode a receipt is accepted only if its asserted [`linkage_terms.identity`](#linkage_termsidentity) is the one the presenting certificate authorizes -- an exact match of the full identity over the same canonical bytes the record commits to and the receipt signs. A party that uses a different identity string than the one bound into its certificate needs a new certificate (a deliberate regeneration); see [PROTOCOL.md](spec/PROTOCOL.md#signing-identity-and-certificate-pinning).

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

When metadata is inferred (no explicit `metadata` block), an empty (zero-length) column name in the input is rejected at intake with a clear error (exit 64), the same way an explicit `metadata` `name` is rejected at config parse (see the `name` field below). A trailing comma, a blank cell, or a leading delimiter in a CSV header row produces such an unnamed column; because an empty name cannot be used for linkage, identification, or payload, the file is refused up front rather than silently dropping the column's audit record during the exchange. Name the column or remove the empty header field. The web app surfaces the same rejection at its file-intake surfaces (the quick and Advanced invite paths and the acceptor's file step).

```yaml
metadata:
  columns:
    - name: "LAST_NAME"
      type: last_name
      role: linkage
      description: "Legal last name as recorded at enrollment"
    - name: "DOB"
      type: date_of_birth
      role: linkage
    - name: "CLIENT_ID"
      role: identifier
      description: "Internal client identifier"
    - name: "PROGRAM_START_DATE"
      role: payload
      description: "Date client enrolled in the program"
    - name: "COUNTY"
      role: ignored
      description: "Present in the input but excluded from this exchange"
```

### Column fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Column name in the input CSV; must be non-empty, at most 256 characters, and unique within the metadata block (matched case-sensitively). A violation is rejected at config parse |
| `type` | string | no | Semantic type (see [Semantic Types](#semantic-types) above); inferred from name if omitted |
| `role` | enum | no | `linkage`, `identifier`, `payload`, or `ignored`; inferred if omitted (inference never assigns `ignored` -- it is opt-in only) |
| `is_payload` | boolean | no | Whether this column is transmitted as payload data after the intersection is identified; defaults to `true` when `role` is `payload`, `false` otherwise |
| `description` | string | no | Human-readable description; shared with partner for payload columns |

`role` and `is_payload` are partially independent. A column used for linkage or as an identifier can also carry `is_payload: true`, meaning it participates in the PSI protocol *and* is transmitted as payload for matched members. For example, a phone-number column can have `role: linkage` and `is_payload: true` so that it both links records and is delivered to the partner for matched rows. Any column that is not used for linkage or identification must have `is_payload: true`; the application will treat such a column as `role: payload` if no role is specified.

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

  - output: last_name_variants   # fan-out: one row -> multiple PSI entries
    input: LAST_NAME
    steps:
      - function: to_upper_case
      - function: split_on
        params:
          delimiter: "[-\\s]"
          include_original: true  # keep "SMITH-JONES" as well as "SMITH", "JONES"
```

Each linkage field may have at most one data standardization transformation. Fields not covered by an explicit transformation are given an identity transformation and connected to a linkage field by matching the field's semantic type against the input column's metadata.

### Transformation fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `output` | string | yes | Name of a linkage field from `linkage_terms.linkage_fields` |
| `input` | string | yes | Column name in the raw input CSV |
| `steps` | array | no | Steps applied in order; if omitted the raw value is
used unchanged |

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

> **Not yet implemented:** the `split_on` function and the fan-out behavior described in this section are not yet fully implemented. They are targeted for a release after 1.0; see [ROADMAP.md](ROADMAP.md). The description below is the intended design.

The `split_on` function produces `set<string>` instead of a single `string`. When a transformation ends with a set, the field carries multiple candidate values. Each value generates a separate PSI entry for the row, but all entries retain the original row identifier so that a match resolves back to the source row.

**Cross-product**: when a linkage key references multiple fan-out fields, the key strings are the cartesian product of those fields' value lists. A `split_on` on both `first_name` and `last_name` with two parts each produces four key strings per row. The total count can grow quickly; a warning is issued when a single row generates more than 20 key strings for one linkage key.

**Match resolution for fan-out**: when more than one PSI entry derived from the same original row appears in the intersection for a given linkage key round, the correct behavior depends on the output mode. In a single-party-output exchange the receiver can carry the row forward without informing the sender; no inconsistency arises because the sender never learns the intersection result. In a dual-party-output exchange utilizing a deterministic cascade and the filtering of candidate records, the parties must communicate to determine whether the multiple matches are distinct or conflated — that is, whether a third piece of evidence resolves the apparent link. This additional communication violates the protocol's privacy guarantee that nothing is learned about records outside the intersection. Users who employ fan-out transformations in a dual-party-output exchange are warned about this consequence.

When exactly one fan-out entry matches, the original row is accepted and all its fan-out variants are removed from the candidate set for subsequent rounds.

**Distinction from `generate_fuzzy_comparisons`**: fan-out at the standardization stage and `generate_fuzzy_comparisons` on a key element both generate multiple PSI entries per row, but they serve different purposes. Standardization fan-out reflects that a field legitimately has multiple canonical values (e.g. a hyphenated name and its parts). `generate_fuzzy_comparisons` generates approximate variants of a single canonical value to tolerate data entry errors (e.g. digit transpositions in an SSN). Only one match is expected from a `generate_fuzzy_comparisons` expansion; multiple matches from the same row in a standardization fan-out may all be meaningful.

### Available functions

Parameter names below are written in snake_case in YAML (e.g. `input_format`, `include_original`), following the same convention as the rest of the spec; they are normalized for the function library internally. Unlike `connection.provider_options`, a `params` block is not opaque and its keys are not passed verbatim.

**Regex patterns run under a linear-time engine.** The four regex functions (`replace_regex`, `extract_regex`, `filter_regex`, and `split_on`) take a `pattern` (a `delimiter` for `split_on`) that is compiled and run per row over the full dataset. Because a partner authors these patterns and they execute on your data, they run under a linear-time regular-expression engine (RE2 semantics) rather than the JavaScript engine, so no pattern can hang the application through catastrophic backtracking -- this is guaranteed by construction, not screened for. The cost is a restricted **dialect**: a pattern may use the common syntax (character classes, anchors, quantifiers, groups, alternation, and Unicode classes) but not the features that require backtracking -- backreferences and lookarounds -- and a few escapes and class semantics differ from JavaScript. A pattern outside the dialect is rejected at terms validation, before any row is processed. One operator-facing consequence of the switch: a pattern that backtracked catastrophically on the old engine (e.g. `(a+)+`) now simply runs in linear time rather than being rejected; `parse_date` runs on the same engine, so an `input_format` with many adjacent variable-width tokens is likewise bounded by construction. The permitted syntax, the JavaScript divergences, and the exact operation semantics are specified normatively in [PROTOCOL.md](spec/PROTOCOL.md#transform-regular-expression-dialect).

#### String transformation

| Function | Description | Parameters |
|----------|-------------|------------|
| `remove_non_ascii` | Remove all characters outside of the ASCII set, including emojii and symbols | — |
| `remove_punctuation` | Remove ASCII punctuation and symbols | — |
| `remove_dashes` | Remove hyphens | — |
| `replace_separators_with_spaces` | Replace hyphens, apostrophes, ampersands, slashes, and underscores with spaces | — |
| `squash_spaces` | Replace instances of multiple space characters together with a single space | — |
| `trim_whitespace` | Remove leading and trailing whitespace | — |
| `to_upper_case` | Convert to uppercase | — |
| `to_lower_case` | Convert to lowercase | — |
| `remove_accents` | Remove accents and other diacritics, ASCII-ifying the text; re-normalizes to NFC after the diacritic strip | — |
| `remove_affixes` | Remove name titles (Mr., Dr., ...) (and suffixes (Jr., III, ...) | — |
| `substring` | Extract a substring | `start` (1-indexed, required; negative counts from end), `length` (required) |
| `parse_date` | Reformat a date string | `input_format` (default `MM/DD/YYYY`), `output_format` (default `YYYYMMDD`), each at most 256 characters; tokens: `YYYY`, `MM`, `DD` |
| `pad_left` | Left-pad the value with a fill character up to a target length; pass-through if already at or above the length | `length` (positive integer, required, at most 256), `char` (single character, default `"0"`) |
| `phonetic` | Apply a phonetic encoding | `algorithm`: `soundex` (default); result is a 4-character string |
| `replace_regex` | Replace all regex matches | `pattern` (required), `replacement` (default `""`) |
| `extract_regex` | Keep the first capture group, or the whole match if the pattern has none; produce `null` if there is no match or the result is empty | `pattern` (required) |

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

> **Not yet implemented:** `split_on` (and fan-out generally) is not yet fully implemented; see [Fan-out (multi-value fields)](#fan-out-multi-value-fields) and [ROADMAP.md](ROADMAP.md).

| Function | Description | Parameters |
|----------|-------------|------------|
| `split_on` | Split the value on a regex delimiter, producing `Set<string>` | `delimiter` (regex pattern, required), `include_original` (boolean, default `false`) |

When `split_on` finds no delimiter it returns the value as a single-element set; when `include_original` is `true` the unsplit value is prepended to the parts. In both cases the value is the NFC-normalized form, consistent with the other derive-type steps (see [Unicode normalization](#unicode-normalization) above); this differs from the original bytes only when an upstream step such as `to_upper_case` left a non-NFC intermediate.

Steps following `split_on` are applied element-wise across all parts. Null-producing steps filter individual elements; if all elements are filtered the field becomes `null` and `coalesce` may recover it.

---

## Full example

An end-to-end annotated specification covering every component is planned; see [ROADMAP.md](ROADMAP.md). The web application's "Advanced options" editor, under Expert authoring, now exports the linkage terms as a JSON or YAML document (and imports one back, round-tripped through the same validation) -- the GUI-produced reference for the linkage-terms component. The per-section snippets above remain the working reference for the rest.

## See also

- [DESIGN.md](DESIGN.md) - overview of exchange specification purpose and its four components
- [EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md) - the self-attested exchange record this specification's governance fields and `retention_disposition` pointer feed into
- [PROTOCOL.md](spec/PROTOCOL.md) - how linkage terms parameterize the PSI protocol
- [COMMUNICATION.md](COMMUNICATION.md) - how `connection` fields map to channel infrastructure
- [DEPLOYMENT.md](DEPLOYMENT.md) - operating the supporting services referenced in `connection` fields
- [CLI.md](CLI.md) - CLI commands and configuration files that consume this specification
