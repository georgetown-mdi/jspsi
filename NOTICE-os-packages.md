# OS-layer source availability

Each image this repository publishes redistributes its base distribution's
operating-system packages, some of which declare GPL-2.0, GPL-3.0, LGPL-2.1 or
LGPL-3.0 terms. This file states where the corresponding source for those
binaries is published, and how to retrieve it at the versions a published image
holds.

The packages themselves are listed beside this file, one row per installed
package with the version and the license string the image's own package manager
declares: [`NOTICE-os-packages-default.tsv`](NOTICE-os-packages-default.tsv)
and [`NOTICE-os-packages-fips.tsv`](NOTICE-os-packages-fips.tsv). [`NOTICE`](NOTICE)
covers this repository's npm tree and reaches no OS package. How the lists are
derived, and what they do and do not measure, is in
[`docs/spec/CONTAINER_IMAGES.md`](docs/spec/CONTAINER_IMAGES.md#the-os-layer-attribution-lists).

## Scope

It covers both images this repository builds, on the same terms:

- The default image, built from `Dockerfile` and published as
  `vdorie/psi-link:X.Y.Z` and the floating tags beside it.
- The FIPS variant, built from `Dockerfile.fips` and published as
  `vdorie/psi-link:X.Y.Z-fips` and the floating tags beside it.

Coverage of the variant is not conditional on a tag: this statement holds for
any image built from either Dockerfile at the pins its list records, whether or
not a release has pushed that image.

It does not reach two things:

- The Node.js runtime and the npm bundled with it. Neither arrives through a
  package manager -- the default image's base installs both, and the variant
  unpacks them from an upstream `nodejs.org` tarball -- so neither list holds a
  row for them and nothing below names where their source is published. What
  identifies each is the base digest and the tarball hash
  [`docs/spec/CONTAINER_IMAGES.md`](docs/spec/CONTAINER_IMAGES.md) records.
- This repository's own npm tree, its vendored components, and their upstreams.
  Those are [`NOTICE`](NOTICE)'s, and the per-dependency licenses are in the
  CycloneDX SBOM attached to each release.

## The binaries are unmodified distribution packages

Every package in either list arrives from its distribution's own repositories,
installed by that distribution's package manager:

- Default image: the pinned `node:26-alpine` base ships every package but the
  `samba-client` closure, which one `apk add --no-cache samba-client` installs.
- FIPS variant: the pinned `amazonlinux:2023` base ships the rest, and the
  `dnf install` transactions add `tar`, `gzip`, `xz`, `findutils`,
  `libatomic`, `samba-client` and `openssl`, followed by one `dnf swap` onto
  the certified OpenSSL FIPS provider package. Every transaction resolves
  against the release snapshot `AL2023_RELEASEVER` pins.

Neither Dockerfile compiles, patches, relinks or rebuilds a package, and
neither adds a package repository of its own.

**What would falsify that.** An instruction that builds a package from source
(`abuild`, `rpmbuild`, a `make install`), applies a patch to one, overwrites a
file a package owns, or installs from a repository outside the base
distribution's. A reader checking this claim reads the two Dockerfiles for
those, not this paragraph.

Each runtime stage does change the installed filesystem: it deletes files it
does not need and clears the setuid and setgid bits on the files
[`docs/spec/CONTAINER_IMAGES.md`](docs/spec/CONTAINER_IMAGES.md) enumerates.
Neither is a change to a package's compiled contents, so the corresponding
source for every binary an image ships is the distribution's own, unmodified.

## Where the source is published

### The default image: Alpine

The pinned base digest resolves to Alpine 3.24.1, which the list's
`alpine-release` row states.

- **Build recipes and Alpine's own patches**: the aports repository,
  `https://gitlab.alpinelinux.org/alpine/aports`, on the stable branch for that
  release (`3.24-stable`), under `main/<package>` or `community/<package>`. Each
  package directory holds an `APKBUILD` naming the upstream source, with any
  Alpine patch beside it.
- **Upstream sources**: the tarball each `APKBUILD` names, mirrored by Alpine at
  `https://distfiles.alpinelinux.org/distfiles/`.
- **At a list row's version**: the version column is `pkgver-r<pkgrel>`. Find
  that pair in the history of the package's directory on the release branch. A
  row can be a subpackage of a larger recipe rather than a directory of its own,
  and the origin the image's own apk database records for that row
  (`/lib/apk/db/installed`) names the directory to read.

### The FIPS variant: Amazon Linux 2023

`Dockerfile.fips` pins the release snapshot every dnf transaction resolves
against (`AL2023_RELEASEVER`), and the base digest is that same release rather
than a compatible one.

- **Source packages**: Amazon Linux publishes a source RPM for each binary
  package in a release snapshot. A source RPM holds the upstream tarball, the
  distribution's patches and the spec file that builds it, which together are
  the corresponding source for the binary.
- **At a list row's version**: the version column is
  `epoch:version-release`, and rpm records the exact source package each
  installed binary package was built from:
  `rpm -q --qf '%{SOURCERPM}\n' <package>`, run in the image, names the file to
  retrieve.
- **Retrieval**: `dnf download --source <package>`, run against the pinned base
  with `--releasever` set to the snapshot `AL2023_RELEASEVER` names and the
  distribution's source repository enabled. `dnf repolist --all` in that base
  names that repository.

### The limits of the paths above

- Nothing in this repository dereferences either path, and no check asserts
  that they stay reachable or that a distribution has not reorganized them.
  They are recorded from each image's own metadata and each distribution's
  published source arrangements.
- A retrieval that comes up empty at a row's exact version is a prompt to
  regenerate the lists rather than evidence that no source was published: the
  default image's package set floats within its digest-pinned base, so a
  committed row's version is as of that list's generation
  ([`docs/spec/CONTAINER_IMAGES.md`](docs/spec/CONTAINER_IMAGES.md#the-os-layer-attribution-lists)).

## The source-offer question is open

Whether publishing these images obliges this project to make an offer of source
for the OS-layer binaries they redistribute -- and if so, what discharges it:
shipping source alongside the image, a written offer, or pointing at the
distribution's published source -- is **not answered here**. It is a legal
determination for the maintainer, taken with counsel if counsel is consulted,
and the answer is recorded in this file when it is made.

Until then this file states where the corresponding source is published. It is
not itself an offer of source, and no other document in this repository makes
one.
