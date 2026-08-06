#!/usr/bin/env node
// URL-literal egress guard, run by static_checks.yaml on every PR.
//
// PRIVACY.md publishes load-bearing NEGATIVE claims to agency security,
// compliance, and privacy reviewers: the container "makes no other network
// connection" beyond the SFTP server or shared directory the operator
// configures; the hosted web application has "no analytics or third-party
// tracking scripts, and no third-party content delivery" and "makes no request
// to any host other than the supporting services named below"; and the project
// runs no license check, update ping, usage analytics, or telemetry. Prose
// cannot hold those claims true -- a font CDN, an error-reporting SDK, an
// analytics snippet, or a version-check ping is one import away, and the
// document that agency reviewers were handed goes quietly false. So the claim
// is encoded as a check: a URL literal in shipped source that names a host
// under one of the schemes below either sits on ALLOWLIST, each entry carrying
// the reason it does not contradict the document, or it fails the build.
//
// WHAT THIS CHECK DOES NOT COVER -- most of it past the reach of a literal
// scan, the rest by decision:
//
//   - Egress assembled at runtime. A host built from configuration, from an
//     operator-supplied value, or by string concatenation never appears as a
//     literal. The invitation endpoint and the operator's SFTP server are
//     legitimately of this kind, so a literal scan is the only shape available
//     here; it is a backstop, not a proof of no egress.
//   - Egress originating inside a dependency. Only first-party source under
//     SCANNED_ROOTS and SCANNED_FILES is read; what a package does at runtime is
//     the dependency review's ground (CONTRIBUTING.md, Dependency Policy).
//   - Egress introduced by build configuration. A snippet added to
//     apps/web/vite.config.ts or apps/web/nitro.config.ts emits into the
//     shipped page, but those files sit at a workspace root, outside
//     SCANNED_ROOTS.
//   - A file git ignores. The listing in scanRepo excludes them, so a URL
//     literal in one is never read, wherever under a scanned root it sits. The
//     reach of that gap is small, but not because a tree holds no ignored file:
//     an install and a core build leave plenty (node_modules, the workspace
//     dist trees), in CI as much as locally. It is that none of them land under
//     a scanned root, so the gap opens only for a file written under one of
//     those roots and ignored there.
//   - A text file in an encoding other than UTF-8. Every scanned file is
//     decoded as UTF-8, so a UTF-16 one reads as its characters separated by
//     NULs, matches nothing, and is still counted among the files scanned.
//   - A URL literal inside a JavaScript or TypeScript comment. Comment text is
//     blanked before the matcher reads the file, so a `@see` link in a JSDoc
//     block and a trailing `// https://cdn.example/a.js` alike go unreported.
//     This is the one step that deletes text, and a decision rather than a
//     limit of reach: a comment issues no request, and a documentation link
//     would otherwise have to be allowlisted. It reaches the JavaScript and
//     TypeScript family alone; every other text format is scanned raw, for the
//     reason set out below.
//   - A URL spelled so as to evade the matcher: split across concatenated
//     string fragments, escaped inside a regular expression (`https:\/\/`),
//     percent- or entity-encoded in the scheme or the colon after it
//     (`%68ttps://`, `&#104;ttps://`, `https%3A//`, `https&#58;//`; an encoded
//     host is still reported, since the scheme is what the matcher reads), or
//     glued to a letter, digit, or underscore (`xhttps://host`,
//     `_https://host`), none of which the scheme rule admits before the
//     scheme; any other character, or the start of the text, still matches
//     (`.https://host` and `-https://host` are reported). The check is a guard
//     against egress added inadvertently, not against an author who wants to
//     hide it.
//   - Schemes outside http, https, stun, stuns, turn, and turns: a `wss://`,
//     `ws://`, `ftp://` or `file://` literal names a host and is not reported.
//     Nor is a protocol-relative `//host` reference, which carries no scheme to
//     match.
//   - An authority naming no host of its own: empty, a scheme followed by
//     nothing but slashes, which is what a protocol comparison
//     (`location.protocol === "https:"`) is; wholly interpolated
//     (`http://${host}`, `http://${host}:8443`), as the helpers over an inbound
//     Host header write it; nothing but a numeric port (`https://:8443/x`),
//     which the port rule leaves empty and `new URL()` rejects outright; or
//     written entirely of dots, which `new URL()` does resolve to the host
//     `...` but is how elided placeholder text writes a URL (`https://...#...`
//     in the invitation field). Those four are skipped knowingly; why none of
//     them can be tightened is at `urlLiterals` and `namesLiteralHost`. An
//     interpolation with a literal host beside it names a host and is reported
//     (`https://${tenant}.evil.example`).
//
// The opposite direction is loud and left that way: an authority spelling out
// host-shaped text is reported even where `new URL()` rejects it outright
// (`https://%zz/`, `https://[not-ipv6]/`, `https://[2001:db8::1`,
// `https://a:b/`, `https://ex^ample/`, `https://exa|mple/`). The matcher judges
// an authority without parsing it, so a literal nothing could dereference can
// still fail the build; the author resolves that by rewriting the literal or
// allowlisting it with a reason.
//
// License and notice files (LICENSE, LICENCE, NOTICE, COPYING) are not
// scanned: license text is not executable, and the attribution URL in a
// vendored copyright line names an upstream project rather than a host anything
// contacts.
//
// Binary assets are skipped by extension (BINARY_EXTENSIONS) rather than source
// being admitted by extension, so a newly added text format -- an .html or .svg
// dropped into apps/web/public, say -- is scanned by default rather than
// ignored by default. A new binary format that trips the check is fixed by
// adding its extension here, a one-line edit a reviewer sees.
//
// Comment syntax, by contrast, is recognized by extension and only for the
// family a real parser reads here: JavaScript and TypeScript, whose comments
// the TypeScript parser locates. Every other text format -- CSS, HTML, SVG,
// Markdown, shell -- is scanned raw. Stripping is the one step that can delete
// text before the matcher sees it, and a lexer written from a language's
// comment rules rather than its whole grammar gets that wrong silently, which
// reports a file clean; raw leaves a URL written inside an unmodeled comment
// visible, as the false positive an author resolves with an allowlist entry.
//
// SCANNED_ROOTS is source that ships or runs, not all TypeScript. Beside the
// app and library trees and the web app's static assets it carries
// apps/web/server, the Nitro entry point the deployed server boots (named by
// apps/web/nitro.config.ts). SCANNED_FILES carries the shipped files that sit
// at the repository root rather than in a tree, for both images: the two
// entrypoints, docker-entrypoint.sh and docker-entrypoint-fips.sh, which run
// inside the container the "no other network connection" claim is about (each
// is its image's ENTRYPOINT), and the two Dockerfiles, Dockerfile and
// Dockerfile.fips, which reach a different class -- what the image build
// fetches rather than what the running container connects to -- scanned anyway,
// because a `RUN curl` or `ADD https://...` pulling a third party into the
// image is what a reviewer of that claim wants shown.
//
// Deliberately outside both: the build and test configuration at each workspace
// root and the sibling test/ trees; and apps/web/deploy, whose nginx and
// post-deploy files configure the Elastic Beanstalk host rather than the
// application, addressing the instance itself (127.0.0.1, the EC2 metadata
// service) and belonging to deploy review. The test trees and the deploy files
// reach no user; build configuration does, through what it emits, which is why
// it is listed above as a gap rather than a safe exclusion. A tree that starts
// shipping is added here, so an exclusion reads as the decision it is rather
// than an oversight.
//
// Test files are NOT excluded. The scanned roots are shipped-source trees by
// construction (the suites live in sibling test/ directories), so a `*.test.*`
// exclusion would only open a bypass; a test that ever lands under one of these
// roots earns an allowlist entry like anything else.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Shipped-source trees the egress claims are made about. */
export const SCANNED_ROOTS = [
  "apps/web/src",
  "apps/cli/src",
  "packages/core/src",
  "apps/web/public",
  "apps/web/server",
];

