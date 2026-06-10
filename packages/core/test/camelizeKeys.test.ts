import { expect, test } from "vitest";

import {
  camelizeKeys,
  OPAQUE_VALUE_KEYS,
  snakeizeKeys,
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

test("an opaque subtree is left verbatim in both directions, snake keys included", () => {
  // Guards the latent hazard the co-location removes: even a snake_case key
  // inside an opaque map (not the typed camelCase ExchangeSpec saveConfig feeds)
  // must be left verbatim by snakeizeKeys, because opacity is decided on the
  // canonicalized key, not the raw one.
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
  // Re-snakeizing the camelized form preserves the opaque map's keys verbatim.
  const snakeized = snakeizeKeys(camelized) as {
    connection: { provider_options: Record<string, unknown> };
  };
  expect(snakeized.connection.provider_options).toEqual({
    ready_timeout: 5000,
    keepAlive: true,
  });
});
