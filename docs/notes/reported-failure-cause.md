---
title: "Showing a Failed Exchange's Reported Cause"
---

# A failed exchange's reported cause: shown in a block of its own, not folded into the copy

_Status: decided on the maintainer's ruling and built. The escaping the decision rests on is specified in [CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#display-sanitization-escape-format) and [SERVER_JOB_API.md](../spec/SERVER_JOB_API.md#relay-validation-at-the-trust-boundary); this note records why the shape is the one it is. See [docs/notes/README.md](README.md)._

Three of the four failure categories a web or console seat renders show the operator the cause chain the exchange delivered (`failureFor` in `apps/web/src/exchange/useInviterExchange.ts`). The retryable `exchange` category did not: it showed fixed copy and wrote the chain to a diagnostic-only `console.error`. An operator whose unattended run failed there was told the exchange failed and given nothing to act on.

## What the withholding was defending

Not the bytes. Every link of a rendered chain is escaped once at the display boundary, and a relayed one is escaped link by link, capped per link, and counted against the renderer's own depth bound before it reaches a seat at all -- so control characters, the ESC that drives ANSI sequences, bidi overrides and forged framing are already closed, whatever the child or the partner wrote.

What remains is ATTRIBUTION. A partner-writable rendezvous directory and a terminal that names offending files verbatim let somebody else's sentence arrive inside a message this application composed no part of, and an alert that runs its own guidance together with that sentence presents both in one voice. On the `exchange` category that is the sharpest form of it, because the alert offers a retry: a planted "it is safe to run this again" is then read as the console's own advice about a run that may already have disclosed.

## The decision

Show the chain on both seats, in a block of its own inside the alert, labeled as the exchange's report and separated from the first-party copy, which stays fixed. The separation is structural rather than a claim about the text:

- The report renders outside the element holding the seat's sentence, so no width or content of it can displace or extend that sentence.
- Its label is DOM text ahead of it rather than an accessible name, so a reading of the alert -- visual, or flattened to one run by an assistive technology -- meets the attribution before the words it attributes.
- It is set on the code background in the mono face this design reserves for data and protocol state, so words this application did not write display as somebody else's.

Those three are measured in `apps/web/test/browser/failureReportedCause.test.ts`, against a report written in console voice. It is the partition the host-key probe's peer excerpt already holds ([CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#sftp-host-key-verification)), in the weaker form an alert body admits: the probe can put the peer's bytes outside the announced region entirely, while these seats' alert is itself the element the failure appears in.

## The two shapes declined

**Keeping the fixed copy alone** leaves the driving case unserved. The failure this category takes is the one an operator cannot diagnose from the screen -- a dropped connection, a shared folder that never filled, a console run that stopped on a reason only the CLI holds -- and a line in the browser's diagnostic console is no remedy for a run nobody was watching.

**Splitting by seat** was available because the seats differ: `CLAUDE.md` makes the console's operator the machine's own trusted user, warned and guided rather than withheld from, while a public web seat faces a remote partner. It was declined because the attribution risk does not follow that difference -- a console operator reading a planted sentence in the console's voice is misled exactly as a web operator is -- and because a partition that holds structurally costs nothing to apply on both. One shape on both seats is also one shape to keep correct.

## The console's log, beside it rather than instead of it

The console serves a per-run diagnostic log on every server-job seat, offered whether the run succeeded or failed ([SERVER_JOB_API.md](../spec/SERVER_JOB_API.md#the-get-apijobsjobidlog-response)), and that gave "keep the fixed copy" a way to reach the console operator the public web seat has no equivalent for. It stands as a supplement: a log exists only where a run asked for one, downloads as a file, and holds far more than the refusal reason -- so it answers the operator who is already diagnosing, not the one who needs to know why this run stopped.

## Scope, and the residual

The block is for a category whose copy is this application's own. `config`, and the recovery-hint-carrying arms of `security`, render the exchange's message AS the alert's body, which is the [`recoveryHint`](../spec/CLI_EVENTS.md#the-self-explaining-marker) contract working as specified -- a refusal that states its own cause and next step displaces the seat's copy rather than standing beside it -- so there is no second voice for a block to separate. `output` is the second category the block is for: `failureFor`'s `output` arm in `apps/web/src/exchange/useInviterExchange.ts` states this application's own do-not-repeat sentences and puts the console's report of a write this browser did not make on the block beside them, rather than running the two together in one body where the planted sentence would read as the application's advice about a completed disclosure. That category's other cause is this browser's own results-file build, which no exchange reported and which the arm tells apart by the relayed error class: it is this application's account of its own write, so it finishes the sentence rather than standing under a label attributing it to the exchange. The `security` category's untagged arm stays withheld outright: its message is non-oracular by design, and a block attributing it to the exchange would publish it just as well as a sentence would.

The recurring/managed seat -- the surface that actually runs unattended as a PWA -- classifies into a failure type of its own (`ManagedRunFailureAlert` via `ManagedRunSurface`) and renders it through the same components, so a state with a cause to attribute gets this block and this layout rather than a flat span of its own. Which states have one is an allowlist in `apps/web/src/recurring/managedRunLaunchModel.ts`, and it holds two:

- **The transport state**, whose copy states a temporary connection problem and accounts for nothing about why this run stopped. Its report is the partner-or-network text this note's attribution risk is sharpest about, and what answers that is the placement rather than anything the text says: the report stands under the label and outside the seat's own sentence, so the words arrive attributed to the exchange. `apps/web/test/browser/managedRunReportedCause.test.ts` measures that order on the state as it ships.
- **The unreadable-custody state**, which is this device's own storage read, refused before the input file and before connecting. No affordance on the surface makes the entry readable, so the read's own error is the only diagnostic the operator has.

The rest withhold. The input, terms-shortfall and consent states state the cause in copy that is fixed and non-oracular by decision, so there is no second voice for a block to separate; the unexplained state is withheld for the same reason the untagged `security` arm is. A state is added to the allowlist by a decision of the same kind, and the unit test over `apps/web/test/unit/recurring/managedRunLaunchModel.test.ts` holds every state to the one recorded for it.

The residual is persuasion, the same one that probe's excerpt records. Plain printable text inside the block can argue for whatever it likes, including a sentence in console voice, beside the retry control the category offers. What it cannot do is arrive as this application's own words.
