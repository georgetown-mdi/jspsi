import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  builtInDefaultClaims,
  claimMismatches,
  declaredStringConstant,
  stunAuthority,
} from "./check-stun-default-claims.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");

const SOURCE_FILE = "apps/cli/src/connection/webrtc/weriftPeer.ts";
const WEB_COPY_FILE = "apps/web/src/recurring/managedCronExportModel.ts";
const PANEL_FILE = "apps/web/src/recurring/ManagedCronExportPanel.tsx";
const DOCS = [
  "docs/CLI.md",
  "docs/spec/DEPENDENCY_PINS.md",
  "docs/notes/cli-webrtc-stack.md",
];

describe("STUN default claim check", () => {
  it("reads the real constant and holds the real copies to it", () => {
    const uri = declaredStringConstant(
      read(SOURCE_FILE),
      "WERIFT_BUILT_IN_STUN_URI",
    );
    expect(uri).toMatch(/^stun:/);
    expect(
      declaredStringConstant(read(WEB_COPY_FILE), "CLI_BUILT_IN_STUN_URI"),
    ).toBe(uri);
    const authority = stunAuthority(uri);
    for (const doc of DOCS) {
      const text = read(doc);
      expect(builtInDefaultClaims(text).length).toBeGreaterThan(0);
      expect(claimMismatches(text, authority)).toEqual([]);
    }
  });

  it("catches an endpoint written back into the export panel's copy", () => {
    // The panel interpolates the constant, so its prose holds no endpoint of its
    // own; a literal put back into that sentence is what this scan exists for,
    // since a hard-coded copy leaves the constant tie unused.
    const panel = read(PANEL_FILE);
    expect(panel).toContain("CLI_BUILT_IN_STUN_URI");
    expect(builtInDefaultClaims(panel)).toEqual([]);
    expect(
      claimMismatches(
        "uses the built-in default (stun:moved.example:3478) to discover.",
        "stun.l.google.com:19302",
      ),
    ).toMatchObject([{ endpoint: "moved.example:3478" }]);
  });

  it("reports the endpoint that moved, with its line", () => {
    const text = read("docs/CLI.md");
    const [claim] = builtInDefaultClaims(text);
    expect(claim).toMatchObject({ endpoint: "stun.l.google.com:19302" });
    expect(claimMismatches(text, "stun.example.org:3478")).toEqual([claim]);
  });

  it("reads a claim written as a bare authority or as a stun: URI", () => {
    expect(
      builtInDefaultClaims("a built-in default (`stun:relay.example:19302`)."),
    ).toEqual([{ line: 1, endpoint: "relay.example:19302" }]);
    expect(
      builtInDefaultClaims("werift's built-in `relay.example:19302` default."),
    ).toEqual([{ line: 1, endpoint: "relay.example:19302" }]);
  });

  it("reads a claim that wraps across hard-wrapped lines", () => {
    expect(
      builtInDefaultClaims(
        "first line\ndoes not suppress werift's built-in\n`relay.example:19302` default.",
      ),
    ).toEqual([{ line: 2, endpoint: "relay.example:19302" }]);
  });

  it("leaves an example endpoint in a later sentence alone", () => {
    // The docs/CLI.md shape: the replace-not-add sentence names no endpoint, and
    // the no-STUN idiom two sentences on is an example, not the default.
    expect(
      builtInDefaultClaims(
        "A configured list replaces the built-in default rather than adding to it. " +
          "To gather host candidates only, give one unreachable entry, for example `stun:127.0.0.1:3478`.",
      ),
    ).toEqual([]);
  });

  it("stops reading at the window cap when no sentence ends", () => {
    expect(
      builtInDefaultClaims(
        `built-in default${" filler".repeat(40)} relay.example:19302`,
      ),
    ).toEqual([]);
  });

  it("fails loud rather than silent when the declaration moves", () => {
    expect(declaredStringConstant('export const OTHER = "x";', "GONE")).toBe(
      undefined,
    );
    expect(stunAuthority("https://example.org")).toBe(undefined);
    expect(stunAuthority("stun:host.example:19302")).toBe("host.example:19302");
  });
});
