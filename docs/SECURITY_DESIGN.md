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

As noted in [Transport-layer authentication](#transport-layer-authentication), server administrators have visibility into exchanges conducted over SFTP and file-drops. Today the protection on these channels is the transport layer itself (SSH for SFTP; the operator's access controls for file-drops). An additional application-layer of encryption is designed to close that visibility for PAKE-authenticated, recurring exchanges, but it is not yet wired into the protocol and is not active in current releases. As designed, both parties would use the HMAC-based Extract-and-Expand Key Derivation Function (HKDF) to derive a common encryption key from the PAKE session key, and messages would be encrypted using Authenticated Encryption with Associated Data (AEAD) ciphers. Each message would include a sequence number as the nonce, preventing replay. The server admin would then see only opaque ciphertext files, and tampering with a file would cause the authentication tag to fail and the exchange to abort.

When this layer is wired in, its AEAD/MAC and sequence-number (replay and ordering) checks must run at the protocol layer on the output of a `receive()` call, and must not be latched into the connection as a transport control (the `fail`/`finish` teardown signals) behind a buffered inbound frame. The message queue drains an already-received frame to the consumer ahead of any terminal error, whether the close was clean or abnormal (see [Message delivery and teardown](COMMUNICATION.md#message-delivery-and-teardown)), so a check wired as a transport-level latch could hand a suspect frame to the consumer before the integrity alarm fires. Nothing violates this today - transports raise only `transport` and `protocol` terminal errors, and no integrity check is latched behind a frame - so this records a constraint to preserve, not a current gap.

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
