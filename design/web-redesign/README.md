# Web app redesign: the linkage bench

A redesign direction for the psilink web app, presented as a non-functional HTML mockup
(`proposal-c.html`). It is a self-contained page (no build step, no external resources): open
it in a browser, step through the 17 screens with the review bar at the bottom (arrow keys
work), and toggle "Notes" to see which design pattern each decision comes from and why. The
mockup renders in light and dark and respects reduced motion.

The redesign preserves every capability of the current app - nothing is removed, including
the expert authoring surface, terms import/export, and the gated not-yet-applied settings
(psi-c count-only matching, deduplication, fuzzy comparison), which stay visible but inert
exactly as today. What changes is the sequence of interactions, the information
architecture, the copy, and the visual identity.

## The framing

An exchange is a transaction, not a benefits application. Most exchanges are simple and
lightweight; only a few need the full customization surface. The design is grounded in the
civic tech canon (GOV.UK Design System and GDS principles, GOV.UK Service Manual, USWDS,
USDS Digital Services Playbook, and the community-archived 18F guides - sources at the end),
applied through GOV.UK's own exception for expert users doing repeated tasks: keep one
working surface, and give it orientation rather than decomposition.

## The design

One working surface per role - a "bench" with three regions: a section rail on the left, a
work column in the center, and a standing disclosure ledger on the right.

- A three-step required spine: 1 Your file (name and file; default terms are derived from
  the file the moment it is read), 2 Matching & sharing (the one mandatory review - the
  only decision with no safe default), 3 Review & create (owns the invitation lifetime,
  who receives the matched results, the transport choice, a check-your-answers table with
  change links, and the create button).
- A Customize group of optional tabs, unnumbered and out of the spine: Cleaning, Matching
  keys, and Legal agreement. Each tab's state is a quiet fact in the rail ("3 fields",
  "2 keys", an agreement reference or an em-dash) rather than a status word; color appears
  only when a tab has been edited or needs attention. The tabs ship with defaults derived
  from the file - declared once in the rail, not per item - and are promoted from optional
  to required only when a problem gives a reason: the rail's Problems block is the error
  summary, and it links into the tab that needs attention.
- The disclosure ledger (You will send / You will receive / Matched on / Expires / Results
  go to / Agreement / Transport) is always visible and fills in as the exchange takes
  shape; it is the standing answer to "what leaves this machine."
- After creation the rail becomes the protocol timeline (Share -> Partner accepts ->
  Confirm protocol -> Link keys -> Done), ending in a completion panel with the three
  downloads and their caveats.
- The acceptor path is equally light: review the fully expanded terms, consent with your
  file, confirm your columns (a quick-fix mapper appears only when a field is missing;
  cleaning surfaces only when the satisfiability verdict gives a reason), run.
- Transport: the same surface configures SFTP exchanges. Choosing the SFTP transport in
  Review & create saves an exchange file (identical linkage terms, different carrier) that
  automates the repo's command-line tool, with credentials supplied by the CLI at run time,
  never stored in the file. The mockup tags this option "On the roadmap" - the web app is
  WebRTC-only today and the mock never presents an unshipped capability as in force.

Visual identity: a calibrated instrument - warm paper grounds, ruled lines, one cyan
accent, and a strict type boundary where monospace means real data or protocol state and
sans means guidance.

## Alternatives considered

Two other directions were mocked up to the same feature-coverage bar and reviewed before
this one was chosen. "One clear question" ran the exchange as a GOV.UK-style linear
service - one decision per page, error summaries, check-your-answers, a true confirmation
page. "The exchange file" treated each exchange as a resumable case with a task-list hub
and explicit whose-move/waiting states. Both answered real gaps in the current app
(orientation, review and completion moments, designed waiting), but both put the full
weight of the process in front of every user; the bench keeps their review-and-confirm
discipline while letting the common lightweight exchange stay lightweight.

## Feature coverage

The mockup demonstrates, among the rest: the full invitation terms surface (lifetime,
result direction, column typing and disclosure grid with the single-identifier rule, extra
data summaries, per-field cleaning pipelines with add-step menus, whole-file coverage
readouts and original-to-cleaned previews, ordered matching keys with reorder controls,
expert key editor with aliases, transforms, swaps and satisfiability badges, legal
agreement fields, linkage strategy with the single-pass warning, gated matching method and
deduplication, terms import/export as JSON/YAML, reset to recommended); the share step
(invitation link and code with copy actions, one-time-secret and trusted-channel copy,
expiry); the run (stage labels, progress, partial-coverage persistence); completion (the
three downloads with their caveats and the withheld-result variant); and the acceptor side
(paste-or-open entry, fully expanded terms review with the unverified-name note, the exact
consent gate, satisfiability verdict, quick-fix column mapping and the dead-key advisory).
Every error and warning string in the current app appears as a designed component,
including the expired invitation and the could-not-verify-your-partner security stop.

Invariants preserved: the consent checkbox and name gate, the fully expanded terms review,
tokens riding the URL fragment, gated settings never presented as in force, in-browser
processing assurances, and the "you" / "your partner" vocabulary.

## Sources

- GDS design principles: https://www.gov.uk/guidance/government-design-principles
- GOV.UK Design System (question pages, error summary and messages, check answers,
  confirmation pages, complete multiple tasks, start using a service):
  https://design-system.service.gov.uk/
- GOV.UK Service Manual (form structure, accessibility): https://www.gov.uk/service-manual
- US Web Design System (design principles, step indicator, complete-a-complex-form patterns,
  typesetting and color tokens): https://designsystem.digital.gov/
- USDS Digital Services Playbook: https://playbook.usds.gov/
- 18F guides, community archive (Methods, Content Guide, UX Guide): https://guides.18f.org/
  (repos at https://github.com/18F)
