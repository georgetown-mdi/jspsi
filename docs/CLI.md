---
title: "PSI-Link CLI"
---

# PSI-Link CLI

This document covers the CLI commands, configuration files, invitation strings, and recovery procedures for PSI-Link. It does not cover the PSI protocol (see [PROTOCOL.md](PROTOCOL.md)), the security and authentication model (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md)), or deployment of supporting services (see [DEPLOYMENT.md](DEPLOYMENT.md)). Intended readers are IT staff and power users.

## Configuration

Exchange details are stored in two files: a configuration file and an authentication key file. The default file names and paths are `./psilink.yaml` and `./.psilink.key`, while command line arguments to override are `--config-file` and `--key-file` respectively. When these files are first created, the application prints a notice identifying both and gives a warning that the key file should be treated as private. For Docker deployments, agencies are expected to mount one directory per exchange partner, so the working directory itself provides isolation and no subdirectory is needed.

The configuration file is not intended to contain secrets and is safe to commit to version control. The PAKE token and its expiration are stored in the key file instead; they never appear in the configuration file and are not user-editable because the application rotates them automatically. By default, the key file is intentionally named with a leading dot (`.psilink.key`) so that it is hidden from default directory listings and less likely to be accidentally copied or included in an archive; it should be added to `.gitignore`. All other credential fields use the `@path` convention described below.

Command line arguments take precedence over values in the configuration file, allowing scripted workflows to override specific parameters without modifying the stored configuration. Credential and opaque string fields support `@`-file references: a value beginning with `@` is read from the file at the given path rather than used literally - for example, `--server-private-key=@/run/secrets/id_rsa` reads the private key from disk. This convention applies both on the command line and in the configuration file, and is the recommended approach for any credential to avoid exposing sensitive material in process listings or shell history. It does not apply to free-text or structured fields such as `linkage_terms.identity`, where `@` may appear as a literal character.

The `--config-file` and `--key-file` arguments are expected to be available for all relevant commands below, and are thus not explicitly listed.

## Initialization

```sh
psilink init [INPUT_FILE]
```

> **Not yet implemented:** `psilink init` is stubbed; it currently prints a "not yet implemented" message and exits. It is targeted for the 1.0 release (see [ROADMAP.md](ROADMAP.md)). The behavior below is the intended design.

This creates a configuration file and then exits - no exchange or invitation is generated. The file is a commented template with every option documented inline and all defaults pre-filled; if an input file is provided, column metadata, linkage fields, and data standardizing transformations are inferred from it. The user can then edit the file by hand before running their first exchange. Guided interactive setup is available through the web application. If a file already exists at the output path, the user is prompted before overwriting.

## Zero-setup exchange

```sh
psilink [--save] URL INPUT_FILE [OUTPUT_FILE]
```

Both parties run this command against the same server. Linkage terms, metadata, and data standardizing transformations are inferred from each party's input file; if the inferred terms disagree, the exchange fails with an error. Users are expected to prepare files with matching schemas before running. The server coordinates their connection and the exchange proceeds immediately without any prior configuration. By default, no configuration files are written. This mode is suitable for one-off exchanges and for onboarding sessions where both parties are in direct communication. Security relies on the transport authentication layer and file system controls rather than a PAKE-derived shared secret. If there is no end-to-end encryption (e.g. SFTP or file-drop), then implicitly trust is placed in the server administrator.

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

