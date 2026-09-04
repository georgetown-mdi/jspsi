---
title: "Release Process"
---

# Release Process

This document describes how psilink releases are prepared, tagged, and published.

## Versioning

psilink uses [semantic versioning](https://semver.org/) (MAJOR.MINOR.PATCH):

- **PATCH**: backwards-compatible bug fixes, documentation updates, dependency patches.
- **MINOR**: backwards-compatible new features or new configuration fields. Exchange specification files written for an earlier MINOR version of the same MAJOR must continue to work.
- **MAJOR**: breaking changes to the exchange protocol, configuration schema, or CLI interface. A MAJOR bump means existing key files or exchange specs may need to be updated.

`apps/cli/package.json` is the canonical release version: Docker image tags and GitHub Release tags reflect the CLI version. The console baked into that image (`apps/web`, run via `serve`) is versioned to the CLI version along with the rest of the image; the hosted `apps/web` deployment has no release version of its own. `packages/core` (and any future sub-packages) version independently -- a patch to the core library does not require a CLI release unless the CLI itself is also affected. The hosted `apps/web` deployment is continuously deployed and has no release version. The root `package.json` version is a monorepo workspace marker and is not independently meaningful.

Compatibility between the CLI and its core dependency is recorded by the lockfile and embedded in the Docker image; no separate compatibility matrix is maintained.

Nothing has been published yet: the canonical release version is still the pre-publication `0.1.0`, and every in-repo version literal holds at its pre-publication footing -- the footing itself, and what ends it, is specified in `docs/spec/PROTOCOL.md` (Wire-format deltas) and enforced by the release checks below.

## Release Artifacts

Each release produces:

| Artifact       | Published to                   | Tag / name                                                               |
| -------------- | ------------------------------ | ------------------------------------------------------------------------ |
| Docker image   | Docker Hub (`vdorie/psi-link`) | `vdorie/psi-link:X.Y.Z`, `vdorie/psi-link:X.Y`, `vdorie/psi-link:latest` |
| FIPS variant image | Docker Hub (`vdorie/psi-link`) | `vdorie/psi-link:X.Y.Z-fips`, `vdorie/psi-link:X.Y-fips`, `vdorie/psi-link:latest-fips` |
| GitHub Release | GitHub Releases                | Tag `vX.Y.Z`                                                             |
| Launchers      | GitHub Release assets          | `start-psilink.sh`, `Start-Psilink.ps1`, `Setup-PsilinkFileDrop.ps1`     |
| Build provenance | GitHub attestation store     | Subject `docker.io/vdorie/psi-link`, one attestation per released manifest digest |

Each image contains both the CLI and the console; which role it runs is decided by its first argument (see [DEPLOYMENT.md](DEPLOYMENT.md#docker-deployment)). Both run unprivileged as uid 1000, take the same arguments, and speak the same protocol, so a partner on one can exchange with a partner on the other.

The hosted web deployment (`apps/web`) is a separate deployment to its hosting environment as part of CI/CD; it is not this image and is not distributed as a versioned artifact.

## Which image has which posture

The two tags differ in one thing: what serves the cryptography underneath `crypto.subtle`.

- **`vdorie/psi-link:X.Y.Z`** -- the default artifact, built on `node:26-alpine`. It embeds no validated cryptographic module and the project claims none for it. Take this one unless a FIPS obligation says otherwise: it is smaller, its SFTP support is unrestricted, and it is the image the launchers and the Windows file-drop setup scripts pull.
- **`vdorie/psi-link:X.Y.Z-fips`** -- built on Amazon Linux 2023 and containing the CMVP-validated OpenSSL FIPS provider AWS publishes for that distribution, so psilink's `crypto.subtle` calls dispatch into that module. It costs roughly 1.8x the size, and by default it cannot reach an SFTP server that offers only `curve25519` key exchange, only the `chacha20-poly1305@openssh.com` cipher, or only an Ed25519 host key.

**What the FIPS variant does and does not support a claim of** is in [COMPLIANCE.md](COMPLIANCE.md#fips-140), which is the single place this project states it: the certificate, the module version, the environments that certificate covers, and what stays outside the module either way. Two bounds matter here as well, because they decide whether pulling this tag is worth anything to a given deployment:

- The image does not put the host in FIPS mode and cannot. The operational environment is the host plus the runtime plus the image together, and supplying a host in FIPS mode is the operator's.
- The PSI masking itself runs in BoringSSL inside a vendored WebAssembly module, which no OpenSSL provider reaches. That is permanent rather than a gap this image closes.

The variant reports both facts it can observe -- whether its own crypto is being served by that module, and what the host kernel's FIPS mode is -- on stderr at every container start, and warns rather than refusing when either answer is not what a claim needs.

**Pulling and verifying it.** The variant is signed by the same release workflow, under the same Sigstore identity, so verification differs only in the reference:

```sh
docker pull vdorie/psi-link:X.Y.Z-fips
docker inspect --format '{{index .RepoDigests 0}}' vdorie/psi-link:X.Y.Z-fips
cosign verify \
  --certificate-identity-regexp '^https://github\.com/georgetown-mdi/jspsi/\.github/workflows/release\.yaml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  vdorie/psi-link:X.Y.Z-fips
```

Both `--certificate-` arguments are required and each does its own work; [Verifying a Release](#verifying-a-release) explains what they pin and how to verify the build provenance attestation, which the variant also gets.

**Confirming the module inside it.** A signature says which build this is, not what is running in it. Run the image and read its first two stderr lines:

```sh
docker run --rm vdorie/psi-link:X.Y.Z-fips --help
```

A run whose crypto is being served by the module reports `FIPS provider active`, naming the baked-in module version when `FIPS_MODULE_VERSION` is intact in the container's environment and saying plainly that it cannot name one when that variable was cleared or overridden at start; anything else is a warning naming what the startup probe found instead. The host kernel's FIPS-mode line is separate and is reported the same way. Neither line is parsed from `openssl list`: the probe is a Node process making psilink's own call shapes under the image's configuration, and its exit status is the whole verdict.

What the variant is, what may and may not be said about it, the three deployment tiers a claim has to keep apart, and the measured list of what does not work in it are in [fips-variant-image.md](notes/fips-variant-image.md); its pins and the checks that hold them are in [CONTAINER_IMAGES.md](spec/CONTAINER_IMAGES.md).

The three launcher files are the host-side front door an operator runs to open the console: `start-psilink.sh` for macOS and Linux, `Start-Psilink.ps1` for Windows, and `Setup-PsilinkFileDrop.ps1`, which the Windows one dot-sources for its path resolution, credential prompts and network-share volume, and which must sit beside it. They travel as one unit; see [Stamped launchers](#stamped-launchers) for what a release does to them.

`@psilink/core` is not currently published to the npm registry. If that changes, add an npm row to the table above.

## Stamped launchers

A launcher is plaintext an operator reads before running, and it names the image by digest rather than by a floating tag, so a release copy runs exactly the manifest this release signed. The digest is not in the repository: each launcher has a placeholder line, and the release workflow fills it in.

**What gets stamped.** One line per launcher, replaced whole:

| File | Line the release rewrites |
| ---- | ------------------------- |
| `start-psilink.sh` | `PSILINK_IMAGE_DIGEST='@@PSILINK_IMAGE_DIGEST@@'` |
| `Start-Psilink.ps1` | `$PsilinkImageDigest = '@@PSILINK_IMAGE_DIGEST@@'` |

The value substituted is `steps.build.outputs.digest` from the image build -- the manifest-list digest, the same value [step 8](#8-build-and-publish-the-container-image-ci) signs with Cosign. Each launcher also names the repository in full, `docker.io/vdorie/psi-link`, because podman requires the registry prefix and docker accepts it.

**What keeps the launcher and the workflow in step.** The workflow refuses the release if a launcher does not contain its placeholder line exactly once, and again if a placeholder survives the substitution, so a reworded line cannot make the stamp silently no-op. `npm run test:scripts` pins the same two lines from the repository side, in both the launchers and the workflow. A copy that reaches an operator unstamped refuses to run and says where a release copy comes from, rather than falling back to a tag.

**What a release publishes.** The `launchers` job attaches the two stamped files plus `Setup-PsilinkFileDrop.ps1` -- unstamped, and the one `Start-Psilink.ps1` dot-sources -- as assets on the release for this tag, creating it as a draft if the tag has none yet. That job is the only one in the workflow holding `contents: write`.

**How an organisation verifies a copy.** The digest a launcher names is a claim about which image it will run; Cosign is what makes it checkable. Read the digest out of the launcher and verify the signature over that exact reference:

```sh
grep PSILINK_IMAGE_DIGEST start-psilink.sh
cosign verify \
  --certificate-identity-regexp '^https://github\.com/georgetown-mdi/jspsi/\.github/workflows/release\.yaml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  docker.io/vdorie/psi-link@sha256:...
```

A digest that verifies is the image the official release workflow published. The two `--certificate-` arguments are what make that specific, and both are required; [Verifying a Release](#verifying-a-release) explains what they pin. Verify by digest when the reference comes from a launcher, as here; verify by tag when it comes from the release notes.

## Image vulnerability scan

Every release image is scanned for OS-layer vulnerabilities before it is published. The release workflow builds each image single-arch, scans it, and only then authenticates to Docker Hub and pushes, so an image the workflow published is an image that passed the scan. Both gates sit ahead of the login, so a finding against either image stops the whole release rather than publishing one artifact and withholding the other. The hand-built push in [step 8](#8-build-and-publish-the-container-image-ci) is the one path around that.

**What the gate is.** Trivy, over the image's OS package layer, failing the release on a vulnerability that is HIGH or CRITICAL _and_ has a fix available. An unfixable finding does not block a release: a gate that fires on something no bump can resolve is unactionable and ends up switched off. The npm dependency tree is covered separately -- by Dependabot, the [dependency review workflow](../.github/workflows/dependency_review.yaml), and [step 4](#4-review-and-audit-dependencies) below -- so this gate does not reach it by design.

**Where the threshold lives.** On the scan step itself, as literal inputs: `.github/workflows/release.yaml` for this gate and `.github/workflows/image_smoke.yaml` for the pre-merge one. Accepted exceptions are in `.github/trivyignore.yaml`, each vulnerability id with the reason it was accepted and an `expired_at` date. Trivy stops applying an entry on that date and the finding returns to the gate, so an acceptance that outlives the condition it was written for re-reds the weekly scan rather than standing unread.

**What a finding means.** Each base image is pinned by digest by design (see [DEPENDENCY_PINS.md](spec/DEPENDENCY_PINS.md)), so a finding is a prompt to bump that pin rather than something a dependency update resolves. Edit the digest in `Dockerfile` or `Dockerfile.fips` -- on the variant, its Amazon Linux release snapshot moves with the digest, the two being one release rather than two compatible ones -- let the pre-merge scan confirm the new base on that pull request, then tag.

**When it runs.** On every pull request that can change either image, on a weekly schedule against a refreshed vulnerability database, and again in the release workflow ahead of the push. The scheduled run is the one that catches a vulnerability published against a base image nothing in this repository has touched. Pull-request and scheduled findings appear as code-scanning alerts in the repository Security tab, one category per image; the release gate reports on the run's summary page, one section per image.

**What it does not cover.** It reads the amd64 build, while a release publishes amd64 and arm64 for both images; each comes from the same digest-pinned base and the same committed lockfile, so the package set it reads is the one that ships, but a vulnerability in an architecture-specific binary alone is outside it.

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
- `apps/web/package.json` and the root `package.json` -- leave unchanged; neither has a release version.

The canonical release version is also what arms the wire-format pin. `npm run check:protocol-version-bump` is inert while it names `0.1.0` or below; the first release above that publishes deployed peers, so the check asks for the pin covering what the linkage rounds put on the wire and prints the block to record in `scripts/protocol-version-pins.json`. From that release onward, a change to that wire format takes a `PROTOCOL_VERSION` bump with its own pin recorded beside the earlier ones -- see [PROTOCOL.md](spec/PROTOCOL.md#wire-format-deltas-existing-frames-only-and-no-version-bump).

#### Reset the exchange-record format at first publication

`EXCHANGE_RECORD_VERSION` is an internal development counter, cycled freely because no published artifact contains any of its literals. The first release above `0.1.0` ships it reset to `psilink-exchange-record/v1`, and `npm run check:exchange-record-reset` -- armed by the same marker -- fails from that release until the reset is taken. Take it as one piece:

1. Set `EXCHANGE_RECORD_VERSION` to `psilink-exchange-record/v1` in `packages/core/src/exchangeRecord.ts`.
2. Regenerate the record vectors through their generator, `packages/core/test/vectors/generate-exchange-record-vectors.mjs`; `npm run check:vectors` holds every vectors file to its generator.
3. Discharge the obligations `scripts/check-disclosure-recovery.mjs` names -- it fails on its own once the literal moves -- and re-record its `RECORD_VERSION_PIN`.
4. Clear the development artifacts below, then record the reset: set `RESET_TAKEN_AT_RELEASE` to `X.Y.Z` in `scripts/check-exchange-record-reset.mjs`. That retires the rule, so an ordinary forward bump after this release is not held to `v1`.

**Clearing development artifacts.** This reset moves the literal downward, and a leftover artifact the counter numbered on its way up is misread rather than refused. Two classes can hold one, and no released artifact is among them: `packages/core/src/exchangeRecord.ts` does not exist at `v0.1.0`, so nothing published contains a `psilink-exchange-record/vN` literal at all.

- **Browser-stored managed accountings** -- the `disclosures` store of the `psilink-managed-exchanges` IndexedDB database, on any browser that ran a development build of the web app. An entry naming a higher ordinal than the build is treated as a stale page, whose remedy is a reload that cannot help and which withholds the export-then-reset recovery by design (see [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#what-an-exchange-record-version-bump-does-to-a-stored-accounting)). Clear the site data for the app's origin on those devices.
- **CLI record files on disk** -- `psilink-record-<timestamp>.json` and the `.keys.json` beside it, wherever a development build wrote one. One numbered above the reset value is refused on the version with the file still in the operator's hands; one written back when the counter itself read `v1` is not, and parses as current before failing on its field set. Delete or archive pre-release record files.

### 3. Update CHANGELOG.md

Rename the `[Unreleased]` section to `[X.Y.Z] - YYYY-MM-DD`. Open a new empty `[Unreleased]` section above it. Security fixes must be called out in a `### Security` subsection. The `[Unreleased]` entries should already be reader-facing one-liners (see [CONTRIBUTING.md](../CONTRIBUTING.md), Changelog); tighten or drop any that drifted before cutting the release.

### 4. Review and audit dependencies

```sh
npm audit --omit=dev -w packages/core -w apps/cli -w apps/web
```

Resolve any high-severity findings before proceeding. For any dependency added since the last release, verify license compatibility (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

This covers the npm tree only. The image's OS package layer is gated separately, in CI, by the [image vulnerability scan](#image-vulnerability-scan).

The unscoped `npm audit` additionally reports development-tree findings, which are triaged separately rather than at release time; how the last one was resolved, and what holds it resolved, is recorded in [DEPENDENCY_PINS.md](spec/DEPENDENCY_PINS.md#the-brace-expansion-advisory-is-fixed-by-a-root-override).

A Dependabot alert in the repository's Security tab is evaluated against `main`, which routinely lags `staging` by dozens of commits, so an alert can still read as open against `main` after `staging` already has the fix -- check `staging`'s lockfile before triaging a default-branch alert. That check narrows the triage rather than closing it: a package `staging` has not yet patched still gets a full triage.

The same default-branch evaluation decides which `.github/dependabot.yml` Dependabot reads, so an `ignore` entry merged to `staging` suppresses no pull request until a promotion brings it to `main`, and a bump the entry names arrives anyway meanwhile. The evidence for that reading, what decides it, and how such a pull request is handled are in [DEPENDENCY_PINS.md](spec/DEPENDENCY_PINS.md#bumping-the-fips-base-image).

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

The `vX.Y.Z` tag push in step 7 triggers `.github/workflows/release.yaml`, which builds both multi-platform images and pushes them to Docker Hub, signs each with Cosign, attests each one's build provenance (see [Build provenance](#build-provenance)), and then stamps and attaches the launchers (see [Stamped launchers](#stamped-launchers)). The FIPS variant's three tags are the default image's three with `-fips` appended, derived from the pushed tag in the workflow itself. Ensure the `DOCKER_USERNAME` and `DOCKER_TOKEN` repository secrets are set before tagging.

**What has to pass before anything is pushed.** Each gate below runs before the workflow authenticates to Docker Hub, so a release that fails one publishes nothing at all:

- **The version check**, comparing the pushed tag against the version step 2 set in `apps/cli/package.json` and failing the release when the two disagree: the image build bakes that version into the console's partner accept kit, so a tag pushed ahead of the bump would publish an image telling the partner to run the release before it.
- **The vulnerability scans.** Each image is built single-arch, loaded, and scanned; neither is pushed if either scan fails (see [Image vulnerability scan](#image-vulnerability-scan)).
- **The FIPS engagement probe.** The loaded variant candidate runs the engagement probe it ships -- the same one its entrypoint runs at every container start, described under [Which image has which posture](#which-image-has-which-posture) -- so the engagement [COMPLIANCE.md](COMPLIANCE.md#fips-140) frames as measured rather than assumed is measured against the candidate this release publishes rather than against a pre-merge build. It reads the amd64 candidate; both published architectures resolve the same base pin, the same certified provider package, and the same committed lockfile.

The publish sequence signs each image immediately after its own push, verifies that signature with the same command and the same two `--certificate-` arguments this document publishes under [Verifying a Release](#verifying-a-release), and attests its build provenance -- all before the next image is built. A signature the published command cannot verify stops the release there, rather than reaching a partner as an image whose published check calls it untrusted. A failure between the two pushes -- and the variant's multi-arch build is exercised at release time only, the pre-merge smoke building it single-arch -- leaves the default tags moved while the `-fips` tags sit at the previous release, or are absent on the first: everything published is scanned, signed, and attested, but the floating tag pair diverges until the run is repaired. Recover by re-running the failed publish job once the cause is fixed; it rebuilds both images from the same commit and re-pushes the same tags, converging the pair.

If you must build and push by hand -- for a workflow outage or a local test -- follow the multi-platform buildx instructions in `apps/cli/README.md` (creating `multiarch-builder` and running `docker buildx build --push` from the repository root; the variant adds `-f Dockerfile.fips` and the `-fips` tags). A hand-built push bypasses the [image vulnerability scan](#image-vulnerability-scan) the workflow runs ahead of its own, and it bypasses Cosign: scan the image yourself before pushing it, at the threshold the workflow sets, and expect a hand-pushed tag to fail the verification commands below.

### 9. Generate and attach the SBOM

From the workspace root:

```sh
npm sbom --sbom-format cyclonedx --package-lock-only --omit=dev --legacy-peer-deps -w packages/core -w apps/cli -w apps/web > psilink-X.Y.Z.cdx.json
```

`--omit=dev` stays: `apps/web`'s build tools are `devDependencies` and are not shipped. See [SBOM](#software-bill-of-materials-sbom) for the scoping rationale.

`--legacy-peer-deps` works around an unsatisfiable `crossws` optional peer that otherwise makes the unflagged command refuse with `ESBOMPROBLEMS`; the diagnosis and the measurement behind adopting the flag are in [DEPENDENCY_PINS.md](spec/DEPENDENCY_PINS.md#the-crossws-peer-conflict-blocks-the-release-sbom). Its cost: this one invocation stops validating peer conflicts, so a genuine peer conflict elsewhere in the tree would be suppressed just as quietly. Run the compensating strict check alongside it, from the workspace root:

```sh
npm ls --all --omit=dev
```

This still fails loudly on a peer conflict the flagged `npm sbom` invocation no longer reports -- today, naming only the same `crossws` edge -- so a releaser reads a known, diagnosed failure rather than a surprise. A finding that names anything else stops the release.

Do not reach for `@cyclonedx/cyclonedx-npm --ignore-npm-errors` instead of the flag above. It does produce a BOM despite the conflict, but run over this workspace it silently omits `@openmined/psi.js` -- the vendored crypto addon, and the entry a security SBOM most needs -- along with the rest of the workspace packages' trees. A BOM that looks complete and is missing the crypto dependency is worse than one that states a limitation up front.

### 10. Publish the GitHub Release

Step 8 leaves a draft release for tag `vX.Y.Z` with the stamped launchers. Open it, copy the CHANGELOG section for this version as the release body, attach `psilink-X.Y.Z.cdx.json`, record both Docker image digests from step 8 in the release notes -- the default image's and the FIPS variant's, each beside its tag -- and publish. Leave the launcher assets in place: they are the copy an operator downloads.

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

For a hotfix answering a privately reported vulnerability, this section is the mechanics only. The sequencing around it -- keeping the fix out of public view until the release and the advisory land together, and what publishes alongside them -- is in [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md#4-fix-privately-then-release).

## Verifying a Release

### Container image

Both container image digests for each release are recorded in the GitHub Release notes. Verify with:

```sh
docker pull vdorie/psi-link:X.Y.Z
docker inspect --format '{{index .RepoDigests 0}}' vdorie/psi-link:X.Y.Z
```

Compare the digest against the value in the release notes. The FIPS variant is verified the same way, at `vdorie/psi-link:X.Y.Z-fips`; every command in this section takes either reference.

Each release image is also signed with Cosign, keylessly through Sigstore. The signature includes a short-lived certificate Fulcio issued against the release workflow's OIDC identity, and it is recorded in Rekor's public transparency log. There is no project-held signing key and no public key to fetch: what a verifier pins is the workflow that produced the signature. Why the signature is arranged that way, and what it does not decide, are in [cosign-keyless-signing.md](notes/cosign-keyless-signing.md).

This verifies by tag, which is the right form when the reference comes from the release notes; a reference read out of a stamped launcher is verified by digest instead (see [Stamped launchers](#stamped-launchers)). To verify:

```sh
cosign verify \
  --certificate-identity-regexp '^https://github\.com/georgetown-mdi/jspsi/\.github/workflows/release\.yaml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  vdorie/psi-link:X.Y.Z
```

Both `--certificate-` arguments are required, and each does its own work:

- `--certificate-identity-regexp` pins the signer. The certificate's identity is the workflow file's path in this repository plus the ref it ran from, so an anchored pattern refuses a signature produced by a different workflow here, by a branch run of this one, or by a fork.
- `--certificate-oidc-issuer` pins who vouched for that identity to GitHub Actions: verification compares the certificate's issuer for equality and refuses any mismatch, so a certificate from another issuer does not satisfy the check.

Omitting either, or loosening the pattern to something unanchored, accepts signatures a release did not produce.

**The release runs this command on itself.** Each published image is verified with these exact arguments, against the digest just signed, before the next image is built, so a release that completes is one whose signatures verified under the command above. Because the identity is made of the release workflow's own path and its tag trigger, a rename or a widened trigger would otherwise leave this command refusing a legitimate signature with nothing here to say so; `npm run check:release-signing` holds the pattern published here, the copy the workflow runs, and those two properties of the workflow to each other on every pull request.

Install Cosign before running this command (see the Cosign documentation for your platform). Behind a signature that verifies there is also a public Rekor transparency-log entry, which anyone can inspect independently of this project.

### Build provenance

The Cosign signature and the SLSA build provenance attestation are complementary rather than alternatives, so verify both. The signature establishes that the release workflow published this exact manifest, and travels with the image in the registry. The attestation establishes what the build consumed -- which source repository and commit it ran from, and which workflow produced it -- and is held by GitHub rather than by the registry.

The release workflow attests each manifest-list digest, the same digests Cosign signs and, for the default image, the one the launchers name, and stores both attestations against this repository. Verify by digest:

```sh
docker pull vdorie/psi-link:X.Y.Z
docker inspect --format '{{index .RepoDigests 0}}' vdorie/psi-link:X.Y.Z
gh attestation verify oci://docker.io/vdorie/psi-link@sha256:... \
  --repo georgetown-mdi/jspsi \
  --signer-workflow georgetown-mdi/jspsi/.github/workflows/release.yaml
```

Both subjects are recorded as `docker.io/vdorie/psi-link`, the same reference the Cosign step signs under; the two attestations are told apart by their digests, not by their subject names. Neither the attest step nor this verify command has been driven against a published release yet, and reference canonicalization is the untested edge: if verification reports no matching attestation for an image that is certainly attested, check the reference host first -- Docker Hub's OCI-canonical name is `index.docker.io`, and the first real release is what decides whether the alias matches.

Notes on the command:

- It needs the [GitHub CLI](https://cli.github.com/) (`gh`), not Cosign. `cosign verify-attestation` reads attestations Cosign attached to the image in the registry; this one is held by GitHub, and `gh` fetches it from there rather than from Docker Hub.
- `--signer-workflow` is what makes the check specific: `--repo` alone is satisfied by any attestation this repository produced, from any workflow in it. Its value is the release workflow's own path, so a rename would otherwise leave this command reporting no matching attestation for an image the release did attest; `npm run check:release-signing` holds the path published here to that workflow on every pull request, as it does the signature identity above.
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

An SBOM in CycloneDX format is generated as part of the release checklist (step 9) and attached to each GitHub Release.

- One BOM covers both published images: they resolve the same committed lockfile through the same production install, so their npm trees are identical and only their OS package layers differ -- which no `npm sbom` run reaches on either image, and which the [image vulnerability scan](#image-vulnerability-scan) covers separately.
- The `--omit=dev -w packages/core -w apps/cli -w apps/web` scoping covers everything a shipped image runs rather than the whole workspace: the CLI role's production tree (`packages/core` and `apps/cli`, which the Dockerfile installs as `npm ci --omit=dev --omit=optional -w packages/core -w apps/cli`, so this scoping is a superset of it by the optional edges) plus the web console's runtime dependencies, which ship bundled into the Nitro `.output` the image copies. `--omit=dev` excludes devDependencies (`apps/web`'s build tools among them), which the image does not ship. Because the `.output` is tree-shaken, the `apps/web` entry is a superset of what actually ships -- acceptable for a security SBOM.
- Because both the SBOM and the image resolve from the same committed lockfile, every dependency it does list appears at the exact resolved version the image runs.
- The one known residual: `npm sbom` omits a small number of packages that are hoisted to a single `node_modules` entry shared with a dev-only consumer elsewhere in the workspace (for example `yaml` and `tslib`, both installed in the shipped tree but currently absent from the SBOM's component list) -- confirm against `npm ls <pkg> --omit=dev -w packages/core -w apps/cli -w apps/web` if a specific package's presence in the image needs checking and it is missing from the SBOM.
- The superset also runs the other way: a devDependency of a source-only workspace that hoists to the root `node_modules` and satisfies another package's optional peer flips to `devOptional` and enters this graph without shipping (`tsx`, hoisted by `packages/peerjs-broker` and satisfying `vite`'s optional peer, is the known case).

See `docs/spec/DEPENDENCY_PINS.md`.

The release command also passes `--legacy-peer-deps` (see [step 9](#9-generate-and-attach-the-sbom)), which disables the invocation's peer-conflict validation but does not change which components the lockfile-only walk resolves or includes -- it only stops that walk from refusing on the one known conflict. See [DEPENDENCY_PINS.md](spec/DEPENDENCY_PINS.md#the-crossws-peer-conflict-blocks-the-release-sbom) for why the conflict exists and what the flag costs.
