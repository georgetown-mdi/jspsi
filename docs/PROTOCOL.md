---
title: "PSI-Link Protocol"
---

# PSI-Link protocol

This document describes the PSI and PSI-C algorithms, how they are composed to produce a privacy-preserving record linkage, and the wire-level SPAKE2 authentication protocol. It does not cover the exchange agreement format that parameterizes the protocol (see [EXCHANGE_SPEC.md](EXCHANGE_SPEC.md)), the threat model and authentication design (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md)), or the network layer over which the protocol runs (see [COMMUNICATION.md](COMMUNICATION.md)). Intended readers are security auditors, external implementors, and developers.

# Privacy preserving record linkage

The PPRL protocol utilizes a base PSI function to repeatedly reveal the size of the sets of shared statistical linkage keys. This reveals to the parties an association map between their shared members and nothing about elements they do not have in common.

## PSI base function

The PSI base function is a lightly modified version of OpenMined's [PSI](https://github.com/OpenMined/PSI). That package implements private set intersection layering over the encryption in Google's [Private Join and Compute](https://github.com/Google/private-join-and-compute) (itself using OpenSSL), written in C++ that is compiled into WebAssembly. The base function divides the two participants into "server" and a "client" roles. At a high level, the steps of the protocol are:

1. Both client and server generate their own private keys which live only in memory for the duration of the exchange. Keys are random scalars in the P-256 elliptic curve group and are generated using OpenSSL.
2. The client initializes the exchange by encrypting their own data with their own private key using a commutative encryption algorithm and then sends it to the server.
3. The server commutatively encrypts both their own data and the client's data with their own private key and then sends both datasets to the client.
4. The client can then remove their own key from their own data, leaving them with client and server datasets encrypted only by the server.
5. A straightforward string comparison allows the client to see which elements they have in common. They can then choose to share the association table back with the server.

The terminology of "server" and "client" derives from OpenMined's PSI implementation and is used here to be consistent with their documentation. However, "server" and "client" are disfavored throughout the rest of this project as there are many other instances of servers and clients, and OpenMined's PSI includes no networking coding. Most often we will want to execute the protocol so that both parties learn the outcome. When it is necessary to distinguish between the two roles, we will instead use *receiver* and *sender* respectively. When only one party receives output, that party's role is fixed as the receiver. When both parties receive output, roles are assigned dynamically: the party with the smaller dataset becomes the receiver (minimising data transmitted); ties are broken in favour of the initiator becoming the receiver.

## Linkage keys

Statistical linkage keys are data elements that combine several other inputs into a single value that uniquely represents an individual with an extremely high probability. In this application, the most common data types for linkage keys are social security number, first name, last name, and date of birth. An example linkage key is the last four digits of the social security number concatenated with last name and date-of-birth as a character string.

Linkage keys can be designed to produce links even in the place of data quality errors, for instance by exhaustively generating all transpositions of two digits in a Social Security Number (SSN) or comparing all single-character edits of strings of a fixed length. By repeatedly executing the PSI base function on such keys, two parties execute a fuzzy PPRL. 

In order to preserve the guarantee that no information is revealed about individuals not in the intersection, linkage keys must be designed to be precise enough (high positive-predictive value) that any match is definitive.

## Matching Algorithms

### PSI

The way in which links are decided depends on whether or not both parties will receive output. If so, then they can communicate directly with each other and optimize the procedure. For one-to-one mappings, linkage keys are applied in sequence forming a cascade of deterministic matches: keys are ordered from most to least precise, and at each round only records that match uniquely on that key are accepted as pairs and removed from the candidate set - the pool of records not yet definitively matched. Inputs without a match or without a unique linkage key carry forward to the next round.

If only one party receives the output, then a compromise will be necessary. A deterministic cascade as described above can be executed with only one party resolving the final set of association between each party's elements. In this case, the other party learns how many records match each linkage key and how many records match overall. They also learn which of their records match, but not the identifiers of the records to which they match. As an alternative, the deterministic cascade can be enacted entirely by a single party without the other receiving a single output. In this case, all of both datasets must be processed and sent to the receiver every round. This discloses to that party the existence of matches on less precise keys that the cascade would have filtered out.

In linkages that involve multiple links - either many-to-one or many-to-many - the multiplicity is resolved into single entity clusters by applying a transitive closure algorithm. Transitive closure may create scenarios where two members are linked through a third record without a rule linking them directly, so careful consideration of linkage keys and their consequences is required. Having an output that includes multiple links per input implies that some meaning is imparted to the data holder through entity resolution; as such, these exchanges require that the "many" parties receive the output. In order to communicate this effectively to users, rather than describe the multiplicity of the exchange they are asked if they want to *deduplicate* their data, as they effectively use their partner's data to group their own.

In a many-to-one exchange where both parties receive the output, the "many" party can filter its candidate set to remove linked elements after each round similar to the deterministic cascade used in a one-to-one linkage. If the "one" party is not allowed to receive the output, the "many" party must ensure the uniqueness constraint.

Crucially, unlike traditional PPRL, blocking when using PSI is neither necessary nor appropriate. The PSI base function's computational complexity is O(n log n) in the total number of elements rather than quadratic in their product, so there is no cross-product comparison to reduce. Blocking would also compromise the privacy guarantee by revealing to each party how many of the other's records fall into each partition.

The practical upper limit on the number of records for browser-based execution is determined by available memory rather than computation: each encrypted element occupies roughly 64 bytes, so holding both parties' encrypted sets simultaneously for the comparison step requires on the order of 1-2 GB for datasets in the tens of millions of rows - well within the capacity of a modern workstation. The only part of the algorithm that requires WebAssembly is the application of the commutative encryption algorithm, which can be streamed and parallelized over the data.

### PSI-C

> **Not yet implemented:** PSI-C is not yet fully implemented. It is targeted for a release after 1.0; see [ROADMAP.md](ROADMAP.md). The description below is the intended design.

PSI-C is also executed by sequentially executing deterministic linkages. Membership anonymity is granted by the sender permuting the receiver's doubly-encrypted data before returning it to them. The results of multiple linkage keys can be combined so long as the sender uses a consistent permutation algorithm for each round. The association map in the permuted space has the same size as one in the original space. This allows the cardinality to be measured without revealing which specific members are in common.

# Datasets

## Raw data

Data is input as a csv or other tabular data format. These files include rough metadata such as column names and storage types, which can be augmented with [metadata](EXCHANGE_SPEC.md#input-metadata) from the exchange specification. Thus raw data consists of one or more columns, metadata for each column, and a record count.

## Standardized data

A standardized dataset bridges between raw data and the fields expected as inputs to linkage keys. It is an abstraction over the application of [data standardizing](EXCHANGE_SPEC.md#data-standardizing-transformations) transformations. As noted in that section, there can be zero, one, or more than one standardized record for any input, so a standardized data element is essentially a mapping between an index into the raw dataset and a set of strings. These mappings are lazily evaluated and their results are cached. A standardized dataset is a collection of these mappings and the names of the linkage key fields they provide.

## Key input data

As defined in [linkage terms](EXCHANGE_SPEC.md#linkage-terms), linkage fields are the inputs that are typically transformed to create the character strings that are concatenated to form statistical linkage keys. The linkage algorithm attempts to connect individuals - not just character strings - represented by their indices in the original dataset. Consequently, key inputs are realizations of linkage fields and are, like standardized data elements, maps between indices and sets of character strings of arbitrary size. In order to realize a complete linkage key, the set of all combinations of all key inputs is computed each and each combination is concatenated together into a string.

When that set has zero elements, i.e. one of the elements is `NULL`, it is omitted from the linkage protocol. When that set has more than one element and the algorithm is using the optimization implied by the deterministic cascade detailed in [Matching algorithms](#psi), communication is required in order to determine if the link is unique. For example, if one party has a member named "Mary Shaye-Smith" and another two members named "Mary Thorne" and "Mary Smith", unless the mapping was many-to-one it would be incorrect to accept both matches as valid and remove the individuals from the candidate set.

This extra communication step violates the threat model which guarantees that nothing can be learned about members that are not in common. That said, the existence of a match on a key would be sufficient evidence that two records represent the same person and it is only by revealing contradictory evidence that the link is not made. Users who employ these transformations are warned about their consequences.

# Post-linkage steps

## Non-repudiation

> **Partially implemented:** The signing identity that certificate-backed receipts rest on -- key generation, the self-signed certificate, fingerprint pinning, and the identity binding -- is implemented today and specified under [Signing identity and certificate pinning](#signing-identity-and-certificate-pinning) below. Receipt assembly, signing, and the receipt swap are not yet wired up; they are targeted for the 1.0 release (see [ROADMAP.md](ROADMAP.md)). The receipt-content description in this section is the intended design.

A receipt is produced at the conclusion of a successful exchange, after the result - and any payload columns - already exist on both sides. The receiver learns the intersection during the PSI rounds themselves: the association map is computed and shared as a step of the matching algorithm, and payload columns are transmitted immediately afterward. By the time a receipt could be assembled both parties already hold the result, so the receipt is a post-exchange audit artifact recording that the exchange occurred. It does not gate, withhold, or otherwise condition delivery of the result; the result is already in hand on both sides.

Each receipt records the timestamp, a hash of the exchange agreement, each party's `identity` (the self-asserted [`linkage_terms.identity`](EXCHANGE_SPEC.md#linkage-terms) field), and the size of the result if that information was learned by both parties. The hash of the agreement and the signature over the receipt are computed over a canonical byte serialization (RFC 8785, JSON Canonicalization Scheme) so that both parties - and an independent third party using a different implementation - derive byte-identical input and the hash and signature verify across implementations. That serialization is specified in [CANONICAL_ENCODING.md](CANONICAL_ENCODING.md). The two parties then swap signed receipts and each retains the other's. A receipt can be signed in one of two modes, which differ sharply in what they prove:

- **Session-derived (symmetric).** The signature is a MAC under the shared SPAKE2 session key. Both parties hold the same key, so either can forge a MAC the other could have produced. A session-derived receipt is therefore not evidence against a denying counterparty and is not verifiable by any third party; it yields only a tamper-evident local record - a party can later detect that its own stored copy was altered, but cannot use it to hold the partner to the exchange. This mode does not provide non-repudiation.
- **Certificate-backed (asymmetric).** The signature is made with a party's long-lived signing private key, whose self-signed certificate the partner has pinned by fingerprint out-of-band at setup. Only the holder of that key could have produced the signature, and the pin ties the key to the partner, so the signature is verifiable by anyone who holds (or is given) the pinned fingerprint -- it does not depend on a certificate-authority chain. This is the only mode that provides non-repudiation, and the only mode in which the `identity` field carries evidentiary weight: the certificate binds the asserted identity to the pinned key, whereas a session-derived receipt leaves it an unverified label. The signing identity, certificate format, fingerprint pinning, and the identity-binding rule are specified under [Signing identity and certificate pinning](#signing-identity-and-certificate-pinning) below.

Because the receipt is collected after the result already exists on both sides, the signature swap is best-effort evidence, not a fairness or atomicity guarantee. Two limitations follow directly. First, the swap is not a fair exchange: a party may receive the partner's signature and then decline to send its own, and no protocol step can compel the second signature once the first has been handed over. Second, aborting does not undo the data exchange: because both parties already hold the result, terminating the program and restarting does not roll the data back. An aborting party can capture the partner's signature, withhold its own, and still keep the intersection. Restarting the exchange is not a remedy for data already transferred; it only repeats the work.

Retention, access controls, and log integrity beyond the receipt remain each party's internal compliance obligation.

## Signing identity and certificate pinning

> **Implemented.** Identity generation, persistence, fingerprint display, fingerprint pinning, and the identity binding are produced and enforced today (`psilink fingerprint`; the `signing` block in [EXCHANGE_SPEC.md](EXCHANGE_SPEC.md#signing)). Signing receipts with this identity and swapping them is the remaining, not-yet-wired work above.

Certificate-backed receipts rest on a long-lived **signing identity**: an asymmetric keypair and a self-signed certificate that carries the party's `identity`. Each party generates one, persists it, and reuses it across every exchange and every partner -- it is not a per-exchange credential. It is therefore a distinct credential from the PAKE token in the key file, which rotates every exchange: the signing key must be stable for its whole life so that a fingerprint a partner pinned once keeps verifying later receipts. Regenerating the identity is a deliberate act (`psilink fingerprint --force`) that produces a new key and a new fingerprint and invalidates any fingerprint a partner has already pinned.

The trust model is **pinned self-signed**: there is no certificate-authority chain and no revocation. A self-signed certificate proves only possession of its own key, not who the holder is; the binding to a real partner is established out-of-band, the same way the parties already exchange the invitation and PAKE secret. The certificate's **fingerprint** -- an unpadded base64url `SHA-256` over the domain-separated canonical encoding (RFC 8785) of the certificate body -- is shared with the partner over a trusted channel and pinned in the partner's `signing.partner_fingerprint`. The fingerprint is not secret (it is a hash of a public certificate), so the channel must be authentic, not confidential. This is the SSH-host-key / certificate-pinning model, not the web-PKI model. The rationale for choosing it over X.509 + CA for v1, and the seam by which an authority-backed mode could layer on later, are in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#receipt-signing-identities).

The certificate is a small canonical-JSON document rather than an X.509 structure, so the bytes that are signed and fingerprinted reuse the project's single canonicalization primitive (the same one the agreed-terms hash and the record commitments use) and reproduce across implementations; that serialization is specified in [CANONICAL_ENCODING.md](CANONICAL_ENCODING.md). The body carries a format `version` (a single recognized literal for v1, rejected rather than migrated if unrecognized -- also the format discriminant a future authority-backed representation would extend), the signature `algorithm` (`ed25519` in v1), the party's `identity`, and the public key as a JWK (RFC 8037 OKP). The self-signature is an Ed25519 signature over the domain-separated canonical bytes of that body, under the body's own public key; the fingerprint is a SHA-256 over a body encoded under a distinct domain label, so a signature and a fingerprint can never be confused for one another. Ed25519 is used for its deterministic, non-malleable signatures and single canonical encoding; the public key is rejected on load if it is the wrong length, not a valid curve point, or a small-order (degenerate) point.

Two checks gate accepting a certificate-backed receipt, and both must pass before the receipt is accepted:

- **Pinning.** A presented partner certificate is trusted only if its self-signature verifies and its fingerprint matches the configured `signing.partner_fingerprint`. A certificate presented when no fingerprint is pinned, one whose self-signature does not verify, and one whose fingerprint does not match the pin are each rejected with a clear error. The fingerprint comparison is constant-time.
- **Identity binding.** A receipt is accepted only if its asserted `identity` is the one the presenting certificate authorizes. Because `identity` is self-asserted free text (`Consistency: none`, often multi-line), the rule is an exact match of the full identity, compared over the same canonical `identity` bytes the record commits to and the receipt signs -- so the certificate check and the signed record agree on what "identity" is. A party that uses a different identity string needs a different certificate (a deliberate regeneration); the certificate authorizes exactly the identity it carries.

## Self-attested record

> **Implemented.** Unlike the signed receipt above, the self-attested record described here is produced today, at the conclusion of every successful exchange. It is a standalone disclosure-log entry, deliberately unsigned: a session-derived MAC is not non-repudiation (see the two signing modes above), so the unsigned record is an honest, local audit artifact rather than a receipt that overstates what it proves. Signing this record is the separate, deferred Signed Exchange Receipts work, which reuses its commitment scheme and on-disk format.

At the conclusion of every successful exchange, each party produces a self-attested record of what it disclosed. The record is designed to stand on its own as a disclosure-log entry: an operator can use it to populate a HIPAA accounting of disclosures or a FERPA disclosure record without separately retaining and re-matching the original linkage-terms config. It is a local audit artifact, explicitly **not** a signed or non-repudiable receipt and **not** evidence against the partner. It is built from data both sides already hold, so it needs no private key and adds no protocol round-trip.

The record captures: a format `version` (a single recognized literal for v1, which a reader rejects rather than migrates if unrecognized); the local timestamp (an ISO 8601 datetime in UTC, ending in `Z`; a timestamp carrying a numeric offset is rejected, so the format keeps one canonical timestamp form across implementations); a hash, over the canonical encoding, of the agreed exchange terms (both parties' linkage terms in a fixed, canonical-sorted order, so both parties and an independent third party derive the same hash); both parties' self-asserted `identity` strings; the result size, but only in the both-output case -- recorded when both parties' agreed terms have them both receive output, so a size is stored only when both sides are entitled to the result, and it is omitted when only one party receives output (the gate is the terms agreement, not what either party happens to learn during the exchange); and a per-exchange binding nonce (CSPRNG-generated, at least 128 bits) so two runs with identical terms still produce distinct records. The binding nonce is the unsigned record's per-exchange binder and is distinct from the per-commitment salts below; do not conflate them. The deferred signing work will add a stronger session-key-derived binder.

Alongside those fields the record carries readable **governance metadata** so it is self-describing as a disclosure record. This is: the governing data-sharing agreement -- its reference (for example `MOU-2025-0042`) and expiration date -- identifying the authority for the disclosure; the `algorithm` (`psi`, which revealed matched identifiers, or `psi-c`, which revealed only a count), so the record shows whether identifiers or only a count were disclosed; the categories of data exchanged -- the names and any data-dictionary descriptions of the payload columns this party sent and received, with the no-payload case (count-only `psi-c`, or no payload configured) recorded explicitly as an empty list rather than by ambiguous omission; and the matching basis -- the linkage fields the match keyed on, each recorded as its standardized field name and semantic type (for example `lastName`, `dateOfBirth`, `ssn4`), documenting the PII on which shared membership was determined. The standardized name (not the raw source column) is the identifier the linkage keys and the standardization config both reference, so it is the anchor for tracing the basis back through standardization to the data; the basis covers only the fields the linkage keys actually reference, so a declared-but-unused field is not listed (it was not matched on). These fields come from terms both parties validated at exchange time -- the legal agreement reference and expiration, the algorithm, the linkage-field set, and the payload column-name sets are all mutually checked -- so both parties' records carry consistent governance metadata for the same exchange; the one field not cross-party-validated is a column's free-text description, which the two parties may annotate differently. The metadata is names, categories, descriptions, and references only -- never a payload value, a linkage-field value, or a matched identifier -- so the record stays free of protected data at rest, with the data exchanged bound by the commitments below rather than embedded.

The record commits to the data exchanged rather than embedding it: the payload columns this party sent, the payload columns it received, and -- when this party holds it (it received output) -- the association table. A bare `SHA-256` of a low-entropy result (for example an association table over identifiers; cf. the SSN brute-force warning in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#threat-model)) would be brute-forceable by anyone holding the record, leaking the intersection. Instead each commitment is

```
commitment = HMAC-SHA-256(key = salt, message = canonical({ domain, data }))
```

with a fresh per-commitment `salt` (CSPRNG-generated, at least 128 bits) and a per-kind `domain` label that separates the three commitment kinds. Keying HMAC with the secret salt gives computational hiding (the commitment reveals nothing about the data, and a low-entropy data set cannot be brute-forced from the commitment without the salt); binding follows from the collision resistance SHA-256 lends HMAC, so the committer cannot open one commitment to two different data sets. The committed `message` is the canonical encoding (RFC 8785) of `{ domain, data }`, so both parties commit over byte-identical serializations of the same logical data (row order, encoding, and null handling all fixed) and an independent implementation reproduces the bytes; that serialization is specified in [CANONICAL_ENCODING.md](CANONICAL_ENCODING.md). The two payloads are committed in a canonical representation owned by the record format rather than the transport encoding (the wire-level "has data" discriminant is dropped; a no-data payload is the empty value), so a sender's payload-sent commitment and the receiver's payload-received commitment cover byte-identical data for the same logical payload. That symmetry is what later lets the deferred signing work have the two parties cross-check each other's records; today the record is local and self-attested, so the commitments are never compared between parties.

The artifact is split across two files. The **record** holds the commitments and the non-secret summary above; it does not contain the matched data or the salts, so it does not reveal -- or allow brute-force recovery of -- the intersection, and it is the part safe to retain or hand to an auditor (and, once signing is built, to sign and swap). The **opening data** holds, per commitment, the salt and a snapshot of the exact committed data -- the material needed to reveal (open) a commitment later. Because anyone holding the opening data can recompute the commitments, it is as sensitive as the matched data itself and must be kept private. The CLI writes both files atomically (temp file then rename, as the key file is written) and owner-only, to a timestamped default path (overridable, or skipped with `--no-record`); the web app offers both as downloads. The record is written owner-only too, even though it is shareable: "shareable" means it carries no secret material (no salts, no matched data), not that it is world-readable on disk. It still names both parties, the governing agreement, the data categories, and the result size in cleartext (see below), so the conservative default keeps it private to the owner; share it by copying the file, not by loosening its permissions.

Privacy of the record itself: it stores the terms hash, both `identity` strings, the result size, and the governance metadata above (the agreement reference and expiration, the algorithm, and the data categories) in cleartext, so anyone who reads it learns that an exchange with that partner occurred, under which agreement, over what categories of data, and its size -- but no protected values. As with the receipt, retention and access control of the record (and the strict protection of the opening data) are the holder's responsibility.

## Output

The basic output is an association table between each party's element. As noted above, if parties supplied identifier columns with their inputs and flagged them in their metadata, the association table will be between each party's identifiers. Otherwise, the table references the row indices of each dataset.

If parties elected to transmit payload data, the relevant columns for the appropriate rows will be transmitted in-band over the secure connection and appended to the output in-the-clear.

# SPAKE2 authentication protocol

PSI-Link uses a 3-message SPAKE2 handshake ([RFC 9382](https://www.rfc-editor.org/rfc/rfc9382)) over P-256 (NIST's 256-bit prime-order elliptic curve, also known as secp256r1) with mutual MAC confirmation.

The SPAKE2 protocol logic is implemented directly against RFC 9382 rather than through a dedicated SPAKE2 library. This is a deliberate choice: no production-ready, audited SPAKE2 library with dual Node.js/browser support exists in the JavaScript ecosystem. The underlying cryptographic primitives are not hand-written: elliptic-curve scalar multiplication is provided by [`@noble/curves`](https://github.com/paulmillr/noble-curves), an independently audited library, and all symmetric operations (SHA-256, HMAC-SHA-256, HKDF) use the platform `crypto.subtle` API. The hand-written layer is limited to wire-message framing, transcript assembly, and key derivation, all of which are fully specified by RFC 9382.

**Blinding points M and N** (fixed group elements that mask the password in each message) are derived via hash-to-curve ([RFC 9380](https://www.rfc-editor.org/rfc/rfc9380), SSWU for P-256) with psilink-specific domain separation so that no discrete-log relationship with the generator G is publicly known:

```
DST   = "psilink-SPAKE2-P256-SHA256-SSWU-v1"
msg_M = "psilink-SPAKE2-M"
msg_N = "psilink-SPAKE2-N"
M     = 03df561bdb8d6bc4d7e4355bac1c376a6e53d5e0c2c3df07e059ed857b811f7693
N     = 03969a544c8e21a0a99b6816d63c99746a82b72513d9ac2907749ef6b1bc08b0eb
```

**Password scalar derivation**: the PAKE token is expanded to a 48-byte value via HKDF-SHA-256 (HMAC-based Key Derivation Function with SHA-256; info string `"psilink-spake2-password-v1"`) and reduced modulo the P-256 group order. The 48-byte expansion reduces the bias from the mod-reduction to below 2^-128. After the modular reduction, the scalar is shifted into the range `[1, ORDER-1]` (excluding 0). RFC 9382 §3.3 specifies `w` in `{0, ..., p-1}`; the exclusion of 0 is a deliberate tightening because a zero password scalar would make `M*w = identity`, degrading SPAKE2's blinding to a plain Diffie-Hellman. The chance of HKDF output reducing to exactly 0 is ~2^-256, so the deviation is observable only by a chosen-token attacker, and against such an attacker the tightening is strictly safer than RFC-conforming behavior.

**Message flow** (initiator sends first; all messages are JSON objects):

1. Initiator -> Responder: `{ pakeMsg: "1", point: T }` where `T = M*w + G*x_A` (base64url-encoded compressed P-256 point)
2. Responder -> Initiator: `{ pakeMsg: "2", point: S, mac: MAC_B }` where `S = N*w + G*x_B`; `MAC_B = HMAC-SHA-256(Ka, "psilink-spake2-confirm-B")` (Ka is the confirmation key defined in Key derivation below)
3. Initiator -> Responder: `{ pakeMsg: "3", mac: MAC_A }` or `{ pakeMsg: "abort" }` if MAC_B is invalid

Here `w` is the password scalar, `x_A` (initiator) and `x_B` (responder) are fresh random ephemeral scalars (48 bytes from `crypto.getRandomValues`, reduced mod order), and the shared key `K = (T - M*w)*x_B = (S - N*w)*x_A`.

**Key derivation**: the SPAKE2 transcript is assembled per RFC 9382 §3.3 with 8-byte little-endian length prefixes. Rather than SHA-256-hashing the transcript and splitting as Ka||Ke per RFC 9382 §3.4, psilink derives each key independently via HKDF-SHA-256 with the raw transcript as the input keying material: Ka uses info string `"psilink-spake2-ka-v1"` (32 bytes) and Ke uses info string `"psilink-spake2-ke-v1"` (32 bytes). This gives independently derived 256-bit keys from the same entropy. The final transcript field is `w`, the password scalar, serialized as a 32-byte big-endian integer. This is the encoding RFC 9382 §3.3 specifies: the RFC defines `w` as a scalar in the range `{0, ..., p-1}` and states that it "is encoded as a big-endian number padded to the length of p."

**Note on interoperability and external test vectors**: psilink uses custom blinding points M and N derived via hash-to-curve (RFC 9380) with psilink-specific domain separation, rather than the P-256 values fixed in RFC 9382 §4. Because the protocol messages T and S embed M and N implicitly (T = M*w + G*x_A, S = N*w + G*x_B), different blinding points produce different transcripts and session keys even when the rest of the protocol is identical — including the scalar encoding of `w`. This is why the RFC 9382 appendix test vectors and test vectors from other SPAKE2 implementations do not apply to psilink; the divergence is in M and N, not in the transcript encoding. The custom blinding points are intentional: they add a second layer of domain separation at the message level. If an adversary with routing control forwarded a psilink session message into another SPAKE2 application that uses the RFC §4 P-256 blinding points (or vice versa), the recipient would compute its shared key K from a blinded point derived with different M or N, producing a wrong K and a MAC failure. The transcript identity strings (`"psilink-initiator"` and `"psilink-responder"`), the A and B identity fields in the RFC 9382 §3.3 transcript that bind the session key to the psilink application and each party's role, enforce the same separation at the key-derivation level. Custom M and N add defense-in-depth: the handshake fails for two independent reasons rather than one. Correctness of psilink's M and N is verified by the `"M and N match their hash-to-curve derivation"` test in `packages/core/test/pake.test.ts`, which re-derives them from the DST and message inputs and compares against the hardcoded hex values.

## Regenerating M and N

If different identity strings are desired, update the DST and message inputs in the comment block at the top of `packages/core/src/pake.ts` and recompute the hex values. The test named `"M and N match their hash-to-curve derivation"` in `packages/core/test/pake.test.ts` already contains the derivation code using `p256_hasher.hashToCurve`; replace the `expect(...)` assertions with `console.log(M.toHex(true))` calls, run the test, and paste the output back into `pake.ts`.

When renaming, also update every other domain-separation string in the codebase: the HKDF info strings in `pake.ts` (`"psilink-spake2-password-v1"`, `"psilink-spake2-ka-v1"`, `"psilink-spake2-ke-v1"`), `auth.ts` (`"psilink-aead-v1:..."`, `"psilink-token-rotation-v1"`), and the MAC label strings in `pake.ts` (`"psilink-spake2-confirm-A"`, `"psilink-spake2-confirm-B"`).

# X25519 authenticated key exchange

PSI-Link's X25519 authenticated key exchange is the key-agreement primitive that supersedes SPAKE2 as the source of the exchange session key (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md#key-agreement-design) for the decision and its rationale). It performs an ephemeral X25519 Diffie-Hellman keyed together with the pre-shared secret, plus an explicit, role-asymmetric mutual key confirmation, and yields a 32-byte session key with forward secrecy and mutual authentication -- suitable to key the application-layer AEAD and the token rotation in exactly the same way the SPAKE2 session key Ke does. It is implemented as `runKex` in `packages/core/src/kex.ts` and exported from `@psilink/core`. This section specifies the primitive and its wire format; wiring it into the live authentication path (replacing SPAKE2 in `auth.ts`) is a separate, sequenced cutover and is not described here.

**Library selection.** The governing rule is to prefer a well-respected, ideally audited, dual-platform library and to hand-roll only the minimal glue. As with SPAKE2, no production-ready, audited Noise Protocol Framework library with dual Node.js/browser support exists in the JavaScript ecosystem, so none qualifies. The construction therefore reuses [`@noble/curves`](https://github.com/paulmillr/noble-curves) -- already a dependency, independently audited, and used for the SPAKE2 group operations and the Ed25519 signing identity -- for the X25519 primitive (`x25519.getSharedSecret`) and the ephemeral key generation (`x25519.keygen`). No new dependency is added. The only hand-written layer is the minimal NNpsk0 glue: the Noise key-schedule mixing and the two confirmation tags. The full Noise framework is deliberately not implemented. The Diffie-Hellman is a library call, never hand-rolled curve math.

**Construction.** The handshake is pinned to the Noise NNpsk0 pattern over X25519 -- no static keys, the pre-shared secret mixed in at position 0, and ephemeral-ephemeral Diffie-Hellman -- followed by an explicit key-confirmation round, following [NIST SP 800-56A Rev. 3](https://doi.org/10.6028/NIST.SP.800-56Ar3) (section 5.8.1 for the key-derivation step over the shared secret plus fixed info, sections 5.9 / 6.2.1.5 for key confirmation). All symmetric operations (SHA-256, HMAC-SHA-256, HKDF) use the platform `crypto.subtle` API, so they are identical on Node and in the browser.

**Protocol-version tag.** The Noise "protocol name" is the version tag and is hashed into the initial handshake hash, binding every derived key and confirmation tag to it:

```
protocol_name = "psilink-kex-v1:NNpsk0_25519_SHA256"
```

A future authenticated mode (for example a certificate-chain variant) is an additive new version selected out of band; bumping this string makes a mismatched peer derive a different transcript and fail closed, so the door stays open without any pluggable-auth framework today.

**Key schedule** (a minimal subset of the Noise `SymmetricState`: a chaining key `ck` and a handshake hash `h`). `protocol_name` is longer than the 32-byte hash output, so the Noise `InitializeSymmetric` reduces to `h0 = SHA-256(protocol_name)`, and `ck0 = h0`. The NNpsk0 tokens (`-> psk, e` then `<- e, ee`, with an empty prologue) are then processed in order:

```
MixHash("")                       # empty prologue
MixKeyAndHash(psk)                # psk token at position 0
MixHash(e_initiator_public)       # initiator's e: MixHash ...
MixKey(e_initiator_public)        #                ... and MixKey (PSK mode)
MixHash(e_responder_public)       # responder's e: MixHash ...
MixKey(e_responder_public)        #                ... and MixKey (PSK mode)
MixKey(dh)                        # ee: dh = X25519(e_self_private, e_peer_public)
```

In a PSK handshake, Noise (rev 34 section 9.2) processes each `e` token with `MixKey(e.public)` in addition to `MixHash(e.public)`, folding the ephemeral public keys into the chaining key as well as the hash; this implementation does both, so the mix chain is faithful NNpsk0. (`MixHash` touches only `h` and `MixKey` only `ck`, so their order within an `e` token does not affect the result; the chaining-key order `psk -> e_initiator -> e_responder -> ee` does, and is preserved.) Here `MixHash(x)` sets `h = SHA-256(h || x)`; `MixKey(ikm)` sets `ck = HKDF-Noise(ck, ikm, 2)[0]`; and `MixKeyAndHash(ikm)` sets `(ck, temp_h) = HKDF-Noise(ck, ikm, 3)[0..1]` then `MixHash(temp_h)`. `HKDF-Noise(ck, ikm, n)` is the Noise chaining HKDF (Noise rev 34 section 4.3): `temp_key = HMAC(ck, ikm)`, then `output_i = HMAC(temp_key, output_{i-1} || byte(i))` for `i` in `1..n` (with `output_0` empty). This equals RFC 5869 HKDF with `salt = ck` and an empty info string.

After the tokens, the session key and a distinct confirmation key are derived, and the two confirmation tags computed, using the application HKDF (`hkdfDerive`: HKDF-SHA-256, 32-byte zero salt, named info):

```
session_key       = HKDF(ck || h, "psilink-kex-v1:session", 32)
confirm_key        = HKDF(ck,      "psilink-kex-v1:confirm", 32)
initiator_confirm  = HMAC(confirm_key, "psilink-kex-v1:initiator-confirm" || h)
responder_confirm  = HMAC(confirm_key, "psilink-kex-v1:responder-confirm" || h)
```

Deriving `session_key` over both `ck` (which carries the pre-shared secret and the X25519 DH output) and `h` (which carries the protocol-version tag and both ephemeral public keys in role order) is the load-bearing invariant: the session key depends on the ephemeral DH output, so it is neither the pre-shared secret alone -- which would have no forward secrecy -- nor the raw X25519 output alone -- which would not be transcript-bound. The confirmation key is independent (distinct input keying material and a distinct label), and the two confirmation tags are role-asymmetric (distinct labels) and each binds the full transcript hash `h`. All labels are namespaced `psilink-kex-v1:` and are disjoint from every other domain-separation label in the system (`psilink-spake2-*`, `psilink-aead-v1:*`, `psilink-token-rotation-v1`, and the `psilink-signing-*` labels).

**Message flow** (initiator sends first; all messages are JSON objects; `e` is a base64url-encoded 32-byte X25519 public key and `confirm` is a base64url-encoded 32-byte HMAC-SHA-256 tag):

1. Initiator -> Responder: `{ kexMsg: "1", e: e_I }`
2. Responder -> Initiator: `{ kexMsg: "2", e: e_R, confirm: responder_confirm }`
3. Initiator -> Responder: `{ kexMsg: "3", confirm: initiator_confirm }` or `{ kexMsg: "abort" }`

The responder confirms first (in msg2); the initiator verifies `responder_confirm` before sending its own confirmation in msg3, and the responder verifies `initiator_confirm` on msg3. A mismatched pre-shared secret therefore fails closed on both sides before any non-handshake frame is sent. Each side sends the tag for its own role and verifies the tag for the opposite role, so a reflected or echoed confirmation does not verify.

**Contributory check.** The peer's X25519 share is rejected if the computed shared secret is all-zeros. `@noble/curves` enforces this in `getSharedSecret`, which rejects low-order and non-canonical peer shares by throwing (RFC 7748), so the check comes from the audited library; an explicit all-zeros guard is retained as defense in depth against a future primitive swap.

**Failure handling** mirrors SPAKE2. All wire schemas use strict (`.strict()`) Zod parsing, so an unexpected field fails the parse. Tag comparison is constant-time. Every authentication failure throws a single generic, non-oracular error (`"key exchange authentication failed"`) that does not reveal which check failed; a silent peer surfaces the distinct `"key exchange handshake timed out"` after a 30 s per-message bound. Every receive-side failure before the final message sends a best-effort `{ kexMsg: "abort" }` so the peer stops waiting immediately rather than blocking until the timeout.

**Test vectors and interoperability.** The key-schedule mix chain above is faithful Noise NNpsk0, but the overall handshake is pinned by psilink's own checked-in known-answer vector (`packages/core/test/vectors/kex-vectors.json`) rather than being wire-compatible with generic Noise. Two things diverge from a stock Noise NNpsk0 session: the protocol name differs (so the initial `h` differs), and instead of Noise `Split()` the session key uses a custom KDF over `ck || h` with an added explicit confirmation round. So no end-to-end Noise vector corresponds. What does correspond is the underlying machinery, cross-checked against its published references in `packages/core/test/kex.test.ts`: the X25519 Diffie-Hellman against [RFC 7748](https://www.rfc-editor.org/rfc/rfc7748) section 6.1, and the Noise chaining HKDF against [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869) test case 3. The vector fixes the pre-shared secret and both ephemeral private keys and records the session key and both confirmation tags; it is reproduced by the independent generator at `packages/core/test/vectors/generate-kex-vectors.mjs`.

## See also

- [EXCHANGE_SPEC.md](EXCHANGE_SPEC.md) - exchange agreement format that parameterizes the protocol described here
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md) - threat model and security properties of the protocol
- [COMMUNICATION.md](COMMUNICATION.md) - network channels over which the protocol runs
- [DESIGN.md](DESIGN.md) - high-level overview, architecture, and possible extensions
