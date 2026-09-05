---
title: "Container Image Composition and Pins"
---

# Container image composition

Two container images are built from this repository: the shipped CLI image
(`Dockerfile`) and the FIPS variant (`Dockerfile.fips`), published beside it under `-fips` tags. Both
freeze their npm tree to the committed lockfile, pin their base image by digest,
and install one reviewed set of OS packages each. This document records what
each pins, what holds the pin, what those installs bring into the image, and the
three properties of a built image that are measured by running it rather than by
reading its instructions. Why the npm dependencies themselves are exact-pinned,
and the per-stack upgrade checklists, are in
[DEPENDENCY_PINS.md](DEPENDENCY_PINS.md).

## The Docker image's dependency freeze

The shipped CLI image resolves no npm dependency at image-build time and installs
nothing at container runtime; one OS package, named below, is fetched from the
Alpine mirror while the image is built. The Dockerfile's builder stage installs with
`npm ci` against the committed `package-lock.json` -- which installs exactly the
locked tree, verifying each registry package against the lockfile's integrity
hash, and fails the build if a manifest and the lockfile disagree -- then, after
building, empties `node_modules` and re-installs it as
`rm -rf node_modules && npm ci --omit=dev --omit=optional -w packages/core -w apps/cli`,
and the runtime stage copies that `node_modules` unchanged. Every runtime
dependency and transitive in the image is therefore the exact version in the committed
lockfile: a rebuild without a lockfile change cannot re-resolve a caret range,
and the image ships the same tree CI tested. The release SBOM covers a wider
scope than this install -- step 9 in [RELEASES.md](../RELEASES.md) runs
`npm sbom --sbom-format cyclonedx --package-lock-only --omit=dev -w packages/core -w apps/cli -w apps/web`
-- because the Nitro `.output` this image copies bundles `apps/web`'s runtime
dependencies, which the install scope above does not reach.

