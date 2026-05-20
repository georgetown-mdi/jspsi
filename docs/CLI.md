---
title: "PSI-Link CLI"
---

# PSI-Link CLI

This document covers the CLI commands, configuration files, invitation strings,
and recovery procedures for PSI-Link. It does not cover the PSI protocol (see
[PROTOCOL.md](PROTOCOL.md)), the security and authentication model (see
[SECURITY.md](SECURITY.md)), or deployment of supporting services (see
[DEPLOYMENT.md](DEPLOYMENT.md)). Intended readers are IT staff and power users.

## Configuration

Exchange configuration is stored in two files in the working directory: `psilink.yaml`, which records the exchange parameters, and `.psilink.key`, which holds the shared secret used for authentication. The `--config-file` command line argument points to the yaml file and defaults to `./psilink.yaml`; the `--key-file` argument points to the key file and defaults to `.psilink.key`. When these files are first created, the application prints a notice identifying both and gives a warning that the key file should be treated as private. For Docker deployments, agencies are expected to mount one directory per exchange partner, so the working directory itself provides isolation and no subdirectory is needed.

`psilink.yaml` is not intended to contain secrets and is safe to commit to version control. The PAKE token and its expiration are stored in `.psilink.key` instead; they never appear in `psilink.yaml` and are not user-editable because the application rotates them automatically. `.psilink.key` is intentionally named with a leading dot so that it is hidden from default directory listings and less likely to be accidentally copied or included in an archive; it should be added to `.gitignore`. All other credential fields use the `@path` convention described below.

Command line arguments take precedence over values in `psilink.yaml`, allowing scripted workflows to override specific parameters without modifying the stored configuration. Credential and opaque string fields support `@`-file references: a value beginning with `@` is read from the file at the given path rather than used literally - for example, `--sftp-key=@/run/secrets/id_rsa` reads the private key from disk. This convention applies both on the command line and in `psilink.yaml`, and is the recommended approach for any credential to avoid exposing sensitive material in process listings or shell history. It does not apply to free-text or structured fields such as `linkage_terms.identity`, where `@` may appear as a literal character.

## Initialization

```sh
psilink init [INPUT_FILE]
```

This creates `psilink.yaml` in the working directory and then exits - no exchange or invitation is generated. `psilink.yaml` is a commented template with every option documented inline and all defaults pre-filled; if an input file is provided, column metadata, linkage fields, and data standardizing transformations are inferred from it. The user can then edit the file by hand before running their first exchange. Guided interactive setup is available through the web application. If the file already exists, the user is prompted before overwriting. The `--config-file` flag specifies where to create the configuration file.

## Zero-setup exchange

```sh
psilink [--save] URL INPUT_FILE [OUTPUT_FILE]
```

Both parties run this command against the same server URL. Linkage terms, metadata, and data standardizing transformations are inferred from each party's input file; if the inferred terms disagree, the exchange fails with an error. Users are expected to prepare files with matching schemas before running. The server coordinates their connection and the exchange proceeds immediately without any prior configuration. By default, no configuration files are written. This mode is suitable for one-off exchanges and for onboarding sessions where both parties are in direct communication. Security relies on the transport authentication layer - SSH credentials for SFTP, DTLS for WebRTC - rather than a PAKE-derived shared secret.

