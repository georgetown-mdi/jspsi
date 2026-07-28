import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  ALLOWLIST,
  SCANNED_ROOTS,
  allowlistEntryFor,
  fileViolations,
  isScannedFile,
  scanRepo,
  stripComments,
  urlLiterals,
} from "./check-egress-claims.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Fixture paths under the scanned roots. Nothing here is read from disk: the
// scanner takes the source as text, so a matcher case is a string in this file
// rather than an edit to shipped code.
const FIXTURE = "apps/web/src/fixture.ts";

const urlsIn = (source) => urlLiterals(source).map((hit) => hit.url);

describe("URL literal matcher", () => {
  it("flags an unlisted absolute URL in a scanned root", () => {
    const v = fileViolations(
      FIXTURE,
      'const css = "https://fonts.example.com/css?family=Inter";\n',
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("apps/web/src/fixture.ts:1");
    expect(v[0]).toContain("https://fonts.example.com/css?family=Inter");
  });

  it("names PRIVACY.md and the claim at stake in the failure", () => {
    const [message] = fileViolations(
      FIXTURE,
      'fetch("https://telemetry.example/ping");\n',
    );
    expect(message).toContain("PRIVACY.md");
    expect(message).toContain("makes no other network connection");
    expect(message).toContain(
      "makes no request to any host other than the supporting services named below",
    );
  });

  it("passes an allowlisted URL", () => {
    expect(
      fileViolations(
        FIXTURE,
        'const ice = ["stun:stun.l.google.com:19302", "stun:44.247.30.68:443"];\n',
      ),
    ).toEqual([]);
  });

  it("reports the line the literal sits on", () => {
    const source = 'const a = 1;\n\nconst b = "https://evil.example/x";\n';
    expect(urlLiterals(source)).toEqual([
      { url: "https://evil.example/x", authority: "evil.example", line: 3 },
    ]);
  });

  it("does not trip on a scheme-only protocol comparison", () => {
    const source =
      'const protocol = isSecure(server) ? "https:" : "http:";\n' +
      'const port = window.location.protocol === "https:" ? 443 : 80;\n';
    expect(urlsIn(source)).toEqual([]);
  });

  it("does not trip on `stun:`/`turn:` as object-property syntax", () => {
    const source =
      "const schema = {\n" +
      "  stun: z.array(z.string()).optional(),\n" +
      "  turn: z.array(TurnServerSchema).optional(),\n" +
      "};\n";
    expect(urlsIn(source)).toEqual([]);
  });

  it("does not trip on a `/^turns?:/` scheme anchor", () => {
    const source =
      'z.string().regex(/^turns?:/, "bad");\nz.string().regex(/^stuns?:/, "bad");\n';
    expect(urlsIn(source)).toEqual([]);
  });

  it("does not trip on scheme names in error-message prose", () => {
    const source =
      'const message = "TURN URL must begin with turn: or turns:";\n';
    expect(urlsIn(source)).toEqual([]);
  });

  it("still flags a stun/turn URI that does name a host", () => {
    const source =
      'const relay = "turn:relay.example.net:3478?transport=udp";\n';
    expect(urlsIn(source)).toEqual([
      "turn:relay.example.net:3478?transport=udp",
    ]);
  });

  it("does not trip on an authority that is an immediate interpolation", () => {
    const source =
      "const origin = originOf(`http://${host}`);\n" +
      "const hostname = new URL(`http://${host}`).hostname;\n";
    expect(urlsIn(source)).toEqual([]);
  });

  it("still flags a literal host carrying an interpolated path", () => {
    const source = "await fetch(`https://evil.example/${path}`);\n";
    expect(urlLiterals(source).map((hit) => hit.authority)).toEqual([
      "evil.example",
    ]);
  });

  it("does not trip on an authority with no alphanumeric character", () => {
    const source =
      'placeholder="https://...#... or the bare code"\n' +
      'const scheme = "ws://, wss://, or file://";\n';
    expect(urlsIn(source)).toEqual([]);
  });

  it("matches an uppercase scheme", () => {
    expect(urlsIn('const u = "HTTPS://EVIL.EXAMPLE/x";\n')).toEqual([
      "HTTPS://EVIL.EXAMPLE/x",
    ]);
  });

  it("does not read a word ending in a scheme name as a URI", () => {
    expect(urlsIn('const note = "the call returns:2 rows";\n')).toEqual([]);
  });
});

describe("allowlist matching", () => {
  it("gives every entry a reason for why it is not egress", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.trim().length).toBeGreaterThan(20);
      expect(["exact", "prefix"]).toContain(entry.match);
    }
  });

  it("matches an exact entry only exactly", () => {
    expect(allowlistEntryFor("https://peerjs.com/")).toBeDefined();
    expect(
      allowlistEntryFor("https://peerjs.com.evil.example"),
    ).toBeUndefined();
    expect(allowlistEntryFor("https://peerjs.com/x")).toBeUndefined();
  });

  it("admits a prefix entry only at a path, query, or fragment boundary", () => {
    const ok = [
      "https://github.com/georgetown-mdi/jspsi",
      "https://github.com/georgetown-mdi/jspsi#readme",
      "https://github.com/georgetown-mdi/jspsi/blob/main/docs/CLI.md#recurring-exchange",
    ];
    for (const url of ok) expect(allowlistEntryFor(url)).toBeDefined();

    const rejected = [
      "https://github.com/georgetown-mdi/jspsi-exfil",
      "https://github.com/georgetown-mdi/jspsi.evil.example/x",
      "https://github.com/georgetown-mdi/other/blob/main/README.md",
      "https://gitlab.example/georgetown-mdi/jspsi/x",
    ];
    for (const url of rejected) expect(allowlistEntryFor(url)).toBeUndefined();
  });
});

