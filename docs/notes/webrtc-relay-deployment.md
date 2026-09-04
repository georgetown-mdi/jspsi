---
title: "WebRTC Relay and Deployment Shape"
---

# The WebRTC relay, and the shape that deploys it

_Status: measured, with a recommendation and a proposed epic, and the
recommendation is now deployed and verified -- a relayed exchange has been driven
against the standing relay it recommended (see the bring-up addendum below). This
note stays the measurement record. It records what TURN over TLS on 443
carried on two restrictive network classes, what a per-exchange provisioned
deployment costs and leaves behind, how a self-hosted relay compares with a
managed one, and which shape the evidence favours. Nothing here is normative:
the transport's ICE rules are in
[WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#ice), the confidentiality
argument in
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#which-channels-request-it),
and the posture in
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security). See
[docs/notes/README.md](README.md)._

_Bring-up addendum, 2026-09-04: the recommendation below is now built. The
standing relay described in
[standing-relay-delivery.md](standing-relay-delivery.md) has been deployed and
verified to carry a relayed exchange. A CLI party with all outbound and inbound
UDP dropped (only loopback allowed), whose only possible transport is
TURN-over-TLS on 443, completed a mutually-authenticated PSI exchange over ten
matched records; host conntrack witnessed its entire data-channel traffic crossing the relay
(about 29 KB up, 36 KB down to the relay on 443), with a per-exchange
HMAC-SHA1 credential on a one-hour expiry. Two operational findings from the
bring-up. First, no per-session relayed-byte summary appeared in coturn's
container logs during the bring-up -- only a connection reset on teardown -- so
the byte witness came from host conntrack accounting rather than the relay's own
log; whether that is a property of this coturn build or an artefact of the
bring-up's log configuration (simple-log, verbose directed to a file, abrupt
teardown) is not yet settled, and a board spike is scoped to drive it out.
Second,
coturn's per-username allocation quota interacts with the roughly eight-minute
allocation linger a relayed run leaves behind: reusing one credential username
across rapid back-to-back exchanges exhausts the quota and gets new allocations
rejected mid-stream, which minting a fresh per-exchange credential name (as the
tool already does) avoids. The exchange ran between two parties on the relay
host, not across two separate networks behind real NAT, and exercised no browser
party against the instance; those remain unmeasured._

## What was measured, and on what

Two substrates, because the first host to hold the measurement had no cloud
credentials.

- **A local Docker substitute**, for the first question only. coturn serving
  TURNS on 443/tcp, an nginx TLS front over this repository's own web-app image
  with the broker at `/api`, a TLS-terminating inspecting proxy for the second
  class, and both parties in this repository's own container image. Network
  classes were applied with `iptables` inside the restricted party's container,
  where a cloud network ACL would sit.
- **AWS**, for the second and third questions, and for a re-measurement of the
  first over a real internet path: two instances (the owner's ceiling), a
  restricted subnet whose network ACL denies UDP outright, a services subnet
  holding coturn, the web app with its broker, and the inspecting proxy, a
  publicly resolvable name per service, and a real certificate from a public
  authority.

**What the substitute cannot show, said plainly.** No field round-trip times, no
real NAT, no public certificate authority, no cost, and no address a party
outside the host can reach. The last of those turned out to matter: the
substitute's negative result for a CLI-to-browser exchange did not survive the
move to a real network, and the revision is recorded below rather than smoothed
over.

## Question 1: does TURN over TLS on 443 carry a restrictive network

Relay is forced by network shape in every row. No configuration can force it:
the WebRTC connection schema exposes no relay-only knob, and nothing in the CLI
sets one.

Two classes, as scoped: **class A**, UDP blocked outright; **class B**, TCP/443
only, through an inspecting proxy.

### On the local substitute

| class | pair | completed | selected pair |
| --- | --- | --- | --- |
| A | CLI to CLI | yes, 3 of 3 | local `relay` over TURNS (TLS 1.3), remote `host` |
| A | CLI to browser | no; ICE never completes, the CLI exits at its 30 s channel budget | none |
| A | CLI to browser, CLI unrestricted (control) | yes | `host` to `host` and `srflx` |
| B, proxy CA untrusted on the CLI host | CLI to CLI | no; the run dies at the intercepted signaling WebSocket in 0.3 s | none gathered |
| B, proxy CA trusted on the CLI host | CLI to CLI | yes | local `relay` allocated through the proxy, remote `host` |

Three independent witnesses agree the class-A exchange was relayed: coturn's
per-session relayed byte counts, the restricted party's own socket table (only
the TURN host and the broker, both on 443), and a throwaway `getStats()`
instrument whose nominated pair is `relay` to `host` with all three
host-involving pairs failed. Both parties resolved the correct intersection.

