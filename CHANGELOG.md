---
title: "Changelog"
---

# Changelog

All notable changes to PSI-Link are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). PSI-Link uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- SPAKE2 (RFC 9382) authentication over P-256 with mutual MAC confirmation. Recurring exchanges now perform a password-authenticated key exchange (PAKE) before data is transmitted, using a pre-shared token stored in the key file.
- Key rotation: the shared token is automatically replaced with a new one derived from the SPAKE2 session key at the end of each successful handshake.
- `filedrop` channel: file-system-based exchange for environments where neither SFTP nor WebRTC is available. Both parties read and write through a shared locally-mounted directory.
- `zero-setup` CLI command: derive connection parameters directly from a URL, eliminating the need for a configuration file for one-off exchanges.
- `exchange` CLI command updated to require a `.psilink.key` file and perform SPAKE2 authentication before any data is transmitted.
- Key file schema: versioned JSON format for persisting the pre-shared token and exchange metadata between sessions.
- Meta data inference: guess column semantic types from names and infers date formats.
- Custom linkage keys: linkage terms can be set in config and keys can be derived using transformations.
- Data standardization: transformations can create canonical linkage terms from input columns according to their semantic types.

### Changed

- Library API: `runExchange` and `authenticateConnection` now take a `MessageConnection` instead of the event-based `Connection`. CLI exchanges are unaffected.
- An exchange now fails with a clear error (bounded by `peer_timeout_ms`) when the partner stops responding, instead of hanging.
- A peer sending messages out of turn is rejected rather than buffered without limit.

### Fixed

- A malformed message from a peer is reported as a protocol error instead of crashing.
- A failed exchange surfaces its original cause instead of a generic connection error.

### Security

- SPAKE2 blinding points M and N are derived via hash-to-curve (RFC 9380, SSWU for P-256) with `psilink`-specific domain separation strings, ensuring no known discrete-log relationship with the generator.
- Password scalar derivation uses HKDF-SHA-256 expanded to 48 bytes before reduction modulo the P-256 order, keeping mod-reduction bias below 2^-128.
- Invitation tokens carry a bounded lifetime (default 1 hour); rotation tokens carry no expiration, making them suitable for recurring scheduled exchanges.

### Documentation

- Documented the transport delivery contract - a send completes on local hand-off rather than peer delivery, and a clean close flushes the final frame before teardown - in docs/COMMUNICATION.md and the `Connection` and `TransportHooks` interfaces, stating the guarantee any future channel must satisfy.

## [0.1.0] - 2026-05-08

Initial proof-of-concept release.

### Added

- Web application: browser-based PSI over WebRTC using ephemeral invitation links.
- Built-in PeerJS peer-coordination server in the web application, served under `/api/`.
- SFTP transport for recurring exchanges between two parties via the CLI.
- `exchange` CLI command: run an exchange an SFTP connection and predefined linkage rules.
- PSI protocol implementation wrapping the OpenMined PSI WebAssembly module (`@openmined/psi.js`).