For SFTP, since no configuration file is available, SSH credentials must be supplied in the URL or as command-line arguments. Embedding credentials in the URL is not recommended as URLs may appear in shell history and process listings. When used, a warning is issued and users are instructed to use the `@path` convention instead - see [Configuration](#configuration).

Before running, users are warned about the limitations of the security model, namely that they must trust the server's administrator.

If `--save` is not specified, after running users are instructed how to use `psilink invite` and `psilink accept` to establish a configuration-based relationship. `--save` usage can be discussed during onboarding.

If `--save` is specified, intent is advertised to the partner in-band at the start of the exchange; outcomes for each party are described in [Bootstrapping a shared secret](SECURITY.md#bootstrapping-a-shared-secret). The `--config-file` and `--key-file` flags can specify non-default paths for the saved configuration and key file respectively.

## Invitation

```sh
psilink invite [--exchange] [--accept-timeout=N] URL INPUT_FILE [OUTPUT_FILE]
```

This generates a shareable invitation string (see [Invitation strings](#invitation-strings)) then prints it for the user to forward to their partner by a secure channel. The application connects to the server and waits for the partner to respond. It exits when the token expires, when the connection times out, when the user cancels, or when the `--accept-timeout` (default 10 minutes) is reached; in all four cases the token is revoked or has expired, preventing a stale invitation from being accepted later. Accept-timeout is the maximum time the inviter will wait for the entire acceptance handshake to complete - from the moment the invitation is printed to the moment an acceptance message is received. Connection timeouts govern how long the application waits for individual protocol messages to arrive over the network and vary by channel.

On acceptance, a fresh shared secret is generated and exchanged, configuration and key are saved on both sides (where applicable), and both applications exit. The user is notified that this was a setup step and instructed to run `psilink exchange` when ready.

If a `psilink.yaml` file exists, such as one generated by `psilink init`, it will be used to set the exchange details. Whether or not the partner accepts the invitation, the pre-existing configuration file persists. If a configuration file does not exist, default values are used for connection parameters and linkage keys, metadata, and cleaning transformations are inferred from the input file. If the partner accepts the invitation then this default configuration is saved as `psilink.yaml`; otherwise it is discarded because the partner did not accept.

If the `--exchange` flag is specified, the inviter signals readiness to exchange immediately. The inviter must wait while the acceptor makes their decision. If the acceptor also chooses to proceed, the exchange is conducted before both exit. If the acceptor instead saves-and-quits (see [Acceptance](#acceptance)), they communicate their choice to the inviter and both parties exit without exchanging, saving their copies of the persistent secret. Each party is instructed to run `psilink exchange` when ready.

The `--config-file` flag can point to an existing configuration file to use as a base; `--key-file` can point to an existing key file. If `--key-file` is not used and a `.psilink.key` file exists, the user is warned about its existence and told to either delete it or specify a different key file in case reusing that secret was not their intention.

## Invitation strings

Invitation strings are base64url encoded, unpadded representations of the information necessary to conduct an exchange. In particular they contain:
- Connection information
- Linkage terms
- Invitation authentication token (short-lived; rotated to a persistent secret on acceptance)
- A 4-byte hash of the above, used to check for transcription errors

Invitation strings beginning with `-` may be misinterpreted as option flags by argument parsers. All positional arguments and unrecognized flags are validated against the invitation string schema, so the string is identified unambiguously regardless of its position or leading character.

## Acceptance

```sh
psilink accept INVITATION [INPUT_FILE]
```

The `INVITATION` argument is either a base64url string or an `@path` reference to a file containing one. This decodes the invitation string and displays top-level information, including the identity of the inviting party, the PSI algorithm, which parties will receive data, and the linkage keys that will be used. The user can abort or accept. Accepting saves the configuration and the newly-generated persistent keys on both sides and both applications exit; users are notified that this was a configuration and key exchange only and are instructed to run `psilink exchange` to conduct the data exchange. This two-step design is intentional: the config-based path is meant to be methodical, giving each party time to review the saved configuration and prepare their data independently before the exchange begins. If `INPUT_FILE` is provided, it is used to infer the acceptor's column metadata and data standardizing transformations, which are merged with the invitation's linkage terms and saved into `psilink.yaml`.

If a configuration file already exists, it is compared against the connection information and linkage terms to see if there are any disagreements. If so, the acceptance fails without being rejected and without notifying the inviter. The user is shown which values differ and instructed to delete the file or use the `--config-file` option (see below) if they want to proceed. After this, the program exits. After addressing the conflict, the user can run `psilink accept` with the same invitation string to try again. The presence of a pre-existing `.psilink.key` file produces a similar error state. In this way, accepting an invitation does not cause files to be unwittingly overwritten.

If the inviter used the `--exchange` option (see [Invitation](#invitation)), the acceptor is offered the additional choice to proceed immediately with an exchange or to save the configuration and key but quit for the moment. If they choose to proceed, the output path is requested at the prompt before the exchange begins. The save-and-quit option is for acceptors who agree to the linkage terms but need to prepare first - for example, to add their own data standardizing transformations or adjust other local configuration in `psilink.yaml`. If they choose to save-and-quit, this is communicated back to the inviter whose program will indicate that their partner needs time to prepare and that they can run `psilink exchange` in the future; their application will then exit. The key is saved so the shared secret is not lost; when ready, the acceptor also runs `psilink exchange`.

The `--config-file` and `--key-file` flags can specify non-default paths for the saved configuration and key file respectively, which is useful when managing multiple exchange partners.

## Recurring exchange

```sh
psilink exchange INPUT_FILE [OUTPUT_FILE]
```

The application loads configuration from `psilink.yaml` and conducts the exchange without further coordination. The `--config-file` and `--key-file` flags can point to different configuration and key files respectively. The shared secret is rotated after each successful exchange.

## Recovery

In case the shared secrets ever get out-of-sync - for example if one party crashes between key rotation and writing - the recovery path is for both parties to delete their existing secret files. Because there is no way to determine which party holds the newer secret, both must reset regardless of which side failed; reusing an older key may also violate key rotation policies. One party should then generate a new invitation using `psilink invite` which the other should accept.

To recognize failed rotations, the error messages for exchanges that fail PAKE authentication include recovery instructions.

## See also

- [EXCHANGE_SPEC.md](EXCHANGE_SPEC.md) - exchange specification format consumed by the CLI
- [SECURITY.md](SECURITY.md) - authentication model underlying the invitation and recurring exchange flow
- [DEPLOYMENT.md](DEPLOYMENT.md) - operating the supporting services used by the CLI
- [DESIGN.md](DESIGN.md) - overview of the user journey and command table
