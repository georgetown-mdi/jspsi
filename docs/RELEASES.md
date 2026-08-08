---
title: "Release Process"
---

# Release Process

This document describes how PSI-Link releases are prepared, tagged, and published.

## Versioning

PSI-Link uses [semantic versioning](https://semver.org/) (MAJOR.MINOR.PATCH):

- **PATCH**: backwards-compatible bug fixes, documentation updates, dependency patches.
- **MINOR**: backwards-compatible new features or new configuration fields. Exchange specification files written for an earlier MINOR version of the same MAJOR must continue to work.
- **MAJOR**: breaking changes to the exchange protocol, configuration schema, or CLI interface. A MAJOR bump means existing key files or exchange specs may need to be updated.

`apps/cli/package.json` is the canonical release version: Docker image tags and GitHub Release tags reflect the CLI version. The web console appliance baked into that image (`apps/web`, run via `serve`) is versioned to the CLI version along with the rest of the image; the hosted `apps/web` deployment carries no release version of its own. `packages/core` (and any future sub-packages) version independently -- a patch to the core library does not require a CLI release unless the CLI itself is also affected. The hosted `apps/web` deployment is continuously deployed and carries no release version. The root `package.json` version is a monorepo workspace marker and is not independently meaningful.

Compatibility between the CLI and its core dependency is recorded by the lockfile and embedded in the Docker image; no separate compatibility matrix is maintained.

## Release Artifacts

Each release produces:

| Artifact       | Published to                   | Tag / name                                                               |
| -------------- | ------------------------------ | ------------------------------------------------------------------------ |
| Docker image   | Docker Hub (`vdorie/psi-link`) | `vdorie/psi-link:X.Y.Z`, `vdorie/psi-link:X.Y`, `vdorie/psi-link:latest` |
| GitHub Release | GitHub Releases                | Tag `vX.Y.Z`                                                             |
| Launchers      | GitHub Release assets          | `start-psilink.sh`, `Start-Psilink.ps1`, `Setup-PsilinkFileDrop.ps1`     |
| Build provenance | GitHub attestation store     | Subject `docker.io/vdorie/psi-link` at the released manifest digest      |

The single `vdorie/psi-link` image carries both the CLI and the web console appliance; which role it runs is decided by its first argument (see [DEPLOYMENT.md](DEPLOYMENT.md#docker-deployment)).

The hosted web deployment (`apps/web`) is a separate deployment to its hosting environment as part of CI/CD; it is not this image and is not distributed as a versioned artifact.

A FIPS variant image (`Dockerfile.fips`) is built and smoke-tested on every pull request that can affect it and is published nowhere, so no `-fips` tag exists to pull. What it is, what may be claimed of it, and what has to land before it is published are in [fips-variant-image.md](notes/fips-variant-image.md).

The three launcher files are the host-side front door an operator runs to open the console: `start-psilink.sh` for macOS and Linux, `Start-Psilink.ps1` for Windows, and `Setup-PsilinkFileDrop.ps1`, which the Windows one dot-sources for its path resolution, credential prompts and network-share volume, and which must sit beside it. They travel as one unit; see [Stamped launchers](#stamped-launchers) for what a release does to them.

`@psilink/core` is not currently published to the npm registry. If that changes, add an npm row to the table above.

## Stamped launchers

A launcher is plaintext an operator reads before running, and it names the image by digest rather than by a floating tag, so a release copy runs exactly the manifest this release signed. The digest is not in the repository: each launcher carries a placeholder line, and the release workflow fills it in.

**What gets stamped.** One line per launcher, replaced whole:

| File | Line the release rewrites |
| ---- | ------------------------- |
| `start-psilink.sh` | `PSILINK_IMAGE_DIGEST='@@PSILINK_IMAGE_DIGEST@@'` |
| `Start-Psilink.ps1` | `$PsilinkImageDigest = '@@PSILINK_IMAGE_DIGEST@@'` |

The value substituted is `steps.build.outputs.digest` from the image build -- the manifest-list digest, the same value [step 8](#8-build-and-publish-the-container-image-ci) signs with Cosign. Each launcher also names the repository in full, `docker.io/vdorie/psi-link`, because podman requires the registry prefix and docker accepts it.

**What holds the seam together.** The workflow refuses the release if a launcher does not carry its placeholder line exactly once, and again if a placeholder survives the substitution, so a reworded line cannot make the stamp silently no-op. `npm run test:scripts` pins the same two lines from the repository side, in both the launchers and the workflow. A copy that reaches an operator unstamped refuses to run and says where a release copy comes from, rather than falling back to a tag.

**What a release publishes.** The `launchers` job attaches the two stamped files plus `Setup-PsilinkFileDrop.ps1` -- unstamped, and the one `Start-Psilink.ps1` dot-sources -- as assets on the release for this tag, creating it as a draft if the tag has none yet. That job is the only one in the workflow holding `contents: write`.

**How an organisation verifies a copy.** The digest a launcher carries is a claim about which image it will run; Cosign is what makes it checkable. Read the digest out of the launcher and verify the signature over that exact reference:

```sh
grep PSILINK_IMAGE_DIGEST start-psilink.sh
cosign verify --key cosign.pub docker.io/vdorie/psi-link@sha256:...
```

A digest that verifies is the image the maintainer signed. `cosign.pub` is the public signing key at the repository root. Verify by digest when the reference comes from a launcher, as here; verify by tag when it comes from the release notes (see [Verifying a Release](#verifying-a-release)).

## Release Checklist

Work through these steps for every release. Steps marked with `[CI]` are automated; the remainder require a maintainer.

### 1. Prepare the release branch

```sh
git checkout staging
git pull
git checkout -b release/vX.Y.Z
```

### 2. Update versions

Set the release version, following the policy in [Versioning](#versioning):

- `apps/cli/package.json` -- to `X.Y.Z`; it is the canonical release version.
- `packages/core/package.json` -- only if the core library changed in this release, bumped to its own next version (it versions independently of the CLI, so this need not equal `X.Y.Z`).
- `apps/web/package.json` and the root `package.json` -- leave unchanged; neither carries a release version.

### 3. Update CHANGELOG.md

Rename the `[Unreleased]` section to `[X.Y.Z] - YYYY-MM-DD`. Open a new empty `[Unreleased]` section above it. Security fixes must be called out in a `### Security` subsection. The `[Unreleased]` entries should already be reader-facing one-liners (see [CONTRIBUTING.md](../CONTRIBUTING.md), Changelog); tighten or drop any that drifted before cutting the release.

### 4. Review and audit dependencies

```sh
npm audit --omit=dev -w packages/core -w apps/cli -w apps/web
```

Resolve any high-severity findings before proceeding. For any dependency added since the last release, verify license compatibility (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

The unscoped `npm audit` additionally reports development-tree findings, which are triaged separately rather than at release time; how the last one was resolved, and what holds it resolved, is recorded in [DEPENDENCY_PINS.md](spec/DEPENDENCY_PINS.md#the-brace-expansion-advisory-is-fixed-by-a-root-override).

### 5. Run the full test suite

Run what CI gates, rather than a copy of it that drifts: `.github/workflows/static_checks.yaml` is the source of truth for the static checks (typecheck, format, lint, the link and claim checks, and the script suite), `.github/workflows/eb_build_and_test.yaml` for the browser integration suite, and `.github/workflows/cli_build_and_test.yaml` -- the CLI's pull-request gate -- for the CLI's unit and SFTP integration suites, whose integration half also runs in `release.yaml` as the ship gate before publish. Everything they run must pass on the release branch before it merges.

### 6. Open and merge the release PR

Open a pull request from `release/vX.Y.Z` to `main`. The PR title should be `Release vX.Y.Z`. Include a summary of changes (copy from CHANGELOG). Require at least one review before merging.

### 7. Tag the release

After the PR merges to `main`:

```sh
git checkout main
git pull
git tag -s vX.Y.Z -m "PSI-Link vX.Y.Z"
git push origin vX.Y.Z
```

### 8. Build and publish the container image `[CI]`

The `vX.Y.Z` tag push in step 7 triggers `.github/workflows/release.yaml`, which builds the multi-platform image and pushes it to Docker Hub, signs it with Cosign, attests its build provenance (see [Build provenance](#build-provenance)), and then stamps and attaches the launchers (see [Stamped launchers](#stamped-launchers)). Ahead of the build it checks the pushed tag against the version step 2 set in `apps/cli/package.json` and fails the release when the two disagree: the image build bakes that version into the console's partner accept kit, so a tag pushed ahead of the bump would publish an image telling the partner to run the release before it. Ensure the `DOCKER_USERNAME` and `DOCKER_TOKEN` repository secrets are set before tagging.

If you must build and push by hand -- for a workflow outage or a local test -- follow the multi-platform buildx instructions in `apps/cli/README.md` (creating `multiarch-builder` and running `docker buildx build --push` from the repository root).

### 9. Generate and attach the SBOM

From the workspace root:

```sh
npm sbom --sbom-format cyclonedx --package-lock-only --omit=dev -w packages/core -w apps/cli -w apps/web > psilink-X.Y.Z.cdx.json
```

`--omit=dev` stays: `apps/web`'s build tools are `devDependencies` and are not shipped. See [SBOM](#software-bill-of-materials-sbom) for the scoping rationale.

**This command currently fails** with `ESBOMPROBLEMS` on an unsatisfiable `crossws` peer range. It is an upstream prerelease conflict that clears without action here, and the local workarounds cost more than the BOM is worth; the diagnosis, the rejected fixes, and what to re-check after a `@tanstack/*` or `nitropack` bump are in [DEPENDENCY_PINS.md](spec/DEPENDENCY_PINS.md#the-crossws-peer-conflict-blocks-the-release-sbom). Re-run the command and delete these three paragraphs once the `crossws` peer range resolves.

If a release cannot wait for that to clear, drop `-w apps/web`:

```sh
npm sbom --sbom-format cyclonedx --package-lock-only --omit=dev -w packages/core -w apps/cli > psilink-X.Y.Z.cdx.json
```

The conflict lives under `apps/web`, and the validity check is scoped to the selected workspaces, so this still generates. It covers the shipped CLI image's runtime tree in full, including every dependency the [Dependency Policy](../CONTRIBUTING.md#dependency-policy) names -- `@openmined/psi.js`, `@noble/curves`, `re2js`, `ssh2` and `ssh2-sftp-client`. What it omits is the web console's runtime set (the Nitro `.output`), so a release attaching this BOM must say so rather than let it read as complete.

Do not reach for `@cyclonedx/cyclonedx-npm --ignore-npm-errors` as the workaround. It does produce a BOM despite the conflict, but run over this workspace it silently omits `@openmined/psi.js` -- the vendored crypto addon, and the entry a security SBOM most needs -- along with the rest of the workspace packages' trees. A BOM that looks complete and is missing the crypto dependency is worse than a scoped one that says what it left out.

### 10. Publish the GitHub Release

Step 8 leaves a draft release for tag `vX.Y.Z` carrying the stamped launchers. Open it, copy the CHANGELOG section for this version as the release body, attach `psilink-X.Y.Z.cdx.json`, record the Docker image digest from step 8 in the release notes, and publish. Leave the launcher assets in place: they are the copy an operator downloads.

### 11. Merge back to staging

```sh
git checkout staging
git merge main
git push origin staging
```

## Hotfix Releases

For security fixes or critical bugs in an already-released version:

1. Branch from the affected release tag: `git checkout -b hotfix/vX.Y.Z+1 vX.Y.Z`.
2. Apply the fix with a minimal, focused commit.
3. Follow steps 3 through 11 above, incrementing only the PATCH component.
4. If the vulnerability affects the previous major version as well (see [SECURITY.md](../SECURITY.md)), apply the fix there too before proceeding.

## Verifying a Release

### Container image

The container image digest for each release is recorded in the GitHub Release notes. Verify with:

```sh
docker pull vdorie/psi-link:X.Y.Z
docker inspect --format '{{index .RepoDigests 0}}' vdorie/psi-link:X.Y.Z
```

Compare the digest against the value in the release notes.

Each release image is also signed with Cosign using a key-based signature. This verifies by tag, which is the right form when the reference comes from the release notes; a reference read out of a stamped launcher is verified by digest instead (see [Stamped launchers](#stamped-launchers)). To verify:

```sh
cosign verify --key cosign.pub vdorie/psi-link:X.Y.Z
```

`cosign.pub` is the public signing key at the repository root. Install Cosign before running this command (see the Cosign documentation for your platform).

### Build provenance

The Cosign signature answers who published the image; the SLSA build provenance attestation answers how it was built -- which source repository and commit the build ran from, and which workflow produced it. They are complementary rather than alternatives, so verify both.

The release workflow attests the manifest-list digest, the same digest Cosign signs and the launchers carry, and stores the attestation against this repository. Verify by digest:

```sh
docker pull vdorie/psi-link:X.Y.Z
docker inspect --format '{{index .RepoDigests 0}}' vdorie/psi-link:X.Y.Z
gh attestation verify oci://docker.io/vdorie/psi-link@sha256:... \
  --repo georgetown-mdi/jspsi \
  --signer-workflow georgetown-mdi/jspsi/.github/workflows/release.yaml
```

The subject is recorded as `docker.io/vdorie/psi-link`, the same reference the Cosign step signs under. Neither the attest step nor this verify command has been driven against a published release yet, and reference canonicalization is the untested edge: if verification reports no matching attestation for an image that is certainly attested, check the reference host first -- Docker Hub's OCI-canonical name is `index.docker.io`, and the first real release is what settles whether the alias matches.

Notes on the command:

- It needs the [GitHub CLI](https://cli.github.com/) (`gh`), not Cosign. `cosign verify-attestation` reads attestations Cosign attached to the image in the registry; this one is held by GitHub, and `gh` fetches it from there rather than from Docker Hub.
- `--signer-workflow` is what makes the check specific: `--repo` alone is satisfied by any attestation this repository produced, from any workflow in it.
- The attested subject is the multi-platform manifest list, which is what the release publishes and what the digest above resolves to. A per-architecture digest read out of that index is not itself an attested subject.

What the attestation is and is not evidence of, for an agency assessment, is in [COMPLIANCE.md#release-integrity](COMPLIANCE.md#release-integrity).

### Source integrity

Release tags are signed with the maintainer's SSH key. The public key fingerprint is:

```
SHA256:gILsiGXszofEYqaCjXtCFuUzIw+cZDK0WrlCGd6fohM (RSA, vdorie@gmail.com)
```

To verify, point git at the `allowed_signers` file in the repository root, then verify the tag:

```sh
git config gpg.ssh.allowedSignersFile allowed_signers
git verify-tag vX.Y.Z
```

## Software Bill of Materials (SBOM)

An SBOM in CycloneDX format is generated as part of the release checklist (step 9) and attached to each GitHub Release. The `--omit=dev -w packages/core -w apps/cli -w apps/web` scoping covers everything the shipped image runs rather than the whole workspace: the CLI role's production tree (`packages/core` and `apps/cli`, matching the Dockerfile's runtime `npm ci --omit=dev -w packages/core -w apps/cli`) plus the web console's runtime dependencies, which ship bundled into the Nitro `.output` the image copies. `--omit=dev` excludes devDependencies (`apps/web`'s build tools among them), which the image does not ship. Because the `.output` is tree-shaken, the `apps/web` entry is a superset of what actually ships -- acceptable for a security SBOM. Because both the SBOM and the image resolve from the same committed lockfile, every dependency it does list appears at the exact resolved version the image runs. The one known residual: `npm sbom` omits a small number of packages that are hoisted to a single `node_modules` entry shared with a dev-only consumer elsewhere in the workspace (for example `yaml` and `tslib`, both installed in the shipped tree but currently absent from the SBOM's component list) -- confirm against `npm ls <pkg> --omit=dev -w packages/core -w apps/cli -w apps/web` if a specific package's presence in the image needs checking and it is missing from the SBOM. See `docs/spec/DEPENDENCY_PINS.md`.
