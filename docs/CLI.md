---
title: "PSI-Link CLI"
---

# PSI-Link CLI

This document covers the CLI commands, configuration files, invitation strings, and recovery procedures for PSI-Link. It does not cover the PSI protocol (see [PROTOCOL.md](spec/PROTOCOL.md)), the security and authentication model (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md)), or deployment of supporting services (see [DEPLOYMENT.md](DEPLOYMENT.md)). Intended readers are IT staff and power users.

## Configuration

Exchange details are stored in two files: a configuration file and an authentication key file. The default file names and paths are `./psilink.yaml` and `./.psilink.key`, while command line arguments to override are `--config-file` and `--key-file` respectively. When these files are first created, the application prints a notice identifying both and gives a warning that the key file should be treated as private. For Docker deployments, agencies are expected to mount one directory per exchange partner, so the working directory itself provides isolation and no subdirectory is needed.

The configuration file is not intended to contain secrets and is safe to commit to version control. The shared secret and its expiration are stored in the key file instead; they never appear in the configuration file and are not user-editable because the application rotates them automatically. By default, the key file is intentionally named with a leading dot (`.psilink.key`) so that it is hidden from default directory listings and less likely to be accidentally copied or included in an archive; it should be added to `.gitignore`. All other credential fields use the `@path` convention described below.

Command line arguments take precedence over values in the configuration file, allowing scripted workflows to override specific parameters without modifying the stored configuration. Credential and opaque string fields support `@`-file references: a value beginning with `@` is read from the file at the given path rather than used literally - for example, `--server-private-key=@/run/secrets/id_rsa` reads the private key from disk. This convention applies both on the command line and in the configuration file, and is the recommended approach for any credential to avoid exposing sensitive material in process listings or shell history. It applies only to the credential and opaque-options fields marked "`@`-file recommended" in the [exchange reference](EXCHANGE_REFERENCE.md). Any other field -- a free-text field such as `linkage_terms.identity` or `retention_disposition`, or a local-path field such as `signing.identity_file` -- is not treated as an `@`-file reference: a leading `@` is kept as a literal character rather than read as a file path.

When a credential supplied as an `@`-file reference is written into a configuration file -- by `psilink exchange --save` or by the `invite`/`accept` provisioning commands -- the saved file records the original `@path` reference, not the resolved secret, so the secret is never copied into `psilink.yaml` and the file remains safe to commit. A credential supplied as a literal value is saved as-is. The stored reference is the string exactly as typed: a `~/`-relative reference such as `@~/.ssh/id_rsa` therefore stays valid when the configuration is moved to another machine, while a relative reference such as `@secrets/pw` is resolved against the working directory of whichever later command reads it -- use an absolute or `~/` reference if that command will run from a different directory. A saved `@path` is resolved when the configuration is loaded for the next exchange, before any network activity; if the referenced file has since been moved, deleted, made unreadable, or emptied, that load fails with a usage error naming the reference and no connection is attempted.

The "safe to commit" property protects the author of a configuration, not whoever later runs it. Because the file records `@path` references rather than resolved secrets, committing or sharing a configuration you wrote yourself discloses nothing -- but loading one you did *not* author is a different matter. When `psilink exchange` loads a configuration, every `@path` credential reference in it is read from your local disk, with your privileges; for an SFTP exchange the resolved `server.password` is then sent as the SSH password to the configured `server.host`, so the referenced file's contents leave your machine. A configuration is therefore not a trust boundary: loading one you did not author is equivalent to running its referenced files as your own credentials. A substituted configuration could set that password to an `@path` for a sensitive local file -- a private key such as `~/.ssh/id_rsa`, or `/etc/passwd` -- and have its contents transmitted to a host its author chose; a private key exfiltrated this way leaves silently, as an ordinary authentication attempt rather than a visible error. Never run `psilink exchange` against a configuration from an untrusted source: treat a configuration received from a partner or pulled from a shared repository as you would treat running its referenced files as your own credentials. Only a wholesale substituted configuration file introduces this; an invitation cannot, because invitations carry no credential by construction and the connection details on the accept path come from your own command line. See the [security design](SECURITY_DESIGN.md#threat-model) for the trust model.

The `--config-file` and `--key-file` arguments are expected to be available for all relevant commands below, and are thus not explicitly listed.

A leading `~` (or `~/`) in any local filesystem path -- whether given on the command line or written into the configuration file -- is expanded to the current user's home directory. This applies to path arguments such as `--config-file`, `--key-file`, `--record-file`, the input/output paths, and `signing.identity_file`, as well as the path inside an `@`-file reference (for example, `@~/secrets/id_rsa`). Note that `~user` (another user's home) is not resolved.

When a connection is supplied as a URL, psilink percent-decodes the host, path, username, and password into the stored connection fields, so a reserved or non-ASCII character must be percent-encoded in the URL and is stored decoded -- for example `sftp://user@host/my%20drop` targets the directory `my drop`, and a percent-encoded password is sent decoded. All URL-to-config paths decode identically. A malformed percent-escape (such as a lone `%`) is rejected with a usage error (exit 64), and the credential is redacted from the message.

