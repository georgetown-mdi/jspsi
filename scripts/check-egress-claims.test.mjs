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
  commentSyntaxFor,
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

const urlsIn = (source, path = FIXTURE) =>
  urlLiterals(source, path).map((hit) => hit.url);

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

  it("still flags a stun/turn host written behind slashes", () => {
    // stun and turn URIs carry no `//` (RFC 7064, RFC 7065), so a slash before
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
        .authority,
    ).toBe("relay.evil.example:3478");
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
        authority: "${tenant}.evil.example",
        line: 1,
      },
    ]);
    expect(
      urlsIn("await fetch(`http://${format({ a: 1 })}.evil.example`);\n"),
    ).toEqual(["http://${format({ a: 1 })}.evil.example"]);
  });

  it("still flags a literal host carrying an interpolated path", () => {
    const source = "await fetch(`https://evil.example/${path}`);\n";
    expect(urlLiterals(source, FIXTURE).map((hit) => hit.authority)).toEqual([
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
    // The loud direction, stated in the header: the matcher judges an
    // authority without parsing it, so a literal nothing could dereference can
    // still fail the build, and the author rewrites or allowlists it.
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
    // The slash count carries nothing the matcher may lean on: the real parser
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
      { url: "https:///path", authority: "path", line: 1 },
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
    // Running the JavaScript stripper over these would read a `//` or `/*` in
    // ordinary content as a comment opener, blank the rest of the line, and
    // report the file clean. They are scanned raw for that reason.
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
    ];
    for (const [path, source, expected] of cases) {
      expect(commentSyntaxFor(path)).toBe("none");
      expect([path, stripComments(source, path)]).toEqual([path, source]);
      expect([path, urlsIn(source, path)]).toEqual([path, [expected]]);
      expect(fileViolations(path, source)).toHaveLength(1);
    }
  });

  it("strips only block comments from a stylesheet", () => {
    const path = "apps/web/src/bench/tokens.css";
    expect(commentSyntaxFor(path)).toBe("css");
    expect(urlsIn("/* see https://commented.example/x */\n", path)).toEqual([]);
    // CSS has no `//` line comment, so text after one is content.
    expect(urlsIn("a { b: c } // https://evil.example/y\n", path)).toEqual([
      "https://evil.example/y",
    ]);
    // Nor any template literal, so a lone backtick opens no state that would
    // swallow the rest of the file.
    expect(
      urlsIn(
        "a { content: '`' }\nb { background: url(https://evil.example/z) }\n",
        path,
      ),
    ).toEqual(["https://evil.example/z"]);
  });

  it("strips both comment forms from every JavaScript-family extension", () => {
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
      expect(commentSyntaxFor(path)).toBe("javascript");
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

describe("scanned roots", () => {
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

  it("fails when a scanned root or file matches nothing", () => {
    // A renamed shipped tree would otherwise leave the check passing over a
    // smaller scan than its success line claims. Real git decides the premise:
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
    const path = "apps/web/src/bench/tokens.css";
    const source =
      "  --bench-check: url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\"/>');\n";
    expect(urlsIn(source, path)).toEqual(["http://www.w3.org/2000/svg"]);
    expect(fileViolations(path, source)).toEqual([]);
  });

  it("keeps a URL whose own path carries a comment opener", () => {
    expect(urlsIn('const u = "https://evil.example/a/*b*/c";\n')).toEqual([
      "https://evil.example/a/*b*/c",
    ]);
    expect(
      urlsIn(
        "@font-face { src: url(https://evil.example/a/*b*/c.woff2); }\n",
        "apps/web/src/bench/tokens.css",
      ),
    ).toEqual(["https://evil.example/a/*b*/c.woff2"]);
  });

  it("does not let an escaped slash in a regex blank the rest of the line", () => {
    const source =
      'const s = btoa(b).replace(/\\//g, "_"); const u = "https://evil.example/d";\n';
    expect(urlsIn(source)).toEqual(["https://evil.example/d"]);
  });

  it("keeps a comment opener that is JSX text rather than code", () => {
    // JSX text is not code, so a `/*` or `//` in ordinary UI prose about a
    // glob or a path opens no comment. A stripper that reads one as a comment
    // blanks the source after it and reports the file clean -- the silent
    // direction. The trailing comment on each line is the other half: it still
    // has to come off, or the case would pass on a stripper that gave up.
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

  it("keeps a URL that JSX text itself carries", () => {
    expect(
      urlsIn(
        "export const A = () => <p>See https://evil.example/x for more</p>;\n",
        "apps/web/src/f.tsx",
      ),
    ).toEqual(["https://evil.example/x"]);
  });

  it("leaves a file the parser cannot read unstripped", () => {
    // Nothing is deleted on a broken parse, which locates comments no better
    // than guesswork would: the commented URL surfaces as a false positive the
    // author resolves, rather than a blanked line nobody sees.
    const source = "const a = ;\nfunction (\n// https://evil.example/x\n";
    expect(stripComments(source, FIXTURE)).toBe(source);
    expect(urlsIn(source)).toEqual(["https://evil.example/x"]);
  });

  it("does not let a `/*` inside an unquoted CSS URL swallow the file", () => {
    // CSS reads an unquoted url() to its closing paren as one token, so the
    // `/*` opens no comment there. A lexer that thinks otherwise blanks on to
    // the next `*/` and loses whatever literal follows -- silently.
    const path = "apps/web/src/bench/tokens.css";
    const trailing = "b { background: url(https://other.example/y) }\n";
    expect(
      urlsIn(
        `a { background: url(https:evil.example/p/*x) }\n${trailing}`,
        path,
      ),
    ).toEqual(["https:evil.example/p/*x", "https://other.example/y"]);
    expect(
      urlsIn(
        `a { background: url(data:image/svg+xml,x/*y) }\n${trailing}`,
        path,
      ),
    ).toEqual(["https://other.example/y"]);
    // A quoted url() keeps its own rule: the paren inside the string is not
    // the token's end.
    expect(
      urlsIn(
        `a { background: url("data:image/svg+xml,<svg d='M0 0)'/>") }\n${trailing}`,
        path,
      ),
    ).toEqual(["https://other.example/y"]);
  });

  it("keeps template text that follows an interpolation", () => {
    const source = "const u = `${base} // not a comment`;\n";
    expect(stripComments(source, FIXTURE)).toBe(source);
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
    const stripped = stripComments(source, FIXTURE);
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
    const scriptKind = (file) => {
      if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
      if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
      return /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    };
    const canonical = (text, file) => {
      const parsed = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        false,
        scriptKind(file),
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

    const sources = scanRepo(repoRoot).files.filter(
      (file) => commentSyntaxFor(file) === "javascript",
    );
    expect(sources.length).toBeGreaterThan(100);

    const damaged = sources.filter((file) => {
      const source = readFileSync(resolve(repoRoot, file), "utf8");
      const stripped = stripComments(source, file);
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

  it("deletes nothing from a scanned file whose syntax is unmodeled", () => {
    // The parser guard above reaches the JavaScript family only. For every
    // other scanned file the property that stands in for it is that stripping
    // changes nothing at all, and for a stylesheet that it changes no length.
    const { files } = scanRepo(repoRoot);
    const changed = files.filter((file) => {
      const source = readFileSync(resolve(repoRoot, file), "utf8");
      const stripped = stripComments(source, file);
      if (commentSyntaxFor(file) === "none") return stripped !== source;
      return stripped.length !== source.length;
    });
    expect(changed).toEqual([]);
    expect(
      files.filter((file) => commentSyntaxFor(file) === "none").length,
    ).toBeGreaterThan(0);
    expect(
      files.filter((file) => commentSyntaxFor(file) === "css").length,
    ).toBeGreaterThan(0);
  });
});
