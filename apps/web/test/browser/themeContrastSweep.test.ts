/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

// Load Mantine's stylesheet so the swept surfaces render with their real
// geometry and painted backgrounds (the .page ground, the input fills), not the
// unstyled DOM a contrast walk cannot resolve a background from.
import "@mantine/core/styles.css";

import { encodeInvitation, generateSharedSecret } from "@psilink/core";

import { AcceptorBench } from "@bench/AcceptorBench";
import { BenchLobby } from "@bench/BenchLobby";
import { InviterBench } from "@bench/InviterBench";
import { VerifyReceiptBench } from "@bench/VerifyReceiptBench";

import { renderApp } from "./renderApp";

import type { InvitationToken, LinkageTerms } from "@psilink/core";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

// BREADTH contrast sweep over the primary rendered web routes, complementing --
// not replacing -- test/browser/themeContrast.test.ts. That harness pins a
// handful of theme tokens by their exact resolved colour; it proves the token
// arithmetic but samples nothing at the call sites. This sweep is the other
// axis: it mounts each primary route surface and measures EVERY rendered
// text-bearing element against the WCAG 2.1 AA floor, in both colour schemes, so
// a per-call-site drift a token-pin never sees -- a stray `c=`/`color=` on a
// Text, a non-filled variant on a primary Button/ActionIcon/Checkbox, an anchor
// repainted by a stylesheet rule -- fails here. Neither harness subsumes the
// other: keep both.
//
// In-house, not axe-core: the contrast check is the local WCAG luminance/ratio
// math below (~10 lines, the same formula as themeContrast.test.ts, kept
// self-contained here on purpose -- see the note on that duplication below),
// walking computed styles. axe-core would add a dev dependency and a second
// colour engine for a check this app can do against its own rendered tree; the
// dependency was weighed and declined.
//
// Swept routes (extend this set when a top-level screen is added):
//   /         bench lobby     -> BenchLobby
//   /exchange inviter bench   -> InviterBench (initial "Your file" step)
//   /accept   acceptor bench  -> AcceptorBench (review step, a valid token in
//                                the hash -- the route's real initial state)
//   /verify   verify receipt  -> VerifyReceiptBench (initial mount)
// Each renders through renderApp (the app's real MantineProvider + resolver
// config) in BOTH forceColorScheme: "light" and "dark", so a surface AA-clean in
// one scheme but not the other is still caught.
//
// KNOWN BLIND SPOTS (this sweep is a breadth net, not full WCAG coverage):
//   - Gradients and background images: only a solid computed backgroundColor is
//     resolved. A text element painted over a gradient or image resolves to the
//     nearest solid layer beneath it, which may not be what the eye sees.
//   - Overlapping / z-stacked layers: the walk climbs the DOM ancestor chain, not
//     the paint order, so a sibling that visually overlaps a text element is not
//     considered.
//   - Genuinely transparent stacks: where no ancestor (up to the page canvas)
//     paints an opaque background, the element is RECORDED as unresolved rather
//     than silently passed -- see the unresolved handling below.
//   - Disabled controls: WCAG 1.4.3 exempts disabled elements, so they are
//     skipped; a disabled control's contrast is not asserted here.
//   - Deeper interaction states (a loaded file, a run in flight, hover/focus
//     colours): this stays at each route's initial mount for determinism; the
//     per-surface harness drives the specific hover/variant states it pins.

const acceptorTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "firstName", type: "first_name" },
    { name: "lastName", type: "last_name" },
  ],
  linkageKeys: [
    { name: "first", elements: [{ field: "firstName" }] },
    { name: "last", elements: [{ field: "lastName" }] },
  ],
};

/** A checksum-valid invitation for the acceptor's initial (review) surface. The
 * shared secret is random, but nothing here reads its value: it only has to
 * decode to a ready invitation so the review step -- the acceptor route's real
 * landing surface -- renders its terms and Continue action for the sweep. */
async function encodeAcceptToken(): Promise<string> {
  const token: InvitationToken = {
    version: "1",
    linkageTerms: acceptorTerms,
    sharedSecret: generateSharedSecret(),
    connectionEndpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
  };
  return encodeInvitation(token);
}

// Router seam: the lobby's action cards and the "recurring" links are Links;
// render them as plain anchors so the surfaces mount without the router. The
// bench.test.ts / benchAccept.test.ts pattern. (vitest hoists vi.mock.)
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    className,
    children,
    ...rest
  }: {
    to?: string;
    className?: string;
    children?: ReactNode;
    [prop: string]: unknown;
  }) =>
    createElement(
      "a",
      { ...rest, href: typeof to === "string" ? to : "#", className },
      children,
    ),
  useNavigate: () => () => undefined,
}));

// Stub the rendezvous module: importing it runs a top-level config load that
// reads `process` (absent in the browser runner). Its dial/listen functions run
// only inside a run lifecycle these initial mounts never start.
vi.mock("@psi/rendezvous", () => ({
  dialAsAcceptor: vi.fn(),
  listenAsInviter: vi.fn(),
}));

