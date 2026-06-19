---
title: "Changelog"
---

# Changelog

This changelog records, per release, the changes that affect how PSI-Link is run, deployed, or reviewed: new commands and options, changed defaults and behavior, breaking changes, and security-relevant changes. It is not a log of every commit (that is the git history), and it omits internal refactors and test, CI, and tooling changes that no operator or reviewer acts on. Each entry states the observable change and points to `docs/` for the rationale and `docs/spec/` for wire-level detail. The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); PSI-Link uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- `psilink invite` and `psilink accept`: turn a one-off exchange into a recurring one backed by a shared secret. Each runs offline (write key and config files) or online (connect and run in one step). An expired or malformed invitation is rejected before you are prompted, and a pre-existing config or key at the target path is reconciled rather than clobbered. See `docs/CLI.md`.
- Receipt signing identities and `psilink fingerprint`: a long-lived per-party Ed25519 identity and self-signed certificate, pinned by fingerprint exchanged out-of-band. `psilink fingerprint` prints it (and regenerates with `--force`). This is the foundation for signed receipts; receipts themselves are not yet wired up. See `docs/SECURITY_DESIGN.md`.
- Self-attested exchange record: each party writes a local, unsigned audit record (not a non-repudiable receipt) of what it disclosed -- the agreed-terms hash, both identities, records exposed, governance metadata, and salted commitments to the data -- suitable for a HIPAA or FERPA disclosure record, split into a shareable record file and a private opening file. The CLI writes both (`--record-file`, `--no-record`); the web app offers them as downloads. See `docs/spec/EXCHANGE_RECORD.md`.
- The web app now runs invitation-based, backend-free exchanges: "Create an invitation" mints a single-use deep link to deliver out-of-band, the partner opens it to review the terms and consent, and the two browsers rendezvous directly. A web exchange now always carries an invitation secret. See `docs/SECURITY_DESIGN.md` and `docs/COMMUNICATION.md`.
- The web accept screen shows the inviter's full proposed linkage terms -- every key, the fields and transforms that affect matching, the method, and result-sharing -- and requires explicit consent before connecting; the exchange then runs exactly those terms. See `docs/COMMUNICATION.md`.
- `zero-setup` exchange: derive all connection parameters from a URL, with no configuration file, for a one-off exchange. See `docs/CLI.md`.
- `filedrop` channel: exchange through a shared local directory where neither SFTP nor WebRTC is available. See `docs/COMMUNICATION.md`.
- `retain_files` mode (`sftp`/`filedrop`): keep every exchange file as a durable transcript instead of deleting it on consume (`--retain-files`). See `docs/EXCHANGE_REFERENCE.md`.
- `psilink invite --expires-in DURATION` sets the invitation lifetime (default 1 hour). See `docs/CLI.md`.
- `--log-file <path>` on every command that logs appends diagnostics to an owner-only file for unattended runs; a missing parent directory fails with exit 64. See `docs/CLI.md`.
- `--save` on a zero-setup exchange provisions a persistent shared secret in-band when both parties pass it, with no separate invite round; that secret is protected only by the transport. See `docs/SECURITY_DESIGN.md`.
- The `-` input positional reads the CSV from standard input for `exchange`, the zero-setup form, and `invite`; `accept` rejects `-` (it reads its confirmation prompt from stdin), so a piped `accept` fails fast with guidance. See `docs/CLI.md`.
- `--sweep-exchange-files` (and `--force-retain-sweep`) clear protocol files left by a crashed prior run on the `sftp`/`filedrop` channels. See `docs/spec/FILE_SYNC.md`.
- `connection.options.unexpected_files` policy (`error`/`warn`/`ignore`) for a foreign file that appears in the shared directory during an exchange; defaults to `error`, or `warn` under `retain_files`/`lockless_rendezvous`. See `docs/EXCHANGE_REFERENCE.md`.
- `authentication.token_max_age_days`: cap the age of rotated tokens for dormant partnerships. A misspelled key in the `authentication` block is now rejected at parse time. See `docs/EXCHANGE_REFERENCE.md` and `docs/SECURITY_DESIGN.md`.
- Invitations may carry an optional credential-free connection endpoint (a public rendezvous locator); they never carry credentials. See `docs/SECURITY_DESIGN.md`.
- A `psilink:diagnostics` localStorage flag raises web connection-logging verbosity for one browser, without leaking the derived rendezvous ids. See `docs/DEPLOYMENT.md`.
- `psilink invite` (offline) prints how to abandon a pending invitation before it expires: delete its key file. See `docs/CLI.md`.
- Key file schema: a versioned JSON format for persisting the shared token and exchange metadata between sessions.
- Metadata inference (column semantic types and date formats), custom linkage keys via configurable transformations, and data standardization that canonicalizes linkage values by semantic type. See `docs/EXCHANGE_REFERENCE.md`.

