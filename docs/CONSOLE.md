---
title: "psilink Console"
---

# The psilink console

The console is a graphical front end to the containerized `psilink` command-line tool, run on the operator's own machine. One container serves a browser interface on the host's loopback address, and a job API behind it drives the same CLI as a subprocess: an operator authors an exchange, starts it, watches it run, and downloads its result without writing a configuration file or assembling command-line arguments. Intended readers are the IT staff or analysts who conduct an exchange from a single machine.

It is a prototyping tool. The workflow is to author one exchange and run it -- with test data first, then with real data -- and then graduate to the plain CLI plus cron or the Windows Task Scheduler for the recurring production version (see [Graduating to a scheduled run](#graduating-to-a-scheduled-run)). What the console is not: a store of named connections, a scheduler, a manager of several exchanges at once, or a service shared over a network. It holds one exchange at a time, over mounted folders that hold that exchange's configuration, secret, input, and results. Running an exchange again on a schedule from a browser instead is the hosted web application's job (see [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md)).

One operator at one host is what its security rests on. The console has no authentication of its own, so where it is reachable from is decided by how you publish the container's port (see [Reachable only where you publish it](#reachable-only-where-you-publish-it)); the trust invariant that follows from serving a single party, together with what would violate it, is in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#single-party-console-trust-boundary). The operator is the machine's own user, and their own directory layout and credential handling are theirs to choose: where a choice costs them something, the console says so beside the control rather than refusing to run.

This document does not cover the CLI's own commands and configuration files (see [CLI.md](CLI.md)), the field-level meaning of an exchange setting (see [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md)), or the deployment of the services an exchange runs over (see [DEPLOYMENT.md](DEPLOYMENT.md)).

## The image and the console build

The published `vdorie/psi-link` image is the console: it is built with `VITE_DEPLOYMENT_PROFILE=console` so its web assets and its server-side job driver are the console halves, and it runs them with `docker run --rm -p 127.0.0.1:3000:3000 vdorie/psi-link serve` (see [Running the container](#running-the-container)). You do not build web assets yourself, set the profile, or build an image of your own; the image's profile drives which transports run server-side, and the `-fips` variant has the same profile and serves the same two roles. Under `console` the operator's input CSV is read in place from a mounted work-input directory (see [Mounted work-input directory](#mounted-work-input-directory)), and the transport chooser offers to run a shared-directory (`filedrop`) exchange on the console over a mounted rendezvous directory -- and, when the operator authors an SFTP connection in the console (see [Authoring the SFTP connection](#authoring-the-sftp-connection)), to run an SFTP exchange against it; it drops the browser-only file-handling assurance from the UI accordingly. The separate `hosted` web deployment (the continuously deployed `apps/web`, not this image) never offers to run an exchange server-side: a shared-directory or SFTP exchange there only saves an exchange file for the command-line tool, so the operator's file stays in the browser even if the API were reachable.

## Running the container

Pass `serve` as the first argument to run the single-party console instead of the headless CLI (see [Running the CLI](DEPLOYMENT.md#running-the-cli)). The image bakes the `console` web build (see [The image and the console build](#the-image-and-the-console-build)), so no build-time configuration is needed; the Nitro server listens on port 3000. Publish that port to the host loopback so the console is reachable only from the operator's own machine. The simplest console is a single mount and a single environment variable; run it in the foreground and stop it with Ctrl-C when the exchange is done, since nothing needs to persist between exchanges (results stay in the mounted directory):

```sh
docker run --rm -p 127.0.0.1:3000:3000 \
  --env JOB_DATA_ROOT=/data \
  -v /host/work:/data \
  vdorie/psi-link:latest serve
```

The operator drops their input CSVs into `/host/work`, and a shared-directory exchange rendezvouses there too. Splitting those into separate mounts is recommended for the rendezvous directory, because it is partner-synced (see [Mounted work-input directory](#mounted-work-input-directory)):

```sh
docker run --rm \
  -p 127.0.0.1:3000:3000 \
  --env JOB_DATA_ROOT=/data/jobs \
  --env JOB_INPUT_DIR=/data/input \
  --env JOB_RENDEZVOUS_DIR=/data/rendezvous \
  --env JOB_RENDEZVOUS_NAME=agency-a-agency-b \
  -v /host/jobs:/data/jobs \
  -v /host/input:/data/input \
  -v /host/agency-a-agency-b:/data/rendezvous \
  vdorie/psi-link:latest serve
```

`JOB_RENDEZVOUS_NAME` is what a shared-directory invitation tells the partner to look for. The mount point above is named for the container's layout, so without it the invitation and the accept kit would call the shared folder `rendezvous`; name the mount point after the folder instead and it can be left unset.

A deployment whose partner-shared mailbox is two folders (see [Split inbound and outbound rendezvous folders](#split-inbound-and-outbound-rendezvous-folders)) mounts both and names both:

```sh
docker run --rm \
  -p 127.0.0.1:3000:3000 \
  --env JOB_DATA_ROOT=/data/jobs \
  --env JOB_INPUT_DIR=/data/input \
  --env JOB_RENDEZVOUS_DIR=/data/rendezvous-in \
  --env JOB_RENDEZVOUS_OUTBOUND_DIR=/data/rendezvous-out \
  --env JOB_RENDEZVOUS_NAME=agency-b-to-agency-a \
  --env JOB_RENDEZVOUS_OUTBOUND_NAME=agency-a-to-agency-b \
  -v /host/jobs:/data/jobs \
  -v /host/input:/data/input \
  -v /host/from-agency-b:/data/rendezvous-in \
  -v /host/to-agency-b:/data/rendezvous-out \
  vdorie/psi-link:latest serve
```

`JOB_CLI_BINARY` is pre-set in the image and needs no operator value. Setting `JOB_DATA_ROOT` turns the job API on; leave it unset and `serve` runs the web UI and peer-coordination server only. The `-p 127.0.0.1:3000:3000` publish binding is what keeps the unauthenticated API reachable only from the operator's own machine, and what widening it costs is in [Reachable only where you publish it](#reachable-only-where-you-publish-it).

## Reachable only where you publish it

The API has no authentication, so it must reach only the operator's own machine. The app does not inspect its own bind interface; what the API is reachable from is governed by how you publish the container's port and by the host firewall. Publish it to the host loopback -- `-p 127.0.0.1:3000:3000` -- and the unauthenticated API is reachable only from the operator's own machine (see [Running the container](#running-the-container)). This works identically on Linux, macOS, and Windows, Docker Desktop included; an operator who wants LAN exposure publishes without the `127.0.0.1:` prefix, which is their explicit choice.

There is no token, so anything that widens that publish binding widens the unauthenticated API with it. Publishing without the `127.0.0.1:` prefix exposes the API on the host's other interfaces, and fronting the loopback port with a reverse proxy re-exposes it to everyone the proxy admits -- each is a deliberate choice to widen the reachable audience, not a supported console default. Keep the publish binding on host loopback and reach the API only from the host itself. Beyond the publish binding, the app itself requires the browser's `Host` header to name a loopback address (`127.0.0.1`, `localhost`, or `::1`); a request whose `Host` is anything else is refused `403`. This closes browser-delivered DNS rebinding of the loopback API and is why a reverse-proxy or LAN-name front must additionally list its hostname in `JOB_ALLOWED_HOSTS` (see [Turning the job API on](#turning-the-job-api-on)) to work -- the requirement to name that host makes the exposure an explicit choice. The bundled Elastic Beanstalk reference also returns 404 for `/api/jobs` at the proxy, redundant defense-in-depth on top of the app's own hosted-build refusal; leave that denial in place -- the console is not deployed behind that load-balanced front.

## Turning the job API on

The job API is **off by default.** It does nothing -- serves no endpoint, spawns no CLI -- until you configure a data root on the console image. These environment variables configure it:

- `JOB_DATA_ROOT` -- the directory under which each job's working files are created, and the run-time half of the feature gate. On the console image, set it to turn the API on; leave it unset to keep it off. The input and rendezvous directories both default to it, so setting `JOB_DATA_ROOT` alone -- one mounted directory -- lights up the full console. Enabling the API also requires the `console` build profile the published image already has: the hosted `apps/web` deployment can never expose the API, because the app refuses to serve the job routes in a hosted build even if `JOB_DATA_ROOT` is set. This app-layer refusal is the primary guard; the Elastic Beanstalk reference's `/api/jobs` denial (see [Reachable only where you publish it](#reachable-only-where-you-publish-it)) is redundant defense-in-depth.
- `JOB_INPUT_DIR` -- the mounted work-input directory the console lists and profiles for this party's input CSVs; the CLI reads the file you select in place (see [Mounted work-input directory](#mounted-work-input-directory)). Set it to give the inputs their own mount.
- `JOB_RENDEZVOUS_DIR` -- the mounted synced-folder rendezvous directory a shared-directory (`filedrop`) exchange runs over. Set it to a separate mount to keep the partner-synced directory apart from your working files, which is recommended (see [Mounted work-input directory](#mounted-work-input-directory)). On a console that also sets `JOB_RENDEZVOUS_OUTBOUND_DIR` this names the **inbound** folder alone -- the one your partner writes into, and there it is required rather than optional.

  Both of these fall back to `JOB_DATA_ROOT` when unset, so a single mounted directory with only `JOB_DATA_ROOT` set runs a full console. The resolution rule is normative in [SERVER_JOB_API.md](spec/SERVER_JOB_API.md); the choice here is whether one mount or three suits your layout.
- `JOB_RENDEZVOUS_OUTBOUND_DIR` -- an optional second rendezvous mount, the **outbound** folder this party writes its own files into, for a deployment whose partner-shared mailbox is two folders rather than one (see [Split inbound and outbound rendezvous folders](#split-inbound-and-outbound-rendezvous-folders)). Unlike the input and inbound rendezvous directories it has NO `JOB_DATA_ROOT` fallback: the variable being set is the one and only signal that this console rendezvouses over a split pair, so a single-mount console is never silently turned into a split one. A split takes both folders from their own variables, so setting this one while `JOB_RENDEZVOUS_DIR` is unset is refused rather than run: the console reports the missing variable and offers no shared-directory exchange, instead of syncing the data root itself to your partner as the inbound folder.
- `JOB_RENDEZVOUS_NAME` -- an optional name for the shared folder the rendezvous mount stands for, as you and your partner know it: what a shared-directory invitation gives as its advisory locator and what the partner accept kit prints. Leave it unset when the mount point is your own naming -- the console then takes the mount point's last segment. Set it when the mount point is named for the container's layout instead, which is what a launcher does when it binds every operator's folder at a fixed path (see [Running the container](#running-the-container) for an example). A value that is not a plain folder name leaves the console with no name for the folder rather than falling back to the mount point: the invitation still holds a locator, and the accept kit prints no folder name at all.
- `JOB_RENDEZVOUS_OUTBOUND_NAME` -- the same, for the outbound folder of a split rendezvous. Set it whenever the two mounts' last segments would coincide (`/mnt/in/psilink` and `/mnt/out/psilink`): an invitation holds a name per folder and the two must differ, so the console refuses to offer a shared-directory exchange until they do, naming this variable.
- `JOB_SECRETS_DIR` -- an optional, mounted read-only directory the console browses for a connection's credential file (a password file or an SSH private key). Unlike the input and rendezvous directories it has NO `JOB_DATA_ROOT` fallback: the browse surface is never defaulted into the client-writable data root by design. The credential guidance that goes with it is in [Authoring the SFTP connection](#authoring-the-sftp-connection).
- `JOB_SFTP_CREDENTIAL_DIR` -- the container-internal directory a credential pasted into the console is written to. Leave it unset on a console running as the image's own account, which is what the image's default directory belongs to. Set it when you run the container as an account of your own with `--user`, which cannot create that default; see [The user the image runs as](DEPLOYMENT.md#the-user-the-image-runs-as) for the path to give it and what happens if you do not.
- `JOB_ALLOWED_HOSTS` -- an optional, comma-separated list of extra `Host` header hostnames the API accepts, beyond the loopback names (`127.0.0.1`, `localhost`, `::1`) it always accepts. Leave it unset for the default posture, where the API is reached only over host loopback (see [Reachable only where you publish it](#reachable-only-where-you-publish-it)). Set it only when you front the console behind a reverse proxy or reach it by a LAN name -- an unsupported, explicit-choice path -- and list the hostname the browser sends in `Host` (the port is ignored). It is the override for that intentional exposure, not a widening of reach on its own: the publish binding and the host firewall still govern who can connect.

### Mounted work-input directory

The console lists this party's input CSVs out of `JOB_INPUT_DIR`, falling back to `JOB_DATA_ROOT` when that variable is unset -- so a single-folder console, one mount with only `JOB_DATA_ROOT` set, lists inputs out of the data root. It profiles the file the operator selects -- its columns, a bounded per-column sample of values, and per-field coverage -- and the CLI then reads that same file in place when it runs the exchange. The listing is non-recursive: it shows only the files directly in the directory, so mount the directory that holds the CSVs, not a parent, and dot-prefixed files and subdirectories (the per-job working directories) are not shown. No copy is made and nothing is written back to the input directory. Set `JOB_INPUT_DIR` to give the inputs their own mount, which you can mount read-only. The container's own account (see [The user the image runs as](DEPLOYMENT.md#the-user-the-image-runs-as)) cannot write a source directory it does not own, so ownership is the first thing standing between the console and the operator's data; a read-only mount states that intent at the mount as well, rather than leaving it to rest on host ownership alone. The inputs must still be readable by that account.

A shared-directory (`filedrop`) exchange runs over the rendezvous directory at `JOB_RENDEZVOUS_DIR`, which the remote partner writes into over the synced folder; it too falls back to `JOB_DATA_ROOT` when unset, so the single-folder console rendezvouses out of the data root. Setting `JOB_RENDEZVOUS_DIR` to a dedicated mount -- separate from, and not nested with, the working directory that holds your key, input, and results -- is recommended, because the rendezvous directory is partner-writable: a dedicated mount keeps the partner's write access to the rendezvous mailbox and away from your own secrets. The console warns at job start when the rendezvous path overlaps the work-input directory or the data root (as it does in the single-folder layout), but the operator's own directory layout is theirs to choose, so the exchange still runs; a dedicated rendezvous directory is the reliable safeguard, not a requirement.

The console also warns at job start when the rendezvous directory is not empty, naming what it holds. Every shared-directory exchange on this console rendezvouses out of the same mount, and an exchange refuses to start on files an earlier exchange left there -- which a run you asked to keep its files (retain mode) leaves behind after finishing normally, no crash required.

- The warning points you at the console's own recovery for it: turn on "Clear leftover exchange files before starting" in the Diagnostics and recovery section and start the run again -- the sweep runs first, over the exchange's own files, without leaving the GUI. Deleting them on the host before the next launch does the same job.
- A launch that already has that control on is told so instead -- the warning still names what the mount holds, and says the sweep runs first and that your own input and results are not what it sweeps.
- Files that are not part of an exchange -- your input CSVs, your results, the per-job working directories -- are not what the refusal is about, so the warning names them without asking you to remove them, and the launch stays your call.
- It reaches every console surface that watches an exchange run: the flow that mints an invitation, the flow that accepts a partner's, Direct exchange, and the panel that reconnects to an exchange already under way. That enumeration is about which surfaces display a warning, not a promise that every notice arrives whole: the console escapes each warning and caps its displayed length, so a long one -- a notice relayed from the CLI rather than raised by the console itself -- can reach the seat abbreviated.

### Split inbound and outbound rendezvous folders

Some deployments bridge two folders rather than sharing one: this party reads its partner's files out of an **inbound** folder and writes its own into an **outbound** one, and the bridge makes each party's outbound the other's inbound. Set both `JOB_RENDEZVOUS_DIR` (inbound) and `JOB_RENDEZVOUS_OUTBOUND_DIR` (outbound) and every shared-directory exchange the console runs uses that pair, composing the CLI's `inbound_path`/`outbound_path` instead of a single `path` (see [FILE_SYNC.md](spec/FILE_SYNC.md#split-inboundoutbound-directories)).

Five things follow from provisioning the pair, and the console states each where you meet it:

- **Both variables are required.** Set `JOB_RENDEZVOUS_OUTBOUND_DIR` alone -- or mistype `JOB_RENDEZVOUS_DIR` -- and the console refuses to offer a shared-directory exchange and names the missing variable. `JOB_RENDEZVOUS_DIR`'s fallback to `JOB_DATA_ROOT` is for the single-mount console only; it never stands in for the inbound folder of a split, which would hand your partner the folder holding your key, input, and results as the one they write into.
- **It requires retain mode.** A separate outbound folder keeps everything written into it -- nothing is deleted after it is read -- so the console holds the exchange until "Keep every exchange file" is on, and the command-line tool refuses the same pair without `--retain-files`. Both folders must start empty on both sides.
- **The two folders must differ, and neither may sit inside the other.** Either would have the console read its own writes as your partner's. The console refuses to offer a shared-directory exchange while they do, naming the variable to move.
- **Each folder needs a name, and the two names must differ.** The invitation holds a name per folder; where the mount points' last segments coincide, set `JOB_RENDEZVOUS_OUTBOUND_NAME` (and, if you like, `JOB_RENDEZVOUS_NAME`).
- **Your partner runs the mirror image.** Their inbound is your outbound. The accept kit the console downloads with the invitation gives them the two-folder commands; the Windows launcher scripts provision a single shared folder and cannot start a split exchange, so a partner on a network drive needs both folders reachable as ordinary paths (the accept kit says so).

Both folders are partner-synced, so the single mount's guidance applies to both in full: keep them out of the working directory that holds your key, input, and results, and keep a credential file out of either. The console's job-start preflight runs over each folder independently and names which of the two a notice is about.

## Direct exchange: no invitation

Alongside the invitation flows, the console lobby offers a third path, "Direct exchange," for when both parties already agreed on a server out of band: there is no invitation to create or accept. Each operator picks their own input file, the console previews the linkage terms and disclosed columns the CLI expects to infer from it and asks the operator to confirm them (and affirm the trust model below) before running, and the run itself drives the CLI's zero-setup command instead of a saved config -- see [Zero-setup exchange](CLI.md#zero-setup-exchange). Four things follow from having no invitation:

- **The linkage strategy is the one matching term it leaves to you.** Choose `cascade` (the default) or `single-pass` on the confirm step; single-pass shows the same disclosure note the invitation flow shows at the point of choice, and the terms preview beside it shows the choice. You and your partner must choose the same one -- each side reads its terms from its own file, so a mismatch stops the exchange -- and the choice passes into the recurring-run hand-off's command line as `--linkage-strategy`.
- **It runs the SFTP and shared-directory (`filedrop`) channels only**, exactly like the invitation flows.
- **Trust rests entirely on the transport.** It has no shared secret and no application-layer encryption, so the SSH/SFTP connection or the shared directory's own access controls -- and whoever administers them -- are what protect the exchange. That is the same posture the CLI's zero-setup mode has on the command line, in contrast to the shared-secret model an invitation establishes (see [Bootstrapping a shared secret](SECURITY_DESIGN.md#bootstrapping-a-shared-secret)).
- **Each party still writes its own self-attested exchange record** of what it disclosed, exactly as an invitation-driven run does.

The wire-level intent and the argv the server drives the CLI with are specified in [SERVER_JOB_API.md](spec/SERVER_JOB_API.md#the-zero-setup-intent).

## Authoring the SFTP connection

There is no deploy-time provisioner and nothing to pin in advance. Exactly one SFTP connection is effective at a time, authored in the console -- the operator enters the host, username, remote directory, and the required host-key fingerprint, and points the credential at a file, either browsed from a mounted secrets directory (`JOB_SECRETS_DIR`) or given as a file-path reference. A de-emphasized fallback lets them paste the credential value directly when it lives nowhere as a file.

A managed share or an SFTP server with distinct drop and pickup folders is authored with **separate inbound and outbound directories** instead of one shared one: the connection form's directory field becomes the inbound (peer-written) folder and names the outbound (self-written) one beside it. The two must differ, and the split needs retain mode -- the console says so at the point the second directory is named, rather than letting the run fail. This is the console's form of the command line's `--outbound-path`, and a graduated `psilink.yaml` contains the same `inbound_path`/`outbound_path` pair.

The credential signs in one of two ways, and each has a companion setting beside it. A private key takes an optional passphrase reference, for a key that is encrypted. A password takes an optional toggle for answering the server's login prompts with it -- the console's form of `--server-keyboard-interactive`, for a server that refuses the direct password method but asks for the same password as a prompt. Each companion belongs to its own sign-in method: one set against the other is refused at the form, naming the control to change, rather than dropped on the way to the run.

A file reference is the preferred path and never puts a secret through the web server: it is resolved only by the CLI child at exchange time. Referencing a credential file inside the one mounted `JOB_DATA_ROOT` folder is allowed and raises only a non-blocking warning, since that folder is written during the exchange and, if you sync it with your partner, could expose the credential. For isolation, mount a separate read-only `JOB_SECRETS_DIR` and reference the credential there instead -- recommended hardening, not a requirement. An encrypted private key's passphrase file works in a single mount the same way. A pasted value does cross the console's loopback API and is written to a file so the exchange can use it -- but never to the data root or the partner-synced rendezvous directory; it goes to an internal, owner-only location that is wiped at every startup, and it is deleted when the connection is cleared or the exchange is deleted.

The host-key fingerprint is always a literal pin -- the console never prompts to trust a host key (stage a rotation by listing the old and new fingerprints together). An authored connection is held in memory, scoped to the single exchange, and forgotten on restart or when the exchange is deleted. The console runs one exchange at a time, and the container needs network egress and DNS to the server's host and port -- shared-directory exchanges need none. Confining that egress to the one endpoint, so a compromised container process cannot reach anything else, is in [Restricting the container's outbound network access](DEPLOYMENT.md#restricting-the-containers-outbound-network-access). The in-app authoring request and each validation rule are in [SERVER_JOB_API.md](spec/SERVER_JOB_API.md#authoring-the-sftp-connection).

## Choosing how the exchange handles its files

Every console flow that runs an SFTP or shared-directory exchange offers a "How files are handled" section, collapsed by default because its defaults suit a first run. It holds the same file-handling settings the CLI exposes as flags:

- **Keep every exchange file** (retain mode) leaves the exchange's files in place as a permanent transcript instead of deleting each one once it has been read. The transcript persists in the exchange's shared directory rather than in the console's own storage: on SFTP that is the remote directory on the server, which you may not administer; on a shared directory it is the synced folder itself, of which your partner keeps a copy. Nothing removes it once the exchange finishes, so clearing it is a deliberate step there. Turning it on also turns on timestamped filenames and the lockless rendezvous, which it requires -- the same implication `--retain-files` has at the command line.
- **Timestamped filenames** and **lockless rendezvous** can each be set on their own, for a shared folder kept in step by a sync tool that cannot create a file exclusively or pass a deletion on promptly.
- **A name for this side** labels every file this party writes; the two sides must choose different names, and it needs timestamped filenames.
- **If an unrecognised file appears** chooses what to do when a file that is not part of the exchange turns up in the shared directory mid-run. It is a configuration-only setting with no CLI flag, so it is offered on the invitation flows (which compose a `psilink.yaml`) and not on Direct exchange (whose whole configuration is the command line).

Retain mode and the lockless rendezvous are agreements, not negotiations: your partner must set the same three settings on their side, and you must both start from an empty shared directory. A mismatch is only discovered when the two sides meet, and the exchange then stops with an error -- so the console states this the moment you turn retain mode on, and blocks a combination the exchange would reject rather than letting the run fail. The settings themselves are described in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md) and their flags in [CLI.md](CLI.md).

## Tuning the connection

Beside the file-handling section, a "Connection tuning" section holds the same connection settings the CLI exposes as flags, also collapsed by default. Leave a field blank to take the default, which the field shows as its placeholder.

- **How often to check for your partner's files** is the poll interval. Checking less often is gentler on the server; checking more often finds your partner's files sooner.
- **How long to wait for your partner** and **how long to wait for each connection attempt** are the peer and connect timeouts. The connect timeout applies to each attempt, not to all of them together. Neither may exceed seven days, the longest wait the command line itself accepts.
- **How many times to retry a failed connection** is the reconnect budget. Raise it for a link that drops often.
- **Open a new connection for each check** is offered on SFTP only, and connects afresh for each check instead of holding one connection for the whole exchange. Use it when the server limits how long a connection may stay open and the exchange spans long waits. Unlike retain mode, it is this side's choice alone -- your partner neither sees it nor has to match it.

Two of these draw a notice rather than a block, because both are legitimate against a server you control and the command line allows both: checking more often than once a second can trip an SFTP server's anti-flood protection, and opening a new connection for each check pays a full SSH handshake every cycle, which is wasteful at an interval below a minute. The console says so while you can still change it, instead of after the run. These settings pass into the recurring-run hand-off exactly as the file-handling ones do, so a run tuned for a slow partner graduates to a scheduled run tuned the same way. Their flags are in [CLI.md](CLI.md), and the reasoning behind the SFTP session mode in [connection-per-poll-sftp.md](notes/connection-per-poll-sftp.md).

## Diagnosing a run that misbehaves

A third collapsed section, "Diagnostics and recovery", holds the two things you would otherwise leave the console for. Both apply to the run you are about to start and to nothing else; neither is remembered for the next one.

- **Record a detailed log of this run** runs the exchange at the CLI's most detailed logging level and keeps the log with that run's files on the console, offered as a download on the run screen -- beside a completed run's results, beside a failure, and on the panel that reconnects to a run already under way, which is where a run that stalled is usually met. Leave it off for an ordinary run. The log can name your partner, the linkage keys in play, and the columns involved, so treat a copy you download like the results themselves; it is removed with the rest of the run's files when you discard the run.
- **Clear leftover exchange files before starting** is the console's form of the command line's `--sweep-exchange-files`: before the run meets your partner, it deletes the exchange's own leftovers -- the hellos, locks, acknowledgements, and messages a crashed or mismatched run left behind -- and leaves everything else in the folder alone. The console does not decide what counts as one of those files; the same CLI that runs the exchange does. Because a sweep during a live exchange destroys that exchange, the console asks you to confirm no other session is using the directory before it will run one.

A directory holding a **retain-mode transcript** -- yours, or your partner's -- refuses the sweep, because those files may be somebody's audit record. The console says so beside the confirmation, before you start the run, and names the escalation that exists on the command line (`--sweep-exchange-files --force-retain-sweep`, which deletes the transcript permanently) instead of providing a one-click version. A run the guard stops fails like any other run, and the console's alert does not repeat the CLI's own wording -- which is why the condition is stated before you start; a run you asked to record a detailed log has the CLI's reason in that log.

## Signing a receipt, and noting where the result is filed

A fourth collapsed section, "Receipts and record keeping", holds the two audit settings the CLI exposes as `psilink.yaml` keys. Every exchange already writes an unsigned record of what it did, for your own files; both settings here are about what goes beyond that.

- **What this exchange produces** chooses the receipt. Leave it at "No receipt" for a first run. Choosing a **signed receipt** has both parties sign the same terms and data-flow facts and swap signatures, so a third party can later check the exchange happened on those terms without either of you vouching for it -- the `signing.mode: certificate` of the command line. The **session-derived** option is shown but not selectable: no code path produces such a receipt yet, and an exchange asking for one is refused before it runs rather than left to finish unsigned.
- A signed receipt is written as `receipt.json` with that run's files in the mounted folder, and offered as a download on the run screen -- beside a completed run's results, beside a failure, and on the panel that reconnects to a run already under way. It is offered beside a failure because the receipt is written when the two sides sign, before the run's own writes: an exchange that completed and then failed to write its result file still has one, and it is then the only artifact a third party can check. A run that asked for a receipt and produced none says so there rather than showing nothing. Discarding the run removes the receipt with the rest of its files, so keep a copy of your own if you mean to keep it.
- Under a signed receipt, **your fingerprint** is created on demand and shown for you to share. The console runs the same `psilink fingerprint` the command line does, which creates your signing identity the first time and shows the same value every time after. Your partner pins that value, and you pin theirs in **your partner's fingerprint** -- send and receive it over a channel you trust, not the same message as the invitation.
  - A signed exchange will not start without it. Such a run could not finish, and it would fail late rather than early: it goes all the way to the point where the two sides sign -- your data has already gone to your partner by then -- and stops there, because nothing is on file to check the certificate they present against, leaving you no results and no receipt.
  - What you are left with is the exchange record of the disclosure that had already happened, written as `record.json` with that run's files in the mounted folder and offered on the run screen as a download once the run stops. Take it before you go on: trying again, starting over, or discarding the run removes it.
  - The verification keys are offered beside it, but a run that stops this way writes no result file, and opening one of the record's commitments takes that file -- so the pair is your accounting entry, not something you can open.
  - Which side sends its signature first is decided when the two sides meet, so on a run where yours sends first your partner would already have your signed receipt.
  - Authoring is untouched, so you can set the mode, ask for your own fingerprint, and send it while you wait for theirs; to exchange in the meantime, choose "No receipt" and switch to a signed receipt once their fingerprint arrives.
- **Also write out my public certificate** additionally saves your certificate -- the public half only, never your private key -- into the mounted folder, for an auditor who wants to check a receipt without either party's help.
- **A retention note** is filed with your own exchange record and nothing else: never sent to your partner, never checked against theirs, never part of the agreed terms. Write where this result is filed and how long it is kept; never a name, an identifier, or any value from the data. It is the command line's `retention_disposition`.

Your signing identity is written into the folder you mounted, beside the exchange's other files, because it has to outlive the run and be a file you still have afterwards. Treat that folder like the results themselves: readable only by you, and not on shared storage. The identity is long-lived on purpose -- the same key signs every exchange with every partner, which is what lets a fingerprint stay pinned -- so the console offers no way to replace it. Replacing it is `psilink fingerprint --force` at the command line, and the new key has a new fingerprint every partner who pinned the old one must be sent before their verification works again. The signing keys and the receipt format are described in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#receipt-signing-identities) and the configuration keys in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#signing).

**Do not sign a shared-directory exchange out of a single mount.** The rendezvous directory falls back to `JOB_DATA_ROOT` when `JOB_RENDEZVOUS_DIR` is unset (see [Mounted work-input directory](#mounted-work-input-directory)), so on a one-mount console a shared-directory exchange syncs the same folder the signing identity is written into -- putting this party's long-lived P-256 private key in a folder the partner writes into.

- Its disclosure lets whoever holds it forge receipts under this party's identity for every exchange, with every partner, not only the one the folder is shared for.
- Give the rendezvous a mount of its own before signing there: set `JOB_RENDEZVOUS_DIR` to a dedicated directory, separate from and not nested with the working directory that holds your key, input, and results. That is the same split that section recommends for the partner-writable mount generally; signing is where skipping it costs the most.
- The console says the same thing beside the signing control and still runs the exchange -- the directory layout is the operator's own -- so the separate mount is the safeguard, not a gate.
- It says it on this layout only: where the rendezvous has a mount of its own the console withholds that warning, while the shorter word about looking after the key file stays on every layout. It decides that from the mount paths, the real paths symlinks resolve them to, and the folder identity that catches one host folder bound in twice -- so a layout it cannot see through, such as the working directory bound in again underneath the rendezvous folder, looks separate to it.
- The separate mount is what removes the collision, not the missing warning.

## Graduating to a scheduled run

The console is a prototyping tool: once an exchange works, the recurring production version graduates to the plain CLI plus cron or the Windows Task Scheduler. The console shows a recurring-run hand-off -- the portable `psilink.yaml` (or the zero-setup command), a cron and a Task Scheduler example, and the caveats -- filling in the portable settings that transferred from the run while showing the machine-specific paths as placeholders the operator sets on the scheduling machine. What that machine then needs -- the working directory a scheduled job starts in, where the configuration and key file live, the key file's permissions and custody, the cadence its expiry bounds, and what an unattended run refuses rather than asking -- is in [Scheduling the run](CLI.md#scheduling-the-run).

- **Everything you authored transfers over.** The file-handling and connection-tuning settings, the receipt and retention ones, and Direct exchange's linkage strategy all reach the hand-off, so a run that kept its files graduates to a scheduled run that keeps them too and the scheduled exchange is the one you prototyped.
- **It is ready before the run is.** It is composed the moment the exchange starts and is available from then on, collapsed while the run is in flight and expanded once it completes, so the operator can set the schedule up in parallel rather than only afterwards.
- **It never displays the shared secret or a container-internal path.** For an invitation run it points at the on-disk `.psilink.key` to copy, and for one that signed a receipt at the signing identity in the mounted folder -- copy that file to the scheduling machine rather than making a new one there, since a new one has a new fingerprint your partner has not pinned.
- **The scheduled configuration names no receipt file**, so each run writes its own timestamped receipt into the folder it runs in and the schedule accumulates a trail instead of overwriting one file.

The endpoint contract is in [SERVER_JOB_API.md](spec/SERVER_JOB_API.md#the-recurring-run-hand-off) and the command-line reference in [CLI.md](CLI.md#recurring-exchange).

## Sending the partner an accept kit

An SFTP or shared-directory exchange puts the partner on the command line, so the console offers a second artifact at invitation-mint time: a printable, plaintext instruction sheet to send alongside the invitation. It assumes the partner has Docker -- Desktop or Engine -- or can get it, and nothing else, and takes them to the point of accepting -- naming the channel, the rendezvous the invitation names, the `docker run ... accept` and `exchange` commands, and, on a shared directory, routing a partner whose folder is a Windows network drive or DFS path to the release launchers instead (Docker cannot see a drive letter).

- An exchange minted with retain mode on adds a fixed disclosure of what it leaves behind and where those files persist on that channel, so the partner learns it before they join rather than afterwards, and the commands the sheet prints already include the setting -- on the launcher route, which never runs those commands, it points the partner at the console's file-handling control instead.
- The lockless rendezvous travels the same two routes when the exchange runs it without retain mode, since it too is an agreement the partner's side must match.
- It does not restate the linkage terms: accepting displays those and asks the partner to confirm them, which is where that disclosure belongs.
- The sheet contains no secret and no invitation token -- the partner pastes their own copy of the invitation over a placeholder -- so it can travel any way that suits them, including on paper.
- A WebRTC exchange gets no kit: that partner accepts in their browser by opening the link.

Its full contents and invariants are in [SERVER_JOB_API.md](spec/SERVER_JOB_API.md#the-partner-accept-kit).

## Restarting cancels and forgets the exchange

Job state is memory-only, so restarting the server cancels an exchange still running -- rerun it, since the exchange protocol cannot resume mid-run -- and forgets it entirely: the restarted server no longer reports its status or serves its files. The exchange's directory stays on disk under `JOB_DATA_ROOT` until you delete it through the API or remove it by hand; nothing is auto-deleted. Within one server lifetime, though, the console re-attaches: reloading or reopening the console from the same browser finds an exchange still running and picks it back up, and discarding it in the console is what removes its files. Leaving the page does not stop the exchange -- only discarding it does.

The endpoint contract, the request schema, the working-directory layout and file permissions, and the exact gate and startup rules are specified in [SERVER_JOB_API.md](spec/SERVER_JOB_API.md).

## See also

- [CLI.md](CLI.md) - the command-line tool the console drives, and the reference for a run that has graduated to a schedule
- [DEPLOYMENT.md](DEPLOYMENT.md) - the container image, the account it runs as, and restricting the container's outbound network access
- [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md) - the field-level meaning of every setting the console composes into a configuration
- [SERVER_JOB_API.md](spec/SERVER_JOB_API.md) - the endpoint contract, request schema, working-directory layout, and gate and startup rules behind the console
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md#single-party-console-trust-boundary) - the single-party trust invariant the console rests on