// Stub the run lifecycle so nothing dials; no run is launched from an initial
// mount, but the stub keeps the import inert either way.
vi.mock("@psi/exchangeLifecycle", () => ({
  runExchangeLifecycle: () => Promise.resolve(),
}));

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount(scheme: "light" | "dark", node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(renderApp(node, { forceColorScheme: scheme }));
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  window.location.hash = "";
});

/** sRGB channels + alpha of a computed `rgb(r, g, b)` / `rgba(r, g, b, a)`
 * string. Alpha defaults to 1 when absent. */
function rgba(color: string): [number, number, number, number] {
  const m = color.match(/-?\d+(\.\d+)?/g);
  if (m === null || m.length < 3)
    throw new Error(`unparseable color: ${color}`);
  return [
    Number(m[0]),
    Number(m[1]),
    Number(m[2]),
    m.length >= 4 ? Number(m[3]) : 1,
  ];
}

/** WCAG 2.1 relative luminance of an opaque `rgb(r, g, b)` triple. The 0.03928
 * threshold is the value printed in the WCAG 2.1 text (and used by Mantine's own
 * luminance()), matching the byte-for-byte copy in themeContrast.test.ts; kept
 * duplicated on purpose -- the acceptance brief asks this sweep to stay
 * self-contained so it does not churn or merge-conflict the token harness for a
 * ten-line formula. */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const linear = (v: number) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  return (
    0.2126 * linear(r / 255) +
    0.7152 * linear(g / 255) +
    0.0722 * linear(b / 255)
  );
}

