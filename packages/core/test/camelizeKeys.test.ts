import { expect, test } from "vitest";

import {
  camelizeKeys,
  OPAQUE_VALUE_KEYS,
  snakeizeKeys,
  NestingDepthExceededError,
  MAX_NESTING_DEPTH,
} from "../src/utils/camelizeKeys";

// snakeize a camelCase key the way the production walker's inverse transform
// does, so each opaque key can be exercised in its snake_case spelling on input.
// Test-only; deliberately not imported from production (camelToSnake is private)
// so this test does not re-couple to the very helper it is guarding.
function toSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// A probe subtree whose two marker keys change under different directions:
// `snake_marker` is rewritten by camelize (-> snakeMarker) but is a fixed point
// for snakeize; `camelMarker` is rewritten by snakeize (-> camel_marker) but is
// a fixed point for camelize. So whether a direction descended into a subtree is
// read off the surviving marker: camelize-skipped iff `snake_marker` survives,
// snakeize-skipped iff `camelMarker` survives. `id` is a fixed point for both
// directions, so it labels the subtree stably across the transform.
function probeSubtree(id: string): Record<string, unknown> {
  return { id, snake_marker: 1, camelMarker: 2 };
}

/** Collect every object carrying a string `id`, keyed by that id, from a walked
 *  output -- so a subtree can be located after the transform regardless of depth. */
function indexById(
  value: unknown,
  out: Map<string, Record<string, unknown>>,
): void {
  if (Array.isArray(value)) {
    value.forEach((v) => indexById(v, out));
    return;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.id === "string") out.set(obj.id, obj);
    Object.values(obj).forEach((v) => indexById(v, out));
  }
}

// --- The structural invariant ------------------------------------------------

test("camelize and snakeize skip the identical set of opaque subtrees", () => {
  // Build the probe straight from OPAQUE_VALUE_KEYS, so a second opaque key is
  // covered automatically. Each opaque key appears in both spellings (canonical
  // camelCase and its snake_case form) and at two depths; a non-opaque control
  // key holds an otherwise-identical subtree that must NOT be skipped.
  const expectedSkipped = new Set<string>();
  const probe: Record<string, unknown> = {
    control_key: probeSubtree("control"),
    outer_block: {},
  };
  const outer = probe.outer_block as Record<string, unknown>;
  for (const camelKey of OPAQUE_VALUE_KEYS) {
    const camelId = `opaque-camel:${camelKey}`;
    const snakeId = `opaque-snake:${camelKey}`;
    expectedSkipped.add(camelId).add(snakeId);
    // camelCase spelling at the top level
    probe[camelKey] = probeSubtree(camelId);
    // snake_case spelling nested under a (non-opaque) block
    outer[toSnake(camelKey)] = probeSubtree(snakeId);
  }

  const camelIndex = new Map<string, Record<string, unknown>>();
  indexById(camelizeKeys(probe), camelIndex);
  const snakeIndex = new Map<string, Record<string, unknown>>();
  indexById(snakeizeKeys(probe), snakeIndex);

  const camelSkipped = [...camelIndex]
    .filter(([, o]) => "snake_marker" in o)
    .map(([id]) => id)
    .sort();
  const snakeSkipped = [...snakeIndex]
    .filter(([, o]) => "camelMarker" in o)
    .map(([id]) => id)
    .sort();

  // Both directions skip exactly the same subtrees...
  expect(camelSkipped).toEqual(snakeSkipped);
  // ...and that set is exactly the opaque-keyed subtrees, not the control.
  expect(camelSkipped).toEqual([...expectedSkipped].sort());
  expect(camelSkipped).not.toContain("control");
});

// --- Nesting-depth guard -----------------------------------------------------
// camelizeKeys runs BEFORE Zod on partner-controlled input (parseLinkageTerms),
// and recurses once per nesting level, so a deeply-nested untrusted payload --
// trivially within the invitation and frame caps -- would overflow the call
// stack with a RangeError before any validation. The shared walker bounds the
// depth so it fails as a clean, bounded rejection instead. snakeizeKeys shares
// the walker and so the guard, though its input is operator-produced.

// Build a chain of nested objects whose deepest value (an empty object) sits at
// depth `depth` -- the index transformKeysDeep sees, with the root at depth 0 --
// so the guard boundary can be asserted exactly.
function nestedToDepth(depth: number): unknown {
  let v: unknown = {};
  for (let i = 0; i < depth; i++) v = { nested_key: v };
  return v;
}

test("an ordinary nested payload is camelized at depth as before", () => {
  expect(camelizeKeys({ outer_key: { inner_key: { leaf_key: 1 } } })).toEqual({
    outerKey: { innerKey: { leafKey: 1 } },
  });
});

test("the depth guard fires at exactly MAX_NESTING_DEPTH", () => {
  // The deepest allowed value sits at depth MAX_NESTING_DEPTH - 1; one level
  // deeper (depth MAX_NESTING_DEPTH) is rejected. Pinning the exact boundary --
  // not just MAX +/- a margin -- keeps the guard from drifting by one. Both
  // depths are far below the native stack overflow, so the accepted case proves
  // the guard draws the line, not the stack. The bound is itself far above any
  // real config (the deepest schema path is under a dozen levels).
  expect(() =>
    camelizeKeys(nestedToDepth(MAX_NESTING_DEPTH - 1)),
  ).not.toThrow();
  expect(() => camelizeKeys(nestedToDepth(MAX_NESTING_DEPTH))).toThrow(
    NestingDepthExceededError,
  );
});

