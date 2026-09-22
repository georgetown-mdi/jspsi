---
title: "The Three Exchange-File Readers Under the Portable-Configuration Rule"
---

# The three exchange-file readers under the portable-configuration rule

_Status: rule decided on the maintainer's ruling and specified in [EXCHANGE_FILE.md](../spec/EXCHANGE_FILE.md#what-a-consumer-does-with-a-setting-it-cannot-honor); the unread-key refusal behind it is built. This note records the audit each reader was measured by, what it found, and the two gaps left open. See [docs/notes/README.md](README.md)._

One schema, three applications. The spec states what a reader owes a setting it
cannot run; this is what each reader did about it when the rule was written down,
and what was changed.

## Why a stripped key was the first finding

The top level of the exchange file is strict, so an unknown key there has always
been a loud refusal. Every block below it -- `linkage_terms`, `metadata`,
`standardization`, the sftp and filedrop connections, their `options`, the
connection's `server` -- strips instead, and the strip looked harmless while the
only reader was a CLI that loads a file and runs.

It stops being harmless the moment a reader writes the file back out. Each of
`saveConfig`, the web application's command-line export, and any editor that
round-trips a document writes the PARSE RESULT, so a key the parse dropped is a
line the operator wrote and the next file does not hold. The operator has no way
to see it happen: the file they get back is well-formed and one setting short.

The fix is a comparison rather than a rewrite of forty schemas. `parseExchangeSpec`
parses, then walks the document against its own parse result and reports every key
the result does not hold, as the `unrecognized_keys` issue a strict object would
have raised (`packages/core/src/config/unreadKeys.ts`). Two properties came out of
reporting it in Zod's own issue shape: the CLI renders it through the path it
already renders schema failures through, and the web application's import wording,
which already names an unrecognized key exactly as the file spells it, needed no
new branch.

What it cannot see is bounded and stated in the module. An opaque subtree is not
entered: its keys are the author's own, kept verbatim by both the camelize pre-pass
and the schema, and `provider_options` is the one key naming such a subtree
(`OPAQUE_VALUE_KEYS` in `packages/core/src/utils/camelizeKeys.ts`). The key naming
it is read like any other, so a channel whose schema declares no `provider_options`
refuses one. A transform's `params` record is walked like any other node and yields
no false report, since the schema reads the whole record through and the parse
result holds every key the document wrote.

### An array the collapse shortened

One normalization shortens an array: the payload dictionary keeps the first entry
naming a column and drops a later entry naming that column again
(`columnsNamedOnce`). The document's entries are lined up with the result's by that
name, so a dropped entry is measured against the entry kept in its place rather
than against the result as a whole.

- A dropped entry that states something the kept entry does not -- a
  `description`, or one of the same keys with a different value -- is refused as
  the duplicate it is, naming the column and both entries. Reporting the keys it
  states as keys no block reads would name a documented payload-column key and
  point the operator at the wrong line.
- A dropped entry that states nothing the kept entry does not is loaded. The rule
  is that a consumer "MUST NOT write a document short of a setting the one it read
  stated", and every setting such an entry states the saved document states too;
  the line is written twice, and the collapse stays the normalization the schema
  intends rather than becoming a refusal for a repeated line.

### Two spellings of one key

The comparison runs between the camelized document and the parse result, so a key
the camelize pre-pass itself drops is missing from neither side. A document writing
one setting as both `expected_payload_columns` and `expectedPayloadColumns` states
two keys that are read as one name, and the pre-pass keeps one of the two. A second
walk therefore reads the document AS WRITTEN and refuses two sibling keys that
camelize to one name, naming both as the file writes them (`collidingKeyIssues`).
It reaches furthest on the three fail-closed records, where the spelling that
survives decides what a receive-side enforcement holds the partner to.

## The three readers

