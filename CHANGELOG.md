---
title: "Changelog"
---

# Changelog

All notable changes to PSI-Link are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). PSI-Link uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- Canonical encoding for receipts: a language-independent, deterministic byte serialization (RFC 8785, JSON Canonicalization Scheme) used for everything that is hashed, committed, or signed, so receipt hashes and signatures verify across independent implementations. Exposed as `canonicalString`/`canonicalBytes` (with `safeIntegerSchema` for hashed numeric fields) in `@psilink/core`, specified normatively in `docs/CANONICAL_ENCODING.md`, and backed by checked-in cross-implementation test vectors verified byte-identically on Node and in the browser. Foundation for the self-attested record and the signed non-repudiation receipt.

- `@psilink/core/testing` subpath export: `withSuppressedLogs` and `withCapturedLogs` helpers for controlling loglevel output in tests.
- SPAKE2 (RFC 9382) authentication over P-256 with mutual MAC confirmation. Recurring exchanges now perform a password-authenticated key exchange (PAKE) before data is transmitted, using a pre-shared token stored in the key file.
- Key rotation: the shared token is automatically replaced with a new one derived from the SPAKE2 session key at the end of each successful handshake.
- `filedrop` channel: file-system-based exchange for environments where neither SFTP nor WebRTC is available. Both parties read and write through a shared locally-mounted directory.
- `retain_files` mode for the `sftp` and `filedrop` channels: the receiver writes a zero-length acknowledgment marker after consuming each message instead of deleting it, so no exchange file is deleted as a protocol step and the shared directory becomes a permanent transcript. Requires `lockless_rendezvous` and `timestamp_in_filename`; the `--retain-files` CLI flag implies both. Intended for sync-mediated transports that do not propagate deletions and for audit retention.
- Bilateral mode mismatch detection at rendezvous: each party advertises its `lockless_rendezvous` and `retain_files` settings in its hello, and a mismatch fails fast on both parties with a clear usage error (exit 64) naming each side's setting, instead of stalling until the peer timeout.
- `connection.options.unexpected_files` (`sftp`/`filedrop`): policy for a file that appears in the shared directory during the message loop and is neither part of this exchange nor an in-flight temp write -- `error` (fail with a usage error, exit 64, naming the file and the directory path), `warn` (log once per distinct name and continue), or `ignore` (skip silently, the previous behavior). The setting is local, not bilateral; the two parties may use different values. When unset it defaults to `error` on plain transports and `warn` when `retain_files` or `lockless_rendezvous` is set, where sync tools legitimately produce transient conflict copies and partial downloads. A malformed protocol file (a message-shaped name a correctly configured peer cannot produce) is always reported regardless of this setting.
- `zero-setup` CLI command: derive connection parameters directly from a URL, eliminating the need for a configuration file for one-off exchanges.
- `exchange` CLI command updated to require a `.psilink.key` file and perform SPAKE2 authentication before any data is transmitted.
- Key file schema: versioned JSON format for persisting the pre-shared token and exchange metadata between sessions.
- Meta data inference: guess column semantic types from names and infers date formats.
- Custom linkage keys: linkage terms can be set in config and keys can be derived using transformations.
- Data standardization: transformations can create canonical linkage terms from input columns according to their semantic types.

### Changed

