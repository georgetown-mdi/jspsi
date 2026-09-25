---
title: "Alcove Deployment"
---

# Alcove deployment

This document covers the deployment and operation of the supporting services required to run Alcove exchanges, including reference configurations for each service type and Docker deployment of the CLI. It does not cover the communication protocol those services support (see [COMMUNICATION.md](COMMUNICATION.md)) or the CLI commands used against them (see [CLI.md](CLI.md)). Running the same image as the operator's local console is its own document (see [CONSOLE.md](CONSOLE.md)). Intended readers are system administrators and IT staff.

## STUN/TURN

Alcove does not bundle a STUN or TURN server. A deployment needing NAT traversal for WebRTC either points at a commercial ICE-credential service (Twilio Network Traversal Service and equivalents return time-limited credentials on demand; see [COMMUNICATION.md#stunturn](COMMUNICATION.md#stunturn)) or operates a relay of its own.

For the self-hosted case, [`infra/relay/`](../infra/relay/README.md) is a reference deployment of coturn on a dedicated instance: a digest-pinned image, a hardened configuration, the unit that supervises it, ACME certificate renewal, scripts that register and revoke each exchange's relay key, and a verification script. Its README is the operational document -- what to launch, what to open, and the order of operations -- and its [Provenance](../infra/relay/README.md#provenance) section states how far the reference has been driven and what remains undriven. Treat it as a starting point to verify in your own environment rather than a validated configuration.

The reference relay authenticates against a table of per-exchange keys ([Per-exchange keys](../infra/relay/README.md#per-exchange-keys)):

- **One key per exchange.** Each exchange's relay key, derived from its shared secret ([PROTOCOL.md](spec/PROTOCOL.md#relay-credential-derivation)), is a row the relay's operator adds with `register-exchange.sh` and removes with `revoke-exchange.sh`, on the relay host or through the optional HTTPS [registrar](../infra/relay/README.md#the-registrar), which writes the table through the same code for a caller holding the relay-owner token. The relay reads the table per request, so neither needs a restart.
- **What revoking stops.** New allocations under the key. An allocation already open is not cut: a client that keeps refreshing keeps it, past the revoke and past its credential's expiry, and one that stops refreshing loses it within the relay's `max-allocate-lifetime`. The measurements are under Revoking in [Per-exchange keys](../infra/relay/README.md#per-exchange-keys).
- **How long a row lives.** A row registered with a max age in days -- the managed-exchange record's `tokenMaxAgeDays` ([MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#persisted-across-runs)) -- lapses that many days after its registration, and an hourly sweep on the relay revokes it. Each run registers the exchange's next key, which replaces the row and restarts the count, so that registration is the renewal: the relay forgets an exchange at the same bound after which the record's stored secret lapses and a re-invite is needed. A row registered without one, like a record with no max-age policy, lives until it is revoked or replaced. The relay has no setting of its own for this.
- **The static secret during a migration.** A relay may keep its single static secret set beside the table: coturn accepts a credential under either, so credentials minted under the static secret keep working until the operator removes it.

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
limit_req_zone  $binary_remote_addr  zone=alcove_sig_req:10m   rate=10r/s;
limit_conn_zone $binary_remote_addr  zone=alcove_sig_conn:10m;

# Optional Origin allowlist (a browser always sends Origin on a WS upgrade).
map $http_origin $alcove_origin_ok {
    default                        0;
    "https://alcove.example.org"  1;   # replace with your public origin(s)
}

# server{} context: scope the controls to the signaling upgrade location. The `^~`
# prefix makes this match win over the catch-all `location /` and stops a later
# regex location from taking precedence and silently dropping these limits.
location ^~ /api/peerjs {
    if ($alcove_origin_ok = 0) { return 403; }   # remove to skip Origin checks

    limit_req   zone=alcove_sig_req burst=20 nodelay;   # new-connection rate per address
    limit_conn  alcove_sig_conn 32;                     # concurrent connections per address

    proxy_pass          http://alcove_app;              # your upstream
    proxy_http_version  1.1;
    proxy_set_header    Upgrade    $http_upgrade;
    proxy_set_header    Connection "upgrade";
    proxy_set_header    Host       $host;
}
```

The bundled AWS Elastic Beanstalk reference under `apps/web/deploy/aws_eb/` applies the per-address `limit_req`/`limit_conn` on `/api/peerjs` by default -- with the illustrative numbers above, to tune to your load -- and ships the Origin allowlist as a commented-out template you enable by uncommenting the `map` and its matching `if` and setting your public origin (it cannot ship active, because the map defaults to deny and would otherwise reject every client). On a load-balanced environment nginx sees the load balancer's address rather than the client's, so the per-address limits need the real client address recovered from `X-Forwarded-For` to throttle per client instead of collapsing onto one bucket; the reference ships a commented `real_ip` template you scope to the load balancer's subnet(s) -- not the whole VPC, which would let any host in it forge `X-Forwarded-For` -- for that. Confirm the limits suit your load, recover the real client address if you run load-balanced, and enable Origin enforcement if you want it, before exposing a deployment publicly.

#### TLS posture of the bundled reference

The same reference curates the TLS posture of the terminator it ships. The reasoning behind each choice is stated inline in `apps/web/deploy/aws_eb/.platform/nginx/conf.d/https.conf`'s own comments; what an operator has to decide is below.

- **Cipher list -- active.** On top of the TLS 1.2+ floor, an explicit forward-secrecy, AEAD-only `ssl_ciphers` list (ECDHE with AES-GCM / ChaCha20-Poly1305) constrains the TLS 1.2 handshake; TLS 1.3 selects from its own AEAD suites. The floor refuses pre-2014 clients with no ECDHE-AEAD suite (Internet Explorer 11 on Windows 7, Android 4.x, Java 7). If you must serve such a population, widen the list rather than leaving it at this default.
- **Session resumption disabled -- active.** `ssl_session_tickets off` with `ssl_session_cache off`, so every session is a full ECDHE handshake and no resumed session can undercut that forward secrecy. The cost is the resumption round-trip saving, negligible for this low-volume two-party coordination surface. Re-enabling it takes on a rotated, cross-instance-shared `ssl_session_ticket_key` file, which is itself the long-term secret that disabling tickets keeps off disk: keep it owner-only, distribute it only over a secured channel, and rotate it, or the exposure is back.
- **Curve list pinned -- active.** `ssl_ecdh_curve X25519:prime256v1`. Every connection runs a full ECDHE key agreement, so the curve list is pinned explicitly rather than left to the platform default. Unlike the cipher list it applies to both the TLS 1.2 key agreement and the TLS 1.3 key-share. No operator edit is needed.
- **HSTS -- commented opt-in.** It ships inactive because the reference is commonly run with a test or self-signed certificate, and an active `Strict-Transport-Security` header pins HTTPS in the browser: a pinned host cannot be reached over plain HTTP to recover, and a bad certificate cannot be click-through-accepted. For a production deployment with a valid certificate, uncomment the header, start from a short `max-age` and raise it once verified, and leave `preload` off unless you have committed the host to the browser preload list (a one-way step). HSTS is honored only on an HTTPS response, so configure the plain-HTTP redirect at the Elastic Beanstalk load balancer (an ALB HTTP listener that 301s to HTTPS) rather than adding a `:80` server to this nginx config, which would conflict with the platform's own default `:80` server.
- **OCSP stapling -- commented opt-in.** It cannot work on a self-signed certificate, which has no CA-published responder to query, and it further needs infrastructure this config cannot assume: a `resolver` to reach the responder's hostname, and an `ssl_trusted_certificate` issuer chain for `ssl_stapling_verify`. The template holds those directives commented with inline notes on each. Stapling is best-effort, so a misconfiguration serves an unstapled handshake with a logged warning rather than failing to start; after enabling it, confirm it actually staples with `openssl s_client -status` rather than assuming it took.

The forward secrecy above is a property of the TLS hop to this terminator; the PSI exchange's own end-to-end protections do not depend on it.

#### Log retention on the instance

The Elastic Beanstalk platform rotates the nginx logs and the application's stdout and stderr on size alone, so a log that fills slowly keeps its rotated copies for an unbounded time. The reference bounds that: `apps/web/deploy/aws_eb/.platform/hooks/postdeploy/bound_log_retention.sh` rewrites the rotation directives of the platform's logrotate fragments on each deployment to add a daily trigger, a kept-copy count and a maximum age, and leaves the log paths and the rest of each fragment alone. The window is the `RETENTION_DAYS` constant at the top of that script, and the same script is deployed twice, once for an application deployment and once for a configuration-only one.

These are the instance's own disk copies. A deployment that streams the same logs to a log service sets the window there as well, and the two have to agree.

## The project's hosted web deployment

The project runs one public deployment of the web application, for evaluation and demonstration rather than production exchanges of real records; [SHARED_RESPONSIBILITY.md](SHARED_RESPONSIBILITY.md#responsibility-split-hosted-web-application) states what operating it takes on. This section is about that deployment alone. An agency deploying the web application itself configures the reference above and owns every setting in it.

Two environments run the same application, a staging one and a production one, each a single Elastic Beanstalk instance behind a Cloudflare front. Their environment configuration is kept in the repository as one exported file per environment -- `production.json` and `staging.json` under [`apps/web/deploy/aws_eb_saved_configurations/`](../apps/web/deploy/aws_eb_saved_configurations/README.md) -- so a console change that nobody wrote down is a diff rather than a discovery. Each file is an `aws elasticbeanstalk describe-configuration-settings` response rewritten by the `redact.mjs` script beside it, which replaces the account id, the application and environment names, the notification address and the EC2 key name and keeps every other value as exported; that directory's README holds the refresh commands, what each placeholder replaces, and the form the inbound rules take. The settings no export carries -- everything on the Cloudflare side, and the rule list of the shared security group -- are recorded below instead.

Beside the exports, an OpenTofu root, [`infra/hosted/`](../infra/hosted/README.md), describes both environments, the one security group their instances attach, and the Cloudflare zone, and the maintainer applies it from outside the container. Its README holds where its state and credentials live, how it is applied, and how a plan is read for drift. It is applied to both environments and the zone, first on 2026-09-23 UTC; its README records what that run found and the hazard to check before an apply that changes an environment's security groups.

### Which source governs each setting

Two sources in the repository state the environment's settings, and each setting has one that governs it -- the one a change is made in -- while the other records it.

| Setting | Governed by | Recorded in |
| ------- | ----------- | ----------- |
| The option settings `infra/hosted/environments.tf` declares: capacity and instance types, VPC and subnet, the attached security group and `DisableDefaultEC2SecurityGroup`, log streaming and retention, health reporting, the proxy server, the deployment and managed-update policy, the service roles, the notification address, and the application's environment variables | The OpenTofu root | The exported configuration files, re-exported after each apply |
| The option settings the root leaves out: the machine image, the platform's template parameters and launch-control values, the notification topic, the EC2 key pair (absent), and options with no value -- listed in [the root's README](../infra/hosted/README.md#option-settings-it-leaves-out) | The exported configuration files, applied as [below](#applying-a-saved-configuration) | The same files |
| The instances' inbound rules: one security group, `:443` from Cloudflare's published ranges and nothing else. The root declares `DisableDefaultEC2SecurityGroup` `true`, so the platform attaches no group of its own, as the "Security groups" row below records | The OpenTofu root, which reads the ranges from Cloudflare at plan time | `recorded-origin.json` beside the exports, compared daily by [the drift check](#checking-for-certificate-and-range-drift) |
| Cloudflare: the proxy on both public names, SSL/TLS mode, Always Use HTTPS, HSTS | The OpenTofu root | [The recorded values below](#recorded-settings-and-their-source) |
| The application version an environment runs | [`eb_deploy.yaml`](../.github/workflows/eb_deploy.yaml); the root ignores it | Neither |
| The origin certificate | The `cert/` prefix of the deployment bucket, installed by [the route below](#reinstalling-the-origin-certificate) | `recorded-origin.json` and the recorded values below |
| The instance profile's policies (the Session Manager route), the application version lifecycle rule, and the other rows below that neither source expresses | The account, changed by hand | The recorded values below |

A change to a setting the root governs is made in the root and applied; one made in a console is undone by the next apply. The re-export that follows either is the record, not the change.

### Refreshing the configuration after a console change

A setting changed in a console, or by an `update-environment` call, is invisible to the repository until someone exports it. So a console change is finished when the repository states it:

1. If the setting is one [the OpenTofu root governs](#which-source-governs-each-setting), make the change in the root and apply it, or apply the root unchanged to put the setting back; `tofu plan` shows which the console change was.
2. Re-export every environment the change touched, run it through `redact.mjs`, commit the result, and read the diff -- the commands are in that README. A change to something the two environments share -- the instance profile, the shared security group, the certificate objects -- touches both.
3. Update the recorded values below for anything an export does not carry, and move its measurement date to the date the change landed.
4. For a Cloudflare-side change there is nothing to export: the recorded values below are the whole record, and updating them is the step.

### Applying a saved configuration

Applying means replaying a checked-in configuration onto an environment -- after recreating one, or to put a drifted one back. For the settings the OpenTofu root governs, applying is `tofu apply` from [`infra/hosted/`](../infra/hosted/README.md#applying); replaying an export is for the settings the root leaves out, and one that replays a setting the root declares is overwritten by the next apply. It is a separate path from deploying the application: [`eb_deploy.yaml`](../.github/workflows/eb_deploy.yaml) creates an application version from the pushed commit and calls `update-environment --version-label`, and reads nothing from the saved-configuration directory.

- The option settings of a committed file are applied either as a configuration template for the application that the environment is then updated against, or as the option settings of an `update-environment` call. No apply has been run from this repository yet, so the first one is also the verification of the exact commands: run it against staging, and correct the README with what the tool accepted.
- Substitute the replaced identifiers back before applying. A committed file states them as placeholders, which no AWS call accepts.
- Read the file before applying it. An export is a snapshot of the whole environment configuration, so applying an older one replays every other setting that has changed since as well.
- Applying a configuration is a configuration deployment, which does not reinstall the origin certificate. That route is below.

### Reinstalling the origin certificate

The instance serves TLS on `:443` from `/etc/pki/tls/certs`, which the prebuild hook `apps/web/deploy/aws_eb/.platform/hooks/prebuild/download_certificates.sh` fills from the `cert/` prefix of the environment's deployment bucket. Replacing the objects in that prefix installs nothing by itself, and the two routes differ:

- **An application deployment installs what is in the prefix.** When no code change is due, redeploy the version label the environment already runs: `aws elasticbeanstalk update-environment --application-name <application-name> --environment-name <environment-name> --version-label <the label already in place>`. Elastic Beanstalk accepts a label already in place, and the deployment runs the prebuild hook. Measured 2026-09-17 on both environments, about 50 seconds each.
- **A configuration-only deployment does not.** An `update-environment --option-settings` call completed cleanly and left the origin serving the certificate it had before the objects were replaced (measured 2026-09-17, staging).

Both environments read the same `cert/` prefix and the certificate covers both public names, so one upload serves both -- but each environment needs its own redeploy. Upload the replacement, redeploy staging, check the certificate the staging public name serves, then redeploy production.

That measured behavior bounds what the second copy of the hook is good for. `download_certificates.sh` ships twice and byte-identical, as `.platform/hooks/prebuild/` and `.platform/confighooks/prebuild/`, because an application deployment and a configuration deployment run separate hook trees, and a deployment of either kind onto an instance with no certificate on disk fails in the proxy step without it. The measurement above says the configuration-deployment copy does not end with a replaced certificate installed; which part of that path accounts for it is unmeasured. So the confighooks copy stays -- it covers the certificate-load failure that is the reason the hook exists -- and it is not the route for installing a replacement. Both copies stay identical, which `scripts/eb-cert-hook-parity.test.mjs` holds.

### Checking for certificate and range drift

Two values the exports do not carry decide whether the origin keeps answering the edge: the certificate it serves, an expired one answering `Full (strict)` with a 526 on both public names, and its port-443 rule list, a range Cloudflare adds and the rules do not admit showing as an intermittent edge error. `check-origin-drift.mjs` in the saved-configuration directory compares the deployed certificate against a margin and the rules against Cloudflare's published lists; that directory's [README](../apps/web/deploy/aws_eb_saved_configurations/README.md#checking-the-origin-certificate-and-the-cloudflare-ranges) holds its arguments, its exit codes, the read permissions it needs and the recorded values it compares against.

Cloudflare changes its published ranges without notice, so the reconciliation runs daily rather than on a person's cadence: [`origin_drift.yaml`](../.github/workflows/origin_drift.yaml) runs the check at 06:23 UTC and on manual dispatch, assuming a read-only role through GitHub's OIDC token. Its exit code is the result, so a difference or a value it could not read reds the run; a red scheduled run reaches the maintainer the way every other one here does, and nothing else reports drift.

Run it by hand after any change to the origin certificate, the shared security group, or the Cloudflare configuration, and whenever the daily run is red for a reason other than drift -- a throttled AWS call, an unreachable `cloudflare.com`, a role that will not assume -- since a red run for one of those states nothing about the two values. Where that condition outlasts the day it appeared, the by-hand run is the reconciliation until it is fixed, monthly at the least:

```sh
node apps/web/deploy/aws_eb_saved_configurations/check-origin-drift.mjs
```

A run by hand needs read credentials for the AWS account, which no development container holds, so it is the maintainer's to run outside the container. What to do with each result, from the daily run or by hand:

- **A comparison found a difference.** Correct the account first where it is the account that is wrong: issue a replacement Origin CA certificate and install it by the route above when the expiry is inside the margin. When the rules and the published ranges differ, apply [the OpenTofu root](../infra/hosted/README.md#reading-a-plan-for-drift): it reads the ranges from Cloudflare at plan time, so its plan is the list of rules to add and remove. A rule authorized or revoked by hand is removed or put back by the next apply. Then re-run the check and commit the record it prints, which is what the account and Cloudflare now hold. Where the account is already right, the record alone is stale, and committing that block is the whole fix.
- **A comparison could not run.** The run had no credentials for the account, no route to `cloudflare.com`, or an answer it could not read, so a value it compares was never read. It exits 2 rather than 0 and compares nothing in place of what it could not read, so fix the run and repeat it rather than reading a 2 as agreement.

#### Creating the role the scheduled run assumes

The workflow holds no AWS key. It assumes `alcove-origin-drift-check`, a role with the three read calls the check makes and nothing else, which the account holder creates once. The role's recorded values are in the saved-configuration [README](../apps/web/deploy/aws_eb_saved_configurations/README.md#the-scheduled-run-and-the-role-it-assumes); these are the steps that create it. Substitute the account id and the region, and run them with credentials that can write IAM:

1. Confirm the account has GitHub's OIDC provider, which the deploy role already uses: `aws iam list-open-id-connect-providers` states an ARN ending `token.actions.githubusercontent.com`. Create it if it is absent -- `aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com`.

2. Write the trust policy. The condition admits this repository's default branch and nothing else, so a dispatch from any other branch, and any other repository, cannot assume the role:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"
         },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": {
             "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
             "token.actions.githubusercontent.com:sub": "repo:georgetown-mdi@50965319/alcove@1011394533:ref:refs/heads/main"
           }
         }
       }
     ]
   }
   ```

3. Write the permission policy. Each statement is one call the check makes: the account id it reads to name the deployment bucket, the one certificate object in it, and the security group both environments attach. `ec2:DescribeSecurityGroups` names `*` because a Describe call's resource is the whole account; narrow it to the group's ARN where IAM accepts one.

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "ReadTheAccountId",
         "Effect": "Allow",
         "Action": "sts:GetCallerIdentity",
         "Resource": "*"
       },
       {
         "Sid": "ReadTheOriginCertificate",
         "Effect": "Allow",
         "Action": "s3:GetObject",
         "Resource": "arn:aws:s3:::elasticbeanstalk-<region>-<account-id>/cert/public.crt"
       },
       {
         "Sid": "ReadThePort443Rules",
         "Effect": "Allow",
         "Action": "ec2:DescribeSecurityGroups",
         "Resource": "*"
       }
     ]
   }
   ```

4. Create the role and attach the policy:

   ```sh
   aws iam create-role --role-name alcove-origin-drift-check \
     --assume-role-policy-document file://trust-policy.json
   aws iam put-role-policy --role-name alcove-origin-drift-check \
     --policy-name origin-drift-reads --policy-document file://permission-policy.json
   ```

5. Set the role's ARN as the `AWS_ORIGIN_DRIFT_ROLE_ARN` repository secret, and confirm `AWS_REGION_NAME`, which the deploy workflow already reads, is set as a repository variable.

6. Dispatch the workflow from the default branch once and read the run. A role that will not assume, a permission the policy misses, or a region that does not match the one the committed configuration files state all end as a red run naming what it could not read.

### Recorded settings and their source

Three measurement passes on 2026-09-17 established the values this document and the assurance documents rest on: a pass that measured the environment against the responsibility rows, a pass that took the public path to HTTPS end to end, and a pass that put the log window in force. Their records are maintainer notes held outside this repository; each row below names its source -- one of those passes, or a later change to the environment with the date it landed -- and a later measurement replaces the row rather than being added beside it.

The identifiers the deploy workflow keeps as a secret or a variable -- the AWS account id, the application and environment names, and the public names -- are not recorded here, and the committed configuration files replace the account id and the two names wherever an export states them. What the assurance documents rest on is the settings.

| Setting                | Recorded value                                                                                                                                                                                                                                                                                                                                                                                            | Source                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Environment type       | `SingleInstance`, one `t4g.nano` instance with a public address, on the Node.js 24 Amazon Linux 2023 platform. No load balancer on either environment.                                                                                                                                                                                                                                                    | responsibility rows                            |
| On-instance proxy      | `ProxyServer: nginx`, serving the configuration under `apps/web/deploy/aws_eb/.platform/nginx/`.                                                                                                                                                                                                                                                                                                          | responsibility rows                            |
| Public TLS front       | Both public names are proxied through Cloudflare on its Free plan, and public TLS terminates on a Cloudflare-managed edge certificate for the zone.                                                                                                                                                                                                                                                       | responsibility rows, HTTPS                     |
| Edge settings          | Cloudflare SSL/TLS mode `Full (strict)`; Always Use HTTPS on, so plain HTTP to either public name is answered `301` at the edge; HSTS on with `max-age=2592000`, without `includeSubDomains` and without preload.                                                                                                                                                                                         | HTTPS                                          |
| Origin certificate     | A Cloudflare Origin CA certificate covering the zone apex and its wildcard, RSA 2048, valid 2026-09-17 to 2041-09-13, read by both environments from one `cert/` prefix. Nothing triggers its renewal, which is why the expiry is written down here and in `recorded-origin.json` beside the configuration files, where [the drift check](#checking-for-certificate-and-range-drift) reads it.                                                                                                                                                      | HTTPS                                          |
| Origin inbound         | `:443` only, and only from Cloudflare's published ranges as fetched during that pass (15 IPv4 and 7 IPv6). No inbound `:80` and no inbound `:22` from anywhere. [The drift check](#checking-for-certificate-and-range-drift) reconciles the rule against Cloudflare's current list.                                                                                                                                                                            | HTTPS                                          |
| Security groups        | One group, shared by both instances and owned by the OpenTofu root, carries the `:443` rule and is the only group either instance attaches. `DisableDefaultEC2SecurityGroup` is `true` on both environments, so neither has a platform-created group, and a `rebuild-environment` creates none. | OpenTofu apply and rebuild, 2026-09-23 UTC |
| Shell access           | AWS Systems Manager Session Manager is the only route, through `AmazonSSMManagedInstanceCore` attached to the shared instance-profile role `aws-elasticbeanstalk-ec2-role` -- so any later environment on that profile inherits the same access. Neither environment sets an EC2 key pair -- the committed configuration files record the option with no value -- so the platform creates no SSH ingress. | host-side change and re-export, 2026-09-19 UTC |
| Record of shell access | Session logging to S3 or CloudWatch Logs is not configured, so CloudTrail's API records are the only record that a session was opened and by which principal.                                                                                                                                                                                                                                             | HTTPS                                          |
| Log streaming          | `aws:elasticbeanstalk:cloudwatch:logs` with `StreamLogs=true`, `RetentionInDays=90`, `DeleteOnTerminate=false`, on both environments. Leaving deletion off is deliberate: streamed logs outlive a teardown of the environment and expire on the 90-day clock.                                                                                                                                             | log window                                     |
| Streamed files         | Seven log groups per environment, every one at 90 days. The nginx access and error logs, `web.stdout.log`, `eb-engine.log` and `eb-hooks.log` receive lines; the `httpd` pair exists but never receives one on an nginx platform; `web.stderr.log` has no group.                                                                                                                                          | log window                                     |
| Health streaming       | Off (`HealthStreamingEnabled=false`), and the health namespace carries its own `RetentionInDays` of 7, so turning it on streams under a 7-day window until that namespace is set deliberately.                                                                                                                                                                                                            | log window                                     |
| Instance-disk window   | The `RETENTION_DAYS` constant of the postdeploy hook, at 90 days, matching the streamed window ([Log retention on the instance](#log-retention-on-the-instance)). Streaming follows the live file only, so the rotated archives are bounded by this alone.                                                                                                                                                | log window                                     |
| Other AWS log classes  | None: no S3 log publication, no load-balancer logs, no VPC flow logs, no WAF, no CloudFront distribution, and DNS is not in Route 53.                                                                                                                                                                                                                                                                     | responsibility rows                            |
| Deployment artifacts   | Application versions expire after 21 days under the application's own age rule; the deployment logs in the bucket have no lifecycle rule and expire under nothing.                                                                                                                                                                                                                                        | responsibility rows                            |

Values these passes did not measure, unrecorded rather than assumed:

- Cloudflare's retention for the sampled request logs and security analytics it holds on the Free plan. Cloudflare holds request metadata for everything it forwards, under its own policy; the period is not measured.
- Whether Cloudflare caches any response. Every probed path answered as dynamic; static assets were not probed.
- Whether the inbound rules survive a managed platform update. They survive a configuration deployment, and a `rebuild-environment` on each environment, measured 2026-09-23 UTC after [the OpenTofu root's first apply](../infra/hosted/README.md#the-first-run-against-the-live-account).
- The volume and cost of the streamed logs. The stored-bytes figure lagged far behind ingestion at measurement time and was not a usable number.
- Whether an environment recreated under its old name streams into the same log groups. The group names derive from the environment name, but confirming it means tearing an environment down.
- Instance internals -- the rotation fragments and disk use -- on the staging environment. Those were read on production, and staging runs the same platform version.

## Diagnosing web connection failures

By default the web client logs PeerJS connection activity at errors-only, so a normal exchange prints no connection-diagnostic detail to the browser console. This is deliberate: PeerJS's warning-level logs interpolate the remote peer id, and a web exchange's peer ids are rendezvous addresses derived from the invitation secret, which the app keeps out of its logs (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security)).

To diagnose a failing rendezvous or connect against a deployed client without a redeploy, a tester or support engineer can raise that verbosity for a single browser, from the devtools console:

```js
localStorage.setItem("alcove:diagnostics", "1");  // then reload the page
```

With the flag set, the client raises PeerJS to its most verbose level, so the connection-establishment and protocol-anomaly detail that is otherwise suppressed prints to the console. The same flag also re-enables the app's own diagnostic console sinks that a production build suppresses -- the raw exchange-failure `Error` object, with its expandable stack and cause chain, and the acceptor's dial target -- so a failing exchange logs its full structured error for triage. Clear it to return to the errors-only default:

```js
localStorage.removeItem("alcove:diagnostics");     // then reload the page
```

The flag is read once per page load, so set or clear it and then reload. It is scoped to the one browser that sets it (it is not shared with the partner and does not travel in the invitation link), and it persists across reloads until cleared. A development build (`npm run dev`) is in this diagnostic mode by default.

The derived rendezvous peer ids are redacted out of the PeerJS console output before printing, so a verbose capture contains no rendezvous id even with the flag on. It is not, however, unconditionally safe to share: at this level PeerJS also logs connection-establishment detail -- SDP and ICE candidates -- which includes the local machine's private/LAN IP addresses and network topology. Treat a verbose capture as a diagnostic containing network internals: share it only with trusted support, and review it first if your network layout is sensitive. The same caution covers the whole capture, not only the PeerJS lines: the app's own exchange-failure errors the flag re-enables contain the partner's signaling host/port and transport-error text -- the same network-internals class, not invitation secrets, session keys, or record data, which never reach these logs.

### A relay that could not be reached

When a browser exchange uses a relay (a TURN server, from the operator's own relay setting or the invitation) and the connection does not open, the failure alert says whether the relay gave the browser a relay address:

- The relay gave none and the browser reported an error for it: the alert names the relay url and that error -- for example `error 701: Failed to establish connection` for a relay the browser could not reach -- instead of a bare "connection open timed out".
- The relay gave none and the browser reported no error before the connection attempt ended: the alert names the relay url alone. The browser can take longer to give up on an unanswered UDP relay than the exchange waits for the connection.
- The relay gave an address, or no relay is configured: the alert keeps the plain timeout, which points at the path between the two parties rather than at a relay that answered.

Check the relay url, that the relay is running, and that this network allows outbound connections to its host and port. Each party's alert reports the relay its own browser used.

## Console

The web application also runs as the **console**: a single-party graphical front end that drives that party's own `alcove` exchange from a container on the operator's own machine, so an operator creates, watches, and downloads the result of an exchange without invoking the CLI by hand. Turning its job API on, the environment variables and mounts it takes, where to publish its port, and what an operator can author in it are in [CONSOLE.md](CONSOLE.md).

## SFTP server

Alcove does not include or require any particular SFTP server. In practice almost all deployments reuse an existing service: `sshd` on a standard Linux host, with a per-exchange directory whose Unix permissions restrict access to the two partner accounts, is sufficient. The two parties should agree out-of-band on the directory path and on which accounts have access.

No feature of the server is required beyond ordinary SFTP. What an exchange does need is that nothing else edits the directory it runs in: Alcove treats the shared directory as the whole of the exchange's state -- the set of filenames present in it *is* the protocol state (see [FILE_SYNC.md](spec/FILE_SYNC.md#core-principle-the-directory-is-the-state-machine)) -- so a server-side rule that moves, renames, rewrites, quarantines, or deletes a file there is rewriting that state behind both parties' backs. A failed exchange against a commercial or managed SFTP service is more often a server-side setting of this kind than a fault in the exchange, and it reaches the operator as an unexplained stall rather than as a message naming the cause. Work through the checklist below before the first exchange against a server you do not administer yourself, and give the partner's administrator the same list.

### Rendezvous directory checklist

Ordered by what they cost deployments, most damaging first.

1. **No upload-triggered automation on the directory.** Any Event Rule, Monitor, Trigger, or scheduled Task that acts on a newly uploaded file -- moving it to an archive or processing folder, renaming it, or quarantining it -- breaks the exchange, and it is the most common configuration-dependent failure. Alcove publishes every file whose contents the partner reads by writing a `temp-<uuid>.tmp` first and renaming it to the final name, so a partner never reads a partial file under the name it is waiting for. An automation that grabs the temporary file races that rename; one that grabs the final file removes the message the partner is polling for. The result is either a failed publish that ends the run or a partner waiting on a file that is not there until its peer timeout expires. Rules that only notify -- an email, a log entry, a webhook -- are harmless; it is moving, renaming, and quarantining that must be off for this directory.

2. **Exclude the directory from antivirus, DLP, and ICAP scanning.** The files an exchange writes are opaque protocol frames, and an invitation-based exchange encrypts them end to end -- the CLI requests the application-layer AEAD on every file-sync exchange and an invitation is what supplies the session key it needs, so the server and anything reading through it see ciphertext rather than the exchange's contents (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security); a zero-setup exchange has no session key and runs under the SSH transport's encryption alone). The rendezvous files, the key-exchange handshake frames, and the abort marker a failing party leaves sit outside that AEAD and hold no exchange data ([COMPLIANCE.md](COMPLIANCE.md#nist-sp-800-53), SC-8). A scanner therefore has nothing it can classify accurately -- at best it passes the file through, at worst it holds it until a scan completes or quarantines it as unrecognized binary content, which is a deletion as far as the protocol is concerned. Exclude the path rather than tuning the scanner's verdicts.

3. **No aggressive or short-age auto-cleanup.** An exchange spans many poll cycles and can run for hours when the partner reconciles the directory slowly. Alcove removes files itself where the protocol calls for it; a cleanup rule that removes one first -- a hello during rendezvous, or a message the partner has not yet consumed -- costs the exchange with no error naming the cause. It is worse in retain mode, where nothing is deleted as a protocol step and the directory is kept as a permanent transcript by design (see the `retain_files` row in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#sftp-and-file-drop-options)): an age-based sweep there destroys audit material and not only a live exchange. Where a mandatory retention policy cannot exempt the directory, set its age threshold well above the longest exchange you expect to run.

4. **Give the Alcove account rename and delete, not just write.** Two operations beyond `put` are critical. **Rename** is how every file the partner reads is published -- the temp-then-final rename above is what keeps a partner from ever reading a partial file. **Delete** is a protocol step in the default (non-retain) mode: the receiver deletes each message it has consumed, and that deletion is the sender's go-ahead for the next one. It is also how a run clears its own files at close and how a starting run sweeps a temporary file orphaned by a crashed prior attempt.

   Delete has a second, narrower consequence that applies only under [`connection_per_poll`](#a-maximum-session-duration-needs-a-session-per-poll-cycle); the default held-session mode keeps no such record and is unaffected. On a rendezvous directory whose permissions stop this party from unlinking files the partner wrote -- a sticky-bit directory is the usual shape -- a `connection_per_poll` run also leaves some of its *own* temporary files behind. The peer-owned temporary files that the start-of-exchange sweep attempts and cannot delete fill the adapter's record of cleanup deletes it still owes, and while that record stands full a cleanup this party's send path deferred across an idle gap is refused a place in it. The fill clears itself within a few session re-establishments rather than standing for the run -- but a cleanup refused inside that window is issued once and never re-issued, so that one temporary file survives the run. What it costs is directory hygiene: no data is lost, nothing hangs, and no exchange fails. The mechanism, the constants, and what the bound rests on are the second stated limit in [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#the-deferred-cleanup-delete-record).

5. **Allow-list the parties' client addresses, and give each party its own account.** Alcove polls the directory on a cadence and re-dials after a dropped session, which an anti-flood or auto-ban rule can read as abuse. Some products (Cerberus FTP Server and Titan FTP among them) offer a permanent ban as the response, which turns one transient network drop into a lockout that outlives the exchange; check whether yours does and what its ban duration and thresholds are. Allow-list both parties' client addresses so the rule cannot fire against them. Give each party its own account as well: the two parties are connected concurrently, so a shared account collides with per-account maximum-login and maximum-connection limits, and distinct accounts are also what make the directory permissions above meaningful per party.

### Server-enforced session limits

Two server limits are easily confused with each other, and Alcove answers them differently. Establish which one your server enforces before configuring anything.

#### An idle timeout is already handled

Servers commonly close a session that has gone quiet for some window; Azure Blob Storage's SFTP endpoint uses a fixed two minutes that is not operator-adjustable. An exchange does go legitimately quiet: one party polls while the other computes its reply, which on modest hardware runs for minutes with no file traffic at all.

Alcove covers this itself, with nothing to configure. The SFTP adapter issues a real no-op SFTP command on a fixed interval once a session has been idle for it, so a server keying idleness on the last SFTP **request** sees activity. The interval is a constant rather than a setting, sized below the tightest fixed idle window it must survive -- Azure's two minutes; the value and the reasoning are in [CHANNEL_SECURITY.md](spec/CHANNEL_SECURITY.md#sftp-session-heartbeat-and-tcp-keepalive). A TCP or SSH-transport keepalive is not a substitute for it, and Alcove does not rely on one here: transport traffic rides below the SFTP protocol and does not reset a timer keyed on SFTP requests.

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

Object-store SFTP front-ends -- AWS Transfer Family over S3, Azure Blob Storage's SFTP endpoint, Google Cloud Storage bridges -- do work with Alcove. Run them in **retain mode**, the configuration they are intended for: set `retain_files` on both parties, and on the command line `--retain-files` supplies the two settings it requires, `lockless_rendezvous` and `timestamp_in_filename` (see the rows in [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#sftp-and-file-drop-options)). Retain mode rendezvouses through an acknowledgment-marker barrier instead of the default exclusive-create lock race, and exclusive create is the one operation an object-store front-end may not honor the way the lock path needs, so configuring retain mode answers that question rather than leaving it to the backend. Retain mode is bilateral: both parties set it, and a mismatch fails fast at rendezvous rather than stalling. A front-end that implements rename as copy-then-delete is not a problem in either mode, because Alcove never renames onto a name that already exists and a reader waits for a message's declared byte count before reading it.

Two of the checklist items above still apply, and retain mode makes the first of them more pressing rather than less:

- **Keep the rendezvous prefix out of every lifecycle and auto-expiry rule** (S3 Lifecycle, Azure lifecycle management, and their equivalents). Retain mode leaves the exchange's files in place as a durable transcript, so they linger longer than in the default mode and an expiry rule is correspondingly more likely to reach them -- during an exchange as well as after it.
- **No upload-triggered move or quarantine automation, and no antivirus/DLP scanning on the prefix.** These are orthogonal to the rendezvous mode and reach a retain-mode exchange exactly as they reach any other.

### Negotiating only FIPS-approved algorithms

A deployment required to use FIPS-approved cryptography constrains what the SSH layer will negotiate from the connection's own configuration, with no server-side cooperation needed. The settings to apply, what each excludes, what happens when the partner's server offers nothing approved, and the host-key gap no client-side setting can close are in [FIPS_SFTP_PROFILE.md](FIPS_SFTP_PROFILE.md).

### Local development and testing

For local development and integration testing, the project's test suite stands up its own SFTP server (an in-process `ssh2.Server` by default, or a native OpenSSH `sshd` child process). That setup is intended for testing the CLI's transport behavior against a known-good server and is not a production reference.

## Docker deployment

The published image `ghcr.io/georgetown-mdi/alcove` runs in either of two roles depending on its first argument; there is no separate console image.

`ghcr.io/georgetown-mdi/alcove` publishes two variants of that one image, differing only in what serves the cryptography beneath them. The unsuffixed tags (`X.Y.Z`, `X.Y`, `latest`) are the default artifact and the one every command in this document names. The `-fips` tags (`X.Y.Z-fips`, `X.Y-fips`, `latest-fips`) include a CMVP-validated OpenSSL FIPS provider instead, at roughly 1.8x the size and with the SFTP restrictions in [FIPS_SFTP_PROFILE.md](FIPS_SFTP_PROFILE.md); take one only under a FIPS obligation. Which artifact has which posture is in [RELEASES.md](RELEASES.md#which-image-has-which-posture), and what may be claimed of the variant is in [COMPLIANCE.md](COMPLIANCE.md#fips-140). Everything below holds for both.

### The user the image runs as

Both roles run unprivileged in both variants. Left alone they run as the image's `node` account, **uid 1000, gid 1000**; both also run as an account you name with `--user`, which is the subject of "Running as your own account instead" below. What the posture rests on is that neither role runs as root: nothing in an exchange holds the privilege to write outside what you mounted, and the program files inside the container belong to `root`, so the running process cannot rewrite its own code. The number 1000 is the base image's default rather than something Alcove requires of you.

What the default account asks of you is bind-mount ownership. A bind mount keeps its host directory's ownership inside the container, so every directory the container writes -- `/work` for the CLI, and the data, input, and rendezvous mounts for the console -- has to be writable by uid 1000, and every file it reads has to be readable by it. Which case below applies is decided by the container engine, not by the operating system: Docker Desktop is available for Linux too.

- **Docker Desktop**, on macOS, Windows, or Linux, presents a bind mount to whichever user the container runs as, so there is nothing to do: the commands in this document and in the quickstart work as written.
- **Docker Engine on Linux** passes the host directory's real ownership through. A directory created by an account that is itself uid 1000 -- the usual case on a single-user workstation -- is already owned by the account the container runs as. Otherwise hand the working directory to that uid once, before the first run:

  ```sh
  sudo chown 1000:1000 /host/work
  ```

  The `sudo` is required: giving a file away to another uid is privileged, and without it the command answers `Operation not permitted`.

  **If you have run this image before**, the directory needs more than that. Earlier images ran as root, so any `alcove.yaml`, `.alcove.key`, or results file already in the directory belongs to root at mode `0600`: unreadable to uid 1000 whatever the directory around them says, and untouched by a chown of the directory alone. Hand the contents over with it:

  ```sh
  sudo chown -R 1000:1000 /host/work
  ```

  Watch the read side too: a working directory or input file that no other account can read (mode `0700`, `0600`) is unreadable inside the container even when it is yours on the host.

- **A CIFS network-share volume** -- the Docker volume the Windows file-drop scripts create over `//server/share` -- has no host ownership to pass through: a Windows SMB server serves no Unix owner for the mount to read, so the client presents the whole tree as owned by whatever the volume's `uid=` and `gid=` mount options name, and root when they name nothing. The volume must therefore pin `uid=1000,gid=1000`, which is what `Setup-AlcoveFileDrop.ps1` and its Command Prompt counterpart create it with; a volume made by hand without them mounts and then refuses every write. Ownership is mapped rather than enforcement switched off, so the share's own access control still decides what the mount credential may do.

**Running as your own account instead.** Where changing the directory's ownership is not an option, run the container as yourself:

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD":/work ghcr.io/georgetown-mdi/alcove exchange input.csv
```

The container then runs as an account the image knows nothing about, and `HOME` is not a question that arises. Alcove chooses no path under the home directory for anything: it reaches for the home directory only to expand a `~` you wrote yourself, so an ephemeral or unset `HOME` changes no path Alcove picks. It still resolves the ones you spell with a `~` against whatever home the container has, which in an ephemeral one is a different directory on every run -- so write those paths out in full. The signing identity, the one long-lived credential the CLI holds, is written and read only where you name it (see [Mounting the signing identity](#mounting-the-signing-identity)).

**The console takes the same route.** `serve` keeps the signing identity in the mounted data root by default, or at a file the operator picks in the secrets mount, and refuses a shared-directory exchange whose rendezvous folder holds the identity's folder, since the run would publish the key (see [CONSOLE.md](CONSOLE.md#signing-a-receipt-and-noting-where-the-result-is-filed)). Its one container-internal write outside the mounts is the directory a pasted SFTP credential is materialized to, which the image creates under root-owned `/run` for its own account; point `JOB_SFTP_CREDENTIAL_DIR` at a path the account you named can create instead:

```sh
docker run --rm -p 127.0.0.1:3000:3000 \
  --user "$(id -u):$(id -g)" \
  --env JOB_SFTP_CREDENTIAL_DIR=/tmp/alcove-sftp-credentials \
  --env JOB_DATA_ROOT=/data \
  -v /host/work:/data \
  ghcr.io/georgetown-mdi/alcove:latest serve
```

The path must sit outside every folder you mounted -- the data root, the input directory, the rendezvous directories, and the secrets directory -- or the console refuses to start rather than put a pasted secret where your results or your partner's sync are. It is container-internal and goes with the container, which is what `--rm` is doing above. The variable is not optional once you name an account: the default directory is one only the image's own account can create, and a console that cannot create the directory it is given refuses to start, naming this variable in the refusal.

**The console launcher does all of this for you.** On macOS and Linux, the `start-alcove.sh` published with each release runs the container as the account that started it, passes the scratch-directory override with it, and runs the container's own `alcove doctor mount` checks over every folder it is about to mount, as that same account, before the console starts. The folders the console writes in -- the data root and the rendezvous folder -- have to pass the write checks. The input folder has to be readable and nothing more, so a read-only input mount passes it, and the launcher binds it read-only in the container besides. Under `sudo` -- the usual workaround for an account outside the docker group -- it runs the container as the account `sudo` came from; started from a root login with no account to name, it passes no `--user` at all and leaves the image's own account to run it.

**On Windows, `Start-Alcove.ps1` fills the same variables from folders the operator picks.** It asks whether the partner named one shared folder or a pair and sets `JOB_RENDEZVOUS_DIR` alone, or that variable and `JOB_RENDEZVOUS_OUTBOUND_DIR` together, with `JOB_RENDEZVOUS_NAME` and `JOB_RENDEZVOUS_OUTBOUND_NAME` beside them (the variables themselves are in [CONSOLE.md](CONSOLE.md#turning-the-job-api-on)). A pair is never provisioned by halves: one folder given without the other is refused rather than run as a single-folder console, matching the console's own refusal.

Two folders on one share take **one** network-share volume, over the folder that holds them both, with each folder passed as a path under it -- the launcher creates no volume it can later remove, so it creates as few as the run needs. That folder is the share root when the two sit far apart, and the container then reaches the whole share: keep the pair side by side inside one exchange folder. Two folders on different shares or different servers have no folder above them both, and take a volume each.

**What a mis-owned mount looks like.** The failure names `EACCES` and the path it could not write. Those paths are relative -- the key file and config default to `./.alcove.key` and `./alcove.yaml`, resolved against the container's working directory -- and where the failure lands depends on the command:

- `alcove exchange` stops up front, at the key-file preflight, with `key file parent directory . is not writable: EACCES: permission denied, open '.alcove-write-probe-<pid>-<hex>'. Restore write access ...`. It stops there by design, before any key exchange, so nothing is half-done.
- `alcove accept` has no such preflight: the terms are displayed and confirmed, and the write that follows fails with `EACCES: permission denied, open './alcove.yaml.tmp.<pid>'` and exit 69. Nothing is spent -- the invitation is still good -- but the ownership has to be fixed and `accept` run again.
- An existing `alcove.yaml` that the container cannot read fails earlier still, at config load: `config file ./alcove.yaml could not be read: EACCES: permission denied, open './alcove.yaml'`. A file owned by root rather than uid 1000 is what produces this, and the recursive `chown` above is what clears it.

In all three the remedy is ownership, not mode: a `chmod` on a directory or file the container's account does not own changes nothing it can reach.

### Running the CLI

By default the image runs the headless CLI. Mount a working directory and pass CLI arguments:

```sh
docker run --rm -v "$PWD":/work ghcr.io/georgetown-mdi/alcove exchange input.csv
```

What the container needs to reach while it runs, and how to hold it to that, is in [Restricting the container's outbound network access](#restricting-the-containers-outbound-network-access).

### Running the console

Pass `serve` as the first argument to run the console instead. It takes a published port and at least one mount; the commands for each mount layout are in [Running the container](CONSOLE.md#running-the-container).

### Restricting the container's outbound network access

An exchange gives the container one reason to reach the network: the SFTP connection to the server the two parties agreed on. Holding its outbound access to that one endpoint is defense in depth -- were the process ever compromised, through a dependency vulnerability or partner-supplied material that got past the protocol's own bounds, an egress allowlist bounds what it could reach or exfiltrate to. No exchange needs it to work and nothing in Alcove depends on it; it is hardening an operator applies.

`docker run` has no egress allowlist of its own, and the image runs unprivileged (see [The user the image runs as](#the-user-the-image-runs-as)), so nothing inside the container can set network rules for itself either. Restricting egress is therefore host configuration rather than a container flag. What each role needs outbound:

- **A shared-directory (filedrop) exchange needs no egress at all**, in either role. The rendezvous directory is a mount, and the host performs whatever network file access it stands for, so the container itself reaches nothing.
- **An SFTP exchange needs TCP to the server's host and port**, plus name resolution for that host unless it is named by address. This is the same in both roles: the console drives the same CLI as a subprocess inside the same container, and the console's "read the fingerprint from the server" probe reaches that same endpoint.
- **The console's own web and job-API traffic is inbound, not egress.** The browser connects in over the published loopback port, and the console serves its assets and its peer-coordination server from inside the container. `-p 127.0.0.1:3000:3000` governs who may reach in and stays exactly as it is (see [Running the console](#running-the-console)).

#### No egress at all

For a shared-directory exchange on the CLI, take the network away outright:

```sh
docker run --rm --network none -v "$PWD":/work ghcr.io/georgetown-mdi/alcove exchange input.csv
```

This is the strongest option here and the only portable one -- a `docker run` flag with no host configuration behind it. It is not an option for the console, whose browser traffic has to reach the published port; a console that will only ever run shared-directory exchanges takes the allowlist below with no SFTP entry in it, which denies the same traffic outbound.

A network file drop is the one place where something still reaches out: `alcove doctor probe` talks to the SMB server from inside the container (see [Checking a network file drop](CLI.md#checking-a-network-file-drop)). Run the checks before you take the network away, or allow tcp/445 to the file server while you run them. The exchange itself, over the mounted directory, still needs nothing.

#### An allowlist for an SFTP exchange

These steps are host-specific and Linux-only. They assume Docker Engine on a Linux host with its default iptables integration (the daemon's `iptables` setting left on), and root on that host to write firewall rules. The rules are host state: they govern every container on the network you create, they do not travel with the image or a Compose file, and they last until you delete them or the host reboots -- persist them with your distribution's own mechanism (`iptables-persistent`, a `firewalld` direct rule, a systemd unit) if the deployment is a lasting one.

**Docker Desktop -- on macOS, Windows, or Linux -- and rootless Docker do not work this way.** The container's traffic is routed inside a virtual machine or a user-mode network stack these rules do not reach, and neither engine offers a supported equivalent. There, `--network none` above still restricts a shared-directory exchange, while an SFTP exchange's egress restriction has to come from the host's own firewall or from the network the machine sits on -- which covers the whole machine rather than this container.

**1. Give the container a network of its own, with a subnet you chose.**

```sh
docker network create --subnet 172.31.240.0/29 alcove-egress
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

The explicit rule numbers are critical. `-I` inserts at the position you give it and at the top of the chain when you give none, so numbering them is what keeps the `DROP` last instead of first; `-A` would append past the chain's own trailing `RETURN`, where a rule is never reached. Read the result back with `sudo iptables -L DOCKER-USER -n --line-numbers` before running anything against it, and verify it as below rather than trusting the listing.

**3. Run the container on that network.** Nothing else about either invocation changes.

```sh
# Headless CLI
docker run --rm --network alcove-egress --dns 192.0.2.53 \
  -v "$PWD":/work ghcr.io/georgetown-mdi/alcove exchange input.csv

# Console
docker run --rm --network alcove-egress --dns 192.0.2.53 \
  -p 127.0.0.1:3000:3000 \
  --env JOB_DATA_ROOT=/data \
  -v /host/work:/data \
  ghcr.io/georgetown-mdi/alcove:latest serve
```

`--dns` names the resolver the container uses, so the address the rules permit is one you chose rather than whatever the host's `/etc/resolv.conf` happens to hold. Drop the flag along with the two resolver rules if you pin the server by address.

#### Substituting your own endpoint

`SFTP_ADDR` and `SFTP_PORT` stand for the server the two parties agreed on; there is no built-in endpoint to allow.

- **Headless CLI**: `connection.server.host` and `connection.server.port` from your `alcove.yaml`, the port being 22 when unset (see [`connection.server`](EXCHANGE_REFERENCE.md#connectionserver)).
- **Console**: the host and port you enter when you author the connection in the console (see [Authoring the SFTP connection](CONSOLE.md#authoring-the-sftp-connection)). Re-authoring against a different server means revisiting the rules.

A hostname that resolves to several addresses needs a rule per address. Confirm the set with `dig +short <host>` and re-confirm it whenever the server's operator changes anything: an address that moves out from under the allowlist stops the exchange with a connection failure rather than a warning.

**Pinning the server by address instead.** Naming the server by address in the connection takes name resolution out of the picture entirely: drop the two resolver rules and the `--dns` flag, and the allowlist is one endpoint and nothing else. What authenticates the server is its host key, pinned as `host_key_fingerprint` -- mandatory for a console-authored connection, and effectively so for a containerized CLI run, which has no terminal and so fails closed rather than establishing trust on first use (see [SFTP host-key trust](CLI.md#sftp-host-key-trust)). Identifying the server by address therefore costs no authentication. What it costs is maintenance: an address the server's operator changes has to be changed in the configuration and in the rules.

#### Verify it rather than assuming it

An allowlist that silently drops name resolution, and one whose `DROP` sits above the rules meant to permit anything, both look identical to a working one until an exchange fails. Check both directions with `probe-host-key`, which connects far enough to read the server's host key and sends no credential (see [Reading a host key with `probe-host-key`](CLI.md#reading-a-host-key-with-probe-host-key)); it exits 0 when it reached the server and 69 when it could not.

```sh
# Permitted: the endpoint you allowed. Prints a fingerprint, exits 0.
docker run --rm --network alcove-egress --dns 192.0.2.53 \
  ghcr.io/georgetown-mdi/alcove probe-host-key sftp://sftp.partner.example --connect-timeout 10s

# Blocked: the same host on a port you did not allow. Exits 69.
docker run --rm --network alcove-egress --dns 192.0.2.53 \
  ghcr.io/georgetown-mdi/alcove probe-host-key sftp://sftp.partner.example:2222 --connect-timeout 10s

# Blocked: a host you did not allow. Run it a second time without
# `--network alcove-egress`: a probe that fails for its own reasons proves
# nothing, so it has to succeed off the restricted network to count.
docker run --rm --network alcove-egress --dns 192.0.2.53 \
  ghcr.io/georgetown-mdi/alcove probe-host-key sftp://some.other.host --connect-timeout 10s
```

A blocked endpoint answers nothing rather than refusing, so each blocked row takes about its `--connect-timeout` to exit: the probe dials once, and that value is the whole wait.

Probing by name is also the name-resolution check, since it succeeds only if the container both resolved the name and reached the address. A probe that fails by name and succeeds against the address says resolution is what the rules are dropping -- permit the resolver, or pin the server by address.

These steps are executed, not only written: Alcove's image smoke workflow (`.github/workflows/image_smoke.yaml`) creates the network, writes these rules into `DOCKER-USER`, and asserts each row above against the image it has just built -- the permitted endpoint read by name, the denied port and the denied host refused, each of the three reached again off the restricted network, and the by-name probe refused once the resolver rules are removed. What that establishes is that the mechanism works as written on a current Docker Engine. Your own subnet, resolver, server address, and port are still yours to check here.

Finally, start the console once on the restricted network and confirm it still loads at `http://127.0.0.1:3000`. The publish binding governs what arrives at the container and these rules govern what leaves it, but a mistake in either is worth catching before an exchange rather than during one.

#### What the restriction does not cover

- **The host and the operator's browser are unaffected.** This bounds one container's reach, not the machine's.
- **Name resolution is a permitted channel whenever you allow a resolver.** Pin the server by address and drop the resolver rules if you need that closed too.
- **Traffic the host delivers to itself is not forwarded**, so `DOCKER-USER` is not where a container reaching a service on the host's own address is decided; close that at the host's `INPUT` chain if it matters to you.
- **It is not a substitute for the controls that protect the exchange.** The partner's material is untrusted whatever the container may reach, and what bounds it is the exchange protocol itself (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security)); what bounds who reaches the console is the publish binding (see [Reachable only where you publish it](CONSOLE.md#reachable-only-where-you-publish-it)).

### Key file permissions in containers

Automated deployment tooling -- CI runners, container entrypoints, Kubernetes init containers, and orchestration scripts -- must not leave `.alcove.key` readable by other processes or users. Violating this rule defeats the application-layer authentication that protects recurring exchanges.

Owner-only and the container's identity are one question here, not two: a `0600` file grants nothing to anyone but its owner, so the account the container runs as (see [The user the image runs as](#the-user-the-image-runs-as)) has to be that owner. A key file owned by some other uid is not merely unwritable from inside the container -- it is unreadable, and the exchange fails before it starts.

**Inject via a secrets manager, not the image.** Never copy `.alcove.key` into a container image layer; image layers are readable by anyone with pull access to the registry. Instead, mount the file at runtime:

- **Docker**: bind-mount the directory that holds the key file, read-write, and name the file inside it with `--key-file`: `--mount type=bind,src=/host/path/secrets,dst=/run/secrets` with `--key-file /run/secrets/.alcove.key`. Do not mount the key file on its own: the CLI saves the rotated token after each successful exchange by writing a new file beside the old one and renaming it into place, and a rename onto a file that is itself a mount point fails (`EBUSY`). On Linux the key-file pre-flight refuses such a mount before the key exchange; elsewhere the save fails after it, and both parties must re-invite. For the same reason do not use a read-only mount or a Docker secret, which is mounted read-only. Set the directory's owner to uid 1000 and the file to mode `0600` and owner uid 1000 on the host before the container starts.
- **Kubernetes**: use a `Secret` volume with `defaultMode: 0600`. Do not use a `ConfigMap` for the key file. Set the pod's `securityContext` so the projected file belongs to the identity the container runs as; a `0600` file the container's uid does not own is unreadable to it.
- **CI runners**: write the token to a temporary file with `install -m 0600 /dev/stdin .alcove.key <<< "$TOKEN"` (bash) or `printf '%s' "$TOKEN" | install -m 0600 /dev/stdin .alcove.key` (POSIX sh) rather than `echo "$TOKEN" > .alcove.key`, which may leave a world-readable file depending on the runner's umask.

**Separate read-only config from read-write secrets.** If the working directory (containing `alcove.yaml` and input data) is mounted read-only - for example to prevent the container from modifying source data - mount a separate read-write volume for the key file and use `--key-file` to redirect the CLI. One exception needs the directory holding the config writable: under `signing.mode: certificate` a first contact with a partner you have not pinned records the fingerprint it adopts into `alcove.yaml` by renaming a new file over it (see [CLI.md](CLI.md#pinning-the-partners-certificate)), so either set `signing.partner_fingerprint` before that run or mount the configuration writable for it - a run that can do neither is refused before it connects:

```sh
# Docker
# /run/secrets must be read-write; the CLI writes the rotated token after each successful exchange
docker run \
  --mount type=bind,src=/data/config,dst=/work,readonly \
  --mount type=bind,src=/data/secrets,dst=/run/secrets \
  ghcr.io/georgetown-mdi/alcove exchange input.csv --key-file /run/secrets/.alcove.key
```

```yaml
# Kubernetes: separate secretsDir volume alongside a read-only configMap mount
volumes:
  - name: config
    configMap:
      name: alcove-config
      defaultMode: 0444
  - name: secrets
    secret:
      secretName: alcove-key
      defaultMode: 0600
containers:
  - name: alcove
    volumeMounts:
      - name: config
        mountPath: /work
        readOnly: true
      - name: secrets
        mountPath: /run/secrets
    args: ["exchange", "input.csv", "--key-file", "/run/secrets/.alcove.key"]
```

The `--key-file` flag is accepted by both `exchange` (reads the token on start and writes the rotated token back to the same path after a successful exchange) and `zero-setup` (specifies the output path when `--save` is used).

**Verify before first exchange.** After injecting the key file, verify its permissions before running `alcove exchange`:

```sh
stat -c "%a %n" .alcove.key   # Linux
stat -f "%Lp %N" .alcove.key  # macOS
```

The output must show `600`. If it does not, the CLI will emit a warning on load; correct the permissions before proceeding.

The manual procedure for confirming the Windows owner-only writers still
narrow ACLs correctly is in [TESTING.md](TESTING.md#verifying-windows-owner-only-file-protections).

### Mounting the signing identity

The signing identity is the CLI's other credential file, and it is not the key file: the shared secret rotates every exchange and must be written back, while the signing identity is a long-lived P-256 private key that must stay byte-for-byte stable, because a partner pins its fingerprint once and every later receipt verifies against it. Mount them differently.

Alcove resolves no location for it. Name the path with `signing.identity_file` in the configuration, or `--identity-file` on the command line; a certificate-mode exchange configured with neither is refused before it connects. See [CLI.md](CLI.md#where-the-signing-identity-lives).

**Give it a mount of its own, and mount that read-only.** The identity is created once, by `alcove fingerprint`, which is the only command that writes it; an exchange and an `alcove verify-receipt` read the file and write neither it, its directory, nor anything beside it. That is the reason it does not go in the `/run/secrets` mount above: the rotating key file is what makes that mount read-write, and the identity has no reason to inherit the requirement.

The console holds the same rule against a signing identity it reads from the mount it browses: it creates the identity only at its own default location in the data root, so a directory named through the console's identity option is read and not written, with one exception -- an identity removed between the console's presence check and the `alcove fingerprint` child's load, which that child creates at the picked path. The certificate export goes to the data root, and no `alcove.yaml` in that directory ever becomes the child's config. Mount it read-only there too, which closes that one case.

Provision it once, against a directory writable for that one command:

```sh
docker run --rm \
  --mount type=bind,src=/data/signing,dst=/run/signing \
  ghcr.io/georgetown-mdi/alcove fingerprint \
  --identity-file /run/signing/alcove-signing-identity.json \
  --identity "Agency A, a@agency-a.gov"
```

Then mount it read-only for every exchange thereafter, beside the read-write mount the key file needs, with `signing.identity_file: /run/signing/alcove-signing-identity.json` and `signing.receipt_output: /run/secrets/alcove-receipt.json` in the mounted `alcove.yaml`. Point the exchange record there too: the image's `WORKDIR` is `/work`, which this example mounts read-only, and a signed run's receipt and record both default to a path under the working directory -- a write that fails there is non-fatal and only warns, so leaving either at its default here would complete the exchange while landing neither.

**A fixed path keeps only the latest run.** `--record-file` and `signing.receipt_output` each name one file, and every run replaces it, the record's verification-keys file included, so the example below holds only the most recent exchange's record and receipt. Where the history matters -- an accounting of disclosures, for one -- copy both out after each run, or give the record a per-run name from the scheduler, for example `--record-file "/run/secrets/alcove-record-$(date -u +%Y%m%dT%H%M%SZ).json"`. `signing.receipt_output` is read from the configuration and has no per-run form, so the receipt has to be copied out.

```sh
docker run \
  --mount type=bind,src=/data/config,dst=/work,readonly \
  --mount type=bind,src=/data/secrets,dst=/run/secrets \
  --mount type=bind,src=/data/signing,dst=/run/signing,readonly \
  ghcr.io/georgetown-mdi/alcove exchange input.csv --key-file /run/secrets/.alcove.key \
  --record-file /run/secrets/alcove-record.json
```

```yaml
# Kubernetes: the signing identity is a second Secret volume, mounted read-only
volumes:
  - name: signing
    secret:
      secretName: alcove-signing-identity
      defaultMode: 0600
containers:
  - name: alcove
    volumeMounts:
      - name: signing
        mountPath: /run/signing
        readOnly: true
```

Two more things, whichever platform you are on:

- **Make the host directory durable, and back it up.** Losing the file means minting a new identity with a new fingerprint, which every partner must re-pin before your receipts verify again.
- **Never put it in a directory the partner writes into.** In a file-drop exchange the rendezvous directory is exactly that, and a signing identity there hands the partner the private key that signs for you with every partner, not only the one you share the folder with. On the command line nothing checks this for you: the path is the one you named. The console does check its own mounts and refuses such a run, whichever directory holds the identity it was pointed at (see [CONSOLE.md](CONSOLE.md#signing-a-receipt-and-noting-where-the-result-is-filed)).

## See also

- [COMMUNICATION.md](COMMUNICATION.md) - the communication channels and services described here
- [CLI.md](CLI.md) - CLI configuration for connecting to the services described here
- [CONSOLE.md](CONSOLE.md) - running the image as the operator's local console: its mounts, environment variables, and what an operator authors in it
- [FIPS_SFTP_PROFILE.md](FIPS_SFTP_PROFILE.md) - constraining an SFTP exchange's SSH negotiation to FIPS-approved algorithms
