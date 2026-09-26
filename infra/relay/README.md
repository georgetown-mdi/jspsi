# The Alcove standing relay: a reference for a dedicated instance

Everything needed to bring up a self-hosted TURN relay that carries an Alcove
WebRTC exchange for a party on a network that blocks UDP or admits only TCP/443:
a digest-pinned coturn image, a hardened configuration, the systemd unit that
supervises it, an ACME renewal that keeps its certificate current, scripts that
register and revoke each exchange's relay key, an optional HTTPS registrar that
does the same for a caller holding the relay-owner token, a sweep that revokes
lapsed keys, and a verification script that asks the deployed relay whether it
is doing its job.

The relay runs on a **dedicated instance**, provisioned from this reference
rather than configured by hand. [`aws/provision.md`](aws/provision.md) is how one
is launched on AWS; the two `demo-*.sh` scripts beside it stop and start the
separate always-on demo box, which carries the demo SFTP server and is not this.

## What the relay sees

**The relay carries the encrypted WebRTC channel and nothing else.** A TURN
server forwards DTLS without terminating it, so what passes through it is
ciphertext: it sees addresses, timing, and volume, and no exchange data at any
point. That is not a design intention -- it was measured. An interception point
sitting on the relay path read only the STUN and TURN envelope, about 13 KB each
way, while both parties still resolved the correct intersection (see
[the deployment record](../../docs/notes/webrtc-relay-deployment.md), question 1,
and [SECURITY_DESIGN.md](../../docs/SECURITY_DESIGN.md#channel-security) for the
posture the measurement confirms).

The consequence for an agency reviewing a deployment: the relay is not a place
where personal data is processed, and hosting it does not put the host inside the
data path. A party that will not accept a relay it does not operate can run this
one itself, which is the whole reason a self-hosted reference exists beside the
managed option.

## Provenance

Agent-authored, and a proposal rather than ratified infrastructure: read every
claim here as something to check. **A relay has been stood up from it, on the
docker path.** One instance -- the stock AL2023 arm64 AMI
[`aws/provision.md`](aws/provision.md) prescribes -- was driven end to end on
2026-09-03/04: the image built from the pinned digest, the container's uid was
probed (65534), a real Let's Encrypt certificate was issued by DNS-01 through
Cloudflare and deployed, the configuration rendered, TURNS bound on 443, an
outside TLS handshake was verified from a third network against the public
name, allocations were driven with `turnutils_uclient`, an allocation toward an
internal address was confirmed refused, and `verify.sh` finished 6 pass / 0
fail / 0 unclear from `install.sh`'s own end-of-install run.

**The podman/Quadlet path has been driven on a stand-in host, not an
instance.** On 2026-09-24 `install.sh` installed the relay under
`alcove-relay.container` in a throwaway Fedora 42 container running systemd
and podman 5.8, and `verify.sh`'s probes passed there as they did on the docker
host beside it, the self-signed test certificate aside. `verify.sh` has not
exercised the data leg to a responsive peer (`ALCOVE_RELAY_VERIFY_PEER`):
its allocation and refusal probes were driven, not exchange traffic. A
relayed exchange has been driven through this relay separately; what that
covered and what it did not is in
[standing-relay-delivery.md](../../docs/notes/standing-relay-delivery.md).
Fix what the next real run against those gets wrong rather than loosening a
probe until it passes.

**The per-exchange secrets table has been driven through the key scripts, on
a stand-in host rather than this relay.** What coturn 4.18.0 does with the
table -- two rows both authenticate, an unregistered secret is refused, a
deleted row refuses new allocations and leaves open ones running, the static
secret and the rows are a union, and the HMAC key is the 64 hex characters --
was measured by hand against the pinned image on 2026-09-23. On 2026-09-23/24
`register-exchange.sh`, `revoke-exchange.sh`, the data directory's ownership,
and `verify.sh`'s secrets-table probes ran against the pinned image in a
throwaway Amazon Linux 2023 container with its own docker daemon, with every
secrets-table probe passing, the table-only and static-secret cases alike.

**The registrar, the lapse sweep, and `max-allocate-lifetime` were driven
beside the pinned coturn on 2026-09-24**, on an Amazon Linux 2023 docker host
and a Fedora 42 podman host, both installed by `install.sh`: registration,
replacement, revocation, the sweep's lapse boundary, the registrar's refusals,
and `verify.sh` with its registrar probe all behaved as this document states.
That run went through the earlier write path, which ran `turnadmin` in a
throwaway container; the write path is `relay_table.py`, which writes the same
table directly, and its coupling to coturn's table is held by a check against
the pinned image (below). What that run measured about open allocations is
under Revoking in [Per-exchange keys](#per-exchange-keys).

`render-config.sh` and `mint-credential.sh` were also driven locally against a
fixture before the live run: `render-config.sh` renders the template, writes
at mode 600, and refuses a leftover placeholder, a placeholder named in a
comment, and a secret whose alphabet its substitution would not survive;
`mint-credential.sh` produces a credential that matches an independent
HMAC-SHA1 computation of the same username, which the live run confirmed
coturn itself accepts.

The measurement this reference implements, and the shapes it rules out, are in
[`docs/notes/webrtc-relay-deployment.md`](../../docs/notes/webrtc-relay-deployment.md);
the delivery decision is in
[`docs/notes/standing-relay-delivery.md`](../../docs/notes/standing-relay-delivery.md).
Neither is restated here.

Nothing in this directory runs a relay in CI. Tests under `scripts/` drive
`certs/deploy-hook.sh`, `relay_table.py`, the key scripts, the sweep, the
registrar, `verify.sh`'s cleanup and registrar probe, and `render-config.sh`
against a fixture host whose `turndb` is a real SQLite file holding coturn's
`turn_secret` table. `scripts/relay-turn-secret-schema.test.mjs` holds that
table's shape to the pinned image: where docker or podman answers, the image's
own `turnadmin` creates a table, `relay_table.py` reads its row and writes its
own, and `turnadmin` lists the result; where neither answers, the test is
reported as skipped rather than passed. None of it is a build input. The one
other repository-level coupling is the docker Dependabot entry for
`/infra/relay`, which raises a base image bump as a pull request.

## Order of operations

1. Hold an elastic address, create the DNS A record for the relay's name, and
   launch the instance -- [`aws/provision.md`](aws/provision.md).
2. Put `/etc/alcove-relay/relay.env` on the host from
   [`relay.env.example`](relay.env.example) and set the realm. Every script
   refuses to run without it; nothing defaults to a hostname.
3. Put `/etc/alcove-relay/acme.env` from [`certs/env.example`](certs/env.example)
   at mode 600, with the DNS provider's credential.
4. Run `install.sh` as root. It installs a container runtime, builds the image,
   creates the data directory for the secrets table, obtains a certificate,
   renders the configuration, installs the unit and the three timers, starts the
   relay, starts the registrar where the host holds its token, and runs
   `verify.sh`.
5. Read `verify.sh`'s output. A relay that starts and cannot allocate looks
   identical from the console.
6. Per exchange: `register-exchange.sh <exchange-id> <max-age-days|none>`
   with the exchange's relay key on standard input, and
   `revoke-exchange.sh <exchange-id>` when it ends -- see [Per-exchange keys](#per-exchange-keys) -- or the same through
   [the registrar](#the-registrar). The parties mint their own credentials from
   that key.

`install.sh` is idempotent. Run it again after an edit to the template, the unit,
or the Dockerfile and it converges.

## The files

| path | what it is |
| --- | --- |
| `Dockerfile` | The base image pin, and nothing else. One line of instruction: `coturn/coturn` at a tag and its multi-arch index digest. The single home of that digest -- every other file names the locally built `localhost/alcove-relay:installed` tag, so a base move is exactly one edit. Its comment carries the fallback if the community image stops publishing |
| `turnserver.conf.tmpl` | The hardened coturn configuration, with `__PLACEHOLDER__` values. Tracked; the rendered file is not |
| `render-config.sh` | Substitutes the template at mode 600. Run at install and again on every start, because a stopped and started instance comes back on a different address and a stale `external-ip` advertises a candidate nobody can reach. The cloud seam is one variable: an executable printing `<public>/<private>` |
| `alcove-relay.container` | The Quadlet unit for a podman host, installed at `/etc/containers/systemd/`. systemd is the only supervisor; there is no container daemon under it |
| `alcove-relay-docker.service` | The same container on a docker host: a plain systemd unit running `docker run` in the foreground, installed as `/etc/systemd/system/alcove-relay.service`. Same image, mounts, and flags as the Quadlet unit -- the two are edited together |
| `alcove-relay-verify.service`, `.timer` | The daily verification. A standing relay is idle between exchanges, so nothing else notices it stopped carrying allocations until a partner is waiting on one |
| `install.sh` | The whole install, idempotent |
| `relay_table.py` | The one write path to the secrets table: register, revoke, and sweep, each one SQLite transaction, as the relay image's account. Everything below that touches the table calls it. See [Per-exchange keys](#per-exchange-keys) |
| `register-exchange.sh`, `revoke-exchange.sh`, `exchange-keys.sh` | Add and remove one exchange's relay key, through `relay_table.py`; the third is the shared part both source, and `sweep-exchanges.sh` and `verify.sh` too. See [Per-exchange keys](#per-exchange-keys) |
| `import-legacy-mapping.sh` | Carries the text mapping an install from before the secrets table's own mapping kept into the table, and deletes it once the table reads back every row; `install.sh` runs it. See [Per-exchange keys](#per-exchange-keys), The mapping |
| `sweep-exchanges.sh`, `alcove-relay-sweep.service`, `.timer` | Revokes every exchange whose registration has lapsed, hourly. See [Per-exchange keys](#per-exchange-keys), Lifetime |
| `registrar.py`, `alcove-relay-registrar.service` | The optional HTTPS registrar, which registers and revokes through `relay_table.py` for a caller holding the relay-owner token. See [The registrar](#the-registrar) |
| `verify.sh` | Drives a real TURNS handshake, a real allocation, a probe that an allocation toward an internal address is refused, and the secrets table: two keys registered for the run both allocate, an unregistered key and a credential keyed with a key's decoded bytes are refused, and a revoked key's new allocation is refused. Where the host holds a registrar token it also asks the registrar: calls with no token or a wrong one are answered 401 and write nothing, and a registration and a revocation with the token reach the mapping and the table; with no token it says it skipped the registrar. Its exchanges are under the ids `alcove-verify-a`, `-b`, and `-registrar`, a prefix every other caller is refused. On exit it revokes them, each in one transaction, and warns naming the exchange id, never the key, for any it could not revoke. Passes only on an observed refusal: a question that could not be asked reports UNCLEAR and fails. Connects to the realm's name by default; `ALCOVE_RELAY_VERIFY_CONNECT` overrides the TCP connect target while the realm still names the SNI and TURN realm -- `install.sh` sets it to the instance's private address for the end-of-install run, because EC2 does not hairpin an instance's traffic back to its own Elastic IP, while the daily timer stays on the public name so it fails if that path breaks. `ALCOVE_RELAY_VERIFY_WAIT` sets how many seconds it retries a bare TCP connect before its first probe, waiting for a just-(re)started listener to come up; 30 by default |
| `mint-credential.sh` | One time-limited credential under the static secret, on a host that holds one: `<expiry>:<name>` as the username, the base64 HMAC-SHA1 of it as the password |
| `relay.env.example` | The host's one configuration file, copied to `/etc/alcove-relay/relay.env` |
| `certs/` | ACME DNS-01 renewal: the timer and its unit, the client-neutral `renew.sh`, the deploy hook, and the provider credential's example |
| `aws/` | The AWS-specific half: instance provisioning, the IMDSv2 external-address helper, and the demo box's stop/start scripts |

## Per-exchange keys

Each exchange has its own relay key, derived from the exchange's shared secret
([PROTOCOL.md, Relay credential derivation](../../docs/spec/PROTOCOL.md#relay-credential-derivation)).
The relay holds one row per registered exchange in coturn's `turn_secret` table,
in the SQLite file `/var/lib/alcove-relay/turndb` (mounted at
`/var/lib/coturn/turndb`), and accepts a credential minted under any row.

Run both scripts as root on the relay host, from `/opt/alcove-relay`, or call
[the registrar](#the-registrar), which writes through the same code:

```sh
register-exchange.sh <exchange-id> <max-age-days|none>   # the key on standard input
revoke-exchange.sh <exchange-id>
```

- **The arguments.** The exchange id is 1 to 128 of `[A-Za-z0-9._-]`, not
  starting with `-`. An id containing a run of 64 hex characters of either
  case is refused, so a key passed in the id's place is never registered or
  journaled, and so is an id starting with `alcove-verify-`, which `verify.sh`
  registers and revokes on every run. max-age-days is a whole number of days
  from 1 to 36500, or `none` for a row that never lapses -- see Lifetime below;
  it is required, so a registration never clears a lapse by leaving it out.
  Either script refuses a malformed argument and names it, without printing the
  value.
- **The key.** 64 lowercase hex characters, the form coturn keys its HMAC with,
  read from standard input: typed at a terminal, where it is not echoed, or
  piped. It is never an argument, so it does not reach the process table, the
  shell's history, or a `sudo` log:

  ```sh
  printf '%s\n' "$KEY" | /opt/alcove-relay/register-exchange.sh exchange-1 90
  ```

- **Registering.** Adds the key's row and maps the exchange to it. An exchange
  already registered has its prior row deleted in the same transaction, so the
  relay holds only its current key from the moment the call returns -- register
  again after each [rotation](../../docs/spec/PROTOCOL.md#shared-secret-rotation).
  Registering the key an exchange already holds renews its row: the new
  registration time and the call's max-age-days. A key another exchange holds
  is refused. The message states the resulting lapse.
- **Revoking.** Deletes the exchange's row and its mapping in one transaction,
  whether by `revoke-exchange.sh`, the registrar, or the sweep. Measured against
  coturn 4.18.0, what a revoke does and does not do:
  - A new allocation under the key is refused within about 200 ms, with no
    restart.
  - An allocation already open is NOT cut. Its client keeps it for as long as
    it keeps refreshing: refreshes under a revoked key and an expired credential
    went on succeeding until the client exited, twelve minutes past the
    credential's expiry, and coturn accepted every forced re-authentication
    after a stale nonce, with the default nonce lifetime and with
    `stale-nonce=60` alike. Neither a revoke nor a credential's expiry ends a
    client that keeps refreshing, and a shorter `stale-nonce` does not help.
  - `turnserver.conf.tmpl` sets `max-allocate-lifetime=600`, the longest
    lifetime one allocate or refresh is granted. That bounds only a client that
    stops refreshing: coturn closed such an allocation 600 s after its last
    refresh.
- **Lifetime.** A row registered with max-age-days lapses that many days after
  its registration, and the sweep -- `sweep-exchanges.sh`, or
  `alcove-relay-sweep.timer` hourly -- revokes it within the hour. Registering
  the exchange's next key, or its current key again, replaces the row and
  restarts the count, so each run's registration is the renewal and an exchange
  that keeps running is never swept. max-age-days is the managed-exchange
  record's `tokenMaxAgeDays`
  ([MANAGED_EXCHANGE_RECORD.md, Persisted across runs](../../docs/spec/MANAGED_EXCHANGE_RECORD.md#persisted-across-runs)): each successful run stamps the stored secret's
  `expires` that many days out and rotates the secret, and the relay forgets
  the exchange's key at the same bound after which the record's secret lapses
  and a re-invite is needed. Its ceiling, 36500, is core's
  `MAX_TOKEN_MAX_AGE_DAYS` (`packages/core/src/config/connection.ts`). The
  record's policy is off by default; a row registered with `none`, like a record
  with no policy, has no lapse and lives until it is revoked or replaced. There
  is no relay-side setting for the lapse.
- **The mapping.** `turn_secret` is keyed by realm and key and holds no exchange
  id, so `relay_table.py` keeps a second table in the same file,
  `alcove_exchange`: the exchange id, the realm, the key, the Unix time of the
  registration, and max-age-days (empty for no lapse). coturn reads neither the
  table nor anything else it does not know. One file means a register, revoke,
  or sweep is one SQLite transaction across the row and the mapping: it lands
  whole or not at all, and its result is the write's own, with nothing read
  back. `install.sh` carries a mapping an earlier install kept in
  `/etc/alcove-relay/exchange-keys` into the table once, through
  `import-legacy-mapping.sh`, and deletes that file, which holds every key in
  plaintext, once the table, read back, accounts for each of its rows: each
  exchange carried in reads back, no key in the file is listed without an
  exchange mapping it, or mapped without being listed, and a key the table
  maps is mapped to the row's own exchange. If the import fails, the file is
  kept unchanged and `install.sh` stops. If the import lands but the table
  does not account for a row, the file is moved to `exchange-keys.imported`
  and `install.sh` warns, naming the exchange ids; remove a key listed with
  no exchange mapping it with `forget-key`, delete from
  `exchange-keys.imported` a row whose key another exchange holds (a key maps
  to one exchange only; register that exchange again with a key of its own
  if it is still in use), and run `install.sh` again. A file is imported
  once only: every later run checks `exchange-keys.imported` the same way,
  never imports it again, and deletes it once the table accounts for it, so
  an exchange revoked or swept since stays revoked, and a row removed from
  the file is not carried in.
- **How they reach the table.** `relay_table.py`, on the host's own `python3`
  and its `sqlite3` module, opens `/var/lib/alcove-relay/turndb` as the relay
  image's account -- a script run as root drops to the account that owns the
  file first -- so every file SQLite creates beside it is one coturn can use. No
  container runtime is involved. It never creates `turndb`: coturn does at its
  first start, and until then every call exits 1 naming the file. A table that
  cannot be written -- read-only, unopenable, locked past 10 s -- exits 1 with
  SQLite's own reason, having changed nothing. A row no exchange maps -- one
  added by hand -- is removed by value, the key on standard input:
  `printf '%s\n' "$KEY" | python3 /opt/alcove-relay/relay_table.py forget-key`,
  with `relay.env`'s variables in the environment. An `alcove-verify-` row
  the import skips -- a verify run that died before cleaning up -- gets no
  mapping, so if an earlier install already wrote its key into the table
  that key stays until it is removed with `forget-key`, the key taken from
  the legacy file, which `install.sh` keeps until then.
- **A replaced `turndb` needs a restart.** coturn holds the file open. A
  `turndb` deleted or replaced under a running coturn -- by hand, or a restore
  from backup -- leaves the server reading the file it opened while every write
  lands in the new one: a revoke reports success while the key still
  allocates, and a registration does not allocate. After touching the file,
  `systemctl restart alcove-relay.service`.

**The static secret is optional.** A host holding
`/etc/alcove-relay/static-auth-secret` renders it beside the table, and coturn
accepts a credential under the static secret or any row -- measured, so a
relay can move to per-exchange keys with its static secret still set, while
credentials from `mint-credential.sh` keep working. To finish the move, delete
the file and restart `alcove-relay.service`. `install.sh` keeps a secret it
finds and mints none.

## The registrar

An HTTPS service beside coturn that registers and revokes an exchange's key
for a caller holding the relay-owner token, so a browser inviter can register
the key it rotates to at the end of each run without shell access to the relay
host. It is optional: `install.sh` runs it only on a host holding
`/etc/alcove-relay/registrar-token`. To turn it on:

```sh
(umask 077; openssl rand -hex 32 > /etc/alcove-relay/registrar-token)
/opt/alcove-relay/install.sh   # or the checkout's install.sh
```

Give the token to the relay's operator, who keeps it in the browser's own
settings, never in a served bundle. To turn it off, delete the file and run
`install.sh` again. To replace the token, overwrite the file and
`systemctl restart alcove-relay-registrar.service`.

- **The calls.** Every request needs `Authorization: Bearer <token>`; without
  it, or with a wrong token, the answer is 401 and nothing is written. A CORS
  preflight (`OPTIONS`) is the one exception: a browser sends it with no
  token, and it is answered 204 and does nothing. Any other method -- `GET`,
  `TRACE`, `PROPFIND`, anything but `PUT`, `DELETE`, and `OPTIONS` -- is
  answered 401 without the token and 405 with it, in JSON, and writes nothing.

  | request | writes | answer |
  | --- | --- | --- |
  | `PUT /exchanges/<exchange-id>` with `{"key": "<key-hex64>", "maxAgeDays": <days> \| null}` | what `register-exchange.sh <exchange-id> <days\|none>` writes | 200 and `{"message": ..., "maxAgeDays": ..., "lapsesAt": ...}` |
  | `DELETE /exchanges/<exchange-id>` | what `revoke-exchange.sh <exchange-id>` writes | 200 and `{"message": ...}` |

  `maxAgeDays` is required: a whole number of days, or `null` for a row that
  never lapses. A body that leaves it out is refused, so a re-registration
  cannot clear a lapse by omission, and the answer states the resulting lapse:
  `maxAgeDays` as registered and `lapsesAt` as an ISO 8601 UTC time, or `null`.
  The registrar checks the exchange id, the key, and `maxAgeDays` against the
  rules in [Per-exchange keys](#per-exchange-keys), The arguments, and answers a
  value that fails them 400 with a fixed message naming the field, never the
  value, before anything is written. An id starting with `alcove-verify-` is
  refused 400 unless the request carries `Alcove-Relay-Verify-Run: 1`, which
  `verify.sh` sends and which the preflight does not allow a browser to send. A
  body that is not that JSON object is answered 400, one over 1024 bytes 413,
  and one without a `Content-Length` 411. A request line or header block the
  registrar cannot parse is answered in JSON with the connection closed. A
  refusal on the exchange's state -- a key another exchange holds, an id not
  registered -- is answered 409, and a table that cannot be written 500, each
  with `{"error": ...}`, which never contains the key. One write runs at a time.
- **Authentication and CORS.** Authentication reads the `Authorization` header
  and nothing else -- no cookie, no query parameter -- and no answer carries
  `Access-Control-Allow-Credentials`, so a browser's ambient credentials never
  authenticate a cross-origin call. `Access-Control-Allow-Origin: *` is safe for
  that reason. `scripts/relay-exchange-keys.test.mjs` holds both.
- **Where it listens.** HTTPS on `ALCOVE_RELAY_REGISTRAR_PORT` in `relay.env`,
  8443 by default, on every address, with the relay's own certificate from
  `/etc/alcove-relay/certs`; the certificate deploy hook restarts it when the
  certificate changes. TURNS holds 443, so the registrar cannot share it. Open
  the port in the instance's security group to the addresses the operator
  registers from ([aws/provision.md](aws/provision.md), Ports).
- **How it reaches the table, and as whom.** In-process, through
  `relay_table.py`, so the table and mapping have one write path. It runs as the
  relay image's uid and gid, which `install.sh` reads from the image and fills
  into the unit, with no capability and no container runtime; the token and
  certificate under the root-only `/etc/alcove-relay` reach it as systemd
  credentials (`LoadCredential=`). The unit carries a full systemd sandbox --
  read-only system and no home, a private `/tmp` and `/dev`, no kernel,
  cgroup, clock, or hostname writes, the `@system-service` system calls, and
  write access to `/var/lib/alcove-relay` alone -- and the sweep's unit the
  same with no network. It is `python3` from the distribution (3.9 or later,
  the standard library only), which Amazon Linux 2023 ships.
- **What it logs.** One line per request to the journal (`journalctl -u
  alcove-relay-registrar.service`), naming the method, the status, and the
  path, and the result of each write. The path is logged only when it is
  `/exchanges/<exchange-id>` with a well-formed id, and the method only when
  it is a standard one; any other path or method, and any part of a malformed
  request line, is replaced by a fixed placeholder, since it could hold a key
  sent in the wrong place. Neither the token nor a key is logged.

## Supervision and the container runtime

One service name, `alcove-relay.service`, whichever runtime the host carries:
the certificate deploy hook restarts it by that name and the verification timer
requires it. Which file defines it is what `install.sh` decides, and it decides
once per host -- the runtime is recorded in `relay.env` and read back on every
later run, so a converge does not move a running relay from one supervisor to the
other.

| The host has | The unit | The supervisor |
| --- | --- | --- |
| podman | `alcove-relay.container`, at `/etc/containers/systemd/` | podman's systemd generator: daemonless, and systemd is the only supervisor |
| docker | `alcove-relay-docker.service`, installed as `/etc/systemd/system/alcove-relay.service` | systemd, over a foreground `docker run`; the unit `Requires=docker.service` |

**Amazon Linux 2023 is a docker host.** It publishes no `podman` package and
carries no EPEL, so `dnf install podman` fails there with no match, while `dnf
install docker` installs Docker Engine. That is measured on the arm64 AMI
[`aws/provision.md`](aws/provision.md) prescribes, and it is why the docker path
is a tracked unit rather than a documented equivalence. `install.sh` still
prefers podman wherever the distribution carries it.

**Under podman, a container's command line reaches the journal.** Each
container lifecycle event (create, start, died, remove, and the rest) is a
journal entry that journald stamps with podman's command line, and where
`containers.conf` sets `log_driver = "journald"`, Fedora's default, conmon sends
the container's output there too. Measured on Fedora 42: a key on a `podman
run` command line reached the journal on every run, and a credential on
`turnutils_uclient`'s did the same. Nothing here puts a key on a container's
command line -- `relay_table.py` runs no container:
`scripts/relay-exchange-keys.test.mjs` checks that its import statements name
exactly the modules it uses today, that it reads only the names it uses today
off `os`, and that it holds no dynamic import, though not code a string builds
and `eval` runs -- and `verify.sh` passes
podman's global `--events-backend=none` to every `turnutils_uclient` run. A run
by hand whose command line or output carries a key or a credential takes the
same flags, `podman --events-backend=none run --log-driver=none ...`, which
were measured to leave none in the journal while the caller still reads the
output. docker journaled neither.

The two unit files carry the same image, the same read-only mounts, and the same
container flags. `alcove-relay-docker.service`'s header holds the
directive-to-flag mapping between them, and an edit to one is an edit to both.

Host networking is a requirement of the protocol rather than a convenience. TURN
hands out a relayed transport address, and bridge networking or published ports
rewrite the address the client is told to use; the relay range is also wide
enough that publishing it is not a port list.

## Certificates

Let's Encrypt over DNS-01, on a systemd timer, driven through `lego` (default,
v5 or later -- `renew.sh` drives the v5 `run` flag shape, which a v4 binary
rejects) or `acme.sh`. DNS-01 rather than HTTP-01 because the relay already
terminates TLS on 443 for TURNS -- an HTTP-01 challenge would need a second
service on 80 whose only job is to answer it.

The provider is a variable, and the credential lives in `/etc/alcove-relay/acme.env`
at mode 600. `certs/env.example` carries the Cloudflare shape (a token scoped to
`Zone:DNS:Edit` on the one zone, not a global key); another provider is that
provider's variables in the same file.

**The deploy hook's chown is load-bearing.** It re-owns the private key to the
account inside the container, whose numeric uid `install.sh` reads from the built
image rather than assuming. The relay measurement recorded coturn silently
falling back to its defaults on a key it could not read: no error where the
failure is, and the first symptom is a party that cannot gather a relay
candidate. A renewal that landed a root-owned key would take the relay out that
way, at renewal time, with nothing in the journal naming the cause. `install.sh`
converges the same ownership on every run, certificate already present or not,
because a rebuilt image is where that uid moves.

The hook **restarts** rather than reloads. Whether a signal makes coturn re-read
its certificate is a question nobody has driven against the real server, so the
hook does the thing that certainly works. A restart drops any allocation in
flight, so the hook restarts only when the certificate or key it deploys differs
from the copy already in `/etc/alcove-relay/certs` in content or owner -- on
most days the timer fires, the ACME client renews nothing and the relay keeps
running -- and the timer runs at a fixed early hour for the day it does renew.

## Portability

The core of this directory is cloud-neutral. Moving it to Azure, to another
provider, or on-prem changes two things and nothing else:

- **The external address.** `render-config.sh` calls whatever
  `ALCOVE_RELAY_EXTERNAL_IP_HELPER` names and requires only that it print
  `<public>/<private>` on one line. `aws/external-ip.sh` reads IMDSv2; another
  cloud is a sibling of that file, and a host with a static pair is two lines of
  `printf`.
- **The DNS-01 provider.** Two variables in `acme.env`.

The image, the configuration, the units, the credential model, and the
verification are the same everywhere. Neither `install.sh`'s `dnf` lines nor the
`aws/` directory is reached by anything else here; on a distribution without
`dnf`, install podman or docker with that distribution's own package manager and
`install.sh` uses what it finds.

## What is not tracked

The tooling is here; nothing that carries a secret, identifies an account, or is
a rendered artifact is. Each path is ignored by this directory's `.gitignore`,
and every script refuses to run rather than defaulting to a value it was not
given.

| path | what goes there |
| --- | --- |
| `/etc/alcove-relay/static-auth-secret` | Optional. The static secret `mint-credential.sh` signs under, mode 600. It never appears on a unit's `ExecStart` line, in a tracked file, or in the journal |
| `/etc/alcove-relay/registrar-token` | Optional. The relay-owner token the registrar requires, mode 600; the registrar runs only where it exists |
| `/etc/alcove-relay/turnserver.conf` | The rendered configuration, mode 600, because it can hold that secret. Rendered from the tracked template on every start |
| `/var/lib/alcove-relay/turndb` | The secrets table and the exchange mapping beside it, owned by the container's uid, in a mode-700 directory of that account's |
| `/etc/alcove-relay/certs/` | The certificate and private key the ACME hook deploys. The key is mode 600 and owned by the container's uid |
| `/etc/alcove-relay/relay.env` | The realm, the port range, the quotas, and the external-address helper. Copy [`relay.env.example`](relay.env.example) |
| `/etc/alcove-relay/acme.env` | The ACME contact, client, provider, and the provider's credential. Copy [`certs/env.example`](certs/env.example) |
| `aws/env` | The demo box's instance id, region, profile, and optional zone credential. Copy [`aws/env.example`](aws/env.example) |

Not to be confused with [`hosted/`](../hosted/README.md), the OpenTofu root
for the project's hosted web application environments.
