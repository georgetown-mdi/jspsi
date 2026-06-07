---
title: "PSI-Link Security Design"
---

# PSI-Link security

This document covers the threat model, authentication design, and channel security for PSI-Link exchanges, and introduces the private set intersection (PSI) protocol on which the privacy guarantee rests at a conceptual level. It does not specify the PSI and PSI-C algorithms or the wire-level SPAKE2 protocol in detail (see [PROTOCOL.md](PROTOCOL.md)), the network channels over which exchanges run (see [COMMUNICATION.md](COMMUNICATION.md)), or CLI configuration for authentication (see [CLI.md](CLI.md)). Intended readers are security teams and compliance officers.

# Overview

PSI-Link protects an exchange with three independent layers:

1. **The PSI protocol protects the data itself.** Before any record leaves a participant's machine it is encrypted under that party's own ephemeral key, and the protocol then layers the partner's key on top, so each side only ever handles the other's records in a form it cannot decrypt. Neither side can recover the other's underlying values; both learn only which records the two of them hold in common. This is what makes the approach privacy-preserving regardless of which channel carries the traffic. See [Private set intersection](#private-set-intersection) below.

2. **PAKE authentication proves you are talking to the right partner.** For recurring exchanges the two parties hold a shared secret, established once out of band, and prove to each other that they both hold it without ever sending it over the wire. The secret is rotated after every successful exchange, so it is never reused. Authentication is a hard gate: if it fails, no data is exchanged. See [Authentication](#authentication).

3. **Transport encryption protects the data in transit.** The underlying channel - an SSH/SFTP connection, a WebRTC link, or a network-mounted share - encrypts traffic as it crosses the network. For zero-setup exchanges, which carry no shared secret, this transport layer is the sole protection, which is why trust there rests on whoever administers the server or share. See [Channel security](#channel-security).

A fourth layer - application-layer message encryption keyed from the PAKE session, so that even the operator of an SFTP server or shared drive would see only opaque ciphertext - is designed but not yet wired into the protocol. Its intended role is described under [Channel security](#channel-security).

The remainder of this document treats each layer in turn, beginning with the PSI protocol the other two are built to protect.

# Private set intersection

Private set intersection (PSI) is the cryptographic primitive the privacy guarantee rests on. It lets two parties compute the overlap between their datasets - the records they have in common - while revealing nothing about the records they do not.

The intuition is a layered, order-independent ("commutative") encryption. Each party holds an ephemeral key, generated fresh for the exchange and never shared. Each side encrypts its own linkage keys under its own key, and the protocol applies the partner's key as a second layer, so a record is only ever seen by the other party in a form that party cannot decrypt. Because the scheme is commutative, two values that started out equal remain equal once both keys have been applied, which is what lets the parties recognise shared records by comparing encrypted forms alone. Neither side can strip the other's key to recover a plaintext value, and records outside the intersection are never revealed.

PSI-Link uses a lightly modified build of OpenMined's [PSI](https://github.com/OpenMined/PSI) - which in turn layers over Google's Private Join and Compute - as this primitive. The base function is run repeatedly over a sequence of linkage keys to build the association map between matched records. A cardinality-only variant, PSI-C, reveals the size of the overlap without revealing which members are shared; it is designed but not yet implemented.

Two properties of the primitive are deliberately not hidden, and both are load-bearing for the threat model that follows:

- **Set sizes are revealed.** The base PSI function inherently leaks how many records each party holds. This is treated as acceptable for linking administrative data, where membership and identity are sensitive but the size of a database is not.
- **The result is only as private as the linkage keys.** Because each party learns the linkage key for every shared member, a weak key - for example one built from a single identifier - can leak membership through a differencing or brute-force attack. Combining several PII elements into each key is what keeps "you learn only the overlap" a meaningful guarantee.

The algorithm itself - role assignment, the encryption and key-removal steps, the matching cascade, and the PSI-C design - is specified in [PROTOCOL.md](PROTOCOL.md#psi-base-function). The two properties above are developed further in the [Threat model](#threat-model).

# Threat model

The system is designed to be utilized by partner agencies with signed data sharing agreements, and the primary goal of the security design is to prevent parties from learning anything about each other's data beyond the mapping between shared members. With that in mind, an honest-but-curious threat model has been adopted which assumes that partners are not actively tampering with inputs, but that it is still beneficial to minimize what is disclosed.

For each successive use of the base PSI function, information is revealed to each party. For PSI, this includes the key that links individual members. For PSI-C, the cardinality of that key can be learned. This implies that linkage keys could be chosen to reveal sensitive information through a differencing attack in order to reveal membership, so it is crucial that both parties review the linkage keys before agreeing to use them.

A malicious adversary cannot learn anything beyond what the PSI protocol reveals, but they can attempt a membership attack using specific inputs. For instance, if a statistical linkage key included only social security numbers, it would be easy to brute-force. To protect against this, it is recommended that keys combine multiple elements of personally identifiable information (PII). Even with complex linkage keys, membership attacks are still possible, but only if a target's PII is already known.

Separately from adversarial attacks, note that the PSI base function used inherently leaks the size of each parties' sets. This is considered acceptable for the use-case of linking administrative data, as it is individual membership and identifying information that is considered sensitive and not the size of the database.

When using public services to facilitate scheduled exchanges, some metadata around the exchange is leaked such as who is conducting the exchange and when. Parties are encouraged to stand up their own services when necessary and resources to facilitate this are available.

# Authentication

Before establishing connections, parties need to ensure that they are communicating with the correct partner. Recurring exchanges (see [User journey](DESIGN.md#user-journey)) use a pre-shared secret and a Password Authenticated Key Exchange (PAKE) for application-layer authentication. Zero-setup exchanges rely instead on transport-layer authentication.

## Recurring exchange authentication

In order to share secrets, one party generates a random cryptographic token using an available cryptography library and shares it with their partner using a trusted, existing communication channel such as secure email. At the start of the exchange, both parties must execute a PAKE protocol, such as SPAKE2 with the shared token as the password input.

The shared secret is automatically rotated after each successful authentication handshake, before the data exchange begins. Both parties independently derive the same replacement token from the SPAKE2 session key via HKDF - no extra round-trip is required. Each party is responsible for persisting the new token immediately after the handshake completes (the CLI writes it to the key file). If that write fails (for example, due to a disk error or clock skew that causes the post-handshake expiry check to fail on one side only), the two parties may hold different tokens; see [Out-of-sync tokens](CLI.md#out-of-sync-tokens) for recovery steps. If the data exchange subsequently fails, both parties already hold the rotated token and can retry without re-inviting. If a secret is lost after rotation, a new invitation can be generated from the existing configuration to re-establish a shared secret (see [Recovery](CLI.md#recovery)).

Tokens generated for invitations carry a bounded lifetime. A default expiration window of 1 hour is used if none is provided by the inviting party. Because the invitation token is rotated on first use, it functions as a one-time setup credential: its window of validity is the period between generation and acceptance. Replacement tokens generated by rotation carry no expiration by default, making them suitable for recurring scheduled exchanges without further coordination.

The wire-level SPAKE2 specification — blinding points, message encoding, key derivation, and interoperability notes — is in [PROTOCOL.md](PROTOCOL.md#spake2-authentication-protocol).

### Token format and entropy

Tokens are base64url-encoded 32-byte values. Invitation tokens are generated using `crypto.getRandomValues`, giving 256 bits of entropy. Rotation tokens are derived from the 32-byte SPAKE2 session key Ke via HKDF-SHA-256 (info string `"psilink-token-rotation-v1"`, output 32 bytes) and carry the same 256-bit security level as the underlying session key.

### Invitation contents and confidentiality

An invitation carries the linkage terms and the short-lived PAKE setup token, and it may also carry a connection endpoint: a public locator (a PeerJS signaling URL, an SFTP host and port, or a file-drop directory) that tells the acceptor where to rendezvous. A locator of this kind is not a secret -- it names a meeting point, not a means of authenticating at it -- so embedding it does not weaken the invitation. The credential-free property is enforced by the schema: the endpoint has no field for a password, private key, key file, or PeerJS API key, and an invitation carrying any such field is rejected when decoded. Connection credentials are therefore never transmitted in an invitation; each party configures its own. By the same token, the endpoint carries no server-identity material (an SSH host-key fingerprint, for example): how a party authenticates the server it reaches is unchanged by the hint and continues to rest on the transport layer and the server administrator, as described under [Transport-layer authentication](#transport-layer-authentication).

The invitation must nonetheless be treated as confidential, because it carries the PAKE setup token -- the established secret an attacker needs to authenticate as you. This is sharpened by the web rendezvous flow, in which both parties derive the coordination-server rendezvous id deterministically from that shared token. An attacker who obtains the invitation therefore learns both the authentication secret and the rendezvous id, and could reach the meeting point first to mount a man-in-the-middle attack before the intended partner arrives. This is the standard out-of-band-channel trust model: the security of the exchange rests on the invitation reaching only its intended recipient. Forward invitations only over a trusted channel (for example, secure email), and treat a leaked invitation as a compromise -- generate a fresh one (see [Recovery](CLI.md#recovery)) rather than reuse it.

## Transport-layer authentication

Transport-layer authentication is the defined path for zero-setup exchanges only. It is not an option for recurring exchanges: the `exchange` command requires a key file (`.psilink.key`) and will abort if one is absent.

For zero-setup exchanges, parties rely on transport-layer authentication (DTLS for WebRTC, SSH for SFTP, and commonly SMB or krb5p for file-drops). For an SFTP connection or a network-mounted file-drop, user and path management on the server-side limit who is able to listen in. This offloads trust to the server's administrator to ensure that the directory is specific to the exchange and cannot be accessed by other users. This method may be preferable if managing an additional encryption key is perceived as too burdensome, even though it is less secure overall. Users who wish to establish a persistent shared secret are encouraged to bootstrap one (see [Bootstrapping a shared secret](#bootstrapping-a-shared-secret)).

## Bootstrapping a shared secret

Parties wishing to transition from a zero-setup exchange to a recurring exchange may save the parameters from the zero-setup invocation (see [Zero-setup exchange](CLI.md#zero-setup-exchange)). Because this intent affects key generation, each party advertises it to the other at the start of the exchange.

| Party A | Party B | Outcome                                                                                                                                                                     |
| ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _save_  | _save_  | Initiator generates a fresh shared secret and transmits it to both; both save it as the basis for future recurring exchanges. Both also save their configuration files.     |
| _save_  | _none_  | No secret generated. A's configuration is saved; A is notified that their partner did not also choose to save and instructed to invite B to establish a recurring exchange. |
| _none_  | _none_  | Standard zero-setup exchange; no configuration is saved.                                                                                                                    |

The party that did not signal an intent to save the exchange parameters is notified that their partner is trying to establish a recurring exchange, that nothing is being saved on their end, and that they can either wait for an invitation from their partner or coordinate to run the exchange again and save the parameters.

# Key file security

`.psilink.key` contains the PAKE token that authenticates recurring exchanges. It must be treated as a credential with the same care as a private key or password.

## Required permissions

**Unix**: The CLI writes `.psilink.key` with mode `0600` (owner-read-only). If an existing key file has any group or world permission bits set (i.e. `mode & 0o077` is non-zero), the CLI emits a warning on load. Correct the permissions before running further exchanges:

```sh
chmod 0600 .psilink.key
```

**Windows**: The CLI enforces ACLs on write: it creates an empty placeholder file, narrows its ACL with `icacls /inheritance:r /grant:r` to grant Modify (`M`) to the current user only, then writes the token into the already-protected file. This ensures the token is never on disk while the file still carries inherited ACEs (e.g. the default `BUILTIN\Users` read). If the `icacls` call fails (for example in a restricted container environment), the placeholder is deleted and an error is raised; no key material is written.

On load, the CLI first attempts to use PowerShell's `Get-Acl` with SID translation, which checks both inherited and explicit ACEs in a locale-independent way; SYSTEM (`S-1-5-18`) and Administrators (`S-1-5-32-544`) are not flagged. If PowerShell is unavailable -- for example in Nano Server containers or environments with strict application control policies -- the CLI falls back to `icacls`, which checks only explicit (non-inherited) non-owner ACEs. `fs.statSync` is not used for either check because it returns simulated POSIX mode bits that do not reflect the actual ACL. To correct over-permissive ACLs:

```cmd
icacls .psilink.key /inheritance:r /grant:r "%USERDOMAIN%\%USERNAME%":(M)
```

`%USERDOMAIN%\%USERNAME%` produces the domain-qualified name (e.g. `CORP\alice` or `COMPUTER\alice`) that `icacls` requires to resolve domain accounts unambiguously. This matches the value the CLI obtains internally via `whoami`. On a standalone (non-domain) machine `%USERDOMAIN%` equals the computer name, which is correct.

## What not to do

- Never commit `.psilink.key` to version control. Add it to `.gitignore`:
  ```
  /.psilink.key
  ```
- Never transmit the token over an unencrypted channel. If the token must be
  copied between machines, use an encrypted transfer (for example, `scp`,
  SFTP, or a secrets manager API).
- Never log or display the token value in plaintext. Avoid including
  `--key-file` content in bug reports or support tickets.
- Never store the token in environment variables that are visible to child
  processes or appear in process listings.

## Backup

Tokens may be backed up to a secrets manager or encrypted store (for example, HashiCorp Vault, AWS Secrets Manager, or an encrypted filesystem). Any backup must carry the same access restrictions as the original file: owner-read-only or the equivalent ACL. If no backup exists and a token is lost, re-invitation is the correct recovery path (see [Recovery](CLI.md#recovery)).

## Compromise response

If a token is believed compromised -- for example, it was observed in a log, a process listing, a shared filesystem, or in transit on an unencrypted channel -- treat it as invalid immediately and take the following steps:

1. Notify the partner out-of-band before any further exchanges are attempted; the partner's copy may also have been exposed.
2. Both parties delete their key files (`.psilink.key` on each side).
3. Re-invite over a channel known to be uncompromised. An observed token remains valid until the next successful exchange rotates it out, so the window between observation and deletion must be closed as quickly as possible.

## Token age and rotation policy

Tokens are rotated automatically on every successful exchange. There is no system-enforced maximum age. Organizations with their own key-rotation policies should treat each exchange as the rotation event.

If an exchange partnership goes dormant for an extended period, organizations may choose to establish a local policy that triggers re-invitation after a maximum idle interval (for example, 90 days without a successful exchange). This is a deployment policy decision and is not enforced by the CLI.

# Channel security

As noted in [Transport-layer authentication](#transport-layer-authentication), server administrators have visibility into exchanges conducted over SFTP and file-drops. Today the protection on these channels is the transport layer itself (SSH for SFTP; the operator's access controls for file-drops). An additional application-layer of encryption is designed to close that visibility for PAKE-authenticated, recurring exchanges, but it is not yet wired into the protocol and is not active in current releases. As designed, both parties would use the HMAC-based Extract-and-Expand Key Derivation Function (HKDF) to derive AES-GCM keys from the PAKE session key, one for each direction so that every key has a single sender, and messages would be encrypted using Authenticated Encryption with Associated Data (AEAD) ciphers. Each message would carry a per-direction sequence number as its nonce, preventing replay and reordering. The separate per-direction keys are what keep that nonce construction safe: both directions number their messages from zero, so a single shared key would encrypt two different messages under the same key and nonce - a reuse that is catastrophic for AES-GCM - whereas one key per sender keeps every key-nonce pair unique. The server admin would then see only opaque ciphertext files, and tampering with a file would cause the authentication tag to fail and the exchange to abort.

The concrete envelope the `EncryptedMessageConnection` decorator emits is `{ enc: base64url(IV || ciphertext || 16-byte GCM tag) }`, where the 12-byte IV is four leading zero bytes (authenticated, but not separately validated) followed by the 8-byte big-endian sequence number, and the encrypted plaintext is a one-byte type tag (`0` for a JSON object, `1` for a `Uint8Array`) ahead of the payload. This wire format is pinned byte-for-byte by a checked-in known-answer vector at [`packages/core/test/vectors/aead-envelope-vectors.json`](../packages/core/test/vectors/aead-envelope-vectors.json), following the cross-implementation vector precedent of `canonical-vectors.json` and `exchange-record-vectors.json`: each vector fixes a session key, role, sequence number, and plaintext and records the exact serialized `enc` string, so an independent implementation can reproduce it from those inputs and any change to the nonce construction, byte order, envelope shape, or tagging is caught. The vectors are asserted against the decorator in `packages/core/test/encryptedMessageConnection.test.ts`, which separately pins the per-direction HKDF key derivation (`deriveAeadKey`).

The envelope binds no Associated Data (AAD), and this is a deliberate, recorded decision rather than an omission. AAD would matter only to stop a frame authenticated under one context (role/direction, session, or transcript) from being spliced or replayed into a different context that shares the same key. Here every such context is already separated below the AAD layer by a distinct key. Direction is bound by the key: each direction uses its own AES-GCM key, derived with a distinct HKDF info string (`psilink-aead-v1:initiator-to-responder` versus `...responder-to-initiator`), so a frame presented to the opposite direction decrypts under the wrong key and the tag fails. Session is bound by the key: both keys derive from the per-session SPAKE2 session key, which is transcript-bound and mixes in each run's random ephemeral scalars, so it is distinct even across two runs of the same PAKE token - a frame from one session decrypts under the wrong key in another. Ordering within a single direction of a single session is bound by the sequence-number nonce and the strict-increasing replay guard. The only set of frames that share one AEAD key is those one sender emits in one direction of one session, and the decorator carries exactly one logical stream there - it does not multiplex sub-channels or protocol phases, and the one-byte payload type tag that distinguishes binary from JSON lives inside the authenticated plaintext. There is therefore no second logical context under a shared key for AAD to separate, so binding the direction (or a session id) as AAD would only restate what the key already enforces. The sequence number is the GCM nonce, not a substitute for AAD: the reason AAD is unnecessary is the absence of a second context under one key, not that the nonce stands in for AAD. Practically, the decorator holds only its inner connection, the session key, and the role - no session or transcript id is in scope to bind without new plumbing that belongs to the not-yet-wired caller integration.

Revisit this decision if a future change multiplexes more than one logical stream or protocol phase over a single direction's key, or collapses the per-direction key split into one shared key. In either case a context or sub-stream id bound as AAD would stop being redundant: it would still block cross-direction splicing, though not the key-nonce reuse that collapsing the key split would itself make catastrophic (AAD does not protect against nonce reuse). Until then, the per-direction key plus the sequence nonce are sufficient and no AAD is bound.

When this layer is wired in, its AEAD/MAC and sequence-number (replay and ordering) checks must run at the protocol layer on the output of a `receive()` call, and must not be latched into the connection as a transport control (the `fail`/`finish` teardown signals) behind a buffered inbound frame. The message queue drains an already-received frame to the consumer ahead of any terminal error, whether the close was clean or abnormal (see [Message delivery and teardown](COMMUNICATION.md#message-delivery-and-teardown)), so a check wired as a transport-level latch could hand a suspect frame to the consumer before the integrity alarm fires. Nothing violates this today - transports raise only `transport` and `protocol` terminal errors, and no integrity check is latched behind a frame - so this records a constraint to preserve, not a current gap.

The sequence-number check rejects any number that is not strictly greater than the last accepted, which stops replay and reordering but not omission: a gap (a sequence number that skips ahead) is accepted, and a truncated tail is indistinguishable from a clean end. Completeness is therefore delegated to the inner transport and the lockstep protocol above, where a dropped frame surfaces as a stalled or schema-invalid exchange. Strict gap detection - rejecting anything that is not exactly the last accepted plus one - together with an integrity-protected end-of-stream marker for truncation is a planned follow-up, deferred from the initial AEAD port and tracked on the project board. It is blocked on the send path advancing its counter only on a fully successful send (otherwise a legitimate sender-side gap, from a failed transport send or a serialization error, would raise a false tamper alarm), and as net-new security behavior it requires explicit security review; the end-of-stream-marker design will be recorded here when it is built.

WebRTC connections use DTLS which provides end-to-end encryption, so the peer-coordination server never sees data-channel traffic. A TURN relay, when used to traverse NAT or firewall restrictions, preserves this property: it forwards encrypted DTLS packets without terminating the session.

A WebSocket relay is a distinct and rarer fallback that arises when a firewall blocks TURN through deep-packet inspection of the DTLS handshake. Unlike a TURN relay, a WebSocket relay terminates DTLS and sees plaintext. When a WebSocket relay is in use, the exchange policy follows its authentication state:

- If PAKE authentication is active (a recurring exchange), the exchange proceeds with the application-layer AEAD encryption described above (the same mechanism planned for SFTP and file-drop channels).
- If PAKE is absent (a zero-setup exchange), the exchange aborts. Application-layer encryption cannot be applied without a shared session key, and proceeding without transport protection would expose data to the relay.

Zero-setup WebRTC is already constrained in practice: it requires a peer-coordination server accessible to both parties, which is an uncommon deployment. The WebSocket relay scenario therefore applies almost exclusively to recurring exchanges, where PAKE is always active. (This policy will be enforced when WebSocket relay support is added; relays are not yet a supported transport option.)

# Data handling

PSI-Link does not transmit, log, or retain any personally identifiable information (PII) outside of the configured output file.

**Protocol messages**: All data exchanged between parties during the PSI protocol consists of cryptographic protocol messages - elliptic-curve points, to be wrapped in AEAD ciphertext once the planned application-layer encryption is in place (see [Channel security](#channel-security)). Raw PII values are never sent to a partner in any form. The PSI protocol's privacy guarantee ensures that each party learns only the existence of shared members; records not in the intersection are not revealed to the other party.

**Third parties**: No PII is transmitted to any third party. The peer-coordination server used by the web application's WebRTC channel sees only connection metadata (peer IDs); it has no visibility into data-channel traffic (see [Channel security](#channel-security)). SFTP and filedrop channels use operator-managed infrastructure.

**Logging**: PSI-Link does not write PII to log output. Any operational log output is limited to non-sensitive metadata: exchange timing, transport errors, and protocol state transitions. Log output should be reviewed before forwarding to a third-party logging service.

**Output**: The exchange output is an association table of row indices mapping each party's matched records. It does not contain raw PII fields from the input file. Parties are responsible for joining those indices against their own datasets and handling the resulting joined data under their applicable data governance policies.

# Regulatory compliance

The NIST SP 800-53 Rev 5 control mapping and Section 508 accessibility status for PSI-Link are documented in [COMPLIANCE.md](COMPLIANCE.md).

## See also

- [PROTOCOL.md](PROTOCOL.md) - the PSI protocol and SPAKE2 wire-level protocol specification
- [COMMUNICATION.md](COMMUNICATION.md) - the network channels whose security properties are described here
- [CLI.md](CLI.md) - CLI commands for the invitation and authentication flow
- [EXCHANGE_SPEC.md](EXCHANGE_SPEC.md) - `connection` block reference for configuring authentication
- [COMPLIANCE.md](COMPLIANCE.md) - regulatory control mapping, NIST SP 800-53, and Section 508 status
