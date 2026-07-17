---
title: "PSI-Link Deployment"
---

# PSI-Link deployment

This document covers the deployment and operation of the supporting services required to run PSI-Link exchanges, including reference configurations for each service type and Docker deployment of the CLI. It does not cover the communication protocol those services support (see [COMMUNICATION.md](COMMUNICATION.md)) or the CLI commands used against them (see [CLI.md](CLI.md)). Intended readers are system administrators and IT staff.

## STUN/TURN

PSI-Link does not bundle a STUN or TURN server, and no reference configuration is provided in this release. Deployments needing NAT traversal for WebRTC typically either point at a commercial ICE-credential service (Twilio Network Traversal Service and equivalents return time-limited credentials on demand; see [COMMUNICATION.md#stunturn](COMMUNICATION.md#stunturn)) or operate a self-hosted coturn instance using its upstream documentation. Reference configurations for both are targeted for the 1.1 release; see [ROADMAP.md](ROADMAP.md).

## WebSocket-to-TCP proxy

A WebSocket-to-TCP proxy is required only when a browser-based party needs to reach an SFTP server, because browser runtimes cannot open raw TCP connections (see [COMMUNICATION.md#websocket-to-tcp-proxy](COMMUNICATION.md#websocket-to-tcp-proxy)). The CLI does not need this proxy. No reference configuration is provided in this release; deployment guidance is targeted for the 1.1 release (see [ROADMAP.md](ROADMAP.md)).

## Peer coordination server

The web application bundles a PeerJS-compatible peer-coordination server, served under its own `/api/` route, so deploying the web application is sufficient to obtain a coordination server for parties that use it. The public PeerJS service (`api.peerjs.com`) is also usable for evaluation but routes connection-establishment metadata through a third party.

Deploying a standalone peer-coordination server -- for example, as a serverless WebSocket function on AWS Lambda or Cloudflare Workers -- is not currently supported by configuration in the web application and is targeted for the 1.1 release (see [ROADMAP.md](ROADMAP.md)).

### Hardening the signaling surface

The bundled coordination server is untrusted by design: the rendezvous ids are derived from the out-of-band invitation secret and the two browsers run an authenticated key exchange directly between themselves, so the server only relays opaque setup messages and never sees exchange data (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security)). The residual exposure on its WebSocket upgrade surface is therefore resource exhaustion and nuisance, not access to any party's data. The application enforces several defense-in-depth guards itself, unconditionally and regardless of deployment:

- A slow, partial, or idle upgrade handshake (a "slowloris" that dribbles, stalls, or connects and then sends nothing at all) is bounded by connection-level timeouts and closed server-side rather than held open.
- Each signaling message is size-capped, so an unauthenticated peer cannot send an oversized frame.
- A client that registers but never proves it is a live peer (it sends no heartbeat) is reaped within seconds, well before the liveness timeout that governs an established peer, so an abandoned or junk registration cannot squat a slot; a real peer, which heartbeats within seconds of connecting, is never cut short.
- The relay's hold-for-reconnect message queues are bounded in count and depth, so a client cannot drive unbounded memory by addressing messages to many made-up recipients.

The constant values and rationale for these guards are in [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#web-signaling-surface-bounds).

Two further protections depend on the deployment and are the reverse proxy's responsibility, because only the proxy sees the real client origin and address:

- **Origin / cross-site enforcement.** The application does not restrict the WebSocket upgrade by Origin, because it is not configured with its public origin -- the value it could otherwise derive is its internal bind address, which does not match the browser's public origin, so enforcing it would reject legitimate clients. A cross-site connection to the signaling server gains nothing an unauthenticated script does not already have (it cannot target or read any exchange -- the authenticated handshake protects that), but an operator who wants to restrict the upgrade by Origin should do so at the reverse proxy, which knows the public origin.
- **Per-address rate limiting.** Bounding how many connections or registrations a single client address may open belongs at the proxy or hosting layer, which sees the real client address. Behind a proxy the application sees only the proxy's address, so an in-application per-address cap would either do nothing or throttle all clients together. The in-application reaper above clears a fire-and-forget flood (sockets that register and go silent), but a flood that keeps each socket alive with heartbeats is indistinguishable from real peers in the application; the only in-application ceiling on it is the global registered-client cap, which is shared across all clients, so without a proxy such a flood degrades to global connection exhaustion rather than per-address throttling.

A deployment that exposes the web application directly, with no reverse proxy, gets the unconditional in-application guards above but neither Origin enforcement nor per-address rate limiting; run the coordination server behind a reverse proxy for those.

Both controls scope to the `/api/peerjs` upgrade path. The following nginx reference shows where each goes; the rate and connection limits are illustrative starting points to tune to your load, not recommended values:

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

The same reference also curates the TLS posture of the terminator it ships. On top of the TLS 1.2+ floor it sets an explicit forward-secrecy, AEAD-only `ssl_ciphers` list (ECDHE with AES-GCM / ChaCha20-Poly1305), active by default, so the TLS 1.2 handshake no longer falls back to the platform default suite list, which still permits CBC-mode SHA1 and non-forward-secret plain-RSA key exchange; the list constrains TLS 1.2 only, as TLS 1.3 selects from its own AEAD suites. The trade-off is that this floor refuses pre-2014 clients with no ECDHE-AEAD suite (Internet Explorer 11 on Windows 7, Android 4.x, Java 7); if you must serve such a population, widen the list deliberately rather than leaving it at this default.

The same reference also disables TLS session resumption (`ssl_session_tickets off`, `ssl_session_cache off`), active by default, so every session is a full ECDHE handshake and no resumed session can undercut that forward secrecy. nginx enables stateless session tickets by default and, with no `ssl_session_ticket_key`, never rotates the single per-worker key that wraps every resumed session's keying material -- the one long-term secret the ECDHE-only handshake otherwise removes, which a passive observer who captures resumed traffic and later obtains the key could use to decrypt those sessions. Turning tickets off closes that; turning the cache off pins the result, because under TLS 1.3 tickets-off alone would still allow stateful resumption against a session cache. The cost is the resumption round-trip saving, negligible for this low-volume two-party coordination surface, against no unrotated key and no key-rotation tooling to run. On a load-balanced environment this matters more, not less -- each instance would otherwise derive its own ticket key, so resumption across instances would require a shared `ssl_session_ticket_key` distributed and rotated in lockstep, operator-dependent infrastructure the reference does not ship. If you want resumption performance back, re-enable both deliberately (tickets with rotated, cross-instance-shared key file(s), plus a cache); the `ssl_session_timeout` already set then bounds how long a session resumes -- but the key file is itself the long-term secret disabling tickets removed, now on disk, so keep it owner-only, distribute it only over a secured channel, and rotate it, or you have reintroduced the exposure. This forward secrecy is a property of the TLS hop to this terminator; the PSI exchange's own end-to-end protections do not depend on it.

With resumption disabled, every connection now runs a full ECDHE key agreement rather than amortizing it across resumed sessions, so the same reference also pins the ECDHE curve list explicitly (`ssl_ecdh_curve X25519:prime256v1`), active by default, instead of leaving curve selection to the OpenSSL/platform default. Modern OpenSSL already prefers X25519 and P-256, so the practical delta is small; pinning makes the choice explicit and resilient to a future platform-default change at no operator-editing cost -- the same active-if-safe-unedited posture as the cipher list. Unlike the cipher list, which constrains TLS 1.2 only, the curve list applies to both the TLS 1.2 ECDHE key agreement and the TLS 1.3 key-share, so it is kept to two groups (X25519 and P-256) that effectively every TLS 1.2+ AEAD client able to negotiate the cipher floor already offers.

HSTS (`Strict-Transport-Security`), by contrast, ships as a commented opt-in template rather than active, because the reference is commonly run with a test or self-signed certificate and an active HSTS header pins HTTPS in the browser -- a pinned host cannot be reached over plain HTTP to recover, and a bad certificate can no longer be click-through-accepted. For a production deployment with a valid certificate you should enable it: uncomment the header, start from a short `max-age` and raise it once verified, and leave `preload` off unless you have deliberately committed the host to the browser preload list (a one-way step). HSTS is honored only on an HTTPS response, so it -- and SSL-strip protection generally -- takes effect on first contact only if plain HTTP is already redirected to HTTPS. Configure that redirect at the Elastic Beanstalk load balancer (an ALB HTTP listener that 301s to HTTPS); without it, plain-HTTP requests are not upgraded and an enabled HSTS policy never reaches the browser on a first visit. Do the redirect there rather than adding a `:80` server to this nginx config, which would conflict with the platform's own default `:80` server.

OCSP stapling ships the same way -- a commented opt-in template, not active -- for a parallel reason. When enabled it has nginx fetch a fresh OCSP response for its own certificate and staple it into the handshake, sparing the client a separate revocation round-trip to the CA. But, like HSTS, it cannot work on the test or self-signed certificate the reference is commonly run with (a self-signed certificate has no CA-published OCSP responder to query), and it further needs infrastructure this config cannot assume: a `resolver` so nginx can reach the responder's hostname and an `ssl_trusted_certificate` issuer chain for `ssl_stapling_verify` to validate the response. The template carries those directives commented together with inline notes on each. Stapling is best-effort, so it does not get the loud-on-half-edit treatment the Origin allowlist does: a misconfiguration makes nginx serve an unstapled handshake with a logged warning rather than fail to start, so a partial edit degrades quietly -- after enabling it, confirm it actually staples with `openssl s_client -status` rather than assuming it took.

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

## Server job API

The web application can run as a **console appliance** for a single party: a container that drives that party's own `psilink` exchange runs behind a server-side job API, so an operator creates, watches, and downloads the result of an exchange without invoking the CLI by hand. The appliance serves one party, inside that party's own trust boundary; it is never a shared meeting point between the two partners, who still rendezvous only over the exchange channel itself. The trust invariant and what would violate it are in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#single-party-appliance-trust-boundary).

**One image, the console profile baked in.** The published `vdorie/psi-link` image is the appliance: it is built with `VITE_DEPLOYMENT_PROFILE=console` so its web assets and its server-side job driver are the console halves, and it runs them with `docker run -d -p 3000:3000 vdorie/psi-link serve` (see [Docker deployment](#docker-deployment)). You do not build web assets yourself, set the profile, or publish a second image; the profile the image carries drives which transports run server-side. Under `console` the transport chooser offers to run a shared-directory (`filedrop`) exchange on the appliance -- sending the operator's file to the job API -- and, when SFTP remotes are provisioned (below), to run an SFTP exchange against one of them; it drops the browser-only file-handling assurance from the UI accordingly. The separate `hosted` web deployment (the continuously deployed `apps/web`, not this image) never offers to run an exchange server-side: a shared-directory or SFTP exchange there only saves an exchange file for the command-line tool, so the operator's file stays in the browser even if the API were reachable.

The job API is **off by default.** It does nothing -- serves no endpoint, spawns no CLI -- until you configure a data root. Two environment variables control it:

- `JOB_DATA_ROOT` -- the feature gate and the directory under which each job's working files are created. Set it to turn the API on; leave it unset to keep it off. A hosted deployment that does not set it never exposes the API.
- `JOB_API_TOKEN` -- a bearer token the API requires on every request. Set it whenever the API is reachable beyond loopback.
- `JOB_SFTP_REMOTES` -- the path to a mounted file naming the SFTP servers the appliance may connect out to. Set it to let the appliance run SFTP exchanges through the job API; leave it unset and SFTP stays save-a-file.

**Loopback or token, enforced at startup.** The API assumes a single operator, not multiple tenants, so it must not sit unauthenticated on a shared interface. If you enable it (set `JOB_DATA_ROOT`) on a non-loopback bind without a token, the server refuses to start. Run it either bound to loopback (the appliance case, no token needed) or with `JOB_API_TOKEN` set.

That startup check reads the application's own bind host, which is not the whole story behind a reverse proxy: a proxy terminates the public connection and forwards to the app on loopback, so the app sees a loopback bind and does not force a token even though the API is publicly reachable through the proxy. Behind any proxy, set `JOB_API_TOKEN` yourself, or deny the `/api/jobs` path at the proxy. The bundled Elastic Beanstalk reference does the latter -- it returns 404 for `/api/jobs` by default, since that hosted profile is not a single-party appliance -- so remove that block deliberately if you are deploying the appliance there with a token.

**SFTP runs only against remotes you provision.** The browser never supplies a host or a credential: an SFTP job names one of the remotes in the `JOB_SFTP_REMOTES` file, and everything about the connection -- host, port, account, credential file references, and the pinned host-key fingerprint -- comes from that file. Every entry must pin its server's host key (the appliance never prompts to trust one; stage a rotation by listing the old and new fingerprints together) and must reference its credentials as `@path` files mounted alongside, never inline, so the web server never holds a secret and job directories never contain one. The file is read once at startup, and an invalid file refuses to start; changing hosts or fingerprints takes a restart, while a credential file's contents can be rotated in place. One exchange runs against a remote at a time. The container additionally needs network egress and DNS to each remote's host and port -- shared-directory exchanges needed none. The file format and each validation rule are in [SERVER_JOB_API.md](spec/SERVER_JOB_API.md#sftp-remotes); the trust posture is in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#single-party-appliance-trust-boundary).

**Restarting cancels in-flight exchanges; completed jobs survive.** Job state lives in server memory only, so restarting the server cancels any exchange still running -- rerun those, since the exchange protocol cannot resume mid-run. A completed job's files remain on disk, and the console re-discovers them after a restart: you can still list prior jobs and download each one's result, record, and verification keys read-only (an interrupted run shows as terminated, and nothing is ever re-run). Per-job directories accumulate under `JOB_DATA_ROOT` until you remove a job through the API or delete its directory by hand; nothing is auto-deleted.

The endpoint contract, the request schema, the working-directory layout and file permissions, and the exact gate and startup rules are specified in [SERVER_JOB_API.md](spec/SERVER_JOB_API.md).

## SFTP server

PSI-Link does not include or require any particular SFTP server. In practice almost all deployments reuse an existing service: `sshd` on a standard Linux host, with a per-exchange directory whose Unix permissions restrict access to the two partner accounts, is sufficient. The two parties should agree out-of-band on the directory path and on which accounts have access; nothing more is required of the server beyond that.

For local development and integration testing, the project's test suite stands up its own SFTP server (an in-process `ssh2.Server` by default, or a native OpenSSH `sshd` child process). That setup is intended for testing the CLI's transport behavior against a known-good server and is not a production reference.

## Docker deployment

The single published image `vdorie/psi-link` runs in either of two roles depending on its first argument; there is no separate console image.

### Running the CLI

By default the image runs the headless CLI. Mount a working directory and pass CLI arguments:

```sh
docker run --rm -v "$PWD":/work vdorie/psi-link exchange input.csv
```

This is unchanged; existing CLI usage (`exchange`, `invite`, `accept`, and the rest) is backwards compatible.

### Running the web console appliance

Pass `serve` as the first argument to run the single-party console appliance instead. The image bakes the `console` web build (see [Server job API](#server-job-api)), so no build-time configuration is needed; the Nitro server listens on port 3000:

```sh
docker run -d -p 3000:3000 vdorie/psi-link serve
```

That starts the web UI and peer-coordination server only. The server job API stays off until you set `JOB_DATA_ROOT`; enable it by passing the two environment variables and mounting a data volume for the per-job working files:

```sh
docker run -d -p 3000:3000 \
  --env JOB_DATA_ROOT=/data/jobs \
  --env JOB_API_TOKEN=... \
  -v /host/jobs:/data/jobs \
  vdorie/psi-link serve
```

`JOB_CLI_BINARY` is pre-set in the image and needs no operator value. The loopback-or-token rule, why the token is required on a non-loopback bind, and the reverse-proxy caveat are in [Server job API](#server-job-api); a deployment reachable beyond loopback (a published port, or any reverse proxy) must set `JOB_API_TOKEN` or deny `/api/jobs` at the proxy.

### Key file permissions in containers

Automated deployment tooling -- CI runners, container entrypoints, Kubernetes init containers, and orchestration scripts -- must not leave `.psilink.key` readable by other processes or users. Violating this rule defeats the application-layer authentication that protects recurring exchanges.

**Inject via a secrets manager, not the image.** Never copy `.psilink.key` into a container image layer; image layers are readable by anyone with pull access to the registry. Instead, mount the file at runtime:

- **Docker**: mount the key file as a named secret or a host-path bind mount with `--mount type=bind,src=/host/path/.psilink.key,dst=/work/.psilink.key`. Do not mount it read-only; the CLI must be able to write the rotated token after each successful exchange. Set the file's permissions to `0600` on the host before the container starts.
- **Kubernetes**: use a `Secret` volume with `defaultMode: 0600`. Do not use a `ConfigMap` for the key file.
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

## Verifying Windows owner-only file protections

On Windows the CLI protects its owner-only files with ACLs rather than POSIX mode bits, and no automated test leg runs on Windows. The checks below are a manual procedure to run on a Windows host to confirm the owner-only writers still narrow ACLs correctly after a change to their Windows branch. Run them in PowerShell from a scratch directory on an NTFS volume that carries the usual inheritable ACEs (a subdirectory of the user profile is fine); each check produces an artifact you then inspect. `$me` below is the domain-qualified account the CLI narrows the file to; derive it from `whoami`, the same call the CLI uses to name the grant principal, so the comparison matches the granted identity exactly (domain casing and NetBIOS form included).

```powershell
$me = (whoami)
```

Owner-only artifacts on Windows come from three writers: `writeFileOwnerOnly` (the key file, the config writer, exchange records, and the signing identity), `createOwnerOnlyWriteStream` (the result CSV), and `writeFileAtomic` for a file written with the owner-only mode. Produce one artifact from each by running the operations that use them: an exchange writes the result CSV and rotates the key file, `accept` writes the signing identity, and so on (see [CLI.md](CLI.md)). Each check assumes a file at `$f`.

**A narrowed file grants Modify to the current user only, with no inherited or foreign non-owner ACE.** After a writer creates `$f`, its DACL must grant `Modify` to the current user and to no one else, and must not be inheriting from the parent directory:

```powershell
icacls $f
# Expect one line granting the current user (M); no BUILTIN\Users, no (I)
# inherited entries, no other principal.
(Get-Acl $f).AreAccessRulesProtected   # must be True (inheritance stripped)
(Get-Acl $f).Access | ForEach-Object {
  "{0}  {1}  Inherited={2}" -f $_.IdentityReference, $_.FileSystemRights, $_.IsInherited
}
# Every rule must be IdentityReference = $me, FileSystemRights = Modify,
# Inherited = False. Any other principal, or any Inherited = True rule, fails.
```

This is what `writeFileOwnerOnly`, `writeFileAtomic` (owner-only mode), and `createOwnerOnlyWriteStream` all produce: they run `icacls <file> /inheritance:r /grant:r "$me:(M)"`, which strips inheritance and replaces the DACL with the single owner Modify grant.

**`createOwnerOnlyWriteStream`'s overwrite path drops a pre-existing foreign explicit ACE.** The stream writer unlinks and recreates the destination as a fresh inode before narrowing, so a foreign principal's explicit (non-inherited) grant left on a prior file at that path does not survive the overwrite. Seed such a grant on a stand-in file, overwrite it by writing a result CSV to the same path, and confirm the foreign grant is gone:

```powershell
# Seed a pre-existing file with an explicit grant for another principal
# (Guests is present on a default install; substitute any non-owner account).
"stale" | Out-File -Encoding utf8 $f
icacls $f /grant "Guests:(R)"
icacls $f    # confirm the Guests ACE is present before the overwrite

# Now run an exchange whose result CSV output path is $f, then re-inspect:
icacls $f
# Expect only the current user (M); the Guests ACE must be absent. If it
# survived, the fresh-inode overwrite regressed to an in-place narrow.
```

**The load-time over-permissive check flags a loosened ACL.** On load, before reading an owner-only secret (the key file or the signing identity), the CLI runs `warnIfFileOverPermissive`, which on Windows checks the ACL: first via PowerShell `Get-Acl` with SID translation (both inherited and explicit ACEs; SYSTEM and Administrators are exempt), falling back to `icacls` (explicit non-owner ACEs only) where PowerShell is unavailable. Loosen a correctly-narrowed key file and confirm the next CLI load warns:

```powershell
# Grant another principal read on the key file, defeating owner-only.
icacls .psilink.key /grant "Guests:(R)"
```

Run a command that loads the key file (for example `psilink exchange`) and confirm it logs a warning that the file grants access to other users and should be restricted to owner-only. To confirm the `icacls` fallback tier (used where `Get-Acl` cannot run, such as a Nano Server container or a constrained-language environment), repeat with PowerShell unavailable on `PATH`; the warning must still fire. Restore owner-only afterward:

```powershell
icacls .psilink.key /inheritance:r /grant:r "$me:(M)"
```

A clean load emits no such warning, so absence of the warning after restoring the ACL confirms the check clears a correctly-narrowed file.

## See also

- [COMMUNICATION.md](COMMUNICATION.md) - the communication channels and services described here
- [CLI.md](CLI.md) - CLI configuration for connecting to the services described here
