---
title: "Changelog"
---

# Changelog

This changelog is a reader's summary of what PSI-Link does and how that changes per release: the major capabilities, breaking changes to them, and the headline security posture. It is not a log of every commit or every refinement (that is the git history). Each entry states the capability in a line or two and points to `docs/` for the full behavior and `docs/spec/` for wire-level detail. The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); PSI-Link uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- The CLI runs recurring, authenticated SFTP exchanges between two parties from a saved config, and one-off exchanges with no config via a `zero-setup` URL. See `docs/CLI.md`.
- The `filedrop` channel exchanges through a shared local directory where neither SFTP nor WebRTC is available. See `docs/COMMUNICATION.md`.
- The CLI runs exchanges over the `webrtc` channel: a peer-to-peer data channel reached through a peer-coordination server, with no file server or shared directory in between. Either party may be a browser, so a CLI party and a web-app party can exchange with each other. See `docs/CLI.md`.
- The web app runs backend-free, invitation-based browser-to-browser exchanges over WebRTC: one side mints a single-use invitation link, the partner opens it to review the terms and consent, and the two browsers rendezvous directly. See `docs/COMMUNICATION.md` and `docs/SECURITY_DESIGN.md`.
- The web app runs recurring exchanges: either party can save an exchange as recurring at invite creation or at accept (its terms and rotating secret persisted in the browser, origin-isolated), then run it again with the same partner without a new invitation. A saved exchange exports as a plaintext credential file under operator custody, for backup against browser-storage eviction and for moving the exchange to another device. See `docs/MANAGED_EXCHANGE.md`.
- The web app can run as a single-party console appliance, driving the party's own `psilink` exchange (filedrop or SFTP) as a server-side subprocess so an operator runs and downloads a result without the command line. Off by default and gated behind a data root; reach it only from the operator's own machine by publishing the container port to host loopback. See `docs/DEPLOYMENT.md` and `docs/spec/SERVER_JOB_API.md`.
- The console runs a Direct exchange: a no-invitation, lowest-ceremony path where both parties run against a server they agreed on out of band, with linkage terms inferred from each party's file (previewed for confirmation) and no shared secret, so protection is transport-only -- the console analog of the CLI's zero-setup. See `docs/DEPLOYMENT.md` and `docs/spec/SERVER_JOB_API.md`.
- The console sends the partner an accept kit: a printable, plaintext instruction sheet, downloaded alongside the invitation, that takes a partner who has only Docker -- Desktop or Engine -- to the point of accepting an SFTP or shared-directory exchange. It carries no secret and no invitation token. See `docs/DEPLOYMENT.md`.
- Each party writes a local, self-attested exchange record of what it disclosed, suitable for a HIPAA or FERPA accounting of disclosures. `psilink verify-receipt` (CLI) and the web "Verify a receipt" page re-check a stored record for internal consistency, read-only. See `docs/spec/EXCHANGE_RECORD.md`.
- Authenticated CLI exchanges configured with a signing identity (`signing` block, certificate mode) also produce a dual-signed exchange receipt: both parties sign the same terms and data-flow facts and swap signatures over the connection, each verifying the partner's pinned certificate before its signature, for a third-party-verifiable record of the data flow. `psilink verify-receipt` checks a stored one later, on either party's side or an auditor's: both signatures, both certificates, and -- for the top-line `verified` verdict -- both certificate slots anchored to something the verifier holds (a pinned partner fingerprint per slot, or the verifier's own signing identity for its own slot, resolved from `--identity-file`, `signing.identity_file`, or the default identity path); a run anchoring only one slot grades `incomplete`. The web "Verify a receipt" page checks a stored one on the same terms, anchoring the partner's slot with a typed pinned fingerprint and its own with an exported certificate -- no private signing key is used in the browser. See `docs/spec/PROTOCOL.md` and `docs/spec/EXCHANGE_RECORD.md`.
- The `single-pass` linkage strategy batches every agreed linkage key into one PSI exchange, keeping the round-trip count constant in the key count for a high-latency channel, as a consented disclosure tradeoff against the default per-key `cascade`. See `docs/EXCHANGE_REFERENCE.md` and `docs/spec/PROTOCOL.md`.
- The PSI engine selects a native N-API backend when a prebuilt addon is present for the running platform, falling back to WASM; the browser always uses WASM. It is a performance accelerator with byte-identical wire output. See `docs/spec/PROTOCOL.md`.
- Host-side console launchers, published stamped as release assets: `Start-Psilink.ps1` (Windows) and `start-psilink.sh` (macOS and Linux) collect the exchange folders, run the container's own `psilink doctor` checks against them, start the web console against the release image pinned by digest, and open the browser. Plaintext, no network of their own, no persistence, no auto-update. See `docs/RELEASES.md` and the setup page in `support/windows-network-filedrop/README.md`.

### Changed

- BREAKING: the published container image runs unprivileged as uid 1000 (`USER node`) instead of root, for both the CLI and console roles. A bind-mounted working directory -- including one an earlier root image wrote into -- must be writable by uid 1000: run the container as your own account with `--user`, or `chown -R 1000:1000` the directory. See `docs/DEPLOYMENT.md`.
- BREAKING: exchange receipts are signed with ECDSA over P-256, an algorithm the targeted FIPS 140-3 certificate approves, through the platform's Web Crypto. The signing-identity, certificate, and dual-signed-receipt formats change with it, so every certificate fingerprint changes: regenerate the identity with `psilink fingerprint --force` and re-share the new fingerprint with each partner out of band. An identity file, certificate, or receipt in the earlier format is refused rather than read. See `docs/spec/PROTOCOL.md` and `docs/spec/EXCHANGE_RECORD.md`.
- BREAKING: the redesigned web app's home route at `/` opens on the browser's list of recurring (managed) exchanges once one exists, run again without a new invitation; a first-run visitor (or a browser that cannot store exchanges) lands on the quick path instead. The full recurring-exchange list, with its designed empty state and restore-from-backup import, is always reachable at `/saved`. Setting up or accepting a one-off exchange is the quick path (`/quick`, with `/exchange`, `/accept`, and `/verify` behind it), and the legacy web interface is removed. See `docs/DESIGN.md`, `docs/MANAGED_EXCHANGE.md`, and `docs/COMMUNICATION.md`.

### Security

- Recurring CLI exchanges are encrypted end-to-end on the wire with an application-layer AEAD, authenticated with a P-256 key exchange, and SFTP connections verify the server host key fail-closed. See `docs/SECURITY_DESIGN.md` and `docs/spec/CHANNEL_SECURITY.md`.

## [0.1.0] - 2026-05-08

Initial proof-of-concept release.

### Added

- Web application: browser-based PSI over WebRTC using ephemeral invitation links.
- Built-in PeerJS peer-coordination server in the web application, served under `/api/`.
- SFTP transport for recurring exchanges between two parties via the CLI.
- `exchange` CLI command: run an exchange over an SFTP connection and predefined linkage rules.
- PSI protocol implementation wrapping the OpenMined PSI WebAssembly module (`@openmined/psi.js`).
