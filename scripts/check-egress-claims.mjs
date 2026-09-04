#!/usr/bin/env node
// URL-literal egress guard, run by static_checks.yaml on every PR.
//
// PRIVACY.md publishes critical NEGATIVE claims to agency security,
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
// under one of the schemes below either sits on ALLOWLIST, each entry stating
// the reason it does not contradict the document, or it fails the build.
//
// WHAT THIS CHECK DOES NOT COVER -- most of it past the reach of a literal
// scan, the rest by decision:
//
//   - Egress assembled at runtime. A host built from configuration, from an
//     operator-supplied value, or by string concatenation never appears as a
//     literal. The invitation endpoint and the operator's SFTP server are
//     legitimately of this kind, so a literal scan is the only shape available
//     here; it is a safety check, not a proof of no egress.
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
//     decoded as UTF-8, so a UTF-16 one displays as its characters separated by
//     NULs, matches nothing, and is still counted among the files scanned.
//   - A URL literal inside a JavaScript or TypeScript comment. A comment holds
//     no literal node, so a `@see` link in a JSDoc block and a trailing
//     `// https://cdn.example/a.js` alike go unreported. This is a decision
//     rather than a limit of reach: a comment issues no request, and a
//     documentation link would otherwise have to be allowlisted. It reaches the
//     JavaScript and TypeScript family alone; every other text format is
//     scanned raw, for the reason set out below.
//   - A URL spelled so as to evade the matcher: split across concatenated
//     string fragments, written into a regular-expression literal, whose node
//     the extraction does not read, percent- or entity-encoded in the scheme or
//     the colon after it (`%68ttps://`, `&#104;ttps://`, `https%3A//`,
//     `https&#58;//`; an encoded host is still reported, since the scheme is
//     what the matcher reads), or glued to a letter, digit, or underscore
//     (`xhttps://host`, `_https://host`), none of which the scheme rule admits
//     before the scheme; any other character, or the start of the text, still
//     matches (`.https://host` and `-https://host` are reported). An escape the
//     language itself removes is not among these: a literal is read as its
//     cooked value, so the regex-escaped spelling written into a string
//     (`"https:\/\/host"`) is reported as the `https://host` it evaluates to.
//     The check is a guard against egress added inadvertently, not against an
//     author who wants to hide it.
//   - Schemes outside http, https, stun, stuns, turn, and turns: a `wss://`,
//     `ws://`, `ftp://` or `file://` literal names a host and is not reported.
//     Nor is a protocol-relative `//host` reference, which has no scheme to
//     match.
//   - An authority naming no host of its own: empty, a scheme followed by
//     nothing but slashes, which is what a protocol comparison
//     (`location.protocol === "https:"`) is; wholly interpolated inside a
//     template (`http://${host}`, `http://${host}:8443`), as the helpers over
//     an inbound Host header write it; or written entirely of dots, which
//     `new URL()` does resolve to the host `...` but is how elided placeholder
//     text writes a URL (`https://...#...` in the invitation field). Those are
//     skipped knowingly; why none of them can be tightened is at urlsIn and
//     resolvedHost. An interpolation with a literal host beside it names a host
//     and is reported (`https://${tenant}.evil.example`), and so does the same
//     text written where the parser says nothing interpolates: in a string or a
//     JSX attribute value, `https://${host}` names the host `${host}`. The node
//     the parser reports is what decides, not the characters.
//
// The opposite direction is loud and left that way: an authority spelling out
// host-shaped text is reported even where `new URL()` rejects it outright
// (`https://%zz/`, `https://[not-ipv6]/`, `https://[2001:db8::1`,
// `https://a:b/`, `https://ex^ample/`, `https://exa|mple/`), and so is an
// authority of nothing but a port outside a template (`https://:8443/x`).
// `new URL()` is the host oracle for the authorities it accepts, and a literal
// nothing could dereference can still fail the build; the author resolves that
// by rewriting the literal or allowlisting it with a reason.
//
// These limits are published rather than internal: PRIVACY.md summarizes them
// for agency reviewers and docs/SECURITY_DESIGN.md ("Egress hardening and its
// limits") enumerates them, so narrowing one here moves all three.
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
// Where a literal begins and ends is the language's own question, so the
// JavaScript and TypeScript family is read from the string, template, and
// JSX-text nodes of a TypeScript parse: a URL cannot run past the literal
// holding it, and whether a `${` interpolates is what the parser says rather
// than what the characters look like. That reaches the one family a parser is
// run for here. Every other text format -- CSS, HTML, SVG, Markdown, shell --
// is scanned raw, and so is a file of this family whose parse reports a syntax
// error: such a parse yields no literal nodes at all, and reporting a file
// clean because nothing could be extracted from it is the one direction this
// check cannot afford. A raw scan reads comment text too, so those files
// over-report rather than under-report.
//
// SCANNED_ROOTS is source that ships or runs, not all TypeScript. Beside the
// app and library trees and the web app's static assets it includes
// apps/web/server, the Nitro entry point the deployed server boots (named by
// apps/web/nitro.config.ts). The signaling broker's whole src is among the
// library trees: the web build bundles it into that same server, and its
// standalone entry point runs the identical wiring as a service of its own.
// SCANNED_FILES contains the shipped files that sit
// outside any scanned tree, for both images: the two entrypoints,
// docker-entrypoint.sh and docker-entrypoint-fips.sh, which run inside the
// container the "no other network connection" claim is about (each is its
// image's ENTRYPOINT); the two files of support/fips-probe/ the FIPS variant
// COPYs in, which its entrypoint runs at every container start and which are
// therefore as shipped as the entrypoint itself, the rest of that directory
// being a harness that ships nowhere; and the two Dockerfiles, Dockerfile and
// Dockerfile.fips, which reach a different class -- what the image build
// fetches rather than what the running container connects to -- scanned anyway,
// because a `RUN curl` or `ADD https://...` pulling a third party into the
// image is what a reviewer of that claim wants shown.
//
// By design, outside both: the build and test configuration at each workspace
// root and the sibling test/ trees; and apps/web/deploy, whose nginx and
// platform-hook files configure the Elastic Beanstalk host rather than the
// application, addressing the instance itself (127.0.0.1, the EC2 metadata
// service) and belonging to deploy review. The test trees and the deploy files
// reach no user; build configuration does, through what it emits, which is why
// it is listed above as a gap rather than a safe exclusion. A tree that starts
// shipping is added here, so an exclusion is treated as the decision it is
// rather than an oversight.
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
  "packages/peerjs-broker/src",
  "apps/web/public",
  "apps/web/server",
];

