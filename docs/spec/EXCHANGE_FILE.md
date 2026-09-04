---
title: "Exchange File Artifact"
---

# Exchange file artifact

This document specifies the downloadable **exchange file**: the `psilink.yaml`
a party composes in the web application and hands to the CLI. It covers what the
artifact is (the shared CLI config schema, not a parallel format), the
mint-layer guarantees layered on top of it, the versioning and compatibility
policy between a continuously-deployed web app and a pinned CLI, the
payload-disclosure commitments its fields hold and the run-time gates that
enforce them, the channel-binding semantics an accepting tool must honor, and the
path the shared secret takes (never the file). It is the implementation-level
complement to the
field-level [exchange reference](../EXCHANGE_REFERENCE.md), which an operator
opens to author or read a `psilink.yaml`, and to the **Provisioning the key file
from an invitation** material under that document's
[Authentication](../EXCHANGE_REFERENCE.md#authentication) section; this document
covers how the artifact is constructed and what it does and does not promise. It
does not cover the field-level meaning of any config field (see
[EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md)), the invitation token's
connection-endpoint sub-schemas (see [FILE_SYNC.md](FILE_SYNC.md)), or the
owner-only write discipline the key file it provisions is written under (see
[CREDENTIAL_STORAGE.md](CREDENTIAL_STORAGE.md)). The token's own wire format --
its encoding, its checksum, and its top-level field layout -- is specified in no
document of this tier; `packages/core/src/config/invitation.ts` is the only
statement of it. Intended readers are security auditors and implementors.

## The artifact is the CLI config schema

A minted exchange file is an ordinary `psilink.yaml`. There is no web-specific
format, no parallel schema, and no field a CLI-authored config could not also
hold. The web mint layer (`mintExchangeFile` in
`packages/core/src/config/exchangeFile.ts`) assembles the exchange on the
camelCase side, validates it through the same `ExchangeSpecSchema`
(`packages/core/src/config/exchangeSpec.ts`) both applications share, and
serializes the parse result -- not the pre-validation input -- through the same
`snakeizeKeys` + YAML `stringify` discipline the CLI's `saveConfig`
(`apps/cli/src/config.ts`) uses. The output is `snake_case` on disk, the
convention every hand-authored config follows, and the CLI's `loadConfig`
(`apps/cli/src/commands/exchange.ts`) reads it through `parseExchangeSpec`
(which `camelizeKeys` then re-validates through the identical schema) with no
web-aware step.

Serializing the parse result rather than the assembled input is a structural
guarantee, not a convention: only the schema's own fields reach the YAML, so a
caller that bypassed the TypeScript types could not smuggle an extra top-level
field into a minted file. A validation failure throws a `ZodError` on the
minting side, so a malformed exchange never becomes a downloadable file that the
CLI would later reject.

### Mint-layer guarantees

The schema is the shared contract; the mint layer adds three guarantees a
hand-authored config is not obligated to meet. They are guarantees about what a
minted file cannot contain; the commitments it does hold, and what enforces
them, are in [Payload-disclosure consent](#payload-disclosure-consent) below.

- **No `authentication` block.** The mint layer never assembles the top-level
  `authentication` block at all. The schema makes that block optional and gives
  it three fields: `shared_secret` and `expires`, both key-file-injected at
  runtime, and the operator-policy `token_max_age_days`, which an operator sets
  in `psilink.yaml` and no mint path has a value for. So a minted file that omits
  the block has no secret and no place to put one, and leaves the max-age
  policy to whoever runs it. This mirrors `saveConfig`, which strips
  `shared_secret` and `expires` from any `authentication` block a caller leaves
  populated -- and leaves `token_max_age_days` standing; the mint layer reaches
  the same end by never building the block.
- **No credential field is representable.** The mint layer's input connection is
  a credential-free locator type (`ExchangeFileConnection`: `SftpExchangeLocator`
  or `FiledropExchangeLocator`). By construction these types have no `username`,
  `password`, `privateKey`, `privateKeyPassphrase`, `hostKeyFingerprint`, or
  `keyboardInteractive` field, so a credential cannot reach a minted file even by
  mistake -- the type is the enforcement, not a runtime strip. WebRTC is
  outside this type: a WebRTC exchange is coordinated live, not from
  a downloaded file, so the mint layer covers only the file-sync channels
  (`sftp`, `filedrop`).
- **The SFTP placeholder username.** An SFTP locator has no identity field,
  so a minted SFTP connection seeds the one SSH identity field the operator must
  supply, `username`, with the shared placeholder constant
  `PLACEHOLDER_SSH_USERNAME` = `REPLACE_WITH_SSH_USERNAME`
  (`packages/core/src/config/endpointProducer.ts`). The placeholder is
  not a valid credential, so a downloaded config run before the
  operator fills it in fails loudly rather than connecting anonymously. The same
  constant is used by the CLI's `connectionFromEndpoint`, so the "fill this in"
  marker is identical wherever a config was minted.

## Versioning and compatibility policy

The hosted web application is continuously deployed; a CLI in the field is
pinned to whatever `@psilink/core` version its release shipped with. A newer web
app can therefore mint a file whose schema is newer than an older CLI's. The
policy below is the direct consequence of the schema mechanics, not a separate
promise layered over them.

### What a minted file targets

A minted file targets the `ExchangeSpecSchema` of the `@psilink/core` version the
web app shipped with. Both applications embed the same schema; the artifact is
valid against the version that produced it. That is the whole promise on the
compatibility axis.

### What an older CLI does with a newer file

The observable outcome depends on where the field diverges, and the cases differ
sharply:

- **An unknown top-level key is rejected loudly.** `ExchangeSpecSchema` is a
  `z.strictObject`, so a key the older CLI's schema does not know -- whether a
  newer web app's addition or an operator's typo -- is reported from `loadConfig` as
  a load-time `UsageError` (CLI exit 64) naming the key, and the exchange never
  starts. Four of the top-level keys are enforcement records whose absence is a
  valid state (`outbound_payload_consent`, `disclosed_payload_columns`,
  `expected_payload_columns`, `expected_partner_deduplicate`), so stripping a
  misspelling of one would silently disable the control it names; that hazard
  governs the whole top level rather than being spot-checked key by key.
- **An unknown field inside a spec block is silently stripped.** The blocks
  themselves (`linkage_terms`, `metadata`, `standardization`, `connection`) strip
  unrecognized keys on parse. That property, not any one schema kind, is what this
  case rests on: the blocks are built from different Zod constructs -- an object
  for `linkage_terms`, an array for `metadata` and `standardization`, a
  discriminated union for `connection` -- and strip is the behavior they share. A
  newer web app that adds an optional field within one of them drops that field on
  load; the exchange runs on the fields the older CLI does understand. This is a
  silent narrowing, not a loud rejection.
- **An unknown enum value is rejected loudly.** A field whose value changed to
  one an older schema does not accept -- a new `algorithm`, a new
  `linkage_strategy`, a new semantic `type`, a new `channel` -- is a
  `z.enum`/`z.literal` the older schema rejects. `loadConfig` reports the
  `ZodError` as a load-time `UsageError` (CLI exit 64) naming the field. The
  exchange never starts.
- **The `authentication` block is validated strictly.** Like the top level and
  unlike the sibling spec blocks, `AuthenticationSchema` is a `z.strictObject`: an
  unrecognized key there is rejected, not stripped, because it holds an operator
  security policy (`token_max_age_days`) a typo must not silently disable. A
  minted file never includes this block, so it matters only for an operator-edited
  config.

The critical property across all four cases: an incompatibility is reported as
a loud load-time validation error (or, for a stripped unknown field within a
block, a run over the understood subset), never a silent reinterpretation of a
value into something it did not mean.

### What is not promised

There is no back-compatibility guarantee for existing artifacts. Breaking changes
to the config file format are explicitly in scope: a future core version may change field shapes or semantics, and a file minted by
one web version is not promised to load unchanged under a differently-versioned
CLI. The compatibility mechanics above are what keeps such a break visible -- an
incompatible file fails validation with a named field rather than loading with a
misread value -- not a promise that the break will not happen. An operator who
downloads a file should run it against a CLI of the matching generation, and
re-mint (or re-invite) rather than hand-migrate a file across a breaking change.

## Payload-disclosure consent

Four fields hold a party's payload-disclosure commitments, and every one of them
is enforced at run time rather than merely recorded. Three are top-level keys of
the artifact -- `expected_payload_columns`, `disclosed_payload_columns`, and
`outbound_payload_consent`, siblings of `linkage_terms` -- and the fourth,
`disclosedPayloadColumns`, rides the invitation token (its wire declaration and
version policy are in
[FILE_SYNC.md](FILE_SYNC.md#disclosed-columns-subset-on-the-token); its
job-intent form in [SERVER_JOB_API.md](SERVER_JOB_API.md)). None of the three
local fields is exchanged, cross-checked against the partner, or folded into the
agreed-terms hash. What an operator authors, and what each field means to them,
is in [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#linkage_termspayload).

The set of columns any of them describes is always
`disclosedColumnNames(metadata)` over some party's metadata -- the names
`isDisclosedToPartner` selects and `preparePayload` transmits -- never a
separately authored dictionary. That is what keeps a consented set from drifting
from the bytes that flow. Each field is bounded to `MAX_PAYLOAD_ENTRIES` entries
of `MAX_NAME_LENGTH` each, the same bounds a `payload.send`/`receive` list
holds.

### Absent, empty, present: one rule for every field

The three states are distinct at every one of these fields, and the distinction
is the whole disclosure control:

- **Absent** is lazy: no commitment is on record, so nothing is compared. A
  first-contact party, a config predating the field, and a guided or default
  path that authored no dictionary are all here.
- **Present and empty** is strict, and is *not* the absent case. `[]` asserts
  "nothing", and any later non-empty set violates it.
- **Present and non-empty** is strict in both directions: a narrowed set fails
  exactly as a widened one does, because the exchange record and the partner's
  consent surface state the confirmed set.

Laziness relaxes only the declaration check, never what is disclosed.
Transmission stays governed by each sender's own `isDisclosedToPartner` metadata
and the send-side guards below, so a lazy receiver still receives only what the
sender's consented metadata transmits.

### Receive-side runtime enforcement (`reconcileReceivedPayload`)

A party holding a locked-in expected set verifies, after the payload exchange and
before the result or audit record is built, that the partner transmitted exactly
that set. A mismatch aborts the exchange as a `ConnectionError` of kind
`protocol` (CLI exit 69): the partner promised one disclosure and delivered
another. Because it runs after the payload exchange, it stops the exchange from
completing rather than stopping the columns from crossing.

The locked-in set is the acceptor's carried `disclosedPayloadColumns` (consented
at review time, threaded to `runExchange` as `prepared.expectedPayloadColumns`),
or the config's own top-level `expected_payload_columns`, falling back to the
negotiated `payload.receive` names for an authored recurring config. The
top-level field is distinct from `payload.receive` so it does not
trip the compatibility mirror; the fallback is safe because that mirror equals
the partner's declared `send`, which in turn equals what the partner transmits.

Two cases are **not** a mismatch: an absent expected set (the lazy
path), and an empty *received* set. The partner sends nothing both when it
discloses nothing and when no row matched, which can never exceed any consent,
and which is also what lets a correctly gated no-output party pass.

How a party arrives at its set, by exchange mode:

- **Invite/accept.** The inviter publishes its disclosed subset on the token and
  leaves its own receive side blank, filling lazily from the acceptor's first
  transmission. The acceptor locks in the carried subset -- known up front, with
  no observation needed -- and both an offline and an online accept persist it to
  the written config so a later `psilink exchange` enforces what was consented to
  at accept time. An acceptance that reuses a pre-existing config refreshes that
  config's field surgically in place, leaving the operator's connection and
  linkage blocks untouched: a partner that changes only what it discloses is
  re-consented to on that acceptance, and a prior acceptance's set left standing
  would false-abort the next exchange against an honest partner. An invitation
  with no subset *removes* the field rather than leaving a set this
  acceptance never showed.
- **Zero-setup.** Neither party holds the other's metadata in advance, so the
  first exchange reconciles lazily and neither throws. A `--save` run
  crystallizes the set it observed into the config it writes.
- **Recurring.** Both parties' persisted configs hold the commitment, so each
  enforces its own -- the runtime, actual-bytes counterpart to
  `validateCompatibility`'s terms-level send/receive mirror.

**An observe-then-persist writer records only an unambiguous observation.** The
online inviter and a zero-setup `--save` party learn their set by watching the
first exchange, and two observations are not safe to persist. An observed *empty*
set is left absent, because a partner that discloses nothing and a first exchange
with zero matched rows are indistinguishable on the receive side, and persisting
`[]` would false-abort a later run that does match. An observation above
`MAX_PAYLOAD_ENTRIES` is likewise left absent: the wire message bounds each
column name but not the count, while the persisted field is bounded on reload, so
crystallizing it would write a config this party could no longer load, and
truncating would false-abort every later run against the partner's full set. The
token-carry path needs neither guard, because the invitation bounds its subset at
intake.

### Send-side mint-boundary guard (`assertPayloadSendDisclosed`)

The receive-side commitment's counterpart, holding a *present* `payload.send` to
exactly the disclosed set and rejecting both over- and under-declaration, so the
dictionary shown for consent and written into the exchange record matches the
bytes that flow. It runs inside `prepareForExchange`, before any credential,
terms, or data are sent, so a contradiction costs no disclosure.

The empty case is where this guard is a disclosure control rather than an
accuracy one: an acceptor's `send` is `deriveAcceptedLinkageTerms`'s mirror of
the inviter's `payload.receive`, so an empty one holds the partner's
declaration that it will take nothing, held against metadata that may be
*inferred* -- where every column that is not a linkage or PII alias defaults to
`is_payload: true`. That empty-send enforcement, and only it, is gated on this
party's own `output.share_with_partner`: with the partner entitled to no result
nothing crosses whatever the metadata discloses, leaving a disclosure control
nothing to control. A non-empty `send` is checked in both directions regardless
of entitlement, because that dictionary is exchanged, consented to, and recorded
whatever moves.

The gate reads a **local** declaration -- it runs before `validateCompatibility`
has mirrored the partner's `expectsOutput` -- so it determines the coherence of this
party's own configuration, while the `runExchange` send gate, reading the
partner's authenticated terms, stays the fail-closed control over what actually
leaves.

### Send-side prepare-time commitment (`assertDisclosureMatchesCommitment`)

The runtime enforcement above catches a partner that under- or over-delivers, but it
fires on the *receiver*, after data has moved, and attributes the abort to the
partner. Its proactive counterpart runs on the *committing* party at prepare
time, before any credential, terms, or data are sent: a party that persisted the
disclosed set it published -- the top-level `disclosed_payload_columns`, in this
party's own column namespace -- verifies that its current metadata still
discloses exactly that set, and throws a `UsageError` (CLI exit 64, a local
configuration error) naming the offending column(s) otherwise. Without it a
metadata drift on the committing side silently under-delivers a promised column,
and the partner aborts mid-exchange under a partner-attributed `protocol` error;
this turns that into an early, self-attributed local failure.

The error states a **dual** remedy -- restore the column's metadata to transmit,
*or* re-establish the exchange with the narrower disclosure -- so it never
pressures the operator toward wider disclosure, narrowing one's own disclosure
being always legitimate.

**Every mint that publishes a subset also persists it, and no mint skips it.**
That binding is what keeps the commitment from going stale against the token the
partner locked in: a re-invite over edited metadata republishes a fresh token and
refreshes the field in the same operation, so the two cannot disagree. The online
invite and the offline infer-from-input path write a fresh config and include it
in the ordinary `saveConfig`; the offline invite-from-config and re-invite paths
reuse the operator's config and write the field surgically through the YAML
document model, leaving operator content and comments untouched. A config that
declares no metadata block publishes no subset, so the field is *removed* rather
than left at a stale prior value. The only remaining drift is metadata edited
without re-inviting, which is exactly the case this guard catches. The acceptor
does not persist this field: its send side is covered by its own consent record
instead, because the mirrored `payload.send` the mint-boundary guard holds to the
disclosed set is present only when the inviter authored a `payload.receive`.

### The acceptor's outbound consent (`assertOutboundPayloadConsented`)

An acceptance's outbound column set is authored by no party. The invitation
authors the inviter's `payload.send`; the mirror leaves the acceptor's own `send`
absent whenever the inviter authored no `receive` -- the common invite shape --
so the set is resolved from the acceptor's own CSV header, where inference makes
every unrecognized column `role: payload, is_payload: true`. Neither guard above
reaches it: the mint-boundary guard early-returns on an absent `send`, and
`disclosed_payload_columns` records a promise to the partner that an acceptance
never makes. So an acceptance records the set it *showed* the operator, in a
third per-party local field:

- `outbound_payload_consent: { status: confirmed, columns: [...] }` -- the exact
  set the operator was shown and consented to, in this party's own namespace. The
  empty set is a real confirmation that nothing is disclosed.
- `outbound_payload_consent: { status: pending }` -- the acceptance could not
  resolve the set (no input file was named, or its columns could not satisfy the
  invitation's linkage keys), so nothing is confirmed yet.
- **Absent** -- no record, and nothing is checked. Every non-acceptor is here (an
  inviter, a zero-setup run, a hand-authored config), as is an acceptance whose
  partner is entitled to no result.

`assertOutboundPayloadConsented` enforces it inside `prepareForExchange`, before
any credential, terms, or data are sent, throwing a `UsageError` (CLI exit 64) on
`pending`, or on a `confirmed` set the run no longer resolves. The comparison is
by **membership** in both directions but **not by order**, since metadata order
decides which order columns are transmitted in and not which are. Like the two
fields above it is gated on `output.share_with_partner`.

Every fresh acceptance surface derives the record through one function,
`deriveOutboundPayloadConsent`: `psilink accept` writes it into the configuration
it provisions, the browser's accept composes it into the exchange-file document
it persists as a [managed exchange](MANAGED_EXCHANGE_RECORD.md), and a console
acceptance composes it into the CLI configuration the console runs the job from
(see [SERVER_JOB_API.md](SERVER_JOB_API.md), "Composed CLI configuration"). The
two composing surfaces derive it from the same `metadata` the document they write
holds -- so the persisted record and the persisted metadata cannot state
different disclosures. A front end shows the set and takes the answer; this
assert is the run-boundary safety check behind whichever one prepared the exchange,
so an unattended run refuses rather than transmit a set no party chose.

**Lifecycle across re-acceptance and re-invitation follows one rule:** no
machine-managed field may lag the operation that rewrites the config's role or
terms, and no partner-controlled input may remove one from a config that still
transmits. An acceptance that reuses an existing config therefore derives the
refreshed record from the *kept* config's own `output.share_with_partner`, never
solely from the invitation's mirror -- reconciliation compares no output field,
so an invitation on which the mirror yields no record cannot decide that about a
kept config that still shares. There the record falls to `pending`, and it is
removed only where the kept config itself does not share, where a leftover record
is inert. A mint over the same config removes the record on the same rule the
`disclosed_payload_columns` refresh follows: the config becomes the inviting
side's, whose outbound set is that commitment instead. One narrow shape restores
the pre-record laziness, stated as a limit: a mint over a config with no
metadata block publishes no commitment either, so both gates end up absent and a
later unattended exchange from that config transmits its inferred set unchecked,
exactly as every pre-record config does. The removal there weakens no previously
enforced set, but nothing replaces it.

### The no-output send gate

The payload channel is gated on output entitlement, closing the one-sided
disclosure analyzed in
[one-sided-disclosure.md](../notes/one-sided-disclosure.md): `runExchange`
transmits payload only to a partner whose agreed terms entitle it to the result
(`output.expects_output`), so a non-receiving helper -- which learns no matched
records -- is sent no payload. The receive side fails closed as a safety check: a
party with `expects_output: false` expects the empty set and aborts with the
`protocol` error above if it is sent any payload regardless. This is enforced in
the protocol, alongside the schema rule forbidding a no-output party from
declaring `payload.receive` columns; it is left neither to the data dictionary
nor to operator discipline.

## Terms-binding consent

One top-level key states a commitment about the partner's *terms* rather than
its payload: `expected_partner_deduplicate`, a sibling of `linkage_terms` and a
boolean. It records the [`deduplicate`](PROTOCOL.md#deduplicating-cardinalities-many-to-x-matching)
an accepted invitation declared for the *inviting* party's own side. Like the
payload records above it is per-party and local -- never exchanged,
cross-checked, or folded into the agreed-terms hash -- and like them it is
enforced at run time rather than merely recorded.

`runExchange` holds the value the partner presents at the terms exchange to it
(`assertPresentedDeduplicateMatchesInvitation`, `packages/core/src/exchange.ts`)
and aborts on a contradiction as an `InvitationTermDivergenceError` -- a
`ConnectionError` of kind `protocol`, CLI exit 69 -- before any key or payload
moves. The refusal is one-sided by construction: only the accepting party holds
the declaration.

Two states, not three: the empty case has no analogue here.

- **Absent** means no binding is enforced, not that only a file with nothing to
  bind reaches this state. It is the state of an exchange authored from two
  parties' own configuration files, where the differing pair is exactly what
  makes one of them the "many" side, and no acceptance ever had a value to
  record. Two further paths reach it despite an acceptance: the online-accept
  reuse branch warns and continues when persisting the declaration to an
  existing config fails ("...and to no value if it records none"), and a
  config written by a build predating the field has none to read back.
- **Present** binds strictly, `false` no less than `true`. A declared `false`
  against a presented `true` is the widening the record exists to refuse.

The field is distinct from `linkage_terms.deduplicate` beside it,
which is *this* party's own side: `deriveAcceptedLinkageTerms` sets an
acceptance's own value to `false` and retains nothing of the inviter's, so a run
that read the binding off its own terms would refuse the legitimate differing
pair. The two are read from separate keys and never derived from one another.

Every path that reaches an acceptance records it: the CLI's offline accept writes
it into the config it composes, the online accept carries it on the bootstrap's
config write and refreshes a reused config in place, the browser's managed
deposit persists it into the record's document, and a console server-job accept
forwards it into the composed config. A later run restores it from the config
onto `prepared.expectedPartnerDeduplicate`. No mint path records it: an inviter
accepted no declaration.

## Channel-binding semantics

An invitation may bind a connection endpoint (the credential-free
`ConnectionEndpoint` locator, `packages/core/src/config/invitation.ts`) so the
accepting party can reach the rendezvous without separate out-of-band setup. An
endpoint names exactly one channel, and the accepting party's tool must be able
to drive that channel. There is no cross-transport promise and no renegotiation:
what a build can drive is fixed at build time, and an endpoint it cannot drive is
refused rather than adapted.

The drivable set is not a property of "browser versus CLI" but of the tool and,
for the web application, its deployment profile:

- **CLI.** `sftp`, `filedrop`, and `webrtc`. `psilink accept` seeds the endpoint
  into the acceptor's connection through the single consumer
  `connectionFromEndpoint` (`apps/cli`), which also applies the mirror swap for a
  split-directory endpoint. A seeded `webrtc` connection holds the locator
  only; the accept path stamps `role: acceptor` onto it (`withWebRTCPeerRole`),
  and the channel needs the shared secret both parties derive their rendezvous
  ids from, so `psilink exchange` refuses a webrtc run that reaches it without a
  secret or without a stamped `role`.
- **Browser, hosted profile.** `webrtc` only. A file-sync endpoint names a
  directory or an SFTP host the browser cannot reach.
- **Browser, console profile.** `webrtc`, `filedrop`, and `sftp`. The console
  build runs a file-sync exchange through its job API rather than in the page, so
  a file-sync endpoint is drivable there and is accepted.

Enforcement lives at the acceptor's accept path. In the browser,
`prepareAcceptedInvitation` (`apps/web/src/psi/acceptInvitation.ts`) admits an
endpoint only through `endpointDrivableHere(endpoint, profile)`, a switch over
the channel union that is exhaustive with no `default` -- so a newly added
channel fails to compile until it is classified, the allowlist
discipline rather than a blocklist that would admit an unvetted channel. A token
with no endpoint, or one this build cannot drive, throws before any
rendezvous is attempted:

> This invitation does not carry a connection endpoint this build can accept, so
> it cannot be run here.

Because every failure path throws, a caller that only dials on success cannot
reach across transports.

The endpoint itself holds only a public locator (signaling URL, SFTP
host/port/path, or a file-drop directory / split pair) and never a credential;
the per-channel sub-schemas are `z.strictObject` and reject any field outside the
locator allowlist. The endpoint wire format and the split-directory mirror swap
are specified in [FILE_SYNC.md](FILE_SYNC.md#split-inboundoutbound-directories).

## The secret's path

The shared secret rides only the invitation code. It never enters the exchange
file, and each party provisions its own `.psilink.key` from the code:

- **The file has no secret.** As above, a minted file has no
  `authentication` block, and `saveConfig` strips `shared_secret`/`expires`
  regardless. The 256-bit setup secret an invitation holds
  (`SHARED_SECRET_REGEX`: 43 base64url characters encoding 32 bytes,
  `packages/core/src/config/connection.ts`) is confidential and travels only on
  the encoded invitation code, over a trusted out-of-band channel.
- **The three provisioning paths.** `psilink invite` writes the inviter's key
  file (secret plus expiry); `psilink accept` writes the acceptor's copy
  (secret, with the invitation expiry stripped); and
  `psilink exchange --invitation CODE` provisions the key file for the party that
  composed the exchange in the web app and downloaded a secret-free config,
  writing the inviter-side copy (secret **and** expiry, matching `psilink
  invite`) so the invitation's bounded lifetime is enforced at exchange time.

### `exchange --invitation` fail-closed ordering

`provisionKeyFileFromInvitation` (`apps/cli/src/keyFile.ts`) is the ordering
authority for that path, and it is fail-closed at each step:

1. **Refuse if a key file already exists.** A key file present at the key path is
   a `UsageError` (exit 64), never an overwrite. After the first exchange the
   secret rotates, so re-supplying the original code must not resurrect a stale
   secret; provisioning is a first-time step, re-established only by re-inviting.
   This check runs first, before the code is even decoded.
2. **Decode and validate before any write.** The code is decoded and validated
   for checksum, schema, and expiry (`decodeAndValidateInvitation`) before
   anything is written, so a malformed or expired code raises its `UsageError`
   and leaves the filesystem untouched -- nothing is written and no connection
   is attempted.
3. **Write the key file, then load the config.** Only on success is the key file
   written (with the token's shared secret and expiry). The handler runs this
   provisioning step ahead of `loadConfig`, so the config load then finds the
   provisioned key and the exchange proceeds as a normal recurring `exchange`.
   The `--invitation` value is never `@`-resolved into `argv`; its `@`-file form
   (`--invitation @code.txt`) is read at decode time, keeping the code out of
   shell history and the process argument list.

The owner-only on-disk write discipline the key file is written under -- the
POSIX exclusive-create, atomic-rename, and `fsync` durability that keeps a
freshly written or rotated token from being lost or world-readable -- is
specified once in [CREDENTIAL_STORAGE.md](CREDENTIAL_STORAGE.md) and is not
repeated here. The secret rotation the key file undergoes after each successful
handshake is covered in
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#recurring-exchange-authentication).
