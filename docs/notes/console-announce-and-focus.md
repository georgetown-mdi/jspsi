---
title: "Announcing an Outcome in the Console"
---

# Announcing an outcome: one polite region, and focus reserved for repair

_Status: decided and built, by a 3-panelist design panel deciding 2-1. The convention is realized in `apps/web/src/components/useDeferredAnnouncement.ts` and its callers, including the SFTP authoring form's host-key probe (`apps/web/src/console/SftpAuthoringForm.tsx`). The structural properties that probe's failure surface has to hold are specified in [CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md); this note records why the mechanism is the one it is. See [docs/notes/README.md](README.md)._

An outcome surface in the console -- a probe result, a listing settle, a verdict -- has to reach an operator who is not looking at it. Two mechanisms had grown up side by side: a visually-hidden polite live region owned by the component holding the outcome, and, on the SFTP authoring form's host-key probe, a `role="alert"` on the visible alert plus a programmatic focus move onto it. Both are defensible in isolation; having both meant the same class of event announced by different means on different screens, and neither reading of the DOM told a reviewer which one a new surface should adopt. This note records the settlement.

## The convention

- **One channel announces.** A single always-mounted, visually-hidden polite live region (`role="status" aria-live="polite" aria-atomic="true"`), owned by the component that holds the outcome state, rendered in every phase -- empty before there is an outcome -- and placed ahead of the outcome surface's subtree. Its text is written in after mount, which is what `useDeferredAnnouncement` exists to guarantee.
- **A live region is always mounted ahead of its content.** A conditionally-mounted element never has a live role. A region that appears together with its text is a freshly inserted node rather than a change to something being observed, and what an assistive technology does with that is the browser's special-casing rather than the region's own semantics.
- **The region's text must transit a distinct value on every phase change** -- the in-flight sentence, or `""`. Setting a region to the string it already holds is not a change, so without that transit a second identical outcome is silent.
- **Programmatic focus is reserved for focus repair.** It moves only when the settle destroys the operator's focus anchor -- the anchor unmounted, or the control was disabled for the duration and the browser dropped focus to `<body>` -- and never as the announcer. A move is guarded on `document.activeElement` still being the anchor or `document.body`, so an operator who moved on during a long-running settle keeps their place.

## Why the region rather than the focus move

The focus move announces as a side effect: moving focus onto a container makes an assistive technology read that container. It is appealing here, because the probe's failure needs a keyboard user moved to the outcome anyway, and one mechanism doing both jobs is one mechanism to keep correct.

The majority's answer was that the two jobs fail differently. A focus move is a runtime action that can be blocked (a browser refusing focus to an element it does not consider focusable, a competing focus call arriving after it) or quietly unwired (a component library that stops forwarding its `ref` to the focusable root -- exactly what the previous `role="alert"` alert's move rested on). When it does not happen, the outcome is not announced at all and nothing else is holding the message. A stable pre-mounted region has no such single point: the text is in the DOM whether or not focus moved, and it is the mechanism the rest of the app's outcome surfaces already use, so conforming the remaining one is cheaper than diverging.

Splitting the jobs also makes the focus rule statable. Once the region announces, a focus move has exactly one remaining justification -- repair -- which is a condition a reader can check against the code, where "focus moves to announce" was a rule with no boundary and no answer for the operator who had moved on.

### The dissent

One panelist argued the opposite: that the focus move alone should announce, on the grounds that it both announces and moves the keyboard user in one action, and that a second channel is a second thing to keep in sync with the copy on screen. The majority did not dispute the coupling cost; it answered that a blocked or unwired focus call then leaves the outcome unannounced with no fallback, which is the worse of the two failures.

### The acknowledged risk

`role="alert"` on insertion is the form browsers and screen readers most reliably special-case -- it is the oldest and most widely implemented of the live-region behaviors. Swapping it for a polite region that is already mounted trades that special-casing for the general mechanism. No assistive technology is driven anywhere in this repository ([CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md) states this), so the swap is asserted against the DOM -- the region is present, mounted ahead of its content, and holds the console's sentence; the discarded mechanism is gone -- and not measured against any screen reader. Two things bound the risk. The focus-repair path is retained, so a keyboard user still lands on a presented result. And assertiveness is a property of the stable region: a maintainer who wants interruption sets `aria-live="assertive"` on it, without reintroducing a conditionally-mounted live role.

## Applied to the host-key probe

What the convention comes to on the SFTP authoring form's probe surface:

- The probe's own polite region is mounted in every phase, first in the result's DOM order, and holds a fixed console sentence per phase. It interpolates nothing, which is what makes the containment property [CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md) specifies structural rather than an escaping argument: no byte a peer chose can be in the announced run because no value reaches it at all.
- The visible failure alert has no live role. Mantine's `Alert` defaults to `role="alert"`, so the surface passes `role="presentation"` to displace that default rather than merely not passing it -- an attribute the convention makes inert is removed, never left in place asserting a behavior nothing holds. What holds the property is the ABSENCE of an alert or live role rather than the presentational role applying: ARIA's presentational-role-conflict resolution ignores `role="presentation"` on an element with global `aria-*` attributes, which Mantine sets on the alert root, so the element is exposed as generic. The prop stays required all the same -- drop it and the `role="alert"` default returns -- and the browser test measures that outcome (no alert or live role anywhere in the probe result) together with the assumption this reasoning rests on (the alert root does have those global attributes), rather than the presentational role itself.
- The failure settle restores focus to the probe trigger. That is repair, not announcement: the trigger is disabled while the probe runs, so the browser has already dropped focus to `<body>`.
- The presented-result panel has no live semantics either, but keeps its focus move, because that move is repair in the strict sense -- the trigger the operator pressed unmounts when the panel replaces it. The panel is named from its own visible lead line, so what focus lands on is not an anonymous `div`.

The region holds a summary sentence, not the diagnosis. A screen-reader user hears that the probe settled and that pasting remains available, and reads the alert for what answered the port. That is the price of a region that interpolates nothing, and it is paid by design -- the alternative would put console-derived text into the announced run and reopen the containment question the spec settles structurally.

### `outline: "none"` on a focus target is by design

The containers that take programmatic focus (the presented-result panel, and the secrets picker's stage, which established the pattern) set `tabIndex={-1}` and `style={{ outline: "none" }}`. `tabIndex={-1}` makes an element focusable by script only -- it is not in the tab order and not keyboard operable -- so WCAG 2.4.7 Focus Visible, which is about the keyboard focus indicator on the interactive controls a keyboard user tabs through, does not apply to it. Suppressing the outline is what keeps a scripted move from painting a focus ring around a whole panel that the user never navigated to; every control inside the panel keeps its own indicator.

## Considered and left alone

- **The peer-bytes excerpt's control-like chrome.** The field the peer's own first bytes render in is a read-only `Textarea`, which looks like something to type into. That is a separate question about how the excerpt presents, not about how the outcome announces, and the properties that attribute those bytes are specified and checked independently.
- **A lint or check enforcing the convention** -- for instance, one rejecting a live role on a conditionally-mounted element. Enforcement of a convention this new should be scoped on its own rather than built alongside the first surface that conforms to it.