/** Shipped files that build or run the container, outside any scanned tree. */
export const SCANNED_FILES = [
  "Dockerfile",
  "docker-entrypoint.sh",
  "Dockerfile.fips",
  "docker-entrypoint-fips.sh",
  "support/fips-probe/engagement.mjs",
  "support/fips-probe/image-engagement.mjs",
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
      "the FIPS variant image's build fetches the official Node runtime tarball from here, because Amazon Linux 2023 packages no Node 26; what the build fetches, not a connection the running container makes, and the same class as the Alpine mirror the default image's one apk install reaches",
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

// Where a URL ends inside the text holding it: whitespace, the quote forms,
// and the punctuation that brackets one in TypeScript, JSX, and CSS. Braces are
// left out and read at endOfUrl instead, where whether a `}` closes syntax or
// spells text is a question about the candidate rather than the character. `[`
// and `]` are left out so an IPv6 host literal is not truncated to nothing.
const URL_TERMINATOR = /[\s"'`<>(),;\\]/;

const URL_SCHEME = new RegExp(
  `(?<![A-Za-z0-9_])(?<scheme>https?|stuns?|turns?):`,
  "gi",
);

// An authority that survives interpolation as nothing but a port. A numeric
// port is literal text a fully interpolated authority leaves behind
// (`${host}:8443`), and `new URL()` rejects a non-numeric one, so nothing a
// host could hide in is dropped with it.
const TRAILING_PORT = /:\d*$/;

// The parser resolves the elided placeholder text of the invitation field
// (`https://...#...`) to a host of nothing but dots, which names no server.
const DOTS_ONLY = /^\.+$/;

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

/** Whether `path` is read by the TypeScript parser rather than scanned raw. */
export function isJavaScriptFamily(path) {
  return SCRIPT_KIND_BY_EXTENSION.has(extname(path).toLowerCase());
}

/** The 1-based line the character at `position` of `source` sits on. */
function lineOf(source, position) {
  let line = 1;
  for (let index = 0; index < position; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

/**
 * One candidate: the text a matcher reads, assembled from the segments that
 * wrote it. A segment is either literal text or, in a template, the `${...}`
 * span between two literal ones, and each records where its text starts in the
 * file. A segment whose text the file spells verbatim maps its own offsets
 * straight back; one the parser rewrote (a literal holding an escape) reports
 * the position it begins at.
 *
 * A `raw` candidate is the whole text of a file no parser was run for, which
 * is what decides how a brace in it is read (endOfUrl).
 */
function candidateOf(source, segments, raw = false) {
  let text = "";
  const placed = [];
  for (const segment of segments) {
    placed.push({
      ...segment,
      at: text.length,
      verbatim: source.startsWith(segment.text, segment.sourceStart),
    });
    text += segment.text;
  }
  return { text, segments: placed, raw };
}

/** The segment `offset` falls in. */
function segmentAt(candidate, offset) {
  return candidate.segments.findLast((segment) => segment.at <= offset);
}

/** Whether `offset` is interpolated text rather than text the literal spells. */
function isInterpolated(candidate, offset) {
  return segmentAt(candidate, offset).interpolation === true;
}

/** Where in the file the character at `offset` of the candidate sits. */
function positionOf(candidate, offset) {
  const segment = segmentAt(candidate, offset);
  return segment.verbatim
    ? segment.sourceStart + (offset - segment.at)
    : segment.sourceStart;
}

/**
 * A template as one candidate, its literal spans holding the source text of
 * each `${...}` between them. Both template expressions and template literal
 * types are written this way, and the spans are read the same for either.
 *
 * The head token ends just past the `${` it opens, and each following literal
 * token starts at the `}` that closes it, which is what bounds the span.
 */
function templateCandidate(source, parsed, node) {
  const segments = [
    { text: node.head.text, sourceStart: node.head.getStart(parsed) + 1 },
  ];
  let opened = node.head.end;
  for (const span of node.templateSpans) {
    const closing = span.literal.getStart(parsed);
    segments.push({
      text: source.slice(opened - "${".length, closing + "}".length),
      sourceStart: opened - "${".length,
      interpolation: true,
    });
    segments.push({
      text: span.literal.text,
      sourceStart: closing + "}".length,
    });
    opened = span.literal.end;
  }
  return candidateOf(source, segments);
}

/**
 * The literals a TypeScript parse of `source` holds, or undefined when the
 * parser reports a syntax error: a broken parse yields no literal nodes, so the
 * caller scans such a file raw rather than reading nothing out of it.
 */
function parsedLiterals(source, path) {
  const parsed = ts.createSourceFile(
    basename(path),
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    SCRIPT_KIND_BY_EXTENSION.get(extname(path).toLowerCase()),
  );
  // `parseDiagnostics` is off the public SourceFile type. A TypeScript upgrade
  // that renames it therefore is treated as "cannot parse", which scans the
  // file raw and over-reports, rather than as "parsed clean".
  if (parsed.parseDiagnostics?.length !== 0) return undefined;

  const literals = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.push(
        candidateOf(source, [
          { text: node.text, sourceStart: node.getStart(parsed) + 1 },
        ]),
      );
    } else if (ts.isJsxText(node)) {
      literals.push(
        candidateOf(source, [{ text: node.text, sourceStart: node.pos }]),
      );
    } else if (
      ts.isTemplateExpression(node) ||
      ts.isTemplateLiteralTypeNode(node)
    ) {
      literals.push(templateCandidate(source, parsed, node));
    }
    node.forEachChild(visit);
  };
  visit(parsed);
  return literals;
}

/**
 * Where the URL beginning at `start` ends: the first terminator the candidate's
 * own reading of the text admits.
 *
 * A parsed candidate holds the parser's word on which spans interpolate, so a
 * terminator inside one of them belongs to the expression rather than to the
 * URL, and a brace is never a terminator at all: in a template it opens or
 * closes a span whose text belongs to the authority the literal writes, and in
 * a string or a JSX attribute value the parser says those characters are text.
 *
 * A raw candidate has no such word, and the formats scanned raw write braces as
 * syntax of their own: shell and Dockerfile parameter expansion. There a `${`
 * opens a span its matching `}` closes, both part of the URL
 * (`https://nodejs.org/dist/${NODE_VERSION}/x`), while a `}` that opened
 * nothing ends it -- the one closing `${SFTP_ENDPOINT:-https://host}`, which
 * lands in the reported host if the URL swallows it.
 */
function endOfUrl(candidate, start) {
  let depth = 0;
  for (let offset = start; offset < candidate.text.length; offset += 1) {
    const char = candidate.text[offset];
    if (candidate.raw) {
      if (char === "$" && candidate.text[offset + 1] === "{") {
        depth += 1;
        offset += 1;
        continue;
      }
      if (char === "}") {
        if (depth === 0) return offset;
        depth -= 1;
        continue;
      }
    }
    if (URL_TERMINATOR.test(char) && !isInterpolated(candidate, offset)) {
      return offset;
    }
  }
  return candidate.text.length;
}

/**
 * The host `new URL()` resolves `authority` to, or undefined where it rejects
 * it outright. The parser is the oracle for both directions, and it is handed
 * an authority position rather than the literal as written: `stun:` and `turn:`
 * URIs have no `//` (RFC 7064, RFC 7065), and the slash count of a web URL
 * means nothing either, since `new URL()` resolves `https:host/x` through
 * `https:////host/x` alike and `fetch` dereferences them alike too.
 *
 * What that buys over judging the characters: an internationalized host is a
 * host, whatever alphabet it is written in (`https://пример.рф/` resolves to
 * `xn--e1afmkfd.xn--p1ai`, which resolves and serves), a bracketed `[::]` is
 * one, and a port is separated from the host by the same rules the runtime
 * applies rather than by a rule of our own.
 */
function resolvedHost(authority) {
  try {
    return new URL(`https://${authority}`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * The absolute URL literals `candidate` holds, as `{url, host, line}`, where
 * `host` is what the URL parser resolved and undefined where it rejected the
 * authority as unparseable -- reported all the same, and loudly.
 *
 * Two shapes are excluded here rather than allowlisted, because neither names a
 * host:
 *
 *   - An empty authority -- a scheme followed by nothing but slashes, which is
 *     what a protocol comparison (`location.protocol === "https:"`) is, and
 *     what makes the check usable at all for the other schemes: `stun:` and
 *     `turn:` are also object-property syntax in a Zod schema, the head of a
 *     `/^turns?:/` anchor, and the tail of prose like "must begin with turn:".
 *   - An authority a template interpolates away, as the `URL`-parsing helpers
 *     over an inbound `Host` header write it (`http://${host}`,
 *     `http://${host}:8443`). Only text the parser calls an interpolation is
 *     removed, so the same characters inside a string or a JSX attribute value
 *     stay the literal host they are.
 */
function urlsIn(source, candidate) {
  const found = [];
  for (const match of candidate.text.matchAll(URL_SCHEME)) {
    // A scheme inside an interpolation belongs to the expression, whose own
    // literals are candidates in their own right.
    if (isInterpolated(candidate, match.index)) continue;

    const start = match.index + match[0].length;
    const end = endOfUrl(candidate, start);
    const body = candidate.text.slice(start, end);
    const authorityStart = start + /^\/*/.exec(body)[0].length;
    let authority = "";
    for (let offset = authorityStart; offset < end; offset += 1) {
      if (!isInterpolated(candidate, offset)) {
        authority += candidate.text[offset];
      }
    }
    if (authority === "") continue;
    // What an interpolation left behind can still be a whole authority's worth
    // of punctuation, which is why the port comes off before the parser sees it.
    const interpolated = authority.length !== end - authorityStart;
    if (
      interpolated &&
      authority.split(/[/?#]/, 1)[0].replace(TRAILING_PORT, "") === ""
    ) {
      continue;
    }

    const host = resolvedHost(authority);
    if (host !== undefined && DOTS_ONLY.test(host)) continue;
    found.push({
      url: `${match.groups.scheme}:${body}`,
      host,
      line: lineOf(source, positionOf(candidate, match.index)),
    });
  }
  return found;
}

/**
 * Absolute URL literals in `source` as `{url, host, line}`, read from the
 * parser's literal nodes for a JavaScript-family file and from the raw text for
 * every other format.
 */
export function urlLiterals(source, path) {
  const parsed = isJavaScriptFamily(path)
    ? parsedLiterals(source, path)
    : undefined;
  const candidates = parsed ?? [
    candidateOf(source, [{ text: source, sourceStart: 0 }], /* raw */ true),
  ];
  return candidates.flatMap((candidate) => urlsIn(source, candidate));
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
