# Provisioning the relay instance on AWS

The relay runs on a dedicated instance of its own, provisioned from the reference
in [the parent directory](../README.md) rather than configured by hand. This
file is the AWS half: what to launch, what to open, and what the owner does once.

Nothing here has been run. No instance has been launched from this document, and
no step below has been driven against an account.

## The instance

A stock Amazon Linux 2023 AMI, arm64, at the smallest size that carries the
traffic. The relay measurement ran coturn on a `t4g.micro` colocated with two
other services; alone, `t4g.nano` is the size to start from and `t4g.micro` the
one to move to if allocations are dropped under load. A standing relay is paid
for while it idles -- roughly ten dollars a month at these sizes with an address
held -- and that idle cost, not the per-exchange cent, is the figure this shape
turns on (see [the deployment record](../../../docs/notes/webrtc-relay-deployment.md)).

Nothing about the reference is AL2023-specific except `dnf` in `install.sh`. The
AMI is stock: no image is baked, and the instance is reproduced by relaunching it
against the same user-data.

**An elastic address, held.** The relay's name has to keep resolving between
exchanges, and a partner has no channel to be handed a new address out of band.
The address is what makes the name stable; the demo box, which is stopped and
started, is the opposite trade and takes a short-TTL record instead.

**A DNS A record**, created before the first install: the ACME DNS-01 challenge
proves control of the zone, and the certificate is issued for this name. One
name serves as the TURN realm, the certificate subject, and the host in the
`turns:` URL a partner is given.

## Ports

Inbound, in the instance's security group:

| Port | Protocol | Source | Why |
| --- | --- | --- | --- |
| 443 | TCP | 0.0.0.0/0, ::/0 | TURNS. The whole client-facing surface, and the one port a restrictive network leaves open |
| 49152-49200 | UDP | 0.0.0.0/0, ::/0 | The relay range. A peer's traffic leaves here whatever transport the client arrived on |
| 22 | TCP | the owner's address only | Administration. Not open to the internet |

Outbound: unrestricted, or at minimum UDP to the relay range and TCP/443 to the
ACME authority and the DNS provider's API.

No plain TURN listener is configured, so 3478 stays closed. Nothing in the
configuration listens on it.

## User-data

Cloud-init fetches this directory and runs `install.sh`. The realm is the one
value that cannot be derived on the box, so the user-data writes it before
installing.

```sh
#!/bin/bash
set -euo pipefail
dnf -y install git
git clone --depth 1 https://github.com/georgetown-mdi/jspsi /opt/psilink-src
install -d -m 700 /etc/psilink-relay
install -m 600 /opt/psilink-src/infra/relay/relay.env.example /etc/psilink-relay/relay.env
sed -i 's/^PSILINK_RELAY_REALM=.*/PSILINK_RELAY_REALM=relay.example.org/' /etc/psilink-relay/relay.env
# The DNS provider credential, from wherever this account keeps secrets. It is
# not in the repository and not in user-data, which is readable from the
# instance metadata service by anything running on the box.
install -m 600 /dev/stdin /etc/psilink-relay/acme.env <<'ACME'
PSILINK_RELAY_ACME_EMAIL=relay-admin@example.org
PSILINK_RELAY_ACME_CLIENT=lego
PSILINK_RELAY_DNS_PROVIDER=cloudflare
CLOUDFLARE_DNS_API_TOKEN=REPLACE_WITH_YOUR_DNS_TOKEN
ACME
/opt/psilink-src/infra/relay/install.sh
```

**The metadata hop limit stays at 1 and IMDSv2 stays required.** `external-ip.sh`
reads IMDSv2 and needs no more than one hop. A relay is the box where an
unauthenticated metadata read matters most: an allocation toward
`169.254.169.254` is exactly what the configuration's `denied-peer-ip` rules
refuse, and admitting IMDSv1 would restore the surface those rules close.

Neither `lego` nor `acme.sh` is installed by `install.sh`; add whichever the
user-data installs to the block above, before the install line.

## Retiring what the old box carried

The relay measurement's coturn ran as a user-space build on the always-on demo
box, behind a self-signed certificate. Once this instance is serving:

- Stop and remove that user-space coturn build and its unit or launch script.
- Delete its self-signed certificate and key. Nothing should be able to start a
  second TURN server on that box by accident, and a self-signed certificate is
  one a psilink party refuses to gather a relay candidate against anyway.
- Close 443/tcp, 3478, and the old relay range in that box's security group. Its
  remaining duty is the demo SFTP server.
- Leave the box itself: it keeps its demo duty, and
  [`demo-up.sh`](demo-up.sh) and [`demo-down.sh`](demo-down.sh) stop and start
  it around a demonstration so it is not paid for between them.

## After the install

`install.sh` ends by running `verify.sh`, which is the only step that says
whether the result carries an exchange rather than merely starting. Read its
output; a relay that starts and cannot allocate looks identical from the console.
