---
title: "Signed Provenance for the Vendored PSI Prebuild"
---

# Prebuild provenance: binding vendored bytes to the build that made them

_Status: decided, built, and armed against a fork that attests. This note
records why the
vendored `@openmined/psi.js` tarball is verified with a GitHub artifact
attestation rather than npm provenance or a cosign blob signature, what the
`.sha256` sidecar is re-scoped to, and why the check ships armed by a committed
marker instead of unconditionally. The marker format and the exact verifier
invocation are in
[DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md#the-vendored-openminedpsijs-addon);
the procedure and the reviewer's steps are in
[PREBUILD_REVENDOR.md](../PREBUILD_REVENDOR.md). See
[docs/notes/README.md](README.md)._

## The gap

`@openmined/psi.js` is a psilink fork, built by that repository's
`native-prebuilds.yml` and copied here by hand as
`lib/openmined-psi.js-<version>.tgz`. It ships native N-API addons that are
`dlopen`'d with full process privilege and run the PSI crypto. The digests that
stand between the tree and those bytes -- the committed `.sha256` sidecar, and
the lockfile's own `integrity` for the `file:` dependency -- are both recorded
in this repository.

The sidecar is written in the same commit as the tarball it describes. Against
accident it works and is the only control that works with no network and no
tooling. Against a writer who controls `lib/` it proves nothing, because that
writer controls both files. Nothing bound the vendored bytes to a fork commit or
a workflow run, and that hop -- artifact output to vendored file -- is the one
this note closes.

## Mechanisms weighed

**GitHub artifact attestations** (`actions/attest-build-provenance` producing,
`gh attestation verify` consuming), chosen. Keyless throughout, so there is no
key to rotate, leak, or revoke. The attestation is stored against the
**producing** repository, which is precisely the trust boundary in question: it
lives outside any psilink commit, so a writer with `lib/` access cannot forge
it. It is also the toolchain already in this repository -- `release.yaml`'s
publish job runs the same action against the image manifest and already declares
the two permissions the fork needs -- and the same Sigstore chain as the keyless
release-image signing decision ([cosign-keyless-signing.md](cosign-keyless-signing.md)).
The consumer story is one command with no key material to distribute.

**npm provenance**, structurally inapplicable. It is a property of a package
published to the npm registry, and this tarball is a `file:` dependency that is
never published. Adopting it would mean publishing the fork under a scope --
trading an artifact the project controls for a registry dependency it does not,
a distribution decision far larger than this one and not otherwise wanted.

**Cosign blob signing**, the fallback. It works on any file however it is
distributed, and was exercised end to end on the real 15.9 MB artifact: sign,
verify OK, then verify again after flipping a single bit and get a signature
failure. It costs more ceremony -- the consumer needs cosign installed and must
pin an identity regexp correctly, and the signature bundle has to travel
alongside the tarball as a second vendored file that the same `lib/` writer
could replace. It is the right answer if the artifact ever needs verifying
outside GitHub's API, and the wrong answer while both repositories are on
GitHub and public.

## The sidecar is kept, and re-scoped

Once provenance exists the sidecar stops being the tamper control, and the
temptation is to delete it. It is kept, because it holds value the attestation
cannot: it verifies with `sha256sum` alone, with no network, no token, and no
`gh`, and it runs first, before install. That is the check that catches a
truncated checkout or a corrupt download -- and it keeps working when
`api.github.com` is unreachable, which is exactly the condition that makes
`gh attestation verify` unavailable.

What changes is what the documentation claims for it. It is an availability and
accident control, not a tamper control across the fork boundary, and it says so
rather than leaving a reader to infer that a committed hash proves origin.

## Why the check is armed, not unconditional

Attestation coverage is a property of the run that packed a given tarball, not
of the fork: one packed before the producing workflow attested has nothing
to verify. A check that unconditionally demanded an attestation would redden CI
over such an artifact, and the pressure would then be to weaken or revert it --
the wrong direction for a control that is meant to tighten. So the enforcement
is armed per artifact by `attestation_expected` in a marker committed beside the
tarball: disarmed, CI stays on the sidecar baseline and warns; armed,
verification is enforcing.

The obvious weakness in a marker-armed design is the downgrade: disarm the
check, then substitute the bytes. Three properties are what make that a poor
move rather than a silent one.

- **The marker is mandatory in both states.** A missing or malformed marker
  fails the check, so the arming switch cannot be removed by deleting the file
  and leaving an absence that looks like a repository which never had the
  control.
- **The digest binding is enforced while disarmed.** The marker's recorded
  `sha256` is held against the tarball's real bytes offline, in both states. A
  substitution must therefore also rewrite the marker -- and rewriting it to
  match new bytes is what guarantees the armed lookup fails, because no
  attestation exists for those bytes.
- **Disarming is a diff.** What remains is flipping one boolean in a tracked
  file under `lib/`, in the same pull request as the bytes it protects, which a
  reviewer reads.

This does not make the repository resistant to a maintainer who intends harm and
can merge; nothing in the repository can. It makes the removal of the control
plain instead of invisible, which is the achievable property.

## Enforcement points

Verification runs where the network and a token are always available: the shared
setup action, ahead of `npm ci`, and the release publish job, ahead of the
shipped image build -- the two places these bytes are respectively installed and
baked into a published artifact. The `native_alpine` and `image_smoke` legs keep
the sidecar alone; they consume a tarball a CI run already verified rather than
introducing it.

The local `npm install` path is left out by design. Making it depend on the
attestation would make a plain install require a GitHub token, and a developer
without one would get a failure that looks like tampering. Local installs keep the
sidecar, which is what they had.

## What is not settled

An attestation binds bytes to a workflow run; it does not establish that the run
built reviewed source. Tying `source_digest` to reviewable fork source stays a
step the reviewer performs, not one the tool performs -- the one part of this
chain no tool closes.

The rest is settled and recorded rather than assumed. The positive path runs:
the fork attests and the armed check verifies a real attestation, so the
invocation is exercised in both directions and not only in its failing one. The
two questions the first armed re-vendor was left to answer are answered in
[PREBUILD_REVENDOR.md](../PREBUILD_REVENDOR.md#first-armed-run) -- a public
fork's attestations are readable unauthenticated, so CI's `GITHUB_TOKEN` reaches
them, and `--source-ref` is matched exactly rather than by commit reachability,
so a run minted on a branch fails a `refs/heads/master` verification even once
that branch has fast-forwarded onto it. Where that pass can be observed is
bounded by egress the verifier needs beyond `api.github.com`: an environment
fenced from the Sigstore bundle host or the TUF CDN fails closed and cannot
re-establish it, which is why CI's own run is where it stands. The spec states
that limit.