- Renamed the default file-sync rendezvous mode from "wave" to "lock" (the counterpart to the existing "lockless" mode) and its on-disk tiebreaker file from `<id1>-<id2>.wave` to `<peer1>-<peer2>-lock.json`, bringing the tiebreaker under the same control-file filename grammar as every other protocol file. Terminology and on-disk naming only: no protocol behavior or config-schema change, and `lockless_rendezvous: false` still selects this mode. Old and new builds do not interoperate at rendezvous (one writes `.wave`, the other `-lock.json`), so both ends must run the same build.
- Library API: `runExchange` and `authenticateConnection` now take a `MessageConnection` instead of the event-based `Connection`. CLI exchanges are unaffected.
- An exchange now fails with a clear error (bounded by `peer_timeout_ms`) when the partner stops responding, instead of hanging.
- A peer sending messages out of turn is rejected rather than buffered without limit.
- The CLI now exits with code 64 (EX_USAGE) instead of 69 (EX_UNAVAILABLE) when `synchronize()` or `send()` fails due to a configuration or usage problem: a dirty exchange directory (preexisting handshake files), multiple concurrent sessions on the same path, or a send timeout. Transport failures continue to exit with code 69.
- `psilink exchange` now exits 64 (EX_USAGE) for every malformed, unreadable, or missing configuration (`psilink.yaml`) or key (`.psilink.key`) file. Previously only a missing config file exited 64, while a missing or malformed key file and a malformed config exited 69 (EX_UNAVAILABLE), the code reserved for transport failures. A malformed PAKE token is now classified the same way whether the key file is read or written.
- The CLI now exits 64 (EX_USAGE) instead of 69 when the requested channel or URL scheme is unsupported -- a `webrtc` config or a `ws://`/`wss://` URL, an unknown URL scheme, or a malformed `file://` authority -- in both `psilink exchange` and the zero-setup command, classifying it as invalid caller input rather than a transport failure.
- Invalid connection-option combinations -- a reserved or unaccompanied `peer_id`, a `retain_files`/`lockless_rendezvous` contradiction, and similar -- now exit 64 (EX_USAGE) instead of 69, whether they originate in `psilink.yaml` or a command-line override.

### Fixed

