import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const STATUSLINE = fileURLToPath(new URL("./statusline.mjs", import.meta.url));

// Run it the way the harness does: the payload on stdin, one line on stdout. A
// statusline that exits nonzero or throws puts a stack trace where the line goes,
// so every case asserts the exit status too.
function render(payload) {
  const { status, stdout } = spawnSync("node", [STATUSLINE], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status, line: stdout };
}

const full = () => ({
  model: { display_name: "Opus 5" },
  context_window: {
    used_percentage: 42.4,
    context_window_size: 1000000,
    current_usage: {
      input_tokens: 1000,
      cache_read_input_tokens: 400000,
      cache_creation_input_tokens: 20000,
      output_tokens: 3000,
    },
  },
  cost: { total_cost_usd: 1.239 },
  rate_limits: {
    five_hour: { used_percentage: 12 },
    seven_day: { used_percentage: 33.6 },
  },
});

describe("statusline", () => {
  it("renders a full payload", () => {
    const { status, line } = render(full());
    expect(status).toBe(0);
    expect(line).toBe(
      "Opus 5 | ctx 42% (424k/1000k) | last -- | $1.24 | 5h 12% 7d 34%",
    );
  });

  it("falls back to the percentage when a usage subfield is missing", () => {
    const payload = full();
    delete payload.context_window.current_usage.cache_creation_input_tokens;
    const { status, line } = render(payload);
    expect(status).toBe(0);
    expect(line).toContain("ctx 42%");
    expect(line).not.toContain("NaN");
    expect(line).not.toContain("(");
  });

  it("renders placeholders for a payload carrying nothing", () => {
    const { status, line } = render({});
    expect(status).toBe(0);
    expect(line).toBe("model? | ctx -- | last --");
  });

  it("exits quietly on garbage stdin", () => {
    const { status, line } = render("}{ not json");
    expect(status).toBe(0);
    expect(line).toBe("statusline: unreadable payload");
  });
});