Two consequences the substitute settled on its own merits. **werift verifies the
TURN server's certificate**: with the interception CA untrusted it gathers no
relay candidate at all, so TURNS through an inspecting proxy requires that CA on
the CLI host. And **an interception point at the relay reads the STUN and TURN
envelope only**, about 13 KB up and 11.5 KB down, while the linkage still
resolves correctly.

### Re-measured over a real internet path

The same exchange, restricted CLI on one instance and partner on another host,
through coturn on a public address with a public certificate.

| class | relay | completed exchanges | interrupted on purpose | rendezvous to data channel |
| --- | --- | --- | --- | --- |
| A | self-hosted coturn | 7 | 0 | 8.49 to 8.69 s |
| B | self-hosted coturn | 3 | 2 | 8.24 to 8.84 s |
| A | managed vendor | 1 | 0 | 15.27 s |
| B | managed vendor | 1 | 0 | 14.33 s |

Class A is a network ACL denying UDP in both directions and admitting TCP/443 to
the service addresses. Class B is the same ACL plus a route sending the services
subnet through the proxy's interface; the interception is confirmed per class
switch by reading the issuer of the certificate the restricted box is served,
which is the public authority under class A and the proxy's own CA under class
B. On class B the proxy read 13.2 KB up and 11.7 KB down of relay traffic in the
clear and the linkage still came out correct, which reproduces the substitute's
result on a real path.

### The consequence

**TURNS on 443 carried a real exchange for a CLI party on both classes**,
including through TLS interception once the proxy's CA was trusted on the CLI
host. On that evidence a DTLS-terminating WebSocket relay is not needed for the
CLI half: no network measured here forced one. Whether such a relay is built
anyway, and the application-layer wrap it would require, is a direction this
measurement does not decide; it removes the forcing case, not the option.

### The browser qualification, revised

The substitute measured a CLI-to-browser exchange failing on both classes, and
attributed it to the browser's offer: an mDNS-obscured host candidate that
werift does not resolve, plus a server-reflexive UDP address unreachable from a
UDP-blocked party, with no third option because the web client configures a
fixed STUN pair and no TURN entry. Three controls excluded the harness.

**On AWS the same attempt completed.** A restricted CLI on class A accepted a
browser party's invitation and the browser reported the exchange complete with
two matched records. The browser's selected pair was its own server-reflexive
UDP candidate to the CLI's relay candidate on the public coturn, nominated and
carrying about 11.8 KB each way; coturn logged the allocation over TLS 1.3 on
443 and a channel binding to the browser's reflexive address.

So the substitute's failure was a property of the substitute: its relay's
address was not reachable from the browser. The finding that survives is
narrower and still real.

- A browser with no TURN entry **can** reach a CLI party whose relay address is
  publicly reachable, because the browser sends UDP to the relayed transport
  address and the CLI never needs a candidate of the browser's.
- That path costs the browser outbound UDP to an arbitrary high port. A browser
  on a network of either class measured here has no candidate the CLI can use
  and no relay of its own, so **a browser-side TURN entry is still required
  before any restrictive-network claim about CLI-to-web is complete**. What is
  not yet measured is the case with the restriction on the browser's side.

