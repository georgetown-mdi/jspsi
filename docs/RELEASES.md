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

Packages version independently. `apps/cli/package.json` is the canonical release version: Docker image tags and GitHub Release tags reflect the CLI version. `packages/core` (and any future sub-packages) version independently — a patch to the core library does not require a CLI release unless the CLI itself is also affected. `apps/web` is continuously deployed and carries no release version. The root `package.json` version is a monorepo workspace marker and is not independently meaningful.

Compatibility between the CLI and its core dependency is recorded by the lockfile and embedded in the Docker image; no separate compatibility matrix is maintained.

## Release Artifacts

Each release produces:

| Artifact         | Published to                   | Tag / name                                                               |
| ---------------- | ------------------------------ | ------------------------------------------------------------------------ |
| CLI Docker image | Docker Hub (`vdorie/psi-link`) | `vdorie/psi-link:X.Y.Z`, `vdorie/psi-link:X.Y`, `vdorie/psi-link:latest` |
| GitHub Release   | GitHub Releases                | Tag `vX.Y.Z`                                                             |

The web application is deployed to its hosting environment as part of CI/CD; it is not distributed as a versioned artifact.

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

Update the version field in each `package.json` to `X.Y.Z`:

- `package.json` (root)
- `packages/core/package.json`
- `apps/cli/package.json`
- `apps/web/package.json`

### 3. Update CHANGELOG.md

Rename the `[Unreleased]` section to `[X.Y.Z] - YYYY-MM-DD`. Open a new empty `[Unreleased]` section above it. Security fixes must be called out in a `### Security` subsection.

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
docker compose -f apps/cli/test/container/compose.yaml up -d
npm run test:integration -w apps/cli
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

### 8. Build and publish the container image

```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag vdorie/psi-link:X.Y.Z \
  --tag vdorie/psi-link:X.Y \
  --tag vdorie/psi-link:latest \
  --push .
```

This step is automated by `.github/workflows/release.yaml`, which triggers on any `vX.Y.Z` tag push. Ensure the `DOCKER_USERNAME` and `DOCKER_TOKEN` repository secrets are set before tagging.

### 9. Generate and attach the SBOM

From the workspace root:

```sh
npm sbom --sbom-format cyclonedx --package-lock-only > psilink-X.Y.Z.cdx.json
```

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

An SBOM in CycloneDX format is generated as part of the release checklist (step 9) and attached to each GitHub Release. It lists every direct and transitive dependency with versions and licenses, making it straightforward for downstream users to audit their exposure when a vulnerability is announced in a dependency.