> **Not yet implemented:** `psilink init`, `psilink invite`, `psilink accept`, and the `--save` flag are reserved for the configuration and bootstrapping workflow but are not yet wired up in the CLI; they are targeted for the 1.0 release (see [ROADMAP.md](ROADMAP.md)). The `init`, `invite`, and `accept` commands currently print a "not yet implemented" message and exit; the `--save` flag emits a warning and proceeds with a standard zero-setup exchange. Until these commands land, recurring exchanges require a key file (`.psilink.key`) provisioned out-of-band - see [Required permissions](SECURITY_DESIGN.md#required-permissions) for the file format.

If `--save` is specified, intent is advertised to the partner in-band at the start of the exchange; outcomes for each party are described in [Bootstrapping a shared secret](SECURITY_DESIGN.md#bootstrapping-a-shared-secret).

If a zero-setup exchange is started with configuration and/or key files already present, the user is warned that they will be ignored and that if their intent was to use those files, the user should use `psilink exchange` instead.

If `--save` was specified, the `--config-file` and `--key-file` arguments can be used to specify output paths. If the relevant argument is not used and a configuration or key file exists at the default path, the user warning that the file exists is upgraded to an error. The user is also informed that they can delete the file or specify a different destination if they wish to proceed.

## Invitation strings

Subsequent commands involve agreeing to exchanges through the use of invitation strings. Invitation strings are base64url encoded, unpadded representations of the information necessary to agree on an exchange. In particular they contain:
- Linkage terms
- Invitation authentication token (short-lived; rotated to a persistent secret on acceptance)
- A 4-byte hash of the above, used to check for transcription errors

Connection information is not included; each party configures their own `connection` block in their configuration file independently.

Invitation strings beginning with `-` may be misinterpreted as option flags by argument parsers. All positional arguments and unrecognized flags are validated against the invitation string schema, so the string is identified unambiguously regardless of its position or leading character.

## Offline invitation

When both parties are not simultaneously available or prefer not to use a coordination server, invite and accept can be performed without any server connection.

```sh
psilink invite [INPUT_FILE]
```

This generates a PAKE token, saves the `pakeToken` and an `expires` field to a key file, prints an invitation string (see [Invitation strings](#invitation-strings)) and instructions for its use, and then exits immediately. The invitation should be forwarded to the user's partner using a trusted out-of-band channel (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md)).

Generating an invitation requires either a pre-existing configuration file or an `INPUT_FILE` from which linkage terms are inferred. If both types of files are present the content of the configuration file is checked against the input. A conflict occurs if the columns in the input cannot be transformed through available data standardizations to produce the linkage fields defined in the configuration file, meaning the file cannot satisfy the linkage keys the partner will expect. In this case, an error is raised and the reason why an invite cannot be generated is given.

If only an `INPUT_FILE` is given, the inferred linkage terms, metadata, and data standardizations are written to a configuration file. The user is notified that they must fill in the connection block of the configuration file in order to conduct exchanges.

## Offline acceptance

```sh
psilink accept INVITATION [INPUT_FILE]
```

The `INVITATION` argument is either a base64url string or an `@path` reference to a file containing one. This command decodes the invitation token, displays the linkage terms, and prompts the user to accept. If they accept, configuration and key files are created (with exceptions noted below) and the user is notified that they must fill in their connection parameters in order to conduct exchanges. Coordination with the partner happens out-of-band, for example if the linkage terms are unacceptable or if the invitation expires.

If `--config-file` is not used and a configuration file already exists at the default path, its linkage terms are compared against the invitation's; any disagreement causes acceptance to fail. The user is shown which values differ and instructed to resolve the conflict before retrying with the same invitation string or to supply an alternative configuration file path.

If `--key-file` is not used and there is a pre-existing key file at the default path, a similar error and instructions are generated. In this way, accepting an invitation does not cause files to be unwittingly overwritten.

If `INPUT_FILE` is provided, its columns are inspected to infer metadata and to see if default data standardizing transformations can satisfy the linkage keys in the invitation. If the linkage terms can be satisfied, they are written to a configuration file together with the inferred metadata and the standardizing transformations. If terms cannot be satisfied, a warning is issued that the user may need to modify their data to satisfy the terms. The configuration file is then written without the metadata or standardizing transformations.

After acceptance, both parties run `psilink exchange` at their convenience.

## Online invitation

```sh
psilink invite [--accept-timeout=N] URL INPUT_FILE [OUTPUT_FILE]
```

Similar to [offline invitation](#offline-invitation), this generates a shareable invitation string (see [Invitation strings](#invitation-strings)) then prints it and instructions for the user to forward to their partner by a secure, out-of-band channel. Those instructions include copy/pasteable templates for the invocation of `psilink accept` that reference the shared server. After printing the invitation information, the program connects to the server and waits for the partner to respond.

The application exits when the token expires, when the connection times out, when the user cancels, or when the `--accept-timeout` (default 15 minutes) is reached; in all four cases the token is revoked or has expired, preventing a stale invitation from being accepted later. Accept-timeout is the maximum time the inviter will wait for the entire acceptance handshake to complete - from the moment the invitation is printed to the moment an acceptance message is received.

On acceptance the two parties engage in direct communication. After successfully accomplishing a PAKE, a fresh shared secret is generated and exchanged. Clients using communication channels without end-to-end encryption shift to an application-layer channel. The configuration and key files are saved on both sides (where applicable), and the exchange is conducted before output is written and both applications exit. If `OUTPUT_FILE` is given, it is used as the destination; otherwise, output is written to `stdout`.

If a configuration file exists, such as one generated by `psilink init`, it will be used to set the exchange details. Similar to the offline case, the input file is checked against the configuration to make sure that it can meet the linkage terms. Whether or not the partner accepts the invitation, the pre-existing configuration file persists.

If a configuration file does not exist, default values are inferred from the input file for linkage keys, metadata, and cleaning transformations. If the partner accepts the invitation then this default configuration is saved; otherwise it is discarded because the partner did not accept.

If `--key-file` is not used and a key file exists at the default path, the user is warned about its existence and told to either delete it or specify a different key file in case reusing that secret was not their intention.

## Online acceptance

```sh
psilink accept URL INVITATION INPUT_FILE [OUTPUT_FILE]
```

This command is similar to [offline acceptance](#offline-acceptance), however it coordinates with the other party and executes an exchange. It decodes the invitation string and displays top-level information, including the identity of the inviting party, the PSI algorithm, which parties will receive data, and the linkage keys that will be used. The user can abort or accept. Accepting saves the configuration and newly-generated persistent keys on both sides and immediately conducts the exchange; both applications exit when complete.

If `--config-file` is not used and a configuration file already exists at the default path, its linkage terms are compared against the invitation's and its connection block is compared against the URL's explicit fields (scheme, hostname, port, path, and username/password if present; absence of credentials in the URL is not treated as a conflict). Any disagreement causes acceptance to fail without being rejected and without notifying the inviter. The user is shown which values differ and instructed to delete the file or use the `--config-file` option (see [Configuration](#configuration)) if they want to proceed. After this, the program exits. After addressing the conflict, the user can run `psilink accept` with the same URL and invitation string to try again.

If `--key-file` is not used and there is a pre-existing key file at the default path, a similar error and instructions are generated. In this way, accepting an invitation does not cause files to be unwittingly overwritten.

## Recurring exchange

```sh
psilink exchange INPUT_FILE [OUTPUT_FILE]
```

The application loads configuration and key files and conducts the exchange without further coordination. The shared secret is rotated after each successful authentication handshake, before the data exchange begins; if the data exchange subsequently fails, both parties already hold the rotated token and can retry without re-inviting. If `OUTPUT_FILE` is given, the results of the exchange are written to that path; otherwise, output is written to `stdout`.

The `sftp` and `filedrop` channels are currently supported; `webrtc` is not yet available in the CLI. For file-drop exchanges, the `psilink.yaml` configuration uses `channel: filedrop` and `path` in place of `channel: sftp` and `server`:

```yaml
connection:
  channel: filedrop
  path: /mnt/sftp-share/exchanges/agency-a-agency-b
```

## Recovery

### Key lifecycle

A key file passes through four stages:

1. **Creation** - `psilink invite` or `psilink accept` writes a fresh `.psilink.key` with a short-lived invitation token. The file is written owner-read-only (`0600` on Unix).
2. **Rotation** - `psilink exchange` rotates the token automatically after each successful authentication handshake, before the data exchange begins. The new token replaces the previous one in the same file. No manual action is required. If the key file write fails, an error is reported immediately; both parties must re-invite because the partner may already hold the rotated token, making the old token invalid (see [Out-of-sync tokens](#out-of-sync-tokens)).
3. **Loss** - if the key file is deleted or otherwise unrecoverable, both parties must re-invite (see below). If a backup exists in a secrets manager or encrypted store, restore from the backup and retry the exchange; confirm with the partner out-of-band that the backup reflects the same exchange they last completed - if in doubt, re-invite rather than risk an out-of-sync token that silently fails the PAKE handshake.
4. **Compromise** - if the token is believed to have been observed by a third party, follow the procedure in [Compromise response](SECURITY_DESIGN.md#compromise-response).

### Out-of-sync tokens

If one party fails to write the rotated token to its key file - whether due to a crash, power loss, or a disk error - the two sides will hold different tokens and the next PAKE handshake will fail. Clock skew can produce the same result: if one party's clock lags and a token expires between the SPAKE2 round-trip messages, that party fails the post-handshake expiry check and discards the new token while the other party saves it successfully. Because there is no way to determine which party holds the newer token, both must reset regardless of which side failed; reusing an older token may also violate key-rotation policies.

To recognize failed rotations, the error messages for exchanges that fail PAKE authentication instruct users how they can generate and accept new invitation strings, and encourage them to contact their partners out-of-band. Since connection information has already been shared, the recommended commands are `psilink invite URL` followed by `psilink accept URL INVITATION`. The pre-existing `psilink.yaml` configuration file is reused; only the key file needs to be recreated.

### Token loss

If a key file is lost and no backup is available:

1. Contact the partner out-of-band to coordinate the reset.
2. Both parties delete their existing key files.
3. The inviting party runs `psilink invite URL INPUT_FILE` and shares the invitation string with the partner.
4. The accepting party runs `psilink accept URL INVITATION INPUT_FILE`.

The pre-existing `psilink.yaml` configuration file is reused; only the key file needs to be recreated.

### Token compromise

See [Compromise response](SECURITY_DESIGN.md#compromise-response) for the full procedure. In summary: notify the partner out-of-band, both parties delete their key files, and re-invite over a channel known to be uncompromised.

## Exit codes

The CLI distinguishes two failure classes, following the BSD `sysexits` convention:

- **64 (`EX_USAGE`)** - invalid caller input or configuration: a problem the operator fixes locally by editing or provisioning a file. Retrying without changing anything will not help.
- **69 (`EX_UNAVAILABLE`)** - a transport or availability failure: the exchange server, peer, or shared storage was unreachable, rejected an operation, or went silent. Retrying once the transport recovers may succeed.

For `psilink exchange`, a missing, malformed, or unreadable configuration file (`psilink.yaml`) or key file (`.psilink.key`) - including a key file whose stored token is malformed - is a usage error and exits 64. Failures during the exchange itself - connecting to the server, the rendezvous, or the message loop - exit 69. A successful run exits 0; a run terminated by a signal exits 130 (SIGINT) or 143 (SIGTERM).

## See also

- [EXCHANGE_SPEC.md](EXCHANGE_SPEC.md) - exchange specification format consumed by the CLI
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md) - authentication model underlying the invitation and recurring exchange flow
- [COMMUNICATION.md](COMMUNICATION.md) - communication channels (WebRTC, SFTP, filedrop) and supporting services
- [DEPLOYMENT.md](DEPLOYMENT.md) - operating the supporting services used by the CLI
- [DESIGN.md](DESIGN.md) - overview of the user journey and command table