test("a pathologically-deep payload fails cleanly, not with a RangeError", () => {
  // ~5000 levels overflowed camelizeKeys's native recursion before the guard;
  // it must now reject with the bounded UsageError. The guard fires at the bound,
  // so the native stack overflow is never reached.
  let err: unknown;
  try {
    camelizeKeys(nestedToDepth(5000));
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(NestingDepthExceededError);
  expect(err).not.toBeInstanceOf(RangeError);
});

test("snakeizeKeys shares the depth guard", () => {
  // The walker is shared, so the write direction is bounded too -- harmless, its
  // input is the operator's typed ExchangeSpec and never this deep.
  expect(() => snakeizeKeys(nestedToDepth(5000))).toThrow(
    NestingDepthExceededError,
  );
});

// --- Round-trip and verbatim behavior ----------------------------------------

test("snakeizeKeys is the inverse of camelizeKeys for schema keys", () => {
  const onDisk = {
    linkage_terms: {
      linkage_fields: [{ name: "first_name", semantic_type: "name" }],
      legal_agreement: { expiration_date: "2030-01-01" },
    },
  };
  // snake -> camel -> snake reproduces the original snake form byte-for-byte.
  expect(snakeizeKeys(camelizeKeys(onDisk))).toEqual(onDisk);
});

test("only keys are rewritten; string values are left verbatim, both directions", () => {
  // The walker applies its transform to object keys only, never to values: a
  // value that happens to look like the other casing (e.g. the `firstName` in a
  // `name: firstName` label) must survive unchanged. Asserted in both directions
  // so neither path can start transforming values undetected.
  expect(camelizeKeys({ some_key: "first_name" })).toEqual({
    someKey: "first_name",
  });
  expect(snakeizeKeys({ someKey: "firstName" })).toEqual({
    some_key: "firstName",
  });
});

test("an opaque map's contents survive a read -> write round-trip verbatim", () => {
  // A snake_case key authored inside provider_options is left verbatim by
  // camelizeKeys (read), and re-snakeizing the camelized form leaves it verbatim
  // again -- the round-trip stability the shared skip exists to guarantee. The
  // direct raw-snake-into-snakeizeKeys path is covered by the next test.
  const input = {
    connection: {
      provider_options: { ready_timeout: 5000, keepAlive: true },
    },
  };
  const camelized = camelizeKeys(input) as {
    connection: { providerOptions: Record<string, unknown> };
  };
  expect(camelized.connection.providerOptions).toEqual({
    ready_timeout: 5000,
    keepAlive: true,
  });
  const snakeized = snakeizeKeys(camelized) as {
    connection: { provider_options: Record<string, unknown> };
  };
  expect(snakeized.connection.provider_options).toEqual({
    ready_timeout: 5000,
    keepAlive: true,
  });
});

test("snakeizeKeys skips an opaque subtree even given raw snake_case keys", () => {
  // The latent hazard the co-location removes: opacity is decided on the
  // canonicalized key, not the raw one, so a snake_case `provider_options` key
  // routed DIRECTLY through snakeizeKeys -- not the typed camelCase ExchangeSpec
  // saveConfig feeds -- is still skipped. Non-opaque camelCase siblings are
  // snakeized as usual, proving the walker is active rather than short-circuited.
  const snakeized = snakeizeKeys({
    provider_options: { ready_timeout: 5000, keepAlive: true },
    someCamelKey: { innerCamel: 1 },
  }) as Record<string, Record<string, unknown>>;
  expect(snakeized.provider_options).toEqual({
    ready_timeout: 5000,
    keepAlive: true,
  });
  expect(snakeized.some_camel_key).toEqual({ inner_camel: 1 });
});

test("an opaque map is verbatim all the way down (nested objects, arrays), both directions", () => {
  // The walker skips an opaque value by not recursing into it AT ALL, so opacity
  // holds at every depth -- a nested object and an array of objects with
  // case-bearing keys must survive byte-for-byte through both directions. This
  // pins the "opaque all the way down" promise that a future "recurse one more
  // level" change could otherwise break with no test noticing. The probe carries
  // both a snake_case key (would change if camelized) and a camelCase key (would
  // change if snakeized) at depth, so a regression in either direction is caught.
  const opaque = {
    ready_timeout: 5000,
    algorithms: { server_host_key: ["ssh-ed25519"], readyDeep: true },
    forward_list: [{ src_port: 1 }, { dstHost: "h" }],
  };
  const camelized = camelizeKeys({ provider_options: opaque }) as {
    providerOptions: typeof opaque;
  };
  expect(camelized.providerOptions).toEqual(opaque);
  const snakeized = snakeizeKeys({ providerOptions: opaque }) as {
    provider_options: typeof opaque;
  };
  expect(snakeized.provider_options).toEqual(opaque);
});
