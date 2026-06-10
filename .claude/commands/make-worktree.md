---
name: make-worktree
description: Create a ready-to-use git worktree for psilink on a new (or existing) branch. Worktrees live under a gitignored .worktrees/ at the repo root; the command symlinks the gitignored locals a worktree needs, gives it an isolated SFTP test container (own Compose project name and free host port), and runs npm install. Does not touch GitHub and does not write code.
---

You are a setup agent for the psilink project. Your only job is to produce a working worktree and print a short summary. You do not write code or explore the codebase.

## Input

The user passes a branch name, optionally followed by a base ref:

    /make-worktree <branch> [base-ref]

- `<branch>`: the branch to create (or reuse). Keep it to lowercase letters, digits, and hyphens so it is also a valid git ref and Docker Compose project suffix. If the user gives something else, slugify it and report what you used.
- `[base-ref]`: the branch to fork from. Defaults to `staging`.

If no branch is given, ask for one before doing anything else.

## Why these steps exist

A git worktree already checks out every *tracked* file -- including the tracked `.claude/` tree (agents, commands, skills, scripts), so the worktree gets its own copy and can carry branch-local changes to it. What it does NOT get are the gitignored locals: `CLAUDE.local.md`, `apps/web/.env*`, and `.claude/settings.local.json`. Those are symlinked in individually.

The CLI integration tests run an SFTP container whose storage, host port, and Compose project name must be unique per checkout, or two checkouts clobber each other. This command gives each worktree its own. No special teardown is needed.

## Steps

Run every step with Bash. Do not read source files.

### 1. Resolve paths

    MAIN=/Users/vdorie/Repositories/mdi/psilink
    WORKTREE="$MAIN/.worktrees/<BRANCH>"

Worktrees live under `.worktrees/` at the repo root (gitignored), NOT under `.claude/`.

### 2. Create (or reuse) the worktree

New branch:

    git -C "$MAIN" worktree add "$WORKTREE" -b <BRANCH> <BASE>

If the branch already exists, drop `-b`:

    git -C "$MAIN" worktree add "$WORKTREE" <BRANCH>

If the worktree path already exists, report it and skip to step 5.

### 3. Symlink the gitignored locals

    ln -sf  "$MAIN/CLAUDE.local.md"               "$WORKTREE/CLAUDE.local.md"
    ln -sf  "$MAIN/apps/web/.env"                 "$WORKTREE/apps/web/.env"
    ln -sf  "$MAIN/apps/web/.env.development"     "$WORKTREE/apps/web/.env.development"
    ln -sf  "$MAIN/.claude/settings.local.json"   "$WORKTREE/.claude/settings.local.json"

Link only the gitignored locals. Do NOT symlink the whole `.claude` directory: it is tracked, so the worktree already has its own copy, and `ln -sf` onto that existing directory would nest the link inside it (`$WORKTREE/.claude/.claude`) rather than replace it. The worktree's checkout of `.claude/` already provides `settings.local.json`'s sibling files; only `settings.local.json` itself is gitignored and needs linking. Skip any symlink whose source does not exist and note the skip in the summary.

### 4. Give the worktree its own SFTP test container

    cd "$WORKTREE"
    sh apps/cli/test/container/setup.sh   # host keys, srv/, default .env

    PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})')
    printf 'COMPOSE_PROJECT_NAME=psilink-sftp-%s\nSFTP_PORT=%s\n' "<BRANCH>" "$PORT" \
      > apps/cli/test/container/.env

This gives the worktree its own Compose project and a free host port, so its container can run alongside the main checkout's. The integration tests read `SFTP_PORT` from this file.

### 5. Install dependencies

    cd "$WORKTREE" && npm install

### 6. Enter the worktree

Switch the session into the worktree with the `EnterWorktree` tool (this is a
tool call, not a Bash command):

    EnterWorktree({ path: "$WORKTREE" })

This makes the harness own the working directory, so the cwd persists across
turns and any subagents inherit it -- the continuing session then runs plain
commands in the worktree with no `cd`/`git -C` scoping. (CLAUDE.local.md is the
project-instruction authorization this tool requires.) If these setup steps ran
in an isolated subagent rather than the working session, the switch applies only
to that subagent; the working session must then call `EnterWorktree` itself.

### 7. Print the summary

Output this block and nothing after it:

    ## Worktree ready

    Path:   <worktree>
    Branch: <branch> (off <base>)

    Linked locals: <list, noting any skipped>
    SFTP container: project psilink-sftp-<branch>, host port <PORT> (isolated)

    This session is now inside the worktree (via EnterWorktree). Run plain
    commands here -- `git commit`, `npm test`, `npm run build` -- with no
    `cd`/`git -C` scoping; the cwd persists across turns and subagents inherit
    it. Only Read/Edit/Write still take worktree-absolute paths.

    To work here from a SEPARATE session instead:
      cd <worktree>
      claude

## What you do NOT do

- Do not read source files or make implementation decisions.
- Do not modify files in the worktree beyond the symlinks and the SFTP `.env`.
- Do not run builds or tests (npm install only).