That remains the open scope call: the web client's ICE list is a deliberate
choice with its own disclosure consequences, and adding a relay to it is work
this record proposes rather than performs.

## Question 2: what "exchange-provisioned" means

Two shapes, both stood up on the account. Six ephemeral cycles, then one shared
box carrying seven exchanges.

| shape | provisioned | to first frame | cost per exchange | cycles | orphans after the last cycle | the interrupted cycle |
| --- | --- | --- | --- | --- | --- | --- |
| ephemeral, per exchange | one t4g.micro, two elastic addresses, a second network interface, one security group, one TURN secret, one certificate, two DNS records | 94 s, over a 94 to 129 s range | about $0.002 per cycle | 6 | zero of every type | left nothing: zero of every type after its teardown |
| shared, per-exchange credentials | the same box, stood up once; per exchange only a freshly minted time-limited TURN credential | 8.6 s, plus 12 s of amortised bring-up | about $0.0001 | 7 exchanges on one box | no services instance and no addresses after teardown | one exchange interrupted mid-channel; the box carried the next one unchanged |

**Cost is computed, not measured.** Cost Explorer returned $0 with no
per-service grouping for the run's day and marked the figure estimated, which is
its published lag rather than the run's spend, and the account's month-to-date
read $0 in the closing inventory. Every figure above is arithmetic over
published on-demand rates this credential could not confirm through the pricing
API. Behind them: a t4g.micro services box at $0.0084/hour, a t4g.nano
restricted box at $0.0042/hour, a public address at $0.005/hour whether attached
or not, and a gp3 volume at $0.08/GiB-month. The ephemeral figure assumes the
measured cycle length of about five and a half minutes end to end, first API
call to post-teardown sweep, and counts the services instance, its two elastic
addresses, and its root volume; the shared figure assumes the box's 87 s
bring-up divided across the seven exchanges it carried plus each exchange's own
8.6 s.

The per-exchange arithmetic flatters the shared shape in a way worth stating: a
shared box is paid for while it idles. At the same rates a t4g.micro holding one
elastic address continuously is about $9.80 a month whether it carries one
exchange or a thousand, and that, not the per-exchange cent, is the figure a
deployment decision turns on.

### Provisioning, phase by phase

Seconds. The last column is the CLI's own rendezvous-to-data-channel window,
read from the two log lines that bracket it.

| cycle | API create to running | running to SSH | SSH to TLS on both addresses | of which engine install | of which image load | rendezvous to data channel |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 19 | 23 | 46 | 13 | 11 | 8.559 |
| 2 | 19 | 21 | 46 | 13 | 11 | 8.587 |
| 3 | 19 | 22 | 79 | 51 | 11 | 8.521 |
| 4 | 20 | 22 | 46 | 14 | 12 | 8.697 |
| 5 | 22 | 26 | 51 | 13 | 12 | 8.493 |
| 6 | 19 | 21 | 46 | 14 | 12 | 8.240 |
| shared | 19 | 20 | 48 | 14 | 11 | 8.592 |

**Image delivery is what fills the dominant phase.** Bringing the services up
takes about twice as long as launching the instance, and installing the
container engine plus loading the image from an attached volume is 24 to 26 s of
that 46 s, roughly 30 percent of a whole 86 s bring-up, and 62 s of the one
120 s outlier where the package install ran long. That phase is an artifact of
the measurement's constraints, not of the shape: the credential could neither
bake a machine image nor pull from a registry. **A real deployment replaces it
with a baked image or a registry pull and pays neither the volume nor the
load**, which would take the ephemeral bring-up from about 90 s toward about
60 s. It does not remove the instance-launch and SSH-readiness phases, which are
40 s together and are the floor a per-exchange instance cannot go below.

### Three findings about the ephemeral shape

