#!/usr/bin/env node
// Claude Code statusline: model | context usage | session cost | plan usage.
// Reads the statusline JSON payload on stdin, prints a single line.

import { statSync } from "node:fs";

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

// Local time, so it reads against a wall clock. Resolves from TZ in the
// environment Claude Code passes down (America/New_York here).
const formatClock = (date) =>
  date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

let raw = "";
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let status;
  try {
    status = JSON.parse(raw);
  } catch {
    process.stdout.write("statusline: unreadable payload");
    return;
  }

  const parts = [];

  const modelName = status.model?.display_name ?? status.model?.id ?? "model?";
  parts.push(
    /fable/i.test(modelName) ? `${RED}${modelName}${RESET}` : modelName,
  );

  const contextWindow = status.context_window;
  if (contextWindow && contextWindow.used_percentage != null) {
    const usage = contextWindow.current_usage;
    const usedTokens = usage
      ? usage.input_tokens +
        usage.cache_read_input_tokens +
        usage.cache_creation_input_tokens +
        usage.output_tokens
      : null;
    const windowSize = contextWindow.context_window_size;
    const percent = Math.round(contextWindow.used_percentage);
    const kilo = (n) => `${Math.round(n / 1000)}k`;
    const detail =
      usedTokens != null && windowSize
        ? `ctx ${percent}% (${kilo(usedTokens)}/${kilo(windowSize)})`
        : `ctx ${percent}%`;
    const color = percent >= 80 ? RED : percent >= 60 ? YELLOW : "";
    parts.push(color ? `${color}${detail}${RESET}` : detail);
  } else {
    parts.push("ctx --");
  }

  // The transcript is appended on every message, so its mtime is the last
  // conversation update -- and so the age of the prompt cache written with it.
  let lastUpdate = null;
  try {
    if (status.transcript_path)
      lastUpdate = statSync(status.transcript_path).mtimeMs;
  } catch {
    /* transcript not written yet */
  }

  // An absolute time, never a relative age or an age-derived color: the
  // statusline re-renders on conversation updates, not on a timer, so it is
  // frozen for the whole idle stretch this is meant to measure. A wall-clock
  // time stays true while stale; "idle 3s" would not. The prompt cache holds
  // for an hour past this (measured), which is a glance at a clock away.
  parts.push(
    lastUpdate == null
      ? "last --"
      : `last ${formatClock(new Date(lastUpdate))}`,
  );

  const totalCost = status.cost?.total_cost_usd;
  if (totalCost != null) parts.push(`$${totalCost.toFixed(2)}`);

  const fiveHour = status.rate_limits?.five_hour?.used_percentage;
  const sevenDay = status.rate_limits?.seven_day?.used_percentage;
  const planSpans = [];
  if (fiveHour != null) planSpans.push(`5h ${Math.round(fiveHour)}%`);
  if (sevenDay != null) planSpans.push(`7d ${Math.round(sevenDay)}%`);
  if (planSpans.length > 0) parts.push(planSpans.join(" "));

  process.stdout.write(parts.join(" | "));
});