/** Shipped files that build or run the container, outside any scanned tree. */
export const SCANNED_FILES = [
  "Dockerfile",
  "docker-entrypoint.sh",
  "Dockerfile.fips",
  "docker-entrypoint-fips.sh",
];

/**
 * Absolute URL literals that do not contradict PRIVACY.md, each with the reason
 * it does not. `exact` matches the literal; `prefix` also admits a longer URL
 * whose next character is `/`, `?`, or `#`, so the entry cannot be extended
 * into another host or another repository.
 */
export const ALLOWLIST = [
  {
    url: "stun:stun.l.google.com:19302",
    match: "exact",
    reason:
      "default public STUN server, the one third-party host the web app intends to reach; already named in PRIVACY.md's supporting-services table",
  },
  {
    url: "stun:44.247.30.68:443",
    match: "exact",
    reason: "second default public STUN server, same basis as the first",
  },
  {
    url: "https://peerjs",
    match: "exact",
    reason:
      "dummy base handed to `new URL()` so a request path can be parsed; never dereferenced",
  },
  {
    url: "https://peerjs.com/",
    match: "exact",
    reason:
      "metadata string in the PeerJS server-info response describing the upstream project; never contacted",
  },
  {
    url: "http://www.w3.org/2000/svg",
    match: "exact",
    reason:
      "XML namespace identifier inside an inline SVG data URI; a namespace name, never fetched",
  },
  {
    url: "https://nodejs.org/dist",
    match: "prefix",
    reason:
      "the FIPS variant image's build fetches the official Node runtime tarball and its checksum file from here, because Amazon Linux 2023 packages no Node 26; what the build fetches, not a connection the running container makes, and the same class as the Alpine mirror the default image's one apk install reaches",
  },
  {
    url: "https://github.com/georgetown-mdi/jspsi",
    match: "prefix",
    reason:
      "operator-clicked hyperlinks into this project's own repository documentation: user navigation, not app-initiated egress; a prefix because UI work adds these routinely, scoped to this repository so a link to any other host still fails",
  },
];

