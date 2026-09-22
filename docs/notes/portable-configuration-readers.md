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

What it cannot see is bounded and stated in the module: an opaque free-form record
(a transform's `params`) is not entered, since its keys are the author's own and
pass through verbatim, and where a normalizing schema shortens an array -- the
payload dictionary collapsing two entries naming one column -- a key is measured
against every surviving entry rather than a positional counterpart.

## The three readers

**The CLI's config load** (`apps/cli/src/config.ts`, `loadConfig` in
`apps/cli/src/commands/exchange.ts`). It honors what it reads or refuses loudly:
an algorithm, a deduplicate shape, or a signing mode this build does not implement
is already its own refusal, and a runtime-injected `authentication` field is warned
about by name rather than dropped. Two divergences, both now refusals: a
`connection.authentication` block (the pre-refactor location, previously stripped)
and CLI-only invocation flags written into `connection.options`
(`sweep_exchange_files`, `force_retain_sweep`, previously stripped). A third was in
the naming rather than the outcome: a schema refusal named its field by the
camelCase path the parsed shape uses, so `expected_payload_columns` reached the
operator as `expectedPayloadColumns`. `describeConfigSchemaError` names each
segment as the file spells it, for both config-file call sites.

**The console's job layer** (`apps/web/src/jobs/`). No load path exists to audit.
The layer composes an exchange file from the console's own intent and validates
what it composed; nothing there reads an operator's document. The rule reaches it
when a load leg is built, and the fail-closed records name what that leg cannot
quietly shed.

**The web application's managed import** (`apps/web/src/psi/managed/`). Already the
rule's model: it refuses a channel it does not run, a connection field outside the
credential-free locator subset, a top-level field outside what it composes, and a
secret, each naming the fields and never their values. It holds `role` and
`token_max_age_days` as local record fields and re-injects both on export, so an
unedited import and re-export are the same document. Its own audit finding was the
nested strip, fixed in core above; its bespoke `connection.server` allowlist stays,
since it reads the file's own object and so measures a key in the spelling the
operator wrote.

## The two gaps left open

**No notice for a setting held without an editor.** The rule's middle outcome has
two halves: hold the setting unchanged, and tell the operator this surface will not
let them change it. The holding half is built and tested in both directions; the
telling half needs a surface to tell it on, and the import has none. A field the
web application stores and cannot edit (`retention_disposition` is the one a stored
document can hold today) therefore survives a round trip in silence.

**The CLI's refusal cites one issue.** A config failing schema validation reports
the first issue and a count of the rest, so a document with several dropped keys
names one of them per load. That is the shape its refusal has always had, and the
bound on it is deliberate -- an operator's document can fail against a great many
fields at once.
