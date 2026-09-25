# Standing product principles

The owner's standing principles for weighing a decision: a docket item, a review disposition, whether and how to file follow-on work. Each points at the repository file that states it, where one does; read that file for the detail rather than this summary. The page informs a recommendation and delegates nothing: decisions still go to the owner through the docket.

## How a recommendation argues

A recommendation argues from the product, the user's experience and sound security. A rule, invented or measured, never outranks those harder-to-measure principles, and a recommendation that rests on a rule alone says so and asks the owner. The principles below are held the same way: a recommendation names any it runs against, but argues from cost and benefit to users and the product, never from a principle's name.

## The principles

- **Guard against mistakes, not against the partner.** The parties are agencies under a signed data-sharing agreement, authenticated to each other. Design first against operator and partner mistakes; defend against a malicious partner where that is cheap and neither degrades the user's experience nor interferes with legitimate use. Stated in `docs/SECURITY_DESIGN.md`, Threat model. Where it stops: it sizes the new defenses worth building, and never licenses removing or softening an existing control over content the operator cannot inspect -- partner-authored or browser-delivered input and the bounds on parsing it -- which `CLAUDE.md`, Applications, calls correctly a hard refusal.
- **A party's data cleaning is its own business.** Standardization is never agreed, sent or verified between the parties. Stated in `docs/spec/PROTOCOL.md`, The width bound: a per-key candidate cap the terms declare.
- **Pre-release, there is nothing to break.** An internal format takes no version bump, compatibility path or migration, and internal version literals return to v1 before the first release. Stated in part in `docs/RELEASES.md`, Reset the exchange-record format at first publication, and `docs/spec/PROTOCOL.md`, Wire-format deltas: existing frames only, and no version bump.
- **No invented numbers.** A bound derives from the agreed terms or a measurement, or is labeled an arbitrary working value and raised on request without pushback.
- **Ship the whole feature.** Refusing a technically feasible combination is at most an interim, stated limit, with the wanted item kept open.
- **Argue from the product and the user.** A standing ruling, an acceptance criterion, epic fit, a settled spec rule or a spike result is context for a recommendation, never its reason.
- **No machinery nobody asked for.** Wait for a second occurrence before building a guard, and give a guard an expiry date. Stated in part in `CLAUDE.md`, Spawns and reports: a control the acceptance criteria do not require is proposed in a line before it is built.
- **Find the cause, and make a recurring rule mechanical.** Fix the cause rather than the symptom; a rule that keeps being broken becomes a hook or a check. Read with the principle above. Stated in part in `CLAUDE.md`, Writing, tooling and commits: a runtime claim is encoded as a check.
- **The web app is static.** Its server only delivers the code, and the peer-coordination server stands apart from it rather than being wired deeper into it. Stated in part in `CLAUDE.md`, Applications.
- **The invitation channel is trusted.** A second out-of-band message is no more trustworthy than the invitation, so it adds no protection. Stated in `docs/SECURITY_DESIGN.md`, Invitation contents and confidentiality.