### Changed

- BREAKING: the CLI authenticates recurring exchanges with the X25519 authenticated key exchange instead of SPAKE2, and the shared credential is renamed `pake_token` -> `shared_secret` in config. Old and new builds do not interoperate; pre-release, no migration shim. `exchange` now requires a `.psilink.key`. See `docs/spec/PROTOCOL.md`.
- BREAKING: the `authentication` block moves from per-channel `connection` config to the top level of the exchange spec, and the WebRTC role moves to `connection.role`. Authentication, rotation, and expiry behavior are unchanged. See `docs/EXCHANGE_REFERENCE.md`.
- BREAKING: the duration flags `--accept-timeout`, `--connection-timeout`, and `--peer-timeout` now require a unit suffix (`30s`, `2h`); a bare integer is rejected. Update any scripts that pass bare seconds. See `docs/CLI.md`.
- BREAKING (source builds): a source install now requires Node 26, enforced at install rather than advisory. The published Docker image and web deploy are unaffected.
- Renamed the default file-sync rendezvous mode "wave" -> "lock" and its on-disk tiebreaker file; old and new builds do not interoperate at rendezvous, so both ends must run the same build.
- Exit codes: scripts that branch on 64 vs 69 should be reviewed. A class of configuration and usage failures that previously exited 69 now exits 64 (EX_USAGE) -- a dirty exchange directory, concurrent sessions on one path, a send timeout, a malformed or missing config or key file, an unsupported channel or URL scheme, or an invalid connection-option combination -- while transport failures still exit 69. See `docs/CLI.md`.
- The timeout flags now reject a value above a 7-day ceiling with a usage error (exit 64). See `docs/CLI.md`.
- A clean file-sync close against a departed peer now fails fast (bounded to about a minute) and logs the wait at default verbosity, instead of blocking up to the full peer-timeout. See `docs/spec/FILE_SYNC.md`.
- Offline `psilink invite` can take its linkage terms from an existing config instead of an input CSV. See `docs/CLI.md`.
- Online `psilink invite` states up front that the printed invitation is acceptable only while the command is waiting. See `docs/CLI.md`.
- Terminal transport and directory errors (an over-cap frame, a contaminated directory, a stalled server) now end with a concrete next step and suppress the contradictory generic "retry without re-inviting" advisory.
- The CLI and the web accept screen render an invitation or config validation failure as a readable one-liner instead of a raw schema-error dump.
- The web exchange screen shows a fixed, friendly, retry-oriented message when a generic transport failure (a dropped or failed connection) ends an exchange, instead of the raw error text; the detailed error stays in the browser console for diagnosis.
- Documentation is reorganized into `docs/` (overview) and `docs/spec/` (wire formats, byte encodings, constants); some files moved or were renamed, so links to old paths break. See `docs/spec/README.md`.

### Removed

- The web app's server-side session backend (`/api/psi`) and its secret-less (zero-setup) web exchange are removed; a web exchange now always carries an invitation secret. The PeerJS signaling server (the transport) is retained.

### Fixed