/** WCAG contrast ratio between two opaque `rgb` triples (1..21). */
function contrast(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Composite `top` (which may carry alpha) over the opaque `under`, returning the
 * resulting opaque triple (the standard source-over "over" operator). */
function composite(
  top: [number, number, number, number],
  under: [number, number, number],
): [number, number, number] {
  const a = top[3];
  return [
    top[0] * a + under[0] * (1 - a),
    top[1] * a + under[1] * (1 - a),
    top[2] * a + under[2] * (1 - a),
  ];
}

/** The page canvas the app paints behind everything: Mantine's
 * --mantine-color-body (white in light, dark-7 in dark), resolved on the document
 * element. Used as the base an ancestor walk composites onto when the walk itself
 * never reaches an opaque paint. Returns undefined only if even the canvas
 * resolves transparent. */
function pageCanvas(): [number, number, number] | undefined {
  const body = getComputedStyle(document.documentElement).getPropertyValue(
    "--mantine-color-body",
  );
  if (body.trim() === "") return undefined;
  const probe = document.createElement("span");
  probe.style.color = body;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const [r, g, b, a] = rgba(resolved);
  return a === 0 ? undefined : [r, g, b];
}

/** Fold the translucent layers gathered from the innermost outward onto an opaque
 * base: the outermost gathered layer sits nearest the base, so composite from the
 * end of the list inward. */
function foldLayers(
  layers: Array<[number, number, number, number]>,
  base: [number, number, number],
): [number, number, number] {
  let result = base;
  for (let i = layers.length - 1; i >= 0; i -= 1)
    result = composite(layers[i], result);
  return result;
}

/** Resolve the effective (opaque) background painted behind `el` by walking its
 * ancestor chain, compositing each translucent layer over the one beneath, until
 * an opaque layer is reached; then the page canvas is the base. Returns undefined
 * (recorded, never silently passed) when nothing up to and including the canvas
 * paints -- a genuinely transparent stack this walk cannot resolve. */
function effectiveBackground(
  el: HTMLElement,
): [number, number, number] | undefined {
  const layers: Array<[number, number, number, number]> = [];
  let node: HTMLElement | null = el;
  while (node !== null) {
    const [r, g, b, a] = rgba(getComputedStyle(node).backgroundColor);
    if (a > 0) {
      if (a >= 1) return foldLayers(layers, [r, g, b]);
      layers.push([r, g, b, a]);
    }
    node = node.parentElement;
  }
  const canvas = pageCanvas();
  if (canvas === undefined) return undefined;
  return foldLayers(layers, canvas);
}

/** True when `el` is not painted (so its text is not seen and not judged):
 * display:none, visibility hidden, aria-hidden, the hidden attribute, or a zero
 * box. A disabled control is also excluded -- WCAG 1.4.3 exempts disabled
 * elements (a documented blind spot). */
function isSkippable(el: HTMLElement): boolean {
  if (el.closest("[hidden]") !== null) return true;
  if (el.closest('[aria-hidden="true"]') !== null) return true;
  if (
    el.closest(":disabled") !== null ||
    el.closest('[aria-disabled="true"]') !== null
  )
    return true;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return true;
  const rect = el.getBoundingClientRect();
  return rect.width === 0 || rect.height === 0;
}

/** Whether `el` owns a direct, non-whitespace text node -- the text this element
 * paints in its own colour (a text node belongs to exactly one element, so each
 * run of text is judged once, on the element that renders it). */
function ownsText(el: HTMLElement): boolean {
  for (const node of el.childNodes)
    if (
      node.nodeType === Node.TEXT_NODE &&
      (node.textContent ?? "").trim() !== ""
    )
      return true;
  return false;
}

/** WCAG "large text": >= 24px, or >= 18.66px when bold (>= 700). Large text
 * clears at 3:1; normal text needs 4.5:1. */
function largeTextFloor(style: CSSStyleDeclaration): number {
  const px = parseFloat(style.fontSize);
  const bold = Number(style.fontWeight) >= 700;
  const isLarge = px >= 24 || (bold && px >= 18.66);
  return isLarge ? 3 : 4.5;
}

interface Failure {
  text: string;
  color: string;
  background: string;
  ratio: number;
  floor: number;
}

/** Sweep every painted, text-bearing element under `rootEl`, measuring each
 * against its WCAG AA floor. Returns the below-floor failures and any element
 * whose background could not be resolved -- both fail the surface. */
function sweepContrast(rootEl: HTMLElement): {
  failures: Array<Failure>;
  unresolved: Array<string>;
} {
  const failures: Array<Failure> = [];
  const unresolved: Array<string> = [];
  for (const el of rootEl.querySelectorAll<HTMLElement>("*")) {
    if (!ownsText(el) || isSkippable(el)) continue;
    const style = getComputedStyle(el);
    const background = effectiveBackground(el);
    const label = el.textContent.trim().slice(0, 60);
    if (background === undefined) {
      unresolved.push(label);
      continue;
    }
    // Text may itself carry alpha (rare); composite it onto its own background so
    // the ratio is between what is actually painted, not a nominal colour.
    const textColor = composite(rgba(style.color), background);
    const ratio = contrast(textColor, background);
    const floor = largeTextFloor(style);
    if (ratio + 1e-9 < floor)
      failures.push({
        text: label,
        color: style.color,
        background: `rgb(${background.map(Math.round).join(", ")})`,
        ratio: Number(ratio.toFixed(2)),
        floor,
      });
  }
  return { failures, unresolved };
}

/** Wait for the mounted surface's landmark heading (createRoot.render is not
 * synchronous), then read the resting background of any filled-primary control
 * off its hover state, and sweep.
 *
 * The browser project shares one pointer across the suite, so a filled-primary
 * button the sticky pointer happens to land on paints its hover fill (one shade
 * lighter), which drops white-on-fill under the AA floor -- the resting colour
 * the surface actually ships clears it. Moving the pointer off each such control
 * (unhover ignores its argument and parks the pointer on the body) settles it to
 * the resting state before the sweep reads it, so the sweep measures what ships,
 * not a transient hover. themeContrast.test.ts de-flakes its own reads the same
 * way. A surface with no such control just no-ops. */
async function mountAndSweep(
  scheme: "light" | "dark",
  node: ReactNode,
): Promise<ReturnType<typeof sweepContrast>> {
  mount(scheme, node);
  await expect.poll(() => container!.querySelector("h1")).not.toBeNull();
  for (const control of container!.querySelectorAll<HTMLElement>(
    ".mantine-Button-root, .mantine-ActionIcon-root",
  )) {
    if (control.matches(":hover")) {
      await userEvent.unhover(control);
      await expect.poll(() => control.matches(":hover")).toBe(false);
    }
  }
  return sweepContrast(container!);
}

const ROUTES: Array<{ route: string; node: () => Promise<ReactNode> }> = [
  { route: "/", node: () => Promise.resolve(createElement(BenchLobby)) },
  {
    route: "/exchange",
    node: () => Promise.resolve(createElement(InviterBench)),
  },
  {
    route: "/accept",
    node: async () => {
      window.location.hash = await encodeAcceptToken();
      return createElement(AcceptorBench);
    },
  },
  {
    route: "/verify",
    node: () => Promise.resolve(createElement(VerifyReceiptBench)),
  },
];

describe("primary-route contrast sweep (WCAG 2.1 AA)", () => {
  for (const { route, node } of ROUTES)
    for (const scheme of ["light", "dark"] as const)
      test(`${route} is AA-clean (${scheme})`, async () => {
        const { failures, unresolved } = await mountAndSweep(
          scheme,
          await node(),
        );
        // A newly-introduced below-floor element (a stray colour, a non-filled
        // primary variant) fails here with the offending text, colours, and ratio.
        expect(failures).toEqual([]);
        // A text element whose background this walk cannot resolve is a coverage
        // gap, not a pass: fail so the sweep is extended rather than the surface
        // quietly under-checked.
        expect(unresolved).toEqual([]);
      });
});
