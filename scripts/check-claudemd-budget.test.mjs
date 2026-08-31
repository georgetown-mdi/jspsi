import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUDGET_BYTES, budgetViolation } from "./check-claudemd-budget.mjs";

const here = dirname(fileURLToPath(import.meta.url));

describe("CLAUDE.md byte budget", () => {
  it("passes on the real CLAUDE.md", () => {
    const bytes = Buffer.byteLength(
      readFileSync(resolve(here, "..", "CLAUDE.md")),
    );
    expect(budgetViolation(bytes)).toBeNull();
  });

  it("allows a file exactly at the ceiling", () => {
    expect(budgetViolation(BUDGET_BYTES)).toBeNull();
  });

  it("fails one byte over, and says by how much", () => {
    const violation = budgetViolation(BUDGET_BYTES + 1);
    expect(violation).toContain("over the");
    expect(violation).toContain("by 1");
  });

  it("directs the overflow to relocation rather than deletion", () => {
    const violation = budgetViolation(BUDGET_BYTES + 500);
    expect(violation).toContain("Relocate");
    expect(violation).toContain("Do not delete a rule");
  });

  // The budget is a claim about bytes on disk, not characters: a multi-byte
  // character costs what it costs. Measuring the string length instead would
  // report a file over the budget as fitting.
  it("measures bytes, not characters", () => {
    const text = "é".repeat(BUDGET_BYTES);
    expect(Buffer.byteLength(text)).toBeGreaterThan(text.length);
    expect(budgetViolation(Buffer.byteLength(text))).not.toBeNull();
  });
});
