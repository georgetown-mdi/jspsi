---
title: "Exchange File Artifact"
---

# Exchange file artifact

This document specifies the downloadable **exchange file**: the `psilink.yaml`
a party composes in the web application and hands to the CLI. It covers what the
artifact is (the shared CLI config schema, not a parallel format), the
mint-layer guarantees layered on top of it, the versioning and compatibility
policy between a continuously-deployed web app and a pinned CLI, the
channel-binding semantics an accepting tool must honor, and the path the shared
secret takes (never the file). It is the implementation-level complement to the
field-level [exchange reference](../EXCHANGE_REFERENCE.md), which an operator
opens to author or read a `psilink.yaml`, and to the **Provisioning the key file
from an invitation** material under that document's
[Authentication](../EXCHANGE_REFERENCE.md#authentication) section; this document
covers how the artifact is constructed and what it does and does not promise. It
does not cover the field-level meaning of any config field (see
[EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md)), the invitation token wire
format and its endpoint sub-schemas (see [FILE_SYNC.md](FILE_SYNC.md)), or the
owner-only write discipline the key file it provisions is written under (see
[CREDENTIAL_STORAGE.md](CREDENTIAL_STORAGE.md)). Intended readers are security
auditors and implementors.

## The artifact is the CLI config schema

A minted exchange file is an ordinary `psilink.yaml`. There is no web-specific
format, no parallel schema, and no field a CLI-authored config could not also
carry. The web mint layer (`mintExchangeFile` in
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
hand-authored config is not obligated to meet:

- **No `authentication` block.** The mint layer never assembles the top-level
  `authentication` block at all. The schema makes that block optional, and its
  only fields today (`shared_secret`, `expires`) are key-file-injected at
  runtime, so a minted file that omits the block carries no secret and no
  place to put one. This mirrors `saveConfig`, which strips `shared_secret` and
  `expires` from any `authentication` block a caller leaves populated; the mint
  layer reaches the same end by never building the block.
- **No credential field is representable.** The mint layer's input connection is
  a credential-free locator type (`ExchangeFileConnection`: `SftpExchangeLocator`
  or `FiledropExchangeLocator`). By construction these types have no `username`,
  `password`, `privateKey`, `privateKeyPassphrase`, `hostKeyFingerprint`, or
  `keyboardInteractive` field, so a credential cannot reach a minted file even by
  mistake -- the type is the enforcement, not a runtime strip. WebRTC is
  deliberately outside this type: a WebRTC exchange is coordinated live, not from
  a downloaded file, so the mint layer covers only the file-sync channels
  (`sftp`, `filedrop`).
- **The SFTP placeholder username.** An SFTP locator carries no identity field,
  so a minted SFTP connection seeds the one SSH identity field the operator must
  supply, `username`, with the shared placeholder constant
  `PLACEHOLDER_SSH_USERNAME` = `REPLACE_WITH_SSH_USERNAME`
  (`packages/core/src/config/endpointProducer.ts`). The placeholder is
  deliberately not a valid credential, so a downloaded config run before the
  operator fills it in fails loudly rather than connecting anonymously. The same
  constant is used by the CLI's `connectionFromEndpoint`, so the "fill this in"
  marker is identical wherever a config was minted.

## Versioning and compatibility policy

The hosted web application is continuously deployed; a CLI in the field is
pinned to whatever `@psilink/core` version its release shipped with. A newer web
app can therefore mint a file whose schema is newer than an older CLI's. The
policy below is the honest consequence of the schema mechanics, not a separate
promise layered over them.

### What a minted file targets

A minted file targets the `ExchangeSpecSchema` of the `@psilink/core` version the
web app shipped with. Both applications embed the same schema; the artifact is
valid against the version that produced it. That is the whole promise on the
compatibility axis.

### What an older CLI does with a newer file

The observable outcome depends on how the field diverges, and the two cases
differ sharply:

- **An unknown field is silently stripped.** The spec-tier sub-schemas
  (`linkage_terms`, `metadata`, `standardization`, `connection`, and the
  top-level spec object itself) are bare `z.object` schemas, which strip
  unrecognized keys on parse. A newer web app that adds an optional field an
  older CLI's schema does not know drops that field on load; the exchange runs
  on the fields the older CLI does understand. This is a silent narrowing, not a
  loud rejection.
- **An unknown enum value is rejected loudly.** A field whose value changed to
  one an older schema does not accept -- a new `algorithm`, a new
  `linkage_strategy`, a new semantic `type`, a new `channel` -- is a
  `z.enum`/`z.literal` the older schema rejects. `loadConfig` surfaces the
  `ZodError` as a load-time `UsageError` (CLI exit 64) naming the field. The
  exchange never starts.
- **The `authentication` block is validated strictly.** Unlike the spec blocks,
  `AuthenticationSchema` is a `z.strictObject`: an unrecognized key there is
  rejected, not stripped. A minted file never carries this block, so this matters
  only for an operator-edited config, but it is the one part of the config whose
  unknown-key handling is fail-closed rather than fail-strip, because it alone
  holds an operator security policy (`token_max_age_days`) a typo must not
  silently disable.

The load-bearing property across all three cases: an incompatibility surfaces as
a loud load-time validation error (or, for a stripped unknown field, a run over
the understood subset), never a silent reinterpretation of a value into something
it did not mean.

### What is not promised

There is no back-compatibility guarantee for existing artifacts. Breaking changes
to the config file format are explicitly in scope: a future core version may change field shapes or semantics, and a file minted by
one web version is not promised to load unchanged under a differently-versioned
CLI. The compatibility mechanics above are what keeps such a break honest -- an
incompatible file fails validation with a named field rather than loading with a
misread value -- not a promise that the break will not happen. An operator who
downloads a file should run it against a CLI of the matching generation, and
re-mint (or re-invite) rather than hand-migrate a file across a breaking change.

## Channel-binding semantics

An invitation may bind a connection endpoint (the credential-free
`ConnectionEndpoint` locator, `packages/core/src/config/invitation.ts`) so the
accepting party can reach the rendezvous without separate out-of-band setup. An
endpoint names exactly one channel, and the accepting party's tool must speak
that channel. There is no cross-transport promise and no renegotiation: a browser
speaks only `webrtc`, and the CLI speaks `sftp`/`filedrop`.

Enforcement lives at the acceptor's accept path, per tool:

- **CLI.** `psilink accept` seeds the endpoint into the acceptor's connection
  through the single consumer `connectionFromEndpoint` (`apps/cli`), which also
  applies the mirror swap for a split-directory endpoint. The endpoint is a
  file-sync locator (`sftp`/`filedrop`); the CLI has no WebRTC transport yet.
- **Browser.** `prepareAcceptedInvitation`
  (`apps/web/src/psi/acceptInvitation.ts`) requires the token's
  `connectionEndpoint` to be present and `channel === "webrtc"`; a token without
  one, or carrying a different channel, throws before any rendezvous is
  attempted ("This invitation does not carry a WebRTC connection endpoint, so it
  cannot be accepted in the browser."). Because every failure path throws, a
  caller that only dials on success cannot reach across transports.

The endpoint itself carries only a public locator (signaling URL, SFTP
host/port/path, or a file-drop directory / split pair) and never a credential;
the per-channel sub-schemas are `z.strictObject` and reject any field outside the
locator allowlist. The endpoint wire format and the split-directory mirror swap
are specified in [FILE_SYNC.md](FILE_SYNC.md#split-inboundoutbound-directories).

## The secret's path

The shared secret rides only the invitation code. It never enters the exchange
file, and each party provisions its own `.psilink.key` from the code:

- **The file carries no secret.** As above, a minted file has no
  `authentication` block, and `saveConfig` strips `shared_secret`/`expires`
  regardless. The 256-bit setup secret an invitation carries
  (`SHARED_SECRET_REGEX`: 43 base64url characters encoding 32 bytes,
  `packages/core/src/config/connection.ts`) is confidential and travels only on
  the encoded invitation code, over a trusted out-of-band channel.
- **The three provisioning paths.** `psilink invite` writes the inviter's key
  file (secret plus expiry); `psilink accept` writes the acceptor's copy
  (secret, with the invitation expiry stripped); and the new
  `psilink exchange --invitation CODE` provisions the key file for the party that
  composed the exchange in the web app and downloaded a secret-free config,
  writing the inviter-side copy (secret **and** expiry, matching `psilink
  invite`) so the invitation's bounded lifetime is enforced at exchange time.

### `exchange --invitation` fail-closed ordering

`provisionKeyFileFromInvitation` (`apps/cli/src/keyFile.ts`) is the ordering
authority for the new path, and it is fail-closed at each step:

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
