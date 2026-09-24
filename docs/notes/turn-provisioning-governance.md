---
title: "TURN Provisioning and Partner Governance"
---

# TURN provisioning, against what partners' governance will accept

_Status: surveyed, with a recommendation per profile; nothing here is decided
or built, and the configuration shape is left to separate work. The relay
measurement answered what a relay costs and whether it works; this record is the
other half of the same decision -- what an organization can run, and what its
partners' security and governance teams will accept relaying through. Nothing
here is normative: the transport's ICE rules are in
[WEBRTC_TRANSPORT.md](../spec/WEBRTC_TRANSPORT.md#ice), the confidentiality
argument in
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#which-channels-request-it),
and the posture in
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security). The technical
record it builds on is [webrtc-relay-deployment.md](webrtc-relay-deployment.md).
See [docs/notes/README.md](README.md)._

## What this record assumes

Owner direction, taken as given and not re-examined here:

- **No public relay.** A relay is stood up by the deployment or by a party to
  the exchange, and access to it is regulated by per-exchange, time-limited
  credentials -- coturn's shared-secret mode, the `hmac-sha1` credential type in
  [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#connectionturn), with
  bandwidth quotas and peer-range denial -- never by a long-lived credential.
- **A managed relay is acceptable**, and the deployment leaves the choice
  between it and a self-hosted one open.
- **The inviter names a relay it can provision, and the acceptor may add its
  own.** Both entries merge into one ICE server list, and the inviter's relay
  serves both parties by design.

**Superseded 2026-09-22, by an owner ruling on the relay work.** Two inputs
this record relied on are superseded; its measurements and governance findings
stand.

- **The credential-free invitation is not a rule.** This record cites
  [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#invitation-contents-and-confidentiality)
  for an invitation that can never hold a credential; the owner had not approved
  that rule. The invitation is confidential, and a connection credential may be
  included where its lifetime fits the invitation's acceptance window. The
  objection under [Runbook relay](#runbook-relay) that a one-hour credential
  would expire before a slow acceptance stands as a lifetime mismatch, not as a
  prohibition.
- **The invitation names the inviter's relay, never its credential.** The
  invitation may hold the inviting party's relay locator -- its TURN and STUN
  addresses -- and the accepting party relays through that relay in place of
  its own rather than merging the two into one list. Both parties derive the
  relay credential from the exchange's shared secret
  ([PROTOCOL.md](../spec/PROTOCOL.md#the-invitations-relay-locator)), so no
  relay credential passes between them. Each party's own relay is the fallback
  where the invitation names none. Delivering a relay sealed at rendezvous is a
  later option and not part of this cut.

Taken from the relay measurement rather than measured again: TURN over TLS on
443 relays a UDP-blocked CLI party, through TLS interception once the
interception CA is trusted on the CLI host; the recommended shape is a shared,
long-lived relay with per-exchange credentials on a one-hour expiry, self-hosted
coturn by default and a managed vendor as a supported alternative
([Question 3](webrtc-relay-deployment.md#question-3-self-hosted-or-managed));
and the self-hosted shape has a reference deployment in
[`infra/relay/`](../../infra/relay/README.md).

## How it was written

- **Against named organizations.** The profiles were written against a set of
  partner organizations whose identities, and which profile each matches, are
  held privately. This record names profiles only.
- **Every governance claim cites its source and date** -- framework text,
  vendor documentation, or published guidance -- listed under
  [Sources](#sources) and cited by tag, such as [F1]. Where a source states no
  date, the date it was read, 2026-09-21, stands in. A claim no source supports
  is marked **Advisory**.
- **No claim that a regulation applies to an organization is made here.** What a
  source says is stated as the source says it; where applicability is an
  inference, the text says so.
- **Time-boxed to about one day.** What it could not answer is listed under
  [What remains unanswered](#what-remains-unanswered) rather than guessed at.

## Three profiles, as postures

The owner first described these by size -- large, medium, small. They are named
here by what the organization runs, because a partner-facing answer to "what
will your security team accept" starts from what an organization would
recognize in itself.

| profile | you are here if | what it runs for Alcove |
| --- | --- | --- |
| **Credential service** | You already operate authenticated, internet-facing APIs, and one more is a platform team's ordinary work | An HTTPS endpoint that mints a per-exchange relay credential on request, in front of its own relay or a managed vendor's -- the [`ice_provision`](../EXCHANGE_REFERENCE.md#connectionice_provision) shape, which the CLI refuses today |
| **Runbook relay** | You can run a VM from a runbook, keep it patched, and keep its certificate renewed | A persistent coturn from [`infra/relay/`](../../infra/relay/README.md): TLS on 443, shared-secret time-limited credentials, peer ranges denied |
| **No relay of its own** | You run no server for this and would rather not | Direct or STUN-only paths, a partner's relay, or a managed relay it chooses |

Two things the owner's experience with the partners behind this record
contradicts, and which a profile must not assume:

- **What an organization could operate is not what it will operate.** An
  organization able to run a credential service may still put everything in
  virtual machines, which is the runbook posture. Place a partner by what it
  will run, found by asking, not by what it could.
- **Size does not order governance friction.** A larger organization is not
  reliably slower or stricter. The friction comes from specific things, each of
  which a smaller organization can have and a larger one can lack:
  - whether the relay is a new internet-facing system in the organization's own
    estate;
  - whether a relay vendor has to pass the organization's vendor-risk program;
  - whether the unit that approves the exchange is the unit that runs the
    network's egress path. Where they are different units, approval of the
    exchange does not mean the relay's traffic will pass.

## What every profile meets

### What the relay sees

A TURN relay forwards the DTLS-encrypted data channel without terminating it,
so it sees the two parties' addresses, timing, and volume and never exchange
data ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security)). That was
measured, not assumed: an interception point on the relay path read only the
STUN and TURN envelope while both parties resolved the correct linkage
([webrtc-relay-deployment.md](webrtc-relay-deployment.md#question-3-self-hosted-or-managed)).
TURN itself does not encrypt what it relays -- RFC 8656 notes that the server
operator "can see the application data being relayed" [F9] -- so the
confidentiality is the data channel's DTLS, not the relay's. Whichever party
allocated the relay, it sees both parties' addresses, so each party's
governance has a stake in the relay the other chose.

### Outbound TLS on 443 to a partner's relay, against outbound SFTP

Alcove already asks a partner to connect outbound to a server the other party
runs: an SFTP exchange does
([DEPLOYMENT.md](../DEPLOYMENT.md#sftp-server)). A partner-run relay asks for
the same kind of connection, over a different path.

| | SFTP to the partner's server | TURN over TLS on 443 to the partner's relay |
| --- | --- | --- |
| Port and path | The server's port, usually 22, through the network firewall | TCP 443, through the same egress path as web traffic -- a secure web gateway, where there is one |
| What a network team reviews | A firewall rule to one host and port | Often nothing, until the gateway's own policy catches it |
| Where it fails | The rule is not there | The relay's name is uncategorized or newly registered; TLS inspection presents a certificate the CLI does not trust; the network allows only an explicit proxy |
| How the far end is authenticated | A pinned host key | A public-authority certificate the CLI verifies, measured in the relay record |
| What the far end's operator sees | Ciphertext under the application-layer wrap, plus the files outside it | Ciphertext under DTLS, plus addresses, timing, and volume |

What the sources say about each difference:

- **Neither is blocked by generic guidance.** NIST's firewall guidance applies
  deny-by-default to inbound traffic and states that "less stringent policies
  are generally used for outgoing TCP and UDP traffic" [F6]. An organization
  that adopts SP 800-53's deny-by-default, allow-by-exception control at its
  managed interfaces (SC-7(5)) needs an exception for either [F4].
- **Port 443 meets the web gateway instead.** SP 800-53 SC-7(8) routes
  organization-defined traffic to external networks through authenticated proxy
  servers [F4], and a gateway on that path applies category policy.
  Palo Alto Networks recommends blocking its newly-registered-domain category,
  defined as registered within the last 32 days [V4]. Zscaler's guidance
  recommends blocking its newly registered and observed domains category,
  which covers a domain registered within the last 30 days or observed for the
  first time [V5]. A relay name registered for the purpose falls in the first
  for its first month, and a name nobody has reached before may fall in the
  second whatever its domain's age.
- **TLS inspection breaks the CLI's relay path unless the interception CA is
  trusted on the CLI host.** That is measured
  ([webrtc-relay-deployment.md](webrtc-relay-deployment.md#on-the-local-substitute)).
  Collaboration vendors whose media also relays over TCP 443 ask customers to
  exempt it from inspection: Microsoft for Microsoft 365 [V1], Cisco for Webex
  media [V2], and Zoom for its domains [V3]. Asking a partner to exempt the
  relay's name is therefore an established kind of request; that it applies to
  an Alcove relay is an inference by analogy.
- **An explicit proxy moves browser media onto it.** Chrome's
  `WebRtcIPHandling` policy value `disable_non_proxied_udp` makes WebRTC use UDP
  SOCKS proxying or fall back to TCP proxying [V6], the proxy mode RFC 8828
  describes [F10]. Whether the CLI's TURN client can reach a relay through an
  explicit proxy is unmeasured.

**Advisory:** TLS on 443 usually passes without anyone filing a request, which
is its advantage over SFTP. When it fails, it fails in the gateway -- a system
neither exchange operator runs -- and the CLI reports it only as
[no relay candidate gathered](../CLI.md#when-a-webrtc-exchange-does-not-connect).
The request to make of a partner's network team is "allow, and do not inspect,
TLS to this relay name on 443", made at the point in onboarding where the SFTP
rule would be requested, not after the first failed exchange.

**Advisory:** governance teams gate on the exchange agreement more than on the
port. SP 800-53 CA-3 governs an information exchange through a documented
agreement [F4], with SP 800-47 Rev. 1 as the guidance for drafting one [F5],
and SA-9(2) has providers identify the functions, ports, and protocols their
service needs [F4]. The relay, its operator, its name, and its port belong in
the data sharing agreement, as the SFTP server does.

### Relaying through a third-party managed service

**What HIPAA's published text says, without deciding it for a relay.**

- The 2013 Omnibus Rule preamble calls the conduit exception "a narrow one",
  limited to "transmission services (whether digital or hard copy), including
  any temporary storage of transmitted data incident to such transmission",
  and distinguishes a conduit from a business associate by "the transient
  versus persistent nature" of its opportunity to access the information; which
  side a service falls on "will be fact specific" [F1].
- HHS's cloud guidance holds that a service that maintains encrypted ePHI is a
  business associate even without the decryption key, and repeats that the
  conduit exception is limited to transmission-only services whose access is
  "only transient in nature" [F2].
- A TURN relay forwards ciphertext and stores nothing beyond transmission, which
  is the transmission side of that line. That reading is an inference: no source
  found names TURN or a media relay, and the determination is the deploying
  agency's, as [COMPLIANCE.md](../COMPLIANCE.md#hipaa-considerations) already
  states.

**What the vendors say of themselves.** Read 2026-09-21; each vendor's
documentation is undated unless a date is given.

| vendor | TLS on TCP 443 in its documentation | HIPAA position it states | per-session credential lifetime |
| --- | --- | --- | --- |
| Twilio Network Traversal Service [V7] | Its API examples list `turn:...:443?transport=tcp`, TCP rather than TLS; prose elsewhere states TLS support | On its HIPAA-eligible list (list dated 2020-10-20); a BAA requires its Security or Enterprise Edition | 24 hours unless the caller lowers it |
| Cloudflare Realtime TURN [V8] | `turns:turn.cloudflare.com:443?transport=tcp` | Not among the services its HIPAA page lists as in scope (inferred from absence). States it cannot read DTLS media and processes client addresses, ports, and session timing | Caller-set, up to 48 hours |
| Xirsys [V9] | Not confirmed; its documentation did not render for reading | States it qualifies for the conduit exception rather than signing a BAA | 60-minute access token (secondary source) |
| AWS Kinesis Video Streams WebRTC [V10] | `turns:` on 443 | Parent service on AWS's HIPAA-eligible list; the WebRTC capability is not named separately | Caller-set, minimum 30 seconds |
| Azure Communication Services network traversal [V11] | -- | -- | Retired 2024-03-31 |
| Metered [V12] | `turn:` on 443, TCP; no `turns:` example found | No HIPAA statement found; a GDPR data processing agreement | Caller-set, no default |

None of the six states how long it retains relay metadata. The relay record
already found one vendor answering TLS on 443 without advertising it, so the
port that works is checked per vendor rather than read from its URL list.

**A vendor-risk program meets the vendor, not the protocol.** CIS Safeguard
15.4 requires service provider contracts to include security requirements such
as breach notification, encryption, and data disposal [F7], and SP 800-53 SA-9
places the provider's controls in the contract [F4]. The usual evidence asked
for is a SOC 2 report against the AICPA Trust Services Criteria [F8], an
ISO 27001 certificate, or a HITRUST certification (market practice, secondary
sources only).

**Advisory: the other party meets the vendor second-hand.** A managed relay is a
vendor of the party that contracts it. For the partner it is that party's
subprocessor, reviewed -- if at all -- through the data sharing agreement rather
than the partner's own vendor program. Under the owner direction the inviter's
relay serves both parties, so a managed relay the inviter chose is one the
acceptor's governance meets this way.

**A managed relay moves the relay, not the minting.** Twilio, Cloudflare, and
Metered each mint per-session credentials from a long-lived account key they
say to keep on a server, never in the client [V7] [V8] [V12]. Someone still
holds that key and mints per exchange. Where the vendor's default lifetime is
longer than the one-hour ceiling -- Twilio's 24 hours -- the ceiling has to be
set on every call.

### What an inviter-run relay must log, retain, and attest

**Log.** coturn writes a usage line when a session closes, naming the realm, the
authenticated username, and the packets and bytes received and sent [V13]. A
credential minted per exchange has a per-exchange name, which makes that
line attributable to one exchange. The standing relay's bring-up did not observe
these lines in its container logs
([webrtc-relay-deployment.md](webrtc-relay-deployment.md#what-the-standing-deployment-carried)),
so the reference does not yet demonstrably produce the record a partner would
ask for.

**Retain.** No framework found sets one number for a relay.

- HIPAA's six-year retention applies to "the documentation required by
  paragraph (b)(1)" -- written policies and required records of actions and
  assessments; the text does not name audit logs [F3].
- SP 800-53 AU-11 leaves the period organization-defined [F4].
- CIS Safeguard 8.10: "Retain audit logs across enterprise assets for a minimum
  of 90 days" [F7].

**Advisory:** plan for at least 90 days of the relay's session logs, and expect a
partner's agreement to ask for incident notification within a set window and
for the relay's logs on request.

**Attest.** What an operator can state to a partner, each point backed by
something checkable:

| attestation | what backs it |
| --- | --- |
| The relay forwards DTLS without terminating it, and sees addresses, timing, and volume | [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security) and the relay measurement |
| Peer ranges are denied, so the relay cannot reach its own network | `verify.sh`, which passes only on an observed refusal ([`infra/relay/`](../../infra/relay/README.md)) |
| Credentials are minted per exchange and expire in an hour | `mint-credential.sh` and the rendered configuration |
| The relay is patched | The deployed image's version against the project's advisories, below |

Patch currency is a standing obligation, not a one-time statement. coturn's
advisory database lists 22 advisories, 19 of them published between 2026-02-23
and 2026-08-05; five of the 22 bypass the peer-address denial the reference
configuration relies on, four of those in 2026 [V13]. Several sit in features
the reference leaves off -- the telnet CLI, the web admin interface, mobility.
The reference pins its image by digest and a Dependabot entry raises each base
bump as a pull request, but the operator still redeploys.

## The profiles, one by one

### Credential service

**What it can stand up and operate.** An authenticated HTTPS endpoint, with its
own relays or a vendor account behind it. The build is within its reach; the
slow part is the new-system review an internet-facing service meets under its
own boundary controls (SC-7 [F4]) -- **advisory**.

**What its partners' governance will accept.**

- **TLS on 443 to its relay:** a relay under the organization's own established
  domain is the least likely to meet a gateway's newly-registered category.
  Whether a new subdomain takes its parent's category is unanswered. A partner
  may still need an inspection exemption for the name.
- **A managed relay behind its endpoint:** passes its own vendor program; its
  partners meet it as a subprocessor.
- **Log, retain, attest:** as above, and **advisory:** expect to be asked for
  the same assurance evidence -- a SOC 2 report or equivalent -- for the
  endpoint as for the relay behind it.

**Credential model.**

| | |
| --- | --- |
| Who mints | The endpoint, from the organization's static relay secret or vendor key |
| Lifetime | Minutes, within the one-hour ceiling; minted at exchange time, so it can be short |
| How it reaches the partner | A server-provided configuration: each party calls the endpoint at exchange time |

Of the three routes, this is the only one that delivers a fresh credential to
a partner, or to an unattended browser party, on every run without an operator
minting it. What it leaves open is how the
partner authenticates to the endpoint. The invitation is credential-free by
design
([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#invitation-contents-and-confidentiality);
superseded as a rule, see [What this record assumes](#what-this-record-assumes)),
and a per-partner API credential issued out of band is long-lived.
**Advisory:** an endpoint credential derived from the exchange's own rotating
shared secret, which the inviter already holds, is one candidate; the
configuration-shape work decides.

### Runbook relay

**What it can stand up and operate.** The reference relay: one instance from a
stock image, installed by one script, with automated certificate renewal and a
daily verification timer. What it takes to keep running:

- redeploying for coturn advisories, at the rate above;
- holding the static secret every credential is minted under;
- retaining the relay's logs, at least 90 days (**advisory**);
- opening inbound TCP 443 and the relay's UDP port range in its own firewall.

**What its partners' governance will accept.**

- **TLS on 443 to its relay:** the name is the risk. Register or delegate it
  well ahead of the first exchange, so it is past the 30- or 32-day
  newly-registered window [V4] [V5], and keep it stable -- the relay record
  already requires a stable name for other reasons. Whether a subdomain of the
  organization's established domain avoids the window is unconfirmed, and a
  gateway that also flags newly observed names may catch it anyway [V5].
- **Its own governance:** a new internet-facing server in its estate, which in
  many organizations needs a new-system or cloud-hosting approval -- **advisory**.
- **Log, retain, attest:** as above.

**Credential model.**

| | |
| --- | --- |
| Who mints | The operator, with `mint-credential.sh`, from the static secret |
| Lifetime | One hour |
| How it reaches the partner | Only by a route the posture does not have -- see below |

For its own allocations the operator mints locally. The partner needs a
credential only when its own network blocks UDP: a party with no TURN entry of
its own reaches a partner's relayed address over UDP, measured for a browser
party in
[the relay record](webrtc-relay-deployment.md#the-browser-qualification-revised),
at the cost of outbound UDP to the relay's high ports.

When the partner's network does block UDP, the credential has to arrive per
exchange, and none of the three routes fits:

- **The invitation** is minted once, is credential-free by design (superseded
  as a rule, see [What this record assumes](#what-this-record-assumes)), and may wait
  up to a year for acceptance
  ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#recurring-exchange-authentication)).
  A one-hour credential in it would expire before a slow acceptance and would
  never renew for a recurring run.
- **A server-provided configuration** is the credential-service posture's
  endpoint; adopting it moves the organization into that posture.
- **The deployment** configures only its own parties: a web deployment can
  give the browsers it serves a relay entry, not a partner's CLI.

**Advisory:** a fourth route is delivery at rendezvous, sealed under a key both
parties derive from their shared secret before the data channel opens. It is a
protocol change and is recorded here as an option, not a proposal.

### No relay of its own

**What it can stand up and operate.** Nothing, or a vendor account.

**The paths it has.**

- **Direct or STUN-only** works where both networks pass UDP; on either
  restrictive class the relay record measured, it has no path. The CLI's built-in STUN default discloses
  the host's public address to a third party
  ([CLI.md](../CLI.md#stun-and-what-it-discloses)).
- **The partner's relay**, as the acceptor: free when its network passes
  outbound UDP; otherwise it needs a credential delivered by one of the routes
  above.
- **A managed relay it chooses**, for its own allocations: it mints with the
  vendor key on its own host, sets the lifetime at or below one hour on every
  call, and puts the vendor through its own vendor review with either a BAA or a
  documented conduit determination.

**What its partners' governance will accept.** Its partners hold no credential
for its relay, but their traffic reaches the relay's address, which then sees
theirs. **Advisory:** a partner's governance will ask which vendor it is and
whether that vendor signs a BAA, even though the partner contracts nothing.

**Credential model.**

| | |
| --- | --- |
| Who mints | Itself, through the vendor's API |
| Lifetime | Vendor-dependent; set at or below one hour |
| How it reaches the partner | It does not: the acceptor's own entry serves only the acceptor |

A browser party in this posture has no relay at all: the web client builds its
peer connection with a fixed STUN set and no TURN entry
([EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#connectionstun)), so a
browser's relay entry can come only from the deployment.

## Which shape helps each profile most

- **Credential service:** support for the `ice_provision` endpoint in the CLI and
  the web client, with an endpoint authentication an invitation can name
  without holding a credential. It serves recurring and browser parties with no
  operator in the loop, and it is where a runbook relay ends up once its
  partners block UDP.
- **Runbook relay:** be the inviter. The invitation names the inviter's relay
  and the acceptor relays through it, so the party that has one should send the
  invitation (see [What this record assumes](#what-this-record-assumes)). Pair the reference relay
  with a stable name registered well ahead, and with an allow-and-do-not-inspect
  request to each partner's network team at onboarding.
- **No relay of its own:** be the acceptor, and use the inviter's relay, which
  the invitation names (the command line and the web app both relay through
  it). Where
  the partner has none, choose a managed relay that signs a BAA or document a
  conduit determination, and set its credential lifetime.
- **Every profile:** name the relay in the data sharing agreement, as the SFTP
  server is. **Proposed, not built:** a pre-flight check that dials the relay
  from the operator's host, which would turn the egress question into a step
  onboarding can check before the first exchange.

## What this record leaves to separate work

- **The concrete configuration shape.** What the keys and defaults look like and
  where each party's relay entry lives -- the invitation, the connection block,
  the web client -- is decided separately. That includes whether an invitation
  may name a relay or an endpoint without contradicting the credential-free
  invitation, how an endpoint authenticates a partner, and what the web client's
  ICE list holds. This record states what organizations will tolerate; it
  decides none of that.
- **The browser-side relay entry**, a disclosure decision the relay record
  raises.
- **Delivery at rendezvous**, which would be a protocol change and belongs to
  the specification if it is pursued.

## What remains unanswered

| question | what would answer it |
| --- | --- |
| Whether the CLI's TURN client reaches a relay through an explicit proxy | A relayed run from a host whose only egress is an explicit proxy |
| Whether a browser under `disable_non_proxied_udp` reaches a relay through the proxy | The same run with a browser party, once the web client has a TURN entry |
| Whether a gateway gives a new subdomain its parent domain's category | A gateway vendor's statement, or a test against one |
| Whether a TURN relay's operator is a HIPAA conduit for a given exchange | The deploying agency's own determination; no guidance found names TURN |
| How long each managed vendor keeps relay metadata | The vendors' answers; none of their documentation states a period |
| Whether the reference relay writes per-session usage lines | A relayed exchange against it with its logging checked |
| Whether Twilio offers TLS on 443 in its credential response | A live credential response; its examples show TCP only |
| The scope of Cloudflare's and AWS's HIPAA coverage for their relays | Each vendor's confirmation |
| What HHS's 405(d) practices (2023 edition), NIST SP 800-66 Rev. 2, the CalHHS Data Exchange Framework safeguards policy, and the Medi-Cal managed care contract's security exhibit say on relay egress and log retention | A read of each primary text; only secondary summaries were reached in the time box |
| The primary text of HHS's conduit FAQ on hhs.gov | A direct read; hhs.gov refused automated retrieval, and the same passage was read in an archived copy of the cloud guidance [F2] |

## Sources

Framework text and published guidance:

- **[F1]** HHS, "Modifications to the HIPAA Privacy, Security, Enforcement, and
  Breach Notification Rules" (Omnibus Final Rule), 78 Fed. Reg. 5566,
  2013-01-25, preamble at pp. 5571-5572.
  https://www.govinfo.gov/content/pkg/FR-2013-01-25/html/2013-01073.htm
- **[F2]** HHS Office for Civil Rights, "Guidance on HIPAA & Cloud Computing",
  question 3; content last reviewed 2022-12-23, read in an archived copy.
  https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html
- **[F3]** 45 CFR 164.316(b)(2)(i), current text, read 2026-09-21.
  https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C/section-164.316
- **[F4]** NIST SP 800-53 Rev. 5, "Security and Privacy Controls for Information
  Systems and Organizations", 2020-09 with later updates: SC-7, SC-7(5),
  SC-7(8), SA-9, SA-9(2), AU-11, CA-3.
  https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final
- **[F5]** NIST SP 800-47 Rev. 1, "Managing the Security of Information
  Exchanges", 2021-07. https://doi.org/10.6028/NIST.SP.800-47r1
- **[F6]** NIST SP 800-41 Rev. 1, "Guidelines on Firewalls and Firewall
  Policy", 2009-09.
  https://nvlpubs.nist.gov/nistpubs/legacy/sp/nistspecialpublication800-41r1.pdf
- **[F7]** CIS Critical Security Controls v8.1, 2024-06: Safeguards 8.10 and
  15.4. https://www.cisecurity.org/controls/v8-1
- **[F8]** AICPA, "2017 Trust Services Criteria (With Revised Points of Focus -
  2022)", 2022.
  https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022
- **[F9]** IETF RFC 8656, "Traversal Using Relays around NAT (TURN)", 2020-02.
  https://www.rfc-editor.org/rfc/rfc8656.html
- **[F10]** IETF RFC 8828, "WebRTC IP Address Handling Requirements", 2021-01.
  https://www.rfc-editor.org/rfc/rfc8828.html

Vendor documentation:

- **[V1]** Microsoft, "Microsoft 365 network connectivity principles", updated
  2026-08-31.
  https://learn.microsoft.com/en-us/microsoft-365/enterprise/microsoft-365-network-connectivity-principles
- **[V2]** Cisco, "Network Requirements for Webex Services", 2026-09-09.
  https://help.webex.com/en-us/article/WBX000028782/Network-Requirements-for-Webex-Services
- **[V3]** Zoom, "Network firewall or proxy server settings for Zoom", undated,
  read 2026-09-21.
  https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060548
- **[V4]** Palo Alto Networks, "URL Categories", undated, read 2026-09-21.
  https://docs.paloaltonetworks.com/advanced-url-filtering/administration/url-filtering-basics/url-categories
- **[V5]** Zscaler, "Best Practices for DNS Control Rules", undated, read
  2026-09-21 through a search engine's rendering, since the page does not
  render for automated retrieval.
  https://help.zscaler.com/zia/best-practices-dns-control-rules
- **[V6]** Google, Chrome Enterprise policy "WebRtcIPHandling", undated, read
  2026-09-21. https://chromeenterprise.google/policies/web-rtc-ip-handling/
- **[V7]** Twilio, "Network Traversal Service" and its REST API reference,
  undated, read 2026-09-21; "HIPAA Eligible Products and Services", 2020-10-20.
  https://www.twilio.com/docs/stun-turn and
  https://www.twilio.com/en-us/hipaa
- **[V8]** Cloudflare, Realtime TURN "Generate Credentials" and "FAQ", and the
  Cloudflare HIPAA page, undated, read 2026-09-21.
  https://developers.cloudflare.com/realtime/turn/faq/ and
  https://www.cloudflare.com/trust-hub/compliance-resources/hipaa/
- **[V9]** Xirsys, "FAQ", undated, read 2026-09-21. https://xirsys.com/faq/
- **[V10]** AWS, "GetIceServerConfig" API reference and "HIPAA Eligible Services
  Reference", undated, read 2026-09-21.
  https://docs.aws.amazon.com/kinesisvideostreams/latest/APIReference/API_signaling_GetIceServerConfig.html
  and https://aws.amazon.com/compliance/hipaa-eligible-services-reference/
- **[V11]** Microsoft, retirement notice for Azure Communication Services
  Network Traversal (public preview), 2023-09-29, effective 2024-03-31, read
  through a mirror of the Azure Updates feed; the product's quickstart
  redirects to the notice.
- **[V12]** Metered, "How to Create Expiring TURN Credentials" and its GDPR data
  processing agreement, undated, read 2026-09-21.
  https://www.metered.ca/docs/turnserver-guides/expiring-turn-credentials/
- **[V13]** coturn, `README.turnserver` and the project's issue tracker for the
  session usage line, undated; the project's GitHub security advisories, read
  2026-09-21. https://github.com/coturn/coturn/security/advisories
