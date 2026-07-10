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

## SFTP server

PSI-Link does not include or require any particular SFTP server. In practice almost all deployments reuse an existing service: `sshd` on a standard Linux host, with a per-exchange directory whose Unix permissions restrict access to the two partner accounts, is sufficient. The two parties should agree out-of-band on the directory path and on which accounts have access; nothing more is required of the server beyond that.

For local development and integration testing, the project's test suite stands up its own SFTP server (an in-process `ssh2.Server` by default, or a native OpenSSH `sshd` child process). That setup is intended for testing the CLI's transport behavior against a known-good server and is not a production reference.

## Docker deployment

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

## See also

- [COMMUNICATION.md](COMMUNICATION.md) - the communication channels and services described here
- [CLI.md](CLI.md) - CLI configuration for connecting to the services described here
