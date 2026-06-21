---
title: "Canonical Encoding for Receipts"
---

# Canonical encoding for receipts

PSI-Link receipts -- the [self-attested record](EXCHANGE_RECORD.md) and the
certificate-backed non-repudiation receipt (see
[PROTOCOL.md](PROTOCOL.md#non-repudiation)) -- are
hashed and signed over a byte string. For a hash or signature to verify, every
party that produces or checks a receipt must derive exactly the same bytes from
the same logical object. That includes an independent third party -- an auditor
running a different implementation, possibly in a different language -- who has
only the receipt, the certificate, and this document.

The [Canonical encoding](../SECURITY_DESIGN.md#canonical-encoding) overview
covers what this encoding is for and what it protects against; this document is
its normative complement -- the specification of that byte string. It is written
so the bytes can be reproduced without reading the PSI-Link source. Wherever a
detail is delegated to an external standard, that standard is cited; nothing is
left to an implementation's discretion.

## Normative reference

The canonical encoding is **[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785),
JSON Canonicalization Scheme (JCS)**, applied to the restricted value domain in
[Value domain](#value-domain) below. An implementation that produces RFC 8785
output for an object in that domain produces the correct PSI-Link canonical
bytes; the rules in [Encoding rules](#encoding-rules) restate the parts of
RFC 8785 that matter here, plus the additional constraints PSI-Link imposes so
that the input domain is always reproducible.

RFC 8785 reuses two ECMAScript ([ECMA-262](https://tc39.es/ecma262/)) operations
verbatim: number-to-string conversion (`Number.prototype.toString`, equivalently
`JSON.stringify` of a number) and JSON string production (`JSON.stringify` of a
string). Both are fully specified by ECMA-262 and produce identical results in
Node.js and every browser, which is why the canonical bytes are
platform-independent.

## Scope

This encoding is the single canonicalization primitive for everything that is
hashed, committed, or signed: the agreed-terms object embedded in a receipt, the
[self-attested record](EXCHANGE_RECORD.md), the receipt itself, and the signing
certificate -- whose
self-signature is computed over, and whose pinned fingerprint is a SHA-256 of,
the canonical bytes of its body (see
[PROTOCOL.md](PROTOCOL.md#signing-identity-and-certificate-pinning)). It
supersedes ad hoc `JSON.stringify` and key-sorting for those artifacts. Equality
checks that must match a hashed form -- for example the cross-party
linkage-terms comparison in `validateCompatibility` -- use it too, so that
"equal" means "hashes equal".

It is **not** the wire format for exchange messages or configuration files;
those remain ordinary JSON/YAML.

## Value domain

A value to be canonically encoded is one of:

| Kind | Notes |
|------|-------|
| string | any sequence of Unicode scalar values (see [Strings](#strings)) |
| number | finite; integers must be **safe** (see [Numbers](#numbers)) |
| boolean | `true` or `false` |
| null | the JSON null literal |
| array | ordered list of values in this domain |
| object | unordered set of string-keyed members whose values are in this domain |

Everything else is **rejected** rather than coerced, because silent coercion is
the classic way two implementations diverge:

- `undefined` -- as an object member value, an array element, or the top-level
  value. An absent field is expressed by **omitting the key**, never by a
  member set to `undefined` (see [Absent versus null](#absent-versus-null)).
- Non-finite numbers (`NaN`, `Infinity`, `-Infinity`).
- Integers outside the safe range (see [Numbers](#numbers)).
- `bigint`, symbols, and functions.
- Non-plain objects: dates, maps, sets, typed arrays, class instances, and
  anything else that is not a plain JSON object. **Binary data is not a member
  of the domain**; it must be encoded to a string first (see
  [Binary fields](#binary-fields)).

A conforming implementation MUST reject an out-of-domain value with an error
rather than emit bytes for it.

## Encoding rules

### Object member ordering

Object members are sorted by their keys, and the sort is applied recursively at
every level of nesting. Keys are compared **by UTF-16 code unit**: each key is
viewed as the sequence of 16-bit code units of its UTF-16 encoding, and keys are
ordered by the first position at which they differ, by numeric code-unit value.
This is the ordering produced by ECMAScript `Array.prototype.sort` with no
comparator, and is the ordering RFC 8785 specifies. Duplicate keys cannot occur
(the input is a set of members).

Array element order is **significant** and is preserved as given.

The encoder sorts keys but does **not** fold their **casing**: two objects whose
keys differ only in snake_case-vs-camelCase form (`{"input_format": ...}` vs
`{"inputFormat": ...}`) encode to different bytes. This matters for the
partner-controlled `transform.params` keys, the only linkage-terms keys whose
form could vary. They are normalized to camelCase at **every** parse path that
produces a `LinkageTerms` -- config load and the post-handshake wire path (via
`camelizeKeys` in `parseLinkageTerms`), and the invitation decode path (via
`InvitationLinkageTermsSchema`, which camelizes before validating). So by the
time terms reach a canonical encoding they are already camelCase on both sides: a
casing fold is a parse-layer invariant, not something the consumers re-do. The
agreed-terms hash (`computeTermsHash`) and the cross-party
`validateCompatibility` comparison therefore both encode the same camelCase form
without folding, which is what keeps the hash cross-party reproducible. A
third-party implementation reproducing the agreed-terms hash must normalize
`transform.params` keys to camelCase the same way (a `snake_case` key in a token
is folded at decode, so the hashed form is camelCase).

### Numbers

A number MUST be finite. RFC 8785 serializes a number as ECMAScript
`Number.prototype.toString` would (equivalently, `JSON.stringify` of the
number): the shortest decimal string that round-trips to the same IEEE-754
double, with `-0` rendered as `0`, no insignificant trailing zeros, and
exponential form only outside the range RFC 8785 fixes.

PSI-Link adds one constraint to keep the input reproducible: an **integer-valued
number MUST be a safe integer**, i.e. its absolute value is at most
2^53 - 1 (`9007199254740991`). Beyond that range a decimal integer literal in
the source JSON may not round-trip to the same double across implementations, so
such a value MUST instead be encoded as a string by the producer. Finite
non-integer numbers are permitted and follow the rule above without further
constraint.

Receipt and record numeric fields that are hashed or signed (result sizes, row
counts) are **safe integers by schema** -- they are validated as safe integers
before a receipt is assembled -- so for those fields the number format reduces
to a plain decimal integer with no exponent.

### Strings

Strings are serialized exactly as ECMAScript `JSON.stringify` serializes a
string, which is what RFC 8785 requires:

- The string is delimited by `"`.
- These characters use two-character escapes: `"` becomes `\"`, `\` becomes
  `\\`, backspace (U+0008) becomes `\b`, tab (U+0009) becomes `\t`, line feed
  (U+000A) becomes `\n`, form feed (U+000C) becomes `\f`, carriage return
  (U+000D) becomes `\r`.
- Any other control character in U+0000 through U+001F is escaped as a
  six-character backslash-u-zero-zero-XX sequence with **lowercase**
  hexadecimal digits (U+0000 and U+001F escape to their lowercase six-character
  forms, shown exactly in the `control-character-escapes` test vector).
- The forward slash `/` is **not** escaped.
- Every other character, including all non-ASCII characters, is emitted as its
  **raw UTF-8 bytes** -- it is not `\u`-escaped. For example the euro sign
  (U+20AC) is emitted as the three bytes `E2 82 AC`.
- A lone surrogate (an unpaired UTF-16 surrogate code point) is escaped as
  `\uXXXX` with lowercase hex, per ECMA-262 well-formed JSON stringification.

### Absent versus null

`null` is a value; an absent member is the absence of a key. They are distinct
and encode differently: `{"a":1}` and `{"a":1,"b":null}` are different objects
with different bytes. A member whose value would be `undefined` is not "null" and
is not "absent in a tidy way" -- it is rejected. Producers express "no value" by
**leaving the key out**.

### Binary fields

Binary data embedded in a receipt or record -- salts, signatures, certificate
fingerprints, certificate blobs -- is carried as a **base64url string without
padding** (the URL- and filename-safe alphabet of
[RFC 4648](https://www.rfc-editor.org/rfc/rfc4648#section-5), `A-Z a-z 0-9 - _`,
with no trailing `=`). The producer encodes the bytes to that string before the
value enters the object; the canonical encoder then treats it as an ordinary
string. There is exactly one byte-to-string encoding for binary data, so the
canonical form is reproducible.

### Final byte string

The canonical **byte** string is the **UTF-8** encoding of the canonical
character string defined by the rules above. UTF-8 is emitted without a byte
order mark. This byte string is what is hashed and signed; hashing and signature
details belong to the receipt itself (see
[PROTOCOL.md](PROTOCOL.md#non-repudiation)).

## Worked examples

In each row, encoding the value yields the canonical string shown; the
receipt bytes are that string's UTF-8 encoding. Backslash escape sequences
in the canonical strings below are literal backslash sequences, not the
control characters themselves.

| Value | Canonical string |
|-------|------------------|
| `{"b":1,"a":2,"c":3}` | `{"a":2,"b":1,"c":3}` |
| `{"z":{"b":1,"a":2},"a":[3,2,1]}` | `{"a":[3,2,1],"z":{"a":2,"b":1}}` |
| `{"n":9007199254740991}` | `{"n":9007199254740991}` |
| `{"n":-0}` | `{"n":0}` |
| `{"a":null,"c":false,"b":true}` | `{"a":null,"b":true,"c":false}` |
| an object `{s}` whose value is the euro sign | `{"s":"<euro as raw UTF-8 E2 82 AC>"}` |
| an object whose only member `s` holds control characters | see the `control-character-escapes` test vector for the exact bytes |
| `{"sig":"f39_","salt":"3q2-7w"}` | `{"salt":"3q2-7w","sig":"f39_"}` |

The euro and control-character rows are described rather than shown literally to
keep this document free of raw non-ASCII and control bytes; their exact `value`,
`canonical`, and `bytesHex` are in the test vectors below
(`non-ascii-string`, `astral-emoji`, and `control-character-escapes`).

## Test vectors

A machine-readable set of test vectors is checked in at
[`packages/core/test/vectors/canonical-vectors.json`](../../packages/core/test/vectors/canonical-vectors.json).
It is a JSON object with a `vectors` array; each entry has:

| Field | Meaning |
|-------|---------|
| `name` | short identifier |
| `description` | what the vector exercises |
| `value` | the input value |
| `canonical` | the expected canonical character string |
| `bytesHex` | the expected canonical byte string, as lowercase hex |
| `sha256Hex` | the SHA-256 of `bytesHex`'s bytes, as lowercase hex |

An independent implementation reproduces the bytes by encoding each `value` and
checking the result equals `bytesHex` (and, if it also hashes, that the SHA-256
equals `sha256Hex`).

One normative case is absent from the file: the `-0` to `0` normalization
([Numbers](#numbers) and the worked example `{"n":-0}` -> `{"n":0}`). JSON has no
negative zero -- a `-0` literal parses to `0` -- so it cannot be carried as a
JSON `value`. Verify it from a `-0` literal in your own language; the Node suite
does so directly.

The PSI-Link test suite runs these vectors in both Node.js
([`packages/core/test/canonical.test.ts`](../../packages/core/test/canonical.test.ts))
and a real browser
([`apps/web/test/browser/canonical.test.ts`](../../apps/web/test/browser/canonical.test.ts)),
asserting byte-identical output on both platforms.

## Implementation note (non-normative)

PSI-Link implements the encoding in `packages/core/src/utils/canonical.ts`. It
delegates the RFC 8785 serialization to the
[`canonicalize`](https://www.npmjs.com/package/canonicalize) package -- the
scheme author's reference implementation -- behind a strict pre-validation pass
that rejects every out-of-domain value listed above rather than letting the
underlying serializer coerce it. `canonicalString(value)` returns the canonical
character string and `canonicalBytes(value)` returns its UTF-8 bytes. Numeric
schema fields use `safeIntegerSchema`. None of this is required to reproduce the
bytes; the normative definition is RFC 8785 over the value domain above.

## See also

- [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#canonical-encoding) - the Canonical
  encoding overview: what the encoding is for and what it protects against
- [PROTOCOL.md](PROTOCOL.md#non-repudiation) - how receipts use these bytes
- [EXCHANGE_RECORD.md](EXCHANGE_RECORD.md) - the self-attested record whose
  commitments and agreed-terms hash are computed over these bytes
- [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md) - the exchange specification whose
  linkage terms are embedded, canonically encoded, in a receipt
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) - JSON Canonicalization Scheme
- [RFC 4648 section 5](https://www.rfc-editor.org/rfc/rfc4648#section-5) - base64url
