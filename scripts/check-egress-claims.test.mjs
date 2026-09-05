import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  ALLOWLIST,
  SCANNED_FILES,
  SCANNED_ROOTS,
  allowlistEntryFor,
  fileViolations,
  isJavaScriptFamily,
  isScannedFile,
  scanRepo,
  urlLiterals,
} from "./check-egress-claims.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Bound for the describes below whose cases scan `repoRoot`: they walk the whole
// working tree, and the parser guard among them parses every JavaScript-family
// source in it a second time. Alone on an idle container the heaviest runs 3.8s
// against vitest's 5s default -- and 11.4s with the rest of the suite competing
// for the same cores, which is the contention that reddened it. Sized at roughly
// five times that worst measurement, this stays a hang safety check -- an extractor
// that loops, or a walk that never terminates, still fails here -- rather than
// an assertion about how fast the scan runs.
const SCAN_TIMEOUT_MS = 60_000;

// Fixture paths under the scanned roots. Nothing here is read from disk: the
// scanner takes the source as text, so a matcher case is a string in this file
// rather than an edit to shipped code.
const FIXTURE = "apps/web/src/fixture.ts";

const urlsIn = (source, path = FIXTURE) =>
  urlLiterals(source, path).map((hit) => hit.url);

// What the TypeScript parser makes of a source text: the cooked value of every
// string and no-substitution template literal in it, and whether it parses at
// all. The check reads literals from a parse, so the parser is the oracle for
// what a case's source actually holds rather than what it looks like it holds.
const parseOf = (source, scriptKind = ts.ScriptKind.TS) => {
  const parsed = ts.createSourceFile(
    "fixture",
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKind,
  );
  const literals = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.push(node.text);
    }
    node.forEachChild(visit);
  };
  visit(parsed);
  return { literals, parseErrors: parsed.parseDiagnostics.length };
};

const LITERAL = 'const u = "https://evil.example/x";\n';

// One file for every scanned pathspec, which is what a repository has to hold
// for the scan to resolve at all.
const SKELETON = [
  ...SCANNED_ROOTS.map((root) => `${root}/entry.ts`),
  ...SCANNED_FILES,
];

