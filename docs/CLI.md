---
title: "PSI-Link CLI"
---

# PSI-Link CLI

This document covers the CLI commands, configuration files, invitation strings, and recovery procedures for PSI-Link. It does not cover the PSI protocol (see [PROTOCOL.md](spec/PROTOCOL.md)), the security and authentication model (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md)), or deployment of supporting services (see [DEPLOYMENT.md](DEPLOYMENT.md)). Intended readers are IT staff and power users.

Before a first SFTP exchange against a server you do not administer yourself, work through the [SFTP server checklist](DEPLOYMENT.md#sftp-server): the settings covered there -- upload-triggered automation, scanning, auto-cleanup, account permissions, anti-flood bans, and session limits -- are the usual cause of an SFTP exchange that stalls, and each one reaches you as that stall rather than as a message naming it.

## Configuration

Exchange details are stored in two files: a configuration file and an authentication key file. The default file names and paths are `./psilink.yaml` and `./.psilink.key`, while command line arguments to override are `--config-file` and `--key-file` respectively. When these files are first created, the application prints a notice identifying both and gives a warning that the key file should be treated as private. For Docker deployments, agencies are expected to mount one directory per exchange partner, so the working directory itself provides isolation and no subdirectory is needed.

The configuration file is not intended to contain secrets and is safe to commit to version control. The shared secret and its expiration are stored in the key file instead; they never appear in the configuration file and are not user-editable because the application rotates them automatically. By default, the key file is intentionally named with a leading dot (`.psilink.key`) so that it is hidden from default directory listings and less likely to be accidentally copied or included in an archive; it should be added to `.gitignore`. All other credential fields use the `@path` convention described below.

Command line arguments take precedence over values in the configuration file, allowing scripted workflows to override specific parameters without modifying the stored configuration. Credential and opaque string fields support `@`-file references: a value beginning with `@` is read from the file at the given path rather than used literally - for example, `--server-private-key=@/run/secrets/id_rsa` reads the private key from disk. This convention applies both on the command line and in the configuration file, and is the recommended approach for any credential to avoid exposing sensitive material in process listings or shell history. It applies only to the credential and opaque-options fields marked "`@`-file recommended" in the [exchange reference](EXCHANGE_REFERENCE.md). Any other field -- a free-text field such as `linkage_terms.identity` or `retention_disposition`, or a local-path field such as `signing.identity_file` -- is not treated as an `@`-file reference: a leading `@` is kept as a literal character rather than read as a file path.

When a credential supplied as an `@`-file reference is written into a configuration file -- by a zero-setup run with `--save` or by the `invite`/`accept` provisioning commands -- the saved file records the original `@path` reference, not the resolved secret, so the secret is never copied into `psilink.yaml` and the file remains safe to commit; `psilink exchange` writes no credential, editing an existing `psilink.yaml` only to record a host-key pin (see [SFTP host-key trust](#sftp-host-key-trust)). A credential supplied as a literal value is saved as-is. The stored reference is the string exactly as typed: a `~/`-relative reference such as `@~/.ssh/id_rsa` therefore stays valid when the configuration is moved to another machine, while a relative reference such as `@secrets/pw` is resolved against the working directory of whichever later command reads it -- use an absolute or `~/` reference if that command will run from a different directory. A saved `@path` is resolved when the configuration is loaded for the next exchange, before any network activity; if the referenced file has since been moved, deleted, made unreadable, or emptied, that load fails with a usage error naming the reference and no connection is attempted.

The "safe to commit" property protects the author of a configuration, not whoever later runs it. Never run `psilink exchange` against a configuration from an untrusted source: treat one received from a partner or pulled from a shared repository as you would treat handing over the files it references.

- **What the load reads.** Every `@path` credential reference in the configuration is read from your local disk, with your privileges, before the exchange runs.
- **Where it goes.** For an SFTP exchange the resolved `server.password` is sent as the SSH password to the configured `server.host`, so the referenced file's contents leave your machine.
- **What cannot introduce it.** An invitation carries no credential by construction, and the connection details on the accept path come from your own command line, so only a wholesale substituted configuration file reaches this.

The threat model behind the rule -- what a substituted configuration can do with a reference and why it is not cheaply detected -- is in the [security design](SECURITY_DESIGN.md#configuration-file-trust-boundary).

The `--config-file` and `--key-file` arguments are expected to be available for all relevant commands below, and are thus not explicitly listed.

A leading `~` (or `~/`) in a local filesystem path -- whether given on the command line or written into the configuration file -- is expanded to the current user's home directory. Which paths are expanded depends on the command:

- The path inside an `@`-file reference (for example, `@~/secrets/id_rsa`) is expanded wherever a reference is resolved.
- `psilink exchange` expands `--config-file`, `--key-file`, `--record-file`, the input and output paths, and `signing.identity_file`.
- The zero-setup form expands `--config-file`, `--key-file`, and `--record-file`; its input and output positionals are taken literally.
- `psilink init` expands `--config-file`; `psilink fingerprint` expands `--config-file`, `--identity-file`, and `--export-certificate`; `psilink verify-receipt` expands `RECORD`, `--keys`, `--signed-record`, `--config-file`, `--partner-terms`, `--identity-file`, and `signing.identity_file`.
- `psilink invite` and `psilink accept` expand no path argument. A `~/`-relative path given to either is taken literally and creates a directory named `~`, so pass an absolute path.

Note that `~user` (another user's home) is not resolved.

When a connection is supplied as a URL, psilink percent-decodes the host, path, username, and password into the stored connection fields, so a reserved or non-ASCII character must be percent-encoded in the URL and is stored decoded -- for example `sftp://user@host/my%20drop` targets the directory `my drop`, and a percent-encoded password is sent decoded. All URL-to-config paths decode identically. A malformed percent-escape (such as a lone `%`) is rejected with a usage error (exit 64), and the credential is redacted from the message.

An `INPUT_FILE` argument may be given as `-` to read the CSV from standard input instead of a file on disk -- for example, `cat data.csv | psilink exchange - results.csv` -- so a pipeline need not stage a temporary file. This applies to `psilink exchange`, the zero-setup form (`psilink URL INPUT_FILE`), `psilink invite`, `psilink init`, and `psilink verify-receipt` -- for the last, to its `INPUT_FILE` only; the `RESULT_FILE` positional must be a path. For `psilink accept` it applies only with `--consent-to-terms`: `accept` normally reads its interactive confirmation from standard input and so cannot also take the CSV there, so a `-` input is rejected with guidance to give a file path; passing `--consent-to-terms` skips that prompt and frees standard input, so `accept --consent-to-terms - ...` reads the CSV from stdin like the others. `psilink init` reads its CSV from standard input the same way, so a `-` input means `init` cannot also prompt there: when a configuration file already exists at the output path and the CSV comes from stdin, `init` fails closed rather than overwriting unprompted (the same conservative default it applies in any non-interactive context). Passing `-` at an interactive terminal with nothing piped in is reported as an error rather than left waiting silently for input -- pipe the CSV or pass a file path.

Durations on the command line are written as a positive integer followed by a single-character unit -- `s` (seconds), `m` (minutes), `h` (hours), or `d` (days); for example `45s`, `30m`, `2h`, or `1d`. The unit suffix is required: a bare number such as `30` is not a valid duration and is rejected with the suffixed form to use (`30s`) rather than silently read as seconds. This applies to every duration-valued option, including `--expires-in`, `--accept-timeout`, `--connection-timeout`, and `--peer-timeout`.

`--polling-frequency` sets how often the `sftp`/`filedrop` channels poll the shared directory for the partner's files, overriding the `poll_interval_ms` configuration field (default `5s`). It is duration-valued like the flags above -- the unit suffix is still required, and a bare number is still rejected the same way -- but it additionally accepts a millisecond unit, so a sub-second value such as `100ms` is expressible; the millisecond unit is unique to this flag, and the other duration options still reject a sub-second or `ms` value. A conservative interval stays within SFTP servers' anti-flood limits, and because the per-round encryption dominates an exchange's wall-clock time a multi-second poll adds negligible latency, so the flag exists mainly to let a demo opt into a fast poll against a controlled server. There is no hard floor, but a value below `1s` is warned about (not blocked): a sub-second poll can trip an SFTP server's anti-flood/DoS protection and drop the connection. The flag takes effect on the commands that build a live connection -- the zero-setup exchange, `psilink exchange`, and the online `invite`/`accept` -- and, like the other connection-tuning flags, is reported as ignored on an offline `invite`/`accept` (set `poll_interval_ms` under `connection.options` in the written configuration instead).

The timeout flags `--connection-timeout`, `--peer-timeout`, and `--accept-timeout` also have a sanity ceiling of `7d`: a value above it is rejected with a usage error naming the flag and the maximum, before any connection attempt, token, or file write. A timeout is a coordination window that even a generous async setup measures in hours, so a value past a week is treated as a mistake rather than an intent; this is a usability guard, not a security bound (the accept window is in any case bounded by the invitation lifetime). It is separate from the `--expires-in` one-year ceiling, which bounds how long the invitation stays valid rather than how long a command waits.

## Initialization

```sh
psilink init [INPUT_FILE]
```

This creates a configuration file and then exits - no exchange or invitation is generated, and no key file is created. The file is a commented template with every option documented inline and all defaults pre-filled; if an input file is provided, column metadata, linkage fields, and data standardizing transformations are inferred from it. The user can then edit the file by hand before running their first exchange. Pass `--identity` to pre-fill the linkage-terms identity (a placeholder is written for you to edit otherwise). The [web console appliance](DEPLOYMENT.md#server-job-api) is an alternative to hand-editing this template: an operator prototypes one exchange there and the console produces a recurring-run hand-off -- a filled-in `psilink.yaml` (or the zero-setup command), the `psilink exchange` command, and cron/Task Scheduler examples -- to carry that run to a scheduled command-line exchange (see [Recurring exchange](#recurring-exchange)). The hand-off fills in the portable settings that carried over from the run and marks the machine-specific paths as placeholders to set; it is not a full guided-authoring wizard. On success the command prints a notice identifying the configuration file it wrote and exits 0; invalid caller input (an unreadable or malformed `INPUT_FILE`) exits 64, and the command performs no network activity on any path.

If a file already exists at the output path, the user is prompted before overwriting; declining leaves the existing file untouched. When no terminal is available to prompt (a non-interactive run, or a `-` stdin CSV that has already claimed standard input), `init` fails closed with a usage error rather than overwriting silently - delete the file or pass `--config-file` to write elsewhere.

## Zero-setup exchange

```sh
psilink [--save] [--linkage-strategy STRATEGY] [--sweep-exchange-files [--force-retain-sweep]] URL INPUT_FILE [OUTPUT_FILE]
```

Both parties run this command against the same server. Linkage terms, metadata, and data standardizing transformations are inferred from each party's input file; if the inferred terms disagree, the exchange fails with an error. Users are expected to prepare files with matching schemas before running. The server coordinates their connection and the exchange proceeds immediately without any prior configuration. By default, no configuration files are written. This mode is suitable for one-off exchanges and for onboarding sessions where both parties are in direct communication. Security relies on the transport authentication layer and file system controls rather than a pre-shared secret. If there is no end-to-end encryption (e.g. SFTP or file-drop), then implicitly trust is placed in the server administrator.

`--linkage-strategy STRATEGY` chooses the linkage strategy (`cascade` or `single-pass`) exactly as for [`psilink invite`](#offline-invitation), with the same `single-pass` disclosure tradeoff. Because each party infers its own terms here rather than one party authoring them for both, both parties must pass the same value: the strategy is a mandatory-consistency term, so a mismatch aborts the exchange. An unknown value is a usage error before any connection is attempted.

The URL scheme determines the transport channel:

| Scheme | Channel | Description |
|--------|---------|-------------|
| `sftp://` or `ssh://` | `sftp` | SFTP server; SSH credentials required |
| `ws://` or `wss://` | `webrtc` | WebRTC via PeerJS peer-coordination server (not yet available in CLI) |
| `file://` | `filedrop` | Locally-mounted shared directory (e.g. NFS or SMB share) |

For SFTP, SSH credentials must be supplied in the URL or as command-line arguments. Embedding credentials in the URL is not recommended as URLs may appear in shell history and process listings; use the `@path` convention instead - see [Configuration](#configuration).

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

Invitation strings beginning with `-` may be misinterpreted as option flags by argument parsers. On `invite`, `accept`, and `init`, a single-`-`-leading token is kept as a positional and validated against the invitation string (or file) schema, while a `--`-prefixed token -- which a positional never is -- is rejected as an unrecognized option (exit 64), so a `-`-leading invitation is identified unambiguously and a mistyped flag is still caught.

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

The `INVITATION` argument is either a base64url string or an `@path` reference to a file containing one. This command decodes the invitation token, displays what acceptance discloses, and asks you to confirm it. On a yes, configuration and key files are created (with exceptions noted below) and you are told to fill in your connection parameters before conducting exchanges; on a no, nothing is written. Coordination with the partner happens out-of-band, for example if the linkage terms are unacceptable or if the invitation expires.

### Enforced, or your partner's word

Every fact the display states carries the basis it rests on, so the two are never told apart by omission:

- `(enforced)` -- psilink holds the fact itself. Either it is true of the run, or the exchange aborts rather than proceed without it.
- `(your partner's word)` -- the fact is what your partner declared. psilink shows it faithfully but neither verifies nor enforces it, and a partner that does not honor it is not stopped by this tool.

A fact that needs more than the marker carries its explanation on the line below it, in the same wording the web consent screen uses for the same fact.

### What the display shows, in order

The display is an indented outline, one entry per line. It leads with what this party itself discloses -- the hardest thing to undo -- before the terms the invitation proposes.

- **`columns you will send`** (`enforced`) -- the columns this party will send to your partner for matched records, one per line. It reads `(none)` in the two cases where nothing leaves: your file discloses no columns, or the invitation gives the inviting party no result, in which case the payload step transmits nothing at all and no column set is listed -- your input file cannot change that answer. Where columns are listed they are derived from your own input through the same rule that decides what psilink transmits, so no column outside that list is sent. The list is also what acceptance records as your consent to it (see [Confirming what you send](#confirming-what-you-send)), so the bound holds over later runs and not only over the configuration this acceptance writes: a run that resolves a different set -- including one on a configuration that already existed, whose stored metadata nothing here compares against this input -- shows it and asks again rather than send it. Where the set is not yet known -- an offline acceptance given no input file -- the line says so and names what settles it: your input file, read when the exchange runs, which shows the columns and asks you to confirm them there instead. An online acceptance always lists the set, since it prepares the exchange it is about to run and reads the list off that.
- **`inviting party`** (`your partner's word`) -- the name your partner typed into their own terms. psilink has not verified it.
- **`PSI algorithm`** (`enforced`) -- `psi` reveals the shared identifiers of matched records to whoever receives the result; `psi-c` reveals only their count. Both parties must end up on the same algorithm.
- **`linkage strategy`** (`enforced`) -- `cascade` or `single-pass`, with the single-pass disclosure note when it applies. A mandatory-consistency term: the exchange aborts unless both parties agree on it.
- **`you will receive the result`** (`enforced`) -- a `no` means you are sent no result and any result sent to you is rejected.
- **`the inviting party will receive the result`** (`enforced` on a `yes`, `your partner's word` on a `no`) -- the marker follows the answer, because the two are not alike. A `yes` is a disclosure the run itself makes, and what your partner does with the result once it holds it is governed by your agreement rather than by psilink. A `no` is the withholding of a result from a partner, which rests on the agreed terms being honored, not on anything psilink can impose.
- **`what your partner learns either way`** (`enforced`) -- shown when your partner does not receive the result. Helping compute the match tells an honest partner which of its own records are in your data. It is inherent to the match, not a breach, and it is bounded: never which of your records they met, nor anything about the rest of your set beyond its size.
- **`duplicate matches`** (`enforced`) -- whether a record may match more than one of the partner's.
- **`matched on`** (`enforced`) -- a single line naming the fields the linkage keys match on.
- **`personal data used`** (`enforced`) -- the categories of personal data the keys are computed over. Under each, **`declared data standards`** (`your partner's word`) lists the standards your partner commits that category to, including any allowed-character pattern. Those are data expectations, not filters psilink applies.
- **`allowed-character patterns`** (`your partner's word`) -- shown once when any field declares one, carrying the caveat that covers every pattern listed above: each is a partner-supplied regular expression psilink has not verified. The patterns themselves are shown in full under the field each belongs to, so a reader who knows regular expressions can inspect what one actually admits.
- **`linkage keys`** (`enforced`) -- each key: the fields it matches on and how broadly (a truncated value, an approximate match), then the elements it combines, the declared field behind each, every value transform with its parameters and what it does to matching, any approximate-match setting, and any swap.
- **`columns you will receive`** (`enforced` where the invitation carries the column set, `your partner's word` where its terms only declare one) -- the columns the invitation says your partner will send for matched records, or `(none)` where it carries an empty set. Only a declared direction reaches this line: where the invitation declares nothing, the line is absent and what arrives is reconciled against your partner's own disclosure when the exchange runs. What your side locks in is the set the invitation *carries* -- the exact columns your partner's own disclosure rule produced -- and your own side is what enforces it: anything else your partner sends is received and then rejected, aborting the exchange. A carried empty set is that same commitment with no column in it. Where the invitation carries no such set, and the columns shown come from the terms your partner authored, the marker says so: there is no recorded set to hold them to, so an online acceptance reconciles what arrives against your partner's own disclosure instead. The abort stops the exchange from completing, not the columns from crossing: each side reconciles what it received only after the payloads have been exchanged, so a violated commitment is caught on the far side of the wire.
- **`columns the inviting party requests from you`** (`your partner's word`) -- a request, not a declaration of what you send; what you actually send is the first line of the display. `(none)` where the invitation declares an empty request: your partner has committed to receiving no column from you, and it is your partner's side that aborts if you send one -- after your values have reached it, since reconciliation follows the payload exchange there too. An absent request is omitted from the display: your partner takes whatever your own metadata discloses.
- **`legal agreement`** (`your partner's word`) -- the reference, the stated purpose, and the date the agreement is valid through, when the invitation attaches one. The reference and the date are byte-compared against your own copy before data moves; the text itself is your partner's, never vetted by psilink.
- **`expires`** (`enforced`) -- the instant past which the invitation is refused, when the token carries one.

Every matching rule is shown here rather than behind a second command: under `psi`, what is matched decides which identifiers are disclosed, so a rule you are consenting to is never hidden. A term the inviting party declares that this version of the exchange does not yet apply -- a count-only algorithm, duplicate matching, or an approximate-match setting -- is marked as proposed, so the display never states behavior the run does not perform. For the two that psilink refuses outright, the count-only algorithm and duplicate matching, the mark says so and names what to ask your partner for instead: an invitation carrying either is aborted before any identifier is revealed, so there is nothing to weigh beyond getting a corrected invitation. A value transform this version does not recognize is marked as unrecognized rather than printed in the same shape as a rule psilink can explain.

### The decision facts, repeated at the prompt

The full outline runs well past a terminal screen, so the facts heading it -- the columns you will send, the inviting party with its unverified-name note, and the PSI algorithm with any note on it -- are printed once more, unchanged, immediately before the prompt, where they are on screen when it asks.

That repetition is deliberately those facts and no others, to stay short: terms that bear on disclosure but would lengthen it -- the linkage strategy and, under single-pass, its disclosure note -- appear only in the outline above. It is not short in every case, since it lists the columns you send one per line: past roughly nineteen disclosed columns the repetition itself runs off a standard terminal, and what scrolls away first is that column list. Read the outline before answering; the repetition is a reminder of what you read, not a substitute for it.

Under `--consent-to-terms` no prompt follows, so the block is printed under a heading that repeats rather than asks. Its contents are identical either way.

### Where the display is shown

The terms display is diagnostic output written at `info` level, so `--log-file` and `--log-level` route it exactly as they route every other diagnostic. Wherever acceptance stops to ask for confirmation, though, the terms are also shown on the terminal it asks on, whatever those options are set to: `--log-file` records them in the file and shows them at the prompt, and `--log-level warn`, `error`, or `silent` keeps them out of the log and still shows them at the prompt. You are never asked to accept terms the run did not put in front of you.

That pairing follows the question rather than the terminal: acceptance without `--consent-to-terms` asks even where nothing can answer -- it reads end-of-file and declines -- and the terms go to standard error alongside the question it asked. `--consent-to-terms` is what keeps them off standard error, by asking nothing. Where that second copy is written -- under `--log-file`, or under a level that drops `info` -- it is plain, without the timestamp and level prefix the log's own copy carries; on the default routing there is no second copy to show, since the log's line already lands on the terminal the prompt asks on.

One limit of the pairing: psilink does not verify that the terminal took what it was sent. If standard error stops accepting output partway through -- a full pipe, or a reader that closed early -- the remaining lines are dropped and the question is still asked, so a prompt that arrives after a truncated display is answered against what you can see rather than the whole surface.

### Accepting without the prompt

`--consent-to-terms` records your consent to this invitation's terms in advance and skips the interactive confirmation, so `accept` can run unattended or in a script -- where there is no terminal, the prompt otherwise reads end-of-file and declines. It bypasses the one human checkpoint before the configuration and linkage key are written from the partner-supplied invitation, so review the terms before using it. It is off by default: without it, `accept` displays the terms and stops to ask you to confirm them. Since nothing asks, there is nothing to show alongside a question: the terms stay diagnostic output on the routing you chose, so `--log-file` captures them for the unattended run's record and `--log-level silent` drops them. It also frees standard input for a `-` `INPUT_FILE` (see the `-` standard-input note under [Configuration](#configuration)).

### Existing files

If `--config-file` is not used and a configuration file already exists at the default path, its linkage terms are compared against the invitation's; any disagreement causes acceptance to fail. The user is shown which values differ and instructed to resolve the conflict before retrying with the same invitation string or to supply an alternative configuration file path.

A reused configuration keeps its connection block and linkage terms, but the record of what you consented to *receive* is refreshed to the invitation you have just accepted, so it never lags behind the disclosure you were shown. When that invitation declares no disclosed columns, the record is removed rather than left at a set this acceptance never showed you, and a warning names the columns it held: dropping it means the next `psilink exchange` accepts whatever columns the partner transmits instead of holding the received payload to a consented set. To keep the check, ask the inviting party for an invitation that declares the columns it sends.

A pre-existing key file is treated differently from a configuration file: it is never reconciled or reused, because silently reusing a stale authentication token must never happen. If `--key-file` is not used and a key file already exists at the default path, acceptance fails outright and the user is told to delete it or supply a different key file path. In this way, accepting an invitation does not cause files to be unwittingly overwritten.

### Checking your input against the terms

If `INPUT_FILE` is provided, its columns are checked against the invitation's terms before you are asked to confirm. The checks are:

- **The input can satisfy no linkage key at all** -- it cannot produce the fields any key requires. Acceptance stops with an error that names the unsatisfied fields and writes no files, rather than provisioning a configuration that could only ever produce an empty result.
- **The input can satisfy only some of the keys** -- a warning names the unsatisfied fields, and the keys that depend on them are inactive for this exchange. Acceptance proceeds: the columns are inspected to infer metadata and data standardizing transformations exactly as they are when every field is satisfiable, and both are written to the configuration file together with the linkage terms. An unsatisfied field simply gets no transformation. To activate its keys later, edit the written configuration to give the field both its metadata and its standardizing transformation -- re-roling the column alone binds it with the identity transformation, whose raw values will not match the partner's standardized ones -- or delete the written configuration and re-accept with corrected data, since a repeat acceptance over an existing configuration reuses it unchanged.
- **A linkage key's own cleaning can never produce a value** -- a `parse_date` whose `input_format` omits a component, so it drops every record regardless of the data. The key is warned about by name even though its columns are present: it passes the column check yet would contribute nothing, so the fix is a corrected invitation from the partner, not a different CSV.
- **The input discloses columns the invitation will not accept** -- the invitation declares the inviting party accepts no payload column *and* is entitled to the matched result, while the input discloses some (the same set the display's `columns you will send` line lists, on an acceptance that reaches that display). A warning names them, one per line, because that disagreement is one the exchange refuses to run on. The two remedies are to set those columns not to transmit in the written configuration (`is_payload: false`, or the `ignored` role), or to ask the partner for an invitation that accepts them. What follows the warning differs by path, and the warning says which:
  - Online acceptance also prepares the exchange before it asks you to confirm, so it meets the refusal itself: the command stops as a configuration error (exit 64) before the terms are displayed and without writing a configuration or key file.
  - Offline acceptance prepares nothing, so it is not stopped: confirming writes the configuration and key file, and the refusal arrives when you run `psilink exchange`.

  An invitation that gives the inviting party no result is not this case: nothing is transmitted to a party not entitled to the result, so there is no disagreement, nothing is warned about, and the `columns you will send` line reads the no-payload sentence instead. The check reads the disclosed set the way the run will -- from the configuration's metadata when one was written, else inferred from the input's columns -- so it cannot warn about a set the exchange would not refuse over.

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

Unlike the [offline invitation](#offline-invitation), the online path does not source its linkage terms from a pre-existing configuration file. A configuration file at the configuration path is reported as a conflict and the command aborts before any token is minted or connection opened; delete it or pass `--config-file` to write elsewhere.

Linkage keys, metadata, and cleaning transformations are therefore inferred from the input file. If the partner accepts the invitation that configuration is saved; otherwise it is discarded because the partner did not accept.

If `--key-file` is not used and a key file exists at the default path, the user is warned about its existence and told to either delete it or specify a different key file in case reusing that secret was not their intention.

## Online acceptance

```sh
psilink accept URL INVITATION INPUT_FILE [OUTPUT_FILE]
```

This command is similar to [offline acceptance](#offline-acceptance), however it coordinates with the other party and executes an exchange. It decodes the invitation string and displays the same terms outline [offline acceptance](#offline-acceptance) prints, leading with the columns this party itself will send to the partner for matched records -- its own outbound disclosure. The user can abort or accept. `--consent-to-terms` skips this confirmation for unattended runs exactly as in [offline acceptance](#offline-acceptance), recording advance consent to the invitation's terms before the configuration and key are written and the handshake is run; it applies only to that consent and does not affect [SFTP host-key trust](#sftp-host-key-trust), which has its own non-interactive setup. It also lets `INPUT_FILE` be `-` to read the CSV from stdin. As in offline acceptance, the input is checked against the invitation's linkage terms before any connection: if it can satisfy no key, the command stops with an error and never connects, so the two parties cannot complete a handshake and run an exchange that yields only an empty result indistinguishable from a legitimate non-match; if it can satisfy some but not all keys, a warning names the unsatisfied fields and the exchange proceeds on the keys that remain. Accepting saves the configuration and newly-generated persistent keys on both sides as soon as the handshake succeeds, before the data exchange begins, so a post-handshake failure can be retried with `psilink exchange` without re-inviting (see [Recurring exchange](#recurring-exchange)); the exchange is then conducted and both applications exit when complete.

When the invitation carries a [connection endpoint](#invitation-strings) naming a split inbound/outbound directory pair (an `sftp`/`filedrop` exchange with separate drop and pickup folders), and you do not pass `--outbound-path`, the acceptor adopts the mirror-swapped directory roles from the endpoint -- where the inviter writes becomes where you read, and vice versa -- together with the retain mode a split exchange requires, so you need not retype the mirrored directories. This is the online counterpart to the same seeding the offline accept performs. The reachable host, port, and credentials still come from your own URL and flags, never from the endpoint, so a bridged topology where you reach the rendezvous differently from the inviter is supported. An explicit `--outbound-path` overrides this entirely: it takes the URL/positional path as your inbound and the flag as your outbound, ignoring the endpoint's pair. A non-split invitation (a single shared path, or no endpoint) leaves the connection exactly as the URL builds it.

If `--config-file` is not used and a configuration file already exists at the default path, its linkage terms are compared against the invitation's exactly as in [Offline acceptance](#existing-files), and its connection block is additionally compared against the connection target -- the URL, any `--server-*`/`--outbound-path` overrides, and any split directories seeded from the endpoint as just described. The connection comparison distinguishes *which* drop you are meeting at from *how* you reach it. A mismatch in the rendezvous location -- the host or the path -- causes acceptance to fail without notifying the inviter: the user is shown which values differ and instructed to delete the file or use the `--config-file` option (see [Configuration](#configuration)), after which the program exits, and the user can retry with the same URL and invitation string once the conflict is addressed. A difference in *how* the same drop is reached -- the protocol/channel (for example a `file://` configuration accepted against an `sftp://` URL, as with a file-sync service), the port, or the credentials -- is not an error: the specified value is used for this exchange and a warning notes that the saved configuration's connection settings are left unchanged, so the user can update the file if the change was meant to persist. Absence of a field from the URL (with no matching override) is never a conflict; the acceptor's own stored value stands.

A pre-existing key file is handled as in [Offline acceptance](#existing-files), with the refusal landing before any connection is opened.

## Recurring exchange

```sh
psilink exchange [--invitation CODE] [--sweep-exchange-files [--force-retain-sweep]] INPUT_FILE [OUTPUT_FILE]
```

The application loads configuration and key files and conducts the exchange without further coordination. The shared secret is rotated after each successful authentication handshake, before the data exchange begins; if the data exchange subsequently fails, both parties already hold the rotated token and can retry without re-inviting. If `OUTPUT_FILE` is given, the results of the exchange are written to that path; otherwise, output is written to `stdout`.

### Provisioning the key file from an invitation

`--invitation CODE` provisions the key file from an invitation code -- the same code `psilink accept` takes -- and then runs the exchange, so a party holding a configuration that carries no secret completes local provisioning and exchanges in one command. It is the offline route for the party that composed the exchange in the web application and downloaded that configuration (see [EXCHANGE_FILE.md](spec/EXCHANGE_FILE.md)); it is also how a re-invited party re-provisions without going back through `accept` (see [Recovery](#recovery)).

`@path` is supported -- `--invitation @code.txt` keeps the code out of shell history. The code is decoded and validated (checksum, schema, expiry) before anything is written, so a malformed or expired code fails with nothing written. A key file already at the key path is an error rather than an overwrite: the secret rotates after the first exchange, so the original code must not resurrect a stale one.

Before any credential, terms, or data are sent, the `INPUT_FILE`'s columns are checked against the configuration's linkage terms, the same satisfiability pre-flight `accept` applies. If the CSV can satisfy no key -- it cannot produce the fields any key requires -- the run stops with a usage error (exit 64) that names the unsatisfied fields, rather than completing an exchange whose empty result is indistinguishable from a legitimate non-match; if it satisfies some but not all keys, a warning names the unsatisfied fields and the exchange proceeds on the keys that remain. This guards a recurring run whose CSV has drifted from the terms the configuration committed to -- a file swapped since setup, or one never checked at an offline accept. The check resolves fields exactly as the exchange does, honoring any explicit metadata or column-standardization in the configuration, so a field an explicit type or remap produces is not flagged.

### Confirming what you send

An exchange you accepted an invitation for has one fact no invitation settles: the columns *you* send to your partner for matched records. The invitation settles what you receive; what you send comes from your own input file, where a column psilink does not recognize as a linkage or identifier column is transmitted by default. So acceptance records the set it showed you, and the exchange holds itself to that record:

- **The set is the one you confirmed** -- the exchange runs, without asking again.
- **The set is not the one you confirmed**, whether it gained a column or lost one -- the run stops before any credential, terms, or data are sent, prints the columns it would send and what changed, and asks you to confirm. A yes records the new set and the exchange proceeds; a no stops the run (exit 64) with nothing sent. A narrower set is asked about no less than a wider one: your partner's consent surface and the [exchange record](spec/EXCHANGE_RECORD.md) state the set you confirmed, so a run that sends a different one is sending a set neither party settled on.
- **Acceptance never resolved the set** -- you accepted without naming an input file, or with one whose columns could not satisfy the linkage terms. The first run that can resolve it shows the columns and asks, exactly as above.

Where there is no terminal to ask on -- an unattended or scheduled run, or one reading its CSV from standard input -- the run refuses instead (exit 64, before any credential, terms, or data are sent), naming the columns and how to confirm them: run it once from a terminal, or accept the invitation again naming your input file. That refusal is the point of the record. An exchange whose partner is entitled to no result is never asked about, because nothing is transmitted to it whatever your file holds; nor is an exchange you *invited* a partner to, whose outbound columns you authored yourself when you minted the invitation.

The `sftp` and `filedrop` channels are currently supported; `webrtc` is not yet available in the CLI. For file-drop exchanges, the `psilink.yaml` configuration uses `channel: filedrop` and `path` in place of `channel: sftp` and `server`:

```yaml
connection:
  channel: filedrop
  path: /mnt/sftp-share/exchanges/agency-a-agency-b
```

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

`SFTP_URL` is an `sftp://host[:port]` address; you supply no username, path, or credential, and none is sent to the server (the probe refuses before authenticating). A non-sftp scheme is a usage error. `--connect-timeout` bounds the connection attempt (e.g. `10s`), enforced as the SSH ready timeout. By default the command prints a human-readable summary; `--json` instead prints one line of machine-readable JSON -- `{"fingerprint":"SHA256:...","key_type":"..."}` -- on stdout for a script to consume. A transport failure (unreachable, refused, or timed out) exits 69; a usage error exits 64. The console's "read the fingerprint from the server" affordance runs this command for the operator.

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
psilink fingerprint [--identity STRING] [--identity-file PATH] [--config-file PATH] [--force] [--export-certificate PATH]
```

Print this party's signing certificate fingerprint, creating the signing identity on first use. That identity is the long-lived keypair and self-signed certificate behind a certificate-backed receipt: a partner pins the printed fingerprint once and every later receipt verifies against it (see [Receipt signing identities](SECURITY_DESIGN.md#receipt-signing-identities)). Share the value out-of-band, the way an SFTP host-key fingerprint is shared.

The identity lives at `~/.psilink/signing-identity.json` by default; `--identity-file` overrides that path, as does `signing.identity_file` in the configuration named by `--config-file`. Creation is announced rather than silent. The identity string bound into the certificate -- the party's name, organization, and contact -- comes from `--identity`, or from `linkage_terms.identity` in the configuration when the flag is absent; once an identity exists, `--identity` is ignored unless `--force` is also given.

`--force` regenerates the identity: a new key with a new fingerprint, which invalidates every fingerprint a partner has already pinned. They must re-pin before your receipts verify again, so treat it as a coordinated action rather than a retry.

`--export-certificate PATH` additionally writes this party's public certificate -- the certificate alone, never the private key -- to `PATH` for sending to a partner. Naming the signing identity file itself is refused rather than allowed to overwrite the private key with the certificate.

## Verifying a receipt

```sh
psilink verify-receipt RECORD [INPUT_FILE] [RESULT_FILE]
```

Read a stored exchange artifact and report what holds up. It is read-only: it never modifies or re-signs an artifact. An exchange produces two, and this command verifies either or both:

- The **exchange record** (`psilink-record-<stamp>.json`), self-attested and unsigned. Verifying it is an internal-consistency check: it says nothing about the partner.
- The **dual-signed record** (`psilink-receipt-<stamp>.json`), written when the exchange ran with `signing.mode: certificate`. This is the evidence against the partner: both parties' signatures and certificates over the terms and the data that flowed.

`RECORD` may be either file -- the command tells them apart by their format `version`, so an auditor handed only the dual-signed record verifies it directly. To check both artifacts of one exchange in a single run, name the exchange record as `RECORD` and pass the dual-signed record to `--signed-record`; that is also what lets the record's agreed-terms hash and party identities anchor the signature checks. The record's verification keys are read from the record path with a `.keys.json` suffix by default, or from `--keys`. An unrecognized `version` on any of these files is rejected with a clear error (exit 64) rather than mis-parsed.

The record holds no matched data -- only salted commitments to it -- so verification **re-supplies** the committed data from your own retained files: pass the `INPUT_FILE` you contributed and the `RESULT_FILE` you kept, and the command reconstructs the committed data and opens every commitment (the sent payload, the received payload, and the record's pairing). Reproduction is byte-exact only from **unmodified** retained files -- a results file re-sorted or re-exported in a spreadsheet will not reproduce -- and a duplicate value in an identifier column is reported as a note. A genuinely empty received cell is a known limitation: it cannot be told apart from a committed null, so a record with one will not reproduce, reported as a commitment mismatch (never silently mis-opened) rather than a note.

With `--config-file` (your exchange config, for your linkage terms) and `--partner-terms` (the partner's terms), it also re-derives the agreed-terms hash. The partner's terms are not retained by default, so this check is optional; without both, the terms hash is reported as not checked. `--config-file` is never auto-loaded -- name it explicitly, since a stray config in the working directory may belong to a different exchange.

Either path is one you named, so a file that is not there is a usage error rather than a run with the terms hash quietly left unchecked. A `--partner-terms` file that defines no `linkage_terms` is refused for the same reason -- supplying the partner's terms is all that flag does. A `--config-file` that defines none is not: the same config is where `signing.partner_fingerprint` and `signing.identity_file` are read from, so one carrying only those is accepted for them, and a note beside the agreed-terms line records that the config supplied no terms. A "not checked" line names what is still missing, so a config you already passed is never the remediation it points you back at.

With neither `INPUT_FILE` nor `RESULT_FILE`, the command still runs -- the third-party-auditor case: it checks the record's structure and version and reports each commitment as not opened (an auditor without your retained data cannot open the commitments, by design), rather than failing.

The verdict distinguishes a commitment that **opened and matches**, one that was **not opened** (its data was not re-supplied), and one that **does not match**, and rolls up to `VERIFIED` (everything checked and passed), `INCOMPLETE` (nothing contradicted, but not everything could be checked), or `VERIFICATION FAILED` (a check did not match). The command exits nonzero (1) only on a definite failure; a failed opening is reported as "the record may have been altered, or a re-supplied input/result/terms does not match this exchange", never asserted as tampering, since the two are indistinguishable. When no dual-signed record was supplied, the output says so rather than implying it checked the partner's signatures.

### Verifying the signed record

For a dual-signed record the command reports, per party, four things: the **receipt signature** against the certificate the record carries, the **certificate identity binding** (its self-signature, which is what ties the displayed identity to the signing key), what **anchors the certificate** outside the record, and the **asserted identity** against the identities this exchange was between. The per-exchange **binder** is printed but not recomputed -- deriving it needs the exchange's session key, which only the two parties held -- so a verifier confirms the signers signed a receipt carrying that binder and nothing more. The verdict rolls up on the same three levels, prefixed `SIGNED RECEIPT`, and a failure exits 1.

The pinned fingerprint comes from `--partner-fingerprint`, or from `signing.partner_fingerprint` in the config named by `--config-file`; the flag wins, so an auditor given a fingerprint out-of-band can verify without a config. A config named for its pin need define nothing else -- only the `signing` fields are read from it -- and a `--config-file` path that does not exist is a usage error rather than a silently unanchored run, so a typo cannot be mistaken for a record you hold no fingerprint for. A value that is not a fingerprint (an unpadded base64url SHA-256 digest, 43 characters) is a usage error too, so a mistyped pin is never reported as a partner mismatch. A pin matching **neither** certificate is a failure -- the record is not the party's you pinned.

#### A verified verdict needs both certificates anchored

The record carries two certificates, and the top-line `SIGNED RECEIPT VERIFIED` speaks for both: it is reached only when something outside the record anchors **each** of them, and it names what anchored each one -- `both certificates are anchored outside the record -- the initiator's by your own signing identity, and the responder's by a fingerprint you pinned out-of-band`.

There are two anchoring sources, and which you use depends on whether you were a party to the exchange:

- **Your own signing identity** anchors your own slot, and you supply no fingerprint for it. The command reads the identity from `--identity-file`, else `signing.identity_file` in `--config-file`, else `~/.psilink/signing-identity.json`, and computes the fingerprint itself -- there is nothing to copy by hand, and nothing you could copy except off the record you are checking. Naming the file with `--identity-file` asserts the record is one you signed, so an identity that matches neither certificate then fails the run; one found without being asked is reported instead and leaves the slot unanchored.
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

To recognize failed rotations, the error messages for exchanges that fail key-exchange authentication instruct users how they can generate and accept new invitation strings, and encourage them to contact their partners out-of-band. Since connection information has already been shared, the recommended commands are `psilink invite URL` followed by `psilink accept URL INVITATION`. The pre-existing `psilink.yaml` configuration file is reused; only the key file needs to be recreated. A party that already holds that configuration and needs only the new secret can instead re-provision offline with [`psilink exchange --invitation`](#provisioning-the-key-file-from-an-invitation), which writes the key file and runs the exchange in one command.

### Token loss

If a key file is lost and no backup is available, reset as in [Out-of-sync tokens](#out-of-sync-tokens): coordinate with the partner out-of-band, both parties delete their existing key files, and the pair re-invites and accepts.

### Token compromise

See [Compromise response](SECURITY_DESIGN.md#compromise-response) for the procedure.

## Logging

Every command that produces diagnostic output - `init`, `invite`, `accept`, `exchange`, the zero-setup form, `fingerprint`, `probe-host-key`, `doctor`, and `verify-receipt` - accepts `--log-level` and `--log-file`.

psilink follows the standard stream convention: a command's result data goes to `stdout`, and all diagnostic output - every log line, `info` and `debug` included, together with the interactive confirmation prompt - goes to `stderr`. This keeps a piped or redirected result clean. `psilink accept URL INVITATION 2>/dev/null > matched.csv` writes only the matched-records CSV to `matched.csv`, with the invitation-terms display, the "wrote key file" line, the runtime banner, and every other diagnostic sent to `stderr`, where the same run without the redirect still shows them on the terminal. The result on `stdout` is an exchange's CSV output (when no `OUTPUT_FILE` positional is given), the invitation token printed by `invite`, the fingerprint value printed by `fingerprint` -- whose action banner, bound identity, `--force` regeneration warning, and out-of-band sharing instructions are diagnostics on `stderr`, so `FP=$(psilink fingerprint)` captures just the value -- and the verification verdict printed by `verify-receipt` (its exit code, nonzero only on a definite failure, carries the same result for scripts).

`--log-level <level>` selects the verbosity: `silent`, `error`, `warn`, `info` (the default), `debug`, or `trace`, matched without regard to case. `silent` suppresses all log output. Any other value is a usage error and exits 64, naming the value you gave, on every command that accepts the flag - a typo never quietly leaves the run at the default. The level governs every diagnostic the run emits once logging is set up, including the low-level warnings from data cleaning and file handling, so `silent` keeps them out of the terminal and out of a `--log-file` alike and `debug`/`trace` turn up the rest of the run's detail - except a usage error in the command line itself (reported on `stderr` before either flag takes effect) and the last-resort line for an error no command handler caught (written straight to `stderr` at exit 1); neither is ever routed to a `--log-file`. It does not suppress the linkage terms `accept` shows when it stops to ask you to confirm them: those accompany the question rather than the log, and reach the terminal whatever this is set to (see [Offline acceptance](#offline-acceptance)).

`--log-file <path>` appends log output to `<path>` instead of writing it to the terminal, so psilink can be run unattended or in automation without shell redirection. The file is opened in append mode, preserving any content from previous runs; each line already carries an ISO-8601 timestamp, so successive runs stay distinguishable without a separate flag. The parent directory must already exist - a missing directory aborts the command with a usage error (exit 64) before any exchange work begins. A log file psilink creates is owner-only (mode `0600`), since at `debug`/`trace` it can record partner identity, linkage keys, and data categories; if you point `--log-file` at a file that already exists, its permissions are left as they are. `--log-level` still applies to the file, so `--log-level silent --log-file run.log` writes nothing. Every diagnostic line is captured, including the low-level warnings from data cleaning and file handling. `psilink doctor`'s check lines are captured too, but as the plain rendering an operator reads rather than as timestamped log records (see [Checking a network file drop](#checking-a-network-file-drop)). Results written to `stdout` (an exchange's CSV output, the fingerprint value) are not log output and are unaffected by `--log-file`.

For unattended runs, set `--peer-timeout` to a value that suits how long you are willing to wait for a partner that never appears (it defaults to one hour); a partner that never appears at all makes the command wait out this budget at the rendezvous and live-exchange steps before exiting. The teardown after a successful exchange does not inherit this budget - it is bounded separately and short - so the long wait only applies while the exchange is still in progress. Wrapping the command in your pipeline's own outer timeout is still recommended as a backstop.

One case does not consume the whole budget: a rendezvous that finds a partner hello already in the folder and never gets an answer behind it fails well inside the timeout, naming the file rather than blaming your partner. That is the shape a previous run killed outright leaves, which is worth setting up against on a schedule - see [Directory exclusivity](EXCHANGE_REFERENCE.md#directory-exclusivity) for the recovery and for why `peer_id` is recommended for unattended runs.

### Machine-readable event stream

`--event-stream` emits a machine-readable event stream for a supervising process (an orchestrator, a job runner, a test harness) that spawns psilink and needs structured progress and outcome events rather than parsed log lines. It is available on every exchange-running command - the zero-setup exchange, `psilink exchange`, and the online `psilink invite`/`accept` - and is off by default; it has no effect on an offline `invite`/`accept`, which runs no exchange.

The stream is newline-delimited JSON on **file descriptor 3**, one event object per line, flushed as it happens: a stage-list event up front, a stage event at each protocol step and a stage-end event with that stage's duration when it completes, a warning event per non-fatal terms-exchange warning, a one-shot metrics summary, and exactly one terminal event - a result on success or a classified error on failure. The metrics event, emitted just before the terminal event, reports the run's operational counters: how many records this party processed, how many times a transport data operation retried, and how many times the connection was re-established. Together with the per-stage durations this lets a supervisor - or an operator debugging a slow or flaky recurring exchange - see where the wall-clock went and how much the transport struggled. The error event names one of four categories (`exchange`, `output`, `security`, `config`), a machine-readable abort reason distinct from the human log line, so a supervisor can tell a security (authentication) failure or a local output-write failure from a retryable transport fault - a distinction the exit code alone cannot make. A run interrupted by a signal exits 130/143 without a terminal event (and so without a metrics event), which together is the interrupt signal.

`stdout` and `stderr` are unchanged by the flag: the CSV result still goes to stdout and every diagnostic still goes to stderr, so the event stream never corrupts either. Wire fd 3 to a pipe when you spawn psilink (for example, in Node, `stdio: ["inherit", "pipe", "pipe", "pipe"]`); if you pass `--event-stream` without wiring fd 3, the command fails fast with a usage error (exit 64) before any exchange work. The full contract - the framing, the per-line schema version, every event's fields, and the category rules - is in [docs/spec/CLI_EVENTS.md](spec/CLI_EVENTS.md).

## Exit codes

Every `psilink` command exits with one of the following codes. The two failure classes 64 and 69 follow the BSD `sysexits` convention.

| Code | Name | Meaning |
| ---- | ---- | ------- |
| 0 | success | The command completed. For an exchange, the run finished and any result was written. |
| 64 | `EX_USAGE` | Invalid caller input or configuration: a bad flag or positional, an unrecognized or repeated option, a missing/malformed config or key file, an unsupported channel, or -- with `--event-stream` -- fd 3 not wired. One mid-run condition also lands here rather than under 69, because its remedy is likewise a local settings change: an SFTP exchange whose cumulative mid-exchange reconnection budget (`max_reconnect_attempts`) is exhausted by a partner server that keeps dropping the held session. A problem the operator fixes locally; retrying unchanged will not help. |
| 69 | `EX_UNAVAILABLE` | A transport or availability failure: the exchange server, peer, or shared storage was unreachable, rejected an operation, or went silent. Retrying once the transport recovers may succeed. From `psilink doctor`, it means something the checks themselves depend on was not available, so nothing was established either way. |
| 78 | `EX_CONFIG` | `psilink doctor` only: the checks ran and something they found needs changing before an exchange will work (see [Checking a network file drop](#checking-a-network-file-drop)). |
| 130 | interrupted (SIGINT) | The run was interrupted by `SIGINT` (Ctrl-C). 128 + 2, the conventional signal exit. |
| 143 | terminated (SIGTERM) | The run was terminated by `SIGTERM`. 128 + 15. |
| 1 | unexpected error | A last-resort code for an error that escaped every command handler; ordinary faults use 64 or 69 above. |

64 and 69 are the classification the command error boundaries apply (a `UsageError` maps to 64, otherwise the error's own exit code or 69); 78 is `psilink doctor`'s verdict code and is set nowhere else; 130 and 143 are set by the exchange's own signal handlers; 1 is the top-level catch-all. When `--event-stream` is active a `security`-category failure exits 69 like any other transport failure -- the exit code cannot single it out, so read the terminal event's category to detect it (see [Machine-readable event stream](#machine-readable-event-stream)).

For `psilink exchange`, a missing, malformed, or unreadable configuration file (`psilink.yaml`) or key file (`.psilink.key`) - including a key file whose stored token is malformed - is a usage error and exits 64. An unsupported channel or URL scheme - a `webrtc` config or `ws://` URL the CLI does not yet support, an unknown scheme, or a malformed `file://` authority - is likewise a usage error and exits 64, as is a URL carrying a malformed percent-escape such as a lone `%` (with any credential redacted from the message) or an invalid connection option or combination (for example a negative, fractional, non-numeric, or above-ceiling `--max-reconnect-attempts`, a non-numeric or out-of-range (outside `0..65535`) `--server-port`, a reserved `peer_id`, or a `retain_files`/`lockless_rendezvous` contradiction). Failures during the exchange itself - connecting to the server, the rendezvous, or the message loop - exit 69. A successful run exits 0; a run terminated by a signal exits 130 (SIGINT) or 143 (SIGTERM).

Passing a single-value option more than once - for example `psilink invite --accept-timeout 60s --accept-timeout 120s`, or a repeated `--log-level`, `--log-file`, `--server-port`, `--peer-timeout`, or `--linkage-strategy` - is a usage error and exits 64, naming the flag (`--<flag> may be given only once`), rather than silently taking one of the values. Count flags (`-v`/`--verbose`) and boolean flags (and their `--no-` forms, such as `--record`/`--no-record`) may still be repeated and keep their accumulate / last-one-wins / negation semantics.

Passing an unrecognized option - a misspelling such as `--server-user` for `--server-username`, or `--retain-file` for `--retain-files` - is a usage error and exits 64, naming the offending option, before any connection is attempted or file is written, on every command. It catches a mistyped credential or path override that would otherwise be dropped silently, leaving the run on the option's default or a stale configuration value. Positional arguments - the server URL, the input and output files, and the invitation string - are validated by each command, not by this check. The `invite`, `accept`, and `init` commands accept a positional that may begin with `-` (an invitation string, or `-` for stdin; see [Invitation strings](#invitation-strings)), so on those commands the unknown-option check rejects only a `--`-prefixed token, which a positional never is, and leaves a single-`-` positional for the command's own validation.

## See also

- [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md) - exchange specification format consumed by the CLI
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md) - authentication model underlying the invitation and recurring exchange flow
- [COMMUNICATION.md](COMMUNICATION.md) - communication channels (WebRTC, SFTP, filedrop) and supporting services
- [DEPLOYMENT.md](DEPLOYMENT.md) - operating the supporting services used by the CLI
- [DESIGN.md](DESIGN.md) - overview of the user journey and command table
