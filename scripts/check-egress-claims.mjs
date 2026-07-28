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
// is encoded as a check: an absolute URL literal in shipped source either sits
// on ALLOWLIST below, each entry carrying the reason it is not egress, or it
// fails the build.
//
// WHAT THIS CHECK DOES NOT COVER, and cannot:
//
//   - Egress assembled at runtime. A host built from configuration, from an
//     operator-supplied value, or by string concatenation never appears as a
//     literal. The invitation endpoint and the operator's SFTP server are
//     legitimately of this kind, so a literal scan is the only shape available
//     here; it is a backstop, not a proof of no egress.
//   - Egress originating inside a dependency. Only first-party source under
//     SCANNED_ROOTS is read; what a package does at runtime is the dependency
//     review's ground (CONTRIBUTING.md, Dependency Policy).
//   - A URL spelled so as to evade the matcher: split across concatenated
//     string fragments, escaped inside a regular expression (`https:\/\/`),
//     or percent- or entity-encoded. The check is a guard against egress added
//     inadvertently, not against an author who wants to hide it.
//   - Schemes outside http, https, stun, stuns, turn, and turns.
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
// Test files are NOT excluded. The scanned roots are shipped-source trees by
// construction (the suites live in sibling test/ directories), so a `*.test.*`
// exclusion would only open a bypass; a test that ever lands under one of these
// roots earns an allowlist entry like anything else.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Shipped-source trees the egress claims are made about. */
export const SCANNED_ROOTS = [
  "apps/web/src",
  "apps/cli/src",
  "packages/core/src",
  "apps/web/public",
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
// so an IPv6 host literal is not truncated to nothing. The stripper and the
// matcher share the set, or a URL one of them consumes whole could end mid-way
// through the other.
const TERMINATOR_CHARS = "\\s\"'`<>(),;}\\\\";
const URL_TERMINATOR = new RegExp(`[${TERMINATOR_CHARS}]`);
const URL_LITERAL = new RegExp(
  `(?<![A-Za-z0-9_])(?<scheme>https?|stuns?|turns?):(?<rest>[^${TERMINATOR_CHARS}]*)`,
  "gi",
);

// A scheme immediately before a `//`, which makes those slashes part of a URL
// rather than the start of a line comment.
const SCHEME_BEFORE_SLASHES = /[A-Za-z][A-Za-z0-9+.-]*:$/;

/** Whether `path` is scanned at all (a text file that is not license text). */
export function isScannedFile(path) {
  if (NOTICE_BASENAMES.has(basename(path))) return false;
  return !BINARY_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * Blank out `//` line comments and block comments, preserving every other
 * character position so line numbers survive.
 *
 * String-aware in both directions, which is the whole difficulty: a `//` inside
 * a string or template literal is not a comment start (or the check would be
 * blind to `"https://evil.example"`, exactly what it exists to catch), and a
 * `//` preceded by a scheme is consumed as part of its URL (or an unquoted
 * `url(http://...)` in CSS would be eaten as a comment).
 *
 * `'` and `"` states are scoped to one line, since neither string form spans a
 * newline unescaped. That bounds the damage when an apostrophe in JSX text or a
 * quote inside a regular-expression character class opens a state that is not
 * really a string: the mis-read ends at the newline, and its failure direction
 * is a comment left unstripped -- a loud false positive -- rather than a string
 * silently swallowed.
 */
export function stripComments(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  // "code" | "line" | "block" | "single" | "double" | "template"
  let state = "code";
  // Template literals nest: `${` inside one returns to code, and the matching
  // `}` returns to the template. Each entry is a brace depth.
  const templates = [];
  const blank = (c) => (c === "\n" ? "\n" : " ");

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      } else {
        out += blank(c);
      }
      i += 1;
      continue;
    }

    if (state === "block") {
      if (c === "*" && next === "/") {
        state = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += blank(c);
      i += 1;
      continue;
    }

    if (state === "single" || state === "double") {
      out += c;
      if (c === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (c === "\n") state = "code";
      else if (c === (state === "single" ? "'" : '"')) state = "code";
      i += 1;
      continue;
    }

    if (state === "template") {
      out += c;
      if (c === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (c === "`") state = "code";
      else if (c === "$" && next === "{") {
        out += next;
        templates.push(0);
        state = "code";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    // state === "code"
    if (c === "\\" && next !== undefined) {
      // A backslash outside a string is a regular-expression escape. Copying
      // the escaped character with it is what keeps `/\//g` -- an escaped
      // slash abutting the regex's closing one -- from reading as a `//`
      // comment and blanking the rest of the line.
      out += c + next;
      i += 2;
      continue;
    }
    if (c === "/" && next === "/") {
      if (SCHEME_BEFORE_SLASHES.test(source.slice(Math.max(0, i - 64), i))) {
        // Part of a URL: copy the whole literal so nothing inside it -- a `/*`
        // in a path, say -- is read as a comment opener.
        while (i < n && !URL_TERMINATOR.test(source[i])) {
          out += source[i];
          i += 1;
        }
        continue;
      }
      state = "line";
      out += "  ";
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      state = "block";
      out += "  ";
      i += 2;
      continue;
    }
    out += c;
    if (c === "'") state = "single";
    else if (c === '"') state = "double";
    else if (c === "`") state = "template";
    else if (c === "{" && templates.length > 0) {
      templates[templates.length - 1] += 1;
    } else if (c === "}" && templates.length > 0) {
      if (templates[templates.length - 1] === 0) {
        templates.pop();
        state = "template";
      } else {
        templates[templates.length - 1] -= 1;
      }
    }
    i += 1;
  }

  return out;
}

/**
 * Absolute URL literals in `source` as `{url, authority, line}`, after comment
 * stripping. Four shapes are excluded here rather than allowlisted, because
 * none of them names a host:
 *
 *   - `http`/`https` without `://`, which is a protocol comparison
 *     (`location.protocol === "https:"`), not a URL.
 *   - `stun`/`turn` whose colon is not immediately followed by a host
 *     character. This is what makes the check usable at all: `stun:` and
 *     `turn:` are also object-property syntax in a Zod schema, the head of a
 *     `/^turns?:/` anchor, and the tail of prose like "must begin with turn:".
 *   - An authority opening with a `${` interpolation, which names whatever the
 *     expression evaluates to (the `URL`-parsing helpers over an inbound `Host`
 *     header do this) rather than a literal host.
 *   - An authority holding no alphanumeric character, such as the elided
 *     `https://...#...` in placeholder text.
 */
export function urlLiterals(source) {
  const found = [];
  const text = stripComments(source);
  let lineStart = 0;
  let line = 1;
  for (const match of text.matchAll(URL_LITERAL)) {
    const { scheme, rest } = match.groups;
    const isWeb = /^https?$/i.test(scheme);
    if (isWeb && !rest.startsWith("//")) continue;
    const afterScheme = isWeb ? rest.slice(2) : rest;
    if (afterScheme === "" || afterScheme.startsWith("/")) continue;
    const authority = afterScheme.split(/[/?#]/, 1)[0];
    if (authority.startsWith("${")) continue;
    if (!/[A-Za-z0-9]/.test(authority)) continue;

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
  return urlLiterals(source)
    .filter(({ url }) => allowlistEntryFor(url) === undefined)
    .map(
      ({ url, line }) =>
        `${path}:${line}: unallowlisted URL literal \`${url}\` -- PRIVACY.md tells agency reviewers the container "makes no other network connection" and the hosted web application "makes no request to any host other than the supporting services named below"`,
    );
}

/** Scan the real trees under `root`, returning the files read and what failed. */
export function scanRepo(root) {
  const listed = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...SCANNED_ROOTS,
    ],
    { cwd: root, encoding: "utf8" },
  );
  const files = listed.split("\n").filter(Boolean).filter(isScannedFile);
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
      "If the literal is egress, it is the document that has to change, not this list. If it names no host anything contacts -- a namespace identifier, a document link the operator clicks, a base URL only handed to a parser -- add it to ALLOWLIST in scripts/check-egress-claims.mjs with the one-line reason why.",
    );
    process.exit(1);
  }
  console.log(
    `Egress claim check passed: ${files.length} files across ${SCANNED_ROOTS.length} shipped-source trees hold no URL literal outside the ${ALLOWLIST.length}-entry allowlist.`,
  );
}
