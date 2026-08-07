---
title: "Container Image Composition and Pins"
---

# Container image composition

Two container images are built from this repository: the shipped CLI image
(`Dockerfile`) and the unpublished FIPS variant (`Dockerfile.fips`). Both
freeze their npm tree to the committed lockfile, pin their base image by digest,
and install one reviewed set of OS packages each. This document records what
each pins, what holds the pin, and what those installs bring into the image.
Why the npm dependencies themselves are exact-pinned, and the per-stack upgrade
checklists, are in [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md).

## The Docker image's dependency freeze

The shipped CLI image resolves no npm dependency at image-build time and installs
nothing at container runtime; one OS package, named below, is fetched from the
Alpine mirror while the image is built. The Dockerfile's builder stage installs with
`npm ci` against the committed `package-lock.json` -- which installs exactly the
locked tree, verifying each registry package against the lockfile's integrity
hash, and fails the build if a manifest and the lockfile disagree -- then, after
building, re-runs `npm ci --omit=dev` for the production-only tree, and the
runtime stage copies that `node_modules` unchanged. Every runtime dependency and
transitive in the image is therefore the exact version in the committed
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
install, the shipped tree is the `--omit=dev` one, the runtime stage runs no npm
at all, each file's OS-package installs are exactly the reviewed set, and the
copied layout keeps the workspace links and the PSI worker entry where the CLI
resolves them.

Those invariants are read off `COPY` and `RUN`, so the test refuses every other
instruction class outright, in either stage, rather than modeling it. `ADD` is
the one that names itself: it fetches a remote source and takes the same
`--chown`/`--chmod` flags `COPY` does, so it can both pull in a build input the
lockfile does not pin and land files with an ownership no assertion here reads. A
build that needs another class extends the test's reviewed list in the same diff.

The `node:26-alpine` base image is digest-pinned in both stages to its
multi-arch index digest, so the Node runtime and Alpine userland beneath the
frozen `node_modules` are fixed across rebuilds. The tradeoff is that a base
patch (a Node or musl fix) does not arrive on a rebuild of its own: bumping the
base is a deliberate digest update. Pin the multi-arch index digest,
not a platform-specific one, or the multi-platform release build cannot resolve
every architecture; obtain it with `docker buildx imagetools inspect
node:26-alpine`.

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
not published; why it exists, what may be claimed of it, and what stops working
inside it are in
[fips-variant-image.md](../notes/fips-variant-image.md). Everything above about
the npm freeze applies to it unchanged -- same lockfile, same `npm ci`, same
`--omit=dev` runtime tree, same freeze test. What follows is what it pins
beyond that, and the second OS-package inventory that comes with it.

**Six pins, four of them compared against the artifact inside the build.**

| Pin | Value | How it is held |
| --- | --- | --- |
| Release snapshot | `--releasever=2023.12.20260727` on every `dnf` transaction | Shape-checked as a dated snapshot in `scripts/dockerfile-freeze.test.mjs` |
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
edit the test. Unlike the rows below it, then, this pin's exact value is held by
review rather than by a check. Sampled across AWS's published snapshots,
every snapshot from the packages' first appearance (between `2023.6.20250107`
and `2023.7.20250428`) onward still resolves and still serves both certified
NVRs, from a content-addressed blobstore.

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
the packages are the same snapshot rather than two compatible ones. Bumping the
base means re-resolving the digest and re-reading that release out of each
architecture's rootfs -- `docker create` plus `docker cp` of `/etc/os-release`
reads the foreign architecture without emulating or executing it -- and moving
`AL2023_RELEASEVER` to match.

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

`linux-pam` also gives the image its first setgid binary. Measured with

    find / -xdev -type f \( -perm -2000 -o -perm -4000 \) -exec ls -l {} +

which reports nothing on the pinned base digest at either architecture, and after
the install reports exactly `-rwxr-sr-x 1 root shadow /usr/sbin/unix_chkpwd` and
no setuid file at all -- on the built `arm64` image, and at `x86_64` on the
pinned base plus that one instruction. It sits beside the PAM helpers `faillock`,
`mkhomedir_helper`, `pam_namespace_helper`, `pam_timestamp_check` and
`pwhistory_helper`, none of them setgid. The runtime stage declares `USER node`,
so the process the setgid bit would elevate is unprivileged and the bit has to be
read as a boundary rather than as the formality it is for uid 0. What bounds
exploitability is a single measured property of the image rather than of the
package -- `/etc/shadow` carries no usable hash (`root` is `*`, every other
account `!`), so `unix_chkpwd` has nothing to verify against. Whether that
account already carries group `shadow`, which would make the bit grant it nothing
in the first place, is not measured here and nothing rests on it;
`docker run --rm --entrypoint id <image> -Gn node` settles it against a built
image. Nothing stands behind the one property that does carry the conclusion, so
re-measure it if a change gives any account in the image a password hash, or if
the image gains a second setgid or any setuid file; the `find` above settles
both.

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
