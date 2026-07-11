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

`apps/cli/package.json` is the canonical release version: Docker image tags and GitHub Release tags reflect the CLI version. That single image now also carries the web console appliance (`apps/web`, baked in and run via `serve`), which is versioned to the CLI version along with the rest of the image -- the deliberate departure from `apps/web` otherwise carrying no release version. `packages/core` (and any future sub-packages) version independently -- a patch to the core library does not require a CLI release unless the CLI itself is also affected. The hosted `apps/web` deployment is continuously deployed and carries no release version. The root `package.json` version is a monorepo workspace marker and is not independently meaningful.

Compatibility between the CLI and its core dependency is recorded by the lockfile and embedded in the Docker image; no separate compatibility matrix is maintained.

## Release Artifacts

Each release produces:

| Artifact       | Published to                   | Tag / name                                                               |
| -------------- | ------------------------------ | ------------------------------------------------------------------------ |
| Docker image   | Docker Hub (`vdorie/psi-link`) | `vdorie/psi-link:X.Y.Z`, `vdorie/psi-link:X.Y`, `vdorie/psi-link:latest` |
| GitHub Release | GitHub Releases                | Tag `vX.Y.Z`                                                             |

The single `vdorie/psi-link` image carries both roles: it runs headless as the CLI by default (`docker run ... vdorie/psi-link exchange ...`) and, when its first argument is `serve`, as the single-party web console appliance (`docker run ... vdorie/psi-link serve`). See [DEPLOYMENT.md](DEPLOYMENT.md#docker-deployment) for running each role.

The hosted web deployment (`apps/web`) is a separate deployment to its hosting environment as part of CI/CD; it is not this image and is not distributed as a versioned artifact.

`@psilink/core` is not currently published to the npm registry. If that changes, add an npm row to the table above.

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
npm audit
```

Resolve any high-severity findings before proceeding. For any dependency added since the last release, verify license compatibility (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

### 5. Run the full test suite

```sh
npm run build
npm test -w packages/core
npm test -w apps/cli
npm run test:unit -w apps/web
npm run test:integration -w apps/cli     # self-manages its SFTP test server
```

All tests must pass. Lint must be clean (`npm run lint`).

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

The `vX.Y.Z` tag push in step 7 triggers `.github/workflows/release.yaml`, which builds the multi-platform image and pushes it to Docker Hub. Ensure the `DOCKER_USERNAME` and `DOCKER_TOKEN` repository secrets are set before tagging.

If you must build and push by hand -- for a workflow outage or a local test -- follow the multi-platform buildx instructions in `apps/cli/README.md` (creating `multiarch-builder` and running `docker buildx build --push` from the repository root).

### 9. Generate and attach the SBOM

From the workspace root:

```sh
npm sbom --sbom-format cyclonedx --package-lock-only --omit=dev -w packages/core -w apps/cli -w apps/web > psilink-X.Y.Z.cdx.json
```

The image now bundles `apps/web`'s runtime dependencies into the Nitro `.output`, so the SBOM includes `apps/web`. That `.output` is a tree-shaken subset, so the `apps/web` entry is a superset of what actually ships -- acceptable for a security SBOM, which errs toward listing more. `--omit=dev` stays: `apps/web`'s build tools are `devDependencies` and are not shipped.

### 10. Publish the GitHub Release

Create a GitHub Release for tag `vX.Y.Z`. Copy the CHANGELOG section for this version as the release body. Attach `psilink-X.Y.Z.cdx.json` and record the Docker image digest from step 8 in the release notes.

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

Each release image is also signed with Cosign using a key-based signature. To verify:

```sh
cosign verify --key cosign.pub vdorie/psi-link:X.Y.Z
```

`cosign.pub` is the public signing key at the repository root. Install Cosign before running this command (see the Cosign documentation for your platform).

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
