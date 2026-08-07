---
title: "The FIPS Variant Container Image"
---

# The FIPS variant container image: a second artifact, a vendor's validated module, and a host the operator provides

*Status: decided, and built. This note records the choice to ship a separate
`Dockerfile.fips` image on Amazon Linux 2023 carrying the CMVP-validated OpenSSL
FIPS provider AWS publishes for that distribution, the alternatives weighed
against it and rejected, what the arrangement does and does not support a claim
of, and what stops working inside it. The measurements underneath it are in
[fips-provider-surface.md](fips-provider-surface.md); the algorithm decisions the
claim waits on are in
[key-establishment-fips-boundary.md](key-establishment-fips-boundary.md) and
[receipt-signing-fips-boundary.md](receipt-signing-fips-boundary.md); the pins,
the inventory and the checks are in
[DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md). See
[docs/notes/README.md](README.md).*

Read the ceiling first, because it bounds every sentence below. **The PSI
masking runs in BoringSSL inside the vendored `@openmined/psi.js` WebAssembly
module, and an OpenSSL provider cannot cover a different cryptographic library
in principle.** That is not a gap this image closes, or a later image could
close; it is a permanent property of the design, and it belongs in the first
paragraph of any claim made about this artifact rather than in a footnote to it.
Receipt signing sits outside the module too, in `@noble/curves`, which is why
the claim waits on the receipt-signing migration recorded in the sibling note.
Key establishment runs P-256 ECDH through `crypto.subtle`, the same dispatch
path as the AEAD, but the probe carries no ECDH leg, so what the image puts
inside a validated module today is the AEAD and the key-schedule primitives:
AES-256-GCM, SHA-256, HMAC-SHA-256 and HKDF.

## The decision

- **A separate variant image, not the only published image.** `Dockerfile.fips`
  builds it; the default image stays on `node:26-alpine`, and musl stays with
  it.
- **Amazon Linux 2023 in both stages.** `@openmined/psi.js` ships separate musl
  and glibc prebuilds, so building on one libc and running on the other is not
  safe; the builder and the runtime therefore share the same base.
- **CMVP certificate 5021**: module `3.0.8-d694bfa693b76001`, packages
  `openssl-fips-provider-certified` and `-certified-so` at
  `3.0.8-1.amzn2023.0.1`, installed with `dnf swap` against a pinned release
  snapshot.
- **The operator provides a FIPS-mode host.** The image does not enable FIPS
  mode, cannot, and does not refuse to run when the host lacks it. On every run
  it probes whether its own crypto is being served by the validated module and
  reports the host's FIPS-mode state, and warns on either when the answer is not
  what a claim needs.
- **No psilink-level FIPS flag.** The FIPS-mode decision belongs to the host and
  its system-wide crypto policy.
- **Built and smoked in CI ahead of any publication.** The claim gets written
  once, after the decided ECDSA migration lands, and the release workflow's
  published artifacts stay as they are until it is.

## What was rejected, and why

