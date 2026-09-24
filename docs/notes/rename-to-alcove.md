---
title: "Renaming psilink to Alcove"
---

# Renaming psilink to Alcove

_Status: decided on the maintainer's rulings and built. This note records the
mapping from each old name to its new one, why the wire and record constants
moved one ordinal forward rather than resetting, the clean break on the names
an operator or a browser holds, the image and repository moves, and the guard
that holds the old names out. See [docs/notes/README.md](README.md)._

This is design rationale. Nothing here binds an implementation: the constants'
values are in the spec ([PROTOCOL.md](../spec/PROTOCOL.md),
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md),
[EXCHANGE_RECORD.md](../spec/EXCHANGE_RECORD.md),
[EXCHANGE_FILE.md](../spec/EXCHANGE_FILE.md),
[MANAGED_EXCHANGE_RECORD.md](../spec/MANAGED_EXCHANGE_RECORD.md)), and this
note does not restate them.

## The mapping

The product was psilink, its repository `georgetown-mdi/jspsi`, and its image
`docker.io/vdorie/psi-link`. One mapping was applied across every tracked file:

| Old | New |
| --- | --- |
| product name in prose, titles, the PWA name | `Alcove` |
| `psilink` CLI bin and the apps/cli package | `alcove` |
| root package `jspsi` | `alcove-monorepo` (the root and a workspace cannot share a name) |
| apps/web package `jspsi` | `alcove-web` |
| `@psilink/core`, `@psilink/peerjs-broker`, `@psilink/testkit` | `@alcove/core`, `@alcove/peerjs-broker`, `@alcove/testkit` |
| `PSILINK_*`, `VITE_PSILINK_VERSION` | `ALCOVE_*`, `VITE_ALCOVE_VERSION` |
| `psilink.yaml`, `.psilink.key` | `alcove.yaml`, `.alcove.key` |
| `psilink-record`, `psilink-results`, `psilink-receipt`, `psilink-certificate` files | `alcove-record`, `alcove-results`, `alcove-receipt`, `alcove-certificate` |
| `/run/psilink/sftp-credentials` | `/run/alcove/sftp-credentials` |
| browser storage `psilink-...`, `psilink:diagnostics` | `alcove-...`, `alcove:diagnostics` |
| wire and record constants `psilink-...` | `alcove-...`, one ordinal forward (below) |
| image `docker.io/vdorie/psi-link` | `ghcr.io/georgetown-mdi/alcove` |
| CI-local image tags `psi-link:smoke` and the rest | `alcove:smoke` and the rest |
| `Start-Psilink.ps1`, `Setup-PsilinkFileDrop.ps1`, `start-psilink.sh`, `cmd_psilink-*` | `Start-Alcove.ps1`, `Setup-AlcoveFileDrop.ps1`, `start-alcove.sh`, `cmd_alcove-*` |
| relay units `psilink-relay-*`, `/etc/psilink-relay`, table `psilink_exchange` | `alcove-relay-*`, `/etc/alcove-relay`, `alcove_exchange` |
| core `psiLink` logger and `psiLink*.test.ts` | `link` and `link*.test.ts` (they test `psi/link.ts`) |
| nginx zones `psilink_sig_*`, `$psilink_origin_ok` | `alcove_sig_*`, `$alcove_origin_ok` |
| CI SMB paths `/srv/psilink*`, `/mnt/psilink*` | `/srv/alcove*`, `/mnt/alcove*` |
| devcontainer volumes `psilink-*` | `alcove-*` |
| rollup UMD name `psi-link` | `alcove` |
| repository `georgetown-mdi/jspsi` | `georgetown-mdi/alcove` |

Prose that names the product as a sentence subject reads `Alcove`;
identifiers, commands, and file names read `alcove`.

## The wire and record constants

The key-exchange labels, the HKDF info strings, the record, receipt, and
certificate version strings, the relay key info, the rendezvous peer-id prefix,
and the terms-update label all held the old name. They are domain separators
and format discriminants, so renaming them is a break: a pre-rename party
cannot exchange with a post-rename one, and a pre-rename signing identity,
record, or receipt is refused. The alternative that avoids the break -- freezing
the old strings as protocol constants -- leaves the old name in core
permanently, and was declined.

Each literal moved under the `alcove-` prefix to the next ordinal on its own
development counter, rather than resetting to `v1`. The project is
pre-release, and `scripts/check-exchange-record-version.mjs` refuses a `v1`
record literal before the release that publishes it. So
`RECORD_VERSION_PIN` follows the moved record literal, `RESET_RECORD_VERSION`
names the renamed `v1` form, and `RESET_TAKEN_AT_RELEASE` stays unset. The
first-publication reset in
[RELEASES.md](../RELEASES.md#reset-the-exchange-record-format-at-first-publication)
stands, with its literals renamed, and is still taken once at the first
published release.

Two literals follow the rule to a value no build has sent or written:

- The retired X25519 suite's protocol name, which PROTOCOL.md cites as the
  version the current suite replaced, moved one ordinal like the rest, so the
  spec names the retired suite by a name that never shipped.
- The managed-exchange backup format's previous-version literal, which the
  reader recognizes only to report an artifact from the format it replaced,
  moved with its family, so it names a backup version no build wrote.

No build accepts either value, so neither changes what an exchange or a reader accepts.

## Persisted names: a clean break

Operators hold a config, a key file, and record and receipt files; a browser on
the deployed web app holds its recurring exchanges and disclosure accountings in
IndexedDB. Three options were weighed: a clean break, a clean break plus a
one-time copy of the old IndexedDB database into the new one, and shims that
notice an old file and name it.

The ruling is a clean break everywhere. No code path names an old file or
database, so nothing written by a pre-rename build is read. A CLI operator
renames `psilink.yaml` and `.psilink.key` by hand (stated in
[CLI.md](../CLI.md#configuration) and the changelog), and a web user sets up
again any recurring exchange a browser held.

## The image and the repository

The image moved to `ghcr.io/georgetown-mdi/alcove` ahead of the rename, so it
has that name from its first push; a GHCR package name does not follow the
repository's. `docker.io/vdorie/psi-link` is frozen, with nothing pushed to it,
and is deleted after the release milestone.

The repository is renamed to `georgetown-mdi/alcove`; GitHub redirects the old
URL. The cosign certificate identity and the cloud OIDC trust conditions name
the repository, so both move with it. The package's write access for the
release workflow is a grant to the repository under the package's Manage
Actions access, keyed by repository id, so it survives the rename. The
Dockerfile's `org.opencontainers.image.source` label does not provide it:
measured with a hand push, the label links and grants nothing for an
organization package ([RELEASES.md](../RELEASES.md#8-build-and-publish-the-container-image-ci)).

## The guard, and its expiry

`scripts/check-no-legacy-names.mjs` fails on any tracked file or path holding
`jspsi`, `psilink`, or `psi-link`, outside an allowlist of the files that name
the old product on purpose. Its job is the weeks after the rename, while
branches cut before it are merged: such a merge brings the old name back with
no conflict to show. Once those branches are in, it has no job, so it carries
an expiry date, after which it fails with an instruction to delete it rather
than scanning on. The date, the allowlist, and what it cannot see are in its
header.
