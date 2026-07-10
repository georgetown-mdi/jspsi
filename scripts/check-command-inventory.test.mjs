import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  missingMentions,
  registeredCommands,
} from "./check-command-inventory.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

describe("command inventory check", () => {
  it("extracts every registered command from the real cliParser and skips $0", () => {
    const source = readFileSync(
      resolve(root, "apps/cli/src/cliParser.ts"),
      "utf8",
    );
    const commands = registeredCommands(source);
    expect(commands).toContain("init");
    expect(commands).toContain("verify-receipt");
    expect(commands).not.toContain("$0");
    expect(commands.length).toBeGreaterThanOrEqual(6);
  });

  it("passes on the real docs", () => {
    const source = readFileSync(
      resolve(root, "apps/cli/src/cliParser.ts"),
      "utf8",
    );
    const docTexts = Object.fromEntries(
      ["docs/DESIGN.md", "docs/CLI.md"].map((d) => [
        d,
        readFileSync(resolve(root, d), "utf8"),
      ]),
    );
    expect(missingMentions(registeredCommands(source), docTexts)).toEqual([]);
  });

  it("takes only the first token of a positional command signature", () => {
    const source = '.command(\n  "verify-receipt <record> [input-file]",\n)';
    expect(registeredCommands(source)).toEqual(["verify-receipt"]);
  });

  it("flags a command missing from a doc", () => {
    const missing = missingMentions(["init", "verify-receipt"], {
      "docs/DESIGN.md": "init only here",
    });
    expect(missing).toEqual([
      { doc: "docs/DESIGN.md", command: "verify-receipt" },
    ]);
  });
});
