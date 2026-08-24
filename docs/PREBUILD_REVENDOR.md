---
title: "Re-vendoring the Native PSI Prebuild"
---

# Re-vendoring the native PSI prebuild

The PSI addon `@openmined/psi.js` is not installed from a registry. It is built
by the fork [`georgetown-mdi/OpenMinedPSI`](https://github.com/georgetown-mdi/OpenMinedPSI)
and copied into this repository as `lib/openmined-psi.js-<version>.tgz`, a
`file:` dependency. This is the procedure for replacing those bytes, and the
steps a reviewer performs to establish where they came from.

The tarball carries native `.node` addons that are loaded into the process with
full privilege and run the PSI crypto, so its chain of custody is the point of
this document, not a formality.

## The two controls

| Control | What it proves | What it needs |
| --- | --- | --- |
| `lib/<tarball>.sha256` | The bytes in the tree are the bytes the commit intended: no truncated checkout, corrupt download, or half-finished re-vendor | `sha256sum` alone -- no network, no token |
| `lib/<tarball>.provenance.json` plus `gh attestation verify` | The bytes came out of a named workflow run in the fork, at a named commit | Network, a GitHub token, and `gh` |

The sidecar cannot do the provenance job: it is committed alongside the bytes it
describes, so whoever writes one writes the other. The attestation lives in the
fork's attestation store, outside any psilink commit, which is why it closes the
hop the sidecar cannot. Field-by-field format, the exact verifier invocation,
and what arms it: [DEPENDENCY_PINS.md](spec/DEPENDENCY_PINS.md#the-vendored-openminedpsijs-addon).

## Arming state

Verification is armed per vendored tarball by `attestation_expected` in its
provenance marker.

- **Disarmed** (`false`): CI reports the state as a warning annotation on every
  run and passes. The sidecar is the whole control.
- **Armed** (`true`): CI runs `gh attestation verify` against the recorded fork
  repository, signer workflow, and source commit, and any non-zero exit fails
  the build.

The marker itself is not optional in either state. CI fails if it is missing or
malformed, and it holds the recorded digest against the tarball's real bytes
whichever way the switch is set. Turning verification off is therefore a visible
`true` -> `false` edit in a tracked file, not a deletion that looks like nothing.

Arming requires the producing workflow to attest the artifact. Until the fork's
`native-prebuilds.yml` runs `actions/attest-build-provenance` with `id-token:
write` and `attestations: write`, there is nothing to verify and the marker
stays disarmed.

## Procedure

Run the fork's `Native prebuilds` workflow (`workflow_dispatch`) and note the
run's commit. Then, from a branch in this repository:

1. **Download the tarball** from the run's `openmined-psi-tarball` artifact into
   `lib/`, and delete the tarball it replaces along with its `.sha256` and
   `.provenance.json`.

2. **Verify provenance before anything else records the new digest.** This
   ordering matters: a sidecar written first is a hash over unverified bytes.

   ```sh
   gh attestation verify lib/openmined-psi.js-<version>.tgz \
     --repo georgetown-mdi/OpenMinedPSI \
     --signer-workflow georgetown-mdi/OpenMinedPSI/.github/workflows/native-prebuilds.yml \
     --source-ref refs/heads/master \
     --source-digest <fork commit the run built> \
     --predicate-type https://slsa.dev/provenance/v1 \
     --deny-self-hosted-runners
   ```

   If the fork does not attest yet, this returns HTTP 404 for the digest. That
   is the disarmed case: record it in the pull request and leave the marker's
   `attestation_expected` at `false`.

3. **Write the provenance marker** `lib/<tarball>.provenance.json`, carrying the
   new digest, the producer identity above, and -- when step 2 succeeded --
   `attestation_expected: true` with the `source_ref` and `source_digest` that
   verified. Arming without those two is refused.

4. **Regenerate the sidecar**, now over verified bytes:

   ```sh
   sha256sum lib/openmined-psi.js-<version>.tgz > lib/openmined-psi.js-<version>.tgz.sha256
   ```

   Write it with the path in the form `sha256sum -c` is run against, so the
   committed line matches the CI invocation's working directory.

5. **Force a reinstall if the version string did not change.** npm caches a
   `file:` dependency by version, so same-version bytes are otherwise ignored:

   ```sh
   rm -rf node_modules/@openmined/psi.js
   npm install
   ```

6. **Run the checks locally.**

   ```sh
   sha256sum -c lib/openmined-psi.js-*.tgz.sha256
   npm run check:prebuild-provenance
   npx vitest run --project repo-scripts scripts/verify-prebuild-provenance.test.mjs
   npx vitest run --project repo-scripts scripts/vendored-psi-deps.test.mjs
   npm run build -w packages/core && npm test
   ```

7. **Open the pull request** stating the fork run URL, the fork commit, the new
   digest, and the arming state. A rebuild that touches the native crypto is
   crypto-code review scope
   ([CONTRIBUTING.md](../CONTRIBUTING.md#dependency-policy)).

## What the reviewer does

The point of the marker is that a third party can reproduce the chain of
custody from the pull request alone, without trusting the person who ran the
procedure. Against the branch:

1. **Confirm the bytes are the bytes described.** `sha256sum -c
   lib/openmined-psi.js-*.tgz.sha256`, and check that the digest in the diff's
   `.sha256` and `.provenance.json` are the same value.

2. **Verify provenance yourself**, by running `npm run
   check:prebuild-provenance` or the `gh attestation verify` invocation above.
   Do not read the CI result as a substitute while the marker is disarmed: a
   disarmed check reports rather than verifies, and says so in its annotation.

3. **Check the identity the marker pins**, not just that verification passed.
   `producer_repository` and `signer_workflow` must name the fork and its
   `native-prebuilds.yml`; a marker pointing at any other repository or
   workflow is a finding regardless of whether the attestation validates
   against it.

4. **Tie the source commit to reviewable source.** `source_digest` must be a
   commit that exists in the fork and whose tree is the source the addon is
   meant to be built from. This is the step that connects an attested build to
   code someone read; the attestation itself claims only that the run happened.

5. **Read an arming change as a change.** A diff that flips
   `attestation_expected` from `true` to `false` removes the provenance control
   for that artifact, and needs the same explanation as removing any other
   security check.

## First armed run

Nothing has exercised the positive path end to end: the fork has published no
attestation, so `gh attestation verify` has only ever been run here in its
failing direction. The first re-vendor that arms the marker is the acceptance
test, and these are the two things to confirm while watching that pull request's
CI rather than assuming them:

- **The verifier passes in CI, not only locally.** CI authenticates with the
  workflow's `GITHUB_TOKEN` against the fork's attestations, which is a
  different credential from a maintainer's `gh` login.
- **The `--source-ref` recorded matches what the fork's default branch is
  called.** A ref that does not match fails a verification that would otherwise
  succeed, and the failure looks like tampering.

If either surprises, the correct response is to leave the marker disarmed and
fix the mismatch rather than to weaken the invocation.
