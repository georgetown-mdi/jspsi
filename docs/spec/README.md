---
title: "PSI-Link Specification Tier"
---

# PSI-Link technical specifications

This directory is the **technical specification tier** of the PSI-Link
documentation. The documents here are written for implementors and security
auditors: they cover wire formats, byte encodings, normative constant values,
protocol internals, and implementation-level design. The overview tier in
[`docs/`](../) (one level up) stays conceptual and operational, for program
officers, security reviewers, compliance officers, IT staff, and new
contributors.

A document in this tier always has an overview-tier counterpart it complements,
and each states the split in its intro: the overview says what a control or
format is for and what it protects against; the spec says how it is constructed.

## Index

| File | Scope | Audience | Does not cover |
| ---- | ----- | -------- | -------------- |
| [PROTOCOL.md](PROTOCOL.md) | The PSI and PSI-C algorithms, their composition into a record linkage, and the wire-level X25519 authenticated key exchange (construction, key schedule, message encoding). Also the **Self-attested record** subsection: where the record sits in the exchange protocol. | Security auditors, external implementors, developers | The exchange-agreement format (see [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md)); the threat model and authentication design (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md)); the network layer (see [COMMUNICATION.md](../COMMUNICATION.md)) |
| [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md) | The application-layer AEAD envelope and per-direction key derivation, the inbound integrity/replay/ordering checks, the file-sync memory and liveness bounds, the bundled PeerJS signaling server's upgrade-surface bounds (inbound frame size, handshake timeouts, the liveness reaper, and the relay queue bounds), and the application-layer bounds on partner-parsed input -- collection counts, the linear-time regex dialect that transform patterns (raw patterns and the one `parse_date` expands from its format) execute under, and the caps on the transform-param values that drive unbounded per-row work (`pad_left` `length`, `parse_date` formats, raw pattern length) -- with their derived constant values, the SFTP fatal-packet crash safety, and the authenticated abort marker. | Security auditors, implementors | What each control protects against and why it is sufficient -- that is the **Channel security** overview in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security); the SFTP-stack upgrade checklist (see [CONTRIBUTING.md](../../CONTRIBUTING.md#upgrading-the-sftp-stack-ssh2--ssh2-sftp-client)) |
| [FILE_SYNC.md](FILE_SYNC.md) | The file-sync transport state machine: the directory-as-state-machine, the filename taxonomy, the enforcement sites, the invariants, and the exchange preconditions for the `sftp` and `filedrop` channels. | Developers, designers | The user-facing configuration reference and the normative filename **grammar** (see [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md) -- see the tier-inversion note below); the channel/synchronization overview (see [COMMUNICATION.md](../COMMUNICATION.md)) |
| [COMMUNICATION.md](COMMUNICATION.md) | The transport-contract complement to the communication overview: the deferred-decision rationale for the core library's terminal `ConnectionErrorKind` taxonomy. | Developers extending the transport layer | The channels, synchronization, message-delivery contract, and supporting services (see [COMMUNICATION.md](../COMMUNICATION.md)) |
| [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md) | The self-attested exchange record **format**: the record and opening file shapes, the format version, the HMAC commitment scheme and agreed-terms hash, the governance metadata, the disclosure framing, and the record's privacy properties. | Security auditors, external implementors, compliance reviewers, developers | The PSI protocol that produces the exchange (see [PROTOCOL.md](PROTOCOL.md)); the exchange-agreement format that supplies the governance fields (see [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md)); the canonical byte encoding (see [CANONICAL_ENCODING.md](CANONICAL_ENCODING.md)) |
| [CANONICAL_ENCODING.md](CANONICAL_ENCODING.md) | The normative RFC 8785 (JCS) byte encoding the receipts, record commitments, and agreed-terms hash are computed over, with worked examples. Written so an independent implementation reproduces byte-identical output. | External implementors, security auditors | What the encoding is for and what it protects against -- that is the **Canonical encoding** overview in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#canonical-encoding); how receipts use these bytes (see [PROTOCOL.md](PROTOCOL.md#non-repudiation)); the record format (see [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md)) |

## Where does my content go?

> If you are writing a constant value, a byte/wire layout, an HKDF info string or
> other algorithm step, or a "would only need revisiting if..." design rationale,
> it belongs in `docs/spec/` - regardless of which doc you currently have open.
> Overview docs (`docs/`) stay conceptual and operational.

Within this tier, route by topic:

- **The PSI/PSI-C algorithm or the key-exchange wire format** -> [PROTOCOL.md](PROTOCOL.md).
- **The AEAD envelope, key derivation, or a transport memory/liveness bound** -> [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md).
- **The file-sync directory state machine, filename taxonomy, or enforcement sites** -> [FILE_SYNC.md](FILE_SYNC.md).
- **The exchange-record on-disk format or commitment scheme** -> [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md).
- **The canonical byte encoding any of the above commits over** -> [CANONICAL_ENCODING.md](CANONICAL_ENCODING.md).
- **A `ConnectionErrorKind` classification decision** -> [COMMUNICATION.md](COMMUNICATION.md).

### Two overlaps to disambiguate

- **Self-attested record: placement vs format.** Its *protocol placement* -- where it sits in the exchange and the receipt that will later sign it -- lives in [PROTOCOL.md](PROTOCOL.md) (the "Self-attested record" subsection). Its *on-disk format* -- file shapes, commitment scheme, governance metadata -- lives in [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md). Both are spec-tier, so there is no cross-tier break; open the format doc for the bytes and the protocol doc for the placement.
- **Channel security: construction vs key-exchange wire format.** The AEAD construction and the transport bounds are in [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md); the key-exchange wire format that produces the session key those keys derive from is in [PROTOCOL.md](PROTOCOL.md#x25519-authenticated-key-exchange).

### Tier-inversion note: the filename grammar

[FILE_SYNC.md](FILE_SYNC.md) is a spec-tier document, but the single normative
invariant its state machine rests on -- the filename **grammar** -- is owned by
the overview-tier [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md), because that
is the document an operator authoring a `psilink.yaml` opens. FILE_SYNC.md
therefore references *up* into the overview tier for its central invariant. This
is deliberate and recorded: do **not** "tidy" the filename grammar down into
`docs/spec/`. The grammar stays in EXCHANGE_REFERENCE.md (operators need it) and
FILE_SYNC.md defers to it; moving it would silently break FILE_SYNC's invariant
references.
