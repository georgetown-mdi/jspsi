---
name: docket
description: Present the session's decision docket to the owner -- every open decision that is not a potential follow-up -- one decision per message, and record each ruling without executing it.
---

The owner's instruction this command stands for:

> Present each item in the decision docket that is not a potential follow-up,
> one message per item. Give me the context necessary to make the decision in
> plain language, options and their tradeoffs, and recommendations. Save
> executing decisions until I say so.

## First

If `.claude/orchestration/ruleset.md` is not already in your context, read it
before proceeding -- its decision rules are the ones this command applies.

## Build the list

Run only when the owner invokes this command; never start the docket unasked.

1. Collect every open decision the session holds for the owner. Leave out each
   potential follow-up -- a question of whether to file or update a board item;
   those wait for `/follow-ups`.
2. Drop any item the owner has already ruled on, in this session or in a board
   item or repository file.
3. One decision per item: an item holding two decisions is two items, never
   sub-questions under one.
4. Number the items once, as N of M, and keep that numbering to the end.

## Present, one message per item

Each message holds exactly one item and ends the turn:

- A heading: "Docket item N of M: <what is being decided, in words>".
- Background, in plain language: what exists, what is in question, and who it
  affects.
- The options, each with its effect on users and the product and its cost to
  development -- costs and benefits, not line counts.
- One recommended option, with its reason in a sentence or two.

Never open the item with AskUserQuestion, and never put a follow-up filing in a
docket message.

## Record, do not execute

Record each ruling as the owner gives it, then present the next item. Execute
nothing, and write nothing to the board, until the owner says so. When no item
is left, say so in one line.
