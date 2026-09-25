# Host hand-off brief template

A hand-off brief moves steps the orchestrating session cannot take itself -- ones that need the host machine or the owner's hands -- to a session on the host. That session reads `CLAUDE.md` but not `.claude/orchestration/ruleset.md`, so the rules it works under travel in the brief: copy the Contract section into every hand-off brief unchanged, then fill in the Brief section. Write the brief to a file under `scratch/` and give the host session its path.

## Contract

- Execute only. Carry out the steps below as written; do not re-plan, review, or widen them. A step that cannot be done as written stops the run, and the result file says where and why.
- No report. Do not summarize the work in the conversation.
- Write the result file named below: for each step, what ran and its outcome, and any value the orchestrator needs. The orchestrator reads that file; the owner does not carry context back.
- When the owner must act, give one step per message and wait for him to finish it before the next.
- Never use the question tool (AskUserQuestion). Anything the owner must answer goes in prose, one step at a time.

## Brief

- Goal: <one sentence>
- Result file: <absolute path under `scratch/` the orchestrator reads>
- Steps: <numbered; for a step the owner performs, what he does and what he sees when it worked>
- Context: <facts the steps need, each with the repository file or command that states it>
