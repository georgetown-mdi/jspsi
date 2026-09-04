---
title: "Standing Relay Delivery Shape"
---

# How the standing relay is delivered

_Status: decided, the reference is written, and the first deployment has driven a
relayed exchange through it. The relay measurement recommended a shared,
long-lived relay with per-exchange credentials, and this note records the
decisions that turn that recommendation into repository artifacts -- where the
relay runs, how it is supervised, and what is tracked. The measurement itself is
in
[webrtc-relay-deployment.md](webrtc-relay-deployment.md) and is not restated
here. The artifacts are [`infra/relay/`](../../infra/relay/README.md). See
[docs/notes/README.md](README.md)._

## The rescope

The measurement ran coturn as a user-space build on the always-on box that also
carries the demo SFTP server, behind a self-signed certificate. That was a
measurement fixture and is not the deployment.

**The relay gets a dedicated instance, provisioned from a version-controlled
reference.** Two reasons, in order. The relay's identity is its name and its
certificate, and the measurement's central finding is that identity is the part
that does not provision quickly: a per-exchange name meets a half-hour negative
cache at a partner's resolver, and a per-exchange certificate meets a public
authority's duplicate limit within a week of ordinary use. A standing relay must
therefore hold a stable name and a real certificate, and both are properties of a
box that stays up. Second, colocation is what the measurement itself listed as a
stated limit: an instance-level failure would take the relay down with whatever
else shared the box, and a demo box is stopped and started on purpose.

**The demo box keeps only its demo duty, and gets stop/start scripts.** Its
user-space coturn build, its self-signed certificate, and its relay-related
firewall openings are retired. Nothing on it has to be reachable between
demonstrations, so it is stopped between them, which is what the two scripts in
`infra/relay/aws/` are for. The relay is the opposite trade: an address held
continuously, so its name keeps resolving.

## The delivery decisions

Settled by a convened design panel, 2-1 with the dissent's risk answered, and
ratified by the owner.

- **The official `coturn/coturn` image, digest-pinned in a one-line Dockerfile.**
  The Dockerfile is the digest's only home: everything else names the locally
  built tag, so a base move is exactly one edit and there is no second copy to
  drift. The dissent was the supply-chain dependence on a community image, and it
  is answered by writing the fallback into the file that would carry it -- if the
  image stops publishing, that Dockerfile grows a build from a pinned source tag
  rather than floating onto another publisher. The pinning convention itself is
  the repository's existing one; see
  [CONTAINER_IMAGES.md](../spec/CONTAINER_IMAGES.md).
- **podman with a Quadlet unit, systemd as the only supervisor.** Daemonless, and
  it puts the relay under the same supervisor as its certificate timer and its
  verification timer. Because the flags are identical either way, the partner
  README documents the equivalent `docker run` line as a first-class alternative
  rather than a footnote: a host that already runs docker needs no different
  configuration.
  _Addendum, 2026-09-03: the first install attempt measured the AL2023 AMI this
  reference prescribes carrying no podman package and no EPEL, and docker from
  `dnf`. `install.sh` detects the runtime and keeps this unit where podman
  exists; the docker half is a tracked unit paired with it,
  `infra/relay/psilink-relay-docker.service`, rather than the README line._
- **Host networking**, which is a requirement of the protocol rather than a
  preference: TURN hands out a relayed transport address that bridge networking
  or published ports would rewrite.
- **Configuration rendered at start, not at install.** The rendered file carries
  the static secret, so it is written at mode 600 and is untracked; the template
  is what is tracked. Rendering on every start rather than once is what keeps the
  advertised external address true across a stop and start.
- **Certificates by ACME DNS-01 on a timer**, DNS-01 because the relay already
  terminates TLS on 443 and an HTTP-01 challenge would need a second listener
  whose only job is to answer it. The deploy hook re-owns the key to the
  container's account, which the measurement makes load-bearing: coturn was
  observed falling back to its defaults on a key it could not read, so a renewal
  landing a root-owned key would take the relay out silently at renewal time. The
  hook restarts rather than reloads, because whether a signal makes coturn
  re-read its certificate has not been driven against the real server.
- **A verification script that drives the deployed relay**, rather than a
  checklist. It runs a real handshake, a real allocation, and a probe that an
  allocation toward an internal address is refused -- and it passes that last one
  only on an observed refusal, because a relay that starts and cannot allocate,
  and a relay that will happily proxy into its own VPC, both look correct from a
  console. It runs at install and on a timer, since a standing relay is idle
  between exchanges and nothing else notices it stopped working until a partner
  is waiting.

## What is deliberately not here

- **No infrastructure-as-code for the relay instance.** One instance, launched
  once, from a stock AMI with cloud-init user-data that runs the install script.
  A Terraform module for a single long-lived box is more machinery than the thing
  it provisions.
- **No baked machine image.** Image delivery dominated the measurement's
  provisioning time, which is what makes baking worth it for a per-exchange
  instance. A box that is launched once pays that cost once.
- **No managed-vendor path in the reference.** A managed relay stays a supported
  option -- the configuration schema's `turn` entry is what points at either --
  and the measurement's posture finding is that neither sees exchange data. What
  the reference exists to guarantee is that self-hosting is available to a party
  that will not accept a relay it does not operate.
- **Nothing about the browser's ICE list.** Giving the web client a TURN entry is
  a disclosure decision the measurement raises and this note does not touch.

## The edge, now closed

The first real deployment ran the reference end to end and settled what only a
deployment could. A dedicated instance was launched from the reference, a real
public-authority certificate was issued to it, and `verify.sh` passed against the
running relay -- a real handshake, a real allocation, and an observed refusal of
an allocation toward an internal address, so its probes now key on measured
behaviour rather than documented exit statuses. Then a relayed exchange was
driven through it: a CLI party with UDP blocked outright completed a
mutually-authenticated exchange whose entire data-channel traffic the relay carried, with the
credential minted per exchange by `mint-credential.sh`. The byte evidence and the
two operational findings the bring-up surfaced are in
[webrtc-relay-deployment.md](webrtc-relay-deployment.md), not restated here.

What the deployment does not yet cover is the field: the driven exchange ran
between two parties on the relay host rather than across two separate networks
behind real NAT, and no browser party has been exercised against the standing
instance. A relayed exchange is verified against the standing relay; the
real-NAT and browser scenarios remain to be driven.
