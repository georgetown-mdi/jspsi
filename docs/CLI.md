---
title: "PSI-Link CLI"
---

# PSI-Link CLI

This document covers the CLI commands, configuration files, invitation strings, and recovery procedures for PSI-Link. It does not cover the PSI protocol (see [PROTOCOL.md](spec/PROTOCOL.md)), the security and authentication model (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md)), or deployment of supporting services (see [DEPLOYMENT.md](DEPLOYMENT.md)). Intended readers are IT staff and power users.

Before a first SFTP exchange against a server you do not administer yourself, work through the [SFTP server checklist](DEPLOYMENT.md#sftp-server): the settings covered there -- upload-triggered automation, scanning, auto-cleanup, account permissions, anti-flood bans, and session limits -- are the usual cause of an SFTP exchange that stalls, and each one reaches you as that stall rather than as a message naming it.

## Configuration

Exchange details are stored in two files: a configuration file and an authentication key file. The default file names and paths are `./psilink.yaml` and `./.psilink.key`, while command line arguments to override are `--config-file` and `--key-file` respectively. When these files are first created, the application prints a notice identifying both and gives a warning that the key file should be treated as private. For Docker deployments, agencies are expected to mount one directory per exchange partner, so the working directory itself provides isolation and no subdirectory is needed.

The configuration file is not intended to contain secrets and is safe to commit to version control. The shared secret and its expiration are stored in the key file instead; they never appear in the configuration file and are not user-editable because the application rotates them automatically. By default, the key file is intentionally named with a leading dot (`.psilink.key`) so that it is hidden from default directory listings and less likely to be accidentally copied or included in an archive; it should be added to `.gitignore`. All other credential fields use the `@path` convention described below.

Command line arguments take precedence over values in the configuration file, allowing scripted workflows to override specific parameters without modifying the stored configuration. Credential and opaque string fields support `@`-file references: a value beginning with `@` is read from the file at the given path rather than used literally - for example, `--server-private-key=@/run/secrets/id_rsa` reads the private key from disk. This convention applies both on the command line and in the configuration file, and is the recommended approach for any credential to avoid exposing sensitive material in process listings or shell history. Which fields it applies to, and what a leading `@` means in every field it does not, are in [File references](EXCHANGE_REFERENCE.md#file-references).

When a credential supplied as an `@`-file reference is written into a configuration file -- by a zero-setup run with `--save` or by the `invite`/`accept` provisioning commands -- the saved file records the original `@path` reference, not the resolved secret, so the secret is never copied into `psilink.yaml` and the file remains safe to commit; `psilink exchange` writes no credential, editing an existing `psilink.yaml` only to record a host-key pin (see [SFTP host-key trust](#sftp-host-key-trust)). A credential supplied as a literal value is saved as-is. The stored reference is the string exactly as typed: a `~/`-relative reference such as `@~/.ssh/id_rsa` therefore stays valid when the configuration is moved to another machine, while a relative reference such as `@secrets/pw` is resolved against the working directory of whichever later command reads it -- use an absolute or `~/` reference if that command will run from a different directory. A saved `@path` is resolved when the configuration is loaded for the next exchange, before any network activity; if the referenced file has since been moved, deleted, made unreadable, or emptied, that load fails with a usage error naming the reference and no connection is attempted.

The "safe to commit" property protects the author of a configuration, not whoever later runs it. Never run `psilink exchange` against a configuration from an untrusted source: treat one received from a partner or pulled from a shared repository as you would treat handing over the files it references.

- **What the load reads.** Every `@path` credential reference in the configuration is read from your local disk, with your privileges, before the exchange runs.
- **Where it goes.** For an SFTP exchange the resolved `server.password` is sent as the SSH password to the configured `server.host`, so the referenced file's contents leave your machine.
- **What cannot introduce it.** An invitation carries no credential by construction, and the connection details on the accept path come from your own command line, so only a wholesale substituted configuration file reaches this.

The threat model behind the rule -- what a substituted configuration can do with a reference and why it is not cheaply detected -- is in the [security design](SECURITY_DESIGN.md#configuration-file-trust-boundary).

The `--config-file` and `--key-file` arguments are expected to be available for all relevant commands below, and are thus not explicitly listed.

`--identity IDENTITY` supplies this party's label in the linkage terms -- what your partner reads as your name there, in the invitation, and in the exchange record.

**Where it is required.** [`psilink invite`](#offline-invitation) and [`psilink accept`](#offline-acceptance) author a durable partnership -- a configuration, an invitation, the instructions a partner follows -- so each refuses to proceed unnamed and exits 64.

**Where a configuration supplies it.** A run over a pre-existing configuration that it does not rewrite -- inviting from one, or [accepting over one it keeps](#existing-files) -- takes the label from that file's `linkage_terms.identity` and reports a typed `--identity` as having no effect. A configuration carrying none is refused, naming the field to set, and so is one still carrying the placeholder below: the file (not this one invocation) is what every later run sends, so renaming the party is an edit of that file.

**Where it is optional.** The zero-setup form runs with or without it: given a label, that label rides into the terms; given none, the terms carry none, and nothing is asked. [`psilink exchange`](#recurring-exchange) takes the configuration's `linkage_terms.identity`, which `--identity` replaces for that one run, and runs unnamed when neither supplies a label.

**Where it is asked for.** With a terminal on standard input and no `--identity`, [`psilink init`](#initialization) and [`psilink accept`](#offline-acceptance) ask for the label rather than leaving you to the flag, and the answer goes into the configuration file that command was already going to write -- nowhere else, and nothing is kept outside the directory you pointed the command at. The flag is the non-interactive path on both: supplying it asks nothing, and a run with no terminal to ask at -- a pipe, a container started without `-t`, a CI job -- asks nothing either. What that run does instead is the command's own rule: `init` writes the placeholder below, and `accept` refuses (exit 64) rather than blocking on a question nothing will answer. An answer takes exactly the treatment a flag value takes: trimmed, blank read as absence, and the template placeholder refused. Nothing is asked where a command writes no configuration -- an acceptance that keeps an existing one, an `init` whose overwrite you declined -- since there is no file for the answer to be remembered in. `psilink invite`, `psilink exchange`, and the zero-setup form never ask: their label comes from a configuration file they do not rewrite, or from the flag alone.

**What absence means.** psilink stands in no label of its own -- not the account it runs as, not a placeholder. A run with no identity sends none: the terms omit the field, the exchange record omits its own, and every surface that shows a party name shows an absence marker (`(no name given)`) rather than inventing one. A signed receipt is the one thing an unnamed run cannot produce: a certificate is trusted by the identity its holder used in the agreed terms, so a run with `signing.mode: certificate` and an unnamed party on either side stops rather than producing a receipt nobody can verify -- for this party's own absence before the exchange starts (exit 64, see [Signing identity and the agreed terms](#signing-identity-and-the-agreed-terms)), and for the partner's at terms agreement, the first point their terms are in hand, so the run ends before any linkage key or data crosses.

A flag value that is empty or blank -- what a scripted `--identity "$ORG"` sends when `ORG` is unset -- reads as absence, not as a label: where the flag is required that is a usage error (exit 64), and where it is optional the run proceeds with no identity. A blank `linkage_terms.identity` in a configuration file reads the same way where a label is required: `psilink invite` over an existing configuration refuses a whitespace-only one exactly as it refuses a missing one, rather than minting an invitation whose inviter heading renders empty, and an acceptance that keeps one refuses it the same way. The label a named configuration sends is its own bytes, whitespace included -- `psilink exchange` reads it straight from the file -- so for that path trimming decides only whether a run is refused, never what rides into the agreed terms. A `--identity` flag value is trimmed before it rides: what reaches the terms is the trimmed string, not the bytes typed at the flag. Either way a certificate authorizes an exact identity string, so a signing identity bound to a padded value diverges from a flag-supplied identity, which trims the padding away; an exchange that signs receipts under it is refused before it runs (see [Signing identity and the agreed terms](#signing-identity-and-the-agreed-terms)).

**What the template leaves you to fill in.** `psilink init` writes a placeholder into `linkage_terms.identity` when the run gives it no `--identity` -- like the connection's host and username, the template is a scaffold to hand-edit. That exact placeholder value is refused wherever a label is read, as firmly as an absent one: [`psilink invite`](#offline-invitation) over a configuration still carrying it names the field to edit rather than minting an invitation under it, and on a path where the flag itself supplies the label, a command given it as `--identity` exits 64 before anything is sent. Over a [kept configuration](#existing-files) that already carries a real label, [`accept`](#offline-acceptance) -- like `invite` before it -- proceeds under that stored label and reports the placeholder flag as having no effect rather than exiting; the kept configuration's own placeholder is still refused (see [Offline acceptance](#offline-acceptance)). It is matched whole, ignoring surrounding whitespace, so a name that merely contains those words is a label like any other.

A leading `~` (or `~/`) in a local filesystem path -- whether given on the command line or written into the configuration file -- is expanded to the current user's home directory. Which paths are expanded depends on the command:

- The path inside an `@`-file reference (for example, `@~/secrets/id_rsa`) is expanded wherever a reference is resolved.
- `psilink exchange` expands `--config-file`, `--key-file`, `--record-file`, the input and output paths, and `signing.identity_file`.
- The zero-setup form expands `--config-file`, `--key-file`, and `--record-file`; its input and output positionals are taken literally.
- `psilink init` expands `--config-file`; `psilink fingerprint` expands `--config-file`, `--identity-file`, and `--export-certificate`; `psilink verify-receipt` expands `RECORD`, `--keys`, `--signed-record`, `--config-file`, `--partner-terms`, `--identity-file`, and `signing.identity_file`.
- `psilink invite` and `psilink accept` expand no path argument. A `~/`-relative path given to either is taken literally and creates a directory named `~`, so pass an absolute path.

Note that `~user` (another user's home) is not resolved.

When a connection is supplied as a URL, psilink percent-decodes the host, path, username, and password into the stored connection fields, so a reserved or non-ASCII character must be percent-encoded in the URL and is stored decoded -- for example `sftp://user@host/my%20drop` targets the directory `my drop`, and a percent-encoded password is sent decoded. All URL-to-config paths decode identically. A malformed percent-escape (such as a lone `%`) is rejected with a usage error (exit 64), and the credential is redacted from the message.

An `INPUT_FILE` argument may be given as `-` to read the CSV from standard input instead of a file on disk -- for example, `cat data.csv | psilink exchange - results.csv` -- so a pipeline need not stage a temporary file. This applies to `psilink exchange`, the zero-setup form (`psilink URL INPUT_FILE`), `psilink invite`, `psilink init`, and `psilink verify-receipt` -- for the last, to its `INPUT_FILE` only; the `RESULT_FILE` positional must be a path. For `psilink accept` it applies only with `--consent-to-terms`: `accept` normally reads its interactive confirmation from standard input and so cannot also take the CSV there, so a `-` input is rejected with guidance to give a file path; passing `--consent-to-terms` skips that prompt and frees standard input, so `accept --consent-to-terms - ...` reads the CSV from stdin like the others. `psilink init` reads its CSV from standard input the same way, so a `-` input means `init` cannot also prompt there: when a configuration file already exists at the output path and the CSV comes from stdin, `init` fails closed rather than overwriting unprompted (the same conservative default it applies in any non-interactive context). Passing `-` at an interactive terminal with nothing piped in is reported as an error rather than left waiting silently for input -- pipe the CSV or pass a file path.

### What the CSV read refuses

An `INPUT_FILE` is checked as it is read, before any credential, terms, or data are sent, so a file that cannot be exchanged faithfully stops the command instead of producing a result that looks legitimate:

- **A row that cannot be parsed** -- an unterminated quote, or a row whose field count differs from the header -- stops the command with a usage error (exit 64) naming the data row and the reason. The rows such a file yields are not the rows it contains: one stray quote swallows everything after it into a single field, a surplus field's values are dropped, and a row missing its last column reads as having no value there. Left to run, that reaches your partner as a smaller dataset than you meant to send and comes back as a result indistinguishable from a genuine low-match run.
- **A CSV with no data rows** -- an empty file, or a header with nothing under it -- stops the same way. Every later stage accepts an empty dataset, so an unattended run would exchange nothing, write an empty result, attest that count, rotate the shared secret, and exit 0.

Both refusals happen before the exchange begins: nothing is disclosed, no configuration or key file is written, and the shared secret does not rotate. Correct the file -- usually the export that produced it -- and run the command again.

The row check applies to every command that reads a CSV to set up or run an exchange (`psilink exchange`, the zero-setup form, `psilink invite`, `psilink accept`) and to the files `psilink verify-receipt` reads. The empty-dataset check applies to the exchange commands only: a result CSV with no rows is what a genuine zero-match exchange writes, and `psilink verify-receipt` must still be able to verify one. `psilink init` applies neither -- it reads the header and a bounded sample of one column to write its template, never the whole file -- so a template can still be authored from a file these checks would refuse for an exchange.

Durations on the command line are written as a positive integer followed by a single-character unit -- `s` (seconds), `m` (minutes), `h` (hours), or `d` (days); for example `45s`, `30m`, `2h`, or `1d`. The unit suffix is required: a bare number such as `30` is not a valid duration and is rejected with the suffixed form to use (`30s`) rather than silently read as seconds. This applies to every duration-valued option, including `--expires-in`, `--accept-timeout`, `--connection-timeout`, and `--peer-timeout`.

`--polling-frequency` sets how often the `sftp`/`filedrop` channels poll the shared directory for the partner's files, overriding the `poll_interval_ms` configuration field (default `5s`). It is duration-valued like the flags above -- the unit suffix is still required, and a bare number is still rejected the same way -- but it additionally accepts a millisecond unit, so a sub-second value such as `100ms` is expressible; the millisecond unit is unique to this flag, and the other duration options still reject a sub-second or `ms` value. A conservative interval stays within SFTP servers' anti-flood limits, and because the per-round encryption dominates an exchange's wall-clock time a multi-second poll adds negligible latency, so the flag exists mainly to let a demo opt into a fast poll against a controlled server. There is no hard floor, but a value below `1s` is warned about (not blocked): a sub-second poll can trip an SFTP server's anti-flood/DoS protection and drop the connection. The flag takes effect on the commands that build a live connection -- the zero-setup exchange, `psilink exchange`, and the online `invite`/`accept` -- and, like the other connection-tuning flags, is reported as ignored on an offline `invite`/`accept` (set `poll_interval_ms` under `connection.options` in the written configuration instead).

The timeout flags `--connection-timeout`, `--peer-timeout`, and `--accept-timeout` also have a sanity ceiling of `7d`: a value above it is rejected with a usage error naming the flag and the maximum, before any connection attempt, token, or file write. A timeout is a coordination window that even a generous async setup measures in hours, so a value past a week is treated as a mistake rather than an intent; this is a usability guard, not a security bound (the accept window is in any case bounded by the invitation lifetime). It is separate from the `--expires-in` one-year ceiling, which bounds how long the invitation stays valid rather than how long a command waits.

### A rule-set citation that no longer fits

`linkage_terms.linkage_rule_set` names the rule set your linkage fields and keys were drawn from, and every path that fills those lists in for you writes it -- including the template `psilink init` produces. Nothing re-decides it when you edit `linkage_fields` or `linkage_keys` by hand, so a citation can outlive the rules it describes and travel that way onto the invitation, your partner's terms review, and both parties' exchange records. See [`linkage_terms.linkage_rule_set`](EXCHANGE_REFERENCE.md#linkage_termslinkage_rule_set) for what the citation does and does not settle.

Every command that reads linkage terms out of a configuration file checks the citation against that file's own rules and warns when they no longer support it, naming the cited set and which of the two lists diverged: `psilink exchange`, an offline `psilink invite` that takes its terms from the configuration, a `psilink accept` that reuses one already at the path, and `psilink verify-receipt` reading your terms from `--config-file`. It is a warning, not a refusal -- the file is yours, and the citation is recorded and displayed but never selects or alters matching, so the command proceeds. Omit `linkage_rule_set` for rules you author yourself, or restore the rules the cited set declares.

A configuration an acceptance stands behind is the other case, and the warning offers a different remedy there. Those terms are the ones you and the inviting party agreed on, so restoring the cited set's rules would edit that agreement single-handedly, and the exchange would refuse the result against the partner still running the originals. Settle the citation with that party and accept again, or decline to reuse those terms -- and on an offline `psilink invite`, where you are minting a new invitation from those terms rather than putting them to use, author fresh terms for the invitation instead.

That case is recognized from a record `psilink accept` writes into the configuration it produces or reuses, so only the accepting side of an exchange has it. An invitation you sent and a partner accepted leaves nothing in your own file to read, so your copy still reads as terms you hold alone -- and the remedy offered there, restoring the cited set's rules, can still take terms out of an agreement the CLI has no way to see. Check with your partner before acting on it.

Only a set this build ships can be checked. A citation naming another set, or the built-in set at a version this build does not carry, passes without comment: there is nothing behind that name here to compare your rules against. The field set and the key set are checked separately, so a citation pairing a name this build does not know with the built-in key set is still held to the built-in keys. A partner's citation on an invitation is their statement about their own rules; `psilink accept` runs this same check over it against the rules the invitation declares and shows the per-half verdict on the accept prompt before you consent.

## Initialization

```sh
psilink init [INPUT_FILE]
```

This creates a configuration file and then exits - no exchange or invitation is generated, and no key file is created. The file is a commented template with every option documented inline and all defaults pre-filled; if an input file is provided, column metadata, linkage fields, and data standardizing transformations are inferred from it. The user can then edit the file by hand before running their first exchange. Pass `--identity` to pre-fill the linkage-terms identity. Without it, `init` asks for one where there is a terminal to ask at and writes your answer into the template; where there is none, or where the answer is blank, a placeholder is written instead, and it is refused wherever a label is read until you replace it (see [Configuration](#configuration)). The [web console appliance](DEPLOYMENT.md#server-job-api) is an alternative to hand-editing this template: an operator prototypes one exchange there and the console produces a recurring-run hand-off -- a filled-in `psilink.yaml` (or the zero-setup command), the `psilink exchange` command, and cron/Task Scheduler examples -- to carry that run to a scheduled command-line exchange (see [Recurring exchange](#recurring-exchange)). The hand-off fills in the portable settings that carried over from the run and marks the machine-specific paths as placeholders to set; it is not a full guided-authoring wizard. On success the command prints a notice identifying the configuration file it wrote and exits 0; invalid caller input (an unreadable or malformed `INPUT_FILE`) exits 64, and the command performs no network activity on any path.

If a file already exists at the output path, the user is prompted before overwriting; declining leaves the existing file untouched. When no terminal is available to prompt (a non-interactive run, or a `-` stdin CSV that has already claimed standard input), `init` fails closed with a usage error rather than overwriting silently - delete the file or pass `--config-file` to write elsewhere.

The identity question follows that decision, so a run that leaves the existing file alone asks nothing further. Both questions read the same standard input, and a `-` stdin CSV has already claimed it: an `init` reading its CSV that way is asked neither question.

## Zero-setup exchange

```sh
psilink [--identity IDENTITY] [--save] [--linkage-strategy STRATEGY] [--sweep-exchange-files [--force-retain-sweep]] URL INPUT_FILE [OUTPUT_FILE]
```

Both parties run this command against the same server. Linkage terms, metadata, and data standardizing transformations are inferred from each party's input file; if the inferred terms disagree, the exchange fails with an error. Users are expected to prepare files with matching schemas before running. The server coordinates their connection and the exchange proceeds immediately without any prior configuration. By default, no configuration files are written. This mode is suitable for one-off exchanges and for onboarding sessions where both parties are in direct communication. Security relies on the transport authentication layer and file system controls rather than a pre-shared secret. If there is no end-to-end encryption (e.g. SFTP or file-drop), then implicitly trust is placed in the server administrator.

`--linkage-strategy STRATEGY` chooses the linkage strategy (`cascade` or `single-pass`) exactly as for [`psilink invite`](#offline-invitation), with the same `single-pass` disclosure tradeoff. Because each party infers its own terms here rather than one party authoring them for both, both parties must pass the same value: the strategy is a mandatory-consistency term, so a mismatch aborts the exchange. An unknown value is a usage error before any connection is attempted.

The URL scheme determines the transport channel:

| Scheme | Channel | Description |
|--------|---------|-------------|
| `sftp://` or `ssh://` | `sftp` | SFTP server; SSH credentials required |
| `ws://` or `wss://` | `webrtc` | WebRTC via a PeerJS peer-coordination server (not available in a zero-setup exchange -- see below) |
| `file://` | `filedrop` | Locally-mounted shared directory (e.g. NFS or SMB share) |

A zero-setup exchange cannot run over `webrtc`, and a `ws://` or `wss://` URL is refused here with that reason (exit 64). The two parties find each other at signaling ids derived from a shared secret, and a zero-setup exchange is defined by not having one: with nothing shared beforehand there is no address to dial. Establish a secret with [`psilink invite`](#offline-invitation) and [`psilink accept`](#offline-acceptance), then run the exchange with [`psilink exchange`](#webrtc-exchanges).

For SFTP, SSH credentials must be supplied in the URL or as command-line arguments. Embedding credentials in the URL is not recommended as URLs may appear in shell history and process listings; use the `@path` convention instead - see [Configuration](#configuration).

```sh
# SFTP example
psilink --identity "Jane Doe, County Health" sftp://user@sftp.example.org/exchanges/drop input.csv output.csv

# File-drop example, running unnamed (network-mounted folder)
psilink file:///mnt/sftp-share/drop input.csv output.csv
```

Before running, users are warned about the limitations of the security model, namely that they must trust the server's administrator.

If `--save` is not specified, after running users are instructed how to use `psilink invite` and `psilink accept` to establish a recurring exchange. `--save` usage can be discussed during onboarding.

If `--save` is specified, intent is advertised to the partner in-band at the start of the exchange; outcomes for each party are described in [Bootstrapping a shared secret](SECURITY_DESIGN.md#bootstrapping-a-shared-secret). The save happens after the exchange has completed and its result is written, so a save that cannot reach disk is reported as a lost local write (exit 73, and a `warning` on the event stream) rather than as a failed exchange -- see [Exit 73](#exit-73-the-exchange-completed-a-local-write-did-not).

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

Invitation strings beginning with `-` may be misinterpreted as option flags by argument parsers. On `invite`, `accept`, and `init`, a single-`-`-leading token is kept as a positional and validated against the invitation string (or file) schema, while a `--`-prefixed token -- which a positional never is -- is rejected as an unrecognized option (exit 64), so a `-`-leading invitation is identified unambiguously and a mistyped flag is still caught.

## Offline invitation

When both parties are not simultaneously available or prefer not to use a coordination server, invite and accept can be performed without any server connection.

```sh
psilink invite --identity IDENTITY [--expires-in DURATION] [--linkage-strategy STRATEGY] [INPUT_FILE]
```

This generates a shared secret, saves the `sharedSecret` and an `expires` field to a key file, prints an invitation string (see [Invitation strings](#invitation-strings)) and instructions for its use, and then exits immediately. The invitation should be forwarded to the user's partner using a trusted out-of-band channel (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md)).

By default the invitation expires one hour after the shared secret is generated. Pass `--expires-in DURATION` to override that lifetime - for example when the out-of-band coordination window is longer or shorter than an hour. Prefer the shortest window your coordination allows: a longer lifetime proportionally widens the period in which a leaked-but-unaccepted invitation could be used by a third party. `DURATION` is a positive integer followed by a required unit suffix: `s` (seconds), `m` (minutes), `h` (hours), or `d` (days), for example `30m`, `2h`, or `1d`. A zero, negative, or otherwise malformed value is rejected with an error before any invitation is generated, as is a value beyond the one-year maximum (`365d`): the setup secret is short-lived by design, so its lifetime is bounded even when overridden (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md)).

Pass `--linkage-strategy STRATEGY` to choose how the agreed linkage keys are run on the wire; `STRATEGY` is `cascade` (the default) or `single-pass`, and any other value is rejected as a usage error before any invitation is generated. `cascade` runs one dependent PSI round per key, so the round-trip count grows with the number of keys; `single-pass` batches every key into one exchange so the round-trip count stays constant, which is what makes a multi-key linkage practical over a high-latency channel (`filedrop` or `sftp`). Both produce the same matched result. `single-pass` is not a free optimization: to reconstruct the cascade in one pass the sender discloses its full per-key value structure to the receiver, so the receiver observes matches on less precise keys that `cascade` would have filtered out before exchanging them. Selecting it prints a note to that effect, and the partner sees the same note on their consent prompt -- the strategy is a mandatory-consistency term, so both parties must end up agreeing on it or the exchange aborts. Choose `single-pass` only when the round-trip saving is worth that additional disclosure; see [`linkage_terms.linkage_strategy`](EXCHANGE_REFERENCE.md#linkage_termslinkage_strategy) for the full tradeoff. The flag selects the strategy for terms inferred from `INPUT_FILE`; when the linkage terms instead come from a pre-existing configuration file, that file is authoritative and the flag is reported as having no effect (set `linkage_strategy` in the configuration to change it).

Generating an invitation requires either a pre-existing configuration file or an `INPUT_FILE` from which linkage terms are inferred. If both types of files are present, the configuration file supplies the linkage terms and the input is checked against them; a conflict raises an error stating why an invitation cannot be generated.

That authoring-time check grades the input against the configuration's linkage terms on the same verdict `psilink exchange` enforces at the run boundary, so an invitation is minted only when every agreed linkage key can actually contribute:

- A key is unsatisfiable when the columns in the input cannot be transformed through available data standardizations to produce a linkage field the key references, so the file cannot satisfy a key the partner will expect.
- A key is dead when its own declared cleaning can never produce a value whatever the data, for example a `parse_date` whose input format omits a required component. Such a key would run to a silent empty result, so the remedy is a corrected configuration rather than a different input file.

The refusal names the keys it blocks on and the linkage fields those keys cost, and points at the configuration the terms came from. Both surfaces read the same verdict, so what an operator meets here is the refusal `psilink exchange` would raise against the same CSV -- reached before the invitation is disclosed rather than after a partner has accepted it.

Whichever source supplies the terms supplies the identity in them. Inferring the terms from an `INPUT_FILE` requires `--identity`; taking them from a pre-existing configuration file mints the invitation under that file's `linkage_terms.identity`, and an `--identity` given there is reported as having no effect (edit `linkage_terms.identity` in the configuration to change it). Either way an invitation names its inviter: a configuration carrying no identity is refused rather than minted under none, since `--identity` cannot stand in for a file that persists unchanged and supplies every later run.

If only an `INPUT_FILE` is given, the inferred linkage terms, metadata, and data standardizations are written to a configuration file. The user is notified that they must fill in the connection block of the configuration file in order to conduct exchanges.

### Abandoning a pending offline invitation

To withdraw a pending offline invitation before its nominal `expires`, delete the key file it wrote (`.psilink.key` at the default path, or the `--key-file` path). The offline key exchange completes only when the inviting party still holds the pending shared secret, so removing the inviter's copy invalidates the invitation: the secret carried in the invitation string you forwarded can no longer authenticate a handshake against you, and the partner's copy is inert on its own without a live inviter to exchange with. Delete only the key file -- any configuration file (`psilink.yaml`) is left in place, so abandoning a pending invitation never disturbs a recurring exchange the same configuration still serves. The `invite` command prints this reminder, naming the key file, when it generates an offline invitation.

This is distinct from recovering a lost, reset, or compromised key (see [Recovery](#recovery)): it is the supported way to deliberately retract an invitation you have changed your mind about, not a response to exposure. Taking no action also closes the window -- the invitation lapses on its own at the `expires` shown when it was generated -- but deleting the key file closes it immediately rather than waiting out the lifetime.

## Offline acceptance

```sh
psilink accept --identity IDENTITY INVITATION [INPUT_FILE] [OUTPUT_FILE]
```

The `INVITATION` argument is either a base64url string or an `@path` reference to a file containing one. This command decodes the invitation token, displays what acceptance discloses, and asks you to confirm it. On a yes, configuration and key files are created (with exceptions noted below) and, unless the acceptance runs the exchange itself, you are told to fill in your connection parameters before conducting exchanges; on a no, nothing is written. Coordination with the partner happens out-of-band, for example if the linkage terms are unacceptable or if the invitation expires.

`--identity` names this party in the terms the acceptance records. Without it, at a terminal, `accept` asks for the label once the invitation has decoded and before the terms are displayed -- the same interactive session that then shows them and takes the y/N -- and the answer is what the configuration it writes carries. Where nothing can answer, an acceptance with no label is refused (exit 64) rather than left waiting: with no terminal, and under [`--consent-to-terms`](#accepting-without-the-prompt), which declares the run unattended. An acceptance that keeps an [existing configuration](#existing-files) asks nothing either, and needs nothing supplied: it proceeds under that file's own `linkage_terms.identity`, which is what the exchanges the file governs send. A `--identity` given on such a run is reported as having no effect, naming both labels and the field to edit. That notice travels with the terms display rather than as an ordinary diagnostic: it is reported before the terms, and where acceptance stops to ask, on the terminal it asks on whatever `--log-file` and `--log-level` are set to (see [Where the display is shown](#where-the-display-is-shown)) -- so on a run that stops to ask, the name your partner reads never diverges from the one the kept file carries without your seeing it first. An unattended run -- [`--consent-to-terms`](#accepting-without-the-prompt) at a `--log-level` above `warn` (`error` or `silent`) -- reports the notice nowhere; the run still proceeds under the kept file's label either way. A kept configuration carrying no label, or still carrying the placeholder, is refused (exit 64) rather than run unnamed.

`OUTPUT_FILE` is where the result goes, and belongs to an acceptance that runs its own exchange (see [Accepting and running a WebRTC exchange](#accepting-and-running-a-webrtc-exchange)); omit it and the result is written to standard output, exactly as `psilink exchange` writes it. An acceptance that writes only a configuration and key file has no result to send there and reports the argument unused rather than dropping it.

An argument past the last positional a form names is a usage error (exit 64), on this form and on the [online](#online-acceptance) one alike. The two forms read the same position differently -- the third is the `OUTPUT_FILE` here and the `INPUT_FILE` there -- so an extra argument is reported with the form's usage rather than ignored.

### Enforced, or your partner's word

Every fact the display states carries the basis it rests on, so the two are never told apart by omission:

- `(enforced)` -- psilink holds the fact itself. Either it is true of the run, or the exchange aborts rather than proceed without it.
- `(your partner's word)` -- the fact is what your partner declared. psilink shows it faithfully but neither verifies nor enforces it, and a partner that does not honor it is not stopped by this tool.

A fact that needs more than the marker carries its explanation on the line below it, in the same wording the web consent screen uses for the same fact.

### What the display shows, in order

The display is an indented outline, one entry per line. It leads with what this party itself discloses -- the hardest thing to undo -- before the terms the invitation proposes.

An acceptance that runs the exchange itself (see [Accepting and running a WebRTC exchange](#accepting-and-running-a-webrtc-exchange)) says so above the outline, since on that path the confirmation is the last checkpoint before your data moves. Two lines state it: the coordination server the run resolves to dial, host and port, and what confirming does -- connect to that server immediately and run the exchange from your input file, transmitting your linkage data on the terms below it; declining writes nothing and connects to nothing. Under `--consent-to-terms` the same two lines state the run the recorded consent authorizes. An acceptance that writes a configuration and stops dials nothing and carries neither line.

- **`columns you will send`** (`enforced`) -- the columns this party will send to your partner for matched records, one per line. It reads `(none)` in the three cases where nothing leaves: your file discloses no columns; the invitation gives the inviting party no result, in which case the payload step transmits nothing at all and no column set is listed -- your input file cannot change that answer; or the algorithm is `psi-c`, which moves no payload in either direction whoever receives the count, and the line names the algorithm as the reason. Where columns are listed they are derived from your own input through the same rule that decides what psilink transmits, so no column outside that list is sent. The list is also what acceptance records as your consent to it (see [Confirming what you send](#confirming-what-you-send)), so the bound holds over later runs and not only over the configuration this acceptance writes: a run that resolves a different set -- including one on a configuration that already existed, whose stored metadata nothing here compares against this input -- shows it and asks again rather than send it. Where the set is not yet known -- an offline acceptance given no input file -- the line says so and names what settles it: your input file, read when the exchange runs, which shows the columns and asks you to confirm them there instead. An online acceptance always lists the set, since it prepares the exchange it is about to run and reads the list off that.
- **`inviting party`** (`your partner's word`) -- the name your partner chose for their own terms. psilink has not verified it, and supplies none where they gave none: an invitation whose terms carry no identity reads as `(no name given)` rather than as a blank.
- **`PSI algorithm`** (`enforced`) -- `psi` reveals the shared identifiers of matched records to whoever receives the result; `psi-c` reveals only their count. Both parties must end up on the same algorithm. A `psi-c` invitation carries the count-only lines below with it, immediately beneath the algorithm they qualify.
- **`what a count-only exchange still discloses`** (`enforced`) -- shown for a `psi-c` invitation. A count-only run hands neither party a matched pairing, but each round still carries one encrypted element per value a party contributed, and the terms exchange already carries each party's raw row count. Neither figure is the intersection, and the count-only mode hides neither.
- **`how the count reaches each of you`** (`your partner's word`) -- shown for a `psi-c` invitation where both parties are entitled to the count. Only one party computes the number; the other is sent that party's report, which psilink does not check. Where exactly one party is entitled, that party computes its own count and the line is absent.
- **`what a count-only exchange does not bound`** (`your partner's word`) -- shown for a `psi-c` invitation, and never omitted. The count-only guarantee bounds what psilink hands your partner, not what they can learn by choosing which records to ask about: a crafted list, or a second run differing by one record, turns a count into an answer about one person.
- **`exchange files`** (`enforced` on the mode agreement, `your partner's word` on the retention) -- shown when the invitation says the exchange keeps its files: your partner declared retain mode, or the invitation carries a locator giving each side its own drop and pickup directory, a shape that runs only in retain mode and that acceptance configures your own side into. Either way the exchange's files are kept as a permanent transcript at the rendezvous location, not deleted after the run. The mode agreement itself is enforced (a run whose two parties configured different modes aborts); what your partner does with the transcript afterwards, and what anyone who can read that location sees, rests on your agreement, which is what the explanation line states. That explanation is printed once, here in the outline; the line above it is the half repeated at the prompt. An invitation that says neither -- one declaring delete mode, and one declaring nothing -- prints no line here, since neither is a cleanup this transport promises.
- **`linkage strategy`** (`enforced`) -- `cascade` or `single-pass`, with the single-pass disclosure note when it applies. A mandatory-consistency term: the exchange aborts unless both parties agree on it.
- **`you will receive the result`** (`enforced`) -- a `no` means you are sent no result and any result sent to you is rejected.
- **`the inviting party will receive the result`** (`enforced` on a `yes`, `your partner's word` on a `no`) -- the marker follows the answer, because the two are not alike. A `yes` is a disclosure the run itself makes, and what your partner does with the result once it holds it is governed by your agreement rather than by psilink. A `no` is the withholding of a result from a partner, which rests on the agreed terms being honored, not on anything psilink can impose.
- **`what your partner learns either way`** (`enforced`) -- shown when your partner does not receive the result of a `psi` exchange. Helping compute the match tells an honest partner which of its own records are in your data. It is inherent to a match that reveals identifiers, not a breach, and it is bounded: never which of your records they met, nor anything about the rest of your set beyond its size. A count-only (`psi-c`) invitation does not carry the line at all: the party that receives no count computes none and is sent none, so it learns nothing about which of its records match, and what a count-only exchange does disclose is stated with the algorithm instead.
- **`duplicate matches`** (`enforced`) -- whether more than one of your partner's records may match a single one of yours.
- **`matched on`** (`enforced`) -- a single line naming the fields the linkage keys match on.
- **`personal data used`** (`enforced`) -- the categories of personal data the keys are computed over. Under each, **`declared data standards`** (`your partner's word`) lists the standards your partner commits that category to, including any allowed-character pattern. Those are data expectations, not filters psilink applies.
- **`allowed-character patterns`** (`your partner's word`) -- shown once when any field declares one, carrying the caveat that covers every pattern listed above: each is a partner-supplied regular expression psilink has not verified. The patterns themselves are shown in full under the field each belongs to, so a reader who knows regular expressions can inspect what one actually admits.
- **`linkage keys`** (`enforced`) -- each key: the fields it matches on and how broadly (a truncated value, an approximate match), then the elements it combines, the declared field behind each, every value transform with its parameters and what it does to matching, any approximate-match setting, and any swap.
- **`columns you will receive`** (`enforced` where the invitation carries the column set, `your partner's word` where its terms only declare one, then how many columns the declaration holds) -- the columns the invitation says your partner will send for matched records, or `(none)` where it carries an empty set. Only a declared direction reaches this line: where the invitation declares nothing, the line is absent and what arrives is reconciled against your partner's own disclosure when the exchange runs. What your side locks in is the set the invitation *carries* -- the exact columns your partner's own disclosure rule produced -- and your own side is what enforces it: anything else your partner sends is received and then rejected, aborting the exchange. A carried empty set is that same commitment with no column in it. Where the invitation carries no such set, and the columns shown come from the terms your partner authored, the marker says so: there is no recorded set to hold them to, so an online acceptance reconciles what arrives against your partner's own disclosure instead. The abort stops the exchange from completing, not the columns from crossing: each side reconciles what it received only after the payloads have been exchanged, so a violated commitment is caught on the far side of the wire.
- **`columns the inviting party requests from you`** (`your partner's word`, then how many columns the declaration holds) -- a request, not a declaration of what you send; what you actually send is the first line of the display. `(none)` where the invitation declares an empty request: your partner has committed to receiving no column from you, and it is your partner's side that aborts if you send one -- after your values have reached it, since reconciliation follows the payload exchange there too. An absent request is omitted from the display: your partner takes whatever your own metadata discloses.
- **`legal agreement`** (`your partner's word`) -- the reference, the stated purpose, and the date the agreement is valid through, when the invitation attaches one. The reference and the date are byte-compared against your own copy before data moves; the text itself is your partner's, never vetted by psilink.
- **`expires`** (`enforced`) -- the instant past which the invitation is refused, when the token carries one.

Every matching rule is shown here rather than behind a second command: under `psi`, what is matched decides which identifiers are disclosed, so a rule you are consenting to is never hidden. Four kinds of note qualify a rule where it stands:

- **Proposed, not applied.** A term the inviting party declares that this version of the exchange does not yet apply -- an approximate-match setting -- is marked as proposed, so the display never states behavior the run does not perform.
- **Applied, and it discloses more.** Duplicate matching is a term the run does honor, and it discloses more than a one-to-one match does, so the `duplicate matches` line carries a sentence stating what -- and which sentence follows the invitation's output direction, since that decides who reads the grouping. Where the invitation shares the result with you: your side learns, for each of your own matched records, how many of your partner's records group onto it and which rows they are. Where your partner is the sole receiver: it reads that grouping about its own records, you are sent no result, and psilink shows you no group sizes and no row positions. The limit is stated with it: the matching rounds do carry that grouping to your machine, so what you are shown is psilink's own doing rather than something the wire holds back.
- **Applied to your partner's side, not yours.** Beneath that sentence, at the same level, is whose records the setting groups and what it still costs you. Accepting turns it on for the inviting party alone: your own records are not grouped. It still widens what you disclose -- more of your records can match than in a plain one-to-one run of the same two files, each one disclosing its membership and any payload columns you send. Grouping your records instead is set up from each party's own configuration file, where each party declares its own side.
- **Not recognized.** A value transform this version does not recognize is marked as unrecognized rather than printed in the same shape as a rule psilink can explain.

The configuration route the duplicate-matching note names is `psilink exchange` on both sides, each party's `deduplicate` coming from its own configuration file: your `true` against your partner's `false` groups yours alone, and both parties declaring `true` groups both -- a many-to-many match, which runs under `linkage_strategy: cascade`. Accepting an invitation reaches neither: it derives your own side as `false` whatever the invitation declares. See [`linkage_terms.deduplicate`](EXCHANGE_REFERENCE.md#linkage_termsdeduplicate) for what each pair matches and what a both-sided match hands you.

### The decision facts, repeated at the prompt

The full outline runs well past a terminal screen, so the facts heading it -- the columns you will send, the inviting party with its unverified-name note, the PSI algorithm with any note on it, the count-only tier's lines when the algorithm is `psi-c`, and the `exchange files` line, without the explanation beneath it, when the invitation says the exchange keeps its files -- are printed once more, unchanged, immediately before the prompt, where they are on screen when it asks.

That repetition is deliberately those facts and no others, to stay short: terms that bear on disclosure but would lengthen it -- the linkage strategy and, under single-pass, its disclosure note -- appear only in the outline above, and so does the `exchange files` explanation, which runs to about ten wrapped lines and would cost them at each printing. It is not short in every case, since it lists the columns you send one per line: past roughly nineteen disclosed columns the repetition itself runs off a standard terminal -- roughly seventeen when the invitation also discloses retained files -- and what scrolls away first is that column list. Read the outline before answering; the repetition is a reminder of what you read, not a substitute for it.

Under `--consent-to-terms` no prompt follows, so the block is printed under a heading that repeats rather than asks. Its contents are identical either way.

### Where the display is shown

Wherever acceptance stops to ask for confirmation, the terms are shown on the terminal it asks on whatever `--log-file` and `--log-level` are set to, and they read the same at every level: plain, without the timestamp, level, and command name a log line carries ahead of it. You are never asked to accept terms the run did not put in front of you, and never shown a different rendering of them for having silenced the tool.

Where the log would land somewhere else, it keeps its own copy as well: `--log-file` records the terms in the file, at `info` level, and shows them at the prompt. That file copy is a log line like any other, so the level filters it -- a level above `info` (`warn`, `error`, or `silent`) records nothing in the file -- while the prompt copy is untouched by the level and shows the terms in full. Where the log's destination is the terminal the question is asked on, there is no second copy, since the only thing a prefixed one would add is the multi-screen outline a second time.

The outcome of the question is written the same way, on the same terminal at every level: declining prints `invitation declined; no files were written` and stops. That line is what distinguishes a decline from an acceptance under `--log-level silent`, where neither writes a log line -- an acceptance goes on to write the configuration and key file (and, [running the exchange](#accepting-and-running-a-webrtc-exchange), to connect). Both exit 0: a question answered is not a failure, whichever way it was answered.

The no-effect notice an [`--identity`](#configuration) raises over a kept configuration is shown by the same rule, taking `warn` level where the log records it.

The pairing follows the question rather than the terminal: acceptance without `--consent-to-terms` asks even where nothing can answer -- it reads end-of-file and declines -- and the terms go to standard error alongside the question it asked. `--consent-to-terms` is what keeps them off standard error, by asking nothing.

One limit of the pairing: psilink does not verify that the terminal took what it was sent. If standard error stops accepting output partway through -- a full pipe, or a reader that closed early -- the remaining lines are dropped and the question is still asked, so a prompt that arrives after a truncated display is answered against what you can see rather than the whole surface.

### Accepting without the prompt

`--consent-to-terms` records your consent to this invitation's terms in advance and skips the interactive confirmation, so `accept` can run unattended or in a script -- where there is no terminal, the prompt otherwise reads end-of-file and declines. It bypasses the one human checkpoint before the configuration and linkage key are written from the partner-supplied invitation, so review the terms before using it. Where the acceptance [runs the exchange itself](#accepting-and-running-a-webrtc-exchange), that same checkpoint is the last one before it connects to the coordination server the invitation names and transmits, so the flag authorizes connecting and running unattended as well as writing the files. It also silences the identity question, for the same reason and by the same rule: the flag is what frees standard input, so nothing may read it there, and an acceptance given no `--identity` is refused rather than asked. It is off by default: without it, `accept` displays the terms and stops to ask you to confirm them. Since nothing asks, there is nothing to show alongside a question: the terms stay diagnostic output on the routing you chose, so `--log-file` captures them for the unattended run's record and `--log-level silent` drops them. It also frees standard input for a `-` `INPUT_FILE` (see the `-` standard-input note under [Configuration](#configuration)).

### Existing files

If `--config-file` is not used and a configuration file already exists at the default path, its linkage terms are compared against the invitation's; any disagreement causes acceptance to fail. The user is shown which values differ and instructed to resolve the conflict before retrying with the same invitation string or to supply an alternative configuration file path. The comparison is byte-exact on the same predicate the exchange itself applies to those terms (and on the payload slightly stricter: a difference confined to a column description or to column order conflicts here even though the exchange would accept it), so text differing only in its Unicode normalization form is reported here as differing -- a difference the exchange would otherwise refuse to run on, after acceptance had reported the configuration as matching.

A reused configuration keeps its connection block and linkage terms, its `linkage_terms.identity` among them: that label, not a `--identity` typed on the accepting command, is what the acceptance and every exchange the file governs send (see [Configuration](#configuration)). The record of what you consented to *receive* is refreshed to the invitation you have just accepted, so it never lags behind the disclosure you were shown. When that invitation declares no disclosed columns, the record is removed rather than left at a set this acceptance never showed you, and a warning names the columns it held: dropping it means the next `psilink exchange` accepts whatever columns the partner transmits instead of holding the received payload to a consented set. To keep the check, ask the inviting party for an invitation that declares the columns it sends.

A pre-existing key file is treated differently from a configuration file: it is never reconciled or reused, because silently reusing a stale authentication token must never happen. If `--key-file` is not used and a key file already exists at the default path, acceptance fails outright and the user is told to delete it or supply a different key file path. In this way, accepting an invitation does not cause files to be unwittingly overwritten.

### Checking your input against the terms

If `INPUT_FILE` is provided, its columns are checked against the invitation's terms before you are asked to confirm.

The rule is one: acceptance stops unless the input can satisfy **every** linkage key the invitation's terms declare. There is no partial acceptance -- an exchange runs the keys both parties agreed on, so a file that can supply only some of them is a shortfall to settle with your partner before the run, not something to proceed past. The error names what is short and writes no files, and the remedy is a fresh invitation over terms both files can satisfy, agreed out of band.

Three shapes reach that stop, and the error names whichever applies:

- **The input cannot produce a key's fields** -- the columns the key needs are absent, or carry a type the terms' cleaning cannot bind. The error names the unsatisfied fields and the keys they cost. The remedy is a CSV covering those field types, or new terms.
- **A linkage key's own cleaning can never produce a value** -- a `parse_date` whose `input_format` omits a component, or a `substring` whose declared window reads nothing out of a value of any length, so it drops every record regardless of the data. The key is named even though its columns are present: it passes the column check yet would contribute nothing, so the fix is a corrected invitation from the partner, not a different CSV.
- **The invitation's terms declare no linkage key at all** -- there is nothing to match on, so acceptance stops the same way.

A further check covers what the input would send rather than what it can match:

- **The input discloses columns the invitation will not accept** -- the invitation declares the inviting party accepts no payload column *and* is entitled to the matched result, while the input discloses some (the same set the display's `columns you will send` line lists, on an acceptance that reaches that display). A warning names them, one per line, because that disagreement is one the exchange refuses to run on. The two remedies are to set those columns not to transmit in the written configuration (`is_payload: false`, or the `ignored` role), or to ask the partner for an invitation that accepts them. What follows the warning differs by path, and the warning says which:
  - An acceptance that runs the exchange -- online, or from a WebRTC endpoint with an input file -- prepares it before asking you to confirm, so it meets the refusal itself: the command stops as a configuration error (exit 64) before the terms are displayed and without writing a configuration or key file.
  - An acceptance that only writes a configuration prepares nothing, so it is not stopped: confirming writes the configuration and key file, and the refusal arrives when you run `psilink exchange`.

  An invitation that gives the inviting party no result is not this case: nothing is transmitted to a party not entitled to the result, so there is no disagreement, nothing is warned about, and the `columns you will send` line reads the no-payload sentence instead. The check reads the disclosed set the way the run will -- from the configuration's metadata when one was written, else inferred from the input's columns -- so it cannot warn about a set the exchange would not refuse over.

### Accepting and running a WebRTC exchange

An invitation whose [connection endpoint](#invitation-strings) names a WebRTC coordination server carries everything an exchange needs -- the coordination server, the shared secret, and the agreed terms -- and the accepting side takes the `acceptor` end of the rendezvous from the command it runs, so nothing is left for you to fill in. Given an `INPUT_FILE`, acceptance therefore accepts *and* runs the exchange in one invocation, writing the same configuration, key file, audit record, and result that a `psilink accept` followed by a `psilink exchange` writes. That is what lets the partner of an [online WebRTC invitation](#inviting-over-webrtc) meet the inviter inside its accept-timeout without a second command.

The confirmation gates the run as it gates the files: the terms are displayed and confirmed -- or recorded in advance with [`--consent-to-terms`](#accepting-without-the-prompt) -- before anything is written or dialed, and a decline writes no files and opens no connection. What you are confirming is stated with the terms rather than left to be inferred from the command you typed: the display [names the coordination server](#what-the-display-shows-in-order) this run resolves to dial, host and port, and says that confirming connects and transmits immediately, and the question itself repeats that server, since the terms between the two run past a terminal screen.

The endpoint is your partner's, so it reaches the dial through the same refusals a connection you authored yourself does; nothing on this path widens what the acceptor will dial. A locator whose host or path could move the signaling socket elsewhere is refused before the terms are displayed, so an unusable endpoint costs neither a confirmation nor a written file. Both refusals are usage errors (exit 64) -- a delimiter smuggled into the host, and an address that does not parse as a WebSocket URL -- since each is decided by the locator alone and no retry of the same invitation ends differently; the message names the invitation as where the address came from, and the remedy is a further invitation from your partner.

Three cases keep the two-command shape instead. Each is reported rather than silent, so an acceptance that stops short of a run says why:

- **No `INPUT_FILE`.** There is no dataset to exchange, so acceptance writes the configuration and key file; run `psilink exchange` with your input file afterward.
- **An invitation carrying no WebRTC endpoint.** An `sftp` or `filedrop` endpoint, or none at all, leaves a connection block whose credentials you still supply, so acceptance writes it for you to complete.
- **A reused configuration.** A configuration already at the configuration path governs its own exchange -- `psilink exchange` loads it and dials what it says, including its `@path` references, `server.key`, and `secure` -- so acceptance writes the key file and stops.

After an acceptance that writes only a configuration, both parties run `psilink exchange` at their convenience.

## Online invitation

```sh
psilink invite --identity IDENTITY [--accept-timeout=DURATION] [--expires-in DURATION] [--linkage-strategy STRATEGY] URL INPUT_FILE [OUTPUT_FILE]
```

Similar to [offline invitation](#offline-invitation), this generates a shareable invitation string (see [Invitation strings](#invitation-strings)) then prints it and instructions for the user to forward to their partner by a secure, out-of-band channel. Those instructions include a template for the invocation of `psilink accept` that references the shared server (over WebRTC there is none for the partner to type -- see [Inviting over WebRTC](#inviting-over-webrtc)). The template names the invitation as `<INVITATION>` beside its `<INPUT_FILE>` placeholder rather than carrying it: the invitation encodes the setup shared secret, so its delivery is the stdout line above -- which the operator directs -- while the template is a diagnostic like every other line, routed to stderr or to a `--log-file`. The invitation it prints also embeds a [credential-free connection endpoint](#invitation-strings) derived from the connection this invite is using -- the public locator only (host/port/path, or the split `inbound_path`/`outbound_path` pair), never credentials -- so an acceptor seeds its `connection` block from it and need only supply its own credentials. After printing the invitation information, the program connects to the server and waits for the partner to respond.

### Inviting over WebRTC

A `ws://` or `wss://` URL invites over the [`webrtc` channel](#webrtc-exchanges): the URL names the PeerJS peer-coordination server the two parties meet through, and the invitation carries that same host, port, and path as its connection endpoint. This is the only way to hand a partner a coordination server other than the one their client defaults to -- a self-hosted deployment, or a fork with a different one built in -- since no printed instruction can put it into their configuration for them.

- **The partner needs no URL, and no second command.** The printed template is `psilink accept --identity <YOUR NAME, YOUR ORGANIZATION> <INVITATION> <INPUT_FILE>`, run while this command is still waiting: accepting writes the connection block (coordination server and `role` both) from the endpoint and dials it in the same invocation (see [Accepting and running a WebRTC exchange](#accepting-and-running-a-webrtc-exchange)). The `role` is not carried by the invitation -- each command stamps its own end, `inviter` here and `acceptor` there. The partner replaces the placeholder with their own name and quotes it themselves if it contains spaces or commas.
- **The URL names the location and nothing else.** A `ws://`/`wss://` URL carrying a non-empty user, password, query, or fragment is a usage error (exit 64) rather than a silently dropped component, as is one whose host or path could move the signaling socket elsewhere (an `@`, `?`, `#`, `\`, or space, however it was written) or whose port is not dialable. Every such refusal lands before the invitation is minted, so an unusable URL never costs a printed token. For a coordination server that needs an API key, author `channel: webrtc` with `server.key` in `psilink.yaml` and use [`psilink exchange`](#webrtc-exchanges) instead.
- **The endpoint names the mount point even when the URL did not.** A bare-host URL such as `wss://peers.example.org` invites on the root path, and the invitation says so rather than leaving the field empty: a partner's client resolves an absent path to its own default, which is not necessarily this one's, and the two would then wait at different sockets until the accept-timeout.
- **A plaintext (`ws://`) coordination server cannot be conveyed.** A connection endpoint has no `secure` field, so a partner seeded from one dials `wss://` and reaches nothing. The command warns when it emits an endpoint for a `ws://` server, naming the `secure: false` the partner has to add by hand; the invitation and the exchange still proceed.
- **The file-sync flags do not apply.** `--retain-files`, `--lockless-rendezvous`, `--polling-frequency`, `--connection-per-poll`, `--peer-id`, and `--timestamp-in-filename` are reported ignored on this channel, and `--outbound-path` is a usage error: there is no exchange directory to retain, poll, split, or write files into.
- **No `--server-*` flag applies.** Every one of them is reported ignored, credentials included: the coordination server's port is part of the URL, and a webrtc invitation reaches it by location and its API key alone, so nothing typed at `--server-password`, `--server-private-key`, `--server-private-key-passphrase`, `--server-keyboard-interactive`, or `--server-host-key-fingerprint` is sent, saved, or carried on the invitation. A coordination server that needs a key takes it from `server.key` in `psilink.yaml`; `server.username` has no consumer on this channel -- the schema accepts it, but only `server.key` is honoured.

`--expires-in DURATION` overrides the one-hour invitation lifetime exactly as in the [offline invitation](#offline-invitation). When the resulting lifetime is shorter than `--accept-timeout`, the command warns that the token will expire before the wait ends and a later acceptance will be rejected.

`--accept-timeout` is this run's peer budget, bounding both the wait for the partner to accept and the peer waits of the exchange that follows. It bounds that run only: it is not written to the saved configuration, so a later `psilink exchange` from that configuration runs on its channel's own defaults rather than a window sized for one operator waiting at a terminal. Which defaults those are depends on the channel:

- On `sftp` and `filedrop`, the one-hour [`peer_timeout_ms`](EXCHANGE_REFERENCE.md#shared-options) default.
- On `webrtc`, the transport's own pair: ten minutes to meet the partner at the rendezvous, then one hour of peer silence on the open channel.

`--peer-timeout` is how those later runs get a budget other than their channel's defaults. It does not bound this invitation's wait -- the command reports that when the flag is set, naming the timeout that governs the phase instead -- and is recorded as `connection.options.peer_timeout_ms` when the configuration is saved. Editing that field in the file before a later `psilink exchange` does the same thing by hand.

Once the configuration is written the command reports which of the two it carries: the `--peer-timeout` value, or no field at all, in which case it names the channel defaults that leaves later runs on.

`--linkage-strategy STRATEGY` selects the linkage strategy (`cascade` or `single-pass`) exactly as in the [offline invitation](#offline-invitation), and the same disclosure tradeoff applies to `single-pass`.

The application exits when the token expires, when the connection times out, when the user cancels, or when the `--accept-timeout` (default 15 minutes) is reached; in all four cases the invitation can no longer be accepted, because the inviter has left the rendezvous and the handshake cannot be completed (and the secret in any case lapses at its expiry). This prevents the partner from completing the setup against an inviter who has given up; it does not destroy the secret, so a leaked invitation must still be treated as a compromise (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md)). Accept-timeout is the maximum time the inviter will wait for the entire acceptance handshake to complete - from the moment the invitation is printed to the moment an acceptance message is received.

On acceptance the two parties engage in direct communication. After a successful key exchange, a fresh shared secret is generated and exchanged. Clients using communication channels without end-to-end encryption shift to an application-layer channel. The configuration and key files are saved on both sides (where applicable) as soon as the handshake succeeds, before the data exchange begins, so a post-handshake failure can be retried without re-inviting (see [Recurring exchange](#recurring-exchange)). The exchange is then conducted before output is written and both applications exit. If `OUTPUT_FILE` is given, it is used as the destination; otherwise, output is written to `stdout`.

Unlike the [offline invitation](#offline-invitation), the online path does not source its linkage terms from a pre-existing configuration file. A configuration file at the configuration path is reported as a conflict and the command aborts before any token is minted or connection opened; delete it or pass `--config-file` to write elsewhere.

Linkage keys, metadata, and cleaning transformations are therefore inferred from the input file. If the partner accepts the invitation that configuration is saved; otherwise it is discarded because the partner did not accept.

If `--key-file` is not used and a key file exists at the default path, the user is warned about its existence and told to either delete it or specify a different key file in case reusing that secret was not their intention.

## Online acceptance

```sh
psilink accept --identity IDENTITY URL INVITATION INPUT_FILE [OUTPUT_FILE]
```

This command is similar to [offline acceptance](#offline-acceptance), however it coordinates with the other party and executes an exchange. It decodes the invitation string and displays the same terms outline [offline acceptance](#offline-acceptance) prints, leading with the columns this party itself will send to the partner for matched records -- its own outbound disclosure. The user can abort or accept. `--consent-to-terms` skips this confirmation for unattended runs exactly as in [offline acceptance](#offline-acceptance), recording advance consent to the invitation's terms before the configuration and key are written and the handshake is run; it applies only to that consent and does not affect [SFTP host-key trust](#sftp-host-key-trust), which has its own non-interactive setup. It also lets `INPUT_FILE` be `-` to read the CSV from stdin. As in offline acceptance, the input is checked against the invitation's linkage terms before any connection: unless it can satisfy every key those terms declare, the command stops with an error and never connects, so the two parties cannot complete a handshake and run an exchange short of the keys they agreed on. The error names what is short; the remedy is a fresh invitation over terms both files can satisfy, agreed out of band. Accepting saves the configuration and newly-generated persistent keys on both sides as soon as the handshake succeeds, before the data exchange begins, so a post-handshake failure can be retried with `psilink exchange` without re-inviting (see [Recurring exchange](#recurring-exchange)); the exchange is then conducted and both applications exit when complete.

When the invitation carries a [connection endpoint](#invitation-strings) naming a split inbound/outbound directory pair (an `sftp`/`filedrop` exchange with separate drop and pickup folders), and you do not pass `--outbound-path`, the acceptor adopts the mirror-swapped directory roles from the endpoint -- where the inviter writes becomes where you read, and vice versa -- together with the retain mode a split exchange requires, so you need not retype the mirrored directories. This is the online counterpart to the same seeding the offline accept performs. The reachable host, port, and credentials still come from your own URL and flags, never from the endpoint, so a bridged topology where you reach the rendezvous differently from the inviter is supported. An explicit `--outbound-path` overrides this entirely: it takes the URL/positional path as your inbound and the flag as your outbound, ignoring the endpoint's pair. A non-split invitation (a single shared path, or no endpoint) leaves the connection exactly as the URL builds it.

If `--config-file` is not used and a configuration file already exists at the default path, its linkage terms are compared against the invitation's exactly as in [Offline acceptance](#existing-files), and its connection block is additionally compared against the connection target -- the URL, any `--server-*`/`--outbound-path` overrides, and any split directories seeded from the endpoint as just described. The connection comparison distinguishes *which* drop you are meeting at from *how* you reach it. A mismatch in the rendezvous location -- the host or the path -- causes acceptance to fail without notifying the inviter: the user is shown which values differ and instructed to delete the file or use the `--config-file` option (see [Configuration](#configuration)), after which the program exits, and the user can retry with the same URL and invitation string once the conflict is addressed. A difference in *how* the same drop is reached -- the protocol/channel (for example a `file://` configuration accepted against an `sftp://` URL, as with a file-sync service), the port, or the credentials -- is not an error: the specified value is used for this exchange and a warning notes that the saved configuration's connection settings are left unchanged, so the user can update the file if the change was meant to persist. Absence of a field from the URL (with no matching override) is never a conflict; the acceptor's own stored value stands.

A pre-existing key file is handled as in [Offline acceptance](#existing-files), with the refusal landing before any connection is opened.

## Recurring exchange

```sh
psilink exchange [--invitation CODE] [--sweep-exchange-files [--force-retain-sweep]] INPUT_FILE [OUTPUT_FILE]
```

The application loads configuration and key files and conducts the exchange without further coordination. The shared secret is rotated after each successful authentication handshake, before the data exchange begins; if the data exchange subsequently fails, both parties already hold the rotated token and can retry without re-inviting. If `OUTPUT_FILE` is given, the results of the exchange are written to that path; otherwise, output is written to `stdout`. Running it repeatedly on a schedule -- the recurring production arrangement this command exists for -- is [Scheduling the run](#scheduling-the-run) below.

### Provisioning the key file from an invitation

`--invitation CODE` provisions the key file from an invitation code -- the same code `psilink accept` takes -- and then runs the exchange, so a party holding a configuration that carries no secret completes local provisioning and exchanges in one command. It is the offline route for the party that composed the exchange in the web application and downloaded that configuration (see [EXCHANGE_FILE.md](spec/EXCHANGE_FILE.md)); it is also how a re-invited party re-provisions without going back through `accept` (see [Recovery](#recovery)).

`@path` is supported -- `--invitation @code.txt` keeps the code out of shell history. The code is decoded and validated (checksum, schema, expiry) before anything is written, so a malformed or expired code fails with nothing written. A key file already at the key path is an error rather than an overwrite: the secret rotates after the first exchange, so the original code must not resurrect a stale one.

Before any credential, terms, or data are sent, the `INPUT_FILE`'s columns are checked against the configuration's linkage terms, the same satisfiability pre-flight `accept` applies. Unless the CSV can satisfy every key those terms declare, the run stops with a usage error (exit 64) naming the unsatisfied fields and the keys they cost, rather than completing an exchange short of the keys the two parties agreed on. A key whose own cleaning drops every record (a `parse_date` with an incomplete `input_format`) counts as producing nothing here too, and is named the same way; its fix is the terms rather than a different CSV. This guards a recurring run whose CSV has drifted from the terms the configuration committed to -- a file swapped since setup, or one never checked at an offline accept. The remedy for a lasting drift is to settle new terms with your partner out of band and re-establish the exchange under those. The check resolves fields exactly as the exchange does, honoring any explicit metadata or column-standardization in the configuration, so a field an explicit type or remap produces is not flagged.

### Confirming what you send

An exchange you accepted an invitation for has one fact no invitation settles: the columns *you* send to your partner for matched records. The invitation settles what you receive; what you send comes from your own input file, where a column psilink does not recognize as a linkage or identifier column is transmitted by default. So acceptance records the set it showed you, and the exchange holds itself to that record:

- **The set is the one you confirmed** -- the exchange runs, without asking again.
- **The set is not the one you confirmed**, whether it gained a column or lost one -- the run stops before any credential, terms, or data are sent, prints the columns it would send and what changed, and asks you to confirm. A yes records the new set and the exchange proceeds; a no stops the run (exit 64) with nothing sent. A narrower set is asked about no less than a wider one: your partner's consent surface and the [exchange record](spec/EXCHANGE_RECORD.md) state the set you confirmed, so a run that sends a different one is sending a set neither party settled on.
- **Acceptance never resolved the set** -- you accepted without naming an input file, or with one whose columns could not satisfy the linkage terms. The first run that can resolve it shows the columns and asks, exactly as above.

Where there is no terminal to ask on -- an unattended or scheduled run, or one reading its CSV from standard input -- the run refuses instead (exit 64, before any credential, terms, or data are sent), naming the columns and how to confirm them: run it once from a terminal, or accept the invitation again naming your input file. That refusal is the point of the record. An exchange whose partner is entitled to no result is never asked about, because nothing is transmitted to it whatever your file holds; nor is an exchange you *invited* a partner to, whose outbound columns you authored yourself when you minted the invitation.

All three channels -- `sftp`, `filedrop`, and `webrtc` -- run here. For file-drop exchanges, the `psilink.yaml` configuration uses `channel: filedrop` and `path` in place of `channel: sftp` and `server`:

```yaml
connection:
  channel: filedrop
  path: /mnt/sftp-share/exchanges/agency-a-agency-b
```

### WebRTC exchanges

A `webrtc` connection reaches the partner directly over a peer-to-peer data channel, using a PeerJS peer-coordination server only to introduce the two parties. It is the channel the web application uses, so a CLI party and a browser party can exchange with each other.

```yaml
connection:
  channel: webrtc
  server:
    host: peers.example.org
  role: inviter
  stun:
    - stun:stun.example.org:3478
```

- **`role` is required** and the two parties must differ: one `inviter`, one `acceptor`. Each registers with the coordination server under the id its role derives from the shared secret and dials the id the other's derives, so neither needs the other's address. `psilink invite` and `psilink accept` stamp it; a configuration missing it is a usage error (exit 64) before anything is dialed, and one where both parties set the same value fails at the coordination server with an error naming that as the likely cause.
- **`server.secure` defaults to `true`** (a `wss:` socket). Set `secure: false` only for a coordination server you reach without a network in between, such as one on the same machine. The port defaults to 443 or 80 to match, the path to `/`, and the API key to `peerjs`. A connection that resolves to a plain `ws:` socket warns on every run and proceeds, naming what plaintext signaling discloses -- the derived rendezvous ids, both parties' session descriptions, and the candidate addresses they gather -- and how to reconcile it. That disclosure is rendezvous metadata, never exchange content: the two parties authenticate each other over the data channel, which is encrypted end to end either way.
- **Where the connection comes from.** Accepting an invitation seeds the whole block -- coordination server and `role` both -- from the invitation itself, so `psilink accept` writes a ready configuration and, given an input file, [runs the exchange on it in the same invocation](#accepting-and-running-a-webrtc-exchange). That holds for an invitation minted by the web application and for one minted by [`psilink invite` over a `ws://`/`wss://` URL](#inviting-over-webrtc). Otherwise author it by hand: a `ws://` or `wss://` URL is refused (exit 64) on `psilink accept` and on the [zero-setup exchange](#zero-setup-exchange), which take their end of the rendezvous from an invitation they were given, not from a URL.

Nothing about the exchange itself changes: the same authentication handshake, the same linkage, the same result file and exchange record. The data channel is already end-to-end encrypted between the two parties, so this channel does not add the application-layer encryption the file-based channels apply -- the coordination server sees only that a session exists, never its content.

#### STUN, and what it discloses

Finding a path between two parties behind NAT needs a STUN server, which tells each party how it appears from the outside. **When a connection configures neither `stun` nor `turn`, a built-in default (`stun:stun.l.google.com:19302`) is used and a warning says so on every run**, naming what it discloses and how to override it. That disclosure is connection metadata -- this host's public address, and the fact of a session -- never exchange content. Set `stun` to your own server to avoid it.

A configured list replaces the built-in default rather than adding to it, so a list you set is the list actually used. An **empty** list is not "no STUN": to the ICE layer an empty list and an absent one both mean "use the default". To gather host candidates only -- for two parties on the same network, or a VPN -- give a single unreachable entry, for example `stun:127.0.0.1:3478`. That is the supported no-STUN idiom; it costs about five seconds of gathering while the unreachable entry times out, and it works only where a direct path exists.

#### TURN

`turn` entries are passed through to the connection, so a deployment can configure a relay for the case where no direct path can be found:

```yaml
connection:
  channel: webrtc
  server:
    host: peers.example.org
  role: acceptor
  turn:
    - url: turns:relay.example.org:443?transport=tcp
      username: psilink
      credential: "@/run/secrets/turn"
```

**A relayed exchange has been verified against the project's standing relay:** a CLI party with UDP blocked outright completed an authenticated exchange whose data-channel traffic the relay carried, over TURN-over-TLS on 443. werift verifies the TURN server's certificate, so a relay presenting a certificate the CLI host does not trust yields no relay candidate and no relayed path. Verify relayed connectivity in your own environment before depending on it. `ice_provision` (an ICE-credential API) is not supported by the CLI and is refused rather than ignored, so a connection that configures it does not silently fall back to the default.

**A run that allocates against a relay does not return when its work is done.** The allocation a relay hands out is held open by a refresh timer the exchange's teardown cannot cancel, so the command lingers for five sixths of the lifetime the relay granted -- roughly eight minutes where a relay grants the usual ten. The result file, the exchange record and the receipt are all written before the wait, and nothing is transferred during it; what it holds is the process, and in a container the container, which is what a scheduled recurring exchange has to allow for. The mechanism and its measurement are in [WEBRTC_TRANSPORT.md](spec/WEBRTC_TRANSPORT.md#budgets).

### Signing identity and the agreed terms

Under `signing.mode: certificate` the run loads this party's signing identity from the path `signing.identity_file` names, before any credential, terms, or data are sent. A configuration that names none is refused earlier still, from the configuration alone -- before the run prepares your input or reaches the server -- and exits 64: psilink chooses no location for a signing identity, since it is a long-lived credential whose custody is yours (see [Where the signing identity lives](#where-the-signing-identity-lives)). Set `signing.identity_file` -- `/run/signing/psilink-signing-identity.json` is the usual shape, created there by `psilink fingerprint --identity-file` -- or run `signing.mode: none` unsigned. A path that is set but holds no identity file exits 64 too, naming that path.

A partner verifies a receipt against the identity in the agreed terms rather than the one the certificate carries, so an identity bound to anything other than the run's `linkage_terms.identity` -- or the `--identity` that replaces it for that run -- signs receipts the partner rejects. That configuration is refused where the identity is loaded: the run exits 64, naming both values and the two ways to reconcile them, before anything is sent. Reconcile them with [`psilink fingerprint --force --identity`](#signing-identity-fingerprint) naming the terms identity -- which changes the fingerprint your partner has pinned, so it needs a coordinated re-pin -- or by editing `linkage_terms.identity` to the bound value.

Such a run has no way to finish, and refusing it up front is what spares you the connection, the credentials it presents, and the terms it puts on the wire. The exchange holds the same binding itself, as a backstop: a diverging run that gets as far as agreeing terms with your partner ends right there -- before any linkage key or data crosses, with no result and no receipt -- and ends the partner's run promptly too, rather than leaving it to time out.

A `certificate`-mode configuration that pins no `signing.partner_fingerprint` is refused the same way, and for a reason of the same shape: the run exits 64 before any credential, terms, or data are sent, because the certificate the partner presents at the signature swap is rejected when nothing is on file to check it against, ending the exchange with no result and no receipt on this side, and only the [exchange record](#when-the-receipt-swap-fails) of the disclosure it had already made. Set `signing.partner_fingerprint` to the value your partner's [`psilink fingerprint`](#signing-identity-fingerprint) prints, or run `signing.mode: none` until you hold it.

A `certificate`-mode configuration that names no party is refused the same way, and at the same point. With no `linkage_terms.identity` in the configuration and no `--identity` for the run, the exchange exits 64 before anything is sent: the certificate you present is checked against the name you used in the agreed terms, so an unnamed party gives your partner nothing to check it against. Name this party, or run `signing.mode: none`. Your PARTNER's name is not knowable before the run -- their terms arrive during the exchange -- so an exchange whose partner is unnamed stops the moment they do, at terms agreement: before any linkage key or data crosses, with no result, no record, and no receipt written, and the exit code of a failed exchange (69) rather than 64.

### Signing without an exchange record

`--no-record` suppresses the exchange record, not the receipt, and the two are not independent: pairing a receipt to the run it attests needs that run's record. A run that configures a signing identity and passes `--no-record` therefore writes a receipt that can never verify above `INCOMPLETE` on any verifier (see [Pairing the receipt to one run](#pairing-the-receipt-to-one-run)), and the record that would resolve it cannot be reconstructed after the exchange.

The run warns before any credential, terms, or data are sent -- naming both consequences and the two ways out, keep the record or drop the signing block -- and then proceeds: which artifacts to keep is your choice. The warning goes to both the operator log and the [machine-readable event stream](#machine-readable-event-stream), so an unattended run that discards stderr on success still reports it.

### When the receipt swap fails

The signature swap is the last step of an exchange, so a run that fails there -- a fingerprint that does not match the pin, a partner that re-keyed, a connection that drops mid-swap -- has already sent and received its data. That disclosure happened and cannot be undone by restarting.

The swap is not the only step on that side of the line. A partner that transmits payload columns outside the set you consented to receive is refused as well, and that refusal also lands after both payloads have crossed. Everything below applies to it identically.

Such a run still writes its **exchange record and verification keys**, to the same path a completed run writes them to, so the disclosure has a log entry. It writes no receipt: a swap that did not complete produces no dual-signed record, and none is written half-finished. The record itself says which kind of run it came from, so a reader of the file -- or an auditor you hand it to -- can see that no receipt accompanies it without being told.

The run still fails, with its own exit code and error: keeping the record is not a rescue of the exchange, and there is nothing to salvage from the run beyond the record of what it disclosed. `--no-record` suppresses that record as it suppresses a completed run's.

### Sweeping a stale exchange directory

A crashed or mismatched prior run can leave protocol files in an `sftp`/`filedrop` directory that stall the next rendezvous. `--sweep-exchange-files` deletes every protocol file in the directory before the rendezvous -- this party's and the peer's hellos, acks, locks, joining sentinels, and messages -- and starts a fresh exchange. Foreign (non-protocol) files are never touched. It is accepted by `psilink exchange` and the zero-setup form, is CLI-only, and is never persisted to `psilink.yaml`. Confirm that no other session is using the directory before passing it: a sweep during a live exchange destroys that exchange's state.

`--force-retain-sweep` is DANGEROUS and exists only to escalate a sweep the guard refuses. A directory that is, or whose peer is, in retain mode holds an audit transcript, so `--sweep-exchange-files` alone refuses there; `--force-retain-sweep` permits the deletion, and **the prior transcript is permanently lost**. It requires `--sweep-exchange-files` and is rejected on its own. Use it only when discarding the transcript is the intent.

### SFTP host-key trust

Every command that opens an SFTP connection -- `psilink exchange`, an online `psilink invite`/`accept`, and a zero-setup exchange -- verifies the server's SSH host key before sending any credential, so a man-in-the-middle or a substituted server is detected rather than trusted. You can pin the key out-of-band by setting `connection.server.host_key_fingerprint` to the server's OpenSSH SHA256 fingerprint (the value `ssh-keygen -lf` prints; `@path` is supported). If you cannot obtain it out-of-band, the first interactive run establishes it on first use, the way `ssh` does:

- The first time you connect to an unpinned SFTP server from an interactive terminal, the command shows the presented host key's fingerprint and asks you to confirm. On confirmation it records the fingerprint and connects; every later run then verifies it silently. Verify the fingerprint against the server's published value if you can before confirming. Where the command writes a configuration -- `exchange` (into the existing `psilink.yaml`, preserving your comments), the online `invite`/`accept`, and a zero-setup run with `--save` -- the pin is saved there; a zero-setup run without `--save` trusts the key for that one exchange only (like `ssh` to a host you do not add to `known_hosts`).
- A run with no terminal -- an automated or scheduled run, or one piping its input CSV through stdin -- does not prompt and does not silently accept: it fails closed with an error telling you to run once interactively to pin the key, or to set `host_key_fingerprint` yourself. So pin the key (out-of-band or via one interactive run) before scheduling unattended exchanges.
- If the server legitimately rotates its host key, a later run fails with a mismatch error rather than silently trusting the new key. Verify the new fingerprint out-of-band, then re-pin deliberately: set `host_key_fingerprint` to the new value, or remove it from `psilink.yaml` and run once interactively to confirm and re-pin (the same as removing a changed host from `~/.ssh/known_hosts`).

The command-line spelling of the same pin is `--server-host-key-fingerprint` (accepted by every command above): it sets `host_key_fingerprint` for that run, overriding any value in the configuration, so a supervised or scripted run that already knows the fingerprint connects with no prompt while a server presenting a different key still fails closed with a mismatch error.

### Reading a host key with `probe-host-key`

```sh
psilink probe-host-key SFTP_URL [--json] [--connect-timeout <duration>]
```

`probe-host-key` reads and prints the host-key fingerprint an SFTP server presents, without authenticating: it connects only far enough to observe the key, then refuses before any credential is sent (the `ssh-keyscan` analogue). Use it to obtain a fingerprint to pin -- compare the printed value against the one the server's operator published, then set it as `host_key_fingerprint` (or pass `--server-host-key-fingerprint`). It establishes no trust on its own: it reads the key over the same network the exchange will use, so a value it prints is a candidate to verify out-of-band, not a vouched-for key.

`SFTP_URL` is an `sftp://host[:port]` address; you supply no username, path, or credential, and none is sent to the server (the probe refuses before authenticating). A non-sftp scheme is a usage error. `--connect-timeout` bounds the connection attempt (e.g. `10s`), enforced as the SSH ready timeout. By default the command prints a human-readable summary; `--json` instead prints one line of machine-readable JSON -- `{"fingerprint":"SHA256:...","key_type":"..."}` -- on stdout for a script to consume. A transport failure (unreachable, refused, or timed out) exits 69; a usage error exits 64. On the exit-69 path `--json` may print a diagnosis line instead (see the section below). The console's "read the fingerprint from the server" affordance runs this command for the operator.

### When something other than an SSH server answers the port

An SSH server announces itself before anything else, so a connection that ends before that announcement met something that is not one. Rather than reading as an unreachable host, the failure names what answered:

- A peer whose first bytes are a web page, TLS, or any other non-SSH data is reported as such, with a short excerpt of what it sent -- most often a proxy or gateway intercepting the port.
- A peer that accepts the connection and then closes it without sending anything is reported separately: most often a firewall or IP allowlist standing in front of the server rather than the server itself, though a connection throttle reads the same way.
- The verdict rests on the peer's first bytes alone, read within a short budget, so a genuine SSH server that sends a long banner ahead of its announcement -- or sends it late -- is reported the same way. The message names that bound.

Under `--json`, the same verdict also arrives on stdout as one machine-readable line before the exit-69 failure, so a caller that reads only stdout still learns the cause: `{"diagnosis":"non_ssh","shape":"http"|"tls-alert"|"unrecognized","excerpt":"..."}` for a peer that answered with something, or `{"diagnosis":"closed_unanswered"}` for one that closed having sent nothing. A failure with no such verdict prints no line, exactly as before.

The `excerpt` is bytes the peer chose, bounded by the same read budget and carried as a JSON string value escaped to printable ASCII, so untrusted peer bytes never reach the terminal raw -- a property of the emitted LINE only: `JSON.parse` returns the peer's original bytes, so an integrator reading the parsed value escapes it at their own display sink before rendering it. Private-key material is redacted before the excerpt is emitted, the same strip the human-readable failure applies, so a peer answering with a PEM block has it replaced on both routes rather than logged verbatim. The exact byte bound and escape form are in [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#sftp-host-key-verification).

This covers every SFTP connection psilink makes: `probe-host-key`, the first-use host-key prompt, and an `exchange` run's own connection, including a mid-run reconnection in connection-per-poll mode -- the case a scheduled, unattended run behind a proxy that starts intercepting the port lands in. The look is spent once per run, not once per connection: it opens a bounded TCP connection of its own, so once a run has told the operator what answered the port it does not look again. That is what keeps connection-per-poll mode -- which re-dials at every cycle -- from re-reading a peer that is answering wrongly on every tick. A peer answering a later reconnection the same way is reported as the plain connection failure, with no second look.

### Scheduling the run

`psilink exchange` conducts one exchange and exits. Repeating it on a cadence is the host scheduler's job -- cron on Linux and macOS, the Task Scheduler on Windows: psilink schedules nothing itself and leaves no process running between runs. Every scheduled run is a fresh process that reads the configuration and key file, exchanges, rotates the shared secret, writes its result, and exits.

A daily run at 02:00, from the directory holding this exchange's files:

```text
0 2 * * * cd /srv/psilink/agency-b && /usr/local/bin/psilink exchange input.csv results.csv --log-file /srv/psilink/agency-b/exchange.log
```

The container form mounts that directory at the image's working directory (`/work`) and so needs no `cd` (see [Running the CLI](DEPLOYMENT.md#running-the-cli)):

```text
0 2 * * * /usr/bin/docker run --rm -v /srv/psilink/agency-b:/work vdorie/psi-link exchange input.csv results.csv --log-file exchange.log
```

Both lines name the program by absolute path. A scheduled job runs under the scheduler's environment rather than your shell's, so a bare `psilink` or `docker` may not resolve there -- under cron's minimal `PATH`, or a Task Scheduler service account's -- and the job then fails without ever reaching psilink. Give the full path, or put the program on the scheduling account's `PATH`.

For the container form, the mounted directory must be readable and writable by the account inside the container, which is a question of host-side ownership rather than of mode: see [The user the image runs as](DEPLOYMENT.md#the-user-the-image-runs-as), and [Key file permissions in containers](DEPLOYMENT.md#key-file-permissions-in-containers) for mounting the key file (including the read-only-configuration, read-write-secret split).

#### The working directory

The configuration and key files default to `./psilink.yaml` and `./.psilink.key` -- relative paths, resolved against the working directory of the process that reads them. A scheduled job does not inherit the directory you edited the schedule in; the scheduler decides what it starts in. Make it explicit: `cd` into the exchange's directory first, as the lines above do, or pass absolute `--config-file` and `--key-file` paths.

Everything else the run reads or writes by a relative path resolves the same way -- the `INPUT_FILE` and `OUTPUT_FILE` positionals, `--record-file`, `--log-file`, `signing.identity_file`, and any `@path` credential reference stored in the configuration (see [Configuration](#configuration)). One directory per exchange partner is the intended layout, and it is what makes the single `cd` enough.

That directory has to be writable by the scheduling account, not merely readable: each successful run rewrites `.psilink.key` with the rotated secret, and an SFTP run may edit `psilink.yaml` to record a host-key pin. The run verifies up front that the key file can be written, before any key exchange, so a mis-owned directory stops the run rather than desynchronizing the two parties' tokens.

Give the results an `OUTPUT_FILE` path rather than redirecting `stdout`: psilink creates that file owner-only, while a shell `>` redirect leaves it at the scheduling account's umask (see [Key file security](SECURITY_DESIGN.md#key-file-security)). A fixed output path is overwritten by each run. The exchange record and its verification keys default to a per-run timestamped name and so accumulate in the working directory, as does a receipt when the configuration names no `signing.receipt_output`; rotating and archiving what accumulates is an operator responsibility.

#### The key file on the scheduling machine

`.psilink.key` is the credential that authenticates every run of this exchange, and on the scheduling machine it belongs to the account the scheduler runs the job as, readable by nobody else: mode `0600` on Unix, an owner-only ACL on Windows. The CLI writes it that way and warns on load when it finds an existing file over-permissive -- but that warning is a `warn`-level diagnostic, so a job running at `--log-level error` or `silent` forgoes it. [Key file security](SECURITY_DESIGN.md#key-file-security) carries the required permissions, the `chmod`/`icacls` corrections, [what not to do](SECURITY_DESIGN.md#what-not-to-do) with the token, and the [backup](SECURITY_DESIGN.md#backup) and [compromise](SECURITY_DESIGN.md#compromise-response) procedures.

Moving an exchange onto a scheduling machine -- from another host, or from the [web console appliance](DEPLOYMENT.md#server-job-api)'s recurring-run hand-off -- moves that credential, so it travels over an encrypted transfer and under one further rule: from then on exactly one machine may run this exchange. The secret rotates at each successful handshake, so a second copy left running holds a secret the partner has already replaced, its next key exchange fails, and the recovery is for both parties to re-invite (see [Out-of-sync tokens](#out-of-sync-tokens)). Take the copy from the key file as it stands after the last run on the old machine -- the rotation happens before the data exchange, so even a run that later failed has usually rotated it -- and stop running it there.

#### Cadence and the token's expiry

A key file may carry an `expires`, and that instant bounds the schedule. `psilink exchange` checks it at load time, before opening any connection: an expired token aborts the run with a usage error (exit 64), no exchange is attempted, and the recovery is for both parties to re-invite (see [Key lifecycle](#key-lifecycle)). Two mechanisms write it, and enforcement does not distinguish them:

- **An invitation's setup lifetime** -- one hour by default, up to a year with `--expires-in`. The inviting party's key file carries it, whether written by `psilink invite` or provisioned by [`psilink exchange --invitation`](#provisioning-the-key-file-from-an-invitation); the accepting party's copy does not. Where it applies, the first exchange has to happen inside that window, so run the exchange once by hand and confirm it works before handing it to a schedule, rather than letting the schedule take the first run.
- **The max-age policy.** With [`authentication.token_max_age_days`](EXCHANGE_REFERENCE.md#authenticationtoken_max_age_days) set in `psilink.yaml`, each successful exchange stamps `expires` that many days past the moment of rotation. What must fit inside that window is the interval between *successful* runs, not the nominal schedule: a monthly cadence under `token_max_age_days: 30` lapses the token the first time a run fails or is missed. Leave room for several consecutive failures -- a weekly run under a 30-day policy tolerates three.

The "expiring soon" warning (within `token_max_age_days / 3` days of the expiry) is suppressed by any run that refreshes the token, so on a schedule it appears exactly when successive runs have stopped completing. It is the warning that says a re-invitation is coming unless something is fixed; route it somewhere a person reads.

Keep the scheduling host's clock synchronized. Expiry is evaluated against local time on each side, and a lagging clock can additionally expire a token between the key exchange's round trips, leaving the two parties out of sync (see [Out-of-sync tokens](#out-of-sync-tokens)). The two parties set their policies independently and neither is told the other's, so an exchange that stops because the partner's token lapsed presents from this side as a silent peer (see [Token age and rotation policy](SECURITY_DESIGN.md#token-age-and-rotation-policy)).

#### What an unattended run refuses rather than asking

A scheduled run has no terminal, and psilink never reads that as consent: a question it cannot ask becomes a refusal (exit 64) that fails the job visibly, before any credential, terms, or data are sent. Settle both before the first scheduled run:

- **The outbound columns.** A run whose outbound column set differs from the set recorded when the invitation was accepted refuses instead of asking, naming the columns and what changed (see [Confirming what you send](#confirming-what-you-send)). Run it once from a terminal, or accept the invitation again naming your input file.
- **An unpinned SFTP host key.** First-use trust is established interactively, and a run with no terminal fails closed instead of trusting the presented key (see [SFTP host-key trust](#sftp-host-key-trust)). Pin `connection.server.host_key_fingerprint` before scheduling -- from a fingerprint verified out-of-band, read with [`psilink probe-host-key`](#reading-a-host-key-with-probe-host-key), or established by one interactive run.

#### Runs that overlap, and runs that wait

Both parties have to be running at once for an exchange to happen, on every channel: each side waits at the rendezvous only for its own budget -- `--peer-timeout`, or the transport's own default where the field is unset -- and then gives up. Agree the cadence and the window with your partner rather than each side picking one, and leave enough of a margin that a late start on either side still meets the other.

A scheduler starts the next run on time whether or not the previous one has finished, and two runs of the same exchange must not overlap: they share one key file, whose secret each of them rotates, and on `sftp` and `filedrop` one shared directory, which has to be dedicated to a single active exchange between exactly two parties (see [Directory exclusivity](EXCHANGE_REFERENCE.md#directory-exclusivity)). Set an interval longer than the run's own waiting budget -- `--peer-timeout` defaults to one hour on `sftp` and `filedrop`, and a partner that never appears waits it out (see [Logging](#logging)) -- or serialize the job with a lock so a late-running exchange makes the scheduler skip the next start rather than run alongside it. An outer timeout in the job line is a worthwhile backstop either way.

On `sftp` and `filedrop`, set a stable [`peer_id`](EXCHANGE_REFERENCE.md#connectionoptions) for a scheduled exchange -- it turns the protocol file a killed run leaves behind into an immediate start-up refusal naming that file rather than a failed run (see [Directory exclusivity](EXCHANGE_REFERENCE.md#directory-exclusivity)). It requires `timestamp_in_filename: true`, the two parties must use distinct ids, and a stable id also makes this party's runs linkable to each other in the partner's logs.

On `webrtc`, a run that configures neither `stun` nor `turn` uses the built-in default STUN server and warns on every run (see [STUN, and what it discloses](#stun-and-what-it-discloses)). On a schedule that warning goes to a log file rather than to a person, so decide the disclosure once, when you set the schedule up: accept it, or set `stun` to a server of your own.

#### Logs, and what the exit code tells the scheduler

Diagnostics go to `stderr` and the result to `stdout`, and a scheduler disposes of both in its own way, so capture what you need deliberately. `--log-file PATH` appends timestamped lines to a file psilink creates owner-only, and its parent directory must already exist (see [Logging](#logging)). `--log-level` still governs that file: `error` or `silent` discards precisely the notices a schedule depends on, including the over-permissive key-file warning and the expiring-soon advisory. A supervising process that would rather not parse log lines can read structured progress and outcome events on file descriptor 3 with [`--event-stream`](#machine-readable-event-stream).

Whatever supervises the schedule should act on the [exit code](#exit-codes) rather than on the log text: 0 completed; 69 is usually a transport failure that may succeed once the transport recovers; and 64, 70, and 73 are each deterministic in the run's own inputs, so a repeat reaches the same refusal -- and re-running a 73 conducts a second exchange rather than recovering the first. Cap automatic retries at a small fixed number and raise the failure to a person instead of looping.

#### Windows Task Scheduler

The same rules apply under the Task Scheduler, with the account the task runs as in place of the cron account: it must own `.psilink.key` under an owner-only ACL, own the working directory, and reach the program -- by its full path, or by having it on that account's `PATH`. The equivalent of the daily cron line above, which assumes psilink is on the task account's `PATH` (name it by full path there otherwise):

```cmd
schtasks /Create /TN "psilink exchange" /SC DAILY /ST 02:00 /TR "cmd /c cd /d C:\psilink\agency-b && psilink exchange input.csv results.csv"
```

An exchange folder that lives on a Windows network location -- a mapped drive, a UNC path, or a DFS namespace -- is not bind-mountable into the container by its drive letter: the container reaches it through a CIFS volume instead, which the Windows file-drop setup script provisions with the ownership the image needs (see [The user the image runs as](DEPLOYMENT.md#the-user-the-image-runs-as)).

## Checking a network file drop

```sh
psilink doctor probe
psilink doctor mount DIRECTORY
```

`doctor` answers "why did the file drop not work" before an exchange is attempted, and answers it in the two places the answer can differ. `doctor probe` asks the SMB server directly over TCP, with nothing mounted: whether the name resolves from inside the container, whether port 445 is reachable, whether the credentials are accepted, whether the share and the folder open, and whether a file can be created, renamed, and deleted there. `doctor mount` checks an already-mounted directory as the kernel presents it -- the operations psilink's rendezvous is built on, which a share can refuse even after passing every network check.

Run both: the probe leaves a marker file behind and the mount check looks for it, so the two together also establish that the mount and the checks are pointing at the same directory. A wrong server, share, or subfolder -- a DFS path is the usual cause -- is caught there rather than by a failed exchange.

Neither mode changes anything on the share beyond its own working files: the probe attempts to remove every file it creates except the marker and sweeps any `psilink-probe` working file already present, whichever run left it, and the mount check consumes the marker and removes the rest. On a share that refuses deletes or a connection that dies mid-run, a `psilink-probe-*.tmp*` working file can remain until the next run's sweep ([cleanup limits](spec/CLI_DOCTOR.md#cleanup-limits)).

### Inputs

`doctor probe` takes its connection details from the environment, not from flags, so the password never becomes an argv value that any process listing on the machine can read:

| Variable | Meaning |
| -------- | ------- |
| `SMB_SERVER` | Server name or address (required) |
| `SMB_SHARE` | Share name -- the first path component only (required) |
| `SMB_USER` | Account username (required) |
| `SMB_PATH` | Subdirectory under the share the exchange runs in; omit to run the checks against the share root itself |
| `SMB_DOMAIN` | Account domain, for a domain account |
| `SMB_PASS` | Account password |
| `SMB_DIALECT` | `SMB3`, `SMB2`, or `NT1` to pin a dialect; omit to negotiate |
| `SMB_MARKER` | Filename of the marker to leave for `doctor mount`; omit to skip it |
| `SMB_TOKEN` | Per-run value written into the marker; omit to skip the cross-check |

`doctor mount` takes the mounted directory as its argument and reads `SMB_MARKER` and `SMB_TOKEN` for the cross-check; without them it runs its other checks and reports the cross-check as skipped. A missing required variable, or one whose value could change what a command means (a path separator in the server or share name, a line break in a credential, a marker or token that is not a plain identifier), is a usage error and exits 64 with no verdict printed -- the checks never ran.

### Output

By default each check prints a line on stderr -- `OK:`, `WARN:`, `FAIL:`, or `SKIP:` -- with `MEANING:` and `ACTION:` lines under anything that needs one, closing with a summary line. Those lines print plain, with no timestamp, level, or command name ahead of them, so they read in a narrow console and can be passed on to whoever is helping you exactly as written; `--log-file` captures them like any other output, and `--log-level` still governs them (`silent` prints none, leaving the exit code as the whole answer). A `WARN:` does not stop an exchange; it names something worth knowing before you run one, such as a share that works only with `--lockless-rendezvous` or one nearly out of space. Read the `ACTION:` lines, change what they name, and run the command again.

`--json` prints the verdict as one line of JSON on stdout instead of those check lines, for a script or a setup launcher to consume. Either way the run's exit code carries the verdict, so a caller that parses nothing still learns whether anything blocks an exchange (see [Exit codes](#exit-codes)). The full contract -- every field, the schema version and the rule for reading it, the status and verdict vocabularies, both modes' fixed check lists, and the exit-code mapping -- is in [docs/spec/CLI_DOCTOR.md](spec/CLI_DOCTOR.md).

## Signing identity fingerprint

```sh
psilink fingerprint [--identity-file PATH] [--identity STRING] [--config-file PATH] [--force] [--export-certificate PATH]
```

Print this party's signing certificate fingerprint, creating the signing identity on first use. That identity is the long-lived keypair and self-signed certificate behind a certificate-backed receipt: a partner pins the printed fingerprint once and every later receipt verifies against it (see [Receipt signing identities](SECURITY_DESIGN.md#receipt-signing-identities)). Share the value out-of-band, the way an SFTP host-key fingerprint is shared.

Creation is announced rather than silent. The identity string bound into the certificate -- the party's name, organization, and contact -- comes from `--identity`, or from `linkage_terms.identity` in the configuration when the flag is absent; once an identity exists, `--identity` is ignored unless `--force` is also given. A label carrying a control character, or one past the length the linkage terms hold the same value to, is refused rather than bound: the value goes into a certificate a partner pins and reads back long after the run.

### Where the signing identity lives

You choose, and psilink never does. The path comes from `--identity-file`, or from `signing.identity_file` in the configuration named by `--config-file`; with neither, the command refuses and prints nothing on stdout, so a captured `FP=$(psilink fingerprint)` is empty and the status nonzero rather than a fingerprint minted somewhere you did not pick.

Resolve it the way you resolve any other credential. The identity is a long-lived private key reused across every exchange and every partner, so give it a mounted directory of its own:

```sh
psilink fingerprint --identity-file /run/signing/psilink-signing-identity.json --identity "Agency A, a@agency-a.gov"
```

```yaml
signing:
  mode: certificate
  identity_file: /run/signing/psilink-signing-identity.json
```

What the directory has to be:

- **Its own, and not the one holding the key file.** The shared secret rotates every exchange and is written back, so its directory has to be writable; the identity has no reason to inherit that. Mounting them separately is what lets this one be read-only. See [Mounting the signing identity](DEPLOYMENT.md#mounting-the-signing-identity).
- **Writable for the run that creates the file, read-only after.** Only `psilink fingerprint` writes the identity; an exchange and a `psilink verify-receipt` read it and write nothing beside it, so a read-only mount carries every run after the creating one.
- **Durable, and yours alone.** Losing the file means minting a new identity with a new fingerprint, which every partner must re-pin before your receipts verify again.
- **Never a directory your partner syncs into.** In a file-drop exchange the rendezvous directory is one the partner writes to; a signing identity there hands them the private key that signs for you with every partner, not just that one.

A `~`-relative path is expanded, so naming one under your home directory works verbatim -- what psilink does not do is choose the home directory (or any other location) for you. In a container that home is typically ephemeral, and a key minted there is a fresh key with a fresh fingerprint on every run.

If you already hold an identity file, name that one rather than creating a second: a new identity forces every partner to re-pin.

### The identity bound into the certificate

Bind the identity that matches `linkage_terms.identity` in your configuration. A partner verifies a receipt against the identity in the agreed terms rather than the one the presented certificate carries, so a certificate bound to any other string signs receipts the partner rejects. Binding one that diverges from the configured value warns and proceeds -- this command sends nothing, and editing `linkage_terms.identity` to match is the other way to reconcile them -- but bring the two into agreement before you share the fingerprint. An exchange under a divergent pair does not run at all: [`psilink exchange`](#signing-identity-and-the-agreed-terms) refuses it.

The warning is not confined to the invocation that binds the identity: a later one that only reads the existing identity warns the same way, so a configuration edited after the identity was created still reports the divergence. It repeats while the two differ, and the fingerprint value on stdout is unaffected.

### Regenerating and exporting

`--force` regenerates the identity: a new key with a new fingerprint, which invalidates every fingerprint a partner has already pinned. They must re-pin before your receipts verify again, so treat it as a coordinated action rather than a retry.

`--export-certificate PATH` additionally writes this party's public certificate -- the certificate alone, never the private key -- to `PATH` for sending to a partner. Naming the signing identity file itself is refused rather than allowed to overwrite the private key with the certificate.

## Verifying a receipt

```sh
psilink verify-receipt RECORD [INPUT_FILE] [RESULT_FILE]
```

Read a stored exchange artifact and report what holds up. It is read-only: it never modifies or re-signs an artifact. An exchange produces two, and this command verifies either or both:

- The **exchange record** (`psilink-record-<stamp>.json`), self-attested and unsigned. Verifying it is an internal-consistency check: it says nothing about the partner.
- The **dual-signed record** (`psilink-receipt-<stamp>.json`), written when the exchange ran with `signing.mode: certificate`. This is the evidence against the partner: both parties' signatures and certificates over the terms and the data that flowed.

`RECORD` may be either file -- the command tells them apart by their format `version`, so an auditor handed only the dual-signed record verifies it directly. To check both artifacts of one exchange in a single run, name the exchange record as `RECORD` and pass the dual-signed record to `--signed-record`; that is also what lets the record's agreed-terms hash, party identities, and run binder anchor the signature checks -- the run binder being what pairs the receipt to that one exchange (see [Pairing the receipt to one run](#pairing-the-receipt-to-one-run)). The record's verification keys are read from the record path with a `.keys.json` suffix by default, or from `--keys`. An unrecognized `version` on any of these files is rejected with a clear error (exit 64) rather than mis-parsed.

The record holds no matched data -- only salted commitments to it -- so verification **re-supplies** the committed data from your own retained files: pass the `INPUT_FILE` you contributed and the `RESULT_FILE` you kept, and the command reconstructs the committed data and opens every commitment (the sent payload, the received payload, and the record's pairing). Reproduction is byte-exact only from **unmodified** retained files -- a results file re-sorted or re-exported in a spreadsheet will not reproduce -- and a duplicate value in an identifier column is reported as a note. A received cell the partner committed as null is a known limitation: the result writes a null and an empty string the same way, so the cell reproduces as an empty string and the received-payload commitment reports a mismatch (never silently mis-opened). Whenever that commitment mismatches and the re-supplied received payload carries an empty cell, a note names the empty-versus-null difference as a possible cause -- a cause to check, not an exoneration: the verdict stays a mismatch, since the record cannot say which of the two was committed.

The **result size** the record states is checked too, by recount rather than by opening: it is the number of matched pairs, so when the record's pairing opens against your re-supplied result the command recounts that pairing and compares the two. A recorded size the opened pairing does not carry is a definite failure on its own line, distinct from a commitment mismatch and not ambiguous the way one is -- a result that did not belong to this exchange fails the pairing's own line first, so it never reaches this one. Where no pairing stands behind the figure -- you supplied no result, the keys carry no salt for it, it did not open, it opened but is not shaped as a pairing and so carries no count to recount, or the record carries none at all (a count-only exchange records no pairing) -- the size is reported as not checked. A record that states no size at all, which is every exchange where only one party received output, gets no line and is not at fault for it.

With `--config-file` (your exchange config, for your linkage terms) and `--partner-terms` (the partner's terms), it also re-derives the agreed-terms hash. The partner's terms are not retained by default, so this check is optional; without both, the terms hash is reported as not checked. `--config-file` is never auto-loaded -- name it explicitly, since a stray config in the working directory may belong to a different exchange.

Either path is one you named, so a file that is not there is a usage error rather than a run with the terms hash quietly left unchecked. A `--partner-terms` file that defines no `linkage_terms` is refused for the same reason -- supplying the partner's terms is all that flag does. A `--config-file` that defines none is not: the same config is where `signing.partner_fingerprint` and `signing.identity_file` are read from, so one carrying only those is accepted for them, and a note beside the agreed-terms line records that the config supplied no terms. A "not checked" line names what is still missing, so a config you already passed is never the remediation it points you back at.

With neither `INPUT_FILE` nor `RESULT_FILE`, the command still runs -- the third-party-auditor case: it checks the record's structure and version and reports each commitment as not opened (an auditor without your retained data cannot open the commitments, by design), rather than failing.

The verdict distinguishes a commitment that **opened and matches**, one that was **not opened** (its data was not re-supplied), and one that **does not match** -- and the result-size line reads the same three ways -- rolling up to `VERIFIED` (everything checked and passed), `INCOMPLETE` (nothing contradicted, but not everything could be checked), or `VERIFICATION FAILED` (a check did not match). The command exits nonzero (65, `EX_DATAERR`) only on a definite failure; a failed opening is reported as "the record may have been altered, or a re-supplied input/result/terms does not match this exchange", never asserted as tampering, since the two are indistinguishable. Where the recorded result size is the only thing at fault -- every commitment opened and the agreed-terms hash re-derived -- the headline drops that hedge and says what is established: the record's figure disagrees with the pairing it commits to, and the files you re-supplied check out. When no dual-signed record was supplied, the output says so rather than implying it checked the partner's signatures.

### Verifying the signed record

For a dual-signed record the command reports, per party, four things: the **receipt signature** against the certificate the record carries, the **certificate identity binding** (its self-signature, which is what ties the displayed identity to the signing key), what **anchors the certificate** outside the record, and the **asserted identity** against the identities this exchange was between. Beside those it reports the **agreed-terms hash** and the **receipt-record pairing** (below). The per-exchange **binder** is printed but never recomputed -- deriving it needs the exchange's session key, which only the two parties held -- so what a verifier can check about it is that the record for the run carries the same value. The verdict rolls up on the same three levels, prefixed `SIGNED RECEIPT`, and a failure exits 65 (`EX_DATAERR`).

The pinned fingerprint comes from `--partner-fingerprint`, or from `signing.partner_fingerprint` in the config named by `--config-file`; the flag wins, so an auditor given a fingerprint out-of-band can verify without a config. A config named for its pin need define nothing else -- only the `signing` fields are read from it -- and a `--config-file` path that does not exist is a usage error rather than a silently unanchored run, so a typo cannot be mistaken for a record you hold no fingerprint for. A value that is not a fingerprint (an unpadded base64url SHA-256 digest, 43 characters) is a usage error too, so a mistyped pin is never reported as a partner mismatch. A pin matching **neither** certificate is a failure -- the record is not the party's you pinned.

#### Pairing the receipt to one run

Recurring exchanges between the same two parties under the same terms produce receipts a verifier cannot tell apart -- the signed values it can check, the agreed terms and both certificates, are identical from run to run -- so signatures alone do not say which run a receipt is from. Both artifacts of a run carry one shared **run binder**, and naming the exchange record is what lets the command compare them. The pairing line reports one of four things:

- **the same run** -- record and receipt carry the same binder.
- **`DOES NOT MATCH`** -- they carry different binders: two artifacts from different runs, not one exchange. This fails the run (exit 65) and is reported on its own line, distinct from a signature, identity, or anchoring failure -- every one of those may still read as passing. A note points at the shared timestamp stamp the record and receipt of one exchange carry by default.
- **no run binder in the record** -- the record is of an exchange that produced no signed receipt at all, so this receipt is not that run's. Also a failure.
- **not checked** -- no exchange record was named. Nothing is contradicted, so the run still exits 0, but the verdict stays `INCOMPLETE`: which run the receipt attests is open. A dual-signed record verified on its own therefore reports `INCOMPLETE` even with both certificates anchored and the terms hash checked. That is the honest reading rather than a gap -- name the run's exchange record as `RECORD` and pass the receipt to `--signed-record` to pair them.

An exchange run with `--no-record` still produces its signed receipt -- that flag suppresses the record, not the receipt -- and leaves nothing for the pairing to compare against, so every verification of that receipt is the **not checked** case above: it can never rise above `INCOMPLETE`, on any verifier, and no record can be reconstructed after the run to resolve it. Keep the record whenever you keep receipts as evidence. The exchange warns about the combination before it runs, while both choices can still be changed -- see [Signing without an exchange record](#signing-without-an-exchange-record).

An artifact written before psilink carried the run binder is refused on its format `version` (exit 64), naming the version this build recognizes, rather than reported as a pairing failure.

#### A verified verdict needs both certificates anchored

The record carries two certificates, and the top-line `SIGNED RECEIPT VERIFIED` speaks for both: it is reached only when something outside the record anchors **each** of them (and, like every other check, only when the pairing above ran and passed), and it names what anchored each one -- `both certificates are anchored outside the record -- the initiator's by your own signing identity, and the responder's by a fingerprint you pinned out-of-band`.

There are two anchoring sources, and which you use depends on whether you were a party to the exchange:

- **Your own signing identity** anchors your own slot, and you supply no fingerprint for it. The command reads the identity from `--identity-file`, else `signing.identity_file` in `--config-file`, and computes the fingerprint itself -- there is nothing to copy by hand, and nothing you could copy except off the record you are checking. With neither, your own slot is simply left unanchored: psilink looks in no location of its own, and the verdict grades `INCOMPLETE` at exit 0 rather than refusing the run. Only the certificate half of that file is used: verifying signs nothing, so the private key stored beside the certificate is neither imported nor checked against it, and verify-receipt writes nothing beside it either, so the file can be read from a read-only mount. Naming the file with `--identity-file` asserts the record is one you signed, so an identity that matches neither certificate then fails the run; one the config named, which you did not name here, is reported instead and leaves the slot unanchored.
- **A pinned fingerprint** anchors a party you know out-of-band. Repeat `--partner-fingerprint` to pin both signers, which is what a verifier who was party to no exchange does; a third value is refused, since the record holds only two certificates.

Each value anchors at most one certificate, so pinning the same fingerprint twice anchors one slot and leaves the other for something else. Pinning your own fingerprint is redundant with your signing identity, which already anchors your slot: the two carry one digest, so they anchor one slot between them.

An unanchored certificate is still checked -- its self-signature, its signature over the receipt content, and the identity it authorizes -- but only against itself and the identities you supplied, and whoever assembled the record can satisfy all three with a certificate they minted. So a run that anchors one slot says that party signed this exchange and says nothing about who the other signer is. The command reports that as `INCOMPLETE` and names the slot: `Nothing outside the record anchors the initiator's certificate`, with a line saying what would anchor it. That is short of verified rather than a failure, so the run still exits 0.

With nothing anchoring either certificate -- the third-party-auditor case -- the command still checks both signatures and both identity bindings and reports `certificate fingerprint trust not established (no pinned value supplied)`, again `INCOMPLETE` rather than a failure. This is the trust model, not a gap: a dual-signed record is self-consistent by construction, so verifying its signatures alone proves only that the holders of the two certificates in it signed the content, which anyone can arrange with two certificates of their own. Ask your partner for their `psilink fingerprint` value over a trusted channel and pass it to anchor their slot.

## Recovery

### Key lifecycle

A key file passes through four stages:

1. **Creation** - `psilink invite` or `psilink accept` writes a fresh `.psilink.key` with a short-lived invitation token. The file is written owner-only (see [CREDENTIAL_STORAGE.md](spec/CREDENTIAL_STORAGE.md)).
2. **Rotation** - `psilink exchange` rotates the token automatically after each successful authentication handshake, before the data exchange begins. The new token replaces the previous one in the same file. No manual action is required. If the key file write fails, an error is reported immediately; both parties must re-invite because the partner may already hold the rotated token, making the old token invalid (see [Out-of-sync tokens](#out-of-sync-tokens)).
3. **Loss** - if the key file is deleted or otherwise unrecoverable, both parties must re-invite (see below). If a backup exists in a secrets manager or encrypted store, restore from the backup and retry the exchange; confirm with the partner out-of-band that the backup reflects the same exchange they last completed - if in doubt, re-invite rather than risk an out-of-sync token that silently fails the key exchange.
4. **Compromise** - if the token is believed to have been observed by a third party, follow the procedure in [Compromise response](SECURITY_DESIGN.md#compromise-response).

When [`authentication.token_max_age_days`](EXCHANGE_REFERENCE.md#authenticationtoken_max_age_days) is set, each rotated token is stamped with an expiry that many days out, so a token cannot outlive the configured maximum age between exchanges; without it, rotated tokens do not expire. `psilink exchange` checks the token's age at load time, before opening any connection. An already-expired token aborts the run with an error naming the expired time and directing both parties to re-invite (no key exchange is attempted); this applies to any token carrying an `expires` -- including an invitation token's bounded lifetime -- independently of `token_max_age_days`. When `token_max_age_days` is set, a token within `token_max_age_days / 3` days of expiry additionally prints a warning before the exchange. The warning is suppressed when that exchange succeeds, because rotation refreshes the expiry; it appears only when the token was not refreshed, as a prompt to re-invite before it lapses. A stamped `expires` is honored regardless of whether `token_max_age_days` is still set, so removing the field does not revive a token that has already passed its expiry.

### Out-of-sync tokens

If one party fails to write the rotated token to its key file - whether due to a crash, power loss, or a disk error - the two sides will hold different tokens and the next key exchange will fail. Clock skew can produce the same result: if one party's clock lags and a token expires between the key-exchange round-trip messages, that party fails the post-handshake expiry check and discards the new token while the other party saves it successfully. Because there is no way to determine which party holds the newer token, both must reset regardless of which side failed; reusing an older token may also violate key-rotation policies.

To recognize failed rotations, the error messages for exchanges that fail key-exchange authentication instruct users how they can generate and accept new invitation strings, and encourage them to contact their partners out-of-band. Connection information has already been shared, so recovery re-establishes the shared secret alone, through the [offline invitation](#offline-invitation) pair:

1. **Both parties remove their key file** (`.psilink.key`, or the `--key-file` path). The offline `invite` and `accept` used below each refuse to overwrite an existing one with a usage error (exit 64), so the out-of-sync token has to go before either command will run.
2. **The inviting party runs `psilink invite`** -- the offline form, with no URL. Its pre-existing `psilink.yaml` supplies the linkage terms; the command writes a fresh key file and prints a new invitation to forward out-of-band.
3. **The partner runs `psilink accept INVITATION [INPUT_FILE]`**, which reuses their own `psilink.yaml` the same way and writes their key file.
4. **Both parties run `psilink exchange`** at their convenience, as for any [recurring exchange](#recurring-exchange).

Each side's configuration is reused throughout; only the key file is recreated. Neither command takes `--identity`: each runs under the label its kept configuration already carries -- the one the partnership has been exchanging under all along -- and a flag typed at either is reported as having no effect rather than renaming the party for the recovery run (see [Configuration](#configuration)).

The [online invitation](#online-invitation) is not a recovery route. It reports a pre-existing configuration file as a conflict and aborts before minting a token, and that configuration is exactly what recovery keeps -- so the inviting party cannot reach the single command that invites, waits, and exchanges together, and the partner has no rendezvous to accept at. Recovery runs the separate offline commands above instead.

A party that already holds its configuration and needs only the new secret can instead re-provision offline with [`psilink exchange --invitation`](#provisioning-the-key-file-from-an-invitation), which writes the key file and runs the exchange in one command -- replacing that party's step 3 and their own run in step 4; the other party still runs `psilink exchange`.

### Token loss

If a key file is lost and no backup is available, reset as in [Out-of-sync tokens](#out-of-sync-tokens): coordinate with the partner out-of-band, both parties delete their existing key files, and the pair re-invites and accepts.

### Token compromise

See [Compromise response](SECURITY_DESIGN.md#compromise-response) for the procedure.

## Logging

Every command that produces diagnostic output - `init`, `invite`, `accept`, `exchange`, the zero-setup form, `fingerprint`, `probe-host-key`, `doctor`, and `verify-receipt` - accepts `--log-level` and `--log-file`.

psilink follows the standard stream convention: a command's result data goes to `stdout`, and all diagnostic output - every log line, `info` and `debug` included, together with the interactive prompts (the identity question and the confirmations) - goes to `stderr`. This keeps a piped or redirected result clean. `psilink accept --identity IDENTITY URL INVITATION 2>/dev/null > matched.csv` writes only the matched-records CSV to `matched.csv`, with the invitation-terms display, the "wrote key file" line, the runtime banner, and every other diagnostic sent to `stderr`, where the same run without the redirect still shows them on the terminal. The result on `stdout` is an exchange's CSV output (when no `OUTPUT_FILE` positional is given), the invitation token printed by `invite`, the fingerprint value printed by `fingerprint` -- whose action banner, bound identity, `--force` regeneration warning, and out-of-band sharing instructions are diagnostics on `stderr`, so `FP=$(psilink fingerprint)` captures just the value -- and the verification verdict printed by `verify-receipt` (its exit code, nonzero only on a definite failure, carries the same result for scripts).

`--log-level <level>` selects the verbosity: `silent`, `error`, `warn`, `info` (the default), `debug`, or `trace`, matched without regard to case. `silent` suppresses all log output. Any other value is a usage error and exits 64, naming the value you gave, on every command that accepts the flag - a typo never quietly leaves the run at the default. The level governs every diagnostic the run emits once logging is set up, including the low-level warnings from data cleaning and file handling, so `silent` keeps them out of the terminal and out of a `--log-file` alike and `debug`/`trace` turn up the rest of the run's detail - except a usage error in the command line itself (reported on `stderr` before either flag takes effect) and the last-resort line for an error no command handler caught (written straight to `stderr` at exit 1); neither is ever routed to a `--log-file`. It does not suppress the linkage terms `accept` shows when it stops to ask you to confirm them, nor the line saying what became of that question: those accompany the question rather than the log, and reach the terminal whatever this is set to, in the same rendering at every level (see [Offline acceptance](#offline-acceptance)).

`--log-file <path>` appends log output to `<path>` instead of writing it to the terminal, so psilink can be run unattended or in automation without shell redirection. The file is opened in append mode, preserving any content from previous runs; each line already carries an ISO-8601 timestamp, so successive runs stay distinguishable without a separate flag. The parent directory must already exist - a missing directory aborts the command with a usage error (exit 64) before any exchange work begins. A log file psilink creates is owner-only (mode `0600`), since at `debug`/`trace` it can record partner identity, linkage keys, and data categories; if you point `--log-file` at a file that already exists, its permissions are left as they are. On macOS a file also carries an extended ACL, which those permissions do not describe and a file inherits from the directory it is created in, so psilink clears it before the first line is written - on a file it creates and on one you point the flag at alike. A file whose extended ACL cannot be cleared is refused: the command stops with a usage error (exit 64) before any exchange work begins and writes no line into it. Inspect an extended ACL with `ls -le <file>` and clear one yourself with `chmod -N <file>`. `--log-level` still applies to the file, so `--log-level silent --log-file run.log` writes nothing. Every diagnostic line is captured, including the low-level warnings from data cleaning and file handling. `psilink doctor`'s check lines are captured too, but as the plain rendering an operator reads rather than as timestamped log records (see [Checking a network file drop](#checking-a-network-file-drop)). Results written to `stdout` (an exchange's CSV output, the fingerprint value) are not log output and are unaffected by `--log-file`.

For unattended runs, set `--peer-timeout` to a value that suits how long you are willing to wait for a partner that never appears (it defaults to one hour on `sftp` and `filedrop`; on `webrtc` an unset field leaves the transport's own defaults instead, ten minutes to meet the partner at the rendezvous then one hour of peer silence on the open channel); a partner that never appears at all makes the command wait out this budget at the rendezvous and live-exchange steps before exiting. The teardown after a successful exchange does not inherit this budget - it is bounded separately and short - so the long wait only applies while the exchange is still in progress. Wrapping the command in your pipeline's own outer timeout is still recommended as a backstop.

One case does not consume the whole budget: a rendezvous that finds a partner hello already in the folder and never gets an answer behind it fails well inside the timeout, naming the file rather than blaming your partner. That is the shape a previous run killed outright leaves, which is worth setting up against on a schedule - see [Directory exclusivity](EXCHANGE_REFERENCE.md#directory-exclusivity) for the recovery and for why `peer_id` is recommended for unattended runs.

### Machine-readable event stream

`--event-stream` emits a machine-readable event stream for a supervising process (an orchestrator, a job runner, a test harness) that spawns psilink and needs structured progress and outcome events rather than parsed log lines. It is available on every exchange-running command - the zero-setup exchange, `psilink exchange`, and the online `psilink invite`/`accept` - and is off by default; it has no effect on an offline `invite`/`accept`, which runs no exchange.

The stream is newline-delimited JSON on **file descriptor 3**, one event object per line, flushed as it happens: a stage-list event up front, a stage event at each protocol step and a stage-end event with that stage's duration when it completes, a warning event per non-fatal warning (a terms-exchange warning, a cross-party host-key divergence, or any local write a completed run was asked to make and could not - an audit artifact, or a configuration or consent record of an online `invite`/`accept`), a one-shot metrics summary, and exactly one terminal event - a result on success or a classified error on failure. The metrics event, emitted just before the terminal event, reports the run's operational counters: how many records this party processed, how many times a transport data operation retried, and how many times the connection was re-established. Together with the per-stage durations this lets a supervisor - or an operator debugging a slow or flaky recurring exchange - see where the wall-clock went and how much the transport struggled. The error event names one of four categories (`exchange`, `output`, `security`, `config`), a machine-readable abort reason distinct from the human log line, so a supervisor can tell a security (authentication) failure from a retryable transport fault - a distinction the exit code alone cannot make, since both exit 69. A run interrupted by a signal exits 130/143 without a terminal event (and so without a metrics event), which together is the interrupt signal.

`stdout` and `stderr` are unchanged by the flag: the CSV result still goes to stdout and every diagnostic still goes to stderr, so the event stream never corrupts either. Wire fd 3 to a pipe when you spawn psilink (for example, in Node, `stdio: ["inherit", "pipe", "pipe", "pipe"]`); if you pass `--event-stream` without wiring fd 3, the command fails fast with a usage error (exit 64) before any exchange work. The full contract - the framing, the per-line schema version, every event's fields, and the category rules - is in [docs/spec/CLI_EVENTS.md](spec/CLI_EVENTS.md).

## Exit codes

Every `psilink` command exits with one of the following codes. The failure classes 64, 65, 69, 70, and 73 follow the BSD `sysexits` convention.

| Code | Name | Meaning |
| ---- | ---- | ------- |
| 0 | success | The command completed. For an exchange, the run finished and any result was written. |
| 64 | `EX_USAGE` | Invalid caller input or configuration: a bad flag or positional, an unrecognized or repeated option, a missing/malformed config or key file, an unsupported channel, or -- with `--event-stream` -- fd 3 not wired. A run that has already started reaches it too, for a refusal whose remedy is likewise a settings, directory, or terms correction rather than a retry. A problem someone fixes before the next run; retrying unchanged will not help. See below. |
| 65 | `EX_DATAERR` | `psilink verify-receipt` only: the verdict is a definite verification failure -- a commitment, signature, certificate binding, identity, terms hash, or receipt-record pairing check did not match. The run itself completed; this is not a crash. See [Verifying a receipt](#verifying-a-receipt). |
| 69 | `EX_UNAVAILABLE` | Usually a transport or availability failure: the exchange server, peer, or shared storage was unreachable, rejected an operation, or went silent, and retrying once the transport recovers may succeed. From `psilink doctor`, it means something the checks themselves depend on was not available, so nothing was established either way. It is also the code for the one failure that is neither: a completed exchange whose result table could not be built because the partner's payload did not fit the agreed shape. Nothing local failed to write there, so it is not a 73 -- but the exchange did happen, so read the terminal event's `output` category before retrying (see [Machine-readable event stream](#machine-readable-event-stream)). |
| 70 | `EX_SOFTWARE` | An internal fault in psilink itself: two of the run's own derivations of the same quantity disagreed, on inputs it had already accepted. Nothing in your configuration or your data is what to change, and a retry reaches the same refusal while conducting another exchange. **Do not retry; report it** with the error message, which names the two figures that disagreed. |
| 73 | `EX_CANTCREAT` | The exchange completed and a local write did not: the result file, an audit artifact, the configuration and consent records an online `invite`/`accept` writes, or the configuration and key a zero-setup `--save` writes. **Do not re-run.** The data was exchanged; what failed is on this machine. See below. |
| 78 | `EX_CONFIG` | `psilink doctor` only: the checks ran and something they found needs changing before an exchange will work (see [Checking a network file drop](#checking-a-network-file-drop)). |
| 130 | interrupted (SIGINT) | The run was interrupted by `SIGINT` (Ctrl-C). 128 + 2, the conventional signal exit. |
| 143 | terminated (SIGTERM) | The run was terminated by `SIGTERM`. 128 + 15. |
| 1 | unexpected error | A last-resort code for an error that escaped every command handler; ordinary faults use 64, 69, 70, or 73 above. |

64, 65, 69, 70, and 73 are what the run itself reports: a `UsageError` and a connection misuse both map to 64, a definite `verify-receipt` verdict failure to 65, an internal-consistency fault to 70, and any other failure to the error's own exit code or 69 at the command error boundaries, while 73 is set where a completed run loses a local write. 78 is `psilink doctor`'s verdict code and is set nowhere else; 130 and 143 are set by the exchange's own signal handlers; 1 is the top-level catch-all. When `--event-stream` is active a `security`-category failure exits 69 like any other transport failure -- the exit code cannot single it out, so read the terminal event's category to detect it (see [Machine-readable event stream](#machine-readable-event-stream)).

### Exit 64 mid-run: a refusal the next attempt repeats

Most of what lands on 64 is caught before anything is dialed -- a bad flag, a malformed configuration or key file, an unsupported channel. A run that has already started reaches it too, and for the same reason: the refusal is decided by what was supplied, so the next attempt ends at the same place. **Do not retry a mid-run 64 unchanged.** 69 is the code that says the transport may recover; these conditions say something has to change first. What they are:

- **The connection settings.** An SFTP exchange whose cumulative mid-exchange reconnection budget (`max_reconnect_attempts`) is exhausted by a partner server that keeps dropping the held session. A WebRTC coordination-server address that could move the socket off the server the configuration names, a peer id the server reports as already registered (the usual cause is both parties running the same `role`), or a `key` the server rejects. A `retain_files` or `lockless_rendezvous` value the two parties disagree on -- these are bilateral agreements with no negotiation, so a difference is fatal on both sides.
- **The shared directory's state**, on `sftp` and `filedrop`. A stray or foreign file appearing in the rendezvous directory during the exchange; more than one hello, lock, or message file where one is expected; a peer hello left behind as residue from an earlier run; a control or message file whose payload is malformed; or two peer ids where one is a prefix-extension of the other. The directory must be dedicated to a single exchange between exactly two parties.
- **A channel bound the peer or server crossed.** A frame above the maximum frame size, a directory listing past its entry-count or filename-length bound, or a server-driven operation that made no progress within its liveness bound. Each is refused rather than retried, because re-reading incurs the very cost the bound exists to prevent; the message names the specific next step.
- **The agreed terms name something this build cannot run.** A linkage-key element transform naming a standardization function this build does not recognize; a linkage algorithm other than `psi` or `psi-c`; or both parties setting `deduplicate: true` under `linkage_strategy: single-pass`, which resolves to a many-to-many match that strategy does not pair -- the message names the strategy to move to, `cascade` carrying that pair. Each of the last two is settled from the agreed pair once the terms are exchanged, so a run refuses here even where this party's own copy passed on its own. The transform case fires as that key's first row is read -- whether or not any row has a value for the element declaring it -- because the fault is in the terms rather than in the row that happened to reach it. Agree terms this build can run, or move both parties to a version that carries what they name.
- **A row cannot be carried through the agreed terms.** A key element that reads or produces a value above the per-value ceiling, or a row whose assembled key strings cross the per-row bound with no declared fan-out producer to account for the width. The message names the element, the step position, and the row; the remedy is to bind the element to a shorter column, or to shorten the field in this party's own standardization before the key element reads it. Under single-pass, also a record contributing more candidates than one record may contribute to one key, a party's rows expanding past the width its own terms and standardization account for, or two datasets whose declared sizes cross the single-pass ceiling.
- **The partner's build is incompatible.** A message file whose wire envelope carries a version byte this build does not recognize.
- **A guard on psilink's own use of the connection fired.** These stand against a fault in psilink or in how it was packaged rather than against anything you configured: a session key of the wrong length, a value with no JSON representation handed to a send, a send or receive against a closed connection, or an installed WebRTC dependency that does not expose what the transport's flushing close depends on. Report one with the message it printed.

### Exit 73: the exchange completed, a local write did not

**Do not re-run a 73.** The data was exchanged; what failed is a local write afterwards, and no repeat performs it. The conditions:

- **The result file could not be written.** The exchange succeeded and its result was lost on the way to disk, so the run reports a failure -- but re-running it would conduct a second exchange, re-sending this party's records. Fix the destination (a full disk, an unwritable directory, a revoked mount) before running again, deliberately, in the knowledge that it is a fresh exchange. This covers a result written to a file: a result streamed to stdout is handed off to the process's own stdout, and a loss past that hand-off (a truncated shell redirect on a full disk) is outside what the run can detect, so it exits 0.
- **An audit artifact could not be produced** -- the self-attested record and its verification keys, or the dual-signed receipt. Fix what blocked the write (a full disk, a read-only or unwritable path, a revoked mount) and the next exchange records normally.
- **An online `psilink invite` or `psilink accept` could not write its configuration.** What is missing is the configuration a later recurring `psilink exchange` reads. The rotated key is on disk, so recovery is to recreate the configuration -- not to re-invite -- and the error naming the cause was logged when the write failed.
- **A zero-setup `--save` run could not write the configuration, or the key file that accompanies it when both parties saved.** The exchange itself completed and its result is written; what is missing is the recurring-exchange setup. Fix what blocked the write, or point `--config-file` / `--key-file` elsewhere, and establish the recurring exchange with `psilink invite` -- re-running the zero-setup command would conduct a second exchange. The report names what became of each file, so a configuration that was written and could not be removed after the key file failed is named as still on disk; move or remove it first, or `psilink invite` refuses to overwrite it. A configuration file that appeared at the target path after the run's up-front check is reported the same way: the run refuses to overwrite it and reports the save as lost.
- **An online `psilink accept` could not refresh a consent record on a configuration it reused**, or **an online `psilink invite` could not record the payload columns it observed** into the configuration it had just written. The configuration itself stands; what is missing is a machine-managed record the next recurring exchange would have been held to, so that run reconciles against the older record, or lazily where there is none. The logged warning names which.

A supervisor reads the response off the exit code alone: never retry a 73 -- a retried `psilink exchange` simply conducts another exchange with the rotated token, re-sending this party's data and waiting on the partner at the rendezvous again, as does a retried zero-setup run (a retried online `invite` or `accept` fails against the key file already on disk instead). What failed is named on stderr, and on fd 3 when `--event-stream` is active: a lost result file is the terminal `error` event with `category: "output"`, and every other condition above is a `warning` event beside a terminal `result` (see [Terminal-event guarantees](spec/CLI_EVENTS.md#terminal-event-guarantees)). The distinct code exists for the unattended run, where that stderr line is discarded by a supervisor or suppressed by `--log-level error`.

Cap how many times a supervisor retries automatically, and stop rather than loop on a retryable code without limit. The bound is about the count of attempts, not about diagnosing any one fault: every attempt re-runs the exchange protocol against the same set from the start, and 69 can mean the exchange already happened -- the completed-exchange, `output`-category case above -- so a loop that keeps retrying past a few attempts risks repeating a run rather than recovering one interrupted attempt. Repeated exchanges against the same set are not what the protocol's privacy guarantee is scoped to (see [Threat model](SECURITY_DESIGN.md#threat-model)): it assumes a partnership deciding when a run happens, not an unattended loop deciding how many times it happens. Stop after a small, fixed number of attempts -- three, say -- and page an operator instead of retrying further. A 70 is outside that budget entirely, as a 73 and a 64 are: each is deterministic in the run's own inputs, so no attempt after the first ends differently (see [The internal-fault code](spec/CLI_EVENTS.md#the-internal-fault-code) and [Exit 64 mid-run](#exit-64-mid-run-a-refusal-the-next-attempt-repeats)).

For `psilink exchange`, a missing, malformed, or unreadable configuration file (`psilink.yaml`) or key file (`.psilink.key`) - including a key file whose stored token is malformed - is a usage error and exits 64. An unsupported channel or URL scheme - a `ws://` URL on a path that cannot use one (the zero-setup and acceptance paths), a `ws://` URL carrying more than the coordination server's location on the path that can, a `webrtc` connection with no `role`, a `webrtc` coordination-server address that forms no dialable WebSocket URL, an unknown scheme, or a malformed `file://` authority - is likewise a usage error and exits 64, as is a URL carrying a malformed percent-escape such as a lone `%` (with any credential redacted from the message) or an invalid connection option or combination (for example a negative, fractional, non-numeric, or above-ceiling `--max-reconnect-attempts`, a non-numeric or out-of-range (outside `0..65535`) `--server-port`, a reserved `peer_id`, or a `retain_files`/`lockless_rendezvous` contradiction). Failures during the exchange itself - connecting to the server, the rendezvous, or the message loop - exit 69, unless the failure is the internal-fault condition above, which exits 70, or one of the mid-run conditions that exit 64 (see [Exit 64 mid-run](#exit-64-mid-run-a-refusal-the-next-attempt-repeats)). A successful run exits 0; a run terminated by a signal exits 130 (SIGINT) or 143 (SIGTERM).

Passing a single-value option more than once - for example `psilink invite --accept-timeout 60s --accept-timeout 120s`, or a repeated `--log-level`, `--log-file`, `--server-port`, `--peer-timeout`, or `--linkage-strategy` - is a usage error and exits 64, naming the flag (`--<flag> may be given only once`), rather than silently taking one of the values. Count flags (`-v`/`--verbose`) and boolean flags (and their `--no-` forms, such as `--record`/`--no-record`) may still be repeated and keep their accumulate / last-one-wins / negation semantics.

Passing an unrecognized option - a misspelling such as `--server-user` for `--server-username`, or `--retain-file` for `--retain-files` - is a usage error and exits 64, naming the offending option, before any connection is attempted or file is written, on every command. It catches a mistyped credential or path override that would otherwise be dropped silently, leaving the run on the option's default or a stale configuration value. Positional arguments - the server URL, the input and output files, and the invitation string - are validated by each command, not by this check. The `invite`, `accept`, and `init` commands accept a positional that may begin with `-` (an invitation string, or `-` for stdin; see [Invitation strings](#invitation-strings)), so on those commands the unknown-option check rejects only a `--`-prefixed token, which a positional never is, and leaves a single-`-` positional for the command's own validation.

## See also

- [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md) - exchange specification format consumed by the CLI
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md) - authentication model underlying the invitation and recurring exchange flow
- [COMMUNICATION.md](COMMUNICATION.md) - communication channels (WebRTC, SFTP, filedrop) and supporting services
- [DEPLOYMENT.md](DEPLOYMENT.md) - operating the supporting services used by the CLI
- [DESIGN.md](DESIGN.md) - overview of the user journey and command table
