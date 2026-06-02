---
title: "Exchange Specification Reference"
---

# Exchange specification reference

This document is the complete field-level reference for PSI-Link exchange specifications. It covers all fields in the four components - linkage terms, connection, metadata, and data standardization - including types, valid values, consistency rules, and examples. It does not cover how the PSI protocol uses these parameters (see [PROTOCOL.md](PROTOCOL.md)), the threat model or authentication design (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md)), or the CLI commands that consume this file (see [CLI.md](CLI.md)). Intended for anyone configuring an exchange.

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

Fields that support this convention are marked "`@`-file recommended" in their descriptions. It does not apply to free-text or structured fields such as `linkage_terms.identity`, where `@` may appear as a literal character.

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

A free-text string identifying the party holding these terms. Included verbatim in the non-repudiation receipt (receipts are a planned 1.0 feature and are not yet implemented; see [ROADMAP.md](ROADMAP.md)). Parties may format this however they wish; common contents include name, organization, and contact information.

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
      type: firstName
      constraints:
        affixes_allowed: false
        allowed_characters: 'A-Z '
    - name: first_name_raw
      type: firstName
    - name: last_name
      type: lastName
      constraints:
        affixes_allowed: false
        allowed_characters: 'A-Z '
    - name: date_of_birth
      type: dateOfBirth
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
| `firstName` | Given name |
| `lastName` | Family name |
| `dateOfBirth` | Date of birth |
| `phoneNumber` | Phone number |
| `emailAddress` | Email address |

Additional types will be added as their use case arises.

#### Constraints