describe("scanned files", () => {
  it("skips license and notice files", () => {
    const attribution =
      "Copyright (c) 2013 Michelle Bu and Eric Zhang, http://peerjs.com\n";
    expect(isScannedFile("apps/web/src/contrib/peerjs-server/LICENSE")).toBe(
      false,
    );
    expect(
      fileViolations("apps/web/src/contrib/peerjs-server/LICENSE", attribution),
    ).toEqual([]);
    expect(fileViolations("apps/web/src/notes.txt", attribution)).toHaveLength(
      1,
    );
  });

  it("skips binary assets but scans an unknown text format by default", () => {
    expect(isScannedFile("apps/web/public/favicon.ico")).toBe(false);
    expect(isScannedFile("apps/web/public/android-chrome-192x192.png")).toBe(
      false,
    );
    expect(isScannedFile("apps/web/public/logo.svg")).toBe(true);
    expect(isScannedFile("apps/web/public/index.html")).toBe(true);
    expect(isScannedFile("apps/web/public/site.webmanifest")).toBe(true);
    expect(isScannedFile("apps/web/src/bench/tokens.css")).toBe(true);
  });

  it("scans a test file that lands under a shipped-source root", () => {
    expect(isScannedFile("apps/web/src/psi/rendezvous.test.ts")).toBe(true);
    expect(
      fileViolations(
        "apps/web/src/psi/rendezvous.test.ts",
        'const endpoint = "https://fixtures.example/peer";\n',
      ),
    ).toHaveLength(1);
  });
});

