---
title: "The Console's Signing-Identity Custody"
---

# The console's signing-identity custody: keep the default, refuse the one harmful run

_Status: decided on the maintainer's ruling; the refusal is built, the identity-location option is not. The behaviour is specified in [SERVER_JOB_API.md](../spec/SERVER_JOB_API.md#refusing-a-run-that-would-publish-the-signing-identity), with the operator-facing account in [CONSOLE.md](../CONSOLE.md#signing-a-receipt-and-noting-where-the-result-is-filed); this note records the posture and why it was taken rather than restating those rows. The CLI's own posture is [signing-identity-custody.md](signing-identity-custody.md), the decision this one was left out of. See [docs/notes/README.md](README.md)._

The console creates and reads this party's signing identity in the one working directory the operator mounts. On a single-mount console that is also the folder a shared-directory exchange rendezvouses out of, because `JOB_RENDEZVOUS_DIR` falls back to `JOB_DATA_ROOT` -- so the long-lived private key sits in the folder the partner writes into, and the operator's sync tool hands it over. Advisory copy on the receipts card is the console's whole answer to that layout without this decision; the decision adds a refusal for the one run where copy is not enough, and holds the copy to what the refusal does and does not see.

## Why the default location stays

The CLI resolves no location for the identity and refuses to invent one, for reasons recorded in its own note. The console is not in that position: it already has a mounted working directory the operator chose, it composes an explicit `signing.identity_file` on every job, and it never relied on a default the CLI removed. Creating the key there on demand costs an SFTP or WebRTC exchange nothing at all -- nobody syncs that folder on those channels -- and it is what makes a first signed exchange possible with one mount and one variable.

So the default is not the defect. Exactly one layout is, and it is a layout the console can recognize.

## Why this one is a refusal and not a warning

The console's standing posture is warn-and-guide: the operator is the machine's own user, and a hard block on their own choice is the wrong shape (see [CLAUDE.md](../../CLAUDE.md), Applications). A credential file in the single mount warns, and the run proceeds.

Key disclosure does not fit that shape. What the operator would be choosing is not a risk they carry themselves and can weigh -- it is handing a partner the key that signs for them with every other partner, and no later choice of theirs takes it back. The warning also arrives where it cannot be acted on cheaply: the remedy is a mount change, which means restarting the console, so an operator reading the warning mid-authoring is being asked to abandon the run either way. Refusing states the same thing at the moment it is true and leaves the authored draft alone.

The refusal stays narrow so that the posture does not spread. It fires only for a shared-directory exchange, only where the identity file is in the synced folder, and only where the comparison positively found the collision. Every other layout runs, including layouts where the check is merely unsure -- a refusal is owed a positive finding, and an operator hard-blocked by a check that could not resolve a path has no remedy the console can name.

"Would have a key" is the identity file's presence, and only that -- presence, never readability. A file the console's own uid cannot open is a file the partner's sync copies all the same, so a readability test would admit the run on exactly the layouts a mode-`000` key, a uid-mapped mount, or a key minted under another account puts the operator in. The console passes the identity path to the CLI child explicitly and the child LOADS this party's identity from it -- a `certificate` run with nothing there is refused by the CLI, with its own guidance, rather than given a key it just made. So no run creates the key it would go on to publish, and the presence probe is the whole condition.

Creating the identity is refused on no layout. The rendezvous falls back to the data root, so on the default one-mount console every mint would land in a directory a leg holds: refusing there would take signed exchanges away from that console entirely, including the SFTP and WebRTC exchanges where nothing is synced at all. The key is created on demand in the working directory, which is the default the ruling keeps, and the one harmful run is the one refused.

One moment is refused rather than one layout: a mint while a shared-directory exchange holds the single exchange slot and a leg holds the directory the key would land in. The run's own check ran before that key existed, so without this the console would write a private key into a folder its own exchange is syncing as it runs -- the one case where the console, not the operator, chooses the moment. It refuses the mint alone: reading a fingerprint from an identity already there changes nothing about where that key is.

## What the refusal is not

It is not containment. A configured rendezvous is kept in step with the partner's copy by the operator's own sync tool, continuously; a key written into that folder is the partner's from the moment it lands, whether or not an exchange is ever started. By the time the console refuses a run, the disclosure the refusal names has already happened.