1. **A per-exchange DNS name runs against the partner's negative cache.** The
   zone used here answers with a 1800 s negative-cache TTL, so a name minted for
   one exchange can be shadowed by a stale non-existence answer at a partner's
   resolver for half an hour after it is created. The run did not have to
   observe this, because it reused one fixed name per service, re-pointed each
   cycle at a 60 s record TTL, and pinned the partner to the addresses the cycle
   had allocated. That mitigation is exactly what a real deployment cannot do:
   it has no channel to hand a partner an address out of band. A per-exchange
   name is therefore not a free naming choice, and a stable name with a
   rewritten address is the shape that works.
2. **A certificate cannot be minted per exchange from a public authority.** The
   run issued one certificate covering both service names and reused it across
   every cycle, because the authority used caps duplicate certificates at five a
   week and a sixth cycle would have failed. The ephemeral shape therefore
   already had to cache a long-lived credential across exchanges, which is a
   finding about the shape rather than an implementation detail. A per-exchange
   certificate needs a private authority whose root the partner already trusts,
   or a wildcard, or a name that does not change.
3. **Teardown of the per-exchange resources was clean; teardown of the
   surrounding fixture was not.** All seven cycles left zero instances, volumes,
   addresses, network interfaces, security groups, DNS records, and local
   certificates, including the cycle interrupted by killing the restricted party
   while its data channel was open. The one-time network fixture underneath them
   is where teardown needed a retry: a subnet, a route table, and the VPC did not
   delete on the first sweep, were reported loudly with their ids retained, and
   deleted on a second run. None of the three bills. The account's final
   inventory is byte-identical to the pre-run baseline.

## Question 3: self-hosted or managed

| option | class A | class B | setup | cost | credential and expiry |
| --- | --- | --- | --- | --- | --- |
| coturn on EC2 | carried | carried | one instance, one config file, one certificate, colocated with the broker | about $0.002 per ephemeral cycle, or about $9.80 a month held continuously, plus each address while unattached | REST-style: username is a Unix expiry joined to a fixed name, password is the base64 HMAC-SHA1 of that username under a static secret, minted per exchange with a one-hour expiry; the static secret itself minted per cycle |
| coturn on Fargate | not measured | not measured | not measured | not measured | not measured |
| a managed vendor's TURN service | carried | carried, with the limit below | a zone, a key, and one API call per exchange; no server to run | not on this account's bill; the vendor's own charge was not measured | one POST per exchange with a requested lifetime, returning a username and password valid for 600 s |

Fargate was never reachable: the credential the run used is denied the container
service outright, so the row is unmeasured rather than negative.

**Two operational catches, both predicted and both confirmed.**