// Extensions whose bytes are not text. Everything else is read and scanned.
const BINARY_EXTENSIONS = new Set([
  ".avif",
  ".bin",
  ".bmp",
  ".br",
  ".class",
  ".dll",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".icns",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".node",
  ".ogg",
  ".otf",
  ".pdf",
  ".png",
  ".so",
  ".svgz",
  ".tgz",
  ".ttf",
  ".wasm",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

const NOTICE_BASENAMES = new Set([
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENCE",
  "LICENCE.md",
  "LICENCE.txt",
  "NOTICE",
  "NOTICE.md",
  "COPYING",
]);

// Where a URL literal ends in source: whitespace, the quote forms, and the
// punctuation that brackets one in TypeScript, JSX, and CSS. `{` is left out so
// a leading `${` interpolation stays visible to the authority rules, `[` and `]`
// so an IPv6 host literal is not truncated to nothing.
const TERMINATOR_CHARS = "\\s\"'`<>(),;}\\\\";
const URL_TERMINATOR = new RegExp(`[${TERMINATOR_CHARS}]`);
const URL_SCHEME = new RegExp(
  `(?<![A-Za-z0-9_])(?<scheme>https?|stuns?|turns?):`,
  "gi",
);

// A `${...}` span whose text names whatever the expression evaluates to rather
// than a host. Removing the spans is what leaves the literal part of an
// authority for the host rule to judge.
const INTERPOLATION_SPAN = /\$\{[^}]*\}/g;

/** Whether `path` is scanned at all (a text file that is not license text). */
export function isScannedFile(path) {
  if (NOTICE_BASENAMES.has(basename(path))) return false;
  return !BINARY_EXTENSIONS.has(extname(path).toLowerCase());
}

// How the TypeScript parser is to read each JavaScript-family extension. The
// kind decides the language variant, and with it whether `<p>` opens a JSX
// element or a type assertion, so it is chosen per extension rather than
// guessed: .mts and .cts are TypeScript without JSX, .js is JavaScript with it.
const SCRIPT_KIND_BY_EXTENSION = new Map([
  [".cjs", ts.ScriptKind.JS],
  [".cts", ts.ScriptKind.TS],
  [".js", ts.ScriptKind.JS],
  [".jsx", ts.ScriptKind.JSX],
  [".mjs", ts.ScriptKind.JS],
  [".mts", ts.ScriptKind.TS],
  [".ts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
]);

/** Comment syntax recognized for `path`: "javascript" or "none". */
export function commentSyntaxFor(path) {
  return SCRIPT_KIND_BY_EXTENSION.has(extname(path).toLowerCase())
    ? "javascript"
    : "none";
}

/** `text` with every character but a line break spaced out, so positions hold. */
function blankOut(text) {
  return text.replace(/[^\n\r]/g, " ");
}

/**
 * The comment ranges TypeScript reads in `source`, or undefined if the parser
 * cannot read the file at all.
 *
 * Which spans are comments is a question for the parser rather than a lexer of
 * our own: JSX text is not code, so the `/*` in `<p>files under data/* are
 * read</p>` opens nothing, and a hand-rolled scanner that thinks otherwise
 * blanks the source after it -- silently, which is the one failure direction
 * this check cannot afford. Every comment sits in the trivia between a node's
 * full start and its first real character, so taking the comment ranges in that
 * span for every node reaches all of them and nothing else: leading ranges for
 * the comments after a line break, trailing ranges for those on the same line.
 */
function commentRanges(source, path) {
  const parsed = ts.createSourceFile(
    basename(path),
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    SCRIPT_KIND_BY_EXTENSION.get(extname(path).toLowerCase()),
  );
  // `parseDiagnostics` is off the public SourceFile type. A TypeScript upgrade
  // that renames it therefore reads as "cannot parse", which leaves comments
  // in place as false positives, rather than as "parsed clean".
  if (parsed.parseDiagnostics?.length !== 0) return undefined;

  const byPosition = new Map();
  const visit = (node) => {
    const trivia = node.getFullStart();
    const nodeStart = node.getStart(parsed);
    if (nodeStart > trivia) {
      for (const range of [
        ...(ts.getTrailingCommentRanges(source, trivia) ?? []),
        ...(ts.getLeadingCommentRanges(source, trivia) ?? []),
      ]) {
        if (range.end <= nodeStart) byPosition.set(range.pos, range);
      }
    }
    for (const child of node.getChildren(parsed)) visit(child);
  };
  visit(parsed);
  return [...byPosition.values()].sort((a, b) => a.pos - b.pos);
}

/**
 * Blank out the comments `path`'s recognized syntax defines, preserving every
 * other character position so line numbers survive. A path whose extension
 * names no recognized syntax is returned unchanged, so no text is deleted from
 * a format whose comments cannot be located; so is a JavaScript-family file the
 * TypeScript parser rejects, since a broken parse locates them no better than
 * guesswork does.
 */
export function stripComments(source, path) {
  if (commentSyntaxFor(path) === "none") return source;

  const ranges = commentRanges(source, path);
  if (ranges === undefined) return source;
  let out = "";
  let cursor = 0;
  for (const { pos, end } of ranges) {
    if (pos < cursor) continue;
    out += source.slice(cursor, pos) + blankOut(source.slice(pos, end));
    cursor = end;
  }
  return out + source.slice(cursor);
}

/**
 * The URL literal's text starting at `start`, ending at the first terminator.
 *
 * `}` is one of those terminators, and it is also what closes an interpolation
 * inside an authority -- where the text after it, a literal host suffix
 * included, is still part of the URL. So terminators end the literal only at
 * interpolation depth zero. Inner braces raise the depth as well: stopping at
 * the first `}` of `${format({ a: 1 })}` would drop back into the URL one brace
 * early and lose everything the interpolation was prefixed to.
 */
function readUrlBody(text, start) {
  let i = start;
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "$" && text[i + 1] === "{") {
      depth += 1;
      i += 2;
      continue;
    }
    if (c === "}") {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth > 0) {
      if (c === "{") depth += 1;
    } else if (URL_TERMINATOR.test(c)) {
      break;
    }
    i += 1;
  }
  return text.slice(start, i);
}

