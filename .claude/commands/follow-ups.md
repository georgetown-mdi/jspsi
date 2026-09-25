---
name: follow-ups
description: Decide the session's potential follow-ups with a PM consult, then do the board work in one pass -- filings, updates, the docket's consequences -- then housekeeping, and state any final action item no board item carries.
---

The owner's instruction this command stands for:

> For any potential follow-ups, form your own opinions on whether or not they
> should be filed, balancing their potential benefit to users and the product
> as a whole against their implementation and opportunity costs. Then consult
> with a PM. If you both agree, have the issues filed, ensuring that they
> receive an appropriate epic and implementation order. If any others issues
> are affected by a filing or work done in this session, ensure that they are
> properly updated. Try to do all of the board work in a single pass. Include
> consequences of decisions from the decision docket. After that is done, do
> any relevant housekeeping and state if there are any final action items that
> are not open questions carried on future project issues.

## First

If `.claude/orchestration/ruleset.md` is not already in your context, read it
before proceeding -- it holds the session rules this command's steps assume.

## Steps

Run only when the owner invokes this command; never start the board pass
unasked. Keep this pass in messages of its own, apart from any docket item.

1. List every potential follow-up the session turned up -- PR bodies, review
   dispositions, agent reports. For each, form your own opinion on whether to
   file it, weighing its benefit to users and the product against its
   implementation and opportunity costs.
2. Consult the PM once over the whole list, through a `project-manager` spawn
   that holds the list, your opinion on each, the consequences of the docket's
   rulings, and the owner's instruction above quoted verbatim. What the PM files
   on its own is bounded by the one-autonomous-filing cap in
   `.claude/pm/ruleset.md`, Filing and updating items: invoking this command
   does not by itself count as the owner's delegation for a batch, so a draft
   past the cap comes back to the owner for his word.
3. File only what you and the PM both agree on, each with an epic and an
   implementation order. Raise a disagreement with the owner rather than
   settling it.
4. In the same pass, update every open item that a filing, the session's work,
   or a docket ruling affects.
5. Do the relevant housekeeping; retiring a worktree follows the ruleset's
   Worktrees and checkouts section.
6. Report in a few lines what was filed and updated, and state any final
   action item that no board item carries.