The first is the credential path. The configuration schema has a shape for
exactly this, an ICE-provisioning endpoint returning time-limited STUN and TURN
credentials, and the CLI refuses a connection that sets it rather than ignoring
it ([CLI.md](../CLI.md#webrtc-exchanges),
[EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#connectionturn)). So the
managed credential had to be minted out of band, per exchange, and written into
a static `turn` entry before the exchange started. That is the whole
awkwardness, and it is what prices wiring the provisioning call: without it,
using a managed relay means a script that mints a credential and rewrites a
config file between every exchange.

The second is the port. The vendor's credential response advertises STUN and
TURN on 3478 and TURNS on 5349, and **does not list 443 at all**. Both classes
here were carried on `turns:...:443?transport=tcp`, which the vendor answers
even though it does not advertise it. A deployment that took the vendor's URL
list at face value would configure 5349 and be blocked by exactly the networks
the relay exists for. The port that works has to be chosen deliberately and
re-checked, because nothing in the vendor's own response asserts it.

**The posture.** A TURN relay forwards DTLS without terminating it, so a managed
relay sees addresses, timing, and volume, and never exchange data. That is the
statement in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security), and
this run measured it rather than assuming it: an interception point sitting on
the relay path read only the STUN and TURN envelope while the linkage resolved
correctly on both sides. The consequence for the deployment is that a managed
relay is an acceptable option and must not become the only one: **the shape must
let an operator point at a self-hosted relay instead**, which is what the
existing `turn` entry already allows and what the recommendation below keeps.

## The recommendation

**A shared, long-lived relay and coordination deployment with per-exchange
credentials, self-hosted coturn as the default and a managed vendor as a
supported alternative.**

The ephemeral shape works, and its failure mode is not the one that was
expected. Teardown is not the problem: seven cycles, two of them interrupted
mid-exchange, left nothing behind. The problem is that a per-exchange service
needs a per-exchange identity, and identity is the part that does not provision
in a minute. A name minted per exchange meets a half-hour negative cache at the
partner's resolver, and a certificate minted per exchange meets a public
authority's duplicate limit within a week of ordinary use. Both were worked
around here only by giving the partner its addresses out of band, which a real
deployment cannot do. Against that, the shape costs 90 to 130 seconds before the
first frame, against 9 seconds on a box that is already up, and buys an
isolation the DTLS layer already provides: the relay cannot read the exchange
whether it was created for this exchange or has been running for a year. The
shared shape's real cost is idle time, roughly ten dollars a month at the
smallest instance size, which is a price worth paying for two minutes of latency
and a solved naming problem.

Per-exchange credentials carry the isolation that matters. A TURN credential
minted per exchange with a short expiry, over a per-deployment static secret,
was measured on both classes; it bounds what a leaked credential is worth to the
length of one exchange rather than to the life of the deployment.

Ephemeral provisioning stays worth revisiting for one case this run did not
need: a deployment that must hold no address between exchanges. If it is
revisited, the first thing to fix is image delivery, and the naming and
certificate findings above are its design constraints, not details.

### Does the coordination server leave the web app's deployment

**Yes, under this recommendation, in principle and not yet as scheduled work.**
A shared relay deployment is a service that has to exist and be addressed
independently of the web app; once that service exists, the peer-coordination
broker belongs beside it rather than mounted inside the app the browser loads
its code from. The broker is already a workspace of its own with a standalone
entry point, so nothing has to be extracted for that to be possible.

The measurement does not prove it. The run stood the broker up by deploying the
web app's own image and using its mounted signaling path, so the standalone
entry point was never exercised on the account. Running that entry point beside
coturn and completing one exchange against it is the one thing that would settle
it.

If it does leave, the standing constraint in
[web-server-runtime-role.md](web-server-runtime-role.md) reaches its trigger:
the server's last runtime service goes with the broker, and what remains is a
server whose whole job is delivering code. That note records the direction and
schedules nothing; a framework removal is a candidate item under the epic below
rather than a consequence that follows automatically.

## The proposed epic

**A proposal for the owner to ratify.** Nothing in this section is filed,
scoped, or scheduled by this record.

`Done is: a psilink exchange reaches its peer-coordination and relay endpoints at a deployment separate from the web app's, with credentials minted per exchange, and a CLI party on a UDP-blocked network completes an exchange with a browser party through it.`

Candidate members, by title:

- **Encrypt the web PeerJS path once web has an authenticated handshake.** The
  measurement removes the forcing case rather than the item: no class measured
  here forced a DTLS-terminating relay for a CLI party, so the wrap is not on
  the critical path, and it stays scoped to whenever such a relay exists.
- **Evaluate replacing the vendored peerjs-server with a first-party two-peer
  rendezvous broker.** What the broker must be depends on where it is deployed,
  and this record answers that half: beside the relay, addressed independently
  of the web app.
- **Provision an ephemeral peer-coordination server per exchange.** Measured
  here rather than resolved on paper. The evidence recommends against it as the
  default and records the three findings any later attempt has to design around.
- **Drive a real TURN relay through the CLI WebRTC transport.** Discharged: the
  standing relay now carries a byte-witnessed relayed exchange for a UDP-blocked
  CLI party (bring-up addendum above), and the "configured but unproven" limit
  that shipped in [CLI.md](../CLI.md#webrtc-exchanges) and
  [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#connectionturn) is trued to
  match. What remains is the field: a real-NAT path and a browser party against
  the standing instance.
- **New, and the one this record most motivates: give the web client a TURN
  entry.** Until the browser can offer a relay candidate of its own, no
  restrictive-network claim about a CLI-to-web exchange is complete, and the
  case with the restriction on the browser's side is unmeasured. The web
  client's ICE list is a disclosure decision as well as a connectivity one, so
  the item is a scope call before it is an implementation.
- **New, conditional on the coordination server leaving: remove the web app's
  server framework.** Only once the broker is deployed elsewhere, and only on
  the terms in [web-server-runtime-role.md](web-server-runtime-role.md).

## What remains unmeasured

| question | the one thing that would settle it |
| --- | --- |
| Real partner and agency networks | a run from a machine on one, which the owner scoped as a follow-on rather than a blocker |
| A browser on a restrictive network | the same exchange with the class applied to the browser's side, which needs the browser-side TURN entry first |
| coturn on Fargate | a credential granted the container service; the one used here is denied it outright |
| Whether the account's real cost matches the computed figure | reading Cost Explorer a day later, once its lag has passed |
| The managed vendor's own charge | the vendor's bill, which never appears on this account |
| The standalone broker | deploying the broker workspace's own entry point beside the relay and completing one exchange against it |
| Published rates | a credential with pricing-API access; no rate behind any figure here was confirmed from AWS's own API |

## Stated limits

- **The services box is colocated.** The relay, the web app with its broker, and
  the class-B inspecting proxy shared one instance, because the owner's ceiling
  is two instances and the restricted party held the other. An instance-level
  failure would take relay, signaling, and interception together, and a real
  deployment separates them. Nothing measured here depends on their separation.
- **Class B did not cover the managed relay's path.** The interception is a
  route sending the services subnet through the proxy, and the vendor's relay
  address is not in that subnet: the network ACL admitted it on 443 directly,
  out through the internet gateway. The managed relay's class-B row is therefore
  measured as UDP-blocked and TCP/443-only, **without** an inspecting proxy on
  the relay path. Only the signaling path was intercepted in that row. The
  self-hosted rows carry the full class, relay included.
- **The network ACL pinned one vendor address.** The vendor's name resolved to a
  single address, which the ACL then named; a real restrictive network cannot
  pin a managed relay that way, and a vendor whose address set rotates would
  need a broader rule.
- **Question 1's substitute.** Its CLI-to-CLI results are corroborated by the
  AWS runs. Its CLI-to-browser negative result is superseded by them, as above.
- **Two rows in the raw results are harness defects, not network results.** The
  first cycle's first two attempts failed because the CLI was invoked with the
  wrong argument shape and exited before opening a socket. They appear in the
  per-exchange record as failures and are not class-A failures.
- **The CLI reports no candidate pair.** It calls the statistics API nowhere, so
  every candidate-pair fact here comes from the relay's own logs, the restricted
  party's socket table, or a throwaway instrument. The remote party's selected
  candidate was never read on any row.
- **A relayed exchange does not exit when it finishes.** On both substrates the
  process wrote its result and then held for minutes; on AWS the harness stopped
  it after a 90 s grace on eleven runs, so every completed row records a killed
  process rather than a clean exit. The exchanges themselves completed and both
  sides resolved the correct intersection. This is a CLI behaviour the
  measurement surfaced and is filed separately, not a property of any shape here.
- **Every cost figure is computed from published rates**, not read from a bill.
- **The exchange measured is small.** Two matched records over a dozen linkage
  keys, tens of kilobytes on the wire. Nothing here bounds a relay's behaviour
  under a large exchange.
