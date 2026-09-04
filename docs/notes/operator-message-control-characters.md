---
title: "Control Characters in an Operator-Facing Message"
---

# Control characters in an operator-facing message: a per-value treatment, not a schema bound

_Status: decided and built. The control, where it sits, its marker, and the limits it does not close are specified in [CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md) (the compatibility-message composition, and the accept-time reconcile refusal); this note records why the mechanism is the one it is. See [docs/notes/README.md](README.md)._

Operator-facing text is escaped at ONE altitude, the display sink. That assignment is what keeps a backslash in a partner filename from reaching the operator doubled four times over, and it is not in question here. What it leaves open is narrower: a message composed as one link, whose OWN structure is a control character, is escaped together with the values it names, so the escape renders the composition's line break and a value's own to the same visible token. The delimiting quotation does not distinguish them either -- it bounds what a value can do in the message's printable structure, and a line break is not printable.

## Which closer

Two were available, and the difference between them is reach rather than strength.

- **A charset bound on the schema**, narrowing the linkage-field-name field so a control character cannot enter a terms document at all.
- **A per-value treatment at composition**, replacing the control characters where the value is interpolated, beside the redaction and delimiting already applied there.

The second was adopted, on two grounds.

The first covers every renderer at once but only for the field it bounds. The same first-party clauses name rule-set set names, legal-agreement references, payload column names and descriptions, and an online accept's connection locators, each free text a partner chooses; bounding one field would leave the class open at every other, and bounding all of them is a charset decision taken separately for each. The treatment covers any value the composition renders, which is the whole class by construction, because the composition is the only way a value enters one of these clauses -- a brand the compiler enforces, not a convention.

And a charset bound is a BREAKING narrowing of a document format two parties already exchange. A field name is free text an agency writes in the language its data dictionary is written in; a bound narrow enough to exclude a line break by naming an allowed set excludes a great deal of legitimate naming with it, and one that names only the control class to exclude is the same rule as the treatment, applied where it rejects a document instead of where it renders one. Rejecting is the wrong fate for a display concern: the values are compared, hashed, and agreed byte-exact, so a document a partner can author and this party refuses to render is a document the exchange cannot proceed on for a reason that lives entirely in a message.

## Why replacement rather than escaping

The treatment REPLACES rather than escapes, and the distinction is what keeps the single-altitude rule intact. Its output is printable ASCII with no backslash in it, so the sink's one pass finds nothing left to rewrite and nothing is doubled. That is the same shape as the private-key redaction the composition sites already run, and it is why the marker cannot be built out of the escape's own alphabet: a marker spelled `\x0a` would be spelled by exactly the bytes it exists to be distinguishable from, since the escape doubles a literal backslash and a value spelling an escape sequence arrives showing two.

## The cost accepted

Fidelity, in the direction the escape already costs it. An operator reading a value that held a line break sees a marker naming the code point rather than the character, and a value that spells the marker's own text renders as one that held it. That second reading is unclosable in printable ASCII and is the open class the truncation marker already has; what it leaves an operator is the converse -- a control character psilink itself composed still renders as the escape's own token, and no value can produce that.

The same ambiguity decides how far a cut backs off out of a marker. Backing off is keyed on the marker's SHAPE, which a value's own bytes can spell, so the choice is between two ways of being wrong about a value that spells it: back off once and a fitted value can end in marker-shaped bytes of its own, or back off until nothing matches and a value that is nothing but the shape loses all of it, rendering as the truncation marker alone at a budget that would have shown the same width of anything else. The first was taken. A shown value displaying as some of its own bytes is the floor every fit here is built around, and the fragment the back-off exists to prevent is only ever one marker wide -- a whole marker ends in a character no prefix of one holds, so one back-off is all a cut can call for.
