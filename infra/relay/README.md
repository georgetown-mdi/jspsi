# The psilink standing relay: a reference for a dedicated instance

Everything needed to bring up a self-hosted TURN relay that carries a psilink
WebRTC exchange for a party on a network that blocks UDP or admits only TCP/443:
a digest-pinned coturn image, a hardened configuration, the systemd unit that
supervises it, an ACME renewal that keeps its certificate current, scripts that
register and revoke each exchange's relay key, and a verification script that
asks the deployed relay whether it is doing its job.

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

**The podman/Quadlet path remains undriven** -- everything measured above went
through `psilink-relay-docker.service`, and nothing has exercised
`psilink-relay.container` or its generator. `verify.sh` has also not
exercised the data leg to a responsive peer (`PSILINK_RELAY_VERIFY_PEER`):
its allocation and refusal probes were driven, not exchange traffic. A
relayed exchange has been driven through this relay separately; what that
covered and what it did not is in
[standing-relay-delivery.md](../../docs/notes/standing-relay-delivery.md).
Fix what the next real run against those gets wrong rather than loosening a
probe until it passes.

**The per-exchange secrets table has not been driven through these scripts.**
What coturn 4.18.0 does with the table -- two rows both authenticate, an
unregistered secret is refused, a deleted row refuses new allocations and leaves
open ones running, the static secret and the rows are a union, and the HMAC key
is the 64 hex characters -- was measured by hand against the pinned image
on 2026-09-23. `register-exchange.sh`, `revoke-exchange.sh`, the data
directory's ownership, and `verify.sh`'s secrets-table probes have not yet run
against a relay.

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

Nothing in this directory runs a relay in CI. Two tests under `scripts/` drive
`certs/deploy-hook.sh`, the key scripts, and `render-config.sh` against a fixture
host with a stub container runtime, and none of it is a build input. The one
other repository-level coupling is the docker Dependabot entry for
`/infra/relay`, which raises a base image bump as a pull request.

## Order of operations

1. Hold an elastic address, create the DNS A record for the relay's name, and
   launch the instance -- [`aws/provision.md`](aws/provision.md).
2. Put `/etc/psilink-relay/relay.env` on the host from
   [`relay.env.example`](relay.env.example) and set the realm. Every script
   refuses to run without it; nothing defaults to a hostname.
3. Put `/etc/psilink-relay/acme.env` from [`certs/env.example`](certs/env.example)
   at mode 600, with the DNS provider's credential.
4. Run `install.sh` as root. It installs a container runtime, builds the image,
   creates the data directory for the secrets table, obtains a certificate,
   renders the configuration, installs the unit and the two timers, starts the
   relay, and runs `verify.sh`.
5. Read `verify.sh`'s output. A relay that starts and cannot allocate looks
   identical from the console.
