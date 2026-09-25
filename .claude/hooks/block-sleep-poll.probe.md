# Background-resume probe

The rule in `block-sleep-poll.mjs` and `CLAUDE.md`'s one-shot wait bullet rests on one harness behavior: a subagent that starts a background command and ends its turn is resumed with the command's result. Re-run this probe after a Claude Code upgrade, and record the date and build in the hook's header.

Run it from a session on a host with `timeout` on PATH (the dev container has it). Spawn it with the Agent tool, `subagent_type: general-purpose`, `model: sonnet`, and this prompt:

```text
You are a probe of the Claude Code harness, not a task. Do exactly this and nothing else:

1. Call the Bash tool once with run_in_background set to true and this command: timeout 60 sh -c 'sleep 20; echo PROBE-DONE'
2. Immediately end your turn. Your whole message is the single line: WAITING
3. If you are later handed that background command's result, reply with the single line: RESUMED <the command's output>, and end.

Do not wait, poll, sleep, or read any file.
```

The behavior holds when the spawning session receives two notifications under one task id: the first with the result `WAITING` and a note that the agent stopped with background work of its own still running and the result may be interim, the second, about 20 seconds later, with `RESUMED PROBE-DONE`. A single `WAITING` notification and nothing after it means the harness no longer resumes the agent, and the one-shot wait bullet goes back to foreground-only.

To probe a `Workflow` `agent()` call, give its agent the same prompt.
