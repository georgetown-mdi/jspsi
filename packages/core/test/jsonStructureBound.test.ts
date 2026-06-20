import { expect, test } from "vitest";

import { exceedsJsonStructureBound } from "../src/utils/jsonStructureBound";

// Each test isolates one bound by overriding it and leaving the others generous,
// so a failure points at the bound under test. Small explicit values keep the
// over/under cases tiny and legible; the scan is bound-agnostic, so behavior at
// keys/elements/depth of 4 generalizes to the production values.
function check(
  json: string,
  { keys = 1_000, elements = 1_000, depth = 1_000 } = {},
): boolean {
  return exceedsJsonStructureBound(
    new TextEncoder().encode(json),
    keys,
    elements,
    depth,
  );
}

// --- Per-object key bound -----------------------------------------------------

test("an object at the key budget is accepted", () => {
  expect(check('{"a":1,"b":2,"c":3,"d":4}', { keys: 4 })).toBe(false);
});

test("an object one over the key budget is rejected", () => {
  expect(check('{"a":1,"b":2,"c":3,"d":4,"e":5}', { keys: 4 })).toBe(true);
});

test("the key count is per-object: many small objects in an array stay under", () => {
  // The legitimate large-message shape (e.g. an IterationMap): one object per
  // element, each far below the key budget, however many there are.
  const pairs = Array.from(
    { length: 1000 },
    () => '{"theirIndex":1,"iteration":2}',
  );
  expect(check(`[${pairs.join(",")}]`, { keys: 4, elements: 2000 })).toBe(
    false,
  );
});

test("a wide object nested inside an array is still caught", () => {
  expect(check('[{"a":1,"b":2,"c":3,"d":4,"e":5}]', { keys: 4 })).toBe(true);
});

test("a wide object nested inside another object is caught at its own level", () => {
  // The outer object has 1 key; the inner has 5. The bound charges each object
  // its own members, so the inner trips it.
  expect(check('{"outer":{"a":1,"b":2,"c":3,"d":4,"e":5}}', { keys: 4 })).toBe(
    true,
  );
});

test("repeated keys over-count toward the budget (rejects sooner, never later)", () => {
  // The parse keeps one member per name, but the scan counts colons; the
  // over-count only ever rejects earlier, which is safe.
  expect(check('{"a":1,"a":2,"a":3,"a":4,"a":5}', { keys: 4 })).toBe(true);
});

// --- Per-array element bound --------------------------------------------------

test("an array at the element budget is accepted", () => {
  // 5 elements is 4 element-separating commas; the scan counts commas, so this
  // sits exactly at a budget of 4.
  expect(check("[0,0,0,0,0]", { elements: 4 })).toBe(false);
});

test("an array one past the element budget is rejected", () => {
  expect(check("[0,0,0,0,0,0]", { elements: 4 })).toBe(true);
});

test("the element count is per-array: sibling arrays are charged separately", () => {
  // Each inner array has 3 elements; the outer has 4. No single array exceeds a
  // budget of 4, even though the total element count across them does.
  expect(check("[[1,2,3],[1,2,3],[1,2,3],[1,2,3]]", { elements: 4 })).toBe(
    false,
  );
});

test("a wide array nested inside an object is still caught", () => {
  expect(check('{"a":[0,0,0,0,0,0]}', { elements: 4 })).toBe(true);
});

test("array elements and object keys do not collide on one frame", () => {
  // A wide object does not trip the (tiny) element budget, and a wide array does
  // not trip the (tiny) key budget -- a colon is charged only to objects, a
  // comma only to arrays.
  expect(check('{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6}', { elements: 1 })).toBe(
    false,
  );
  expect(check("[0,0,0,0,0,0]", { keys: 1 })).toBe(false);
});

test("object member separators are not counted as array elements", () => {
  // The commas here separate object members, not array elements, so the tiny
  // element budget is untouched.
  expect(check('{"a":1,"b":2,"c":3,"d":4,"e":5}', { elements: 1 })).toBe(false);
});

// --- String handling (applies to both bounds) ---------------------------------

test("colons inside string values are not counted as keys", () => {
  // One object, one member, whose value is a string packed with colons.
  expect(check('{"url":"a:b:c:d:e:f:g:h:i:j"}', { keys: 4 })).toBe(false);
});

test("commas inside string values are not counted as elements", () => {
  // One array, one element, whose value is a string packed with commas.
  expect(check('["a,b,c,d,e,f,g,h,i,j"]', { elements: 4 })).toBe(false);
});

test("braces and brackets inside string values do not open frames", () => {
  expect(check('{"s":"{[{[{[{[{["}', { keys: 4, depth: 4 })).toBe(false);
});

test("an escaped quote inside a string does not end the string early", () => {
  // The \" keeps the scan inside the string, so the colons after it are not
  // counted as keys of the object.
  expect(check('{"a":"he said \\"x:y:z:w:v\\""}', { keys: 4 })).toBe(false);
});

// --- Nesting depth bound ------------------------------------------------------

test("nesting at the depth budget is accepted", () => {
  expect(check("[[[[1]]]]", { depth: 4 })).toBe(false);
});

test("nesting one past the depth budget is rejected", () => {
  expect(check("[[[[[1]]]]]", { depth: 4 })).toBe(true);
});

test("a degenerate all-open-bracket body is rejected by the depth cap", () => {
  // The real DoS the depth cap guards against: an unbounded run of `[` would
  // grow the scan's own stack without it.
  expect(check("[".repeat(100000), { depth: 4 })).toBe(true);
});

// --- Malformed and edge inputs ------------------------------------------------

test("a malformed body does not throw and returns a boolean", () => {
  expect(check('{"a":1,')).toBe(false);
  expect(check("}{][:,")).toBe(false);
  expect(check("")).toBe(false);
});

test("a top-level non-object value is accepted", () => {
  expect(check("12345")).toBe(false);
  expect(check('"a string with : colons"')).toBe(false);
});