/**
 * Whether `authority` still spells out a host of its own, once interpolations
 * and a trailing port are removed. The port has to come off with them: a
 * numeric one is literal text that survives an authority naming no host
 * (`${host}:8443`), and `new URL()` rejects a non-numeric there, so nothing a
 * host could hide in is being dropped.
 *
 * What remains names a host unless it is empty or written entirely of dots.
 * Anything else is reported, whatever alphabet it is in: an internationalized
 * host is a host (`new URL()` resolves `https://пример.рф/` to
 * `xn--e1afmkfd.xn--p1ai`, which resolves and serves), and so is a bracketed
 * `[::]`, so neither may turn on an ASCII test.
 */
function namesLiteralHost(authority) {
  const literal = authority
    .replace(INTERPOLATION_SPAN, "")
    .replace(/:\d*$/, "");
  return literal !== "" && !/^\.+$/.test(literal);
}

/**
 * Absolute URL literals in `source` as `{url, authority, line}`, after comment
 * stripping. The authority is whatever follows the scheme colon and any run of
 * slashes, none of which the matcher can read anything into: `new URL()`
 * resolves `https:host/x`, `https:/host/x`, `https:///host/x` and
 * `https:////host/x` alike to that host, and `fetch` dereferences them alike
 * too. Two shapes are excluded here rather than allowlisted, because neither
 * names a host:
 *
 *   - An empty authority -- a scheme followed by nothing but slashes, which is
 *     what a protocol comparison (`location.protocol === "https:"`) is, and
 *     what makes the check usable at all for the other schemes: `stun:` and
 *     `turn:` are also object-property syntax in a Zod schema, the head of a
 *     `/^turns?:/` anchor, and the tail of prose like "must begin with turn:".
 *   - An authority spelling out no host of its own: fully interpolated, as the
 *     `URL`-parsing helpers over an inbound `Host` header write it
 *     (`http://${host}`, `http://${host}:8443`), or written entirely of dots,
 *     as the elided `https://...#...` of placeholder text is. An interpolation
 *     with a literal host beside it (`https://${tenant}.evil.example`) names
 *     one and is reported.
 */
