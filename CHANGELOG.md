---
title: "Changelog"
---

# Changelog

This changelog is a reader's summary of what PSI-Link does and how that changes per release: the major capabilities, breaking changes to them, and the headline security posture. It is not a log of every commit or every refinement (that is the git history). Each entry states the capability in a line or two and points to `docs/` for the full behavior and `docs/spec/` for wire-level detail. The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); PSI-Link uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- The CLI runs recurring, authenticated SFTP exchanges between two parties from a saved config, and one-off exchanges with no config via a `zero-setup` URL. See `docs/CLI.md`.
- The `filedrop` channel exchanges through a shared local directory where neither SFTP nor WebRTC is available. See `docs/COMMUNICATION.md`.
- The web app runs backend-free, invitation-based browser-to-browser exchanges over WebRTC: one side mints a single-use invitation link, the partner opens it to review the terms and consent, and the two browsers rendezvous directly. See `docs/COMMUNICATION.md` and `docs/SECURITY_DESIGN.md`.
- The web app runs recurring exchanges: either party can save an exchange as recurring at invite creation or at accept (its terms and rotating secret persisted in the browser, origin-isolated), then run it again with the same partner without a new invitation. A saved exchange exports as a plaintext credential file under operator custody, for backup against browser-storage eviction and for moving the exchange to another device. See `docs/MANAGED_EXCHANGE.md`.
- The web app can run as a single-party console appliance, driving the party's own `psilink` exchange (filedrop or SFTP) as a server-side subprocess so an operator runs and downloads a result without the command line. Off by default and gated behind a data root and either a loopback bind or a bearer token. See `docs/DEPLOYMENT.md` and `docs/spec/SERVER_JOB_API.md`.
- Each party writes a local, self-attested exchange record of what it disclosed, suitable for a HIPAA or FERPA accounting of disclosures. `psilink verify-receipt` (CLI) and the web "Verify a receipt" page re-check a stored record for internal consistency, read-only. See `docs/spec/EXCHANGE_RECORD.md`.
- The `single-pass` linkage strategy batches every agreed linkage key into one PSI exchange, keeping the round-trip count constant in the key count for a high-latency channel, as a consented disclosure tradeoff against the default per-key `cascade`. See `docs/EXCHANGE_REFERENCE.md` and `docs/spec/PROTOCOL.md`.
- The PSI engine selects a native N-API backend when a prebuilt addon is present for the running platform, falling back to WASM; the browser always uses WASM. It is a performance accelerator with byte-identical wire output. See `docs/spec/PROTOCOL.md`.

### Changed

- BREAKING: the redesigned web app's home route at `/` opens on the browser's list of recurring (managed) exchanges once one exists, run again without a new invitation; a first-run visitor (or a browser that cannot store exchanges) lands on the quick path instead. The full recurring-exchange list, with its designed empty state and restore-from-backup import, is always reachable at `/saved`. Setting up or accepting a one-off exchange is the quick path (`/quick`, with `/exchange`, `/accept`, and `/verify` behind it), and the legacy web interface is removed. See `docs/DESIGN.md`, `docs/MANAGED_EXCHANGE.md`, and `docs/COMMUNICATION.md`.

### Security

- Recurring CLI exchanges are encrypted end-to-end on the wire with an application-layer AEAD, authenticated with an X25519 key exchange, and SFTP connections verify the server host key fail-closed. See `docs/SECURITY_DESIGN.md` and `docs/spec/CHANNEL_SECURITY.md`.

## [0.1.0] - 2026-05-08

Initial proof-of-concept release.

### Added

- Web application: browser-based PSI over WebRTC using ephemeral invitation links.
- Built-in PeerJS peer-coordination server in the web application, served under `/api/`.
- SFTP transport for recurring exchanges between two parties via the CLI.
- `exchange` CLI command: run an exchange over an SFTP connection and predefined linkage rules.
- PSI protocol implementation wrapping the OpenMined PSI WebAssembly module (`@openmined/psi.js`).
