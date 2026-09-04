---
title: "Keyless Cosign Signing for Release Images"
---

# Keyless Cosign signing: no key to hold, a workflow identity to pin

_Status: decided, and built. This note records the choice to sign release
container images keylessly through Sigstore rather than with a project-held
Cosign key, what was weighed against it, the evidence the decision rests on, and
what it does not settle. The verification commands a partner runs, and the
release procedure around them, are in
[RELEASES.md](../RELEASES.md#verifying-a-release); the framing for an agency
assessment is in [COMPLIANCE.md](../COMPLIANCE.md#release-integrity). See
[docs/notes/README.md](README.md)._

## The decision

Release images are signed with `cosign sign --yes` and no `--key`. Fulcio issues
a short-lived certificate against the release job's GitHub Actions OIDC
identity, the signature is recorded in Rekor's public transparency log, and a
verifier pins the workflow identity instead of fetching a public key.

The corollary is that no signing key is used anywhere: no workflow step reads a
private key, no public key sits in the repository root, and there is no
rotation, expiry, or revocation procedure to write, staff, and remember. The
now-unused `COSIGN_PRIVATE_KEY` and `COSIGN_PASSWORD` repository secrets remain
configured until the maintainer deletes them -- a settings change no commit can
make -- deferred until a keyless-signed image has verified end to end.

## Why this, and why before the first release

**A published key next to the thing it signs is weak evidence.** Under the
key-based arrangement the verifier fetched `cosign.pub` from this repository --
the same repository an attacker with push access controls. That verifier learns
that whoever held the key signed the image, and takes the key's authenticity on
the same trust they were trying to establish. Pinning a workflow identity moves
the anchor to Sigstore's certificate authority and a public append-only log,
neither of which this project can quietly rewrite.

**Public auditability is worth more to a FOSS project than key custody is.**
Every keyless signature is a public Rekor entry: a third party can enumerate
what this workflow has ever signed, and a signature produced outside the
official workflow cannot be made to look like one produced inside it. A stolen
or misused project key leaves no such trace.

**The migration is free exactly once.** Nothing has been signed yet -- no
release workflow run has ever executed, and there is no GitHub Release. (A
`v0.1.0` tag exists on the remote, but it predates this workflow and triggered
no run.) Every cost the evaluation weighed -- partners with a pinned key,
documentation and procedures that describe one, an installed base to migrate --
is zero today and becomes non-zero at the first tagged release that ships a
key-based signature. Deferring the decision is the expensive option.

## What was weighed against it

**Keeping the key-based signature.** Its one real advantage is a shorter
verification command against a self-contained artifact. It costs key custody:
generating the key, holding it in repository secrets, and owning a rotation and
revocation story that nothing here has written. It also leaves the trust
anchor -- the public key -- inside the repository, which is the weakness above.

**Running both.** Two signatures over the same digest is coherent, and would
let partners migrate at their own pace. With no partners to migrate it buys
nothing, and it doubles the surface a verifier has to reason about and what
the project has to keep correct.

**The verification UX, which the decision was conditional on.** The keyless
command is longer: two required `--certificate-` arguments in place of one
`--key`. In exchange it needs no fetched file, so it can be copied out of the
release notes and run as-is, and both arguments are constants across every
release rather than per-release values. RELEASES.md states what each argument
pins and why omitting one is not an option, because the failure mode is a
command that still exits zero while checking less than the reader thinks. That
was judged acceptably simple.

What the longer command costs instead is a coupling: the identity it pins is
made of the release workflow's own file path and its tag trigger, so renaming
that file or widening that filter leaves the published command refusing the
signature a real release produced, with nothing in the document that would
notice. The release workflow therefore runs the published command against each
digest it signs, and `npm run check:release-signing` holds the document's
pattern, the workflow's copy of it, and those two properties of the workflow to
each other on every pull request.

## The evidence

A throwaway workflow on a throwaway branch drove the real thing in this
repository -- OIDC issuance, Fulcio, Rekor, and verification -- rather than
reasoning about it. It signed a scratch blob and a scratch image, the image in a
`registry:2` service container so nothing was published anywhere.

What the runs established:

- GitHub Actions issues an OIDC token to a job holding `id-token: write` in this
  repository, and Fulcio issues a signing certificate against it. Cosign
  v3.0.6, from the pinned `sigstore/cosign-installer`.
- The certificate's identity is the workflow file's path plus the ref the run
  came from, verbatim: on a branch push,
  `https://github.com/georgetown-mdi/jspsi/.github/workflows/<file>.yaml@refs/heads/<branch>`;
  on a tag push, the same with `@refs/tags/<tag>`. The tag form is the one a
  release produces, and it was driven, not inferred.
- An anchored `--certificate-identity-regexp` over that identity verifies the
  signature, and three negative controls fail closed: the exact published
  pattern refuses the branch-form certificate (run 31931204906), a version-tag
  pattern refuses a signature from a differently tagged run of the same
  workflow (run 31931280133), and verification against a different pinned
  issuer (`https://accounts.google.com`) refuses the signature outright. Both
  arguments are required. The issuer control was driven in that mirror
  direction only -- the probe's Actions-issued certificate against a command
  pinning a foreign issuer; presenting a certificate actually issued elsewhere
  to the published command was not driven, and the refusal of that direction
  rests on the same issuer-equality comparison the mirror measured.
- The signature is written to the conventional `sha256-<digest>.sig` tag beside
  the image, not as an OCI referrer, so it needs nothing of a registry that the
  key-based signature did not already need.

The probe's durable evidence is Actions runs 31931204906 (branch push) and
31931280133 (tag push) and the Rekor entries the probe wrote, which are
permanent and public and outlive both the branch, which was deleted, and the
Actions run logs, which expire. Log indices 2484702205 and 2484703379 are the
two runs' sign-blob bundle entries; the keyless image signings in the same runs
wrote their own transparency-log entries, which cosign reported verified but
which are not indexed here.

## What this does not settle

**Docker Hub.** The image leg ran against `registry:2`. The signature's storage
scheme is the conventional tag, which Docker Hub already holds for any image, so
nothing here is expected to differ -- but the first real release is what
establishes that, alongside the attestation-reference question RELEASES.md
already flags in the same position. What that release does with the answer is
settled: it verifies each signature it produces before building the next image,
so a storage scheme Docker Hub does not hold fails the release rather than
reaching a partner as an image the published command calls untrusted.

**A verifier with no route to the internet.** `cosign verify` reported the
transparency-log claim verified offline, the inclusion proof travelling with the
signature. It still resolves Sigstore's trust root, and whether a first run on a
disconnected host can do that was not measured. An agency reviewer verifying
from a segmented network is the case that would find out; settle it by driving
cosign on such a host rather than by reading its source.

## What did not change

Release tags stay signed with the maintainer's SSH key, and `allowed_signers`
stays as it is: tag signing establishes who authored the release commit, which
is a different claim from who published the image, and Sigstore has nothing to
say about it. An assessment will ask about one consequence: the SSH tag
signature is the only signature in a release that rests on a key a person
holds. Every other claim over a release artifact rests on the release
workflow's identity and on this repository's Actions configuration --
which [COMPLIANCE.md](../COMPLIANCE.md#release-integrity) states as a limit.