An `INPUT_FILE` argument may be given as `-` to read the CSV from standard input instead of a file on disk -- for example, `cat data.csv | psilink exchange - results.csv` -- so a pipeline need not stage a temporary file. This applies to `psilink exchange`, the zero-setup form (`psilink URL INPUT_FILE`), `psilink invite`, and `psilink init`. For `psilink accept` it applies only with `--consent-to-terms`: `accept` normally reads its interactive confirmation from standard input and so cannot also take the CSV there, so a `-` input is rejected with guidance to give a file path; passing `--consent-to-terms` skips that prompt and frees standard input, so `accept --consent-to-terms - ...` reads the CSV from stdin like the others. `psilink init` reads its CSV from standard input the same way, so a `-` input means `init` cannot also prompt there: when a configuration file already exists at the output path and the CSV comes from stdin, `init` fails closed rather than overwriting unprompted (the same conservative default it applies in any non-interactive context). Passing `-` at an interactive terminal with nothing piped in is reported as an error rather than left waiting silently for input -- pipe the CSV or pass a file path.

Durations on the command line are written as a positive integer followed by a single-character unit -- `s` (seconds), `m` (minutes), `h` (hours), or `d` (days); for example `45s`, `30m`, `2h`, or `1d`. The unit suffix is required: a bare number is not a valid duration, and an old seconds-only value such as `30` is rejected with the suffixed form to use (`30s`) rather than silently reinterpreted. This applies to every duration-valued option, including `--expires-in`, `--accept-timeout`, `--connection-timeout`, and `--peer-timeout`.

`--polling-frequency` sets how often the `sftp`/`filedrop` channels poll the shared directory for the partner's files, overriding the `poll_interval_ms` configuration field (default `5s`). It is duration-valued like the flags above -- the unit suffix is still required, and a bare number is still rejected the same way -- but it additionally accepts a millisecond unit, so a sub-second value such as `100ms` is expressible; the millisecond unit is unique to this flag, and the other duration options still reject a sub-second or `ms` value. A conservative interval stays within SFTP servers' anti-flood limits, and because the per-round encryption dominates an exchange's wall-clock time a multi-second poll adds negligible latency, so the flag exists mainly to let a demo opt into a fast poll against a controlled server. There is no hard floor, but a value below `1s` is warned about (not blocked): a sub-second poll can trip an SFTP server's anti-flood/DoS protection and drop the connection. The flag takes effect on the commands that build a live connection -- the zero-setup exchange, `psilink exchange`, and the online `invite`/`accept` -- and, like the other connection-tuning flags, is reported as ignored on an offline `invite`/`accept` (set `poll_interval_ms` under `connection.options` in the written configuration instead).

The timeout flags `--connection-timeout`, `--peer-timeout`, and `--accept-timeout` also have a sanity ceiling of `7d`: a value above it is rejected with a usage error naming the flag and the maximum, before any connection attempt, token, or file write. A timeout is a coordination window that even a generous async setup measures in hours, so a value past a week is treated as a mistake rather than an intent; this is a usability guard, not a security bound (the accept window is in any case bounded by the invitation lifetime). It is separate from the `--expires-in` one-year ceiling, which bounds how long the invitation stays valid rather than how long a command waits.

## Initialization

```sh
psilink init [INPUT_FILE]
```

This creates a configuration file and then exits - no exchange or invitation is generated, and no key file is created. The file is a commented template with every option documented inline and all defaults pre-filled; if an input file is provided, column metadata, linkage fields, and data standardizing transformations are inferred from it. The user can then edit the file by hand before running their first exchange. Pass `--identity` to pre-fill the linkage-terms identity (a placeholder is written for you to edit otherwise). Guided interactive setup is available through the web application. On success the command prints a notice identifying the configuration file it wrote and exits 0; invalid caller input (an unreadable or malformed `INPUT_FILE`) exits 64, and the command performs no network activity on any path.

If a file already exists at the output path, the user is prompted before overwriting; declining leaves the existing file untouched. When no terminal is available to prompt (a non-interactive run, or a `-` stdin CSV that has already claimed standard input), `init` fails closed with a usage error rather than overwriting silently - delete the file or pass `--config-file` to write elsewhere.

## Zero-setup exchange

```sh
psilink [--save] [--linkage-strategy STRATEGY] URL INPUT_FILE [OUTPUT_FILE]
```

Both parties run this command against the same server. Linkage terms, metadata, and data standardizing transformations are inferred from each party's input file; if the inferred terms disagree, the exchange fails with an error. Users are expected to prepare files with matching schemas before running. The server coordinates their connection and the exchange proceeds immediately without any prior configuration. By default, no configuration files are written. This mode is suitable for one-off exchanges and for onboarding sessions where both parties are in direct communication. Security relies on the transport authentication layer and file system controls rather than a pre-shared secret. If there is no end-to-end encryption (e.g. SFTP or file-drop), then implicitly trust is placed in the server administrator.