describe("comment stripping", () => {
  it("drops a URL in a line comment", () => {
    expect(
      urlsIn("// A page the operator visits at http://attacker.example\n"),
    ).toEqual([]);
  });

  it("drops a URL in a block comment, including a backticked one", () => {
    const source =
      "/** Deep-link origin, e.g. `https://example.org:3000` (no trailing slash). */\n" +
      "/* TURN server URI (`turn:host` or `turns:host`). */\n";
    expect(urlsIn(source)).toEqual([]);
  });

  it("keeps a URL inside a string, whose `//` is not a comment start", () => {
    expect(urlsIn('const u = "https://evil.example/a";\n')).toEqual([
      "https://evil.example/a",
    ]);
    expect(urlsIn("const u = 'https://evil.example/b';\n")).toEqual([
      "https://evil.example/b",
    ]);
    expect(urlsIn("const u = `https://evil.example/c`;\n")).toEqual([
      "https://evil.example/c",
    ]);
  });

  it("keeps an unquoted URL, which a naive stripper eats as a comment", () => {
    expect(
      urlsIn("@font-face { src: url(https://fonts.example/i.woff2); }\n"),
    ).toEqual(["https://fonts.example/i.woff2"]);
    expect(urlsIn("Sitemap: https://evil.example/sitemap.xml\n")).toEqual([
      "https://evil.example/sitemap.xml",
    ]);
  });

  it("keeps a URL inside a quoted CSS data URI", () => {
    const source =
      "  --bench-check: url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\"/>');\n";
    expect(urlsIn(source)).toEqual(["http://www.w3.org/2000/svg"]);
    expect(fileViolations("apps/web/src/bench/tokens.css", source)).toEqual([]);
  });

  it("does not let an escaped slash in a regex blank the rest of the line", () => {
    const source =
      'const s = btoa(b).replace(/\\//g, "_"); const u = "https://evil.example/d";\n';
    expect(urlsIn(source)).toEqual(["https://evil.example/d"]);
  });

  it("keeps template text that follows an interpolation", () => {
    const source = "const u = `${base} // not a comment`;\n";
    expect(stripComments(source)).toBe(source);
  });

  it("strips a comment inside a template interpolation, braces and all", () => {
    // Without the interpolation's own brace depth, the `}` closing `{ x: 1 }`
    // reads as the end of the interpolation, and the block comment after it
    // reads as template text -- so its URL would survive as a false positive.
    expect(
      urlsIn(
        "const u = `${describe({ x: 1 }) /* see https://evil.example */}`;\n",
      ),
    ).toEqual([]);
  });

  it("preserves length and line breaks so line numbers survive", () => {
    const source = "a\n// comment\nb\n/* block\n   comment */\nc\n";
    const stripped = stripComments(source);
    expect(stripped).toHaveLength(source.length);
    expect(stripped.split("\n")).toHaveLength(source.split("\n").length);
    expect(stripped.split("\n")[2]).toBe("b");
  });
});

describe("the repository as it stands", () => {
  it("holds no URL literal outside the allowlist", () => {
    const { files, violations } = scanRepo(repoRoot);
    expect(violations).toEqual([]);
    expect(files.length).toBeGreaterThan(100);
  });

  it("strips comments and nothing else from every scanned source file", () => {
    // The stripper's fail-open direction: code blanked by a mis-read is code the
    // scan never sees, so a URL literal in it would pass unnoticed. Parsing each
    // file before and after stripping and printing both back with comments
    // suppressed is what catches that -- the two programs must be identical.
    const printer = ts.createPrinter({ removeComments: true });
    const canonical = (text, file) => {
      const parsed = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        false,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      return {
        printed: printer.printFile(parsed),
        parseErrors: parsed.parseDiagnostics.length,
      };
    };

    // `parseDiagnostics` is off the public SourceFile type, so probe it: a
    // TypeScript upgrade that renames it must redden here rather than report
    // every file error-free.
    expect(
      canonical("const a = ;\nfunction (\n", "probe.ts").parseErrors,
    ).toBeGreaterThan(0);
    expect(canonical("const a = 1;\n", "probe.ts").parseErrors).toBe(0);

    const sources = execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        ...SCANNED_ROOTS,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    )
      .split("\n")
      .filter((file) => /\.tsx?$/.test(file));
    expect(sources.length).toBeGreaterThan(100);

    const damaged = sources.filter((file) => {
      const source = readFileSync(resolve(repoRoot, file), "utf8");
      const stripped = stripComments(source);
      if (stripped.length !== source.length) return true;
      const before = canonical(source, file);
      const after = canonical(stripped, file);
      return (
        before.parseErrors !== after.parseErrors ||
        before.printed !== after.printed
      );
    });
    expect(damaged).toEqual([]);
  });
});