What the refusal stops is the console taking that step itself -- starting an exchange whose own protocol step copies the folder to the partner -- and what it gives the operator is the layout, named at the moment the console can name it, with the mount change that ends it. Choosing to keep a key in a folder they sync stays the operator's choice, met the way the console meets the operator's choices: the receipts card warns and points at the remedy. That is why the refusal is no guarantee about the key, and why the card keeps its word about the layout where the refusal is in force.

## What the check can and cannot see

The comparison is the one the rendezvous report already had for `sharesDataRoot`, read per run rather than at boot since the identity is created between runs: each directory as configured, as its real path, and by filesystem identity along the data root's ancestor chain, which is what catches one host folder bind-mounted at two container paths.

One host folder mounted twice, outside that ancestor chain, stays invisible to it -- no path or identity the console can reach expresses the aliasing.

The other half of the refusal is a presence probe: one fixed file name, directly under the mounted working directory. That name, and whether something is at it, is the whole of what the console knows about the key. The receipts card says so on the layouts where a partner syncs the key's folder or the console could not rule that out -- what the refusal covers where the shared layout was established, and what no refusal covers where it was not. Where the report positively says the rendezvous has a mount of its own the card raises neither: nothing about the key is in a folder the partner reads, and a warning shown on the recommended layout as well as the hazardous one tells the operator nothing about which they are in.

### Limits accepted, not closed

These are accepted under the deployment the console is for: the partner is an authenticated party under a signed agreement, and one writing into the synced folder to attack this party is not the case being designed against. They are recorded here, and in the spec's refusal section, so the refusal is not read as a control against a hostile partner. The last is not about the partner at all: it is where the two refusals fail to cover each other, recorded rather than gated.

- **The folder syncs at all times, not only during a run.** The disclosure a key in that folder is has already happened by the time any run is started, so the refusal signals the layout rather than preventing it. The advisory is what names that, and the mount change is what ends it.
- **The probe reads a name, not a key.** It reads that name in the folder the partner writes into. A file a partner plants there refuses a run that would have published nothing -- an exchange by a party with no identity of its own anywhere -- and an identity the operator renamed is not seen at all, so a run that would publish it is admitted.
- **A document at that path is taken as this party's identity.** The console points the CLI at that path for every fingerprint request and for runs on every channel, and the CLI loads whatever is there. A document bound to a different identity label is warned about rather than refused on that load (`warnOnIdentityDivergence`), and the console discards the child's stderr; one bound to the same label -- the label the agreed terms hold, which the partner knows -- diverges from nothing, so `psilink exchange` accepts it too. A partner able to write into the synced folder could therefore put their own signing identity at that path.
- **The two refusals exclude each other in one direction only.** The mint reads the exchange slot; the run reads whether the identity file is there, and nothing makes it read a mint already under way. A shared-directory run created after the mint's child started and before that child wrote the file is admitted, over a window of one child process start, and the key then lands in the folder that run syncs. A gate over both would buy that one window at the cost of a second refusal on a surface whose whole point is how narrow the first one is.

The remedy for all of them is the one the refusal already names: keep the identity outside every folder a partner syncs. The identity-location option below is what would make that routine rather than a mount change.

## What is left open

The maintainer's ruling also has the key's location become a console option: the CLI's own `signing.identity_file`, prefilled with the default and changeable by browsing a mount, mount-relative and resolved server-side, exactly as the connection's credential file is browsed today. That is not built. Until it is, the remedy the refusal names is the one the deployment guide already documents -- give the rendezvous a mount of its own -- and an operator who wants the key outside the working directory has no in-console way to put it there.

## See also

- [SERVER_JOB_API.md](../spec/SERVER_JOB_API.md#refusing-a-run-that-would-publish-the-signing-identity) - the refusal's conditions, its comparison, and the `400` body that names it
- [CONSOLE.md](../CONSOLE.md#signing-a-receipt-and-noting-where-the-result-is-filed) - what the operator meets, and the mount that resolves it
- [DEPLOYMENT.md](../DEPLOYMENT.md#mounting-the-signing-identity) - the CLI's own mounts for the identity, read-only after creation
- [signing-identity-custody.md](signing-identity-custody.md) - the CLI's posture: no invented location, and what each command does without one