- Linkage values are now normalized to Unicode NFC before matching, and again after any case-folding step, so the same value in different normalization forms -- the common macOS-NFC vs database-NFD split -- matches instead of silently failing. See `docs/EXCHANGE_REFERENCE.md`.
- Fixed a deadlock in the multi-key matching loop where one party could skip a linkage key the partner still ran, hanging the exchange; it surfaced under one-to-one and many-to-one linkages when the parties' matched sets diverged.
- An exchange now fails with a clear error (bounded by `peer_timeout_ms`) when the partner stops responding, instead of hanging; the timeout message names the likely peer-side causes.
- On `sftp` and `filedrop`, a peer that aborts mid-exchange is signaled so the waiting side fails fast instead of waiting out `--peer-timeout`. See `docs/spec/FILE_SYNC.md`.
- A `filedrop`/local-filesystem connect that times out is now terminal, so a stalled NFS or CIFS mount no longer ties up the process across retries.
- File-sync rendezvous recovers from a peer that fails mid-arrival, and sweeps an orphaned temp file left by a hard-killed prior run, instead of stalling until the peer timeout or aborting the next run. See `docs/spec/FILE_SYNC.md`.
- An already-expired or malformed shared secret now fails before any connection is opened, with the correct re-invite guidance on both parties, instead of a misleading post-rendezvous error.
- A `peer_timeout_ms` or `server_connect_timeout_ms` of `0` is now rejected at parse time rather than silently disabling the timeout. `max_reconnect_attempts` still accepts `0`.
- An unset `server_connect_timeout_ms` now applies the documented 30000 ms per-attempt connect deadline on both `sftp` and `filedrop`, instead of letting an `sftp` connect fall back to ssh2's shorter internal default. See `docs/EXCHANGE_REFERENCE.md`.
- The SFTP adapter retries a transient `rename` failure instead of aborting on an intermittent server error. See `docs/spec/FILE_SYNC.md`.
- SFTP exchanges are faster: the client disables Nagle's algorithm on its socket, removing per-round-trip delayed-ACK stalls.
- The CLI percent-decodes a server URL's host, path, and credentials, so `sftp://user@host/my%20drop` targets `my drop`; a malformed percent-escape is a usage error (exit 64). See `docs/CLI.md`.
- `connection.provider_options` keys are passed to the transport library verbatim (for example ssh2's `readyTimeout`) instead of being case-rewritten. See `docs/EXCHANGE_REFERENCE.md`.
- `@path` references resolve only in credential and opaque-options fields; a free-text field beginning with a literal `@` is kept verbatim. See `docs/EXCHANGE_REFERENCE.md`.
- The key-file pre-flight now rejects a parent directory that is writable but not readable, so a key write cannot fail after the handshake has already rotated the token. See `docs/SECURITY_DESIGN.md`.
- Repeating a single-value flag (for example `--server-port`) is now a clean usage error (exit 64) instead of misbehaving. See `docs/CLI.md`.
- A malformed message from a peer is reported as a protocol error instead of crashing, and a failed exchange surfaces its original cause instead of a generic connection error.
- The acceptor is warned, or the exchange blocked (exit 64), when its CSV cannot satisfy the inviter's linkage terms, instead of silently producing an empty result. See `docs/CLI.md`.
- Linkage terms that pair `output.expects_output: false` with `payload.receive` columns are rejected as incoherent at parse time. See `docs/EXCHANGE_REFERENCE.md`.
- Linkage terms that reference an undeclared linkage field, or whose `swap` names no element in its key, are rejected as incoherent at decode, instead of silently collapsing the affected key to an empty result. See `docs/EXCHANGE_REFERENCE.md`.

### Security

- A malformed operator config (`psilink.yaml`) or credential file (`.psilink.key`, the signing identity) no longer echoes its own contents into CLI error messages or stderr, so an inline SFTP credential, the shared secret, or a private key cannot leak from a 0600 file into logs or bug reports. Parse errors report the file path only. As a backstop, displayed errors also redact any embedded PEM/OpenSSH private-key block. See `docs/SECURITY_DESIGN.md`.
- Recurring CLI exchanges (`sftp`/`filedrop`) are now encrypted end-to-end on the wire with an application-layer AEAD, so a directory or server administrator sees only ciphertext. See `docs/spec/CHANNEL_SECURITY.md`.
- Web exchanges run the X25519 authenticated key exchange before any PSI data, so each party authenticates the peer and an expired or untrusted credential fails closed; a web exchange is single-use and persists no key file. Transport confidentiality on the web path is provided by DTLS -- the application-layer AEAD is not yet applied there, so the session key currently serves only to authenticate. See `docs/SECURITY_DESIGN.md`.
- Invitation tokens carry a bounded lifetime (default 1 hour, now including web-generated ones); rotation tokens carry no expiry unless `token_max_age_days` is set. See `docs/SECURITY_DESIGN.md`.
- The shared token is rotated after every successful handshake. See `docs/SECURITY_DESIGN.md`.
- The file-sync transport bounds untrusted input from a hostile SFTP or file-drop server, closing memory-exhaustion and hang denial-of-service: a roughly 512 MiB inbound frame cap, an 8192-entry / 255-character directory-listing cap, and per-operation read/write liveness deadlines of about a minute. See `docs/spec/CHANNEL_SECURITY.md`.
- A malformed SFTP packet from a hostile server can no longer crash the CLI; it becomes an orderly typed failure with normal cleanup. See `docs/spec/CHANNEL_SECURITY.md`.
- SFTP host-key verification (fail-closed): every SFTP connection verifies the presented host key before authenticating and aborts on a mismatch. Pin it out-of-band via `connection.server.host_key_fingerprint`, or let the first interactive run establish it on first use -- any command that opens the SFTP connection (`exchange`, an online `invite`/`accept`, or a zero-setup exchange) shows the presented fingerprint, prompts for confirmation, and records it (a zero-setup run persists it only with `--save`); later runs verify it silently. A connection with no pin is refused, and a non-interactive (automated) run with no pin fails closed rather than prompting or trusting the key. A legitimately rotated key is never auto-accepted: verify the new fingerprint out-of-band and re-pin deliberately. The unsupported `certificate` and `known_hosts` fields are rejected at parse time. CLI `sftp` only. See `docs/CLI.md` and `docs/SECURITY_DESIGN.md`.
- Cross-party SFTP host-key reconciliation: in a recurring (authenticated) exchange the two parties now compare the host-key fingerprints they each observed, advertised inside the authenticated post-handshake exchange. A divergence -- which a purely local pin cannot catch -- raises a warning naming both observed values, flagging a possible one-sided interception or a server rekey between the two parties' setups for the operators to disambiguate out-of-band; it warns rather than aborts. A party that observes no host key (a file-drop or proxy path) reconciles to no false alarm. See `docs/spec/CHANNEL_SECURITY.md`.
- Untrusted invitation-token fields are bounded at decode (a 64 KiB cap plus per-field limits), closing a denial-of-service and an SSRF-shaped WebRTC-host vector from a crafted but checksum-valid token. See `docs/SECURITY_DESIGN.md`.
- Sensitive files (key file, config, exchange records, signing identity) are written owner-only, flushed to disk for crash durability, and created on a symlink-safe descriptor on POSIX. See `docs/SECURITY_DESIGN.md`.
- The linkage-result CSV is now written owner-only (mode 0600 on Unix, ACL-narrowed on Windows), so the tool's most sensitive output is no longer left world- or group-readable by the umask. See `docs/SECURITY_DESIGN.md`.
- Operator-facing logs, errors, and web console output escape untrusted partner- and server-controlled strings (filenames, rendezvous paths, identities, error messages), neutralizing terminal, bidi-override, zero-width, and homoglyph injection; values used to build paths or to compare are unaffected. See `docs/SECURITY_DESIGN.md`.
- A credential supplied as an `@path` reference is persisted as the reference, never the resolved secret. Loading a config you did not author runs its `@path` references as your own credentials -- a credential-exfiltration vector -- so never run an untrusted config. See `docs/CLI.md` and `docs/SECURITY_DESIGN.md`.
- `connection.provider_options` is applied through a default-deny allowlist, so it cannot override the security-critical connect options (host, credentials, host-key verification). See `docs/EXCHANGE_REFERENCE.md`.
- A peer sending messages out of turn is rejected rather than buffered without limit.

## [0.1.0] - 2026-05-08

Initial proof-of-concept release.

### Added

- Web application: browser-based PSI over WebRTC using ephemeral invitation links.
- Built-in PeerJS peer-coordination server in the web application, served under `/api/`.
- SFTP transport for recurring exchanges between two parties via the CLI.
- `exchange` CLI command: run an exchange over an SFTP connection and predefined linkage rules.
- PSI protocol implementation wrapping the OpenMined PSI WebAssembly module (`@openmined/psi.js`).
