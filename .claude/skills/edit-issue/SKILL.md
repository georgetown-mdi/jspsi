---
name: edit-issue
description: Update draft items on the psilink GitHub project board -- change the status, title, or body of a draft issue. Use for requests like "mark item 123456 as In Progress on the product board" or "update the title of item 789 on the release board". Wraps edit-issue.mjs so you need not hand-write its syntax.
compatibility: Requires Node.js and .claude/scripts/edit-issue.mjs in the psilink repository.
---

# Edit GitHub Project Draft Issue

Update a draft item on a psilink GitHub project board without learning the script syntax.

## Basic usage

Provide:

- **project**: The numeric project ID -- `9` for the product board, `10` for release & operations. The script takes a number only; a friendly name is rejected, so map the board the user names to its number.
- **itemId**: The numeric draft item ID (the `?itemId=N` URL parameter)
- **At least one field to update**: `status`, `title`, or `body`

### Project mapping

- **Product board**: `9`
- **Release & Operations board**: `10`

## Common fields and values

**Status** -- the valid options differ by board (the board's field is the source of truth):

- **Product board (9)**: `"Backlog"`, `"In Progress"`, `"Review"`, `"Done"`
- **Release & Operations board (10)**: `"Todo"`, `"In Progress"`, `"Done"`

**Title** -- any string (will be trimmed)

**Body** -- the draft item's body text; supports Markdown

## How the skill works

The skill constructs and runs:

```
node .claude/scripts/edit-issue.mjs <project> <itemId> [--status "..."] [--title "..."] [--body "..."]
```

Only the fields you provide are included in the command. If the edit succeeds, the output from the script is displayed.

## Examples

**Update status:**

```
Project: 9
ItemId: 193732227
Status: In Progress
```

**Update title and body:**

```
Project: 10
ItemId: 194023493
Title: Fix WebRTC teardown on disconnect
Body: Close peer connections cleanly without leaving dangling listeners.
```

## Error handling

If the command fails (e.g., invalid itemId, missing project), the script's error output is shown. Check:

- Project number is correct (`9` or `10`)
- ItemId is a valid number (no `?itemId=` prefix)
- You have permissions to edit the board (usually automatic for team members)
