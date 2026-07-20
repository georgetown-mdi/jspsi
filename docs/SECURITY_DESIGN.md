---
title: "PSI-Link Security Design"
---

# PSI-Link security

<!-- Adding to this doc? Keep it conceptual and operational. Constant values, byte/wire
layouts, algorithm steps, and their rationale belong in the spec tier: see
docs/spec/README.md, "Where does my content go?". -->

This is the security overview for security teams and compliance officers. It covers the threat model, the authentication design, and the channel-security controls at the level of what each protects against and why it is sufficient. It does not specify how they are built.

What lives elsewhere:

- The PSI and PSI-C algorithms and the wire-level key exchange: [PROTOCOL.md](spec/PROTOCOL.md).
- The channel-security constructions and constant values: [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md).
- The network channels exchanges run over: [COMMUNICATION.md](COMMUNICATION.md).
- CLI configuration for authentication: [CLI.md](CLI.md).

## Overview

PSI-Link protects an exchange with three layers.

1. **The PSI protocol protects the data itself.** Records are matched in encrypted form: each party encrypts its own linkage keys under an ephemeral key it never shares, and the protocol combines the two parties' keys so that neither side can recover the other's underlying values. Both learn only which records they hold in common. This holds regardless of which channel carries the traffic. See [Private set intersection](#private-set-intersection).

2. **Key-exchange authentication proves you are talking to the right partner.** For recurring exchanges the two parties hold a shared secret, established once out of band, and prove to each other that they hold it without sending it over the wire. The secret rotates after every successful exchange, so it is never reused. Authentication is a hard gate: if it fails, no data is exchanged. See [Authentication](#authentication).

3. **Transport encryption protects the data in transit.** An SSH/SFTP connection or a WebRTC (DTLS) link encrypts traffic on the network; a network-mounted share is protected by whatever transport and access controls the operator configures for it. For zero-setup exchanges, which carry no shared secret, this transport layer is the only protection, so trust rests on whoever administers the server or share. See [Channel security](#channel-security).

4. **Application-layer encryption protects from server snooping.** An additional layer, keyed from the key-exchange session, is applied to recurring (authenticated) CLI exchanges. Immediately after authentication the CLI wraps the connection in an authenticated encryption with associated data (AEAD), so every PSI frame is encrypted end to end and even the operator of an SFTP server or shared drive sees only ciphertext. It does not cover zero-setup exchanges (no session key) or the web application's application layer (not needed, as transport encryption is end-to-end). Also see [Channel security](#channel-security).

## Private set intersection

Private set intersection (PSI) is the primitive the privacy guarantee rests on. It lets two parties compute the records they have in common while revealing nothing about the records they do not.

The intuition is a layered, order-independent ("commutative") encryption. Each party holds an ephemeral key, generated for the exchange and never shared. Each side encrypts its own linkage keys under its own key, and the protocol applies the other party's key as a second layer, so a record is only ever seen by the other party in a form that party cannot decrypt. Because the scheme is commutative, two values that started equal stay equal once both keys are applied, which lets the parties recognize shared records by comparing encrypted forms alone. Neither side can strip the other's key to recover a plaintext value, and records outside the intersection are never revealed.

PSI-Link uses a lightly modified build of OpenMined's [PSI](https://github.com/OpenMined/PSI), which layers over Google's Private Join and Compute. The base function runs repeatedly over a sequence of linkage keys to build the association map between matched records. A cardinality-only variant, PSI-C, reveals the size of the overlap without revealing which members are shared; it is designed but not yet implemented.

Two properties of the primitive are not hidden, and both matter for the threat model that follows:

- **Set sizes are revealed.** The protocol exchanges each party's dataset size as envelope metadata. This is acceptable for linking administrative data, where membership and identity are sensitive but the size of a database is not.
- **The result is only as private as the linkage keys.** Because each party learns the linkage key for every shared member, a weak key (for example one built from a single identifier) can leak membership through a differencing or brute-force attack. Combining several PII elements into each key is what keeps "you learn only the overlap" a meaningful guarantee.

The algorithm itself (role assignment, the encryption and key-removal steps, the matching cascade, and the PSI-C design) is specified in [PROTOCOL.md](spec/PROTOCOL.md#psi-base-function).

## Threat model

PSI-Link is designed for partner agencies with signed data-sharing agreements. The primary goal is to prevent either party from learning anything about the other's data beyond the mapping between shared members. The model is honest-but-curious: it assumes partners are not actively tampering with inputs, but that minimizing what is disclosed is still worthwhile.

Each use of the base PSI function reveals information to each party. For PSI, this is the linkage key of each shared member; for PSI-C, the cardinality of the overlap. Linkage keys can therefore be chosen to reveal sensitive information through a differencing attack, so both parties must review the linkage keys before agreeing to use them.

Within the input-choice threat, a party can attempt a membership attack using crafted inputs. A linkage key built only from Social Security numbers, for example, would be easy to brute-force. Keys should combine several elements of personally identifiable information (PII). Even then a membership attack is possible, but only against a target whose PII is already known.

Separately from adversarial attacks, the protocol reveals each party's dataset size, accepted here for the reasons under [Private set intersection](#private-set-intersection).

One further property follows from how PSI roles are assigned. When both parties expect output, the sender/receiver assignment is a function of the record counts the parties exchange (see [PROTOCOL.md](spec/PROTOCOL.md#role-resolution-and-work-minimization)), and a reported count is not bound to a party's actual dataset. Under the single-pass strategy the sender discloses more than the receiver: its full per-key duplicate structure. A party that under-reports its count can therefore steer itself into the receiver role and its partner into the sender role. This tampers with a reported value rather than only observing, so it goes a step beyond honest-but-curious, and it is accepted rather than prevented.

Its effect is bounded. Single-pass is a strategy both parties agree to before any data is exchanged, and that agreement consents to its disclosure, so the manipulation only shifts which consenting party bears the sender-side disclosure, never whether it happens. A both-output cascade has no such asymmetry, and a one-sided-output exchange is unaffected because the receiver is fixed by entitlement. It is also not cheaply checkable: the manipulator becomes the receiver, whose true row count never appears in verifiable form (its traffic exposes only its distinct-value union), so the partner's only consistency bound is loose. Preventing it would mean discarding the work-minimizing role assignment or making single-pass disclosure symmetric, both of which cost more than a bounded shift in who bears an already-consented disclosure.

When public services facilitate scheduled exchanges, some metadata is leaked, such as who is conducting the exchange and when. Parties are encouraged to stand up their own services where necessary.

### Configuration-file trust boundary

A `psilink.yaml` is designed to be shared. It records `@path` references to credentials rather than the credentials themselves, so it carries no secrets and is safe to commit or send to a partner. That safety protects the file's author, not whoever later runs it. Loading a configuration you did not author is equivalent to running its referenced files as your own credentials: when an exchange runs, each `@path` reference is read from local disk with your privileges, and the resolved credential (in the CLI today, the SFTP password) is sent to the host the configuration names. A substituted configuration can therefore turn such a reference into a read of an arbitrary local file, a private key for instance, delivered to a host the author chose. Reaching this requires loading a wholesale attacker-authored configuration and running an exchange against it; it cannot arrive through an invitation, which carries no credential (see [Invitation contents and confidentiality](#invitation-contents-and-confidentiality)). Which fields are read, and how to treat a configuration from an untrusted source, are in [CLI.md](CLI.md#configuration).

### Single-party appliance trust boundary

The web application can run as a console appliance: a container that drives the party's own `psilink` exchange behind a server-side job API, so an operator runs a single exchange (config, secret, input, and results in one mounted working directory) without invoking the CLI by hand. This appliance serves one party, inside that party's trust boundary. It is never a shared rendezvous between the two parties, who still meet only over the exchange channel itself (a file-drop directory, an SFTP server, or the WebRTC rendezvous). The invariant is single-operator, and the design follows from it:

- **Dark by default.** The job API does nothing unless the deployment is a `console` build and a data root is configured. The hosted `apps/web` deployment leaves the profile unset and serves every job route disabled (`404`), so a misconfigured hosted deployment cannot expose the API. Outbound SFTP is separately gated: it exists only when the operator also provisions a single-server file, which is the appliance's entire network egress, frozen at startup.
- **One operator, no tenants.** The API carries no per-request authentication and no per-tenant isolation, because it answers only to its one operator. Its reach is bounded by the deployment, not an app-level check: container isolation, the operator publishing the port only to host loopback, and the host and agency firewall.
- **The server composes every CLI input.** The operator submits a typed, schema-validated intent, and the server builds every connection path, directory, and credential file from it. No client-supplied text reaches the CLI as an argument, path, or credential; for an SFTP exchange every connection field comes from the operator's provisioned-server file, so a run can only reach the one server the operator provisioned.
- **State is memory-only.** The job state lives in server memory and is never persisted; the console holds one exchange at a time, and a restart forgets it (there is no job listing or restore, and any in-flight run is cancelled rather than resumed). What survives a restart is the on-disk working directory of a completed job, which still holds that job's key file and config. A finished SFTP job's directory pairs the current (post-rotation) shared secret with a partner-reachable rendezvous locator, so delete it promptly after retrieving the result.
- **Mounted directories are trusted local data.** The operator is present at the host and mounts their own material: this party's input CSV, and the file-drop rendezvous directory. The only untrusted input is the remote partner's material arriving over the rendezvous channel, and the exchange protocol carries its confidentiality, integrity, authentication, and denial-of-service bounds (see [Channel security](#channel-security)). Because the rendezvous directory is partner-writable, dedicating it to a separate mount, not nested with the key, input, and results, is recommended; the appliance warns, but does not block, when the paths overlap.

Running SFTP from the appliance adds an outbound surface the file-drop path lacks. The provisioned server pins its host key, verified before any credential is presented, so redirected egress or DNS tampering yields a refused connection rather than a disclosed credential. Credentials are held as file references to operator-mounted secrets, read only by the CLI subprocess; inline secret values are refused at startup. Keeping the secret bytes out of the web server and its job files is accidental-exposure hygiene, not privilege separation: the subprocess runs as the same user, and a compromised server could read the mounted files directly.

What violates the invariant is any deployment that lets a second party reach the API. Publishing the port beyond host loopback, or fronting it with a reverse proxy that routes a second party to it, does exactly that, and because the API is unauthenticated any such exposure re-exposes it unauthenticated. The wire contract, the intent schema, the provisioned-server validation, the workdir modes, and the gate and startup rules are in [SERVER_JOB_API.md](spec/SERVER_JOB_API.md).

## Authentication

Before connecting, parties must confirm they are talking to the right partner. Recurring exchanges (see [User journey](DESIGN.md#user-journey)) use a pre-shared secret and an authenticated key exchange. Zero-setup exchanges rely instead on transport-layer authentication.

### Recurring exchange authentication

To share a secret, one party generates a random 32-byte token and sends it to their partner over a trusted existing channel such as secure email. At the start of the exchange, both parties run an authenticated key exchange: an ephemeral X25519 Diffie-Hellman keyed together with the shared secret and an explicit mutual confirmation (see [Key-agreement design](#key-agreement-design)).

The shared secret rotates after each successful handshake, before the data exchange begins. Both parties independently derive the same replacement token from the key-exchange session key, so no extra round-trip is needed, and each persists it immediately (the CLI writes it to the key file). If that write fails on one side, the two parties can end up holding different tokens; see [Out-of-sync tokens](CLI.md#out-of-sync-tokens) for recovery. Because rotation happens at the handshake, a failed data exchange still leaves both parties holding the rotated token, and they can retry without re-inviting. If a secret is lost after rotation, a new invitation regenerated from the existing configuration re-establishes one (see [Recovery](CLI.md#recovery)).

Invitation tokens carry a bounded lifetime. The default is 1 hour if the inviter sets none; `--expires-in` overrides it up to a maximum of one year. The ceiling is generous because recurring exchanges may run only monthly and an invitation may need to outlast months of operational breakage before a re-invite, but it is a hard bound, so an erroneous override cannot make a setup secret effectively permanent. Because the token rotates on first use, it is a one-time setup credential valid only between generation and acceptance, and the inviter can withdraw it early rather than wait out expiry (see [Online invitation](CLI.md#online-invitation) and [Abandoning a pending offline invitation](CLI.md#abandoning-a-pending-offline-invitation)). Withdrawing a pending invitation differs from the [Compromise response](#compromise-response) for a leaked token: it removes only the pending invitation's key material, not a configuration or a persistent recurring-exchange key. Replacement tokens from rotation carry no expiration by default; an operator who needs a maximum age sets [`token_max_age_days`](EXCHANGE_REFERENCE.md#authenticationtoken_max_age_days) (see [Token age and rotation policy](#token-age-and-rotation-policy)).

In the exchange specification (`psilink.yaml`), this is configured in a top-level `authentication` block, a sibling of the `signing` block rather than nested inside `connection` (see [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#authentication)). The two are kept as separate blocks because they have opposed lifetimes: the shared secret is symmetric, low-value, rotated every exchange, and cheaply re-invited, while the pinned signing certificate (see [Receipt signing identities](#receipt-signing-identities)) is asymmetric, stable for its whole life, and high-value. They already live in separate files on separate schedules. A future protocol version could let the signing identity subsume authentication, dropping the pre-shared secret, which is part of why `signing` earns its own top-level place.

#### Token format and entropy

The shared secret is a 32-byte value carrying 256 bits of entropy, whether minted from a CSPRNG for an invitation or derived from the key-exchange session key by rotation. Rotation derives the replacement deterministically from the session key both parties already hold, so it needs no extra round-trip, and the secret is never reused. The on-disk encoding and the rotation-derivation construction are in [PROTOCOL.md](spec/PROTOCOL.md#shared-secret-rotation).

#### Invitation contents and confidentiality

An invitation carries the linkage terms and the short-lived setup secret, and it may carry a connection endpoint: a public locator (a PeerJS signaling URL, an SFTP host and port, or a file-drop directory) telling the acceptor where to rendezvous. A locator names a meeting point, not a way to authenticate at it, so it is not a secret. The schema enforces that the endpoint carries no password, private key, key file, PeerJS API key, or server-identity material such as an SSH host-key fingerprint; an invitation carrying any such field is rejected when decoded. Connection credentials are therefore never transmitted in an invitation; each party configures its own.

On the web, the inviter derives the linkage terms from its own data file rather than authoring them by hand (see [COMMUNICATION.md](COMMUNICATION.md#web-invitation)). The terms reflect the inviter's column _shape_ (which default field types the file carries) but never a row _value_; the file is read in the browser and never uploaded. This is presence-only disclosure to the recipient, who must hold matching columns to link at all. Where the inviter discloses payload columns, the terms also embed those columns' _names_ as a data dictionary the recipient consents to; the names are those of columns whose values that recipient already receives on a match, so naming them discloses nothing beyond what the match gives, and still no row value is carried.

The decoder also bounds the size and complexity of every attacker-influenceable invitation field: per-field size caps (the 4-byte checksum detects transcription errors only and is no barrier to a crafted payload), a linear-time regex dialect for partner-supplied transform patterns so a catastrophic-backtracking (ReDoS) pattern cannot hang the acceptor, and caps on transform parameters that would otherwise drive unbounded per-row work. Each is defense-in-depth set far above any legitimate invitation, and each fails closed before any row is processed. The per-field caps, the regex dialect, and the parameter ceilings are in [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#application-layer-parsed-input-bounds) and [PROTOCOL.md](spec/PROTOCOL.md#transform-regular-expression-dialect).

The invitation must nonetheless be treated as confidential, because it carries the setup secret an attacker needs to authenticate as you. In the web rendezvous flow both parties derive the coordination-server rendezvous id from that secret, so an attacker who obtains the invitation learns both the authentication secret and the rendezvous id, and could reach the meeting point first to attempt a man-in-the-middle before the intended partner arrives. In that flow the inviter's browser also holds the secret in page memory for the tab's lifetime, the same in-origin exposure as the encoded invitation the page already displays for copying (a same-origin script able to read one could read the other); the secret is never sent to a backend. This is the standard out-of-band trust model: forward invitations only over a trusted channel such as secure email, and treat a leaked invitation as a compromise by generating a fresh one (see [Recovery](CLI.md#recovery)) rather than reusing it.

#### Recurring web exchanges: single-use vs managed

The web application supports the same rotating shared secret the CLI does, but the two web flows treat its persistence oppositely, and the difference is a threat-model boundary, not an implementation gap.

A **one-shot** web exchange is single-use. It runs the authenticated key exchange and derives the rotated replacement secret exactly as the CLI does, then discards it: the browser holds no key-file analog, so nothing sensitive survives the tab and the exchange cannot run again. This is the conservative default.

A **managed** web exchange instead persists the rotated secret (with the standing terms and the credential-free rendezvous locator) in browser storage, so the same partnership can run again on a schedule, unattended where the platform allows (see [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md)). Persisting a rotating credential at rest changes the threat model, which is why the managed lifecycle is security-review-gated. Its persistence is bounded by three properties: the secret is written durably before this party begins the data exchange (persist-before-success), so a crash cannot advance the exchange while the new secret exists only in memory; the secret is a linear resource owned by a single device, so two copies cannot fork it; and the browser at-rest posture is deliberately weaker than the CLI's on-disk key (see [Hosted at-rest threat model for managed exchanges](#hosted-at-rest-threat-model-for-managed-exchanges)). The record's field-by-field shape is in [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md).

Both flows share one property: neither sends the secret, the terms, or the input data to a server. The one-shot flow discards the secret; the managed flow persists it only in origin-isolated browser storage. For the app's own code this holds by design and review; the limits against an injected script are stated under [Egress hardening and its limits](#egress-hardening-and-its-limits).

### Key-agreement design

Recurring exchanges derive their session key from an ephemeral X25519 key exchange, keyed together with the pre-shared secret and an explicit mutual confirmation, rather than the customized SPAKE2 PAKE used in earlier builds. The secret is high-entropy (a 256-bit token, not a human password), so a PAKE's one distinctive property, resistance to offline guessing, is unused; the properties that matter here, forward secrecy and mutual authentication, are preserved by ephemeral X25519 plus a secret-keyed confirmation, and the change sheds the largest hand-rolled-crypto surface in the system. The limit is the same as for any secret-authenticated design: a leaked secret permits active impersonation until it is rotated out, and forward secrecy buys only that a recorded transcript stays confidential if the secret later leaks.

The construction follows the Noise NNpsk0 pattern over X25519 with an added explicit, role-asymmetric key confirmation, following NIST SP 800-56A; its primitive comes from a well-respected, ideally audited library, and the full Noise framework is never hand-rolled. The wire-level specification and the SPAKE2-to-X25519 migration are in [PROTOCOL.md](spec/PROTOCOL.md#x25519-authenticated-key-exchange). The CLI cut over first and the web application has since adopted the same handshake; the cutover is a breaking change between builds, taken before 1.0, with future interop kept open by the handshake's version discriminant.

The pre-shared secret remains the baseline authentication anchor: low setup friction, and no organizational PKI for the bilateral-agency case. A certificate-chain, authority-backed mode is left open by that same version discriminant (see [Pinned self-signed trust model](#pinned-self-signed-trust-model)). The switch also carries a compliance upside: Ed25519 signatures are NIST-approved (FIPS 186-5) and the curves are NIST-specified (SP 800-186), where the bespoke SPAKE2 could not be FIPS-validated, which is material for a FIPS-validated build and agency ATO review.

### Transport-layer authentication

Transport-layer authentication is the defined path for zero-setup exchanges. It is not an option for recurring exchanges: the `exchange` command requires a key file (`.psilink.key`) and aborts if one is absent.

Zero-setup exchanges rely on the transport (DTLS for WebRTC, SSH for SFTP, and commonly SMB or krb5p for file-drops). For an SFTP connection or a network-mounted file-drop, user and path management on the server limit who can listen in, which offloads trust to the server's administrator to keep the directory specific to the exchange. This path may be preferable when managing an extra encryption key is too burdensome, though it is less secure overall. Parties who want a persistent shared secret can bootstrap one (see [Bootstrapping a shared secret](#bootstrapping-a-shared-secret)).

On the SFTP channel the server's identity can be pinned. When an operator sets `connection.server.host_key_fingerprint` to the server's OpenSSH SHA256 host-key fingerprint, every connection verifies the presented host key against the pin before authentication and aborts on a mismatch, so a man-in-the-middle or substituted server is detected rather than silently trusted. The fingerprint is non-secret and is pinned out of band, exactly as the shared secret and signing fingerprint are; the invitation endpoint cannot carry it (see [Invitation contents and confidentiality](#invitation-contents-and-confidentiality)), so an attacker who seeds a configuration cannot pin their own key. An operator who cannot obtain the fingerprint out of band can establish it on a deliberate first connection, ssh-style: an interactive run shows the presented fingerprint, asks the operator to confirm, and pins it, after which subsequent runs verify it silently. The no-pin default is fail-closed: a connection with no pin and no first-use confirmation is refused, and a non-interactive run with no pin fails rather than prompting or silently accepting. (A zero-setup run without `--save` trusts the key for that one exchange only and persists nothing, so it confirms again next time.) A rotated key is never auto-accepted; the operator verifies the new fingerprint out of band and re-pins. This applies to the CLI `sftp` channel only: a file-drop makes no SSH connection, and the web path does not run the host-key check. The construction is specified in [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#sftp-host-key-verification).

Pinning is each party's local decision, so on its own it cannot catch a one-sided interception (one party pins an attacker's key, the other pins the real key, and the two views are never compared) or a server rekey between the two setups. For recurring exchanges the parties therefore reconcile: each advertises the host-key fingerprint it observed inside the authenticated post-handshake exchange, and a divergence raises a warning naming both values for the operators to disambiguate out of band. The check rides the authenticated channel, so the advertised fingerprint cannot be forged by an unauthenticated party; a party that observed no host key (a file-drop or proxy path) reconciles to no divergence rather than a false alarm.

### Bootstrapping a shared secret

Parties who want to move from a zero-setup exchange to a recurring one can save the parameters from the zero-setup invocation (see [Zero-setup exchange](CLI.md#zero-setup-exchange)). Because this affects key generation, each party advertises the intent to the other at the start of the exchange.

| Party A | Party B | Outcome                                                                                                                                                              |
| ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _save_  | _save_  | The initiator generates a fresh shared secret and sends it to the responder; both save it as the basis for future recurring exchanges, along with their configurations. |
| _save_  | _none_  | No secret is generated. A's configuration is saved, and A is told the partner did not choose to save and is directed to invite B to establish a recurring exchange. |
| _none_  | _none_  | Standard zero-setup exchange; nothing is saved.                                                                                                                     |

The save intent rides the linkage-terms exchange, the one round-trip both parties always perform, so each side learns the other's intent even when it advertised none, and a one-sided save never stalls. When both save, the initiator generates a fresh 32-byte secret (the same format and entropy as a rotation token) and sends it to the responder on a dedicated in-band message.

That secret is protected only by the transport layer (SSH, DTLS, or operator access controls for a file-drop), because a zero-setup exchange has no key-exchange session key and so no application-layer AEAD to wrap it. This is an accepted trust model: bootstrapping with `--save` rests on the same transport trust as the zero-setup exchange that carries it, for that one initial exchange. A party unwilling to trust the transport with the secret should use `psilink invite` instead, which never sends the secret through the exchange server. After this first exchange the secret rotates on every subsequent exchange and is never reused.

In `--retain-files` mode the receiver does not delete exchange files after consuming them, so the message carrying the secret persists as a cleartext file in the shared directory until removed by hand. This does not cross the trust boundary above (the operator who holds that directory already sees the secret in transit), but it extends the exposure from in-transit to at-rest. A party bootstrapping with `--save` should avoid `--retain-files` for that exchange, or clear the shared directory once the secret is saved on both ends.

## Key file security

`.psilink.key` holds the shared secret that authenticates recurring exchanges. Treat it as a credential, with the same care as a private key or password.

### Required permissions

The CLI writes `.psilink.key` owner-only (`0600` on Unix, an owner-only ACL on Windows) through an atomic, symlink-hardened, durably-flushed write path, so a crash cannot leave a half-written or world-readable key. On Windows, if the owner-only ACL cannot be applied (for example in a restricted container), no key material is written and an error is raised. The CLI warns on load if an existing key file is over-permissive: on Unix if any group or world permission bit is set, on Windows if a non-owner principal can read it. Correct it before running further exchanges:

```sh
chmod 0600 .psilink.key
```

On Windows, correct an over-permissive ACL with:

```cmd
icacls .psilink.key /inheritance:r /grant:r "%USERDOMAIN%\%USERNAME%":(M)
```

On macOS a file can additionally inherit an extended (NFSv4) ACL that a `0600` mode does not remove, granting another principal access; this affects every owner-only artifact (the key file, signing identity, exchange records, and result CSV). Check with `ls -le` and clear an unexpected entry with `chmod -N <file>`. Before a recurring exchange the CLI verifies the key file can be written, because a write that fails after the handshake has rotated the secret can desynchronize the two parties' tokens. The byte-level write construction and the platform caveats are in [CREDENTIAL_STORAGE.md](spec/CREDENTIAL_STORAGE.md).

**Result CSV output.** The matched-records CSV that `psilink exchange` writes to an output path, the most sensitive artifact the tool produces, is created owner-only on the same principle as the key file, before any rows are written. Writing the result to stdout applies no permission handling: a shell `>` redirect leaves the file at the shell umask, since the shell, not the CLI, creates it. The CLI detects a redirected-regular-file stdout and prints a notice naming the exposure and the output-path alternative (a TTY, a pipe, or `/dev/null` does not trigger it). That check sees only this process's own stdout, so a redirect applied outside it is not detected. Pass an output path to get the owner-only treatment. The CSV write construction is in [CREDENTIAL_STORAGE.md](spec/CREDENTIAL_STORAGE.md#result-csv-output).

### What not to do

- Never commit `.psilink.key` to version control. Add it to `.gitignore`:
  ```
  /.psilink.key
  ```
- Never transmit the token over an unencrypted channel. If it must be copied between machines, use an encrypted transfer (for example `scp`, SFTP, or a secrets manager API).
- Never log or display the token in plaintext. Keep `--key-file` content out of bug reports and support tickets.
- Never store the token in environment variables visible to child processes or process listings.

### Backup

Tokens may be backed up to a secrets manager or encrypted store (for example HashiCorp Vault, AWS Secrets Manager, or an encrypted filesystem). Any backup must carry the same access restrictions as the original: owner-read-only or the equivalent ACL. If no backup exists and a token is lost, re-invitation is the correct recovery (see [Recovery](CLI.md#recovery)).

### Compromise response

If a token is believed compromised (observed in a log, a process listing, a shared filesystem, or in transit on an unencrypted channel), treat it as invalid immediately:

1. Notify the partner out of band before any further exchanges; their copy may also be exposed.
2. Both parties delete their key files (`.psilink.key`).
3. Re-invite over a channel known to be uncompromised. An observed token stays valid until the next successful exchange rotates it out, so close the window between observation and deletion as quickly as possible.

### Token age and rotation policy

Tokens rotate automatically on every successful exchange. By default there is no system-enforced maximum age: an organization with its own rotation policy can treat each exchange as the rotation event, and a frequently-exchanging partnership never accumulates a stale token.

The optional `token_max_age_days` field (in the [`authentication`](EXCHANGE_REFERENCE.md#authenticationtoken_max_age_days) block) makes the age bound system-enforced. When set, each successful exchange stamps an `expires` that many days onto the rotated token, and the next `psilink exchange` enforces it: an expired token aborts the run before any connection, with an error that names the expiry and directs both parties to re-invite; a token near expiry produces an "expiring soon" warning, shown only when no successful exchange has refreshed it. This matters most for a dormant partnership, where a monthly cadence or holiday gap could otherwise hold a valid token for months. The enforcement sites and thresholds are in [PROTOCOL.md](spec/PROTOCOL.md#expires-enforcement-and-the-expiring-soon-advisory).

Both sides set the policy independently; it is not negotiated. If one party enforces a maximum age and the other does not, the enforcing party refuses to exchange once its token lapses, exiting with the re-invite error; to the other party this can look like a silent peer or a key-exchange failure, and the same recovery (re-invite) applies. A misspelled key is rejected at config-parse time, so a typo cannot silently disable the control (see [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#authentication)). As net-new security behavior, the enforcement is subject to the explicit security review required by [CONTRIBUTING](../CONTRIBUTING.md#dependency-policy) before release.

#### Two sources, one `expires`

Two mechanisms write the single `expires` field: an invitation's bounded setup lifetime (default 1 hour) and the `token_max_age_days` policy. psilink stores both with one meaning to every consumer (the instant after which the token must not be used) and one recovery when it lapses (re-invite), and does not record which mechanism set the value, because no decision differs by origin. One visible consequence: an invitation token loaded while a max-age policy is in force can be flagged "expiring soon", which is accurate and correctly actionable either way. The kind-agnostic enforcement sites and rationale are in [PROTOCOL.md](spec/PROTOCOL.md#expires-enforcement-and-the-expiring-soon-advisory).

## Channel security

Server administrators can see exchanges conducted over SFTP and file-drops, so the baseline protection on those channels is the transport itself (SSH for SFTP; the operator's access controls for a file-drop). For authenticated, recurring exchanges an application-layer of encryption closes that visibility. Whether it applies is negotiated in the key exchange: each party declares a request-encryption flag, and both wrap the connection when the negotiated decision (`own request OR peer request`, transcript-bound) is set and a session key was derived. The rule is that the application AEAD applies exactly when the transport is not already end-to-end confidential against the in-path party and a session key exists. File-sync transports (SFTP, file-drop) request it unconditionally, because the server admin can snoop the transport; a transport already confidential against any in-path party (WebRTC over DTLS) requests it only when that confidentiality is broken, under a DTLS-terminating WebSocket relay (below). The CLI requests it on every file-sync exchange, so the SFTP or file-drop admin sees only ciphertext. The AEAD construction is in [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md). Zero-setup exchanges carry no session key and run under transport encryption alone; the web application's application layer is likewise still cleartext, relying on the WebRTC DTLS transport described below.

Beyond confidentiality, the file-sync channels are hardened against a hostile server admin along two axes, memory exhaustion and liveness, plus crash-safety and a parked-peer concern. Each is specified with its constant values in [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md).

- **Application-layer integrity, replay, and gap detection.** The AEAD decorator validates and decrypts each inbound frame, rejecting any integrity, replay, reordering, or mid-stream-gap failure as a `security` error at the protocol layer. Truncated-tail detection is a deliberate deferral, resting on the matching loop's self-driven lockstep.
- **Inbound frame-size bound.** A hostile server could otherwise write an arbitrarily large file that is read and parsed before any integrity check, exhausting memory; the transport refuses an oversized inbound frame before reading it.
- **Directory-listing bound.** The same memory-exhaustion impact reached by directory enumeration (many files, or very long filenames) is bounded by caps on entry count and name length, enforced as the listing streams in.
- **Liveness bounds.** A hostile server can hang an operation instead: withhold a callback, flood empty listing batches, or trickle bytes forever. Per-operation deadlines and idle windows fast-fail each read and write; a whole-exchange budget backstops every transport await; and a connect-probe bound covers the one call outside that budget. All surface as a `UsageError` subclass that every transport consumer treats as terminal.
- **SFTP fatal-packet crash safety.** A malformed SFTP reply packet would otherwise crash the CLI before its orderly cleanup; a guarded error listener turns it into a handled failure.
- **Authenticated abort marker.** A party that fails terminally writes an authenticated `<id>-abort.json` so a parked peer fails fast instead of waiting out the full inactivity budget. The token is keyed from the session key, so a hostile admin cannot forge an abort against a live peer.

All of these are net-new security behavior subject to the explicit security review required by [CONTRIBUTING](../CONTRIBUTING.md#dependency-policy) before release.

WebRTC connections use DTLS for end-to-end encryption, so the peer-coordination server never sees data-channel traffic. A TURN relay preserves this: it forwards encrypted DTLS packets without terminating the session. The web application no longer offers a secret-less (zero-setup) WebRTC rendezvous; every web exchange runs the X25519 authenticated key exchange immediately after the data channel opens, so a wrong or expired secret fails closed before any PSI frame. A WebSocket relay is a rarer fallback used when a firewall blocks TURN; unlike TURN it terminates DTLS and sees plaintext, so it is the one in-path party against which the WebRTC transport stops being end-to-end confidential. This is what the applicability rule keys off: WebRTC declines the application AEAD in the ordinary case and requests it only under a WebSocket relay. In that case a recurring exchange (with a session key) negotiates the AEAD wrap, and a zero-setup exchange (no session key) aborts rather than expose data to the relay. The web application does not yet implement the relay wrap; it would be enabled together with WebSocket relay support.

The peer-coordination server is untrusted by design and relays only opaque rendezvous-setup messages, so the residual concern on its WebSocket surface is resource exhaustion and nuisance, not access to any party's data: rendezvous ids derive from the out-of-band invitation secret and the two browsers run the authenticated key exchange directly, so an unauthenticated connection can neither target nor read an exchange. Because the web app ships the signaling server itself (internet-facing in production, gated only by the well-known default key), its inbound parse is reachable by any client, so the upgrade surface is hardened in the application regardless of deployment: a bounded handshake timeout, a per-message size cap enforced before parsing, two-tier liveness reaping, and bounded relay queues. Origin restriction and per-address rate limiting depend on the real client origin and address, which only a reverse proxy sees, and are the proxy's responsibility (see [DEPLOYMENT.md](DEPLOYMENT.md#hardening-the-signaling-surface)). The constant values are in [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#web-signaling-surface-bounds).

The web app also sets a small set of defense-in-depth HTTP headers on every response its server entry returns, through one chokepoint and regardless of deployment; static public assets and the signaling WebSocket upgrade bypass that entry and need none of them. `Referrer-Policy: no-referrer` keeps the confidential invitation token out of the `Referer` header (the token rides in the URL fragment, which modern browsers already withhold, so this hardens older-client behavior). `X-Frame-Options: DENY` and the Content-Security-Policy `frame-ancestors 'none'` deny framing (clickjacking) for legacy and modern clients. `X-Content-Type-Options: nosniff` stops MIME-sniffing away from a declared `Content-Type`. These complement the proxy-set `Strict-Transport-Security` covered in [DEPLOYMENT.md](DEPLOYMENT.md#hardening-the-signaling-surface).

### Console and log hygiene

The web client keeps its derived rendezvous ids out of the production browser console: PeerJS runs at errors-only, and the ids are logged only at a `debug` level production does not enable. A per-session diagnostic toggle raises verbosity for one browser through a log function that redacts the ids first, and the app strips ids from the `Error` objects PeerJS emits on a connection failure. This is best-effort console hygiene and defense-in-depth, not a primary control: an attacker who holds the invitation already holds the secret the id derives from. Raised verbosity also surfaces SDP/ICE detail carrying local private IPs, flagged to testers in [DEPLOYMENT.md](DEPLOYMENT.md#diagnosing-web-connection-failures).

Separately, psilink escapes untrusted partner- and server-controlled strings at every operator-facing display boundary (CLI log and error output, and the web console and alerts) through shared display-sanitization helpers. The threat is that a hostile or misconfigured partner or server controls strings reaching an operator's terminal or log (filenames, a rendezvous host and path, a self-asserted identity, abort reasons, and spans some libraries quote inside an error), which rendered raw would allow terminal control-sequence injection, homoglyph spoofing, and forged log lines. The rule is escape-at-display, compare-raw: only the displayed copy is escaped, while every value used for a path, equality, or hash comparison is kept byte-exact. The same seam keeps the operator's own secret-bearing files (config, key file, signing identity, and imported terms documents) from echoing a credential into an error or log. First-party web console sinks that once carried raw partner bytes are gated behind the per-session diagnostic flag, so a production console carries none. The byte-level escape format is in [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#display-sanitization-escape-format).

## Hosted at-rest threat model for managed exchanges

A managed web exchange persists a rotating shared secret in the browser (see [Recurring web exchanges: single-use vs managed](#recurring-web-exchanges-single-use-vs-managed)), where the one-shot flow discards it. This section is the at-rest threat model for that persisted secret. Its posture: the browser at-rest secret is weaker than the CLI's on-disk key file, deliberately and by necessity, and the design does not present them as equivalent. The record shape is in [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md); the operational lifecycle is in [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md).

### Why the browser at-rest secret is weaker than the CLI on-disk key

The CLI's `.psilink.key` is protected by the operating system's file-permission model (owner-only, atomic, durable; see [Key file security](#key-file-security)), so another local principal cannot read it. A browser origin has no comparable primitive. The persisted secret lives in IndexedDB, readable by any script that runs in the origin: there is no owner-only mode and no separation between code that uses the secret and code that can read it. The app's own code must read the secret to run an exchange, so any code running in the origin, including an injected script (an XSS), can read it too. This extends the same in-origin exposure the one-shot flow already accepts for the in-memory secret from the lifetime of a tab to the lifetime of the stored record.

Unattended operation caps the protection further. Managing an exchange means running it again later without a human present to supply a passphrase, so any at-rest encryption keyed by material the app itself holds protects only against an attacker who reads the raw store bytes but cannot run in the origin (a disk-image or backup thief), not the in-origin script above, which can use the same decrypt path the app does. At-rest encryption of the managed secret is therefore secondary hygiene, not a primary control.

### The primary controls

Because at-rest encryption cannot be the primary control for an unattended secret, the primary controls bound and recover from exposure rather than prevent a read:

- **Rotation bounds the exposure window, for an exchange that runs.** The secret rotates after every successful run and is never reused, so a secret read from the store is only the current one and is invalidated by the next successful exchange. Rotation is bounded by cadence, though: it happens only when the exchange runs, and the headline managed case is a monthly or dormant partnership. For an idle exchange rotation bounds nothing.
- **Fast re-invite is the recovery.** A suspected compromise or a desync is recovered by re-inviting, which the managed exchange makes cheap by retaining everything a re-invite needs except the secret: the terms and the rendezvous locator (see [Desync detection and recovery](MANAGED_EXCHANGE.md#desync-detection-and-recovery)). This is the same recovery the CLI uses for a lost token.
- **A max-token-age caps stale-token risk, and is the only cap for a dormant exchange.** The browser analog of `token_max_age_days` stamps an `expires` onto the rotated secret, so a managed exchange with the policy set does not hold a usable secret indefinitely when it goes dormant. Like the CLI's, it is operator-set and off by default, so a dormant stored secret has no automatic exposure bound unless the operator opts in.

At-rest encryption of the browser store sits beneath these three as defense-in-depth. The export artifact makes the same call explicit: it is a plaintext credential file under operator custody, the CLI key file's trust model (see [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#export-artifact)).

### Rollback: at-rest copies can silently resurrect

The rotating secret's linearity is maintained by the parties' behavior, not by recorded state: the managed record keeps no rotation epoch or history, and the handshake gives a party no way to recognize that its peer holds a superseded copy. Anything that snapshots the record (the export artifact, a browser-profile backup, a VM snapshot, a duplicated file) can therefore silently re-arm the secret it captured. If that secret is still current, the copy is a live credential: treat a captured export exactly as a captured token under [Compromise response](#compromise-response), because it stays usable until the partnership rotates past it, which a dormant partnership may not do for months. If the partnership has already rotated past it, a restored copy instead produces a desync at the next run, indistinguishable to the partner from an attack (see [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#desync-detection-and-recovery)). A monotonic rotation epoch carried in the record and checked in the handshake would let a party detect a stale or forked peer; it is deferred future core hardening.

### Metadata at rest: presence and shape

The secret is not the only thing the record persists. A managed record also holds the partnership's existence, the operator's label, the agreed terms' column shape and disclosed payload column names, the rendezvous locator, the run schedule, and the run outcomes, which the one-shot flow never left at rest. To any reader of the store (an in-origin script, or whoever holds a disk image or backup) this is presence-and-shape disclosure: it reveals that these two organizations link data, on what schedule, and over which categories of fields, never a row value, but more than the one-shot flow disclosed. None of the secret-centric controls reduce it; it lasts as long as the record and is removed only by deleting the managed exchange (see [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#deleting-a-managed-exchange)).

A persisted input-file handle broadens the reach. Where the record holds a `FileSystemFileHandle` with persistent read permission (the unattended path), it discloses the input file's name, and the granted permission lets an in-origin script read the file's current contents through the handle without the operator present. That read path has content only while a file dwells at the path, so removing or moving the file after a run leaves the handle pointing at nothing readable; combined with the refresh workflow, the input file need exist only around the run window (see [The input file each run](MANAGED_EXCHANGE.md#the-input-file-each-run)). That practice is optional operator hygiene; the app neither enforces nor automates it. The primary control against the in-origin adversary remains preventing script injection, alongside deleting the exchange, which drops the handle with the record.

Two constraints keep the record shape bounded: the operator label is length-capped and should not carry sensitive counterparty detail beyond naming the partnership, and the run and schedule bookkeeping is structured enums, timestamps, and durations rather than free text. The persisted exchange-file document does carry other operator-authored free text (a column description, a standardization step's parameters, a retention note, and the agreed terms' description and purpose strings), authored locally with no partner-controlled value in them. The content guidance is the label's: keep row values and sensitive counterparty detail out of authored descriptions and cleaning parameters. The field names and bounds are in [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md).

### Egress hardening and its limits

The web app's posture is that a managed exchange's secret, terms, and input data never reach a server. What backs that claim differs by adversary.

For the app's own code, the property holds by design and review. No first-party path uploads the secret, the terms, or the input file: the input CSV is read in the browser and never sent, and every managed-exchange write lands in origin-isolated browser storage. This is a reviewed property of the codebase, upheld by the security review that gates the managed lifecycle, not a browser-enforced one.

Against an injected in-origin script the property is not mechanically enforceable, and the design does not claim it is. A planned Content-Security-Policy `connect-src` allowlist (the app origin plus the exact signaling endpoint) would govern programmatic non-WebRTC egress (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, beacons) and block the common exfiltration channels an injected script reaches for first. It cannot govern the negotiated WebRTC peer/relay transport: no shipped CSP directive can allowlist STUN/TURN hosts or peers, so an in-origin script could open its own peer connection and exfiltrate over a data channel regardless of `connect-src`. Downloads, clipboard writes, and navigations are likewise outside it. The allowlist is therefore hardening that narrows the injected-script exfiltration surface, not a complete barrier; the primary control against in-origin script remains preventing injection. A first-party runtime egress guard is not a substitute, because an in-origin attacker bypasses first-party code, so no complete in-origin barrier exists. As net-new security behavior that persists a credential at rest, the whole managed lifecycle is subject to the explicit security review required by [CONTRIBUTING](../CONTRIBUTING.md#dependency-policy) before release.

## Receipt signing identities

A certificate-backed receipt is third-party-verifiable proof that a specific data set flowed between the two parties (see [PROTOCOL.md](spec/PROTOCOL.md#signing-identity-and-certificate-pinning)). That verifiability rests on a long-lived signing identity per party: an Ed25519 keypair and a self-signed certificate carrying the party's `identity`. This is separate from the shared secret, which rotates every exchange; the signing key must instead be stable for its whole life, because a partner pins its certificate fingerprint once and every later receipt must verify against the same key. The two are kept in separate files with separate lifecycles.

A receipt proves narrowly. It evidences only that a specific data set flowed between these two parties, third-party-verifiably in the certificate-backed mode. It does not prove where either party's data came from, that the data is accurate, or that either party met a legal or contractual duty.

### Custody and persistence

The signing identity is persisted in its own file (default `~/.psilink/signing-identity.json`), separate from the per-directory `.psilink.key` and `psilink.yaml`, because one identity is reused across every exchange and partner. The file holds the private key and is protected exactly as the key file is: owner-only via the same atomic write path, with the same over-permissive-permissions warning on load (see [Required permissions](#required-permissions) and [CREDENTIAL_STORAGE.md](spec/CREDENTIAL_STORAGE.md)). It is a longer-lived, higher-value secret than the rotating shared secret, so give it at least the same care: do not commit, transmit in cleartext, or log it.

`psilink fingerprint` creates the identity lazily on first use and loads it thereafter; creation is announced, never silent. Regenerating it is a deliberate, separate action (`--force`) that warns it invalidates any fingerprint a partner has already pinned.

### Pinned self-signed trust model

Trust in a partner's signing key is established by pinning its certificate fingerprint out of band, exactly as the parties exchange the invitation and shared secret, not by validating a certificate-authority chain. A self-signed certificate vouches only for possession of its own key, so the out-of-band fingerprint is the trust anchor: a partner certificate is trusted only if its self-signature verifies and its fingerprint matches the pinned `signing.partner_fingerprint`, and a receipt is accepted only if its asserted identity exactly matches the one the certificate binds. The fingerprint is a hash of a public certificate, so it is not secret; the out-of-band channel must be authentic but need not be confidential. This is the SSH-host-key / certificate-pinning model.

This model was chosen for v1 over full X.509 and a certificate authority. The use case is bilateral and mutually coordinating, so the parties can exchange a fingerprint the same way they exchange a secret, which is exactly where pinning fits and where the large PKI surface (chain building, name constraints, revocation) would be cost without benefit. Representing the certificate as a small canonical-JSON document signed over its RFC 8785 bytes also reuses the project's single canonicalization primitive rather than adding an ASN.1/DER parser.

This decision is deferred, not foreclosed. An authority-backed mode (an agency using its own CA) is a recognized future need: the certificate's `version` is a format discriminant, the `algorithm` field admits other signature schemes, and the receipt-verification path is written around "is this key trusted, and does it authorize this identity?", where "trusted" is satisfied by a pin today and could be satisfied by chain validation later. Adding it is additive work, tracked for when a concrete partner requires it rather than built speculatively.

## Canonical encoding

The self-attested record's commitments, the agreed-terms hash both parties compute, a signing certificate's fingerprint, and the signed exchange receipt are each hashed or signed over a byte string. For any of these to verify, every party that produces or checks one, including an independent third party re-deriving it later from a different implementation, must derive exactly the same bytes from the same logical object. Ordinary JSON does not guarantee that: two correct serializers can differ in key order, number formatting, or type handling, and any such difference makes a signature or commitment fail to verify against content that is in fact identical.

PSI-Link closes that gap with a single canonical encoding, reused for every hashed or signed artifact, so that "these hash equal" reliably means "these are the same object". The normative byte definition, the standard it follows, the value domain, the encoding rules, and the cross-implementation test vectors are in [CANONICAL_ENCODING.md](spec/CANONICAL_ENCODING.md).

## Data handling

PSI-Link uses the identifying fields only to compute the intersection: it does not send them to the partner, write PII to logs, or retain PII outside the configured output file. After matching, each party transmits the payload columns it designated for disclosure (see **Output** below).

**Protocol messages.** During matching, the data crossing the wire is cryptographic protocol messages (elliptic-curve points) plus non-identifying match bookkeeping (encrypted-set indices and association tables); raw identifier values never cross. On recurring (authenticated) CLI exchanges these are wrapped in AEAD ciphertext by the application-layer encryption (see [Channel security](#channel-security)); on zero-setup exchanges and the web application's application layer they cross under transport encryption only. The PSI guarantee ensures each party learns only the existence of shared members, with records outside the intersection never revealed. After matching, a payload-exchange phase transmits the raw values of the payload columns each party designated, for matched rows only; by default the identifying columns used for matching are linkage-only and are not among them.

**Third parties.** No PII is transmitted to any third party. The peer-coordination server used by the web application's WebRTC channel sees only connection metadata (peer IDs) and has no visibility into data-channel traffic (see [Channel security](#channel-security)). SFTP and file-drop channels use operator-managed infrastructure.

**Logging.** PSI-Link does not write PII to log output. Operational logging is limited to non-sensitive metadata: the runtime resource ceilings logged once per exchange (Node version, host memory, the V8 heap limit, and any container memory limit), exchange timing, transport errors, and protocol state transitions. Review log output before forwarding it to a third-party logging service.

**Output.** The output each party writes pairs its own row identifier (a database identifier from its input, or the row index when it has none) with the matched partner records and the payload columns the partner disclosed. The identifying fields used for linkage are not part of it. Each party joins its identifier column back against its dataset to recover the matched rows, and handles the written output under its applicable data governance policies.

## Regulatory compliance

The NIST SP 800-53 Rev 5 control mapping and Section 508 accessibility status are documented in [COMPLIANCE.md](COMPLIANCE.md).

## See also

The spec-tier counterparts that specify how these controls are built:

- [PROTOCOL.md](spec/PROTOCOL.md) - the PSI/PSI-C algorithms and the X25519 key-exchange wire format
- [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md) - the AEAD construction, transport bounds, signaling-surface bounds, and display-sanitization format
- [CREDENTIAL_STORAGE.md](spec/CREDENTIAL_STORAGE.md) - the owner-only on-disk write path for the key file, signing identity, and result CSV
- [CANONICAL_ENCODING.md](spec/CANONICAL_ENCODING.md) - the RFC 8785 byte encoding receipts and commitments are computed over
- [SERVER_JOB_API.md](spec/SERVER_JOB_API.md) - the console appliance's server-side job API
- [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md) and [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md) - the managed exchange lifecycle and its persisted record
- [COMPLIANCE.md](COMPLIANCE.md) - the NIST SP 800-53 control mapping and Section 508 status