export function urlLiterals(source, path) {
  const found = [];
  const text = stripComments(source, path);
  let lineStart = 0;
  let line = 1;
  for (const match of text.matchAll(URL_SCHEME)) {
    const { scheme } = match.groups;
    const rest = readUrlBody(text, match.index + match[0].length);
    const authority = rest.replace(/^\/+/, "").split(/[/?#]/, 1)[0];
    if (!namesLiteralHost(authority)) continue;

    while (lineStart < match.index) {
      const nextBreak = text.indexOf("\n", lineStart);
      if (nextBreak === -1 || nextBreak >= match.index) break;
      lineStart = nextBreak + 1;
      line += 1;
    }
    found.push({ url: `${scheme}:${rest}`, authority, line });
  }
  return found;
}

/** The allowlist entry admitting `url`, or undefined if none does. */
export function allowlistEntryFor(url) {
  return ALLOWLIST.find((entry) => {
    if (url === entry.url) return true;
    if (entry.match !== "prefix") return false;
    return url.startsWith(entry.url) && "/?#".includes(url[entry.url.length]);
  });
}

/** Unallowlisted URL literals in one file, as violation strings (empty = clean). */
export function fileViolations(path, source) {
  if (!isScannedFile(path)) return [];
  return urlLiterals(source, path)
    .filter(({ url }) => allowlistEntryFor(url) === undefined)
    .map(
      ({ url, line }) =>
        `${path}:${line}: unallowlisted URL literal \`${url}\` -- PRIVACY.md tells agency reviewers the container "makes no other network connection" and the hosted web application "makes no request to any host other than the supporting services named below"`,
    );
}

/**
 * Scan the real paths under `root`, returning the files read and what failed.
 *
 * Each pathspec is listed on its own and required to match something. `git
 * ls-files` reports a pathspec that matches nothing by printing nothing and
 * exiting 0, so a renamed or deleted shipped tree would otherwise leave the
 * check passing over a smaller scan than it claims.
 *
 * The listing covers tracked and untracked files but not ignored ones, which
 * keeps build output out of the scan and leaves a generated file dropped into a
 * scanned tree unread.
 *
 * `-z` is what makes a non-ASCII filename readable: the default `core.quotePath`
 * has git print such a path quoted and C-escaped, and that spelling names no
 * file on disk, so the read of it would fail with a bare ENOENT rather than any
 * egress finding.
 */
export function scanRepo(root) {
  const matched = new Set();
  const unresolved = [];
  for (const pathspec of [...SCANNED_ROOTS, ...SCANNED_FILES]) {
    const listed = execFileSync(
      "git",
      [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        pathspec,
      ],
      { cwd: root, encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean);
    if (listed.length === 0) unresolved.push(pathspec);
    for (const file of listed) matched.add(file);
  }
  if (unresolved.length > 0) {
    throw new Error(
      `Egress claim check: ${unresolved.join(", ")} matches no file. A scanned tree or file was renamed or removed; point SCANNED_ROOTS or SCANNED_FILES in scripts/check-egress-claims.mjs at the path that ships.`,
    );
  }
  const files = [...matched].sort().filter(isScannedFile);
  const violations = files.flatMap((file) =>
    fileViolations(file, readFileSync(resolve(root, file), "utf8")),
  );
  return { files, violations };
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { files, violations } = scanRepo(root);
  if (violations.length > 0) {
    console.error(
      `Egress claim check failed (${violations.length} unallowlisted URL literal${violations.length === 1 ? "" : "s"}):\n`,
    );
    for (const v of violations) console.error("  " + v);
    console.error(
      "\nA new host reached from shipped source falsifies PRIVACY.md, which is written for agency security reviewers: no analytics or third-party tracking scripts, no third-party content delivery, no update ping, no telemetry.",
    );
    console.error(
      "If the literal is egress the document does not disclose, it is the document that has to change, not this list. If it does not contradict the document -- because it names no host anything contacts (a namespace identifier, a document link the operator clicks, a base URL only handed to a parser), or because the host it names is already in PRIVACY.md's supporting-services table -- add it to ALLOWLIST in scripts/check-egress-claims.mjs with the one-line reason why.",
    );
    process.exit(1);
  }
  console.log(
    `Egress claim check passed: ${files.length} files across ${SCANNED_ROOTS.length} shipped-source trees and ${SCANNED_FILES.length} container files hold no URL literal outside the ${ALLOWLIST.length}-entry allowlist.`,
  );
}
