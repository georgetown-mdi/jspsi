---
title: "PSI-Link Communication"
---

# PSI-Link communication

This document covers the communication channels available for PSI-Link exchanges, how parties synchronize protocol steps, how the web invitation and acceptance flows disclose and gate consent, how errors are handled, and what supporting services are required. Authentication and channel security are not covered here - see [SECURITY_DESIGN.md](SECURITY_DESIGN.md) for those topics. It does not cover the PSI protocol itself (see [PROTOCOL.md](spec/PROTOCOL.md)) or CLI configuration (see [CLI.md](CLI.md)). The implementation-level rationale for the terminal `ConnectionErrorKind` taxonomy is specified in the [transport-contract spec](spec/COMMUNICATION.md). Intended readers are IT staff and developers.

## Channels

If the exchange is to be accomplished without additional infrastructure, it must utilize existing communication channels. Three communication channels are currently supported:

* Peer-to-peer using WebRTC - this is a protocol that is primarily used by browsers to communicate with each other, for example when conducting video calls. Peer-to-peer connections can be difficult to establish when parties are behind corporate firewalls and using Network Address Translation (NAT). To facilitate these connections, a third-party server typically needs to be available to execute to either help establish the connection, or to explicitly route the traffic.
* SFTP - for many exchanges, one partner already runs an SFTP server that is used for secure file transfers. SFTP is less-than-ideal for a communication protocol, as it is a file transfer protocol and not a direct connection. That said, with frequent polling and strategies to resolve synchronization, it can be treated as a message passing channel with slight delays for each message. As the number of messages is independent of the size of the datasets, this represents a fixed, tolerable time cost.
* File-drop - transfers can be made through directories that both parties can access, for example an NFS or SMB network share provisioned by IT, or a folder backed by an SFTP server and mounted locally. The same file-based polling and synchronization protocol used for SFTP is applied directly to the mounted path. This is the simplest deployment option when shared storage already exists. No additional supporting services are required beyond read/write access to the shared directory. It is possible to conduct an exchange where one party utilizes a file-drop that is synchronized to a directory that is served by an SFTP server to which the other party connects.

## Synchronization

The protocol requires both parties to execute it at the same time. For a new exchange where one party may "invite" the other, the inviter can listen for the other partner to respond. For scheduled exchanges, which party shows up first is arbitrary and in order to execute the protocol there needs to be a way of resolving who will "speak" first and who will "listen".

For WebRTC, this is solved by a single-threaded peer-coordination service which ensures only one party can be "first". For SFTP, an implementation has been written that utilizes the uniqueness of file handles and catching server errors to handle rare race conditions.

