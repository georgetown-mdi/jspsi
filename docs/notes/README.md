# Design notes

Tracked but exploratory. Files here are working notes and design musings - they
capture reasoning and options under consideration, not decisions or
specifications. Nothing here is binding: a note may be folded into the formal
docs once a direction is actually chosen, or simply be discarded.

The maturity ladder:

- `scratch/` (gitignored) - personal, throwaway thinking, no audience.
- `docs/notes/` (here) - tracked, exploratory, citeable; no decision implied.
- `docs/` proper - the formal, living documentation, in two tiers:
  - `docs/` (overview) - conceptual and operational documents for program
    officers, security reviewers, compliance officers, IT staff, and new
    contributors.
  - `docs/spec/` - the technical specification tier: wire formats, byte
    encodings, protocol internals, and implementation-level design, written for
    implementors and auditors. See [`docs/spec/README.md`](../spec/README.md)
    for the index and routing guide.

Naming: notes use lowercase-kebab filenames to distinguish them at a glance from
the SCREAMING_CASE formal specs in `docs/` and `docs/spec/`.
