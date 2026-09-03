# The psilink standing relay: a reference for a dedicated instance

Everything needed to bring up a self-hosted TURN relay that carries a psilink
WebRTC exchange for a party on a network that blocks UDP or admits only TCP/443:
a digest-pinned coturn image, a hardened configuration, the systemd unit that
supervises it, an ACME renewal that keeps its certificate current, a per-exchange
credential helper, and a verification script that asks the deployed relay whether
it is doing its job.

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
claim here as something to check. **No relay has been stood up from it.** One
instance has been launched and the install attempted on it, which is where the
runtime section's AL2023 package facts come from; it got no further than the
package step. No image has been built, no certificate issued, and no allocation
driven. `verify.sh` is the script that turns this from a proposal into a working
relay, and it has itself never been run -- its probes key on coturn's documented
exit statuses and message strings rather than measured ones. Fix what the first
real run gets wrong rather than loosening a probe until it passes.

Three pieces were driven locally against a fixture, and only those three:
`render-config.sh` renders the template, writes at mode 600, and refuses a
leftover placeholder, a placeholder named in a comment, and a secret whose
alphabet its substitution would not survive; `mint-credential.sh` produces a
credential that matches an independent HMAC-SHA1 computation of the same
username; `verify.sh`'s handshake probe was run against a local `openssl
s_server` holding first a self-signed certificate and then a leaf under a locally
trusted CA, which is a TLS endpoint and not a relay -- the allocation and refusal
probes have still been asked of nothing. Whether coturn accepts that credential,
and every other claim in this directory, is unverified.

The measurement this reference implements, and the shapes it rules out, are in
[`docs/notes/webrtc-relay-deployment.md`](../../docs/notes/webrtc-relay-deployment.md);
the delivery decision is in
[`docs/notes/standing-relay-delivery.md`](../../docs/notes/standing-relay-delivery.md).
Neither is restated here.

Nothing in this directory runs in CI. No workflow, package script, or test
invokes it, and none of it is a build input. The one repository-level coupling is
the docker Dependabot entry for `/infra/relay`, which raises a base image bump as
a pull request.

## Order of operations

1. Hold an elastic address, create the DNS A record for the relay's name, and
   launch the instance -- [`aws/provision.md`](aws/provision.md).
2. Put `/etc/psilink-relay/relay.env` on the host from
   [`relay.env.example`](relay.env.example) and set the realm. Every script
   refuses to run without it; nothing defaults to a hostname.
3. Put `/etc/psilink-relay/acme.env` from [`certs/env.example`](certs/env.example)
   at mode 600, with the DNS provider's credential.
4. Run `install.sh` as root. It installs a container runtime, mints the static
   authentication secret if the host has none, builds the image, obtains a
   certificate, renders the configuration, installs the unit and the two timers,
   starts the relay, and runs `verify.sh`.
5. Read `verify.sh`'s output. A relay that starts and cannot allocate looks
   identical from the console.
6. Per exchange: `mint-credential.sh [name] [ttl]` prints a credential and the
   `connection.turn` entry it goes in. One hour by default -- what a leaked
   credential is worth is the length of one exchange, not the life of the
   deployment.

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
| `verify.sh` | Drives a real TURNS handshake, a real allocation, and a probe that an allocation toward an internal address is refused. Passes only on an observed refusal: a question that could not be asked reports UNCLEAR and fails |
| `mint-credential.sh` | One time-limited credential: `<expiry>:<name>` as the username, the base64 HMAC-SHA1 of it as the password |
| `relay.env.example` | The host's one configuration file, copied to `/etc/psilink-relay/relay.env` |
| `certs/` | ACME DNS-01 renewal: the timer and its unit, the client-neutral `renew.sh`, the deploy hook, and the provider credential's example |
| `aws/` | The AWS-specific half: instance provisioning, the IMDSv2 external-address helper, and the demo box's stop/start scripts |

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

Let's Encrypt over DNS-01, on a systemd timer, driven through `lego` (default) or
`acme.sh`. DNS-01 rather than HTTP-01 because the relay already terminates TLS on
443 for TURNS -- an HTTP-01 challenge would need a second service on 80 whose
only job is to answer it.

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
hook does the thing that certainly works; the timer runs at a fixed early hour
because a restart drops any allocation in flight.

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
| `/etc/psilink-relay/static-auth-secret` | The static secret every credential is minted under, mode 600. `install.sh` mints one if the host has none. It never appears on a unit's `ExecStart` line, in a tracked file, or in the journal |
| `/etc/psilink-relay/turnserver.conf` | The rendered configuration, mode 600, because it carries that secret. Rendered from the tracked template on every start |
| `/etc/psilink-relay/certs/` | The certificate and private key the ACME hook deploys. The key is mode 600 and owned by the container's uid |
| `/etc/psilink-relay/relay.env` | The realm, the port range, the quotas, and the external-address helper. Copy [`relay.env.example`](relay.env.example) |
| `/etc/psilink-relay/acme.env` | The ACME contact, client, provider, and the provider's credential. Copy [`certs/env.example`](certs/env.example) |
| `aws/env` | The demo box's instance id, region, profile, and optional zone credential. Copy [`aws/env.example`](aws/env.example) |

Not to be confused with
[`relay-spike-aws/`](../relay-spike-aws/README.md), which provisions a
throwaway account for a measurement and then destroys it, or with
[`aws_eb/`](../aws_eb/README.md), the Terraform draft for the web application's
Elastic Beanstalk environment.