**The CLI's config load** (`apps/cli/src/config.ts`, `loadConfig` in
`apps/cli/src/commands/exchange.ts`). It honors what it reads or refuses loudly:
an algorithm, a deduplicate shape, or a signing mode this build does not implement
is already its own refusal, and a runtime-injected `authentication` field is warned
about by name rather than dropped. Four divergences, each a refusal at load
where the block's schema on its own strips the key: a `connection.authentication`
block (the pre-refactor location); CLI-only invocation flags written into
`connection.options` (`sweep_exchange_files`, `force_retain_sweep`); an option
under `connection.options` the connection's own channel does not read
(`poll_interval_ms` on a webrtc connection, which the filedrop and sftp schemas
read and webrtc's does not); and `provider_options` on a channel whose schema
declares none (filedrop). One more divergence is in the naming rather than the
outcome: a schema refusal named its field by the camelCase path the parsed shape
uses, so `expected_payload_columns` reached the operator as
`expectedPayloadColumns`. `describeConfigSchemaError` renders each path
segment in snake_case mechanically, so a block authored in camelCase (a
`linkageTerms:` block, say) is still reported as `linkage_terms`; only the
refused KEY is named as the file spells it, for both config-file call sites,
through the one path rendering the per-block renderer beside it takes -- which
stops a path at a `params` block, whose keys are the author's own.

The renderer names the path; the KEY an `unrecognized_keys` refusal reports is
named in core, where the raw document is in hand. `unrecognizedKeysAsWritten`
looks each key up among the document's own siblings rather than converting the
camelized name back, so a key authored in camelCase, or outside both conventions,
is named the spelling its author used. It runs over every such refusal, the ones
the strict blocks raise themselves included (the top level and `authentication`,
worded by Zod over the camelized shape), so one key reaches the operator one way
whichever block holds it.

That application reads the same file a second way, which is one reader's other
path rather than a fourth reader (`readConfigLinkageSource`,
`apps/cli/src/config.ts`). `psilink invite` and `psilink verify-receipt` do not
load the whole file: they read `linkage_terms`, `standardization`, and
`metadata` block by block, leaving the connection out so a still-placeholder one
does not fail the read. Each block has its own parse entry point, and those
strip -- so a file `psilink exchange` refused was a file `psilink invite` minted
an invitation from, over terms narrowed by whatever the strip took, with nothing
said to either party. All three blocks are read through the entry point that
applies the same comparison
(`safeParseLinkageTermsTheReaderWrote` and the `TheReaderWrote` siblings for the
other two), so for those three blocks one file is accepted by both commands or
refused by both, and refused naming the same key. A misspelled top-level key
outside those three (`expected_payload_columns`, say) is not covered by this
comparison: `psilink invite`'s read still accepts it, and only `psilink
exchange`'s full load refuses it, so the file still fails closed at exchange
time rather than earlier.

**The console's job layer** (`apps/web/src/jobs/`). No load path exists to audit.
The layer composes an exchange file from the console's own intent and validates
what it composed; nothing there reads an operator's document. The rule reaches it
when a load leg is built, and the fail-closed records name what that leg cannot
quietly shed.

**The web application's managed import** (`apps/web/src/psi/managed/`). Already the
rule's model: it refuses a webrtc connection field outside the credential-free
locator subset, a top-level field outside what it composes, a credential written
as a value, and a secret, each naming the fields and never their values. A
channel it does not run is not among them: such a configuration imports as a
configuration only, and the limit is met where a run would start
([MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#the-configuration-only-record)).
Because nothing runs an sftp record there, it holds every setting of an sftp
connection unchanged, a credential among them as an `@path` reference it never
resolves: the refusal is kept for a literal credential, which the browser would
have to store, and for a webrtc setting the browser run could not apply
([MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md#the-connection-block-credential-free-by-composition)).
It holds `role` and
`token_max_age_days` as local record fields and re-injects both on export, so an
unedited import and re-export are the same document. Its own audit finding was the
nested strip, fixed in core above; its bespoke `connection.server` allowlist stays,
since it reads the file's own object and so measures a key in the spelling the
operator wrote.

## The two gaps left open

**The held-setting notice may not spell a key as the file did.** The rule's
middle outcome has two halves: hold the setting unchanged, and tell the operator
this surface will not let them change it. Both are built. The holding half is
tested in both directions, and the web application's configuration-only page
tells the operator, naming each setting it keeps without showing or editing it
and warning separately about each setting that names a file by `@path`
(`apps/web/src/recurring/managedConfigurationModel.ts`). What stays open is the
spelling: the page names the settings from the stored record, whose keys the
parse has camelized, so a key the file wrote in camelCase is named in
snake_case there rather than as written.

**The CLI's refusal cites one issue.** A config failing schema validation reports
the first issue and a count of the rest, so a document with several dropped keys
names one of them per load. That is the shape its refusal has always had, and the
bound on it is deliberate -- an operator's document can fail against a great many
fields at once.