`--linkage-strategy STRATEGY` chooses the linkage strategy (`cascade` or `single-pass`) exactly as for [`psilink invite`](#offline-invitation), with the same `single-pass` disclosure tradeoff. Because each party infers its own terms here rather than one party authoring them for both, both parties must pass the same value: the strategy is a mandatory-consistency term, so a mismatch aborts the exchange. An unknown value is a usage error before any connection is attempted.

The URL scheme determines the transport channel:

| Scheme | Channel | Description |
|--------|---------|-------------|
| `sftp://` or `ssh://` | `sftp` | SFTP server; SSH credentials required |
| `ws://` or `wss://` | `webrtc` | WebRTC via PeerJS peer-coordination server (not yet available in CLI) |
| `file://` | `filedrop` | Locally-mounted shared directory (e.g. NFS or SMB share) |

For SFTP, SSH credentials must be supplied in the URL or as command-line arguments. Embedding credentials in the URL is not recommended as URLs may appear in shell history and process listings. When used, a warning is issued and users are instructed to use the `@path` convention instead - see [Configuration](#configuration).

```sh
# SFTP example
psilink sftp://user@sftp.example.org/exchanges/drop input.csv output.csv

# File-drop example (network-mounted folder)
psilink file:///mnt/sftp-share/drop input.csv output.csv
```

Before running, users are warned about the limitations of the security model, namely that they must trust the server's administrator.

If `--save` is not specified, after running users are instructed how to use `psilink invite` and `psilink accept` to establish a recurring exchange. `--save` usage can be discussed during onboarding.

If `--save` is specified, intent is advertised to the partner in-band at the start of the exchange; outcomes for each party are described in [Bootstrapping a shared secret](SECURITY_DESIGN.md#bootstrapping-a-shared-secret).

If a zero-setup exchange is started with configuration and/or key files already present, the user is warned that they will be ignored and that if their intent was to use those files, the user should use `psilink exchange` instead.

If `--save` was specified, the `--config-file` and `--key-file` arguments can be used to specify output paths. If the relevant argument is not used and a configuration or key file exists at the default path, the user warning that the file exists is upgraded to an error. The user is also informed that they can delete the file or specify a different destination if they wish to proceed.

## Invitation strings

Subsequent commands involve agreeing to exchanges through the use of invitation strings. Invitation strings are base64url encoded, unpadded representations of the information necessary to agree on an exchange. In particular they contain:
- Linkage terms
- Invitation authentication token (short-lived; rotated to a persistent secret on acceptance)
- Optionally, a credential-free connection endpoint (see below)
- A 4-byte hash of the above, used to check for transcription errors

An invitation MAY carry a connection endpoint: a public locator that tells the acceptor where to rendezvous (a PeerJS signaling URL, an SFTP host and port, or a file-drop directory) so the parties need not arrange that detail over a separate channel. The endpoint is the locator only and never carries credentials -- no password, private key, key file, or PeerJS API key. Each party still supplies the credential portion of its own `connection` block independently. When an invitation omits the endpoint, both parties configure their `connection` block entirely on their own.

Because an invitation carries the shared authentication token -- and, in the web flow, the rendezvous derived from it -- treat it as confidential and forward it only over a trusted, out-of-band channel (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md)).

Invitation strings beginning with `-` may be misinterpreted as option flags by argument parsers. All positional arguments and unrecognized flags are validated against the invitation string schema, so the string is identified unambiguously regardless of its position or leading character.

> **Current CLI limitations.** The invite and accept sections below describe the
> intended design. The current implementation has the following gaps, each
> tracked for a follow-up:
>
> - Online `invite` does not yet reuse a pre-existing configuration file as the
>   source of its linkage terms (offline `invite` now does -- see "Offline
>   invitation" below). A pre-existing configuration on the online path is still
>   reported as a conflict and the command aborts; remove it or pass
>   `--config-file` to proceed.

## Offline invitation

When both parties are not simultaneously available or prefer not to use a coordination server, invite and accept can be performed without any server connection.

```sh
psilink invite [--expires-in DURATION] [--linkage-strategy STRATEGY] [INPUT_FILE]
```

This generates a shared secret, saves the `sharedSecret` and an `expires` field to a key file, prints an invitation string (see [Invitation strings](#invitation-strings)) and instructions for its use, and then exits immediately. The invitation should be forwarded to the user's partner using a trusted out-of-band channel (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md)).

By default the invitation expires one hour after the shared secret is generated. Pass `--expires-in DURATION` to override that lifetime - for example when the out-of-band coordination window is longer or shorter than an hour. Prefer the shortest window your coordination allows: a longer lifetime proportionally widens the period in which a leaked-but-unaccepted invitation could be used by a third party. `DURATION` is a positive integer followed by a required unit suffix: `s` (seconds), `m` (minutes), `h` (hours), or `d` (days), for example `30m`, `2h`, or `1d`. A zero, negative, or otherwise malformed value is rejected with an error before any invitation is generated, as is a value beyond the one-year maximum (`365d`): the setup secret is short-lived by design, so its lifetime is bounded even when overridden (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md)).

Pass `--linkage-strategy STRATEGY` to choose how the agreed linkage keys are run on the wire; `STRATEGY` is `cascade` (the default) or `single-pass`, and any other value is rejected as a usage error before any invitation is generated. `cascade` runs one dependent PSI round per key, so the round-trip count grows with the number of keys; `single-pass` batches every key into one exchange so the round-trip count stays constant, which is what makes a multi-key linkage practical over a high-latency channel (`filedrop` or `sftp`). Both produce the same matched result. `single-pass` is not a free optimization: to reconstruct the cascade in one pass the sender discloses its full per-key value structure to the receiver, so the receiver observes matches on less precise keys that `cascade` would have filtered out before exchanging them. Selecting it prints a note to that effect, and the partner sees the same note on their consent prompt -- the strategy is a mandatory-consistency term, so both parties must end up agreeing on it or the exchange aborts. Choose `single-pass` only when the round-trip saving is worth that additional disclosure; see [`linkage_terms.linkage_strategy`](EXCHANGE_REFERENCE.md#linkage_termslinkage_strategy) for the full tradeoff. The flag selects the strategy for terms inferred from `INPUT_FILE`; when the linkage terms instead come from a pre-existing configuration file, that file is authoritative and the flag is reported as having no effect (set `linkage_strategy` in the configuration to change it).

Generating an invitation requires either a pre-existing configuration file or an `INPUT_FILE` from which linkage terms are inferred. If both types of files are present the content of the configuration file is checked against the input. A conflict occurs if the columns in the input cannot be transformed through available data standardizations to produce the linkage fields defined in the configuration file, meaning the file cannot satisfy the linkage keys the partner will expect. In this case, an error is raised and the reason why an invite cannot be generated is given.

If only an `INPUT_FILE` is given, the inferred linkage terms, metadata, and data standardizations are written to a configuration file. The user is notified that they must fill in the connection block of the configuration file in order to conduct exchanges.

### Abandoning a pending offline invitation

To withdraw a pending offline invitation before its nominal `expires`, delete the key file it wrote (`.psilink.key` at the default path, or the `--key-file` path). The offline key exchange completes only when the inviting party still holds the pending shared secret, so removing the inviter's copy invalidates the invitation: the secret carried in the invitation string you forwarded can no longer authenticate a handshake against you, and the partner's copy is inert on its own without a live inviter to exchange with. Delete only the key file -- any configuration file (`psilink.yaml`) is left in place, so abandoning a pending invitation never disturbs a recurring exchange the same configuration still serves. The `invite` command prints this reminder, naming the key file, when it generates an offline invitation.

This is distinct from recovering a lost, reset, or compromised key (see [Recovery](#recovery)): it is the supported way to deliberately retract an invitation you have changed your mind about, not a response to exposure. Taking no action also closes the window -- the invitation lapses on its own at the `expires` shown when it was generated -- but deleting the key file closes it immediately rather than waiting out the lifetime.

## Offline acceptance

```sh
psilink accept INVITATION [INPUT_FILE]
```

The `INVITATION` argument is either a base64url string or an `@path` reference to a file containing one. This command decodes the invitation token, displays the linkage terms (including the linkage strategy, with the single-pass disclosure note when applicable), and prompts the user to accept. If they accept, configuration and key files are created (with exceptions noted below) and the user is notified that they must fill in their connection parameters in order to conduct exchanges. Coordination with the partner happens out-of-band, for example if the linkage terms are unacceptable or if the invitation expires.

`--consent-to-terms` records your consent to this invitation's terms in advance and skips the interactive confirmation, so `accept` can run unattended or in a script -- where there is no terminal, the prompt otherwise reads end-of-file and declines. It bypasses the one human checkpoint before the configuration and linkage key are written from the partner-supplied invitation, so review the terms before using it; it is off by default, and without it the prompt behaves exactly as before. Because the prompt is what otherwise claims standard input, `--consent-to-terms` also lets `INPUT_FILE` be `-` to read the CSV from stdin (see the `-` standard-input note under [Configuration](#configuration)).

If `--config-file` is not used and a configuration file already exists at the default path, its linkage terms are compared against the invitation's; any disagreement causes acceptance to fail. The user is shown which values differ and instructed to resolve the conflict before retrying with the same invitation string or to supply an alternative configuration file path.

A pre-existing key file is treated differently from a configuration file: it is never reconciled or reused, because silently reusing a stale authentication token must never happen. If `--key-file` is not used and a key file already exists at the default path, acceptance fails outright and the user is told to delete it or supply a different key file path. In this way, accepting an invitation does not cause files to be unwittingly overwritten.

If `INPUT_FILE` is provided, its columns are first checked against the invitation's linkage terms. When the input can satisfy no linkage key at all -- it cannot produce the fields any key requires -- acceptance stops with an error that names the unsatisfied fields and writes no files, rather than provisioning a configuration that could only ever produce an empty result. When it can satisfy at least one key, its columns are inspected to infer metadata and data standardizing transformations: if every field the keys need is satisfiable, they are written to the configuration file together with the inferred metadata and the standardizing transformations; if only some are, a warning names the unsatisfied fields (the keys that depend on them will be inactive) and the configuration is written without the metadata or standardizing transformations, so the user can modify their data and retry. Separately, a linkage key whose own cleaning can never produce a value -- a `parse_date` whose `input_format` omits a component, so it drops every record regardless of the data -- is warned about by name even though its columns are present: it passes the column check yet would contribute nothing, so the fix is a corrected invitation from the partner, not a different CSV.

After acceptance, both parties run `psilink exchange` at their convenience.

## Online invitation

```sh
psilink invite [--accept-timeout=DURATION] [--expires-in DURATION] [--linkage-strategy STRATEGY] URL INPUT_FILE [OUTPUT_FILE]
```

Similar to [offline invitation](#offline-invitation), this generates a shareable invitation string (see [Invitation strings](#invitation-strings)) then prints it and instructions for the user to forward to their partner by a secure, out-of-band channel. Those instructions include copy/pasteable templates for the invocation of `psilink accept` that reference the shared server. The invitation it prints also embeds a [credential-free connection endpoint](#invitation-strings) derived from the connection this invite is using -- the public locator only (host/port/path, or the split `inbound_path`/`outbound_path` pair), never credentials -- so an acceptor seeds its `connection` block from it and need only supply its own credentials. After printing the invitation information, the program connects to the server and waits for the partner to respond.

`--expires-in DURATION` overrides the one-hour invitation lifetime exactly as in the [offline invitation](#offline-invitation). When the resulting lifetime is shorter than `--accept-timeout`, the command warns that the token will expire before the wait ends and a later acceptance will be rejected.

`--linkage-strategy STRATEGY` selects the linkage strategy (`cascade` or `single-pass`) exactly as in the [offline invitation](#offline-invitation), and the same disclosure tradeoff applies to `single-pass`.

The application exits when the token expires, when the connection times out, when the user cancels, or when the `--accept-timeout` (default 15 minutes) is reached; in all four cases the invitation can no longer be accepted, because the inviter has left the rendezvous and the handshake cannot be completed (and the secret in any case lapses at its expiry). This prevents the partner from completing the setup against an inviter who has given up; it does not destroy the secret, so a leaked invitation must still be treated as a compromise (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md)). Accept-timeout is the maximum time the inviter will wait for the entire acceptance handshake to complete - from the moment the invitation is printed to the moment an acceptance message is received.

On acceptance the two parties engage in direct communication. After a successful key exchange, a fresh shared secret is generated and exchanged. Clients using communication channels without end-to-end encryption shift to an application-layer channel. The configuration and key files are saved on both sides (where applicable) as soon as the handshake succeeds, before the data exchange begins, so a post-handshake failure can be retried without re-inviting (see [Recurring exchange](#recurring-exchange)). The exchange is then conducted before output is written and both applications exit. If `OUTPUT_FILE` is given, it is used as the destination; otherwise, output is written to `stdout`.

If a configuration file exists, such as one generated by `psilink init`, it will be used to set the exchange details. Similar to the offline case, the input file is checked against the configuration to make sure that it can meet the linkage terms. Whether or not the partner accepts the invitation, the pre-existing configuration file persists.

If a configuration file does not exist, default values are inferred from the input file for linkage keys, metadata, and cleaning transformations. If the partner accepts the invitation then this default configuration is saved; otherwise it is discarded because the partner did not accept.

If `--key-file` is not used and a key file exists at the default path, the user is warned about its existence and told to either delete it or specify a different key file in case reusing that secret was not their intention.

## Online acceptance

```sh
psilink accept URL INVITATION INPUT_FILE [OUTPUT_FILE]
```

This command is similar to [offline acceptance](#offline-acceptance), however it coordinates with the other party and executes an exchange. It decodes the invitation string and displays top-level information, including the identity of the inviting party, the PSI algorithm, the linkage strategy (with a disclosure note when it is `single-pass`, since that choice discloses the sender's full per-key value structure to the receiver), which parties will receive data, and the linkage keys that will be used. The user can abort or accept. `--consent-to-terms` skips this confirmation for unattended runs exactly as in [offline acceptance](#offline-acceptance), recording advance consent to the invitation's terms before the configuration and key are written and the handshake is run; it applies only to that consent and does not affect [SFTP host-key trust](#sftp-host-key-trust), which has its own non-interactive setup. It also lets `INPUT_FILE` be `-` to read the CSV from stdin. As in offline acceptance, the input is checked against the invitation's linkage terms before any connection: if it can satisfy no key, the command stops with an error and never connects, so the two parties cannot complete a handshake and run an exchange that yields only an empty result indistinguishable from a legitimate non-match; if it can satisfy some but not all keys, a warning names the unsatisfied fields and the exchange proceeds on the keys that remain. Accepting saves the configuration and newly-generated persistent keys on both sides as soon as the handshake succeeds, before the data exchange begins, so a post-handshake failure can be retried with `psilink exchange` without re-inviting (see [Recurring exchange](#recurring-exchange)); the exchange is then conducted and both applications exit when complete.

When the invitation carries a [connection endpoint](#invitation-strings) naming a split inbound/outbound directory pair (an `sftp`/`filedrop` exchange with separate drop and pickup folders), and you do not pass `--outbound-path`, the acceptor adopts the mirror-swapped directory roles from the endpoint -- where the inviter writes becomes where you read, and vice versa -- together with the retain mode a split exchange requires, so you need not retype the mirrored directories. This is the online counterpart to the same seeding the offline accept performs. The reachable host, port, and credentials still come from your own URL and flags, never from the endpoint, so a bridged topology where you reach the rendezvous differently from the inviter is supported. An explicit `--outbound-path` overrides this entirely: it takes the URL/positional path as your inbound and the flag as your outbound, ignoring the endpoint's pair. A non-split invitation (a single shared path, or no endpoint) leaves the connection exactly as the URL builds it.

If `--config-file` is not used and a configuration file already exists at the default path, its linkage terms are compared against the invitation's and its connection block is compared against the connection target -- the URL, any `--server-*`/`--outbound-path` overrides, and any split directories seeded from the endpoint as just described. The connection comparison distinguishes *which* drop you are meeting at from *how* you reach it. A mismatch in the rendezvous location -- the host or the path -- causes acceptance to fail without notifying the inviter: the user is shown which values differ and instructed to delete the file or use the `--config-file` option (see [Configuration](#configuration)), after which the program exits, and the user can retry with the same URL and invitation string once the conflict is addressed. A difference in *how* the same drop is reached -- the protocol/channel (for example a `file://` configuration accepted against an `sftp://` URL, as with a file-sync service), the port, or the credentials -- is not an error: the specified value is used for this exchange and a warning notes that the saved configuration is left unchanged, so the user can update it if the change was meant to persist. Absence of a field from the URL (with no matching override) is never a conflict; the acceptor's own stored value stands.

A pre-existing key file is treated differently from a configuration file: it is never reconciled or reused, because silently reusing a stale authentication token must never happen. If `--key-file` is not used and a key file already exists at the default path, acceptance fails outright -- before any connection is opened -- and the user is told to delete it or supply a different key file path. In this way, accepting an invitation does not cause files to be unwittingly overwritten.

## Recurring exchange

```sh
psilink exchange INPUT_FILE [OUTPUT_FILE]
```

The application loads configuration and key files and conducts the exchange without further coordination. The shared secret is rotated after each successful authentication handshake, before the data exchange begins; if the data exchange subsequently fails, both parties already hold the rotated token and can retry without re-inviting. If `OUTPUT_FILE` is given, the results of the exchange are written to that path; otherwise, output is written to `stdout`.

Before any connection, the `INPUT_FILE`'s columns are checked against the configuration's linkage terms, the same satisfiability pre-flight `accept` applies. If the CSV can satisfy no key -- it cannot produce the fields any key requires -- the run stops with a usage error (exit 64) that names the unsatisfied fields, rather than completing an exchange whose empty result is indistinguishable from a legitimate non-match; if it satisfies some but not all keys, a warning names the unsatisfied fields and the exchange proceeds on the keys that remain. This guards a recurring run whose CSV has drifted from the terms the configuration committed to -- a file swapped since setup, or one never checked at an offline accept. The check resolves fields exactly as the exchange does, honoring any explicit metadata or column-standardization in the configuration, so a field an explicit type or remap produces is not flagged.

The `sftp` and `filedrop` channels are currently supported; `webrtc` is not yet available in the CLI. For file-drop exchanges, the `psilink.yaml` configuration uses `channel: filedrop` and `path` in place of `channel: sftp` and `server`:

```yaml
connection:
  channel: filedrop
  path: /mnt/sftp-share/exchanges/agency-a-agency-b
```

### SFTP host-key trust

Every command that opens an SFTP connection -- `psilink exchange`, an online `psilink invite`/`accept`, and a zero-setup exchange -- verifies the server's SSH host key before sending any credential, so a man-in-the-middle or a substituted server is detected rather than trusted. You can pin the key out-of-band by setting `connection.server.host_key_fingerprint` to the server's OpenSSH SHA256 fingerprint (the value `ssh-keygen -lf` prints; `@path` is supported). If you cannot obtain it out-of-band, the first interactive run establishes it on first use, the way `ssh` does:

- The first time you connect to an unpinned SFTP server from an interactive terminal, the command shows the presented host key's fingerprint and asks you to confirm. On confirmation it records the fingerprint and connects; every later run then verifies it silently. Verify the fingerprint against the server's published value if you can before confirming. Where the command writes a configuration -- `exchange` (into the existing `psilink.yaml`, preserving your comments), the online `invite`/`accept`, and a zero-setup run with `--save` -- the pin is saved there; a zero-setup run without `--save` trusts the key for that one exchange only (like `ssh` to a host you do not add to `known_hosts`).
- A run with no terminal -- an automated or scheduled run, or one piping its input CSV through stdin -- does not prompt and does not silently accept: it fails closed with an error telling you to run once interactively to pin the key, or to set `host_key_fingerprint` yourself. So pin the key (out-of-band or via one interactive run) before scheduling unattended exchanges.
- If the server legitimately rotates its host key, a later run fails with a mismatch error rather than silently trusting the new key. Verify the new fingerprint out-of-band, then re-pin deliberately: set `host_key_fingerprint` to the new value, or remove it from `psilink.yaml` and run once interactively to confirm and re-pin (the same as removing a changed host from `~/.ssh/known_hosts`).

## Verifying a receipt

```sh
psilink verify-receipt RECORD [INPUT_FILE] [RESULT_FILE]
```

Read a stored exchange record and report whether it is internally consistent. It is read-only: it never modifies or re-signs the record. `RECORD` is the record file written at the end of an exchange (`psilink-record-<stamp>.json`); its verification keys are read from the record path with a `.keys.json` suffix by default, or from `--keys`. An unrecognized record or keys `version` is rejected with a clear error (exit 64) rather than mis-parsed.

The record holds no matched data -- only salted commitments to it -- so verification **re-supplies** the committed data from your own retained files: pass the `INPUT_FILE` you contributed and the `RESULT_FILE` you kept, and the command reconstructs the committed data and opens every commitment (the sent payload, the received payload, and the record's pairing). Reproduction is byte-exact only from **unmodified** retained files -- a results file re-sorted or re-exported in a spreadsheet will not reproduce -- and a duplicate value in an identifier column is reported as a note. A genuinely empty received cell is a known limitation: it cannot be told apart from a committed null, so a record with one will not reproduce, reported as a commitment mismatch (never silently mis-opened) rather than a note.

With `--config-file` (your exchange config, for your linkage terms) and `--partner-terms` (the partner's terms), it also re-derives the agreed-terms hash. The partner's terms are not retained by default, so this check is optional; without both, the terms hash is reported as not checked. `--config-file` is never auto-loaded -- name it explicitly, since a stray config in the working directory may belong to a different exchange.

With neither `INPUT_FILE` nor `RESULT_FILE`, the command still runs -- the third-party-auditor case: it checks the record's structure and version and reports each commitment as not opened (an auditor without your retained data cannot open the commitments, by design), rather than failing.

The verdict distinguishes a commitment that **opened and matches**, one that was **not opened** (its data was not re-supplied), and one that **does not match**, and rolls up to `VERIFIED` (everything checked and passed), `INCOMPLETE` (nothing contradicted, but not everything could be checked), or `VERIFICATION FAILED` (a check did not match). The command exits nonzero (1) only on a definite failure; a failed opening is reported as "the record may have been altered, or a re-supplied input/result/terms does not match this exchange", never asserted as tampering, since the two are indistinguishable. Partner receipt **signatures** are not verified yet -- signed evidence bundles are deferred work -- and the command says so rather than implying it checked them.

## Recovery

### Key lifecycle

A key file passes through four stages:

1. **Creation** - `psilink invite` or `psilink accept` writes a fresh `.psilink.key` with a short-lived invitation token. The file is written owner-read-only (`0600` on Unix).
2. **Rotation** - `psilink exchange` rotates the token automatically after each successful authentication handshake, before the data exchange begins. The new token replaces the previous one in the same file. No manual action is required. If [`authentication.token_max_age_days`](EXCHANGE_REFERENCE.md#authenticationtoken_max_age_days) is set, the rotated token is stamped with an expiry that many days out, so a token cannot outlive the configured maximum age between exchanges; without it, rotated tokens do not expire. If the key file write fails, an error is reported immediately; both parties must re-invite because the partner may already hold the rotated token, making the old token invalid (see [Out-of-sync tokens](#out-of-sync-tokens)).
3. **Loss** - if the key file is deleted or otherwise unrecoverable, both parties must re-invite (see below). If a backup exists in a secrets manager or encrypted store, restore from the backup and retry the exchange; confirm with the partner out-of-band that the backup reflects the same exchange they last completed - if in doubt, re-invite rather than risk an out-of-sync token that silently fails the key exchange.
4. **Compromise** - if the token is believed to have been observed by a third party, follow the procedure in [Compromise response](SECURITY_DESIGN.md#compromise-response).

`psilink exchange` checks the token's age at load time, before opening any connection. An already-expired token aborts the run with an error naming the expired time and directing both parties to re-invite (no key exchange is attempted); this applies to any token carrying an `expires` -- including an invitation token's bounded lifetime -- independently of `token_max_age_days`. When `token_max_age_days` is set, a token within `token_max_age_days / 3` days of expiry additionally prints a warning before the exchange. The warning is suppressed when that exchange succeeds, because rotation refreshes the expiry; it appears only when the token was not refreshed, as a prompt to re-invite before it lapses. A stamped `expires` is honored regardless of whether `token_max_age_days` is still set, so removing the field does not revive a token that has already passed its expiry.

### Out-of-sync tokens

If one party fails to write the rotated token to its key file - whether due to a crash, power loss, or a disk error - the two sides will hold different tokens and the next key exchange will fail. Clock skew can produce the same result: if one party's clock lags and a token expires between the key-exchange round-trip messages, that party fails the post-handshake expiry check and discards the new token while the other party saves it successfully. Because there is no way to determine which party holds the newer token, both must reset regardless of which side failed; reusing an older token may also violate key-rotation policies.

To recognize failed rotations, the error messages for exchanges that fail key-exchange authentication instruct users how they can generate and accept new invitation strings, and encourage them to contact their partners out-of-band. Since connection information has already been shared, the recommended commands are `psilink invite URL` followed by `psilink accept URL INVITATION`. The pre-existing `psilink.yaml` configuration file is reused; only the key file needs to be recreated.

### Token loss

If a key file is lost and no backup is available:

1. Contact the partner out-of-band to coordinate the reset.
2. Both parties delete their existing key files.
3. The inviting party runs `psilink invite URL INPUT_FILE` and shares the invitation string with the partner.
4. The accepting party runs `psilink accept URL INVITATION INPUT_FILE`.

The pre-existing `psilink.yaml` configuration file is reused; only the key file needs to be recreated.

### Token compromise

See [Compromise response](SECURITY_DESIGN.md#compromise-response) for the full procedure. In summary: notify the partner out-of-band, both parties delete their key files, and re-invite over a channel known to be uncompromised.

## Logging

Every command that produces diagnostic output - `init`, `invite`, `accept`, `exchange`, the zero-setup form, `fingerprint`, and `verify-receipt` - accepts `--log-level` and `--log-file`.

psilink follows the standard stream convention: a command's result data goes to `stdout`, and all diagnostic output - every log line, `info` and `debug` included, together with the interactive confirmation prompt - goes to `stderr`. This keeps a piped or redirected result clean. `psilink accept URL INVITATION 2>/dev/null > matched.csv` writes only the matched-records CSV to `matched.csv`, with the invitation-terms display, the "wrote key file" line, the runtime banner, and every other diagnostic sent to `stderr`, where the same run without the redirect still shows them on the terminal. The result on `stdout` is an exchange's CSV output (when no `OUTPUT_FILE` positional is given), the invitation token printed by `invite`, the fingerprint value printed by `fingerprint` -- whose action banner, bound identity, `--force` regeneration warning, and out-of-band sharing instructions are diagnostics on `stderr`, so `FP=$(psilink fingerprint)` captures just the value -- and the verification verdict printed by `verify-receipt` (its exit code, nonzero only on a definite failure, carries the same result for scripts).

`--log-level <level>` selects the verbosity: `silent`, `error`, `warn`, `info` (the default), `debug`, or `trace`. `silent` suppresses all log output.

`--log-file <path>` appends log output to `<path>` instead of writing it to the terminal, so psilink can be run unattended or in automation without shell redirection. The file is opened in append mode, preserving any content from previous runs; each line already carries an ISO-8601 timestamp, so successive runs stay distinguishable without a separate flag. The parent directory must already exist - a missing directory aborts the command with a usage error (exit 64) before any exchange work begins. A log file psilink creates is owner-only (mode `0600`), since at `debug`/`trace` it can record partner identity, linkage keys, and data categories; if you point `--log-file` at a file that already exists, its permissions are left as they are. `--log-level` still applies to the file, so `--log-level silent --log-file run.log` writes nothing. Every diagnostic line is captured, including the low-level warnings from data cleaning and file handling. Results written to `stdout` (an exchange's CSV output, the fingerprint value) are not log output and are unaffected by `--log-file`.

For unattended runs, set `--peer-timeout` to a value that suits how long you are willing to wait for a partner that never appears (it defaults to one hour); a dead or departed peer makes the command wait out this budget at the rendezvous and live-exchange steps before exiting. The teardown after a successful exchange does not inherit this budget - it is bounded separately and short - so the long wait only applies while the exchange is still in progress. Wrapping the command in your pipeline's own outer timeout is still recommended as a backstop.

## Exit codes

The CLI distinguishes two failure classes, following the BSD `sysexits` convention:

- **64 (`EX_USAGE`)** - invalid caller input or configuration: a problem the operator fixes locally by editing or provisioning a file. Retrying without changing anything will not help.
- **69 (`EX_UNAVAILABLE`)** - a transport or availability failure: the exchange server, peer, or shared storage was unreachable, rejected an operation, or went silent. Retrying once the transport recovers may succeed.

For `psilink exchange`, a missing, malformed, or unreadable configuration file (`psilink.yaml`) or key file (`.psilink.key`) - including a key file whose stored token is malformed - is a usage error and exits 64. An unsupported channel or URL scheme - a `webrtc` config or `ws://` URL the CLI does not yet support, an unknown scheme, or a malformed `file://` authority - is likewise a usage error and exits 64, as is a URL carrying a malformed percent-escape such as a lone `%` (with any credential redacted from the message) or an invalid connection option or combination (for example a negative, fractional, non-numeric, or above-ceiling `--max-reconnect-attempts`, a non-numeric or out-of-range (outside `0..65535`) `--server-port`, a reserved `peer_id`, or a `retain_files`/`lockless_rendezvous` contradiction). Failures during the exchange itself - connecting to the server, the rendezvous, or the message loop - exit 69. A successful run exits 0; a run terminated by a signal exits 130 (SIGINT) or 143 (SIGTERM).

Passing a single-value option more than once - for example `psilink invite --accept-timeout 60s --accept-timeout 120s`, or a repeated `--log-level`, `--log-file`, `--server-port`, `--peer-timeout`, or `--linkage-strategy` - is a usage error and exits 64, naming the flag (`--<flag> may be given only once`), rather than silently taking one of the values. Count flags (`-v`/`--verbose`) and boolean flags (and their `--no-` forms, such as `--record`/`--no-record`) may still be repeated and keep their accumulate / last-one-wins / negation semantics.

Passing an unrecognized option - a misspelling such as `--server-user` for `--server-username`, or `--retain-file` for `--retain-files` - is a usage error and exits 64, naming the offending option, before any connection is attempted, on the zero-setup exchange, `exchange`, `fingerprint`, and `verify-receipt` commands. Without this the flag was silently dropped and the run proceeded with the option's default (or a stale configuration value), so a mistyped credential or path override went unnoticed. Positional arguments - the server URL and input and output files - are validated by each command, not by this check. The `invite`, `accept`, and `init` commands accept an invitation string that may begin with `-` as a positional (see [Invitation strings](#invitation-strings)); on those commands a mistyped option is therefore treated as a positional and surfaces through the command's own argument validation (for example, as a file that cannot be opened) rather than as a named unknown-option error.

## See also

- [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md) - exchange specification format consumed by the CLI
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md) - authentication model underlying the invitation and recurring exchange flow
- [COMMUNICATION.md](COMMUNICATION.md) - communication channels (WebRTC, SFTP, filedrop) and supporting services
- [DEPLOYMENT.md](DEPLOYMENT.md) - operating the supporting services used by the CLI
- [DESIGN.md](DESIGN.md) - overview of the user journey and command table
