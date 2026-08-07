# Design notes

Tracked, citeable design records: the model behind a mechanism, the options
weighed, and the decisions taken. Nothing here is normative -- a note binds no
implementation, and points at the spec for the normative rows rather than
restating them. A note carries a status line stating where its subject stands,
from a direction still open to a decision taken and built.

The maturity ladder:

- `scratch/` (gitignored) - personal, throwaway thinking, no audience.
- `docs/notes/` (here) - tracked, citeable design records; non-normative.
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