When using a public coordination server, WebRTC additionally requires both parties to know each other's peer IDs before a connection can be established. These IDs are derived from the shared cryptographic token: each party holds a role of either inviter or acceptor, and each independently computes both IDs from the token and their role. This makes peer discovery self-contained and requires no out-of-band address exchange. The inviter and acceptor roles, the PSI protocol's sender and receiver roles, and the initiator and responder roles from the linkage terms handshake (see [Linkage terms](EXCHANGE_REFERENCE.md#linkage-terms)) are all independent of one another and each operate in a distinct phase of the exchange. For a private peer coordination server, directory listings can be used.

## Web invitation

On the web, the inviting party composes an invitation from its own data file. The browser reads the file locally -- it is never uploaded -- and derives the invitation's linkage terms from the file's columns: the default terms, narrowed to the keys those columns can satisfy. Those derived terms are what the acceptor reviews and consents to, and the inviter's own half of the exchange runs on the same terms and the same parsed rows, so the two parties agree on what to link without the inviter re-deriving the terms or re-selecting the file.

### Quick path

The inviter chooses a CSV and enters its name, then walks a short required spine -- choose the file, confirm what it discloses, review and create -- with the default terms filled in from the file; most exchanges need nothing beyond it. Composing fails closed before any setup secret is minted: a file that cannot be read, or whose columns satisfy none of the linkage keys, produces no invitation (the same zero-key condition the acceptor's pre-flight blocks on). Once the invitation is created the inviter moves to the share step, which leads with the invitation link to send out-of-band, and the expiry, alongside the proposed terms summary, and waits for the acceptor to connect; the bare code is offered as well only when the partner will accept through the command-line tool, whose accept takes the code alone (a browser partner pastes the whole link into the accept form instead). The bench previews only the leading and trailing characters of a copy-only artifact; the full value goes to the clipboard and is available behind an explicit reveal. On connect the share block gives way to the run status.

The spine also shows, once a file is chosen, which columns it will send to the partner for matched rows, and its disclosure is adjustable in place before creating. This is awareness only, not a gate: the displayed set is derived from the same predicate the exchange transmits on (so it cannot drift from what leaves the machine), and no column the default terms send stops being sent because of it. When it would send no columns it says so explicitly. Those disclosed columns are also declared in the invitation's payload data dictionary, so the partner's consent screen lists them as columns it will receive.

### Customizing the terms

The default terms are the file-derived defaults, and every part of them is adjustable in place -- there is no separate advanced screen. All customization seeds from the file (never a blank form), so it requires the CSV up front, and authors against a live preview using the same component the acceptor's consent screen uses, so the inviter sees the exact wording the partner will. Validation runs through the linkage-terms schema the exchange enforces; creating is blocked until the terms are valid and at least one key is satisfiable by the inviter's columns. The inviter can set:

- its name, the invitation duration, and who receives the matched results -- both parties, only the inviter, or only the partner (the exchange honors one-sided output end-to-end; the forbidden "neither receives" combination is not offered) -- on the review-and-create step;
- a column metadata grid mapping each column to a semantic type and one consequence-labeled disclosure choice (used to match, unique record identifier, sent to your partner, or ignored), on the confirm-disclosure step of the spine;
- which linkage keys are active and in what order (keyboard-operable, with a per-key indicator of whether the inviter's columns satisfy it), plus the linkage strategy, in a Keys tab reached from the Customize rows on the exchange ledger; choosing `single-pass` over the default `cascade` surfaces at the point of choice the disclosure tradeoff it carries (fewer round trips over a high-latency channel in exchange for disclosing more) and mints terms carrying that choice, which both parties must agree on or the exchange aborts. The disclosure mechanics and round-trip accounting are in [PROTOCOL.md](spec/PROTOCOL.md);
- an optional legal agreement (the partner must enter it identically), in an Agreement tab reached from the same Customize rows.

Per-field data cleaning is a Cleaning tab reached from the ledger's Customize rows, shown as a normal part of preparing for the exchange rather than gated behind expert mode: the inviter authors each field's cleaning steps -- raw regular-expression steps included, each marked "advanced" -- and chooses which column feeds it, with a whole-file coverage warning and a malformed-step gate that blocks creation, matching the acceptor's cleaning editor (below).

The matching algorithm (`psi-c`), deduplication, and fuzzy comparison are surfaced as controls but stay disabled until the exchange applies them, gated on the same applied-flags the consent screen reads, so a setting the run would not honor cannot be authored.

### Expert authoring and import/export

Expert mode unlocks building linkage keys element by element (each element's field chosen from the declared columns, never free-typed, with a typed-parameter transform pipeline and a two-of-N "match in either order" swap), plus a JSON/YAML import/export of the whole terms document round-tripped through the same validation. Adding a second field of one semantic type bound to a distinct column (e.g. a maiden and a current name) and referencing both in the keys is an expert action, since it is a key-authoring decision.

Import refuses a document that turns on an unapplied setting, or that carries a custom per-field constraint a key uses (rather than silently normalizing it to type defaults and generating an invitation under a different agreement than the document declared). The rest of an imported declaration is re-emitted faithfully -- field order and any declared-but-unreferenced field preserved, and a benign empty constraints object kept -- and an imported key referencing a field the inviter's columns cannot supply loads disabled but visible, so the satisfiable keys still generate.

### Per-party disclosure

Column disclosure and cleaning are per-party and local: they are threaded into the inviter's own half of the exchange, never embedded in the invitation, so they change only what the inviter discloses and its own match rate, not the agreed terms the acceptor consents to. See [SECURITY_DESIGN.md](SECURITY_DESIGN.md#invitation-contents-and-confidentiality) for how the derived terms disclose column shape (never row values) to the recipient.

## Web acceptance and consent

On the web, the acceptor reaches the accept flow either by opening the invitation deep link or by pasting the link or bare code into the quick path's "Review invitation" box; both carry the token in the URL fragment, which never reaches the server. Decoding the token enforces the invitation's expiry before any rendezvous or connect: an expired or invalid token fails closed, with no consent action offered. Otherwise it renders the inviter's proposed linkage terms for review, then gates the connection on affirmative consent and a prepared file. No rendezvous, key-exchange handshake, or PSI frame is set up before consent commits.

### The consent review

The proposed terms are organized around an always-visible core, tiered by disclosure direction and ordered so the most consequential fact is met first:

- **What you disclose** -- the acceptor's own outbound send and any request for its data (led first, since the acceptor's own disclosure is its hardest-to-undo fact);
- **What the exchange produces** -- the matching method and the result-sharing directions (what is revealed and to whom);
- **What you receive** -- the inbound partner data;
- **How records are matched** -- the linkage strategy and the matching keys.

An attached legal agreement is placed last in the core as a pre-consent governance checkpoint, surfaced whole (its reference, purpose, and expiry) rather than as a bare flag, because the purpose is the compliance-load-bearing field a disclosure accounting turns on (HIPAA 45 CFR 164.528, and FERPA's studies / audit-evaluation exceptions; see [COMPLIANCE.md](COMPLIANCE.md)). Each tier is a labelled, assistive-technology-navigable group.

Detail sits behind two default-collapsed disclosures: a "Matching strategies" disclosure (one further disclosure per linkage key, holding its elements, transforms, and swaps) and an "Other details" disclosure (field constraints, payload columns, and the deduplicate setting). The fields the keys match on are summarized always-visible above the matching detail, and both that summary and each key's one-liner are derived from the schema-validated field types, not the partner's key or field names, so a key's name cannot misrepresent what it matches on. Where a transform's parameter is coerced before it executes, the display shows the value that actually runs, so a displayed parameter cannot misstate the match. While collapsed, a disclosure's content is hidden from assistive technology, not only visually.

Facts that would otherwise stay buried until a disclosure is expanded are surfaced in the core: a count of the columns the invitation requests from the acceptor (under "What you disclose"), a count of the columns it will send the acceptor for matched records (under "What you receive", omitted when it sends nothing), and the full legal agreement. The two count lines read direction-first to keep the opposite flows distinct. A `single-pass` strategy is surfaced always-visible with the same disclosure note the inviter saw, since the acceptor adopts the inviter's strategy and so consents to it here; `cascade`, which discloses less, is not flagged.

The acceptor's own outbound disclosure -- the columns it will send for matched records -- is forward-referenced always-visible here, since before a file is chosen the exact set is not yet known: a fixed-copy line states that a disclosure is coming and the columns are confirmed later, when the acceptor confirms its columns. Once a file is chosen the actual send list replaces it.

### Consent gate

Having reviewed the terms, the acceptor gives affirmative consent (a checkbox plus its name) and chooses its own CSV on the consent step. Both consent and a name are required before the file is parsed, so choosing a file never pre-empts the consent gate.

The heading ("Invitation from &lt;name&gt;") carries a fixed-copy note marking the counterparty identity unverified: the name is free text the sender typed, carried in an invitation accepted on a transcription checksum rather than an authenticity guarantee. It informs the decision without gating it and shows on the pre-consent review only. A consent helper beside the checkbox reminds that the invitation should have reached the acceptor over a trusted channel. All partner-controlled text in the terms is escaped at display (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md), "Channel security").

### Confirm your columns

Once consent commits and the file parses, the acceptor confirms its columns. A grid maps each column to a semantic type and one consequence-labeled disclosure choice (used to match, unique record identifier, sent to your partner, or ignored), backed by a running summary of exactly which columns will be sent, and a live verdict of how many agreed linkage keys the current mapping satisfies. A file whose columns could match nothing lands here rather than bouncing to the file picker: the hard block remains -- an exchange that could match nothing cannot launch -- but the operator remaps columns in place. A column inferred as a record identifier is not sent by default.

A Cleaning tab reached from the accept ledger's Customize row presents the default cleaning as an editable, ordered list of steps (typed-parameter inputs, including raw regular-expression steps marked "advanced") against a live before-and-after preview over a sample of the operator's rows. Two whole-file checks guard failures the sample cannot show:

- a per-field coverage alarm when a transform has collapsed the field to no value for any row -- an otherwise-invisible failure, since it passes the satisfiability verdict and produces a result indistinguishable from a genuine non-match;
- a terms-derived advisory when a linkage key's own cleaning can never produce a value (e.g. a `parse_date` whose input format omits a component), flagged from the terms alone since the fix is the partner's, not the operator's.

Both inform rather than block. Constraint violations are also surfaced but not enforced (the application warns on constraints, it does not block on them). What does block launching is a malformed or incomplete cleaning step, alongside the satisfiability and single-identifier checks -- the same gate applied on the inviter's side. Raw patterns run under a bounded, non-backtracking engine, so a pathological pattern cannot freeze the tab; raw patterns inside a partner-authored, token-embedded key transform stay read-only, bounded by the wire dialect (see [PROTOCOL.md](spec/PROTOCOL.md#transform-regular-expression-dialect)).

The running send summary is the standing last look, so launching needs no separate confirmation. The metadata and cleaning the acceptor prepares are per-party and local -- never embedded in the invitation or cross-checked -- so they change only its own match rate and disclosure, never the agreed terms.

### Running the agreed terms

The exchange runs the inviter's terms with the acceptor's identity substituted and its output direction mirrored: the acceptor's "receives output" is the inviter's "shares with partner" and vice versa, so a one-sided invitation agrees rather than aborting (for the symmetric both-receive case the mirror is identical).

When the agreed terms give a party no result, the exchange withholds from that party -- in both the web app and the CLI -- both the matched result table and the partner's payload columns; a non-receiving helper is sent none of the partner's payload values and fails closed if it is sent any. It does still learn which of its own records matched (membership), an intrinsic property of helping compute the match. The two result-sharing lines are not equally enforced, and the consent copy marks the difference so cooperative withholding is not read as a cryptographic guarantee:

- the viewer's own non-receipt is enforced (sent none, fails closed on any it is sent), so a "No" there is a hard fact;
- the partner's non-receipt is cooperative, resting on the agreed terms being honored (the documented property of one-sided PSI; see [one-sided-disclosure.md](notes/one-sided-disclosure.md)). The partner's "No" additionally states the honest-helper membership disclosure. The partner's "Yes" notes that the agreement, not the tool, governs the result's use once it is out.

Settings the run does not yet apply are flagged proposed-but-not-applied by one consistent rule: the caveat renders at the same visibility level as the headline it contradicts, so a reader never sees a headline as in force while its caveat is hidden. `psi-c`'s count-only guarantee is disclosure-critical, so it and its caveat are always-visible in the core; deduplicate and fuzzy comparison change match breadth rather than disclosure, so their caveats sit with their headlines inside a disclosure. The run is currently one-to-one, fuzzy expansion is unimplemented, and `psi-c`'s count-only guarantee is not yet honored, so all three are surfaced as proposed and flagged.

The rendezvous peer-id derivation that places the two parties on the connection is specified in [PROTOCOL.md](spec/PROTOCOL.md).

## Message delivery and teardown

Each channel passes messages through a common transport contract whose one subtlety is worth stating explicitly, because it is easy to misread when auditing the code: a send completing does not mean the peer has received the message. There is no end-to-end delivery acknowledgement at this layer. What a completed send does guarantee differs by channel, and that difference is the whole contract. Every channel must guarantee that the final frame of an exchange survives a clean connection close, and it may do so in one of two ways.

The first way is a durable send with a draining close: the send writes the message durably before resolving, and the close waits for the peer to consume the last written message before sweeping it. The file-based channels - SFTP and file-drop - work this way. A send writes the message as a file in the shared directory and does not resolve until that write (and its atomic rename into place) is durable, so the frame is committed to disk before the caller proceeds. Because the sender's close also deletes the files it is responsible for, durability-on-disk alone is not sufficient: the close must drain the last sent file - wait for the peer to consume it - before cleanup runs. This gives the precise guarantee: the terminal frame is durability-until-consumed. Without the drain, the sender's cleanup could delete the file before the peer polls, and the peer would hang until its peer timeout.

The second way is a flushing close: the send only buffers locally, so a message can still be in flight when the sender finishes, and the close is what protects it. WebRTC works this way. A send hands the message to the data channel and returns before it is on the wire, so the final frame is guaranteed not by the send but by the close: a clean (non-error) close must flush the buffered frames before tearing the connection down, and the underlying reliable, ordered data channel delivers them ahead of the close signal the peer acts on. A close caused by an error does the opposite - it discards buffered outbound writes, because an errored link is already unusable.

The WebRTC case is the one that looks like a race when reviewed in isolation: the last operation a party performs is a non-blocking send immediately followed by a close, which appears to drop the frame. It does not, provided the close flushes - so a clean WebRTC close must not be shortcut into an abrupt connection teardown that bypasses the flush. The file-based channels have a different hazard: because the sender is responsible for deleting its own files, a send-then-immediately-close can delete the terminal file before the receiver polls. The drain in close() is what closes that gap.

Any new channel added to the project must satisfy one of these two conditions - a durable send with a draining close, or a flushing clean close. A transport that does neither will silently drop the final frame of an exchange. The same rule is recorded for implementors in the `Connection` and `TransportHooks` interface documentation in the core library.

The rules above govern outbound frames. Inbound delivery has a complementary guarantee that is easy to conflate with the outbound discard-on-error just described: a frame that has already arrived and been buffered is handed to a waiting `receive()` before any terminal error surfaces, whether the connection ended in a clean half-close or an abnormal drop. The two buffers are distinct - an errored close discards pending outbound writes, but never a received frame already sitting in the inbound queue. This is uniform behavior of the shared message queue, which sits above every channel, rather than a per-channel obligation; it is recorded for implementors in the `TransportControls` interface documentation alongside the rule above.

That inbound drain being uniform leaves only a small per-transport choice behind: each transport still wires which terminal control it calls on its own underlying events. Only one channel is close-capable today - WebRTC, in `apps/web/src/psi/peerMessageConnection.ts` - and it maps the data channel's `close` event to `finish()` (the clean half-close) and its `error` event to `fail()` (the abnormal drop); the file-based channels surface only `fail()`. This residue must not be removed by introducing a shared `Connection.close` *event*. A broadcast close event would be delivered only to whatever listener happened to be attached, reintroducing the no-listener drop window that the pull-based queue was built to eliminate - the same window that makes a completed receive, not an event callback, the unit of delivery. Teardown therefore stays driven through the queue's `finish()`/`fail()` controls rather than an event.

## Error handling

In the case of communication channel errors, messages that fail to transmit are retried. The initial connection is retried on a transient failure up to a user-specified limit (`max_reconnect_attempts`); a connection attempt that times out is terminal and is not retried, since a retry cannot recover an unresponsive server or mount. On the SFTP channel a clean session drop mid-exchange is transparently re-dialed and the interrupted operation re-issued, so the exchange survives a server that drops the held session; that survival is itself bounded, by the same `max_reconnect_attempts` limit applied cumulatively over the exchange, so a server that keeps capping the session ends the run with an actionable terminal error rather than reconnecting indefinitely. An unrecoverable drop still ends the exchange with a terminal error. As the communication channels in use guarantee message correctness, any message that fails to validate indicates a deviation from the protocol and results in program termination.

Terminal failures are tagged with a `ConnectionErrorKind` (the kinds and their meanings are documented on that type in the core library) so a consumer can branch on the cause. A deliberate local close surfaces as `"closed"` (nothing went wrong on this side), while a clean remote close, a dropped link, and a peer timeout all surface as `"transport"` (the link ended; a retry is reasonable). The deferred-decision rationale for that taxonomy -- why a clean remote close is not given its own kind, why a non-attributable local crypto/runtime fault is tagged `"transport"` rather than `"security"` or a dedicated `"system"` kind, and the condition that would reopen each -- is in the [transport-contract spec](spec/COMMUNICATION.md#connectionerrorkind-classification).

## Supporting services

The communication channels described above each depend on supporting infrastructure. These services can be deployed in two patterns to minimize resource consumption between exchanges:

**Lifecycle provisioning**: the service has a fixed, permanent address but is started on demand before each exchange and stopped afterward. Both parties know the address statically and may independently trigger startup. This is the preferred model for most supporting services and maps well to serverless compute platforms.

**Address-returning provisioning**: a fresh resource is allocated for each exchange and its address is not known in advance. This is inherently asymmetric - the inviting party allocates the resource during the invitation flow, and the resulting address is communicated to the other party as part of the invitation. By the time either party runs the CLI, both have the static address in their configuration.

Some services support **symmetric provisioning**: both parties call the same provisioning endpoint independently at the start of each exchange and receive their own credentials without needing to coordinate the result with each other. ICE credential services operate this way.

Public fallback instances of each supporting service are provided. When a party uses a public instance, the application issues a warning because connection metadata or encrypted data must flow through a server outside their direct control. Parties are encouraged to operate their own instances when possible; deployment guidance and reference configurations are available in [DEPLOYMENT.md](DEPLOYMENT.md).

### STUN/TURN

For parties behind Network Address Translation (NAT) or corporate firewalls, an Internet Connectivity Establishment (ICE) protocol assists in establishing peer-to-peer WebRTC connections. STUN servers help each party discover their public address; TURN servers relay traffic when no direct path can be found.

STUN and TURN servers can be configured statically or their credentials can be obtained on demand from an ICE credential API. Commercial services such as Twilio Network Traversal Service return time-limited credentials at the start of each exchange. Both parties call the same endpoint independently - this is a symmetric provisioning operation requiring no coordination.

### WebSocket-to-TCP proxy

Browser runtimes cannot open raw TCP connections and must use WebSockets instead. A proxy server translates between the two protocols, allowing a browser to reach services such as an SFTP server that speak TCP natively.

This proxy is a property of the client's runtime environment rather than the server: a browser-based party must configure a proxy while a CLI party connects natively. The two parties' connection configurations may therefore differ here even when connecting to the same underlying server.

### Peer coordination

Establishing a WebRTC connection requires a signaling step in which both parties exchange session descriptions and ICE candidates before a direct channel can be opened. The project uses PeerJS for this: each party registers with a PeerJS-compatible server under a token-derived peer ID and then locates their partner using the complementary ID. PeerJS also provides the data channel implementation used for chunked data transfer over the established connection; signaling and data transport are therefore not independently separable in the current design.

The peer coordination server is well-suited to lifecycle provisioning. It is only needed during the brief signaling phase before the WebRTC data channel is established, after which the two peers communicate directly. Hosting it as a serverless WebSocket function - for example on AWS Lambda with API Gateway or Cloudflare Workers - allows it to cold-start on demand and go idle between exchanges with no standing cost.

### SFTP

A lightweight SFTP server may be operated as a drop zone for exchanges between parties who prefer file-based communication to WebRTC. Like the peer coordination server, an SFTP server is suitable for lifecycle provisioning: its address is fixed and it can be stopped between exchanges. Directory-level access controls on a shared SFTP server can alternatively provide per-exchange isolation without requiring dedicated instances.

## See also

- [SECURITY_DESIGN.md](SECURITY_DESIGN.md) - threat model and security properties of the channels described here
- [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md) - `connection` block reference for configuring the channels described here
- [DEPLOYMENT.md](DEPLOYMENT.md) - operating the supporting services described here
- [CLI.md](CLI.md) - CLI commands for configuring and running exchanges over these channels