| Field | Type | Applies to | Description |
|-------|------|------------|-------------|
| `valid_only` | boolean | `ssn`, `ssn4` | Data must conform to Social Security Administration [rules](https://www.ssa.gov/kc/SSAFactSheet--IssuingSSNs.pdf) for valid SSNs |
| `valid_only` | boolean | `dateOfBirth` | Must be a valid date |
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

The name of each linkage key must be unique. The elements within any linkage must either reference a unique linkage field or have an alias that is unique.

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
| `generate_fuzzy_comparisons` | string | no | Method for generating additional values for fuzzy matching: `transpositions` generates all two-digit transpositions; `editDistances` generates all single-character deletions up to `max_length`, matching values within one edit distance; `adjacentYears` generates dates +/- 1 year from the input. Applied after any transformation |

#### Transform steps

Each step in a `transform` array applies one function from the cleaning and standardizing function library. Steps are applied in order.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `function` | string | yes | Name of the function to apply (see Available functions in the [Data standardization](#data-standardizing-transformations) section) |
| `params` | object | no | Function-specific parameters |

#### Swapped keys

When a `swap` array is present, the receiver transmits a linkage key generated with the two named elements swapped, while the sender generates a linkage key with un-swapped elements. Element names are matched first against element `name` values, then against `field` names. For example, a key might match first name swapped with last name to catch data entry errors where the names are reversed at one agency.

### `linkage_terms.legal_agreement`

*Type:* object  
*Required:* no  
*Consistency:* mandatory if present

Reference to the legal data sharing agreement authorizing this exchange. If `expiration_date` has passed, the exchange fails before any data is transmitted.

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

---

## Connection

Specifies the communication channel, server addresses, and authentication material.

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
*Required:* yes (filedrop only)  
*Applies to:* `filedrop`

Absolute path to the shared directory on the local filesystem. Both parties must be able to read and write files in this directory. Use `file://` URLs with the CLI for zero-setup exchanges.

```yaml
connection:
  channel: filedrop
  path: /mnt/sftp-share/exchanges/agency-a-agency-b
```

### `connection.server`

*Type:* object  
*Required:* yes (webrtc and sftp only)  
*Applies to:* `webrtc`, `sftp`

The primary server for the exchange. For WebRTC this is the PeerJS peer coordination server; for SFTP this is the SFTP host. A URL may be supplied as a convenience and will be decomposed into its component fields; the component fields are the authoritative form.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | yes | Hostname or IP address |
| `port` | integer | no | Port number; defaults to the protocol standard (443 for HTTPS/WSS, 22 for SFTP) |
| `path` | string | no | URL path for WebRTC signaling; remote working directory for SFTP |
| `username` | string | no | Username for server authentication |
| `key` | string | WebRTC only | PeerJS API key for private PeerJS servers; omit when using a public server |

#### SFTP server authentication

SFTP requires at most one primary authentication method alongside `username`. `private_key_passphrase` and `certificate` are companions to `private_key` and are invalid without it.

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

# File-drop example (network-mounted folder)
connection:
  channel: filedrop
  path: /mnt/sftp-share/exchanges/agency-a-agency-b
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

### `connection.authentication`

*Type:* object  
*Required:* no (see note below) 
*Applies to:* `webrtc`, `sftp`, `filedrop`

Authentication settings for the exchange. What belongs in `psilink.yaml` depends on the channel:

- **`webrtc`**: set `role` to identify the inviter and acceptor.
- **`sftp` and `filedrop`**: no fields are user-settable here.

The PAKE token and its expiration are loaded from a key file and added to the in-memory representation before the exchange runs; they never appear in `psilink.yaml` and should not be edited manually. If `pake_token`, `pakeToken`, or `expires` are present in the configuration file, the CLI will emit a warning and ignore them; values from the key file always take precedence.

`pakeToken` is required for recurring exchanges run via the `exchange` command. If the key file (`.psilink.key`) is absent, the CLI aborts before any connection is attempted. Zero-setup exchanges (the `zero-setup` command) rely on transport-layer authentication instead and do not use a key file.

Taken together, this implies that `connection.authentication` is never required in a configuration file. It is required for in-memory objects used for recurring exchanges, and it is optional for zero-setup exchanges.

The PAKE token is automatically rotated after each successful authentication handshake: both parties independently derive the replacement from the SPAKE2 session key using HKDF, so no extra round-trip is required. The CLI persists the new token automatically; library consumers of `authenticateConnection` are responsible for persisting `newToken` from the returned `AuthResult` to their own storage. If the exchange fails before a successful handshake, the existing token remains valid. If the handshake succeeds but the data exchange subsequently fails, both parties already hold the rotated token and can retry without re-inviting. If the handshake succeeds but the new token cannot be persisted (e.g., a disk-write error), both parties may be out of sync: the partner may already hold the rotated token, making the old token invalid. In that case both parties must re-invite. Invitation tokens carry a default expiration of 1 hour; persistent tokens carry none.

| Field | Type | In `psilink.yaml` | Description |
|-------|------|-------------------|-------------|
| `pake_token` | string | never; loaded from `.psilink.key` | PAKE shared secret; a base64url-encoded 32-byte value (43 characters). Do not set manually. |
| `expires` | string (ISO 8601) | never; loaded from `.psilink.key` | Expiration of `pake_token`; absent for persistent tokens. Do not set manually. |
| `role` | enum | WebRTC only | `inviter` \| `acceptor`; used to derive deterministic PeerJS peer IDs from the shared token so both parties know each other's address without out-of-band communication. Orthogonal to the PSI protocol roles, which are determined by `linkage_terms.output`. For `sftp` and `filedrop` this field is not part of the schema; the CLI emits a warning and strips it before validation. |

Any other key under `connection.authentication` is also stripped before validation. The CLI emits a warning naming the field. The Zod schema itself silently strips unknown keys (its default `strip` behavior), so a library consumer that bypasses the CLI's pre-validation pass will not see a warning for unknown fields - they are dropped without comment.

```yaml
connection:
  authentication:
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
      username: "@/run/secrets/twilio_sid"
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
| `peer_timeout_ms` | integer | 3600000 | Milliseconds to wait for the partner at any single step before giving up, applied both to the initial rendezvous and to each message exchanged during the protocol; if the partner goes silent past this window the exchange fails with a transport error. The effective limit is the minimum of this and the remaining PAKE token lifetime. |
| `server_connect_timeout_ms` | integer | 30000 | Milliseconds to wait during each connection attempt to the primary exchange server |
| `max_reconnect_attempts` | integer | 3 | Maximum number of times to attempt reopening a dropped connection before giving up |

#### SFTP and file-drop options

These options apply to both `sftp` and `filedrop` channels.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `poll_interval_ms` | integer | 100 | Milliseconds between checks for the partner's uploaded file. The default is tuned for local-network mounts and CI; raise it (for example, to 1000-5000 ms) for public SFTP servers to reduce request load. |
| `timestamp_in_filename` | boolean | false | When `true`, each outgoing message filename also encodes a UTC timestamp and a per-session sequence number (see [Message filenames](#message-filenames)). Useful for filename-based logging in sync-mediated environments where the sync tool stamps files with the transfer time rather than the original creation time. |
| `lockless_rendezvous` | boolean | false | When `true`, the rendezvous handshake uses an ack-handshake barrier (`<id>-hello.json` + `<id>-hello-ack.json`) instead of the default atomic wave-file race (`<id>-hello.json` + `<id1>-<id2>.wave`). Required on sync-mediated transports that lack atomic exclusive-create or deletion visibility during rendezvous (e.g. a cloud sync service reconciling two local mirrors where both sides "win" a local create). Both parties must set this identically; a mismatch causes rendezvous to time out. The operational sync glob in lockless mode is `<myId>-*` (upload) / `<partnerId>-*` (download), which covers hello, ack, and message files while excluding in-flight `temp-*.tmp` writes. |
| `peer_id` | string | — | A stable, human-readable identifier for this party. Appears in every filename this party writes (hello, message, ack) and in server-side logs and transcripts. When unset, a UUID is generated at construction time. Requires `timestamp_in_filename: true`; a reused stable id without a timestamp segment can collide with a leftover file from a crashed prior session. The two parties must use distinct ids, and neither may be the other's id extended by `-` (e.g. `"site"` and `"site-2"` are rejected at rendezvous; see [FILE_SYNC.md preconditions](FILE_SYNC.md#preconditions-for-a-correct-exchange)). Spaces and `-` are permitted within a `peer_id`. The value `"temp"` is reserved. Filesystem-unsafe characters (`/` and NUL on all platforms; `<`, `>`, `:`, `"`, `\`, `|`, `?`, `*` on Windows NTFS) are not validated but may cause errors at the transport layer. |
| `retain_files` | boolean | false | When `true`, the receiver writes a `receipt` control file after consuming each message rather than deleting it; the sender gates its next write on observing that receipt rather than on the message file disappearing. No exchange file is deleted as a protocol step; the shared directory becomes a permanent transcript. Requires `timestamp_in_filename: true` -- without it, every message from the same party would share a filename and a retained transcript would overwrite itself. Both parties must set this flag identically; a mismatch causes the exchange to stall until the peer timeout fires. **A fresh directory is required for each exchange and is enforced**: `synchronize()` throws a `UsageError` if any message or receipt files from a prior session are present; otherwise a stale message would be mis-consumed against the per-session sequence counter and a stale receipt could prematurely release the sender. See [Receipt files](#receipt-files). |

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

In-flight writes use a temporary `.tmp` file that is renamed to the final `.json` name only once the write completes, so a sync tool watching `*.json` never observes a partial file under its final name. Handshake files (`<id>-hello.json`, `<id1>-<id2>.wave`, `<id>-hello-ack.json`) are separate from message files and are documented in [PROTOCOL.md](PROTOCOL.md).

#### Receipt files

When `retain_files: true`, the receiver writes a receipt file immediately after validating each message and before emitting it to the application layer. The receipt filename follows the same right-anchored byte-count convention as message files, but its terminal segment is the type word `receipt` (not a digit string), so it is never mistaken for a message:

```
<receiverId>-<YYYYMMDDTHHMMSS>-<NNN>-<byteCount>-receipt.json
```

`<NNN>` copies the consumed message's sequence counter. `<byteCount>` is the exact on-disk size of the receipt body, enabling the same partial-sync safety gate (I5) used for messages: the sender reads the file size from the directory listing and waits until it matches the declared count before treating the receipt as valid.

The receiver never deletes the consumed message file. The message and its receipt both persist, and the directory accumulates one of each per exchanged message on every transport -- including those, such as SFTP, that do support deletion. This is what makes the directory a durable transcript rather than only a workaround for transports that cannot propagate deletions.

In `retain_files` mode `close()` does not delete exchange files; the directory is the transcript. The only file ever removed is an in-flight `temp-*.tmp` write, which is cleaned up inline on error.

The transcript accumulates with no in-protocol cleanup; retention, rotation, and archival are out-of-band operator responsibilities.

#### Directory exclusivity

The shared directory (SFTP path or local filedrop path) must be **dedicated exclusively** to a single active exchange between exactly two parties. Both channels treat the directory as a private communication channel: each party reads and deletes files written by the other, and the rendezvous protocol uses filename presence as a synchronization signal.

A third process writing `<id>-hello.json`, `<id1>-<id2>.wave`, `<id>-hello-ack.json`, or `<id>-*.json` files into the same path during an active session will cause the exchange to abort with a diagnostic error. Separate concurrent exchanges must use separate directories.

#### Filename grammar

Every protocol file on `sftp` and `filedrop` channels is named `<id>-...-<token>.json`, where `<token>` is the final `-`-delimited segment before `.json`:

- If `<token>` is all digits, the file is a **message** and `<token>` is its declared byte count. Parsing is right-anchored so a party id containing hyphens does not affect extraction.
- Otherwise `<token>` is a **type word** naming the file kind: `hello` (rendezvous hello), `ack` (lockless-mode handshake ack), `receipt` (retain-mode read receipt). A typed file is never read as a message; the receiver's message scan ignores any file whose terminal segment is non-numeric.

The receiver only reads files whose on-disk size matches the declared byte count, so a partially synced message file is never consumed prematurely.

### `connection.provider_options`

*Type:* object  
*Required:* no

An opaque key-value map passed verbatim to the underlying transport library. Keys and values are defined by the package providing the connection implementation. `@`-file pathing is supported here as well.

---

## Input metadata

Optional field-level descriptions of the input dataset. If omitted, semantic types are inferred from column names. If no identifier columns are specified, output row indices reference positions in the input file.

```yaml
metadata:
  columns:
    - name: "LAST_NAME"
      type: lastName
      role: linkage
      description: "Legal last name as recorded at enrollment"
    - name: "DOB"
      type: dateOfBirth
      role: linkage
    - name: "CLIENT_ID"
      role: identifier
      description: "Internal client identifier"
    - name: "PROGRAM_START_DATE"
      role: payload
      description: "Date client enrolled in the program"
    - name: "COUNTY"
      role: payload
```

### Column fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Column name in the input CSV |
| `type` | string | no | Semantic type (see [Semantic Types](#semantic-types) above); inferred from name if omitted |
| `role` | enum | no | `linkage`, `identifier`, or `payload`; inferred if omitted |
| `is_payload` | boolean | no | Whether this column is transmitted as payload data after the intersection is identified; defaults to `true` when `role` is `payload`, `false` otherwise |
| `description` | string | no | Human-readable description; shared with partner for payload columns |

`role` and `is_payload` are partially independent. A column used for linkage or as an identifier can also carry `is_payload: true`, meaning it participates in the PSI protocol *and* is transmitted as payload for matched members. For example, a phone-number column can have `role: linkage` and `is_payload: true` so that it both links records and is delivered to the partner for matched rows. Any column that is not used for linkage or identification must have `is_payload: true`; the application will treat such a column as `role: payload` if no role is specified.

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
| `remove_accents` | Remove accents and other diacritics, ASCII-ifying the text | — |
| `remove_affixes` | Remove name titles (Mr., Dr., ...) (and suffixes (Jr., III, ...) | — |
| `substring` | Extract a substring | `start` (1-indexed, required; negative counts from end), `length` (required) |
| `parse_date` | Reformat a date string | `input_format` (default `MM/DD/YYYY`), `output_format` (default `YYYYMMDD`); tokens: `YYYY`, `MM`, `DD` |
| `pad_left` | Left-pad the value with a fill character up to a target length; pass-through if already at or above the length | `length` (positive integer, required), `char` (single character, default `"0"`) |
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

> **Not yet implemented:** `split_on` (and fan-out generally) is not yet fully implemented; see [Fan-out (multi-value fields)](#fan-out-multi-value-fields) and [ROADMAP.md](ROADMAP.md).

| Function | Description | Parameters |
|----------|-------------|------------|
| `split_on` | Split the value on a regex delimiter, producing `Set<string>` | `delimiter` (regex pattern, required), `include_original` (boolean, default `false`) |

When `split_on` finds no delimiter the value is returned unchanged as a single-element list. When `include_original` is `true` the unsplit value is prepended to the parts.

Steps following `split_on` are applied element-wise across all parts. Null-producing steps filter individual elements; if all elements are filtered the field becomes `null` and `coalesce` may recover it.

---

## Full example

An end-to-end annotated specification covering every component is planned. It will be produced by exporting from the web application's configuration GUI once that is wired up; see [ROADMAP.md](ROADMAP.md). Until then, the per-section snippets above are the working reference.

## See also

- [DESIGN.md](DESIGN.md) - overview of exchange specification purpose and its four components
- [PROTOCOL.md](PROTOCOL.md) - how linkage terms parameterize the PSI protocol
- [COMMUNICATION.md](COMMUNICATION.md) - how `connection` fields map to channel infrastructure
- [DEPLOYMENT.md](DEPLOYMENT.md) - operating the supporting services referenced in `connection` fields
- [CLI.md](CLI.md) - CLI commands and configuration files that consume this specification
