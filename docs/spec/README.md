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
(Two documents, [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md) and
[CONTAINER_IMAGES.md](CONTAINER_IMAGES.md), are deliberate exceptions -- see the
note below.)

## Index

| File | Scope | Audience | Does not cover |
| ---- | ----- | -------- | -------------- |
| [PROTOCOL.md](PROTOCOL.md) | The PSI and PSI-C algorithms, their composition into a record linkage, and the wire-level P-256 authenticated key exchange (construction, key schedule, message encoding). Also the **Self-attested record** subsection: where the record sits in the exchange protocol. | Security auditors, external implementors, developers | The exchange-agreement format (see [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md)); the threat model and authentication design (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md)); the network layer (see [COMMUNICATION.md](../COMMUNICATION.md)) |
| [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md) | The application-layer AEAD envelope and per-direction key derivation, the inbound integrity/replay/ordering checks, the file-sync memory and liveness bounds, the bundled PeerJS signaling server's upgrade-surface bounds (inbound frame size, handshake timeouts, the liveness reaper, and the relay queue bounds), and the application-layer bounds on partner-parsed input -- collection counts, the linear-time regex dialect that transform patterns (raw patterns and the one `parse_date` expands from its format) execute under, and the caps on the transform-param values that drive unbounded per-row work (`pad_left` `length`, `parse_date` formats, raw pattern length) -- with their derived constant values, the operator-local CSV-read single-line byte ceiling (the lone input bound with no adversary), the SFTP fatal-packet crash safety, and the authenticated abort marker. | Security auditors, implementors | What each control protects against and why it is sufficient -- that is the **Channel security** overview in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security); the SFTP-stack upgrade checklist (see [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md#upgrading-the-sftp-stack-ssh2--ssh2-sftp-client)) |
| [FILE_SYNC.md](FILE_SYNC.md) | The file-sync transport state machine: the directory-as-state-machine, the filename taxonomy, the enforcement sites, the invariants, and the exchange preconditions for the `sftp` and `filedrop` channels. | Developers, designers | The user-facing configuration reference and the normative filename **grammar** (see [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md) -- see the tier-inversion note below); the channel/synchronization overview (see [COMMUNICATION.md](../COMMUNICATION.md)) |
| [WEBRTC_TRANSPORT.md](WEBRTC_TRANSPORT.md) | The `webrtc` channel's wire, which two implementations (the browser's PeerJS client and the CLI's direct-werift transport) must match exactly: the rendezvous roles and the handshake role each fixes, the broker socket URL and the defaults an omitted `server` field takes, the OFFER/ANSWER/CANDIDATE payload shapes, the BinaryPack chunk envelope and close sentinel, what a clean close must wait on before tearing down, the ICE list-replaces-default rule, and the transport's budgets. | Implementors of either end, security auditors | The rendezvous peer-id derivation itself (see [PROTOCOL.md](PROTOCOL.md#webrtc-rendezvous-peer-id-derivation)); the inbound reassembly bound and the AEAD envelope (see [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md)); the library choice and the alternatives weighed (see [cli-webrtc-stack.md](../notes/cli-webrtc-stack.md)); the operator-facing configuration (see [CLI.md](../CLI.md#webrtc-exchanges)) |
| [CLI_EVENTS.md](CLI_EVENTS.md) | The CLI's opt-in machine-interface event stream (`--event-stream`): the fixed file descriptor, the NDJSON framing and per-line schema version, every event type and its fields, the four terminal-error categories and their classification rules, the security marker, the single-terminal-event guarantees, and the per-field sanitization. | Implementors of a supervising process, security auditors | The operator-facing flag description and the exit-code table (see [CLI.md](../CLI.md)); the exchange protocol that produces the stages (see [PROTOCOL.md](PROTOCOL.md)) |
| [CLI_DOCTOR.md](CLI_DOCTOR.md) | The `psilink doctor` verdict emitted under `--json`: the document's fields, the schema version and the compatibility rule, the `overall` and per-check status vocabularies, both modes' fixed ordered check-id lists, the human-only fields the JSON withholds together with the bound on the tool-output excerpt, and the exit code each verdict maps to. | Implementors of a setup launcher, security auditors | What the two modes check and the `SMB_*` inputs they read (see [CLI.md](../CLI.md#checking-a-network-file-drop)); the CLI-wide exit-code table (see [CLI.md](../CLI.md#exit-codes)); the rendezvous semantics the checks exercise (see [FILE_SYNC.md](FILE_SYNC.md)) |
| [SERVER_JOB_API.md](SERVER_JOB_API.md) | The web server's job API that drives the CLI as a subprocess for the console: the endpoint table and status codes, the injection-closed exchange and zero-setup intent schemas, the operator-authored SFTP connection and its validation, the composed CLI config, the workdir layout and modes, the SSE event relay with full-history replay and trust-boundary re-validation, the exit-code reconciliation and cancellation escalation, the `JOB_DATA_ROOT`/`JOB_CLI_BINARY`/`JOB_SECRETS_DIR` semantics and the startup and reachability rules, the memory-only single-active-exchange lifetime a restart forgets, and the two graduation artifacts beside it: the recurring-run hand-off the API serves and the client-composed partner accept kit it does not. | Implementors of a supervising process, security auditors | What the feature is for and how an operator enables it (see [CONSOLE.md](../CONSOLE.md)); the single-party console trust invariant (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#single-party-console-trust-boundary)); the fd-3 event stream this consumes (see [CLI_EVENTS.md](CLI_EVENTS.md)) |
| [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md) | The self-attested exchange record **format**: the record and verification-keys file shapes, the format version, the HMAC commitment scheme and agreed-terms hash, the governance metadata, the disclosure framing, and the record's privacy properties. | Security auditors, external implementors, compliance reviewers, developers | The PSI protocol that produces the exchange (see [PROTOCOL.md](PROTOCOL.md)); the exchange-agreement format that supplies the governance fields (see [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md)); the canonical byte encoding (see [CANONICAL_ENCODING.md](CANONICAL_ENCODING.md)) |
| [EXCHANGE_FILE.md](EXCHANGE_FILE.md) | The downloadable exchange-file artifact's compatibility contract: that a minted file is the shared CLI config schema (no parallel format), the mint-layer guarantees (no `authentication` block, no representable credential, the SFTP placeholder username), the web/CLI versioning policy (strict-reject vs strip, breaking changes in scope, no artifact back-compat), the invitation channel-binding rule, and the secret's key-file provisioning path (`invite`/`accept`/`exchange --invitation`). | Security auditors, implementors | The field-level meaning of any config field (see [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md)); the invitation token's endpoint sub-schemas and their version-bump policy (see [FILE_SYNC.md](FILE_SYNC.md)) -- the token's own wire format is specified in no document of this tier; the owner-only key-file write discipline (see [CREDENTIAL_STORAGE.md](CREDENTIAL_STORAGE.md)) |
| [DEFAULT_STANDARDIZATION.md](DEFAULT_STANDARDIZATION.md) | The cleaning a configuration gets when it authors none: the per-type default standardization pipelines as ordered steps with their parameters and results, the cross-party invariant that makes a change to one wire-affecting, the date-format inference parameters, and the column-name table that infers a semantic type, role, and payload default. | Implementors, security auditors, maintainers changing a pipeline | The step-function catalog and the configuration schemas (see [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md)); the regex dialect and `parse_date` semantics the steps run under, and the field-to-column binding rule (see [PROTOCOL.md](PROTOCOL.md)) |
| [CANONICAL_ENCODING.md](CANONICAL_ENCODING.md) | The normative RFC 8785 (JCS) byte encoding the receipts, record commitments, and agreed-terms hash are computed over, with worked examples. Written so an independent implementation reproduces byte-identical output. | External implementors, security auditors | What the encoding is for and what it protects against -- that is the **Canonical encoding** overview in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#canonical-encoding); how receipts use these bytes (see [PROTOCOL.md](PROTOCOL.md#third-party-verifiable-proof-of-a-data-flow)); the record format (see [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md)) |
| [CREDENTIAL_STORAGE.md](CREDENTIAL_STORAGE.md) | The owner-only on-disk write path shared by the credential, signing-identity, exchange-record, and result-CSV files: the POSIX exclusive-create and atomic-rename discipline, the `fsync` durability and cross-write crash-ordering guarantee, the macOS `F_FULLFSYNC` caveat and NFSv4-ACL strip, the writable-and-readable-parent pre-flight, and the Windows ACL-narrowing and load-check internals. | Security auditors, implementors | What the files contain and the operator-facing required permissions, warnings, and remediation -- that is the **Key file security** overview in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#key-file-security) |
| [MANAGED_EXCHANGE_RECORD.md](MANAGED_EXCHANGE_RECORD.md) | The browser-persisted managed-exchange record shape: this party's exchange-file document plus the local-only fields (the secret, expiry policy, side, label, input-file handle, schedule, and run bookkeeping) split into what persists across runs versus what is supplied at each run (input content never persists; at most a persisted file handle, a pointer), the credential-free connection composition and its three named implementation pieces, the local `side` role dispatch, the persist-before-success crash-consistency ordering, the linear-secret single-owner invariant, the derived-never-stored rendezvous-id and rotation values, and the export artifact's custody model, rollback caveats, and CLI-separable format. | Security auditors, implementors | The browser at-rest threat model, rollback and metadata-at-rest analyses, and egress-hardening limits (see [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges)); the managed exchange lifecycle overview (see [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md)); the exchange-file artifact contract the document reuses (see [EXCHANGE_FILE.md](EXCHANGE_FILE.md)) |
| [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md) | Why the `ssh2`/`ssh2-sftp-client` and `peerjs`/`peerjs-js-binarypack` stacks are exact-pinned, the internal assumptions the CLI SFTP adapter and the web inbound bound rest on, the per-stack checklist to re-verify them before a bump, the vendored `@openmined/psi.js` addon, the `allowScripts` install-script policy (what npm enforces from it, why allows are version-pinned and denials are not), the GitHub Action pin mirror, and the residuals npm's resolver leaves in this workspace. | Maintainers upgrading a pinned dependency | The controls the assumptions support (see [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md)); how the container images freeze and pin what they install (see [CONTAINER_IMAGES.md](CONTAINER_IMAGES.md)); the dependency-review requirement (see [CONTRIBUTING.md](../../CONTRIBUTING.md#dependency-policy)) |
| [CONTAINER_IMAGES.md](CONTAINER_IMAGES.md) | How the shipped CLI image (`Dockerfile`) and the FIPS variant (`Dockerfile.fips`, published beside it under `-fips` tags) freeze their npm tree to the committed lockfile, what each pins by digest, hash, or NVR and what holds each pin, the two reviewed OS-package install lines, what the CMVP certificate behind the variant's provider attests (its tested operational environments and the approved-algorithm rows the variant's measured call shapes rest on, with CAVP certificate ids), and the writable-set and setuid/setgid inventories that are measured by running each built image -- with the descriptive built-image figures behind them kept in a clearly labelled non-normative section. | Maintainers building or vetting an image, security auditors | Why the npm dependencies themselves are exact-pinned and the per-stack upgrade checklists (see [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md)); the release and SBOM procedure (see [RELEASES.md](../RELEASES.md)) |

## Where does my content go?

> If you are writing a constant value, a byte/wire layout, an HKDF info string or
> other algorithm step, or the "would only need revisiting if..." rationale behind
> one of those, it belongs in `docs/spec/` - regardless of which doc you currently
> have open. Overview docs (`docs/`) stay conceptual and operational, including
> operational rationale such as the coverage-gate decision.

Within this tier, route by topic:

- **The PSI/PSI-C algorithm or the key-exchange wire format** -> [PROTOCOL.md](PROTOCOL.md).
- **The AEAD envelope, key derivation, or a transport memory/liveness bound** -> [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md).
- **The file-sync directory state machine, filename taxonomy, or enforcement sites** -> [FILE_SYNC.md](FILE_SYNC.md).
- **The webrtc channel's signaling envelopes, data-channel framing, close obligation, rendezvous roles, or ICE resolution** -> [WEBRTC_TRANSPORT.md](WEBRTC_TRANSPORT.md).
- **The exchange-record on-disk format or commitment scheme** -> [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md).
- **The downloadable exchange-file artifact's compatibility contract (mint-layer guarantees, web/CLI versioning, channel binding, the secret's key-file provisioning path)** -> [EXCHANGE_FILE.md](EXCHANGE_FILE.md).
- **A default standardization pipeline's steps, or the column-name aliases and role/payload defaults type inference assigns** -> [DEFAULT_STANDARDIZATION.md](DEFAULT_STANDARDIZATION.md).
- **The canonical byte encoding any of the above commits over** -> [CANONICAL_ENCODING.md](CANONICAL_ENCODING.md).
- **The owner-only on-disk write path (exclusive-create, atomic rename, fsync durability, ACL narrowing) or its crash-ordering guarantee** -> [CREDENTIAL_STORAGE.md](CREDENTIAL_STORAGE.md).
- **The browser-persisted managed-exchange record shape (the persisted exchange-file document plus local fields, persist-before-success ordering, single-owner invariant) or the export artifact's custody model** -> [MANAGED_EXCHANGE_RECORD.md](MANAGED_EXCHANGE_RECORD.md).
- **The CLI machine-interface event stream (`--event-stream`): fd, NDJSON framing, event fields, or the terminal-error category rules** -> [CLI_EVENTS.md](CLI_EVENTS.md).
- **The `psilink doctor` `--json` verdict: a field, the version rule, a `status`/`overall` value, a check id, or the exit-code mapping** -> [CLI_DOCTOR.md](CLI_DOCTOR.md).
- **The web server's job API (endpoints, the exchange-intent schema, the workdir layout, the SSE relay, the gate/startup rules, the job lifetime)** -> [SERVER_JOB_API.md](SERVER_JOB_API.md).
- **A pinned-dependency internal assumption, its upgrade checklist (`ssh2`, `peerjs`), the vendored PSI addon, the `allowScripts` install-script policy, a GitHub Action pin invariant, or an npm-resolution residual** -> [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md).
- **A container image's npm/Docker freeze, base-image digest pin, OS-package install line, the FIPS variant's pin table, a row of the CMVP certificate that variant's provider holds (its tested operational environments, its approved-algorithm rows and their CAVP certificate ids), or a runtime posture measured on a built image (its writable set, its setuid/setgid inventory)** -> [CONTAINER_IMAGES.md](CONTAINER_IMAGES.md).

### Two overlaps to disambiguate

- **Self-attested record: placement vs format.** Its *protocol placement* -- where it sits in the exchange, beside the separate signed receipt -- lives in [PROTOCOL.md](PROTOCOL.md) (the "Self-attested record" subsection). Its *on-disk format* -- file shapes, commitment scheme, governance metadata -- lives in [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md). Both are spec-tier, so there is no cross-tier break; open the format doc for the bytes and the protocol doc for the placement.
- **Channel security: construction vs key-exchange wire format.** The AEAD construction and the transport bounds are in [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md); the key-exchange wire format that produces the session key those keys derive from is in [PROTOCOL.md](PROTOCOL.md#p-256-authenticated-key-exchange).

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

### Maintainer-runbook exception: DEPENDENCY_PINS.md and CONTAINER_IMAGES.md

[DEPENDENCY_PINS.md](DEPENDENCY_PINS.md) and
[CONTAINER_IMAGES.md](CONTAINER_IMAGES.md) bend the two tier rules above, on
purpose. Their counterparts are
[CONTRIBUTING.md](../../CONTRIBUTING.md#dependency-policy) (the dependency-review
requirement) and [RELEASES.md](../RELEASES.md) (the build and release procedure),
not a `docs/` overview; their content is a re-verification **procedure** over
spec-level assumptions, not a construction; and they add maintainers upgrading a
pinned dependency or building an image to the tier's implementor and auditor
audience. They live here anyway because their substance is spec-tier -- the
numeric SFTP constants, the BinaryPack marker table, and the ssh2 listener
assumptions that [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md) rests on, and the exact
digests, hashes, and version rows that fix what a built image contains -- so they
belong beside that doc, not in a separate runbook tier.

CONTAINER_IMAGES.md additionally includes a clearly labelled **non-normative**
measured-inventories section. Those figures record what a built image was
observed to contain; they bind no build, and nothing in this tier may cite them
as a requirement.