// A throwaway repository holding the skeleton plus whatever paths a case adds,
// so real git decides which of them each pathspec matches.
const withScannedRepo = (extraFiles, run) => {
  const dir = mkdtempSync(resolve(tmpdir(), "egress-scan-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    for (const file of [...SKELETON, ...extraFiles]) {
      mkdirSync(resolve(dir, dirname(file)), { recursive: true });
      writeFileSync(resolve(dir, file), LITERAL);
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

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
    expect(urlLiterals(source, FIXTURE)).toEqual([
      { url: "https://evil.example/x", host: "evil.example", line: 3 },
    ]);
  });

  it("reports the line a literal several nodes into a file sits on", () => {
    // Positions come from the parse rather than from a scan of the text, so a
    // literal reached after comments, JSX prose, and a multi-line template
    // still has to name the line it is written on.
    const source =
      "// https://commented.example/a\n" +
      "const banner = `first\n" +
      "  second`;\n" +
      "export const A = () => (\n" +
      "  <p>\n" +
      "    files under data/* are read\n" +
      "  </p>\n" +
      ");\n" +
      'const u = "https://evil.example/x";\n';
    expect(urlLiterals(source, "apps/web/src/f.tsx")).toEqual([
      { url: "https://evil.example/x", host: "evil.example", line: 9 },
    ]);
  });

  it("names a rewritten literal's own line, not the line inside it", () => {
    // The limit candidateOf has: a literal the parser rewrote -- one
    // holding any escape -- spells no offsets of its own, so a URL further
    // into the same multi-line template is reported at the line that literal
    // begins on. The hit and its host are unaffected, and a literal the file
    // spells verbatim still reports the line the URL sits on.
    const escaped =
      "const banner = `cost: \\$5\n" +
      "  a second line\n" +
      "  https://evil.example/x`;\n";
    expect(urlLiterals(escaped, FIXTURE)).toEqual([
      { url: "https://evil.example/x", host: "evil.example", line: 1 },
    ]);
    expect(urlLiterals(escaped.replace("\\$5", "$5"), FIXTURE)).toEqual([
      { url: "https://evil.example/x", host: "evil.example", line: 3 },
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

  it("still flags a stun/turn host written behind slashes", () => {
    // stun and turn URIs have no `//` (RFC 7064, RFC 7065), so a slash before
    // the host is stray punctuation around a real one.
    expect(
      urlsIn(
        'const ice = ["turn://relay.evil.example:3478?transport=udp",\n' +
          '  "stun:/relay.evil.example:3478",\n' +
          '  "turns:///relay.evil.example:5349"];\n',
      ),
    ).toEqual([
      "turn://relay.evil.example:3478?transport=udp",
      "stun:/relay.evil.example:3478",
      "turns:///relay.evil.example:5349",
    ]);
    expect(
      urlLiterals('const u = "stun:/relay.evil.example:3478";\n', FIXTURE)[0]
        .host,
    ).toBe("relay.evil.example");
  });

  it("does not trip on a stun/turn scheme with slashes and no host", () => {
    expect(
      urlsIn('const prefixes = ["stun://", "turn:/", "turns:"];\n'),
    ).toEqual([]);
  });

  it("does not trip on an authority that is an immediate interpolation", () => {
    const source =
      "const origin = originOf(`http://${host}`);\n" +
      "const hostname = new URL(`http://${host}`).hostname;\n" +
      "const authority = `http://${host}:${port}/api`;\n";
    expect(urlsIn(source)).toEqual([]);
  });

  it("still flags a literal host beside an interpolation", () => {
    // The skip above is for an authority naming whatever an expression
    // evaluates to. A per-tenant host is not that: the interpolation is a
    // subdomain and the registrable name beside it is the literal host.
    expect(
      urlLiterals(
        "await fetch(`https://${tenant}.evil.example/report`);\n",
        FIXTURE,
      ),
    ).toEqual([
      {
        url: "https://${tenant}.evil.example/report",
        host: ".evil.example",
        line: 1,
      },
    ]);
    expect(
      urlsIn("await fetch(`http://${format({ a: 1 })}.evil.example`);\n"),
    ).toEqual(["http://${format({ a: 1 })}.evil.example"]);
  });

  it("still flags a literal host with an interpolated path", () => {
    const source = "await fetch(`https://evil.example/${path}`);\n";
    expect(urlLiterals(source, FIXTURE).map((hit) => hit.host)).toEqual([
      "evil.example",
    ]);
  });

  it("does not read a literal port as the host an interpolation hides", () => {
    // A port is the one literal that survives a fully interpolated authority,
    // and `new URL()` rejects anything but digits there, so nothing a host
    // could be written into is dropped with it.
    expect(() => new URL("https://a:evil.example")).toThrow();
    expect(urlsIn("await fetch(`https://${host}:8443/x`);\n")).toEqual([]);
    expect(urlsIn("await fetch(`stun:${host}:3478`);\n")).toEqual([]);
    expect(
      urlsIn("await fetch(`https://${tenant}.evil.example:8443/x`);\n"),
    ).toEqual(["https://${tenant}.evil.example:8443/x"]);
    expect(urlsIn('await fetch("https://evil.example:8443/x");\n')).toEqual([
      "https://evil.example:8443/x",
    ]);
  });

  it("drops the port only where an interpolation ate the host", () => {
    // The port rule exists for the authority a template interpolates away.
    // Where nothing was interpolated there is no such authority to rescue, so
    // an authority of nothing but a port is host-shaped text the parser
    // rejects, and is reported rather than skipped.
    expect(() => new URL("https://:8443/x")).toThrow();
    expect(urlsIn('await fetch("https://:8443/x");\n')).toEqual([
      "https://:8443/x",
    ]);
    expect(urlsIn("await fetch(`https://${host}:8443/x`);\n")).toEqual([]);
  });

  it("reads a literal as the value it evaluates to", () => {
    // The regex-escaped spelling: `\/` is an escape the language removes, so
    // the string a regular expression is built from holds a plain URL. The
    // parser is what says so, and the check reads the same cooked value.
    const source = 'const p = new RegExp("https:\\/\\/evil.example/x");\n';
    expect(parseOf(source).literals).toEqual(["https://evil.example/x"]);
    expect(urlsIn(source)).toEqual(["https://evil.example/x"]);
  });

  it("reads `${` as literal text where the parser says nothing interpolates", () => {
    // The node kind decides, not the characters: in a single-quoted string and
    // in a JSX attribute value the braces are text, and `new URL()` resolves
    // the authority they spell to a non-empty host.
    expect(new URL("https://${host}/x").hostname).toBe("${host}");
    for (const [source, path] of [
      ["const u = 'https://${host}/x';\n", FIXTURE],
      [
        'export const A = <img src="https://${host}/x" />;\n',
        "apps/web/src/f.tsx",
      ],
    ]) {
      expect([path, urlsIn(source, path)]).toEqual([
        path,
        ["https://${host}/x"],
      ]);
      expect([path, urlLiterals(source, path)[0].host]).toEqual([
        path,
        "${host}",
      ]);
    }
    // The same text where the parser does call it an interpolation.
    expect(urlsIn("const u = `https://${host}/x`;\n")).toEqual([]);
  });

  it("cannot read a literal past the node holding it", () => {
    // An unbalanced `${` inside a URL literal is where a scan of the file's
    // characters loses its footing and runs to the end of the file, including
    // every following line in the failure message. A literal ends where its
    // node does, so the message names that literal and nothing after it.
    const source =
      'const u = "https://evil.example/${";\n' +
      'const v = "a second line";\n' +
      'const w = "https://other.example/y";\n';
    expect(urlsIn(source)).toEqual([
      "https://evil.example/${",
      "https://other.example/y",
    ]);
    const [message] = fileViolations(FIXTURE, source);
    expect(message).toContain("`https://evil.example/${`");
    expect(message).not.toContain("a second line");
  });

  it("does not trip on an authority written entirely of dots", () => {
    // How elided placeholder text spells a URL. `new URL()` does resolve the
    // shape to a host, so this is a knowing skip, stated in the header.
    expect(new URL("https://.../").host).toBe("...");
    expect(urlsIn('placeholder="https://...#... or the bare code"\n')).toEqual(
      [],
    );
  });

  it("matches the schemes it names and no others", () => {
    // The header's scheme limit, which PRIVACY.md and SECURITY_DESIGN.md
    // state in turn: a `wss://` beacon names a host and is not reported.
    for (const scheme of ["ws", "wss", "ftp", "file"]) {
      expect(
        urlsIn(
          `new WebSocket("${scheme}://analytics.evil.example/collect");\n`,
        ),
      ).toEqual([]);
    }
    for (const scheme of ["http", "https", "stun", "stuns", "turn", "turns"]) {
      const literal = `${scheme}://analytics.evil.example/collect`;
      expect(urlsIn(`new WebSocket("${literal}");\n`)).toEqual([literal]);
    }
  });

  it("flags an internationalized host, which resolves like any other", () => {
    // Only the spelling in source is non-ASCII: the host a request reaches is
    // the punycode form `new URL()` produces, which resolves and serves.
    for (const [host, resolved] of [
      ["пример.рф", "xn--e1afmkfd.xn--p1ai"],
      ["例え.テスト", "xn--r8jz45g.xn--zckzah"],
      ["中国.中国", "xn--fiqs8s.xn--fiqs8s"],
      ["مثال.إختبار", "xn--mgbh0fb.xn--kgbechtv"],
    ]) {
      const literal = `https://${host}/collect`;
      expect(new URL(literal).host).toBe(resolved);
      expect(urlsIn(`fetch("${literal}");\n`)).toEqual([literal]);
    }
  });

  it("flags a bracketed address holding no alphanumeric", () => {
    for (const [literal, host] of [
      ["https://[::]/x", "[::]"],
      ["http://[::]:8443/x", "[::]:8443"],
    ]) {
      expect(new URL(literal).host).toBe(host);
      expect(urlsIn(`fetch("${literal}");\n`)).toEqual([literal]);
    }
  });

  it("reports host-shaped text that `new URL()` rejects", () => {
    // The loud direction, stated in the header: the parser is the host oracle
    // for the authorities it accepts, and the ones it refuses are their own
    // reported class rather than a silence, so a literal nothing could
    // dereference can still fail the build. The author rewrites or allowlists
    // it. A hit reports no host for these, because no parser resolved one.
    for (const literal of [
      "https://%zz/",
      "https://[not-ipv6]/",
      "https://[2001:db8::1",
      "https://a:b/",
      "https://ex^ample/",
      "https://exa|mple/",
    ]) {
      expect(() => new URL(literal)).toThrow();
      expect(urlsIn(`fetch("${literal}");\n`)).toEqual([literal]);
      expect(urlLiterals(`fetch("${literal}");\n`, FIXTURE)[0].host).toBe(
        undefined,
      );
    }
  });

  it("skips an empty web authority but not a short or bracketed one", () => {
    expect(
      urlsIn(
        'const u = "https:";\nconst v = "https://";\nconst w = "https:////";\n',
      ),
    ).toEqual([]);
    for (const empty of ["https:", "https://", "https:///", "https:////"]) {
      expect(() => new URL(empty)).toThrow();
    }
    expect(
      urlsIn(
        'const u = "https://a/";\nconst v = "http://[2001:db8::1]:8080/x";\n' +
          'const w = "https://evil.example//double";\n',
      ),
    ).toEqual([
      "https://a/",
      "http://[2001:db8::1]:8080/x",
      "https://evil.example//double",
    ]);
  });

  it("reads the authority through any slash count, as `new URL()` does", () => {
    // The slash count has nothing the matcher may lean on: the real parser
    // resolves every spelling to the same host, and a real fetch() of the
    // http: forms against a loopback server reaches it in each one. Reading
    // any of them as a protocol comparison instead lets a shipped
    // `fetch("https:analytics.example/collect")` pass the build.
    for (const slashes of ["", "/", "//", "///", "////"]) {
      const literal = `https:${slashes}evil.example/x`;
      expect(new URL(literal).host).toBe("evil.example");
      expect(urlsIn(`const u = "${literal}";\n`)).toEqual([literal]);
    }
    // `https:///path` is a host named `path`, not the empty authority its
    // shape suggests.
    expect(new URL("https:///path").host).toBe("path");
    expect(urlLiterals('const u = "https:///path";\n', FIXTURE)).toEqual([
      { url: "https:///path", host: "path", line: 1 },
    ]);
  });

  it("reads a slashless authority in every delivery shape", () => {
    const shapes = [
      ["const u = 'https:evil.example/t';\n", FIXTURE, "https:evil.example/t"],
      ['const u = "https:evil.example/t";\n', FIXTURE, "https:evil.example/t"],
      ["const u = `https:evil.example/t`;\n", FIXTURE, "https:evil.example/t"],
      [
        'export const s = <script src="https:evil.example/t" />;\n',
        "apps/web/src/fixture.tsx",
        "https:evil.example/t",
      ],
      [
        "@font-face { src: url(https:evil.example/t); }\n",
        "apps/web/src/fixture.css",
        "https:evil.example/t",
      ],
      ['const u = "HTTPS:evil.example/t";\n', FIXTURE, "HTTPS:evil.example/t"],
      [
        "await fetch(`https:${tenant}.evil.example/t`);\n",
        FIXTURE,
        "https:${tenant}.evil.example/t",
      ],
      [
        'const u = "http:[2001:db8::1]:8080/t";\n',
        FIXTURE,
        "http:[2001:db8::1]:8080/t",
      ],
    ];
    for (const [source, path, expected] of shapes) {
      expect([source, urlsIn(source, path)]).toEqual([source, [expected]]);
    }
  });

  it("matches a scheme in any case", () => {
    expect(
      urlsIn(
        'const u = "HTTPS://EVIL.EXAMPLE/x";\nconst v = "HtTp://evil.example/y";\n' +
          'const w = "TURN:relay.evil.example:3478";\n',
      ),
    ).toEqual([
      "HTTPS://EVIL.EXAMPLE/x",
      "HtTp://evil.example/y",
      "TURN:relay.evil.example:3478",
    ]);
  });

  it("does not read a word ending in a scheme name as a URI", () => {
    expect(urlsIn('const note = "the call returns:2 rows";\n')).toEqual([]);
  });

  it("reads a scheme that punctuation rather than a word precedes", () => {
    const source =
      'const a = "?next=https://evil.example/one";\n' +
      'const b = await import("https://evil.example/two.js");\n' +
      'const c = "srcset:https://evil.example/three 2x";\n' +
      "const d = `${origin}https://evil.example/four`;\n";
    expect(urlsIn(source)).toEqual([
      "https://evil.example/one",
      "https://evil.example/two.js",
      "https://evil.example/three",
      "https://evil.example/four",
    ]);
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
    expect(isScannedFile("packages/peerjs-broker/src/contrib/LICENSE")).toBe(
      false,
    );
    expect(
      fileViolations("packages/peerjs-broker/src/contrib/LICENSE", attribution),
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
    expect(isScannedFile("apps/web/src/styles/tokens.css")).toBe(true);
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

  it("skips a notice file only on its whole basename", () => {
    const attribution = 'const u = "https://evil.example/x";\n';
    for (const near of [
      "apps/web/src/LICENSE-INDEX.md",
      "apps/web/src/THIRD-PARTY-NOTICE.md",
      "apps/web/src/licenses.ts",
      "apps/web/src/notice.txt",
      "apps/web/src/vendor/LICENSE.ts",
    ]) {
      expect(isScannedFile(near)).toBe(true);
      expect(fileViolations(near, attribution)).toHaveLength(1);
    }
  });

  it("skips a file only on a blocklisted extension", () => {
    const literal = 'const u = "https://evil.example/x";\n';
    expect(isScannedFile("apps/web/public/psi.wasm")).toBe(false);
    expect(isScannedFile("apps/web/public/ICON.PNG")).toBe(false);
    for (const text of [
      "apps/cli/src/entry", // extensionless
      "apps/web/src/routes/index.tsx",
      "apps/web/public/robots.txt",
      "apps/web/public/manifest.json",
      "apps/web/src/worker.mjs",
      "apps/web/public/icon.png.ts",
      "apps/web/src/README.md",
    ]) {
      expect(isScannedFile(text)).toBe(true);
      expect(fileViolations(text, literal)).toHaveLength(1);
    }
  });

  it("reports a URL in a text format whose comment syntax is not modeled", () => {
    // No parser is run for these, and guessing at their comment syntax is what
    // would report a file clean: a `//` or `/*` in ordinary content treated as a
    // comment opener takes the rest of the line, and the URL in it, out of the
    // scan. They are scanned raw for that reason.
    const cases = [
      [
        "apps/web/public/index.html",
        '<p>a // b</p><script src="https://evil.example/a.js"></script>\n',
        "https://evil.example/a.js",
      ],
      [
        "apps/web/public/logo.svg",
        '<svg><image href="https://evil.example/b.png" /><!-- a // b --></svg>\n',
        "https://evil.example/b.png",
      ],
      [
        "apps/web/src/README.md",
        "Files: src/*.ts\n\nSee https://evil.example/c for more.\n",
        "https://evil.example/c",
      ],
      [
        "apps/web/public/robots.txt",
        "# a // b\nSitemap: https://evil.example/d.xml\n",
        "https://evil.example/d.xml",
      ],
      [
        "docker-entrypoint.sh",
        '# a // b\nexec curl "https://evil.example/e" "$@"\n',
        "https://evil.example/e",
      ],
      [
        "apps/web/src/styles/tokens.css",
        "a { b: c } // https://evil.example/f\n",
        "https://evil.example/f",
      ],
    ];
    for (const [path, source, expected] of cases) {
      expect(isJavaScriptFamily(path)).toBe(false);
      expect([path, urlsIn(source, path)]).toEqual([path, [expected]]);
      expect(fileViolations(path, source)).toHaveLength(1);
    }
  });

  it("scans a stylesheet raw, its block comments included", () => {
    // A URL inside a CSS comment is reported: the loud direction, which an
    // author resolves with an allowlist entry. A reader written from CSS
    // comment rules rather than the whole grammar fails the other way -- a
    // backslash line continuation inside a string is enough to make one take
    // real declarations, and the literals in them, out of the scan.
    const path = "apps/web/src/styles/tokens.css";
    const source =
      "/* see https://commented.example/x */\n" +
      "a { background: url(https://evil.example/y) }\n";
    expect(isJavaScriptFamily(path)).toBe(false);
    expect(urlsIn(source, path)).toEqual([
      "https://commented.example/x",
      "https://evil.example/y",
    ]);
    expect(fileViolations(path, source)).toHaveLength(2);
  });

  it("reads no URL out of a comment in any JavaScript-family extension", () => {
    for (const ext of [
      ".cjs",
      ".cts",
      ".js",
      ".jsx",
      ".mjs",
      ".mts",
      ".ts",
      ".tsx",
    ]) {
      const path = `apps/web/src/fixture${ext}`;
      expect(isJavaScriptFamily(path)).toBe(true);
      expect(
        urlsIn(
          "// https://a.example/x\n/* https://b.example/y */\n" +
            'const u = "https://evil.example/z";\n',
          path,
        ),
      ).toEqual(["https://evil.example/z"]);
    }
  });
});

describe("scanned roots", { timeout: SCAN_TIMEOUT_MS }, () => {
  it("covers the entrypoint that runs inside the container", () => {
    // PRIVACY.md's container claim is about what the running image connects
    // to, and this script is the image's ENTRYPOINT; the Dockerfile beside it
    // decides what the build fetches into that image.
    const dockerfile = readFileSync(resolve(repoRoot, "Dockerfile"), "utf8");
    expect(/^ENTRYPOINT\s+\["\/app\/(\S+?)"\]/m.exec(dockerfile)[1]).toBe(
      "docker-entrypoint.sh",
    );
    const { files } = scanRepo(repoRoot);
    expect(files).toContain("docker-entrypoint.sh");
    expect(files).toContain("Dockerfile");
  });

  it("scans a named file and not a sibling sharing its name", () => {
    // Same real-git question the tree test below asks, for the file
    // pathspecs: whether `Dockerfile` also admits `Dockerfile.dev`.
    withScannedRepo(["Dockerfile.dev", "docker-entrypoint.sh.bak"], (dir) => {
      const { files, violations } = scanRepo(dir);
      expect(files).toEqual([...SKELETON].sort());
      expect(violations).toHaveLength(SKELETON.length);
    });
  });

  it("covers the server entry point the deployed web app boots", () => {
    // Nitro builds the deployed server around this entry, so a URL literal
    // reached during server boot is as shipped as anything under src/.
    const nitro = readFileSync(
      resolve(repoRoot, "apps/web/nitro.config.ts"),
      "utf8",
    );
    const entry = /\bentry:\s*"([^"]+)"/.exec(nitro);
    expect(entry).not.toBeNull();
    const entryPath = `apps/web/${entry[1].replace(/^\.\//, "")}`;
    expect(SCANNED_ROOTS.some((root) => entryPath.startsWith(`${root}/`))).toBe(
      true,
    );
    expect(scanRepo(repoRoot).files).toContain(entryPath);
  });

  it("scans a root's own tree and not a sibling sharing its prefix", () => {
    // Driven against real git rather than a model of its pathspec matching,
    // which is what decides whether `apps/web/server` also admits
    // `apps/web/server-extras`.
    const siblings = [
      "apps/web/server-extras/side.ts",
      "apps/web/servers/other.ts",
      "apps/web/srcery/other.ts",
    ];
    withScannedRepo(siblings, (dir) => {
      const { files, violations } = scanRepo(dir);
      expect(files).toEqual([...SKELETON].sort());
      expect(violations).toHaveLength(SKELETON.length);
    });
  });

  it("reads a file whose name is not ASCII", () => {
    // Real git decides the assumption: under the default core.quotePath it prints
    // such a path quoted and C-escaped, a spelling that names no file on disk,
    // so a listing without `-z` reaches readFileSync with it and throws ENOENT
    // in place of any egress finding.
    const nonAscii = "apps/web/src/naïve.ts";
    withScannedRepo([nonAscii], (dir) => {
      expect(
        execFileSync(
          "git",
          ["ls-files", "--cached", "--others", "--exclude-standard", "--"],
          { cwd: dir, encoding: "utf8" },
        ),
      ).toContain('"apps/web/src/na\\303\\257ve.ts"');
      const { files, violations } = scanRepo(dir);
      expect(files).toContain(nonAscii);
      expect(violations).toHaveLength(SKELETON.length + 1);
    });
  });

  it("fails when a scanned root or file matches nothing", () => {
    // A renamed shipped tree would otherwise leave the check passing over a
    // smaller scan than its success line claims. Real git decides the assumption:
    // it reports an unmatched pathspec by printing nothing and exiting 0.
    withScannedRepo([], (dir) => {
      renameSync(
        resolve(dir, "apps/web/server"),
        resolve(dir, "apps/web/serverRenamed"),
      );
      rmSync(resolve(dir, "docker-entrypoint.sh"));
      for (const pathspec of ["apps/web/server", "docker-entrypoint.sh"]) {
        expect(
          execFileSync(
            "git",
            [
              "ls-files",
              "--cached",
              "--others",
              "--exclude-standard",
              "--",
              pathspec,
            ],
            { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
          ),
        ).toBe("");
        expect(() => scanRepo(dir)).toThrow(pathspec);
      }
    });
  });
});

describe("literal extraction", () => {
  it("reads no URL from a line comment", () => {
    expect(
      urlsIn("// A page the operator visits at http://attacker.example\n"),
    ).toEqual([]);
  });

  it("reads no URL from a block comment, including a backticked one", () => {
    const source =
      "/** Deep-link origin, e.g. `https://example.org:3000` (no trailing slash). */\n" +
      "/* TURN server URI (`turn:host` or `turns:host`). */\n";
    expect(urlsIn(source)).toEqual([]);
  });

  it("reads a URL inside a string, whose `//` is not a comment start", () => {
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

  it("reads an unquoted URL in the formats that write one", () => {
    // A format no parser is run for has no literals to read, so its whole text
    // is the candidate and a URL sitting in no quotes at all is still read.
    expect(
      urlsIn(
        "@font-face { src: url(https://fonts.example/i.woff2); }\n",
        "apps/web/src/styles/tokens.css",
      ),
    ).toEqual(["https://fonts.example/i.woff2"]);
    expect(
      urlsIn(
        "Sitemap: https://evil.example/sitemap.xml\n",
        "apps/web/public/robots.txt",
      ),
    ).toEqual(["https://evil.example/sitemap.xml"]);
  });

  it("ends a raw-scanned URL at a brace that closes an expansion", () => {
    // The formats scanned raw write `${...}` as syntax of their own, and no
    // parser is run to say so: the `}` closing a shell default value ends the
    // URL rather than landing in the host the check reports, while one closing
    // a span opened inside the URL stays part of it.
    for (const [path, source, expected] of [
      [
        "docker-entrypoint.sh",
        ': "${SFTP_ENDPOINT:-https://backup.example.com}"\n',
        { url: "https://backup.example.com", host: "backup.example.com" },
      ],
      [
        "docker-entrypoint-fips.sh",
        'exec curl "${ENDPOINT:-https://backup.example.com}/ping" "$@"\n',
        { url: "https://backup.example.com", host: "backup.example.com" },
      ],
      [
        "Dockerfile.fips",
        'RUN curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/node.tar.xz"\n',
        {
          url: "https://nodejs.org/dist/${NODE_VERSION}/node.tar.xz",
          host: "nodejs.org",
        },
      ],
    ]) {
      expect([path, isJavaScriptFamily(path)]).toEqual([path, false]);
      expect([path, urlLiterals(source, path)]).toEqual([
        path,
        [{ ...expected, line: 1 }],
      ]);
    }
    // The parsed family reads the same characters the parser's way, where a
    // brace closes an interpolation the parser marked or spells literal text.
    expect(urlsIn("const u = 'https://${host}/x';\n")).toEqual([
      "https://${host}/x",
    ]);
  });

  it("reads a URL inside a quoted CSS data URI", () => {
    const path = "apps/web/src/styles/tokens.css";
    const source =
      "  --app-check: url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\"/>');\n";
    expect(urlsIn(source, path)).toEqual(["http://www.w3.org/2000/svg"]);
    expect(fileViolations(path, source)).toEqual([]);
  });

  it("reads a URL whose own path has a comment opener", () => {
    expect(urlsIn('const u = "https://evil.example/a/*b*/c";\n')).toEqual([
      "https://evil.example/a/*b*/c",
    ]);
  });

  it("does not lose a literal to a regular expression written before it", () => {
    const source =
      'const s = btoa(b).replace(/\\//g, "_"); const u = "https://evil.example/d";\n';
    expect(urlsIn(source)).toEqual(["https://evil.example/d"]);
  });

  it("reads a comment opener that is JSX text rather than code", () => {
    // JSX text is not code, so a `/*` or `//` in ordinary UI prose about a
    // glob or a path opens no comment. A reader that takes one for a comment
    // loses the source after it and reports the file clean -- the silent
    // direction. The trailing comment on each line is the other half: it still
    // has to go unread, or the case would pass on a reader that gave up.
    for (const path of [
      "apps/web/src/f.tsx",
      "apps/web/src/f.jsx",
      "apps/web/src/f.js",
    ]) {
      expect([
        path,
        urlsIn(
          "export const A = () => <p>files under data/* are read</p>;\n" +
            'const u = "https://evil.example/x"; // https://commented.example/a\n',
          path,
        ),
      ]).toEqual([path, ["https://evil.example/x"]]);
      expect([
        path,
        urlsIn(
          "export const B = () => <p>a // b</p>; " +
            'const u = "https://evil.example/y"; /* https://commented.example/b */\n',
          path,
        ),
      ]).toEqual([path, ["https://evil.example/y"]]);
    }
  });

  it("reads a URL that JSX text itself has", () => {
    expect(
      urlsIn(
        "export const A = () => <p>See https://evil.example/x for more</p>;\n",
        "apps/web/src/f.tsx",
      ),
    ).toEqual(["https://evil.example/x"]);
  });

  it("scans a file the parser cannot read raw, comments included", () => {
    // A broken parse yields no literal to extract at all, which would report
    // the file clean -- the one direction this check cannot afford. Such a
    // file is scanned raw instead, so its commented URL is flagged as a false
    // positive the author resolves. The parser decides both halves of that
    // assumption here rather than a reading of it.
    const source = "const a = ;\nfunction (\n// https://evil.example/x\n";
    expect(parseOf(source).parseErrors).toBeGreaterThan(0);
    expect(parseOf(source).literals).toEqual([]);
    expect(urlsIn(source)).toEqual(["https://evil.example/x"]);
  });

  it("reads template text that follows an interpolation", () => {
    expect(urlsIn("const u = `${base} https://evil.example/x`;\n")).toEqual([
      "https://evil.example/x",
    ]);
  });

  it("reads a template written in type position", () => {
    // A template type is written from the same spans a template expression is,
    // and is read the same way: the literal parts name a host or they do not.
    expect(
      urlsIn(
        "type Endpoint = `https://${string}.evil.example`;\n" +
          "type Fixed = `https://plain.example/x`;\n" +
          "type Whole = `https://${string}`;\n",
      ),
    ).toEqual(["https://${string}.evil.example", "https://plain.example/x"]);
  });

  it("reads no URL from a comment inside a template interpolation", () => {
    // The interpolated span is the parser's own, braces and all: a reader that
    // took the `}` closing `{ x: 1 }` for the end of the interpolation would
    // read the block comment after it as template text and report its URL.
    expect(
      urlsIn(
        "const u = `${describe({ x: 1 }) /* see https://evil.example */}`;\n",
      ),
    ).toEqual([]);
  });
});

describe("the repository as it stands", { timeout: SCAN_TIMEOUT_MS }, () => {
  it("holds no URL literal outside the allowlist", () => {
    const { files, violations } = scanRepo(repoRoot);
    expect(violations).toEqual([]);
    expect(files.length).toBeGreaterThan(100);
  });

  it("parses every scanned JavaScript-family file without a syntax error", () => {
    // Literals come out of the parse for this family, and a file the parser
    // rejects yields none: it is scanned raw instead, which over-reports rather
    // than reporting a file clean it could read nothing out of. Holding the
    // whole family parseable keeps that fallback for the file an author breaks,
    // rather than a state the shipped tree sits in unnoticed.
    const scriptKind = (file) => {
      if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
      if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
      return /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    };
    const parseErrors = (text, file) =>
      ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        false,
        scriptKind(file),
      ).parseDiagnostics.length;

    // `parseDiagnostics` is off the public SourceFile type, so probe it: a
    // TypeScript upgrade that renames it must redden here rather than report
    // every file error-free.
    expect(
      parseErrors("const a = ;\nfunction (\n", "probe.ts"),
    ).toBeGreaterThan(0);
    expect(parseErrors("const a = 1;\n", "probe.ts")).toBe(0);

    const sources = scanRepo(repoRoot).files.filter(isJavaScriptFamily);
    expect(sources.length).toBeGreaterThan(100);
    const unparsed = sources.filter(
      (file) =>
        parseErrors(readFileSync(resolve(repoRoot, file), "utf8"), file) !== 0,
    );
    expect(unparsed).toEqual([]);
  });

  it("keeps every allowlist entry admitting a literal the scan finds", () => {
    // The allowlist is written against the reported literal, so a change in how
    // one is extracted can leave an entry admitting nothing. An entry that no
    // longer matches anything is either stale or covering a literal whose shape
    // moved, and both are edits to make here rather than to discover on the
    // next unrelated failure.
    const { files } = scanRepo(repoRoot);
    const admitted = new Set();
    for (const file of files) {
      const source = readFileSync(resolve(repoRoot, file), "utf8");
      for (const { url } of urlLiterals(source, file)) {
        const entry = allowlistEntryFor(url);
        if (entry !== undefined) admitted.add(entry.url);
      }
    }
    expect([...admitted].sort()).toEqual(ALLOWLIST.map((e) => e.url).sort());
  });

  it("reports only allowlisted hits from the stylesheets it scans", () => {
    // Scanning a stylesheet raw costs nothing measurable here: the shipped
    // stylesheets have their URL literals in real declarations, not in
    // comments, so the hits are the allowlisted SVG namespace and no others.
    const { files } = scanRepo(repoRoot);
    const stylesheets = files.filter((file) => file.endsWith(".css"));
    expect(stylesheets.length).toBeGreaterThan(0);
    const hits = [];
    for (const file of stylesheets) {
      const source = readFileSync(resolve(repoRoot, file), "utf8");
      expect([file, isJavaScriptFamily(file)]).toEqual([file, false]);
      expect([file, fileViolations(file, source)]).toEqual([file, []]);
      hits.push(...urlLiterals(source, file).map(({ url }) => url));
    }
    // Not a vacuous pass: the stylesheets do have a literal, and the raw scan
    // reaches it in the declaration it sits in.
    expect(hits).toContain("http://www.w3.org/2000/svg");
  });
});
