---
title: "PSI-Link Deployment"
---

# PSI-Link deployment

This document covers the deployment and operation of the supporting services required to run PSI-Link exchanges, including reference configurations for each service type and Docker deployment of the CLI. It does not cover the communication protocol those services support (see [COMMUNICATION.md](COMMUNICATION.md)) or the CLI commands used against them (see [CLI.md](CLI.md)). Running the same image as the operator's local console is its own document (see [CONSOLE.md](CONSOLE.md)). Intended readers are system administrators and IT staff.

## STUN/TURN

PSI-Link does not bundle a STUN or TURN server. A deployment needing NAT traversal for WebRTC either points at a commercial ICE-credential service (Twilio Network Traversal Service and equivalents return time-limited credentials on demand; see [COMMUNICATION.md#stunturn](COMMUNICATION.md#stunturn)) or operates a relay of its own.

For the self-hosted case, [`infra/relay/`](../infra/relay/README.md) is a reference deployment of coturn on a dedicated instance: a digest-pinned image, a hardened configuration, the unit that supervises it, ACME certificate renewal, a per-exchange credential helper, and a verification script. Its README is the operational document -- what to launch, what to open, and the order of operations -- and its [Provenance](../infra/relay/README.md#provenance) section states how far the reference has been driven and what remains undriven. Treat it as a starting point to verify in your own environment rather than a validated configuration.

A relay forwards the encrypted WebRTC channel without terminating it, so it sees addresses, timing, and volume and no exchange data. That holds whether the relay is yours or a vendor's, which is why a commercial service is an acceptable option; see [SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security).

## WebSocket-to-TCP proxy

A WebSocket-to-TCP proxy is required only when a browser-based party needs to reach an SFTP server, because browser runtimes cannot open raw TCP connections (see [COMMUNICATION.md#websocket-to-tcp-proxy](COMMUNICATION.md#websocket-to-tcp-proxy)). The CLI does not need this proxy. No reference configuration is provided in this release; deployment guidance is targeted for the 1.1 release (see [ROADMAP.md](ROADMAP.md)).

## Peer coordination server

The web application bundles a PeerJS-compatible peer-coordination server, served under its own `/api/` route, so deploying the web application is sufficient to obtain a coordination server for parties that use it. The public PeerJS service (`api.peerjs.com`) is also usable for evaluation but routes connection-establishment metadata through a third party.

Deploying a standalone peer-coordination server -- for example, as a serverless WebSocket function on AWS Lambda or Cloudflare Workers -- is not currently supported by configuration in the web application and is targeted for the 1.1 release (see [ROADMAP.md](ROADMAP.md)).

### Hardening the signaling surface

The bundled coordination server is untrusted by design: the rendezvous ids are derived from the out-of-band invitation secret and the two browsers run an authenticated key exchange directly between themselves, so the server only relays opaque setup messages and never sees exchange data (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security)). The residual exposure on its WebSocket upgrade surface is therefore resource exhaustion and nuisance, not access to any party's data. The application enforces several defense-in-depth guards itself, unconditionally and regardless of deployment:

- A slow, partial, or idle upgrade handshake (a "slowloris" that dribbles, stalls, or connects and then sends nothing at all) is bounded by connection-level timeouts and closed server-side rather than held open. These bounds cover the window before a request has wholly arrived; bounding the connection past that point is the deployment's, below.
- Each signaling message is size-capped, so an unauthenticated peer cannot send an oversized frame.
- A client that registers but never proves it is a live peer (it sends no heartbeat) is reaped within seconds, well before the liveness timeout that governs an established peer, so an abandoned or junk registration cannot squat a slot; a real peer, which heartbeats within seconds of connecting, is never cut short.
- A registered client holds one connection at a time. A peer that connects again under credentials it has already registered attaches to that registration rather than taking a second one, and the connection it displaces is closed rather than left held.
- The relay's hold-for-reconnect message queues are bounded in count and depth, so a client cannot drive unbounded memory by addressing messages to many made-up recipients.

The constant values and rationale for these guards are in [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#web-signaling-surface-bounds).

Three further protections depend on the deployment and are the reverse proxy's responsibility, because only the proxy sees the real client origin and address, and only the proxy stands between a slow reader and the application:

- **Response-drain limits.** A client that asks for a response and then stops reading it holds the connection, and the bytes queued for it, for as long as it likes. The application does not bound that: its connection timeouts cover the window before a request has arrived, and cutting a connection by how fast it drains would cut a legitimate slow reader, a slow handler, or a long-lived event stream along with it. A reverse proxy is where that bound belongs -- it reads the response from the application and buffers it, so the application's connection is released at the proxy's pace rather than the client's, and the proxy's own send and read timeouts close a client that has stopped reading. Confirm those timeouts and response buffering are on before exposing a deployment publicly.
- **Origin / cross-site enforcement.** The application does not restrict the WebSocket upgrade by Origin, because it is not configured with its public origin -- the value it could otherwise derive is its internal bind address, which does not match the browser's public origin, so enforcing it would reject legitimate clients. A cross-site connection to the signaling server gains nothing an unauthenticated script does not already have (it cannot target or read any exchange -- the authenticated handshake protects that), but an operator who wants to restrict the upgrade by Origin should do so at the reverse proxy, which knows the public origin.
- **Per-address rate limiting.** Bounding how many connections or registrations a single client address may open belongs at the proxy or hosting layer, which sees the real client address. Behind a proxy the application sees only the proxy's address, so an in-application per-address cap would either do nothing or throttle all clients together. The in-application reaper above clears a fire-and-forget flood (sockets that register and go silent), but a flood that keeps each socket alive with heartbeats is indistinguishable from real peers in the application; the only in-application ceiling on it is the global registered-client cap, which is shared across all clients, so without a proxy such a flood degrades to global connection exhaustion rather than per-address throttling.

A deployment that exposes the web application directly, with no reverse proxy, gets the unconditional in-application guards above but none of these three: an unread response pins a connection for as long as the client holds it, and there is neither Origin enforcement nor per-address rate limiting. Run the coordination server behind a reverse proxy for those.

The Origin and rate-limiting controls scope to the `/api/peerjs` upgrade path; a drain limit is a property of how the proxy handles a connection rather than of that path, so it is configured with the proxy's own timeout and buffering settings. The following nginx reference shows where each of the two scoped controls goes; the rate and connection limits are illustrative starting points to tune to your load, not recommended values:

```nginx
# http{} context: per-client-address shared-memory zones.
limit_req_zone  $binary_remote_addr  zone=psilink_sig_req:10m   rate=10r/s;
limit_conn_zone $binary_remote_addr  zone=psilink_sig_conn:10m;

# Optional Origin allowlist (a browser always sends Origin on a WS upgrade).
map $http_origin $psilink_origin_ok {
    default                        0;
    "https://psilink.example.org"  1;   # replace with your public origin(s)
}

# server{} context: scope the controls to the signaling upgrade location. The `^~`
# prefix makes this match win over the catch-all `location /` and stops a later
# regex location from taking precedence and silently dropping these limits.
location ^~ /api/peerjs {
    if ($psilink_origin_ok = 0) { return 403; }   # remove to skip Origin checks

    limit_req   zone=psilink_sig_req burst=20 nodelay;   # new-connection rate per address
    limit_conn  psilink_sig_conn 32;                     # concurrent connections per address

    proxy_pass          http://psilink_app;              # your upstream
    proxy_http_version  1.1;
    proxy_set_header    Upgrade    $http_upgrade;
    proxy_set_header    Connection "upgrade";
    proxy_set_header    Host       $host;
}
```

The bundled AWS Elastic Beanstalk reference under `apps/web/deploy/aws_eb/` applies the per-address `limit_req`/`limit_conn` on `/api/peerjs` by default -- with the illustrative numbers above, to tune to your load -- and ships the Origin allowlist as a commented-out template you enable by uncommenting the `map` and its matching `if` and setting your public origin (it cannot ship active, because the map defaults to deny and would otherwise reject every client). On a load-balanced environment nginx sees the load balancer's address rather than the client's, so the per-address limits need the real client address recovered from `X-Forwarded-For` to throttle per client instead of collapsing onto one bucket; the reference ships a commented `real_ip` template you scope to the load balancer's subnet(s) -- not the whole VPC, which would let any host in it forge `X-Forwarded-For` -- for that. Confirm the limits suit your load, recover the real client address if you run load-balanced, and enable Origin enforcement if you want it, before exposing a deployment publicly.

#### TLS posture of the bundled reference

The same reference curates the TLS posture of the terminator it ships. The reasoning behind each choice is carried inline in `apps/web/deploy/aws_eb/.platform/nginx/conf.d/https.conf`'s own comments; what an operator has to decide is below.

- **Cipher list -- active.** On top of the TLS 1.2+ floor, an explicit forward-secrecy, AEAD-only `ssl_ciphers` list (ECDHE with AES-GCM / ChaCha20-Poly1305) constrains the TLS 1.2 handshake; TLS 1.3 selects from its own AEAD suites. The floor refuses pre-2014 clients with no ECDHE-AEAD suite (Internet Explorer 11 on Windows 7, Android 4.x, Java 7). If you must serve such a population, widen the list deliberately rather than leaving it at this default.
- **Session resumption disabled -- active.** `ssl_session_tickets off` with `ssl_session_cache off`, so every session is a full ECDHE handshake and no resumed session can undercut that forward secrecy. The cost is the resumption round-trip saving, negligible for this low-volume two-party coordination surface. Re-enabling it takes on a rotated, cross-instance-shared `ssl_session_ticket_key` file, which is itself the long-term secret disabling tickets removed, now on disk: keep it owner-only, distribute it only over a secured channel, and rotate it, or the exposure is back.
- **Curve list pinned -- active.** `ssl_ecdh_curve X25519:prime256v1`. Every connection runs a full ECDHE key agreement, so the curve list is pinned explicitly rather than left to the platform default. Unlike the cipher list it applies to both the TLS 1.2 key agreement and the TLS 1.3 key-share. No operator edit is needed.
- **HSTS -- commented opt-in.** It ships inactive because the reference is commonly run with a test or self-signed certificate, and an active `Strict-Transport-Security` header pins HTTPS in the browser: a pinned host cannot be reached over plain HTTP to recover, and a bad certificate can no longer be click-through-accepted. For a production deployment with a valid certificate, uncomment the header, start from a short `max-age` and raise it once verified, and leave `preload` off unless you have deliberately committed the host to the browser preload list (a one-way step). HSTS is honored only on an HTTPS response, so configure the plain-HTTP redirect at the Elastic Beanstalk load balancer (an ALB HTTP listener that 301s to HTTPS) rather than adding a `:80` server to this nginx config, which would conflict with the platform's own default `:80` server.
- **OCSP stapling -- commented opt-in.** It cannot work on a self-signed certificate, which has no CA-published responder to query, and it further needs infrastructure this config cannot assume: a `resolver` to reach the responder's hostname, and an `ssl_trusted_certificate` issuer chain for `ssl_stapling_verify`. The template carries those directives commented with inline notes on each. Stapling is best-effort, so a misconfiguration serves an unstapled handshake with a logged warning rather than failing to start; after enabling it, confirm it actually staples with `openssl s_client -status` rather than assuming it took.

The forward secrecy above is a property of the TLS hop to this terminator; the PSI exchange's own end-to-end protections do not depend on it.

## Diagnosing web connection failures

By default the web client logs PeerJS connection activity at errors-only, so a normal exchange prints no connection-diagnostic detail to the browser console. This is deliberate: PeerJS's warning-level logs interpolate the remote peer id, and a web exchange's peer ids are rendezvous addresses derived from the invitation secret, which the app keeps out of its logs (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security)).

To diagnose a failing rendezvous or connect against a deployed client without a redeploy, a tester or support engineer can raise that verbosity for a single browser, from the devtools console:

```js
localStorage.setItem("psilink:diagnostics", "1");  // then reload the page
```

With the flag set, the client raises PeerJS to its most verbose level, so the connection-establishment and protocol-anomaly detail that is otherwise suppressed prints to the console. The same flag also re-enables the app's own diagnostic console sinks that a production build suppresses -- the raw exchange-failure `Error` object, with its expandable stack and cause chain, and the acceptor's dial target -- so a failing exchange logs its full structured error for triage. Clear it to return to the errors-only default:

```js
localStorage.removeItem("psilink:diagnostics");     // then reload the page
```

The flag is read once per page load, so set or clear it and then reload. It is scoped to the one browser that sets it (it is not shared with the partner and does not travel in the invitation link), and it persists across reloads until cleared. A development build (`npm run dev`) is in this diagnostic mode by default.

The derived rendezvous peer ids are redacted out of the PeerJS console output before printing, so a verbose capture carries no rendezvous id even with the flag on. It is not, however, unconditionally safe to share: at this level PeerJS also logs connection-establishment detail -- SDP and ICE candidates -- which includes the local machine's private/LAN IP addresses and network topology. Treat a verbose capture as a diagnostic containing network internals: share it only with trusted support, and review it first if your network layout is sensitive. The same caution covers the whole capture, not only the PeerJS lines: the app's own exchange-failure errors the flag re-enables carry the partner's signaling host/port and transport-error text -- the same network-internals class, not invitation secrets, session keys, or record data, which never reach these logs.

## Console

The web application also runs as the **console**: a single-party graphical front end that drives that party's own `psilink` exchange from a container on the operator's own machine, so an operator creates, watches, and downloads the result of an exchange without invoking the CLI by hand. Turning its job API on, the environment variables and mounts it takes, where to publish its port, and what an operator can author in it are in [CONSOLE.md](CONSOLE.md).

## SFTP server

PSI-Link does not include or require any particular SFTP server. In practice almost all deployments reuse an existing service: `sshd` on a standard Linux host, with a per-exchange directory whose Unix permissions restrict access to the two partner accounts, is sufficient. The two parties should agree out-of-band on the directory path and on which accounts have access.

No feature of the server is required beyond ordinary SFTP. What an exchange does need is that nothing else edits the directory it runs in: PSI-Link treats the shared directory as the whole of the exchange's state -- the set of filenames present in it *is* the protocol state (see [FILE_SYNC.md](spec/FILE_SYNC.md#core-principle-the-directory-is-the-state-machine)) -- so a server-side rule that moves, renames, rewrites, quarantines, or deletes a file there is rewriting that state behind both parties' backs. A failed exchange against a commercial or managed SFTP service is more often a server-side setting of this kind than a fault in the exchange, and it reaches the operator as an unexplained stall rather than as a message naming the cause. Work through the checklist below before the first exchange against a server you do not administer yourself, and give the partner's administrator the same list.

### Rendezvous directory checklist

Ordered by what they cost deployments, most damaging first.

1. **No upload-triggered automation on the directory.** Any Event Rule, Monitor, Trigger, or scheduled Task that acts on a newly uploaded file -- moving it to an archive or processing folder, renaming it, or quarantining it -- breaks the exchange, and it is the most common configuration-dependent failure. PSI-Link publishes every file whose contents the partner reads by writing a `temp-<uuid>.tmp` first and renaming it to the final name, so a partner never reads a partial file under the name it is waiting for. An automation that grabs the temporary file races that rename; one that grabs the final file removes the message the partner is polling for. The result is either a failed publish that ends the run or a partner waiting on a file that is no longer there until its peer timeout expires. Rules that only notify -- an email, a log entry, a webhook -- are harmless; it is moving, renaming, and quarantining that must be off for this directory.

2. **Exclude the directory from antivirus, DLP, and ICAP scanning.** The files an exchange writes are opaque protocol frames, and an invitation-based exchange encrypts them end to end -- the CLI requests the application-layer AEAD on every file-sync exchange and an invitation is what supplies the session key it needs, so the server and anything reading through it see only ciphertext (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security); a zero-setup exchange has no session key and runs under the SSH transport's encryption alone). A scanner therefore has nothing it can classify accurately -- at best it passes the file through, at worst it holds it until a scan completes or quarantines it as unrecognized binary content, which is a deletion as far as the protocol is concerned. Exclude the path rather than tuning the scanner's verdicts.

3. **No aggressive or short-age auto-cleanup.** An exchange spans many poll cycles and can run for hours when the partner reconciles the directory slowly. PSI-Link removes files itself where the protocol calls for it; a cleanup rule that removes one first -- a hello during rendezvous, or a message the partner has not yet consumed -- costs the exchange with no error naming the cause. It is worse in retain mode, where nothing is deleted as a protocol step and the directory is kept deliberately as a permanent transcript (see the `retain_files` row in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#sftp-and-file-drop-options)): an age-based sweep there destroys audit material and not only a live exchange. Where a mandatory retention policy cannot exempt the directory, set its age threshold well above the longest exchange you expect to run.

4. **Give the PSI-Link account rename and delete, not just write.** Two operations beyond `put` are load-bearing. **Rename** is how every file the partner reads is published -- the temp-then-final rename above is what keeps a partner from ever reading a partial file. **Delete** is a protocol step in the default (non-retain) mode: the receiver deletes each message it has consumed, and that deletion is the sender's go-ahead for the next one. It is also how a run clears its own files at close and how a starting run sweeps a temporary file orphaned by a crashed prior attempt.

   Delete carries a second, narrower consequence that applies only under [`connection_per_poll`](#a-maximum-session-duration-needs-a-session-per-poll-cycle); the default held-session mode keeps no such record and is unaffected. On a rendezvous directory whose permissions stop this party from unlinking files the partner wrote -- a sticky-bit directory is the usual shape -- a `connection_per_poll` run also leaves some of its *own* temporary files behind. The peer-owned temporary files that the start-of-exchange sweep attempts and cannot delete fill the adapter's record of cleanup deletes it still owes, and while that record stands full a cleanup this party's send path deferred across an idle gap is refused a place in it. The fill clears itself within a few session re-establishments rather than standing for the run -- but a cleanup refused inside that window is issued once and never re-issued, so that one temporary file survives the run. What it costs is directory hygiene: no data is lost, nothing hangs, and no exchange fails. The mechanism, the constants, and what the bound rests on are the second stated limit in [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#the-deferred-cleanup-delete-record).

5. **Allow-list the parties' client addresses, and give each party its own account.** PSI-Link polls the directory on a cadence and re-dials after a dropped session, which an anti-flood or auto-ban rule can read as abuse. Some products (Cerberus FTP Server and Titan FTP among them) offer a permanent ban as the response, which turns one transient network drop into a lockout that outlives the exchange; check whether yours does and what its ban duration and thresholds are. Allow-list both parties' client addresses so the rule cannot fire against them. Give each party its own account as well: the two parties are connected concurrently, so a shared account collides with per-account maximum-login and maximum-connection limits, and distinct accounts are also what make the directory permissions above meaningful per party.

### Server-enforced session limits

Two server limits are easily confused with each other, and PSI-Link answers them differently. Establish which one your server enforces before configuring anything.

#### An idle timeout is already handled

Servers commonly close a session that has gone quiet for some window; Azure Blob Storage's SFTP endpoint uses a fixed two minutes that is not operator-adjustable. An exchange does go legitimately quiet: one party polls while the other computes its reply, which on modest hardware runs for minutes with no file traffic at all.

PSI-Link covers this itself, with nothing to configure. The SFTP adapter issues a real no-op SFTP command on a fixed interval once a session has been idle for it, so a server keying idleness on the last SFTP **request** sees activity. The interval is a constant rather than a knob, sized below the tightest fixed idle window it must survive -- Azure's two minutes; the value and the reasoning are in [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#sftp-session-heartbeat-and-tcp-keepalive). A TCP or SSH-transport keepalive is not a substitute for it, and PSI-Link does not rely on one here: transport traffic rides below the SFTP protocol and does not reset a timer keyed on SFTP requests.

Two residues are the operator's rather than the adapter's:

- a server whose idle window is shorter still than the heartbeat interval; and
- a server that keys idleness on something other than SFTP request activity -- bytes transferred, say, or a wall clock the session's activity never resets, which is the next class rather than an idle timer at all.

For either one, confirm the *effective* idle setting with the server's administrator rather than assuming the product's documented default, since it can be set per account or per group, then either raise it or treat the server as a session-lifetime case below.

#### A maximum session duration needs a session per poll cycle

Some servers cap a session's total lifetime: past a fixed age the session is closed however active it has been. No heartbeat defeats that -- activity is exactly what such a cap ignores.

The remedy is `connection_per_poll` (`--connection-per-poll` on the command line), which opens a fresh SFTP session at the start of each poll cycle and releases it before the loop goes idle again, so no session need outlive one cycle. When to set it, what it costs, and the two idle stretches that still hold a session are in the `connection_per_poll` row and the guidance beneath it in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#sftp-only-options). Three points matter at deployment time:

- **It is a local choice, not a bilateral one.** How this party dials leaves no trace the partner can see, so the partner's side is unaffected and need not match. Only the party facing the capped server sets it.
- **Pair it with a long poll interval.** Every cycle pays a full SSH handshake, so the mode belongs with a minutes-scale `poll_interval_ms`; a sub-minute interval draws a warning from the CLI.
- **It replaces the heartbeat rather than layering with it.** No heartbeat is armed in this mode -- a session that lives one cycle has nothing to keep alive -- so the two are alternatives, not layers. Do not read the mode as extra protection on top of the idle-timeout handling above.

Setting neither leaves the default held-session mode, where a clean mid-exchange drop is re-dialed transparently and the interrupted operation re-issued, up to the `max_reconnect_attempts` budget over the whole exchange, after which the next drop ends it (see [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#shared-options)). That budget is a floor under a flaky link, not an answer to a server that caps every session it serves.

### Object-store and managed SFTP front-ends

Object-store SFTP front-ends -- AWS Transfer Family over S3, Azure Blob Storage's SFTP endpoint, Google Cloud Storage bridges -- do work with PSI-Link. Run them in **retain mode**, the configuration they are intended for: set `retain_files` on both parties, and on the command line `--retain-files` supplies the two settings it requires, `lockless_rendezvous` and `timestamp_in_filename` (see the rows in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#sftp-and-file-drop-options)). Retain mode rendezvouses through an acknowledgment-marker barrier instead of the default exclusive-create lock race, and exclusive create is the one operation an object-store front-end may not honor the way the lock path needs, so configuring retain mode settles that question rather than leaving it to the backend. Retain mode is bilateral: both parties set it, and a mismatch fails fast at rendezvous rather than stalling. A front-end that implements rename as copy-then-delete is not a problem in either mode, because PSI-Link never renames onto a name that already exists and a reader waits for a message's declared byte count before reading it.

Two of the checklist items above still apply, and retain mode makes the first of them more pressing rather than less:

- **Keep the rendezvous prefix out of every lifecycle and auto-expiry rule** (S3 Lifecycle, Azure lifecycle management, and their equivalents). Retain mode leaves the exchange's files in place as a durable transcript, so they linger longer than in the default mode and an expiry rule is correspondingly more likely to reach them -- during an exchange as well as after it.
- **No upload-triggered move or quarantine automation, and no antivirus/DLP scanning on the prefix.** These are orthogonal to the rendezvous mode and reach a retain-mode exchange exactly as they reach any other.

### Negotiating only FIPS-approved algorithms

A deployment required to use FIPS-approved cryptography constrains what the SSH layer will negotiate from the connection's own configuration, with no server-side cooperation needed. The settings to apply, what each excludes, what happens when the partner's server offers nothing approved, and the host-key gap no client-side setting can close are in [FIPS_SFTP_PROFILE.md](FIPS_SFTP_PROFILE.md).

### Local development and testing

For local development and integration testing, the project's test suite stands up its own SFTP server (an in-process `ssh2.Server` by default, or a native OpenSSH `sshd` child process). That setup is intended for testing the CLI's transport behavior against a known-good server and is not a production reference.

## Docker deployment

The published image `vdorie/psi-link` runs in either of two roles depending on its first argument; there is no separate console image.

`vdorie/psi-link` publishes two variants of that one image, differing only in what serves the cryptography beneath them. The unsuffixed tags (`X.Y.Z`, `X.Y`, `latest`) are the default artifact and the one every command in this document names. The `-fips` tags (`X.Y.Z-fips`, `X.Y-fips`, `latest-fips`) carry a CMVP-validated OpenSSL FIPS provider instead, at roughly 1.8x the size and with the SFTP restrictions in [FIPS_SFTP_PROFILE.md](FIPS_SFTP_PROFILE.md); take one only under a FIPS obligation. Which artifact carries which posture is in [RELEASES.md](RELEASES.md#which-image-carries-which-posture), and what may be claimed of the variant is in [COMPLIANCE.md](COMPLIANCE.md#fips-140). Everything below holds for both.

### The user the image runs as

Both roles run unprivileged in both variants. Left alone they run as the image's `node` account, **uid 1000, gid 1000**; both also run as an account you name with `--user`, which is the subject of "Running as your own account instead" below. What the posture rests on is that neither role runs as root: nothing in an exchange holds the privilege to write outside what you mounted, and the program files inside the container belong to `root`, so the running process cannot rewrite its own code. The number 1000 is the base image's default rather than something psilink requires of you.

What the default account asks of you is bind-mount ownership. A bind mount keeps its host directory's ownership inside the container, so every directory the container writes -- `/work` for the CLI, and the data, input, and rendezvous mounts for the console appliance -- has to be writable by uid 1000, and every file it reads has to be readable by it. Which case below applies is decided by the container engine, not by the operating system: Docker Desktop is available for Linux too.

- **Docker Desktop**, on macOS, Windows, or Linux, presents a bind mount to whichever user the container runs as, so there is nothing to do: the commands in this document and in the quickstart work as written.
- **Docker Engine on Linux** passes the host directory's real ownership through. A directory created by an account that is itself uid 1000 -- the usual case on a single-user workstation -- is already owned by the account the container runs as. Otherwise hand the working directory to that uid once, before the first run:

  ```sh
  sudo chown 1000:1000 /host/work
  ```

  The `sudo` is load-bearing: giving a file away to another uid is privileged, and without it the command answers `Operation not permitted`.

  **If you have run this image before**, the directory needs more than that. Earlier images ran as root, so any `psilink.yaml`, `.psilink.key`, or results file already in the directory belongs to root at mode `0600`: unreadable to uid 1000 whatever the directory around them says, and untouched by a chown of the directory alone. Hand the contents over with it:

  ```sh
  sudo chown -R 1000:1000 /host/work
  ```

  Watch the read side too: a working directory or input file that no other account can read (mode `0700`, `0600`) is unreadable inside the container even when it is yours on the host.

- **A CIFS network-share volume** -- the Docker volume the Windows file-drop setup creates over `//server/share` -- has no host ownership to pass through: a Windows SMB server serves no Unix owner for the mount to read, so the client presents the whole tree as owned by whatever the volume's `uid=` and `gid=` mount options name, and root when they name nothing. The volume must therefore pin `uid=1000,gid=1000`, which is what `Setup-PsilinkFileDrop.ps1` and its Command Prompt counterpart create it with; a volume made by hand without them mounts and then refuses every write. Ownership is mapped rather than enforcement switched off, so the share's own access control still decides what the mount credential may do.

**Running as your own account instead.** Where changing the directory's ownership is not an option, run the container as yourself:

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD":/work vdorie/psi-link exchange input.csv
```

The container then runs as an account the image knows nothing about, and `HOME` is not a question that arises. psilink chooses no path under the home directory for anything: it reaches for the home directory only to expand a `~` you wrote yourself, so an ephemeral or unset `HOME` changes no path psilink picks. It still resolves the ones you spell with a `~` against whatever home the container has, which in an ephemeral one is a different directory on every run -- so write those paths out in full. The signing identity, the one long-lived credential the CLI holds, is written and read only where you name it (see [Mounting the signing identity](#mounting-the-signing-identity)).

**The console appliance takes the same route.** `serve` keeps the signing identity in the mounted data root. Its one container-internal write outside the mounts is the directory a pasted SFTP credential is materialized to, which the image creates under root-owned `/run` for its own account; point `JOB_SFTP_CREDENTIAL_DIR` at a path the account you named can create instead:

```sh
docker run --rm -p 127.0.0.1:3000:3000 \
  --user "$(id -u):$(id -g)" \
  --env JOB_SFTP_CREDENTIAL_DIR=/tmp/psilink-sftp-credentials \
  --env JOB_DATA_ROOT=/data \
  -v /host/work:/data \
  vdorie/psi-link:latest serve
```

The path must sit outside every folder you mounted -- the data root, the input directory, the rendezvous directories, and the secrets directory -- or the appliance refuses to start rather than put a pasted secret where your results or your partner's sync are. It is container-internal and goes with the container, which is what `--rm` is doing above. The variable is not optional once you name an account: the default directory is one only the image's own account can create, and an appliance that cannot create the directory it is given refuses to start, naming this variable in the refusal.

**The console launcher does all of this for you.** On macOS and Linux, the `start-psilink.sh` published with each release runs the container as the account that started it, passes the scratch-directory override with it, and runs the container's own `psilink doctor mount` battery over every folder it is about to mount, as that same account, before the console starts. The folders the console writes in -- the data root and the rendezvous folder -- have to pass that battery's write checks. The input folder has to be readable and nothing more, so a read-only input mount passes it, and the launcher binds it read-only in the container besides. Under `sudo` -- the usual workaround for an account outside the docker group -- it runs the container as the account `sudo` came from; started from a root login with no account to name, it passes no `--user` at all and leaves the image's own account to run it.

**What a mis-owned mount looks like.** The failure names `EACCES` and the path it could not write. Those paths are relative -- the key file and config default to `./.psilink.key` and `./psilink.yaml`, resolved against the container's working directory -- and where the failure lands depends on the command:

- `psilink exchange` stops up front, at the key-file preflight, with `keyFilePath parent directory . is not writable: EACCES: permission denied, open '.psilink-write-probe-<pid>-<hex>'. Restore write access ...`. It stops there deliberately, before any key exchange, so nothing is half-done.
- `psilink accept` has no such preflight: the terms are displayed and confirmed, and the write that follows fails with `EACCES: permission denied, open './psilink.yaml.tmp.<pid>'` and exit 69. Nothing is spent -- the invitation is still good -- but the ownership has to be fixed and `accept` run again.
- An existing `psilink.yaml` that the container cannot read fails earlier still, at config load: `config file ./psilink.yaml could not be read: EACCES: permission denied, open './psilink.yaml'`. A file owned by root rather than uid 1000 is what produces this, and the recursive `chown` above is what clears it.

In all three the remedy is ownership, not mode: a `chmod` on a directory or file the container's account does not own changes nothing it can reach.

### Running the CLI

By default the image runs the headless CLI. Mount a working directory and pass CLI arguments:

```sh
docker run --rm -v "$PWD":/work vdorie/psi-link exchange input.csv
```

What the container needs to reach while it runs, and how to hold it to that, is in [Restricting the container's outbound network access](#restricting-the-containers-outbound-network-access).

### Running the console

Pass `serve` as the first argument to run the console instead. It takes a published port and at least one mount; the commands for each mount layout are in [Running the container](CONSOLE.md#running-the-container).

### Restricting the container's outbound network access

An exchange gives the container one reason to reach the network: the SFTP connection to the server the two parties agreed on. Holding its outbound access to that one endpoint is defense in depth -- were the process ever compromised, through a dependency vulnerability or partner-supplied material that got past the protocol's own bounds, an egress allowlist bounds what it could reach or exfiltrate to. No exchange needs it to work and nothing in PSI-Link depends on it; it is hardening an operator applies deliberately.

`docker run` has no egress allowlist of its own, and the image runs unprivileged (see [The user the image runs as](#the-user-the-image-runs-as)), so nothing inside the container can set network rules for itself either. Restricting egress is therefore host configuration rather than a container flag. What each role needs outbound:

- **A shared-directory (filedrop) exchange needs no egress at all**, in either role. The rendezvous directory is a mount, and the host performs whatever network file access it stands for, so the container itself reaches nothing.
- **An SFTP exchange needs TCP to the server's host and port**, plus name resolution for that host unless it is named by address. This is the same in both roles: the console drives the same CLI as a subprocess inside the same container, and the console's "read the fingerprint from the server" probe reaches that same endpoint.
- **The console's own web and job-API traffic is inbound, not egress.** The browser connects in over the published loopback port, and the console serves its assets and its peer-coordination server from inside the container. `-p 127.0.0.1:3000:3000` governs who may reach in and stays exactly as it is (see [Running the console](#running-the-console)).

#### No egress at all

For a shared-directory exchange on the CLI, take the network away outright:

```sh
docker run --rm --network none -v "$PWD":/work vdorie/psi-link exchange input.csv
```

This is the strongest option here and the only portable one -- a `docker run` flag with no host configuration behind it. It is not an option for the console appliance, whose browser traffic has to reach the published port; a console that will only ever run shared-directory exchanges takes the allowlist below with no SFTP entry in it, which denies the same traffic outbound.

A network file drop is the one place where something still reaches out: `psilink doctor probe` talks to the SMB server from inside the container (see [Checking a network file drop](CLI.md#checking-a-network-file-drop)). Run the checks before you take the network away, or allow tcp/445 to the file server while you run them. The exchange itself, over the mounted directory, still needs nothing.

#### An allowlist for an SFTP exchange

These steps are host-specific and Linux-only. They assume Docker Engine on a Linux host with its default iptables integration (the daemon's `iptables` setting left on), and root on that host to write firewall rules. The rules are host state: they govern every container on the network you create, they do not travel with the image or a Compose file, and they last until you delete them or the host reboots -- persist them with your distribution's own mechanism (`iptables-persistent`, a `firewalld` direct rule, a systemd unit) if the deployment is a lasting one.

**Docker Desktop -- on macOS, Windows, or Linux -- and rootless Docker do not work this way.** The container's traffic is routed inside a virtual machine or a user-mode network stack these rules do not reach, and neither engine offers a supported equivalent. There, `--network none` above still restricts a shared-directory exchange, while an SFTP exchange's egress restriction has to come from the host's own firewall or from the network the machine sits on -- which covers the whole machine rather than this container.

**1. Give the container a network of its own, with a subnet you chose.**

```sh
docker network create --subnet 172.31.240.0/29 psilink-egress
```

The subnet is pinned rather than taken from Docker's default pool because the rules below name it, and a pool-assigned subnet can differ from one create to the next. Any private range the host does not already route elsewhere will do.

**2. Write the rules into the `DOCKER-USER` chain**, the chain Docker leaves for operator rules and consults ahead of its own. Every rule is scoped to that subnet as its source, so it governs what this container may reach and leaves other containers, and everything arriving at the host, alone.

```sh
SUBNET=172.31.240.0/29
SFTP_ADDR=203.0.113.24     # the address your SFTP server resolves to
SFTP_PORT=22               # connection.server.port; 22 when unset
RESOLVER=192.0.2.53        # the resolver you hand the container in step 3

# Replies on an already-permitted connection, matched before anything below.
sudo iptables -I DOCKER-USER 1 -s "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# The one endpoint an exchange needs.
sudo iptables -I DOCKER-USER 2 -s "$SUBNET" -p tcp -d "$SFTP_ADDR" --dport "$SFTP_PORT" -j ACCEPT
# Name resolution -- omit both if you pin the server by address instead.
sudo iptables -I DOCKER-USER 3 -s "$SUBNET" -p udp -d "$RESOLVER" --dport 53 -j ACCEPT
sudo iptables -I DOCKER-USER 4 -s "$SUBNET" -p tcp -d "$RESOLVER" --dport 53 -j ACCEPT
# Everything else the container tries to reach.
sudo iptables -I DOCKER-USER 5 -s "$SUBNET" -j DROP
```

The explicit rule numbers are load-bearing. `-I` inserts at the position you give it and at the top of the chain when you give none, so numbering them is what keeps the `DROP` last instead of first; `-A` would append past the chain's own trailing `RETURN`, where a rule is never reached. Read the result back with `sudo iptables -L DOCKER-USER -n --line-numbers` before running anything against it, and verify it as below rather than trusting the listing.

**3. Run the container on that network.** Nothing else about either invocation changes.

```sh
# Headless CLI
docker run --rm --network psilink-egress --dns 192.0.2.53 \
  -v "$PWD":/work vdorie/psi-link exchange input.csv

# Console appliance
docker run --rm --network psilink-egress --dns 192.0.2.53 \
  -p 127.0.0.1:3000:3000 \
  --env JOB_DATA_ROOT=/data \
  -v /host/work:/data \
  vdorie/psi-link:latest serve
```

`--dns` names the resolver the container uses, so the address the rules permit is one you chose rather than whatever the host's `/etc/resolv.conf` happens to carry. Drop the flag along with the two resolver rules if you pin the server by address.

#### Substituting your own endpoint

`SFTP_ADDR` and `SFTP_PORT` stand for the server the two parties agreed on; there is no built-in endpoint to allow.

- **Headless CLI**: `connection.server.host` and `connection.server.port` from your `psilink.yaml`, the port being 22 when unset (see [`connection.server`](EXCHANGE_REFERENCE.md#connectionserver)).
- **Console appliance**: the host and port you enter when you author the connection in the console (see [Authoring the SFTP connection](CONSOLE.md#authoring-the-sftp-connection)). Re-authoring against a different server means revisiting the rules.

A hostname that resolves to several addresses needs a rule per address. Confirm the set with `dig +short <host>` and re-confirm it whenever the server's operator changes anything: an address that moves out from under the allowlist stops the exchange with a connection failure rather than a warning.

**Pinning the server by address instead.** Naming the server by address in the connection takes name resolution out of the picture entirely: drop the two resolver rules and the `--dns` flag, and the allowlist is one endpoint and nothing else. What authenticates the server is its host key, pinned as `host_key_fingerprint` -- mandatory for a console-authored connection, and effectively so for a containerized CLI run, which has no terminal and so fails closed rather than establishing trust on first use (see [SFTP host-key trust](CLI.md#sftp-host-key-trust)). Identifying the server by address therefore costs no authentication. What it costs is maintenance: an address the server's operator changes has to be changed in the configuration and in the rules.

#### Verify it rather than assuming it

An allowlist that silently drops name resolution, and one whose `DROP` sits above the rules meant to permit anything, both look identical to a working one until an exchange fails. Check both directions with `probe-host-key`, which connects far enough to read the server's host key and sends no credential (see [Reading a host key with `probe-host-key`](CLI.md#reading-a-host-key-with-probe-host-key)); it exits 0 when it reached the server and 69 when it could not.

```sh
# Permitted: the endpoint you allowed. Prints a fingerprint, exits 0.
docker run --rm --network psilink-egress --dns 192.0.2.53 \
  vdorie/psi-link probe-host-key sftp://sftp.partner.example --connect-timeout 10s

# Blocked: the same host on a port you did not allow. Exits 69.
docker run --rm --network psilink-egress --dns 192.0.2.53 \
  vdorie/psi-link probe-host-key sftp://sftp.partner.example:2222 --connect-timeout 10s

# Blocked: a host you did not allow. Run it a second time without
# `--network psilink-egress`: a probe that fails for its own reasons proves
# nothing, so it has to succeed off the restricted network to count.
docker run --rm --network psilink-egress --dns 192.0.2.53 \
  vdorie/psi-link probe-host-key sftp://some.other.host --connect-timeout 10s
```

Probing by name is also the name-resolution check, since it succeeds only if the container both resolved the name and reached the address. A probe that fails by name and succeeds against the address says resolution is what the rules are dropping -- permit the resolver, or pin the server by address.

These steps are executed, not only written: PSI-Link's image smoke workflow (`.github/workflows/image_smoke.yaml`) creates the network, writes these rules into `DOCKER-USER`, and asserts each row above against the image it has just built -- the permitted endpoint read by name, the denied port and the denied host refused, each of the three reached again off the restricted network, and the by-name probe refused once the resolver rules are removed. What that establishes is that the mechanism works as written on a current Docker Engine. Your own subnet, resolver, server address, and port are still yours to check here.

Finally, start the console once on the restricted network and confirm it still loads at `http://127.0.0.1:3000`. The publish binding governs what arrives at the container and these rules govern what leaves it, but a mistake in either is worth catching before an exchange rather than during one.

#### What the restriction does not cover

- **The host and the operator's browser are unaffected.** This bounds one container's reach, not the machine's.
- **Name resolution is a permitted channel whenever you allow a resolver.** Pin the server by address and drop the resolver rules if you need that closed too.
- **Traffic the host delivers to itself is not forwarded**, so `DOCKER-USER` is not where a container reaching a service on the host's own address is decided; close that at the host's `INPUT` chain if it matters to you.
- **It is not a substitute for the controls that carry the exchange.** The partner's material is untrusted whatever the container may reach, and what bounds it is the exchange protocol itself (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security)); what bounds who reaches the console is the publish binding (see [Reachable only where you publish it](CONSOLE.md#reachable-only-where-you-publish-it)).

### Key file permissions in containers

Automated deployment tooling -- CI runners, container entrypoints, Kubernetes init containers, and orchestration scripts -- must not leave `.psilink.key` readable by other processes or users. Violating this rule defeats the application-layer authentication that protects recurring exchanges.

Owner-only and the container's identity are one question here, not two: a `0600` file grants nothing to anyone but its owner, so the account the container runs as (see [The user the image runs as](#the-user-the-image-runs-as)) has to be that owner. A key file owned by some other uid is not merely unwritable from inside the container -- it is unreadable, and the exchange fails before it starts.

**Inject via a secrets manager, not the image.** Never copy `.psilink.key` into a container image layer; image layers are readable by anyone with pull access to the registry. Instead, mount the file at runtime:

- **Docker**: mount the key file as a named secret or a host-path bind mount with `--mount type=bind,src=/host/path/.psilink.key,dst=/work/.psilink.key`. Do not mount it read-only; the CLI must be able to write the rotated token after each successful exchange. Set the file to mode `0600` and owner uid 1000 on the host before the container starts.
- **Kubernetes**: use a `Secret` volume with `defaultMode: 0600`. Do not use a `ConfigMap` for the key file. Set the pod's `securityContext` so the projected file belongs to the identity the container runs as; a `0600` file the container's uid does not own is unreadable to it.
- **CI runners**: write the token to a temporary file with `install -m 0600 /dev/stdin .psilink.key <<< "$TOKEN"` (bash) or `printf '%s' "$TOKEN" | install -m 0600 /dev/stdin .psilink.key` (POSIX sh) rather than `echo "$TOKEN" > .psilink.key`, which may leave a world-readable file depending on the runner's umask.

**Separate read-only config from read-write secrets.** If the working directory (containing `psilink.yaml` and input data) is mounted read-only - for example to prevent the container from modifying source data - mount a separate read-write volume for the key file and use `--key-file` to redirect the CLI:

```sh
# Docker
# /run/secrets must be read-write; the CLI writes the rotated token after each successful exchange
docker run \
  --mount type=bind,src=/data/config,dst=/work,readonly \
  --mount type=bind,src=/data/secrets,dst=/run/secrets \
  vdorie/psi-link exchange input.csv --key-file /run/secrets/.psilink.key
```

```yaml
# Kubernetes: separate secretsDir volume alongside a read-only configMap mount
volumes:
  - name: config
    configMap:
      name: psilink-config
      defaultMode: 0444
  - name: secrets
    secret:
      secretName: psilink-key
      defaultMode: 0600
containers:
  - name: psilink
    volumeMounts:
      - name: config
        mountPath: /work
        readOnly: true
      - name: secrets
        mountPath: /run/secrets
    args: ["exchange", "input.csv", "--key-file", "/run/secrets/.psilink.key"]
```

The `--key-file` flag is accepted by both `exchange` (reads the token on start and writes the rotated token back to the same path after a successful exchange) and `zero-setup` (specifies the output path when `--save` is used).

**Verify before first exchange.** After injecting the key file, verify its permissions before running `psilink exchange`:

```sh
stat -c "%a %n" .psilink.key   # Linux
stat -f "%Lp %N" .psilink.key  # macOS
```

The output must show `600`. If it does not, the CLI will emit a warning on load; correct the permissions before proceeding.

The manual procedure for confirming the Windows owner-only writers still
narrow ACLs correctly is in [TESTING.md](TESTING.md#verifying-windows-owner-only-file-protections).

### Mounting the signing identity

The signing identity is the CLI's other credential file, and it is not the key file: the shared secret rotates every exchange and must be written back, while the signing identity is a long-lived P-256 private key that must stay byte-for-byte stable, because a partner pins its fingerprint once and every later receipt verifies against it. Mount them differently.

psilink resolves no location for it. Name the path with `signing.identity_file` in the configuration, or `--identity-file` on the command line; a certificate-mode exchange configured with neither is refused before it connects. See [CLI.md](CLI.md#where-the-signing-identity-lives).

**Give it a mount of its own, and mount that read-only.** The identity is created once, by `psilink fingerprint`, which is the only command that writes it; an exchange and a `psilink verify-receipt` read the file and write neither it, its directory, nor anything beside it. That is the reason it does not go in the `/run/secrets` mount above: the rotating key file is what makes that mount read-write, and the identity has no reason to inherit the requirement.

Provision it once, against a directory writable for that one command:

```sh
docker run --rm \
  --mount type=bind,src=/data/signing,dst=/run/signing \
  vdorie/psi-link fingerprint \
  --identity-file /run/signing/psilink-signing-identity.json \
  --identity "Agency A, a@agency-a.gov"
```

Then mount it read-only for every exchange thereafter, beside the read-write mount the key file needs, with `signing.identity_file: /run/signing/psilink-signing-identity.json` and `signing.receipt_output: /run/secrets/psilink-receipt.json` in the mounted `psilink.yaml`. Point the exchange record there too: the image's `WORKDIR` is `/work`, which this example mounts read-only, and a signed run's receipt and record both default to a path under the working directory -- a write that fails there is non-fatal and only warns, so leaving either at its default here would complete the exchange while landing neither.

```sh
docker run \
  --mount type=bind,src=/data/config,dst=/work,readonly \
  --mount type=bind,src=/data/secrets,dst=/run/secrets \
  --mount type=bind,src=/data/signing,dst=/run/signing,readonly \
  vdorie/psi-link exchange input.csv --key-file /run/secrets/.psilink.key \
  --record-file /run/secrets/psilink-record.json
```

```yaml
# Kubernetes: the signing identity is a second Secret volume, mounted read-only
volumes:
  - name: signing
    secret:
      secretName: psilink-signing-identity
      defaultMode: 0600
containers:
  - name: psilink
    volumeMounts:
      - name: signing
        mountPath: /run/signing
        readOnly: true
```

Two more things, whichever platform you are on:

- **Make the host directory durable, and back it up.** Losing the file means minting a new identity with a new fingerprint, which every partner must re-pin before your receipts verify again.
- **Never put it in a directory the partner writes into.** In a file-drop exchange the rendezvous directory is exactly that, and a signing identity there hands the partner the private key that signs for you with every partner, not only the one you share the folder with.

## See also

- [COMMUNICATION.md](COMMUNICATION.md) - the communication channels and services described here
- [CLI.md](CLI.md) - CLI configuration for connecting to the services described here
- [CONSOLE.md](CONSOLE.md) - running the image as the operator's local console: its mounts, environment variables, and what an operator authors in it
- [FIPS_SFTP_PROFILE.md](FIPS_SFTP_PROFILE.md) - constraining an SFTP exchange's SSH negotiation to FIPS-approved algorithms