- Standardized linkage-key strings are now normalized to Unicode NFC before they enter PSI. NFC normalization runs unconditionally as the first step of every field's standardization pipeline -- including identity (no-step) and custom pipelines that never strip to ASCII -- so two parties holding the same logical value in different normalization forms (precomposed NFC vs decomposed NFD, the common macOS-filesystem vs Windows/most-database split) produce identical key bytes instead of silently failing to match. Previously the only normalization happened inside `remove_accents`, which is not guaranteed to run. `remove_accents` additionally re-normalizes to NFC after its NFD diacritic strip so no decomposed residue leaks into the key. The same guarantee covers config-supplied literals that are compared against or injected into the value (`null_if` values, a `coalesce` default, a `replace_regex` replacement, a `pad_left` character) and the fully assembled key string, which is normalized once more after its elements are concatenated; regex patterns are matched as authored and are not normalized.
- Mid-pipeline comparison steps (`null_if`, `filter_regex`, `extract_regex`) now NFC-normalize the value they inspect before matching. A case-fold such as `to_upper_case` can emit non-NFC bytes for a few code points (e.g. the Greek `U+0390`), so an exclusion, filter, or extraction authored correctly in NFC but placed after a case-fold could previously miss -- silently letting an excluded value survive into the PSI set, or wrongly dropping a record whose filter or extraction should have matched. The final assembled-key NFC pass added above only fixes the emitted key, which is produced after these mid-pipeline reads. The steps still pass already-canonical and pure-ASCII values through with byte-identical output (`null_if`/`filter_regex` return the original value; `extract_regex` returns its capture from the normalized value). Follow-up to the Unicode NFC normalization above.
- `connection.provider_options` keys are now passed verbatim, as the spec now documents. Previously the config writer snakeized them to disk and the reader camelized them back, so a key authored in the casing the transport library expects -- e.g. ssh2's `readyTimeout` -- was rewritten (`ready_timeout`) rather than preserved. The map's contents are excluded from key-case transformation on both the write and read paths; all other schema fields, including function `params`, are normalized as before.
- A malformed message from a peer is reported as a protocol error instead of crashing.
- A failed exchange surfaces its original cause instead of a generic connection error.
- Closing a file-sync connection now cancels any in-flight rendezvous or send wait promptly instead of letting the timer fire and resume against a connection that is tearing down. Internal hardening only: cancellation threads a single `AbortController` through every wait site, and a new internal `ConnectionClosedError` may appear in debug logs on a close-during-wait. Not a user-facing exit-code change (a deliberate close under a signal still exits 130/143).
- Wave-path rendezvous: a party whose hello is deleted by a joiner that then fails mid-arrival no longer stalls until the peer timeout. The joiner now signals its arrival with a `<id>-joining.json` sentinel, and the waiting party recovers within a bounded window or aborts with a distinct transport error.
- File-sync rendezvous now sweeps an orphaned in-flight temp file (`temp-*.tmp`) left in the exchange directory by a `send()`/`writeAck()` whose process was hard-killed between the temp write and its atomic rename. The artifact is deleted at rendezvous setup instead of accumulating as litter across crashed exchanges or aborting entry with a spurious usage error. Only `temp-*.tmp` is swept, never the `*.json` message files (so retain mode's transcript is untouched).
- `MessageConnection`: a clean half-close that defers behind buffered inbound frames now tears the transport down at half-close time instead of only when the buffer is later drained, so a consumer that abandons the half-closed connection without draining or closing it no longer leaks the transport's listeners/channel. Internal hardening collapses the connection's terminal lifecycle into a single explicit state, so each method's terminal behavior derives from one source of truth rather than from four hand-duplicated flags. No happy-path or API-surface change for a correct caller; two intended changes land on abnormal/teardown paths: teardown now runs at half-close call time, and an already-buffered frame is drained before any abnormal terminal error surfaces (previously a frame buffered behind an abnormal drop was discarded), uniformly across transports.

### Security

- SPAKE2 blinding points M and N are derived via hash-to-curve (RFC 9380, SSWU for P-256) with `psilink`-specific domain separation strings, ensuring no known discrete-log relationship with the generator.
- Password scalar derivation uses HKDF-SHA-256 expanded to 48 bytes before reduction modulo the P-256 order, keeping mod-reduction bias below 2^-128.
- Invitation tokens carry a bounded lifetime (default 1 hour); rotation tokens carry no expiration, making them suitable for recurring scheduled exchanges.

### Documentation

- Documented the transport delivery contract - a send completes on local hand-off rather than peer delivery, and a clean close flushes the final frame before teardown - in docs/COMMUNICATION.md and the `Connection` and `TransportHooks` interfaces, stating the guarantee any future channel must satisfy.
- Recorded two close-teardown decisions in docs/COMMUNICATION.md (cross-referenced from the `ConnectionErrorKind` JSDoc and the web PeerJS clean-close wiring) now that the inbound drain is uniform in the shared message queue: the error-kind decision (a clean remote close stays kind `"transport"` rather than being unified with a local close's `"closed"`, because a remote channel-close event does not convey the peer's intent and pake.ts relies on the `"transport"` tag to report a vanished peer as a handshake timeout) and the narrowed per-transport residue (each transport wires which terminal control its events call - WebRTC maps `close` to `finish()` and `error` to `fail()` - while a shared `Connection.close` event is rejected as the wrong shape because it would reintroduce the no-listener drop window the pull-based queue eliminates).
- Corrected the non-repudiation receipt design in docs/PROTOCOL.md ahead of implementation: the receipt is a post-exchange audit artifact produced after the result already exists on both sides and does not gate or withhold result delivery; the session-derived (symmetric) signing mode is tamper-evident only and does not provide non-repudiation (its MAC is forgeable by either party), so true non-repudiation requires the certificate-backed asymmetric mode; and the receipt swap is best-effort evidence, not a fairness or atomicity guarantee. Clarified in docs/EXCHANGE_SPEC.md that `linkage_terms.identity` is self-asserted and carries evidentiary weight only when bound to a certificate.

## [0.1.0] - 2026-05-08

Initial proof-of-concept release.

### Added

- Web application: browser-based PSI over WebRTC using ephemeral invitation links.
- Built-in PeerJS peer-coordination server in the web application, served under `/api/`.
- SFTP transport for recurring exchanges between two parties via the CLI.
- `exchange` CLI command: run an exchange an SFTP connection and predefined linkage rules.
- PSI protocol implementation wrapping the OpenMined PSI WebAssembly module (`@openmined/psi.js`).