6. Per exchange: `register-exchange.sh <exchange-id> <key-hex64>` with the
   exchange's relay key, and `revoke-exchange.sh <exchange-id>` when it ends --
   see [Per-exchange keys](#per-exchange-keys). The parties mint their own
   credentials from that key.

`install.sh` is idempotent. Run it again after an edit to the template, the unit,
or the Dockerfile and it converges.

## The files

| path | what it is |
| --- | --- |
| `Dockerfile` | The base image pin, and nothing else. One line of instruction: `coturn/coturn` at a tag and its multi-arch index digest. The single home of that digest -- every other file names the locally built `localhost/psilink-relay:installed` tag, so a base move is exactly one edit. Its comment carries the fallback if the community image stops publishing |
| `turnserver.conf.tmpl` | The hardened coturn configuration, with `__PLACEHOLDER__` values. Tracked; the rendered file is not |
| `render-config.sh` | Substitutes the template at mode 600. Run at install and again on every start, because a stopped and started instance comes back on a different address and a stale `external-ip` advertises a candidate nobody can reach. The cloud seam is one variable: an executable printing `<public>/<private>` |
| `psilink-relay.container` | The Quadlet unit for a podman host, installed at `/etc/containers/systemd/`. systemd is the only supervisor; there is no container daemon under it |
| `psilink-relay-docker.service` | The same container on a docker host: a plain systemd unit running `docker run` in the foreground, installed as `/etc/systemd/system/psilink-relay.service`. Same image, mounts, and flags as the Quadlet unit -- the two are edited together |
| `psilink-relay-verify.service`, `.timer` | The daily verification. A standing relay is idle between exchanges, so nothing else notices it stopped carrying allocations until a partner is waiting on one |
| `install.sh` | The whole install, idempotent |
| `register-exchange.sh`, `revoke-exchange.sh`, `exchange-keys.sh` | Add and remove one exchange's relay key in the secrets table; the third is the shared part both source. See [Per-exchange keys](#per-exchange-keys) |
| `verify.sh` | Drives a real TURNS handshake, a real allocation, a probe that an allocation toward an internal address is refused, and the secrets table: two keys registered for the run both allocate, an unregistered key and a credential keyed with a key's decoded bytes are refused, and a revoked key's new allocation is refused. It revokes its own keys on exit. Passes only on an observed refusal: a question that could not be asked reports UNCLEAR and fails. Connects to the realm's name by default; `PSILINK_RELAY_VERIFY_CONNECT` overrides the TCP connect target while the realm still names the SNI and TURN realm -- `install.sh` sets it to the instance's private address for the end-of-install run, because EC2 does not hairpin an instance's traffic back to its own Elastic IP, while the daily timer stays on the public name so it fails if that path breaks. `PSILINK_RELAY_VERIFY_WAIT` sets how many seconds it retries a bare TCP connect before its first probe, waiting for a just-(re)started listener to come up; 30 by default |
| `mint-credential.sh` | One time-limited credential under the static secret, on a host that holds one: `<expiry>:<name>` as the username, the base64 HMAC-SHA1 of it as the password |
| `relay.env.example` | The host's one configuration file, copied to `/etc/psilink-relay/relay.env` |
| `certs/` | ACME DNS-01 renewal: the timer and its unit, the client-neutral `renew.sh`, the deploy hook, and the provider credential's example |
| `aws/` | The AWS-specific half: instance provisioning, the IMDSv2 external-address helper, and the demo box's stop/start scripts |

## Per-exchange keys

Each exchange has its own relay key, derived from the exchange's shared secret
([PROTOCOL.md, Relay credential derivation](../../docs/spec/PROTOCOL.md#relay-credential-derivation)).
The relay holds one row per registered exchange in coturn's `turn_secret` table,
in the SQLite file `/var/lib/psilink-relay/turndb` (mounted at
`/var/lib/coturn/turndb`), and accepts a credential minted under any row.

Run both scripts as root on the relay host, from `/opt/psilink-relay`:

```sh
register-exchange.sh <exchange-id> <key-hex64>
revoke-exchange.sh <exchange-id>
```

- **The arguments.** The exchange id is 1 to 128 of `[A-Za-z0-9._-]`, not
  starting with `-`; the key is 64 lowercase hex characters, the form coturn
  keys its HMAC with. Either script refuses a malformed argument and names it.
- **Registering.** Adds the key's row. An exchange already registered has its
  new row added, then its prior row deleted, so the relay ends holding only its
  current key and both keys allocate for the moment between -- register again
  after each [rotation](../../docs/spec/PROTOCOL.md#shared-secret-rotation). If
  the delete fails, the script exits non-zero naming the prior key, which stays
  in the table until you delete it by hand. Registering the key an exchange
  already holds changes nothing. A key another exchange holds is refused.
- **The key on the command line.** The key is an argument to both the script
  and the container it starts, so it is visible in the host's process table
  while the command runs; do not run it on a host other accounts share.
- **Revoking.** Deletes the exchange's row. A new allocation under the key is
  refused within about 200 ms, with no restart. An allocation already open is
  NOT cut: its refreshes kept succeeding for over two minutes after the delete,
  through a forced re-authentication, measured against coturn 4.18.0. It ends
  when the client stops refreshing or its lifetime lapses. Whether coturn also
  ends it at the credential's expiry (at most 3600 s for a credential psilink
  mints) has not been measured.
- **Lifetime.** A registered row lives until it is revoked or replaced. No
  expiry or renewal policy for rows is decided yet.
- **The mapping.** `turn_secret` is keyed by realm and key and holds no exchange
  id, so the scripts keep `/etc/psilink-relay/exchange-keys`, one
  `<exchange-id> <key>` line per registered exchange, mode 600. A text file
  rather than a second SQLite database, because the host has no `sqlite3`
  requirement and the image carries no `sqlite3` binary; it sits under `/etc`,
  not in the data directory, so only root can change which row an exchange owns.
  The scripts hold a lock on `exchange-keys.lock` for each edit.
- **How they reach the table.** Through the relay image's own `turnadmin`
  (`-s` to add, `-X` to delete, with the server's realm), in a throwaway
  container with no network, as the image's account -- which owns the data
  directory, so the SQLite file `turnadmin` creates on the first registration
  is one the server can read. A host with coturn's `turnadmin` installed could
  run the same commands against `/var/lib/psilink-relay/turndb` as that account.

**The static secret is optional.** A host holding
`/etc/psilink-relay/static-auth-secret` renders it beside the table, and coturn
accepts a credential under the static secret or any row -- measured, so a
relay can move to per-exchange keys with its static secret still set, while
credentials from `mint-credential.sh` keep working. To finish the move, delete
the file and restart `psilink-relay.service`. `install.sh` keeps a secret it
finds and mints none.

## Supervision and the container runtime

One service name, `psilink-relay.service`, whichever runtime the host carries:
the certificate deploy hook restarts it by that name and the verification timer
requires it. Which file defines it is what `install.sh` decides, and it decides
once per host -- the runtime is recorded in `relay.env` and read back on every
later run, so a converge does not move a running relay from one supervisor to the
other.

| The host has | The unit | The supervisor |
| --- | --- | --- |
| podman | `psilink-relay.container`, at `/etc/containers/systemd/` | podman's systemd generator: daemonless, and systemd is the only supervisor |
| docker | `psilink-relay-docker.service`, installed as `/etc/systemd/system/psilink-relay.service` | systemd, over a foreground `docker run`; the unit `Requires=docker.service` |

**Amazon Linux 2023 is a docker host.** It publishes no `podman` package and
carries no EPEL, so `dnf install podman` fails there with no match, while `dnf
install docker` installs Docker Engine. That is measured on the arm64 AMI
[`aws/provision.md`](aws/provision.md) prescribes, and it is why the docker path
is a tracked unit rather than a documented equivalence. `install.sh` still
prefers podman wherever the distribution carries it.

The two unit files carry the same image, the same read-only mounts, and the same
container flags. `psilink-relay-docker.service`'s header holds the
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

The provider is a variable, and the credential lives in `/etc/psilink-relay/acme.env`
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
from the copy already in `/etc/psilink-relay/certs` in content or owner -- on
most days the timer fires, the ACME client renews nothing and the relay keeps
running -- and the timer runs at a fixed early hour for the day it does renew.

## Portability

The core of this directory is cloud-neutral. Moving it to Azure, to another
provider, or on-prem changes two things and nothing else:

- **The external address.** `render-config.sh` calls whatever
  `PSILINK_RELAY_EXTERNAL_IP_HELPER` names and requires only that it print
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
| `/etc/psilink-relay/static-auth-secret` | Optional. The static secret `mint-credential.sh` signs under, mode 600. It never appears on a unit's `ExecStart` line, in a tracked file, or in the journal |
| `/etc/psilink-relay/turnserver.conf` | The rendered configuration, mode 600, because it can hold that secret. Rendered from the tracked template on every start |
| `/etc/psilink-relay/exchange-keys` | Which registered key belongs to which exchange, mode 600 |
| `/var/lib/psilink-relay/turndb` | The secrets table, owned by the container's uid |
| `/etc/psilink-relay/certs/` | The certificate and private key the ACME hook deploys. The key is mode 600 and owned by the container's uid |
| `/etc/psilink-relay/relay.env` | The realm, the port range, the quotas, and the external-address helper. Copy [`relay.env.example`](relay.env.example) |
| `/etc/psilink-relay/acme.env` | The ACME contact, client, provider, and the provider's credential. Copy [`certs/env.example`](certs/env.example) |
| `aws/env` | The demo box's instance id, region, profile, and optional zone credential. Copy [`aws/env.example`](aws/env.example) |

Not to be confused with [`hosted/`](../hosted/README.md), the OpenTofu root
for the project's hosted web application environments.