**Certificate 5438, whose certified build is `openssl-fips-provider-latest` at
an older NVR.** It has 14 months more nominal runway (sunset 2031-07-26 against
5021's 2030-05-25) and avoids a cross-version module/libcrypto pairing question
entirely, since its module and libcrypto are both 3.2.2. It was rejected on
measurement. Scanned side by side against the same vulnerability database, the
5438 image carries 145 more OS-layer findings and 56 more CVEs than the 5021
image, and AWS has published a fix for every one of those 56; the pin is what
forbids taking them. Thirty-three of them land on `openssl`, `openssl-libs` and
the provider package itself, which is the one component a FIPS variant exists to
be careful about. Worse, the pin fails silently in both directions: unpinned, a
plain `dnf update` replaces the certified module with an uncertified one and
exits 0; pinned with `versionlock` or `exclude=`, `dnf update` still exits 0 and
prints `Complete!` while changing not one package in the image. A 5438 image is
not incrementally patchable and does not say so. 5021's certified module is a
*separate* package name, so `openssl-libs` stays free to float: after a full
`dnf update --releasever=latest` that image scans at zero OS-layer findings and
still loads module `3.0.8-d694bfa693b76001`.

**Replacing the default image rather than adding a variant.** No certificate
reaches musl or Alpine, so the default image cannot carry this claim -- but the
variant does not come free either. By default **SFTP does not work in it at
all** (below), so every SFTP configuration in the field would need a new key and
any Ed25519 host-key pin would need replacing; and the image is 1.84x the size
with a userland carrying GPL-3.0 terms Alpine's does not. That is an
operator-burden argument for a second artifact, not an impossibility argument
against one image, and it is how the field resolves the same question: vendors
who ship the crypto inside their artifact ship a variant (Chainguard, HashiCorp
Vault, GitLab, AWS Bottlerocket), while vendors who consume the platform's
crypto ship one artifact and a switch (Splunk, MongoDB, Elastic, AL2023 itself).

**An application-level FIPS switch.** Red Hat names Node's own `--enable-fips`
as its worked example: it "is ignored if the system runs in FIPS mode", and "if
you use the `--enable-fips` option on a system not running in FIPS mode, you do
not meet the FIPS-140 compliance requirements". Redundant on a FIPS host and
non-compliant off one. There is no psilink equivalent and there should not be.
`crypto.setFips(true)` is worse than useless as a signal: measured, it succeeds
and `getFips()` returns 1 with no FIPS provider present anywhere.

**Refusing to run when the host is not in FIPS mode.** The check is available --
`/proc/sys/crypto/fips_enabled`, which a container reads through from the host
kernel, measured as 1 inside an unmodified `amazonlinux:2023` container on a
FIPS-mode AL2023 host under plain `docker run` with no flags. Refusing on
anything else would strand every developer machine: Docker Desktop's LinuxKit
kernel does not have the sysctl at all, so the file is absent rather than 0. It
would also be the wrong posture. The operator is the one who knows what their
deployment has to satisfy, and warn-and-guide is what this project does with an
operator's own choices.

**Copying `fips.so` into the image by hand.** Red Hat states the rule for how a
cryptographic library may get into an image: "Use package managers for
installing and updating cryptographic libraries. Otherwise, you break FIPS
compliance." Installing the vendor's signed RPM with `dnf` is precisely that;
lifting the shared object out of a package is what it forbids.

## What may and may not be said about it

The authority is the CMVP FAQ, P-17, quoted whole because its second paragraph
is the part usually dropped:

> A cryptographic module that has already been issued a FIPS 140-2 or FIPS 140-3
> validation certificate may be incorporated or embedded into another product.
> The new product may reference the FIPS 140-2 or FIPS 140-3 validated
> cryptographic module so long as the new product does not alter the original
> validated cryptographic module. A product which uses an embedded validated
> cryptographic module cannot claim itself to be validated; only that it
> utilizes an embedded validated cryptographic module. In such case, vendors may
> use the phrase "FIPS 140-[2 or 3] Inside".
>
> There is no assurance that a product is correctly utilizing an embedded
> validated cryptographic module -- this is outside the scope of the FIPS 140-2
> or FIPS 140-3 validation.

So the image **may** say that it embeds and uses a validated cryptographic
module, and may use "FIPS 140-3 Inside". It **may not** call itself validated.

P-18 additionally permits a vendor to call its product FIPS 140-3 "compliant".
**This project does not use that word.** GitLab, the most careful documentation
found in the field, bans it internally on the grounds that "FIPS compliant" and
"FIPS compliance" "are not official terms defined by NIST or CMVP and therefore
should not be used because it leaves room for ambiguity or subjective
interpretations". Adopting the stricter of the two rules costs nothing and keeps
the wording safe under both. The construction with both authority and precedent
is Red Hat's: name what the artifact does, condition it on the deployment, and
attach the sanctioned short form if a short form is wanted.

**Certificate 5021 is a FIPS 140-3 validation**, which is the project's target
standard ([fips-provider-surface.md](fips-provider-surface.md)), so wording that
names the revision may name 140-3. Read off the certificate's own security
policy: "Amazon Linux 2023 OpenSSL FIPS Provider -- FIPS 140-3 Non-Proprietary
Security Policy", document version 1.2 of 2025-05-14, prepared by atsec for
Amazon Web Services, validating module version `3.0.8-d694bfa693b76001` -- the
version this image pins -- at overall Security Level 1 against
FIPS 140-3. The document names 140-3 throughout and 140-2 nowhere. The
certificate is Active with a 2030-05-25 sunset.

The limit on that reading: it rests on the security policy document alone. The
CMVP certificate page was not reachable to cross-check it, so a second source has
not been consulted. The policy is the authoritative document for a validation and
is unambiguous here, but a published claim naming the revision is resting on one
reading rather than two.

## The three tiers a claim has to distinguish

A FIPS claim turns on the operational environment, and the operational
environment is the host plus the runtime plus the image together, not the image
alone. Collapsing the three cases below into one sentence is how this gets
written wrongly.

**On an Amazon Linux 2023 host in FIPS mode.** This is the arrangement AWS
itself documents, on a page about containers specifically: FIPS mode "will be
automatically enabled in an AL2023 container if the AL2023 host is in FIPS mode
and `/proc/sys/crypto/fips_enabled` is accessible from within the container".
Read that condition precisely -- AWS makes visibility a condition rather than
promising it, and a container that masks or overmounts `/proc/sys` inherits
nothing. Note also what AWS declines to say: the page opens with "It does not
cover the certification status of AL2023 cryptographic modules", and the
container procedure it publishes is not the Crypto Officer procedure in the
module's own security policy, which requires a `fips-mode-setup --check` that
does not work in a container at all. AWS separated the operational question from
the certification question and answered only the first.

**On another Linux host in FIPS mode.** What runs is an unmodified, self-testing
validated module in an operational environment that appears on no certificate,
tested or vendor-affirmed. The strongest published argument against this
approach is aimed exactly here, and nothing found beats it: FIPS compliance
"depends on the full OS environment, not just installing a cryptographic
library", and an AL2023 userland on a foreign kernel is an environment no
certificate names. Two things soften it without answering it. A container *can*
be a tested operational environment -- CMVP certificate 5247 lists an "Alpine
Linux 3.20 image" under "Podman 4 on Red Hat Enterprise Linux 9" in its tested
table, with the runtime and its host modelled the way a hypervisor is -- and
some vendors affirm operational environments generically enough ("Linux 3.10+ on
x86-64") for a container userland to satisfy them. Neither is true of this
module today.

**On a host not in FIPS mode.** No claim at all. The module still loads,
self-tests and serves -- that is measured, and it is why the image is usable on
a developer machine -- but the module's own operating conditions are unmet, and
`--enable-fips`-style reasoning does not repair that. The entrypoint says so on
every run.

Underneath all three sits P-17's own caveat: correct *use* of an embedded
validated module is nobody's certified business but this project's.

## What does not work in the FIPS image

Publishing this list is normal practice rather than an admission; Red Hat,
GitLab, Elastic, Splunk, HashiCorp and Chainguard all publish one. Everything
here was measured in the image rather than reasoned about.

- **SFTP against a server that offers only `curve25519` key exchange.**
  Permanent, with no client-side fix. The certified module carries no X25519, so
  `crypto.generateKeyPairSync('x25519')` throws; `ssh2` builds its key-exchange
  list statically at module load with no runtime capability probe, so it still
  advertises both curve25519 entries, the server prefers one, and the handshake
  dies in `KEXECDH_INIT` with
  `error:0308010C:digital envelope routines::unsupported`. Both ends had
  `ecdh-sha2-nistp256` on the table and it was simply not reached. Where the
  server does offer an alternative the fix is configuration psilink already
  accepts, and a full authenticated exchange over SFTP completes with it:

      connection:
        provider_options:
          algorithms:
            kex:
              - ecdh-sha2-nistp256

  `diffie-hellman-group14-sha256` works as well. A server offering neither is
  unreachable from this image.
- **Ed25519 SSH host keys.** `ssh2` *does* capability-probe for host-key
  formats, so under the fips-only provider it drops `ssh-ed25519` from the list
  it will accept. A server whose only host key is an Ed25519 one is unreachable,
  and an existing `host_key_fingerprint` pinned to an Ed25519 key has to be
  re-pinned to another format; the measured run pinned the server's ECDSA
  fingerprint.
- **MD5.** Never an approved algorithm, refused by the provider, and used
  outside security contexts often enough elsewhere that its absence is worth
  naming. `crypto.createHash("md5")` throws `ERR_OSSL_EVP_UNSUPPORTED`.
- **X25519 and Ed25519 through `node:crypto` or `crypto.subtle`.** The certified
  Amazon Linux module carries neither; `openssl list` reports both ABSENT while
  the provider is `status: active` and the default-configuration control lists
  both, so the absence is the provider's rather than the listing's. psilink's
  own Ed25519 receipt signing runs in `@noble/curves` and is functionally
  unaffected -- and is equally outside the module, which is the point the
  sibling note decides. Key establishment uses neither primitive: its P-256
  ECDH runs through `crypto.subtle`.
- **Package operations inside the running image.** `dnf` dies under the shipped
  fips-only configuration on `unsupported hash type blake2s(in FIPS mode)`,
  because its Python hashes with blake2s. Unset `OPENSSL_CONF` for any in-image
  package operation. The build orders every `dnf` transaction before the
  configuration is in force for this reason, and
  `scripts/dockerfile-freeze.test.mjs` holds that ordering as a check.
- **The PSI masking itself, permanently.** BoringSSL inside a vendored
  WebAssembly module is outside any OpenSSL provider in principle. See the top
  of this note.

## How the certificate claim is kept honest

Ten NVRs share the `openssl-fips-provider-latest` package name and carry ten
different modules with ten different `fips.so` hashes; exactly one of them is
the build certificate 5438 names. A package name proves nothing, so the image
asserts rather than assumes, and the assertions fail the build:

- The package that owns the installed `/usr/lib64/ossl-modules/fips.so` is the
  pinned `-certified-so` package at the pinned version, asked of the module file
  rather than of the package database.
- The provider the loader actually activates reports the certificate's module
  version string and `status: active`. Reaching `active` runs the module's own
  integrity self-test, which is causally controlled: flipping one byte of
  `fips.so` makes the load fail with `SELF_TEST_post: module integrity failure`,
  and restoring the file makes it load again.

Two more properties are held as checks rather than prose, both in
`scripts/dockerfile-freeze.test.mjs`: that the OpenSSL configuration activates
the FIPS and base providers and *not* the default provider, with `fips=yes` as
the default property -- leaving `default` activated is what silently turns the
arrangement into a fallback -- and that the configuration names its init section
under **both** `openssl_conf` and `nodejs_conf`. That last one is the single most
likely way to answer the engagement question wrongly: Node's bundled OpenSSL
applies `nodejs_conf` and silently ignores a configuration written under
`openssl_conf`, the Amazon Linux `openssl` CLI is the opposite, and a file
naming one of them configures one consumer while the other runs exactly as
though no configuration existed.

The per-run report is the same question asked of the running container, and it
is asked of the right consumer. The image ships the engagement probe and its
entrypoint runs it before dispatching: a Node process under the image's own
configuration, making psilink's four call shapes and requiring `fips.so` mapped
into that process beside an MD5 digest and a below-minimum RSA keygen that both
fail. The preamble reads the probe's exit status and nothing else, and parses no
text at all. That is deliberate rather than incidental. Reading `openssl list
-providers` back with awk is the obvious way to write this line and it is wrong
twice over: `openssl` on this base is the Amazon Linux CLI, a **different
libcrypto** from the one inside the `node` binary that runs psilink, so it
answers for a consumer psilink does not use; and a listing parsed for an
assurance line has no comparison behind it, so every shape the parse reads
wrongly becomes a false assurance rather than a failure. Which module is serving
is not read back either: the entrypoint names the `FIPS_MODULE_VERSION` the
runtime stage bakes in from the pinned ARG, which the build assertion above has
already compared against the module the loader activates. So no file that ships
in either image, or runs inside one, parses `openssl list` at all; the build
assertion is the one place that does, where the system OpenSSL is the right
consumer because what is being verified is the package just installed, and where
the exact comparison against the pin makes a misread shape fail the build. The
harness in `support/fips-probe/list-algorithms.sh` parses that command too, and
ships nowhere.

CI carries the rest, because a static parser cannot observe a process.
`image_smoke.yaml` builds the variant and then asserts that the provider is
**engaged** rather than merely present -- `crypto.getFips()` returning 1 proves
nothing, since it returns 1 with no module loaded at all. Three legs. The first
runs the probe copy *inside* the built image, the same file the entrypoint runs,
which is what puts its per-leg JSON transcript in the run log. The second is
`webcrypto-probe.mjs` from `support/fips-probe/`, mounted rather than shipped,
which adds the causal controls: breaking the provider and re-running the same
call. The third runs a full two-party exchange between two containers of the
image over a shared volume, which is the only end-to-end run either image gets.

The probe's product legs are what a "dispatches into the validated module"
claim may name, and no more: AES-256-GCM, HKDF-SHA-256, HMAC-SHA-256 and
SHA-256, each at the parameter shape `packages/core/src` passes. Naming a
primitive in such a claim means adding its leg first. That the four are calls
the committed probe actually makes and completes is driven in
`scripts/docker-entrypoint-fips.test.mjs`, so a leg silently dropped or
misparameterised reddens there; that the claim in
[COMPLIANCE.md](../COMPLIANCE.md#fips-140) names those four and no others is
held by review.

## What it costs

Measured on the reference build of this image, against the Alpine image built
the same day: **576 MB to 1056 MB (+480 MB, 1.84x)** and **63 to 167 OS
packages**. Of those 167, **39 carry a GPL-3.0 or LGPL-3.0 term** -- the samba
client stack that the default image already pays for, plus a GPLv3 base userland
Alpine's busybox and musl do not have (`bash`, `coreutils-single`, `diffutils`,
`findutils`, `gawk`, `grep`, `gzip`, `sed`, `tar`, `readline`, `gnupg2-minimal`,
`gnutls`) and the LGPL-3.0 samba record stores. Whether that breadth changes
this project's distribution posture is a licensing call, not a measurement, and
it is open. The per-package inventory and the caveats on those figures are in
[DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md).

The Node runtime is the other cost, and it is a supply-chain one rather than a
size one. Amazon Linux 2023 packages nodejs20, nodejs22 and nodejs24 only, so
the runtime comes from the official tarball at `nodejs.org` plus one extra
package (`libatomic`, without which the binary exits 127). Checking that tarball
against the release's own `SHASUMS256.txt` would be **an integrity check and not
a provenance one**, the manifest arriving over the same channel as the bytes it
vouches for, so a host serving a bad tarball serves a matching checksum. Two
things close that: verifying the detached `SHASUMS256.txt.sig` in the build,
which needs a keyring and a key-rotation story inside the image, or committing
the per-architecture tarball sha256 into the Dockerfile, which is the same trust
model as the base-image digest pin and needs neither. The second is what the
build does, and the values are in
[DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md); what vouches for the tarball is
then this repository rather than the host that served it. The provider does not
share this gap either way: `dnf` verifies the vendor's RPM signatures against the
key the base image carries.

**The provenance act behind those two hashes.** A committed hash carries whatever
trust was placed in the bytes at pin time, so the signature was checked once,
by hand, when the values were resolved on 2026-08-06. No build runs any of this.
The v26.7.0 `SHASUMS256.txt.sig` is an EdDSA signature made 2026-08-05 by

    5BE8A3F6C8A5C01D106C0AD820B1A390B168D356   Antoine du Hamel
    ed25519 [SC], created 2025-06-28

and that key was obtained from two channels distinct from nodejs.org --
`keys.openpgp.org` by fingerprint, and the `nodejs/release-keys` repository on
GitHub -- with the signature verified separately under each in its own throwaway
`GNUPGHOME`. Both gave `Good signature`, and the two copies agree on the primary
fingerprint and on the cv25519 encryption subkey
`0A178CD0FE03CB4F8780980A039F94E89826F891`. That the key is a releaser's rather
than merely a key is corroborated by the same fingerprint appearing under
"Primary GPG keys for Node.js Releasers" in `nodejs/node`'s README, and by the
key file entering `nodejs/release-keys` on 2025-07-18, roughly twelve months
before the release it signed.

The limit is worth stating exactly, because it is easy to overstate. This is
independent of the *host* that served the tarball: neither github.com nor
keys.openpgp.org is nodejs.org, and a compromise of nodejs.org alone cannot forge
the signature. It is not independent of the *project*: `nodejs/release-keys` and
the `nodejs/node` README are Node-controlled, and keys.openpgp.org attests
control of an email address, never releaser status. The Node project is the right
trust anchor for a Node runtime, so this is the correct shape of answer rather
than a weak one -- but it is a provenance record, not a runtime claim, and
nothing re-checks it on a rebuild.

Both committed hashes were confirmed a second time on 2026-08-06, from a
different machine than the one that resolved them, against the same signed
manifest and a key fetched from `nodejs/release-keys`: the manifest verified
`Good signature` and both literals matched it. Two environments agreeing rules
out a transcription slip between resolution and commit, which is the failure a
pinned hash cannot otherwise show. The base-image digest has no such second
reading -- Docker Hub is not reachable from the development container and no
`docker` is installed there -- so it rests on the resolving host alone.

## What is not settled

- **A second reading of certificate 5021's standard revision.** The security
  policy names FIPS 140-3 unambiguously (above), so the question that gated
  wording is answered; what is unsettled is only that the CMVP certificate page
  has not been consulted to corroborate it.
- **Whether `openssl-libs` 3.5.x loading the certified 3.0.8 module is inside
  the validation.** It is measured to load, self-test and serve, and AWS's own
  packaging permits the pairing -- the certified package declares
  `Conflicts: openssl-libs < 1:3.2.2-1`, a floor rather than an equality -- but
  the module's security policy names a specific `openssl-3.0.8` build. That is a
  policy question, not a measurable one.
- **Whether the GPL-3.0 breadth changes the distribution posture.** Measured and
  listed; the call is not a measurement's to make.
- **`x86_64`.** Every measurement behind this note was taken on `aarch64`. Both
  certified packages are published for `x86_64` at the same NVRs, and nothing
  was executed there; the CI job added with this image builds and runs on
  `amd64`, so it is the first execution of this stack on that architecture.
- **A single scanner.** The certificate comparison used Trivy 0.73.0 plus AWS's
  own advisory metadata, which agreed on 56 of 56. That is one scanner and the
  vendor rather than two scanners.

## See also

- [fips-provider-surface.md](fips-provider-surface.md) -- what a FIPS provider
  carries and reaches in a psilink image, the four-leg engagement attribution,
  and what the OpenSSL Project's own certificates approve.
- [key-establishment-fips-boundary.md](key-establishment-fips-boundary.md) and
  [receipt-signing-fips-boundary.md](receipt-signing-fips-boundary.md) -- the two
  algorithm migrations a claim about this image waits on.
- [DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md) -- the variant's pins, its OS
  package inventory beside the Alpine image's, and the checks that hold both.
- [COMPLIANCE.md](../COMPLIANCE.md#fips-140) -- the FIPS claims an agency
  reviewer reads.
- [CLI.md](../CLI.md#configuration) -- `connection.provider_options`, the
  operator-tunable pass-through the SFTP key-exchange remedy above goes through.
