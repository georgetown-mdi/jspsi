---
title: "Resolving the Signing Identity Like a Credential"
---

# Resolving the signing identity like a credential: why psilink chooses no location

_Status: decided and built, by a 3-panelist design panel converging 3-0 on the two questions the issue left open. The behaviour is specified in [CLI.md](../CLI.md#where-the-signing-identity-lives), [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#signingidentity_file), and [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#custody-and-persistence); this note records the posture and why it was taken rather than restating those rows. See [docs/notes/README.md](README.md)._

The signing identity is a long-lived P-256 private key reused across every exchange and every partner. It is the same class of file as the SFTP credential the console browses out of a mounted read-only directory, and it was the one psilink resolved for the operator -- out of the user's home directory, created on first `psilink fingerprint`. This note records what replaced that and why the replacement invents nothing in its place.

## What a chosen location costs

A default is a guess about custody, and both guesses available were wrong in the cases that matter most.

**The home directory.** In a container that home is ephemeral, so each run minted a fresh key with a fresh fingerprint -- silently invalidating every fingerprint a partner had pinned. The failure is quiet at the moment it happens and appears later, at the partner's end, as a receipt that will not verify. The original design reached for a per-user location to make creation convenient against read-only-mount friction; the friction was the shape of the thing, not an obstacle to route around.

**The working directory.** In a single-folder file-drop exchange the working directory is the rendezvous directory -- one the partner writes into. A signing identity there publishes to one partner the key that signs for this party with every partner. That hazard needed a whole warning section to manage; a credentials-mount home dissolves the class rather than warning about it.

There is no third guess that is right either. Which directory is durable, which is partner-visible, and which is backed up are facts about the operator's machine and their custody arrangements, not about psilink.

## The posture

The identity is resolved the way a credential is resolved: from an explicit path the operator named, and from nowhere else. No probe of a conventional location, no environment-variable fallback, no read of the previous default, and no migration. `~` expansion stays -- what changed is that psilink never chooses the home directory, not that an operator may not name one.

That leaves each command with a question about what to do when nothing is configured, and the three answers differ because what the commands are doing differs.

**An exchange refuses.** Under `signing.mode: certificate` with no `identity_file`, the run cannot produce the receipt it is configured to produce, and no partner or network state can change that. It joins the family of pre-flight configuration refusals that already fire before any credential, terms, or data are sent -- no partner pin, unnamed local party -- at the same exit code and in the same message shape. The refusal is not in the block's schema: cross-field rules stay out, so a partially-authored config still parses wherever the schema is read, which is the same division the partner-fingerprint requirement already keeps.

**Verification refuses nothing.** `psilink verify-receipt` uses the identity only to anchor this party's own certificate slot, and only while that slot is still unanchored. With no path configured, the slot is left unanchored and the verdict grades `INCOMPLETE` at exit 0 -- what the command already reported for an identity found without being asked, now the only outcome on that input. A refusal here would break a case that has nothing to do with signing: an auditor who pins both signers reaches a verified verdict holding no identity at all, and a party whose pins already anchor both certificates must not start failing. A path the operator DID name and that is absent or unreadable stays a usage error, matching the rule the command already keeps for `--config-file` and `--partner-terms`.

**Creation refuses, and the guidance is the point.** `psilink fingerprint` with no path exits 64 and writes nothing to stdout, so `FP=$(psilink fingerprint)` yields an empty capture and a nonzero status rather than a fingerprint minted somewhere the operator did not choose. The panel's sharpest point was about what the refusal says: a bare "name a path" invites a throwaway location, and losing this file forces a re-key coordinated with every partner. So the message states the whole remedy -- why psilink picks no location, both spellings of the path with a mounted-credentials example, what the directory has to be (writable for the creating run, read-only after, durable, never partner-synced), and a static line telling an operator who already holds an identity to name that file rather than mint a second one. Static, because psilink knows no location to look in for one; looking is the behaviour this change removes.

## Why the asymmetry is the right shape

The three answers are one rule read against three situations: refuse where the missing input makes the command's own purpose unachievable, and report where it does not. Signing needs a key and cannot proceed without one. Verifying needs no key of its own -- an anchor it lacks is a check that did not run, and the module's standing rule is that a check which did not run is never reported as one that passed. Creating needs a destination, and inventing one is the defect.

## The label bound at creation

Closed in the same change, since it is the same decision point: `psilink fingerprint` bound `--identity` (or `linkage_terms.identity`) into the certificate after only a non-empty check, so the CLI could mint identities the linkage-terms schema itself refuses. The label now takes that schema's two rules -- no control character, and the same length bound -- matching what the console's fingerprint route already applies to the label it binds. The value is not transient: it is bound into a long-lived certificate, and read back and displayed by whoever pinned the fingerprint, long after the run that chose it.

## What this note does not decide

The console's own resolution is a separate decision, tracked separately. It composes an explicit `identity_file` on every job and never relied on the CLI's default, so nothing here changes it.

## See also

- [CLI.md](../CLI.md#where-the-signing-identity-lives) - the operator-facing instructions and the three commands' behaviour
- [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#signingidentity_file) - the field, its requirement under certificate mode, and the mounted example
- [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#custody-and-persistence) - custody, the read-only-after-creation shape, and the threat the old default posed
- [DEPLOYMENT.md](../DEPLOYMENT.md#mounting-the-signing-identity) - the Docker and Kubernetes mounts
