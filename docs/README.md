---
title: "PSI-Link Documentation"
---

# PSI-Link documentation

PSI-Link is a privacy-preserving record linkage (PPRL) tool that enables partner agencies to identify shared members across administrative datasets without revealing anything about the records they do not have in common. It implements a private set intersection (PSI) protocol available both as a browser-based web application and a containerized CLI, and is designed to work within the policy and infrastructure constraints typical of government agencies.

## Role-based reading guide

| I am a... | Start with... | Then read... |
|-----------|--------------|--------------|
| Program officer evaluating the software | [DESIGN.md](DESIGN.md) | [SECURITY_DESIGN.md](SECURITY_DESIGN.md), [COMPLIANCE.md](COMPLIANCE.md) |
| Security reviewer or auditor | [SECURITY_DESIGN.md](SECURITY_DESIGN.md) | [PROTOCOL.md](spec/PROTOCOL.md), [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md), [COMPLIANCE.md](COMPLIANCE.md) |
| Compliance officer or privacy reviewer | [COMPLIANCE.md](COMPLIANCE.md) | [SECURITY_DESIGN.md](SECURITY_DESIGN.md) |
| IT professional operationalizing an exchange | [CLI.md](CLI.md) | [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md), [DEPLOYMENT.md](DEPLOYMENT.md) |
| Developer contributing to the project | [DESIGN.md](DESIGN.md) | [PROTOCOL.md](spec/PROTOCOL.md), [COMMUNICATION.md](COMMUNICATION.md), [FILE_SYNC.md](spec/FILE_SYNC.md), [CONTRIBUTING.md](../CONTRIBUTING.md), [TESTING.md](TESTING.md) |
| Maintainer upgrading a pinned dependency | [CONTRIBUTING.md](../CONTRIBUTING.md#dependency-policy) | [DEPENDENCY_PINS.md](spec/DEPENDENCY_PINS.md) |
| Partner agency setting up an exchange | [CLI.md](CLI.md) | [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md) |

## Document inventory

The documentation is organized in two tiers: this **overview** tier (`docs/`) of conceptual and operational documents, and a **technical specification** tier ([`docs/spec/`](spec/README.md)) of wire formats, byte encodings, normative constants, and implementation-level design for implementors and auditors. The spec tier has its own [index and routing guide](spec/README.md).

### Overview (`docs/`)

- [DESIGN.md](DESIGN.md) - project overview, architecture, exchange specification summary, and high-level user journey
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md) - security overview, the private set intersection (PSI) privacy guarantee, threat model, authentication design, channel security, and key rotation
- [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md) - the managed (recurring) web exchange lifecycle: durability contract, single-device ownership, desync recovery, storage-eviction survival, the encrypted export artifact, and persistence-status UX
- [COMPLIANCE.md](COMPLIANCE.md) - regulatory framings, data classification, and considerations for agency reviewers
- [COMMUNICATION.md](COMMUNICATION.md) - channels, synchronization, error handling, and supporting services
- [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md) - complete field-level reference for exchange specification files
- [CLI.md](CLI.md) - CLI commands, configuration files, invitation strings, and recovery
- [DEPLOYMENT.md](DEPLOYMENT.md) - operating supporting services and Docker deployment of the CLI
- [RELEASES.md](RELEASES.md) - versioning policy, release checklist, and artifact publication
- [TESTING.md](TESTING.md) - test-suite reference: integration backends and profiles, the console sentinel, the browser suite, and the coverage rationale
- [ROADMAP.md](ROADMAP.md) - roadmap of planned functionality

### Technical specifications ([`docs/spec/`](spec/README.md))

- [PROTOCOL.md](spec/PROTOCOL.md) - PSI and PSI-C algorithms, linkage mechanics, datasets, post-linkage steps, and X25519 key-exchange wire-level specification
- [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md) - application-layer AEAD construction, the transport memory/liveness bounds, SFTP fatal-packet crash safety, and the authenticated abort marker
- [FILE_SYNC.md](spec/FILE_SYNC.md) - file-sync transport state model: the directory-as-state-machine, filename taxonomy, enforcement sites, invariants, and exchange preconditions for the `sftp` and `filedrop` channels
- [COMMUNICATION.md](spec/COMMUNICATION.md) - transport-contract complement to the overview: the terminal `ConnectionErrorKind` classification rationale
- [EXCHANGE_RECORD.md](spec/EXCHANGE_RECORD.md) - format specification for the self-attested exchange record: file shapes, commitment scheme, governance metadata, and privacy properties
- [CANONICAL_ENCODING.md](spec/CANONICAL_ENCODING.md) - the RFC 8785 byte encoding the receipts, record commitments, and agreed-terms hash are computed over
- [CREDENTIAL_STORAGE.md](spec/CREDENTIAL_STORAGE.md) - the owner-only write path (exclusive-create, atomic rename, fsync durability, ACL narrowing) for the key file, signing identity, exchange record, and result CSV
- [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md) - the browser-persisted managed-exchange record: field-by-field persisted-vs-re-supplied shape, the persist-before-success ordering, the linear-secret single-owner invariant, and the export artifact's keying
- [CLI_EVENTS.md](spec/CLI_EVENTS.md) - the CLI's opt-in machine-interface event stream (`--event-stream`): the file descriptor, NDJSON framing, event types, terminal-error categories, and per-field sanitization
- [SERVER_JOB_API.md](spec/SERVER_JOB_API.md) - the web server's job API that drives the CLI as a subprocess for the console appliance: endpoints, the injection-closed intent schema, the operator-provisioned SFTP remotes table, read-only restore of completed jobs after a restart, the workdir layout, the SSE event relay, and the gate/startup rules
- [DEPENDENCY_PINS.md](spec/DEPENDENCY_PINS.md) - why the SFTP and WebRTC stacks are exact-pinned, their internal premises, and the per-stack upgrade checklists