Why this is correctness-critical rather than hygiene: `re2js` executes the
agreed linkage transforms' regexes that standardize values before PSI key
derivation, so the two parties' regex engines must behave byte-identically or
the derived keys silently mismatch -- no error, just missed matches. The freeze
covers it and every other external the core CJS build resolves from
`node_modules` at runtime (`yaml`, `canonicalize`, `@noble/curves`, ...), which
their caret manifest ranges would otherwise leave free to re-resolve at image
build time, letting two images of nominally the same release diverge. The
vendored `@openmined/psi.js` tarball participates as the committed bytes in
`lib/`, under the committed sha256 sidecar that stands in for a lockfile
integrity hash (see
[DEPENDENCY_PINS.md](DEPENDENCY_PINS.md#the-vendored-openminedpsijs-addon)).

The structural invariants are enforced by `scripts/dockerfile-freeze.test.mjs`
(run by `npm run test:scripts`, a CI static check), over both `Dockerfile` and
the FIPS variant's `Dockerfile.fips` alike: every install is `npm ci`, the
lockfile and the root `.npmrc` are copied into the builder before the first
install, the builder's last npm command empties `node_modules` and carries both
`--omit=dev` and `--omit=optional`, the runtime stage runs no npm
at all, every stage builds from the reviewed base digest or from another stage of
the same file, each file's OS-package installs are exactly the reviewed set, and
the copied layout keeps the workspace links and the PSI worker entry where the
CLI resolves them.

Every one of those is a property of the instructions rather than of the tree a
build resolves. The test reads what the build is told to do, so the package set
that ends up in the image is outside it -- which is why the command's shape is
held part by part below, each part standing for a way the resolved tree and the
instruction can disagree.

Those invariants are read off `COPY` and `RUN`, so the test refuses every other
instruction class outright, in either stage, rather than modeling it. `ADD` is
the one that names itself: it fetches a remote source and takes the same
`--chown`/`--chmod` flags `COPY` does, so it can both pull in a build input the
lockfile does not pin and land files with an ownership no assertion here reads. A
build that needs another class extends the test's reviewed list in the same diff.

**What makes the rebuilt tree production-only.** Both halves of the rebuild
command answer a measurement. Driving the builder's installs against the
committed lockfile over only the files the builder copies in -- outside the
image, on npm 11.19.0 and Node 26.8.1 (linux/arm64), so the figures stand for
the resolution rather than for a built image's own tree:

| Install                                                                     | Top-level packages | `du -sh` |
| --------------------------------------------------------------------------- | ------------------ | -------- |
| `npm ci -w packages/core -w packages/peerjs-broker -w apps/cli -w apps/web`   | 634                | 517M     |
| then `npm ci --omit=dev -w packages/core -w apps/cli` over that tree          | 553                | 449M     |
| the same command into an emptied tree                                         | 123                | 146M     |
| the same command into an emptied tree, plus `--omit=optional`                 | 101                | 98M      |

The tree is emptied explicitly because `npm ci` empties `node_modules` only when
it is unscoped. A marker directory placed in the tree survives
`npm ci --omit=dev -w packages/core -w apps/cli` and does not survive the same
command with the `-w` flags dropped: scoped, npm reifies in place and removes
only what the scope reaches, leaving the build's own dependencies -- `eslint`
among them -- where the first install put them.

Emptying it is not sufficient on its own. npm omits a package the lockfile flags
`dev` and keeps one it flags `devOptional`, and `vite` carries the second flag:
`apps/web` declares it a devDependency while `@tanstack/react-start`,
`@tanstack/router-plugin`, `@tanstack/start-plugin-core`, `@vitest/mocker` and
`vitefu` each declare it an optional peer. `--omit=optional` is what leaves it,
and `rolldown` and `esbuild` beneath it, out of the image.

What that omission costs is one package: `cpu-features`, ssh2's optional native
CPU-detection addon (with `buildcheck` and `nan` beneath it), the only optional
edge inside the `packages/core` plus `apps/cli` scope. ssh2 declares it optional
and runs without it -- driven on the omitted tree, ssh2 1.17.0 completes a
handshake, authentication and remote exec over loopback with `cpu-features`
unresolvable.

No check measures the built image's `/app/node_modules` against that scope. The
freeze test reads the instruction, and the runtime measurements below cover the
writable set, symlink containment and the setuid inventory rather than the
package set, so a package the resolved tree carries and this scope does not
account for reaches the image unremarked.

The `node:26-alpine` base image is digest-pinned in both stages to its
multi-arch index digest, so the Node runtime and Alpine userland beneath the
frozen `node_modules` are fixed across rebuilds. The tradeoff is that a base
patch (a Node or musl fix) does not arrive on a rebuild of its own: bumping the
base is a deliberate digest update. Pin the multi-arch index digest,
not a platform-specific one, or the multi-platform release build cannot resolve
every architecture; obtain it with `docker buildx imagetools inspect
node:26-alpine`.

What makes that update deliberate is the freeze test, which holds the digest as a
literal listed once per stage: a stage re-pinned onto another digest, dropped
back to the floating tag, or collapsed onto the other stage reddens until the
literal moves in the same diff. The builder's `FROM` is held as tightly as the
runtime stage's, because the npm that resolves the tree the runtime stage ships
is the one the builder's base carries -- a property of the digest rather than of
anything in this repository, recorded in
[DEPENDENCY_PINS.md](DEPENDENCY_PINS.md).

**The one OS package the build fetches.** The runtime stage runs
`apk add --no-cache samba-client`, which is a dependency resolved at image-build
time and the single exception to the paragraphs above. It is in the image rather
than fetched when it is used because of what uses it: the Windows file-drop setup
scripts (`support/windows-network-filedrop/`) run their SMB probe inside this
image, and the networks that probe exists to diagnose are the ones where a
container cannot reach the Alpine mirror at all. HTTPS interception there fails
the fetch with

    error:0A000086:SSL routines:tls_post_process_server_certificate:certificate verify failed
    ...
    samba-client (no such package): required by: world[samba-client]

so a probe that has to install the package stops before it has tested anything.
Installing it while the image is built moves that fetch onto the machine that
publishes the image.

It floats: the instruction names no version, so a rebuild takes whatever the
mirror carries for the pinned base's Alpine release. Measured on the base digest
pinned here (Alpine 3.24.1): `samba-client-4.23.8-r0` and 44 dependencies, 45
packages newly present and none removed. `apk`'s trailing `OK:` line reports the
post-install total rather than the increment, so it reads
`OK: 11.1 MiB in 18 packages` on the bare base and `OK: 63.1 MiB in 63 packages`
after, on `aarch64`; the built `arm64` image goes from 520,152,837 to
574,778,898 bytes, an increase of 54,626,061. The same 63 packages resolve on
`x86_64`, where the post-install total is 54.2 MiB, so the multi-arch release
build is not left short a package. An exact version pin was rejected because
Alpine carries exactly one version of a package per release branch, so a pin
hard-fails the build the moment the mirror supersedes it:
`apk add --no-cache --simulate samba-client=4.23.7-r0` on that base answers

    ERROR: unable to select packages:
      samba-client-4.23.8-r0:
        breaks: world[samba-client=4.23.7-r0]

while `=4.23.8-r0` resolves. A pin would therefore convert every upstream samba
patch into a red build, costing more than the drift it prevents. What the float
costs is that two rebuilds of the same commit can ship different `samba-client`
versions, and that the package is outside the release SBOM, which `npm sbom`
generates from the npm tree. That is acceptable here in a way it is not for
`re2js`: nothing in an exchange reaches this package. It is used only by the
setup-time probe, over a share the operator is testing, never by the CLI or the
console during a run.

Two checks bound it. `scripts/dockerfile-freeze.test.mjs` holds every
`apk`/`apt`/`apt-get`/`dnf`/`microdnf`/`yum`/`pip` instruction in the file to a
per-file list of literals, the way it holds the `.npmrc` COPY, so a second
install or a wider spec on one of those lines reddens rather than shipping. It
reads the whole file rather than the runtime stage alone, because both images
build their runtime stage `FROM` an earlier stage of their own and a package
installed there ships just as surely. A fetch by some other route -- curl and
extract, `rpm` driven directly, or another language's package manager -- is
outside what it sees. `image_smoke.yaml` asserts each built image provides
`smbclient` (`docker run --rm --entrypoint sh <image> -c 'command -v smbclient'`),
so a build that resolved the package away fails the pull request rather than an
operator's setup run.

## The FIPS variant image's pins

`Dockerfile.fips` builds a second image on Amazon Linux 2023 carrying the
CMVP-validated OpenSSL FIPS provider AWS publishes for that distribution. It is
published from the same release workflow under the default image's tags with
`-fips` appended ([RELEASES.md](../RELEASES.md#which-image-has-which-posture));
why it exists, what may be claimed of it, and what stops working inside it are in
[fips-variant-image.md](../notes/fips-variant-image.md). Everything above about
the npm freeze applies to it unchanged -- same lockfile, same `npm ci`, same
production rebuild for the runtime tree, same freeze test. What follows is what
it pins beyond that, and the second OS-package inventory that comes with it.

**Six pins, five of them compared against the artifact inside the build.**

| Pin | Value | How it is held |
| --- | --- | --- |
| Release snapshot | `--releasever=2023.12.20260727` on every `dnf` transaction | Shape-checked as a dated snapshot in `scripts/dockerfile-freeze.test.mjs`; compared against the base rootfs's own `system-release` version, asserted in the build |
| Provider package and version | `openssl-fips-provider-certified` at `3.0.8-1.amzn2023.0.1` | `rpm -qf` on the installed `fips.so`, asserted in the build |
| Module version string | `3.0.8-d694bfa693b76001` | `openssl list -providers` read back, asserted in the build |
| Base image | `amazonlinux:2023@sha256:694092ae18877ed4e3cb9b643759ba95df1f12af12528fefa18f60f79d4c1568`, the multi-arch index digest | Named in the `FROM` instead of the tag; the literal held in `scripts/dockerfile-freeze.test.mjs` |
| Node runtime tarball, `x64` | `982aa24dd8be4c889c6a8ab337ddff3b0896645b20f4239356e80552c16277ee` | `sha256sum -c` against the literal committed in the fetching `RUN`; the literal held in `scripts/dockerfile-freeze.test.mjs` |
| Node runtime tarball, `arm64` | `afc7a004018485092ac8985b817b0d5684472bd9472e0b57d2ab88737e50090d` | as above |

All three certificate pins are build `ARG`s, so what the assertions catch is a
package layer that drifts under the committed values rather than an operator who
changes those values. The three do not move together, and that is what keeps a
partial override from passing. The `dnf swap` and the `rpm -qf` assertion both
read `FIPS_PROVIDER_PACKAGE` and `FIPS_PROVIDER_VERSION`, so overriding those
moves the install and its own check in step; `FIPS_MODULE_VERSION` appears in no
`dnf` line and is read by the read-back assertion and by the `ENV` of the same
name the runtime stage exports from it. That `ENV` is the value the entrypoint's
per-run report names, and it is trustworthy at run time for exactly one reason:
the assertion that compares it against the module the loader activates has
already run in the same stage, so no green build can carry an `ENV` naming a
module other than the one installed. A build driven by hand
with `--build-arg` over the install pins alone therefore installs a different
NVR, satisfies the `rpm -qf` half, and fails on the module version the loader
reports -- it goes red, not green. A green build carrying a different module
takes an override of the module version as well, which is a statement of which
module was intended. What holds the committed defaults themselves is
`scripts/dockerfile-freeze.test.mjs`, which pins all three as literals, and no
CI path passes a build-arg -- `image_smoke.yaml` passes none, and the release
workflow does not build this image.

**The two tarball hashes are deliberately not `ARG`s.** Each is a literal in the
`RUN` that fetches the tarball, selected by the same `case` arm that selects the
architecture's tarball name. An `ARG` is overridable at
`docker build --build-arg`, which is the limit the paragraph above records for
the certificate pins: tolerable there, because a second assertion reads the
installed module back and a partial override goes red, and not tolerable here,
because nothing else in the build looks at the tarball. `NODE_VERSION` stays an
`ARG`, so overriding it alone fetches bytes the committed hash does not cover
and fails at the checksum -- a Node bump means moving the version and both
hashes together. That the check fails closed, on bytes that do not match and on
an arch arm that paired a tarball with the other architecture's hash, is driven
against the real `sha256sum` in `scripts/docker-entrypoint-fips.test.mjs`.

The release-snapshot pin is for reproducibility rather than for the certificate:
AWS retains superseded NVRs, and a dated snapshot is immutable while
`--releasever=latest` accumulates. That is why the freeze test holds its shape
rather than its value: the property worth guarding is that the build names a
dated snapshot at all, and a deliberate bump to a newer one should not have to
edit the test. Which snapshot it names is held by review, but not independently
of the base: the build asserts the two are the same release, so review decides
the pair and a check keeps them from parting company. Sampled across AWS's
published snapshots, every snapshot from the packages' first appearance (between
`2023.6.20250107` and `2023.7.20250428`) onward still resolves and still serves
both certified NVRs, from a content-addressed blobstore.

The module-version pin is the one that cannot be skipped. Ten NVRs share the
`openssl-fips-provider-latest` package name and carry ten different modules with
ten different `fips.so` hashes, exactly one of them certified, so the package
name settles nothing:

    3.2.2-1.amzn2023.0.1 -> 3.2.2-799901ad7ab41d45   <- the one certificate 5438 names
    3.2.2-1.amzn2023.0.2 -> 3.2.2-6a2d04a6952ab14a
    3.5.5-1.amzn2023.0.5 -> 3.5.5-f06cf76f53649b34   <- stock in amazonlinux:2023
    3.5.7-2.amzn2023.0.1 -> 3.5.7-89ade9f4d5e93a4c

The `-certified` name this image uses is a different package with one published
NVR, so a `dnf update` has nothing to move it to; the assertion is what catches
a future one that is not certified.

The security policy is the other reason that pin carries the weight, because it
names no package this image installs and does not agree with itself about the
one it does name. Its installation and administrator-guidance sections (11.1 and
11.2, p. 65) name `openssl-3.0.8-1.amzn2023.0.17`; its end-of-life section
(11.6, p. 65) names `openssl-3.0.8-1.amzn2023.0.9`. Both are NVRs of the
distribution's `openssl` package rather than of either `-certified` package, and
the inconsistency between them is recorded rather than resolved -- neither is
the value this image pins, and nothing here turns on which of the two the policy
meant. The module version string is the identifier the policy is consistent
about, giving it in section 1.1 (p. 6), again in section 11.2 (p. 65) as the
value the Crypto Officer reads back, and in all six rows of Tables 2 and 3.

**The base image digest and the snapshot pin name one release, not two.** The
snapshot pin covers the package layer and not the base rootfs, and the two are
coupled: a base far newer than the pinned snapshot can put that snapshot's
packages in conflict with what the base already carries. The digest in the table
above closes that. It is the multi-arch index digest, which is what a
multi-platform build can resolve -- a platform-specific manifest digest names one
architecture and fails on the other -- and it was resolved on 2026-08-06 with
`docker buildx imagetools inspect amazonlinux:2023`, both of whose per-arch
manifests carry `org.opencontainers.image.created: 2026-08-04`. The rootfs at
that digest reports `PRETTY_NAME="Amazon Linux 2023.12.20260727"` on `amd64` and
`arm64` alike, which is the release `AL2023_RELEASEVER` names, so the base and
the packages are the same snapshot rather than two compatible ones.

That equality is asserted in the build rather than left to the bumper: the
`nodebase` stage reads `system-release`'s version out of the rootfs and fails
unless it is what `AL2023_RELEASEVER` names, so a digest moved on its own reddens
the image build instead of producing a green one whose userland and package layer
came from different releases. Its reach is the architecture being built, each
having a rootfs of its own, and `image_smoke.yaml` builds `amd64` alone. So
bumping the base still means re-resolving the digest and reading that release out
of each architecture's rootfs -- `docker create` plus `docker cp` of
`/etc/os-release` reads the foreign architecture without emulating or executing
it -- with the assertion holding the value that reading produces. The rest of
that procedure, and what a green smoke run does and does not prove about a bump,
are in [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md#bumping-the-fips-base-image).

**What the build fetches, beyond the npm tree.** Two mirrors rather than the
default image's one:

- `dnf` from the pinned Amazon Linux snapshot, for `tar`, `gzip`, `xz`,
  `findutils`, `libatomic`, `samba-client`, `openssl`, and the provider swap.
  RPM signatures are verified against the key the base image carries.
- `nodejs.org`, for the official Node 26 tarball, whose bytes are checked against
  the per-architecture hash committed in the fetching `RUN` rather than against a
  checksum file fetched beside them. Amazon Linux 2023 packages nodejs20,
  nodejs22 and nodejs24 only and the root `package.json` requires `>=26`, and
  `libatomic` is the one shared library the stock image lacks for that binary
  (without it `node` exits 127). What that pin does and does not establish about
  the tarball's provenance, and the one-time verification behind the two values,
  are in [fips-variant-image.md](../notes/fips-variant-image.md).

`smbclient` comes from `samba-client` here rather than from Alpine's package of
the same name, at 4.17.12, so `image_smoke.yaml`'s `command -v smbclient`
assertion holds against both images unchanged. It costs 53 packages on this
base against Alpine's 45, including `systemd`, `dbus`, `pam`,
`cryptsetup-libs`, `device-mapper` and `util-linux` -- a heavier closure, and
one that includes an init system.

## What certificate 5021 attests

The provider pins above name CMVP certificate 5021, "Amazon Linux 2023 OpenSSL
FIPS Provider". Its two sources are the certificate page, which carries
`FIPS 140-3`, `Overall Level 1`, `Status: Active`, a `5/25/2030` sunset date,
and an initial validation on `5/26/2025` by atsec information security
corporation; and the module's own non-proprietary security policy, document
version 1.2 of 2025-05-14, which is the authority for every table below. The
page renders no module-version, tested-configuration or approved-algorithm
section, so the rows here are single-sourced on the policy. Why the image pairs
with this certificate, what a claim about the image may say, and the conditions
the policy attaches to three of the algorithm rows are in
[fips-variant-image.md](../notes/fips-variant-image.md).

### The Caveat

The certificate carries one Caveat, quoted here verbatim:

> When operated in approved mode. No assurance of minimum security of SSPs
> (e.g., keys, bit strings) that are externally loaded, or of SSPs established
> with externally loaded SSPs.

Provenance differs from every other row in this section. The Caveat is a field
of the certificate detail page itself, an HTML page carrying no page numbers,
rather than of the 71-page security policy that sources the tables below; there
is accordingly no page citation for it and none is fabricated.

`SSP` is the FIPS 140-3 term for a sensitive security parameter: a key, a seed,
or any other value whose disclosure or modification compromises the module. The
sentence reaches this project's composition directly -- the key schedule mixes a
pre-shared secret the module did not generate -- and
[COMPLIANCE.md](../COMPLIANCE.md#fips-140) is where what follows from that is
stated.

### The tested operational environments

Section 2.2, Table 3 (pp. 8-9), complete -- three hardware platforms, each
tested with the processor's cryptographic acceleration on and off:

| Operating system | Hardware platform | Processors | PAA/PAI | Hypervisor or host OS |
| --- | --- | --- | --- | --- |
| Amazon Linux 2023 | EC2 `c7g.metal` | AWS Graviton3 | Yes | N/A |
| Amazon Linux 2023 | EC2 `c6i.metal` | Intel Xeon Platinum 8375C | Yes | N/A |
| Amazon Linux 2023 | AWS Snowball | AMD EPYC 7702 | Yes | N/A |
| Amazon Linux 2023 | EC2 `c7g.metal` | AWS Graviton3 | No | N/A |
| Amazon Linux 2023 | EC2 `c6i.metal` | Intel Xeon Platinum 8375C | No | N/A |
| Amazon Linux 2023 | AWS Snowball | AMD EPYC 7702 | No | N/A |

Every row carries module version `3.0.8-d694bfa693b76001`, the string the pin
table above holds. Table 2 (Tested Module Identification, p. 8) names the same
three platforms with `fips.so` as the file and `HMAC-SHA-256` as its integrity
test.

**Six tested environments, and no vendor-affirmed ones.** Section 2.2 is titled
"Tested and Vendor Affirmed Module Version and Identification" and carries only
the two tested tables; Table 3's caption is followed directly by section 2.3,
Excluded Components. The second half of that heading is phrased from the table's
contents deliberately, because an absence is all there is to phrase it from:
this policy states no sentence denying vendor affirmation. Other certificates
do -- 4985's policy says "No operational environments are vendor affirmed" -- so
quoting that sentence against 5021 would be a misquotation.

**None of the six is a container, and none is a virtual machine.** Every row is
bare metal with `Hypervisor or Host OS: N/A`. The variant image is therefore not
running in a tested operational environment on any host, which is what
[fips-variant-image.md](../notes/fips-variant-image.md) reasons from rather than
around.

### The approved-algorithm rows behind the measured call shapes

The variant's entrypoint probe makes five call shapes, and those five are what a
"dispatches into the validated module" claim may name
([fips-variant-image.md](../notes/fips-variant-image.md)). Each is on Table 5
(Approved Algorithms, pp. 9-13), under the row name and CAVP certificate ids the
policy records:

| Call shape | Table 5 row | CAVP certificates | Properties | Reference |
| --- | --- | --- | --- | --- |
| AES-256-GCM, 12-byte IV | `AES-GCM` | A4614, A4615, A4616, A4617, A4620, A4621, A4622, A4623, A4624, A4625, A4626, A4627, A4628 | `Direction - Decrypt, Encrypt`; `IV Generation - External, Internal`; `IV Generation Mode - 8.2.1, 8.2.2`; `Key Length - 128, 192, 256` | SP 800-38D |
| HKDF-SHA-256 | `KDA HKDF Sp800-56Cr1` | A4603 | `Derived Key Length - 2048`; `Shared Secret Length: 224-2048 Increment 8`; `HMAC Algorithm` including `SHA2-256` | SP 800-56C Rev. 2 |
| HMAC-SHA-256 | `HMAC-SHA2-256` | A4608, A4612, A4618, A4629, A4630, A4631, A4632 | `Key Length: 112-524288 Increment 8` | FIPS 198-1 |
| SHA-256 | `SHA2-256` | A4608, A4612, A4618, A4629, A4630, A4631, A4632 | `Message Length: 0-65536 Increment 8`; `Large Message Sizes - 1, 2, 4, 8` | FIPS 180-4 |
| P-256 ECDH | `KAS-ECC-SSC Sp800-56Ar3` | A4612, A4618, A4629, A4630, A4631, A4632 | `Domain Parameter Generation Methods - P-224, P-256, P-384, P-521`; `Scheme - ephemeralUnified`; `KAS Role - initiator, responder` | SP 800-56A Rev. 3 |

Three of those properties bound a value `packages/core/src` chooses, and all
three are satisfied: the HKDF row's shared-secret window is 224-2048 bits
against a 256-bit shared secret, its tested derived-key length 2048 bits against
a 256-bit output, and the HMAC row's key-length floor 112 bits against a 256-bit
key.

**The HKDF row's name and its reference column disagree, and the policy resolves
it in prose.** The row is named `KDA HKDF Sp800-56Cr1` while its reference
column reads `SP 800-56C Rev. 2`; section 2.10 (p. 24) states the attribution
directly -- the module's `KDA OneStep`, `KDA TwoStep` and HKDF are "compliant
with SP 800-56Cr1 (HKDF) and SP 800-56Cr2 (KDA OneStep, KDA TwoStep)". A
citation that names this module's HKDF therefore names Cr1 and CAVP certificate
`A4603`, not the Cr2 row and cert `A3548` that certificate 4985 carries.

**Table 5 membership is not the whole answer for three of the five.** The
policy attaches a condition to AES-GCM, to the SP 800-56Ar3 assurances behind
the ECDH row, and to the use context of HKDF, each stated outside Table 5. They
are recorded in
[fips-variant-image.md](../notes/fips-variant-image.md), which is where what may
be claimed of the image is reasoned about.

**X25519 and Ed25519 appear in no table of this policy.** Neither string occurs
anywhere in its 71 pages, and the policy's non-approved-but-allowed categories
are empty by explicit statement ("N/A for this module", stated twice -- with and
without security claimed), so there is no status either algorithm could hold
under this certificate. That is a different statement from the one certificate
4985 supports, whose Non-Approved, Not Allowed table names both.

### The ECDSA rows, which no probe leg covers

Receipt signing calls `crypto.subtle` ECDSA over P-256 with SHA-256, and the
entrypoint probe makes no ECDSA call, so the rows below are a table placement
and never a measured dispatch
([fips-variant-image.md](../notes/fips-variant-image.md)). They sit on the same
Table 5 (p. 10):

| Table 5 row | CAVP certificates | Properties | Reference |
| --- | --- | --- | --- |
| `ECDSA KeyGen (FIPS186-5)` | A4612, A4618, A4629, A4630, A4631, A4632 | `Curve - P-224, P-256, P-384, P-521`; `Secret Generation Mode - testing candidates` | FIPS 186-5 |
| `ECDSA KeyVer (FIPS186-5)` | A4612, A4618, A4629, A4630, A4631, A4632 | `Curve - P-224, P-256, P-384, P-521` | FIPS 186-5 |
| `ECDSA SigGen (FIPS186-5)` | A4612, A4618, A4629, A4630, A4631, A4632 | `Curve - P-224, P-256, P-384, P-521`; `Hash Algorithm - SHA2-224, SHA2-256, SHA2-384, SHA2-512, SHA2-512/224, SHA2-512/256`; `Component - No` | FIPS 186-5 |
| `ECDSA SigVer (FIPS186-5)` | A4612, A4618, A4629, A4630, A4631, A4632 | `Curve - P-224, P-256, P-384, P-521`; `Hash Algorithm - SHA2-224, SHA2-256, SHA2-384, SHA2-512, SHA2-512/224, SHA2-512/256` | FIPS 186-5 |

A second pair of `SigGen` and `SigVer` rows, at CAVP certificates A4613 and
A4619, carries the SHA-3 hash algorithms in place of the SHA-2 ones over the
same four curves.

Table 13 (Approved Services, p. 30) carries the services above those rows:
signature generation and signature verification with ECDSA, each with the
approved indicator `OSSL_RH_FIPSINDICATOR_APPROVED`, beside key pair generation
with ECDSA and public key verification with ECDSA.

**The pre-hashed-message variant is a non-approved service.** Table 7 lists
`RSA and ECDSA (pre-hashed message)` for signature generation and verification,
and Table 14 (Non-Approved Services, p. 35) carries the two matching service
rows. The module therefore separates two signature services over one approved
algorithm, and which of them a caller reaches is decided by the indicator the
module sets rather than by Table 5 membership. The AES-GCM condition above
separates two services the same way, and there the call surface settles which
one is reached: every `crypto.subtle` AES-GCM call supplies an external IV
([fips-variant-image.md](../notes/fips-variant-image.md)).

## The runtime posture measured on each built image

Three properties are settled by running the image `image_smoke.yaml` just
built, not by reading the Dockerfile that produced it: which trees the
container can write, which files carry a setuid or setgid bit, and where every
symlink under `/app` resolves. All three are outcomes rather than
instructions -- each is decided by base-image state and by the file modes and
targets an OS package arrives with as much as by anything this repository
writes -- so a static reading of the build cannot reach any of them, however
tightly `scripts/dockerfile-freeze.test.mjs` holds the instructions
themselves.

### The writable set

Either image's container writes `/work` and
`/run/psilink/sftp-credentials`, and no path under `/app`. The measurement
creates a file in each of the two writable directories under the account the
image runs as and requires the same write under `/app` to be refused; a write is
what settles it, because a mode that reads as writable over a layer that refuses
the write is the case a `stat` cannot tell apart.

Refusing the write into `/app` is only half the claim, since a file the account
can rewrite in place needs no writable directory around it. The other half is a
walk of `/app` for any path owned by that account, owned by any group the account
carries, or other-writable; the expected set is empty. The walk runs as uid 0, so
no directory mode can hide a path from it -- ownership and mode read the same
whoever asks.

Symlinks are outside that walk. Linux carries no `chmod` for one, so a symlink's
own mode is always 0777 and an other-writable test matches every link in the
image while none of them is rewritable through that mode. What re-points a link
is write permission on the directory holding it, which the walk already reaches
through the directory itself.

Both halves run on both images. They differ in where the account comes from --
the default image inherits `node` from `node:26-alpine`, the variant creates it
at the same uid and gid, Amazon Linux 2023 carrying no such account -- and in
nothing this measurement reads.

### The symlink containment

The writable-set walk above skips symlinks, correctly: a symlink's own mode is
always 0777 and grants nothing, so testing it proves nothing about rewriting.
That leaves one shape the walk cannot see: a symlink under `/app` whose target
resolves into a tree the runtime account can write, `/work` for instance, is
code that account can effectively rewrite without owning, or being granted
write on, anything the walk measures. This pass closes that gap directly,
measuring every symlink found under `/app` in the built image.

Each link is resolved and sorted into one of three buckets: contained (the
resolved path is `/app` or falls under it), escaping (the resolved path exists
but falls outside `/app`), or dangling (the target does not resolve to a path
that exists at all).

The resolution runs `readlink -f` on each link and then checks the result with
`[ -e ]` rather than trusting it alone -- the guard is what actually settles
the classification. The step never changes directory, so every command runs at
the image's `WORKDIR`, `/work`, which is empty in the ephemeral container the
step runs in; a target that does not resolve to a real path therefore fails
the `[ -e ]` guard regardless of what string `readlink -f` produced for it, and
is bucketed as dangling rather than misread as an escape.

Any escaping or dangling link fails the step, and the offenders -- each with
its raw target and, where one resolved, the path it resolved to -- are printed
so the failure is diagnosable from the job log alone.

Run on both images, as the writable-set measurement above is.

### The setuid and setgid inventory

Measured on both images with

    find / -xdev -type f \( -perm -2000 -o -perm -4000 \) -exec ls -l {} +

run as uid 0, for the same reason the `/app` walk is: a traversal under an
unprivileged account cannot enter a root-only directory, so an empty result from
one would report an absence it never measured. The step compares the paths it
finds against the inventory recorded here for that image and fails on any
difference in either direction.

| Image | Recorded inventory |
| --- | --- |
| `Dockerfile` | empty -- no setuid or setgid file |
| `Dockerfile.fips` | empty -- no setuid or setgid file |

Both inventories are empty because each runtime stage takes off every bit its
own OS install brings in, and neither stage's base carries another. Both images
declare `USER node`, so a bit left in place would be a boundary an unprivileged
process could push against rather than a formality, and neither role
authenticates a Unix account or mounts a filesystem.

The default image strips one file. `samba-client` pulls in `linux-pam`, whose
`/usr/sbin/unix_chkpwd` lands setgid `shadow`, and `chmod g-s` in the runtime
stage removes it.

The variant strips ten, its Amazon Linux 2023 base and the `samba-client`
closure recorded above carrying between them eight setuid root -- account, mount
and PAM helpers -- plus `write` setgid `tty` and `utempter` setgid `utmp`. That
closure is materially larger than Alpine's, bringing `systemd`, `pam`,
`cryptsetup-libs`, `device-mapper` and `util-linux` with it. The ten paths are
named as literals in one `chmod u-s,g-s`, so a path the closure stops carrying
fails the build rather than passing unnoticed, and one it gains reddens this
measurement. Per-file detail on what each was for is in
[the FIPS variant's setuid and setgid files](#the-fips-variants-setuid-and-setgid-files).

`scripts/dockerfile-freeze.test.mjs` holds each image's stripping instruction as
one of the mode changes it permits outside the writable trees, and the
measurement holds the outcome, which is the half that also sees the base image's
own files.

An image added to the matrix records its own row the same way rather than
starting unmeasured: its arm in the step is set to the `@unrecorded` sentinel,
and the first run fails that leg and prints the block to paste into the arm and
the list to paste here. The step is the last in the job so that a failure of
either kind -- a sentinel awaiting its first measurement, or an inventory that
has drifted -- skips no step that matters more, the variant's provider
assertions and its end-to-end exchange among them.

## What the shipped setup scripts ask of the image

The Windows and POSIX file-drop scripts in `support/windows-network-filedrop/`
delegate every check they make to a capability of the image: they hand a
container a psilink argument vector, or they pipe one of their helper scripts
into a shell in it and depend on the tools that shell resolves. That is a
contract between two things nothing else in the repository connects, so
`image_smoke.yaml` exercises it on both sides of publication.

**The set is derived, not listed.** `scripts/derive-image-dependencies.mjs`
reads it out of the scripts: an argument vector is a run of literal tokens
beginning with a word the image's own dispatchers answer to -- the words
`docker-entrypoint.sh` routes on, and the commands `apps/cli/src/cliParser.ts`
registers -- on a line that also names the image or an argument-vector
parameter; a helper script is one `cmd_Setup-PsilinkFileDrop.cmd` redirects into
a shell in the image, with the environment and mounts that call site gives it. A
call site added to a script changes the derived set, and a derived dependency
with nothing to exercise it fails `npm run check:image-capabilities`, which
`static_checks.yaml` runs on every pull request whatever it touched.

**Each is exercised rather than matched.** `scripts/assert-image-capabilities.mjs`
runs the argument vector and reads back the machine-readable verdict, and pipes
each helper script in as the `.cmd` pipes it -- so a helper's in-image tools are
resolved by the run and are enumerated nowhere. Two fixtures decide whether a red
result is about the image at all, and the script sets up both: a rendezvous
directory the account the image runs as can write, because a fresh named volume
belongs to root and the default image runs as uid 1000, and a stub peer that
accepts and drops each connection on port 445, because both probe paths stop at
their reachability check when nothing answers and leave `smbclient` unreached.

**What a run may claim is bounded by what it treats as evidence.** A doctor
battery that refuses its input exits 64 having run no check, and an image whose
CLI carries no `doctor` command answers the same way, so 64 proves nothing; 69 is
a dependency the battery could not reach and fails the gate. The evidence is the
verdict document, whose `version` must be the one the shipped launchers read and
stop past.

**Two legs, asserting different things.** The build-time leg runs against the
image the job just built. That is the right subject for `Start-Psilink.ps1` and
`start-psilink.sh`, which ship stamped with a release's manifest digest and are
therefore locked to the commit they were built from, and it catches a support
script that outran the source tree in the same pull request. It is the wrong
subject for `Setup-PsilinkFileDrop.ps1`, which is fetched on its own and runs the
floating tag, so a second leg runs against `vdorie/psi-link:latest` on the weekly
schedule and on demand. That leg is deliberately not a merge gate: the commonest
reading of a gap there is that the capability is on the default branch and no
release has been cut since, whose remedy is a release rather than a held merge.
Both legs print the digest the reference resolved to rather than the reference
they asked for, because the floating tag moves.

Both legs are scoped to the default image. It is the one published as
`vdorie/psi-link`, the only one the scripts name, and the only one whose package
closure their helper scripts were written against.

## Measured inventories

> **Non-normative.** What follows measures images that were built, kept as the
> evidence behind the rows above. Nothing here binds a build: a rebuild that
> moves a figure moves the figure, not the spec.

### What the 45 packages add beyond `smbclient`

Invocation is not the only cost: these libraries sit in the image that runs
every exchange, so an advisory against any of them applies to that image whether
or not an exchange reaches the code, and none of them is in the release SBOM
either. Measured on the pinned base at
`aarch64` (`apk list -I` before and after), they are the samba client libraries
and their record stores (`samba-client-libs`, `samba-common`, `samba-libs`,
`samba-util-libs`, `libsmbclient`, `libwbclient`, `libauth-samba`, `ldb`,
`talloc`, `tdb-libs`, `tevent`, `lmdb`, `gdbm`), an authentication and directory
stack (`linux-pam`, `libldap`, `libsasl`, `utmps-libs`, `skalibs-libs`), a
TLS/crypto stack (`gnutls`, `nettle`, `gmp`, `libtasn1`, `p11-kit`, `libffi`),
compression and archive libraries (`libarchive`, `xz-libs`, `zstd-libs`,
`lz4-libs`, `libbz2`, `brotli-libs`), and a tail of support libraries
(`readline`, the `ncurses` set, `popt`, `icu-libs`, `icu-data-en`, `libexpat`,
`jansson`, `libidn2`, `libunistring`, `acl-libs`, `libcap2`). No `smbd`, `nmbd`
or `winbindd` is installed, so nothing added listens.

`linux-pam` is where the setgid bit the runtime stage strips comes from. Measured
with

    find / -xdev -type f \( -perm -2000 -o -perm -4000 \) -exec ls -l {} +

which reports nothing on the pinned base digest at either architecture, and after
the install reports exactly `-rwxr-sr-x 1 root shadow /usr/sbin/unix_chkpwd` and
no setuid file at all -- on the built `arm64` image, and at `x86_64` on the
pinned base plus that one instruction. It sits beside the PAM helpers `faillock`,
`mkhomedir_helper`, `pam_namespace_helper`, `pam_timestamp_check` and
`pwhistory_helper`, none of them setgid. Because the runtime stage declares
`USER node`, the process that bit would elevate is unprivileged, so it would have
to be read as a boundary rather than as the formality it is for uid 0 -- which is
why the stage removes it instead, leaving nothing to reason about. The enforced
form of that, and the same `find` run against both built images on every pull
request, are in
[the runtime posture measured on each built image](#the-runtime-posture-measured-on-each-built-image).

### The helper image the setup scripts run the probe in is a mutable tag

It is `vdorie/psi-link:latest` in both scripts, and floating it is deliberate:
the scripts are downloaded on their own rather than shipped with a release, so
they cannot name the digest of a release they do not know they belong to, and a
diagnostic pinned tighter than the thing it diagnoses would test an image the
exchange will not run. The limit that comes with it is recorded rather than
closed. The helper container receives the share password in its environment
(`--env SMB_PASS`) and, for the volume check, a bind of the CIFS volume, so the
plaintext credential and read/write access to the partner's drop folder go to
whatever the tag resolves to at pull time -- and that pull happens on exactly the
HTTPS-intercepting networks the probe exists to diagnose. A digest, or a released
version tag, is what would make a substituted image detectable there; how a
separately downloaded script would learn either is the open part.

### The FIPS variant's setuid and setgid files

The ten files the variant's runtime stage strips, with the bits and modes they
arrive with, as `image_smoke.yaml` measured them on a build at the base digest
pinned above before the stripping instruction existed (run 31235317792,
`amd64`). This is the evidence behind that instruction's literal path list, and
the record of what an unstripped build of this closure carries:

    -rwsr-xr-x 1 root root 74360 Nov 20  2023 /usr/bin/chage
    -rwsr-xr-x 1 root root 78680 Nov 20  2023 /usr/bin/gpasswd
    -rwsr-xr-x 1 root root 48760 Jul 10 19:10 /usr/bin/mount
    -rwsr-xr-x 1 root root 42392 Nov 20  2023 /usr/bin/newgrp
    -rwsr-xr-x 1 root root 57232 Jul 10 19:10 /usr/bin/su
    -rwsr-xr-x 1 root root 36400 Jul 10 19:10 /usr/bin/umount
    -rwxr-sr-x 1 root tty  24064 Jul 10 19:10 /usr/bin/write
    -rwx--s--x 1 root utmp 16176 Jan 29  2023 /usr/libexec/utempter/utempter
    -rwsr-xr-x 1 root root 15768 Dec 22  2025 /usr/sbin/pam_timestamp_check
    -rwsr-xr-x 1 root root 28208 Dec 22  2025 /usr/sbin/unix_chkpwd

Eight are setuid root: the account helpers `chage`, `gpasswd`, `newgrp` and
`su`, the mount helpers `mount` and `umount`, and the PAM helpers
`pam_timestamp_check` and `unix_chkpwd`. Two are setgid: `write` to `tty` and
`utempter` to `utmp`. The measurement reads the built image and does not
separate what the base rootfs carries from what the package closure adds; no row
above turns on that split.

Two of these names also appear in the default image's closure, carrying a
different bit there: `unix_chkpwd` lands setgid `shadow` on Alpine, while here it
is setuid root; and `pam_timestamp_check`, which Alpine's install leaves with
neither bit, is setuid root here. The same package name on two distributions is
not the same file modes, which is why each image's list is measured rather than
derived from the other's.

### The FIPS reference build's inventory

These figures measure the reference build `Dockerfile.fips` was derived from,
on `aarch64`, against the Alpine image built the same day. That reference
installed `binutils` (29,160,927 bytes installed) to read the module version out
of `fips.so` with `strings`, which this build does not need because it reads the
version back through `openssl list` instead, so the reference's package count and
size run above what `Dockerfile.fips` produces. Nothing has been measured on
`x86_64`.

| | Alpine image | FIPS variant (reference build) |
| --- | --- | --- |
| Image size | 575,506,781 bytes (576 MB) | 1,055,721,059 bytes (1056 MB) |
| OS packages | 63 | 167 |
| Packages carrying a GPL-3.0 or LGPL-3.0 term | the 6 samba ones | 39 |

Where the 480 MB goes: the two base rootfs are almost the same weight
(`amazonlinux:2023` 183 MB, `node:26-alpine` 178 MB), but Amazon Linux bundles
no Node, so the 222 MB tarball is additive, and its dependency closures are
fatter -- glibc/libgcc/libstdc++ 67 MB, `python3` (in the base image, for `dnf`)
55 MB, the samba client stack 44 MB, `systemd` (a `samba-client` dependency)
31 MB, `dnf`/`rpm`/`libsolv`/`librepo` 11 MB. The certified `fips.so` itself is
1.2 MB.

**The licence consequence is wider than the default image's, and is open.** The
GPL-3.0/LGPL-3.0 term the table above records against the Alpine image's samba
packages reappears here on `samba-client`, `samba-client-libs`, `samba-common`,
`samba-common-libs`, `libsmbclient` and `libwbclient`, and is joined by a GPLv3
base userland Alpine's busybox and musl do not have: `bash`, `coreutils-single`,
`diffutils`, `findutils`, `gawk`, `grep`, `gzip`, `sed`, `tar`, `readline`,
`gdbm-libs`, `gnupg2-minimal`, `gnutls`, `libtasn1`, `libassuan`, plus the
LGPL-3.0 samba record stores (`libtalloc`, `libtdb`, `libtevent`, `libldb`).
Four more carry an unconditional v3 term from elsewhere in the closure:
`binutils`, `elfutils-debuginfod-client`, `libidn2` and `mpfr`. `libgcc`,
`libstdc++`, `libatomic` and `libgomp` carry
"GPL-3.0-or-later WITH GCC-exception-3.1", the runtime exception, which is the
normal case for a linked C++ runtime. The remaining six of the 39 --
`elfutils-libelf`, `elfutils-libs`, `elfutils-default-yama-scope`, `gmp`,
`libunistring` and `nettle` -- offer a GPLv2-or-later arm beside the LGPLv3 one,
so they carry a v3 term only under the arm taken. Whether that breadth changes
this project's distribution posture is a licensing call rather than a
measurement, and it is not settled here.
