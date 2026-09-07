---
title: "The Console's Signing-Identity Custody"
---

# The console's signing-identity custody: keep the default, refuse the one harmful run

_Status: decided on the maintainer's ruling; the refusal is built, the identity-location option is not. The behaviour is specified in [SERVER_JOB_API.md](../spec/SERVER_JOB_API.md#refusing-a-run-that-would-publish-the-signing-identity), with the operator-facing account in [CONSOLE.md](../CONSOLE.md#signing-a-receipt-and-noting-where-the-result-is-filed); this note records the posture and why it was taken rather than restating those rows. The CLI's own posture is [signing-identity-custody.md](signing-identity-custody.md), the decision this one was left out of. See [docs/notes/README.md](README.md)._

The console creates and reads this party's signing identity in the one working directory the operator mounts. On a single-mount console that is also the folder a shared-directory exchange rendezvouses out of, because `JOB_RENDEZVOUS_DIR` falls back to `JOB_DATA_ROOT` -- so the long-lived private key sits in the folder the partner writes into, and a shared-directory run publishes it. The console met that with advisory copy on the receipts card, which is what this decision replaces for the one run where the copy was not enough.

## Why the default location stays

The CLI resolves no location for the identity and refuses to invent one, for reasons recorded in its own note. The console is not in that position: it already has a mounted working directory the operator chose, it composes an explicit `signing.identity_file` on every job, and it never relied on a default the CLI removed. Creating the key there on demand costs an SFTP or WebRTC exchange nothing at all -- nobody syncs that folder on those channels -- and it is what makes a first signed exchange possible with one mount and one variable.

So the default is not the defect. Exactly one layout is, and it is a layout the console can recognize.

## Why this one is a refusal and not a warning

The console's standing posture is warn-and-guide: the operator is the machine's own user, and a hard block on their own choice is the wrong shape (see [CLAUDE.md](../../CLAUDE.md), Applications). A credential file in the single mount warns, and the run proceeds.

Key disclosure does not fit that shape. What the operator would be choosing is not a risk they carry themselves and can weigh -- it is handing a partner the key that signs for them with every other partner, and no later choice of theirs takes it back. The warning also arrives where it cannot be acted on cheaply: the remedy is a mount change, which means restarting the console, so an operator reading the warning mid-authoring is being asked to abandon the run either way. Refusing states the same thing at the moment it is true and leaves the authored draft alone.

The refusal stays narrow so that the posture does not spread. It fires only for a shared-directory exchange, only where the run would have a key in the synced folder, and only where the comparison positively found the collision. Every other layout runs, including layouts where the check is merely unsure -- a refusal is owed a positive finding, and an operator hard-blocked by a check that could not resolve a path has no remedy the console can name.

"Would have a key" covers the key the run itself would mint, not only one already on disk. The console passes the identity path to the CLI child explicitly, and a signed run with no identity yet has the child create one there -- so a rule keyed on the file's presence would admit exactly the first signed run, the one that publishes the key it just made. The same reasoning refuses a fingerprint request that would MINT into that folder, while leaving a request that only reads an identity already there alone: that request creates nothing, and the run is refused on its own.

## What the check can and cannot see

The comparison is the one the rendezvous report already had for `sharesDataRoot`, read per run rather than at boot since the identity is created between runs: each directory as configured, as its real path, and by filesystem identity along the data root's ancestor chain, which is what catches one host folder bind-mounted at two container paths.

One host folder mounted twice, outside that ancestor chain, stays invisible to it -- no path or identity the console can reach expresses the aliasing. That limit is the whole of what the receipts card's remaining advisory now says. The rest of the card's old shared-mount copy is gone: it existed to make the operator weigh a hazard the console now stops.

## What is left open

The maintainer's ruling also has the key's location become a console option: the CLI's own `signing.identity_file`, prefilled with the default and changeable by browsing a mount, mount-relative and resolved server-side, exactly as the connection's credential file is browsed today. That is not built. Until it is, the remedy the refusal names is the one the deployment guide already documents -- give the rendezvous a mount of its own -- and an operator who wants the key outside the working directory has no in-console way to put it there.

## See also

- [SERVER_JOB_API.md](../spec/SERVER_JOB_API.md#refusing-a-run-that-would-publish-the-signing-identity) - the refusal's conditions, its comparison, and the `400` body that names it
- [CONSOLE.md](../CONSOLE.md#signing-a-receipt-and-noting-where-the-result-is-filed) - what the operator meets, and the mount that resolves it
- [DEPLOYMENT.md](../DEPLOYMENT.md#mounting-the-signing-identity) - the CLI's own mounts for the identity, read-only after creation
- [signing-identity-custody.md](signing-identity-custody.md) - the CLI's posture: no invented location, and what each command does without one
