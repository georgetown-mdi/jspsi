import { expect, test } from "vitest";

import { bytesEqual } from "../src/utils/crypto";

test("bytesEqual returns true for equal arrays", () => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([1, 2, 3]);
  expect(bytesEqual(a, b)).toBe(true);
});

test("bytesEqual returns true for empty arrays", () => {
  expect(bytesEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true);
});

test("bytesEqual returns false for different content, same length", () => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([1, 2, 4]);
  expect(bytesEqual(a, b)).toBe(false);
});

test("bytesEqual returns false when lengths differ", () => {
  expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(
    false,
  );
});

// The seed is load-bearing: without it, [1,2,0] vs [1,2] would XOR
// (undefined??0) ^ 0 = 0 for the extra iteration, leaving diff=0 and
// incorrectly returning true.
test("bytesEqual returns false when shorter array is a zero-padded prefix", () => {
  expect(bytesEqual(new Uint8Array([1, 2, 0]), new Uint8Array([1, 2]))).toBe(
    false,
  );
  expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0]))).toBe(
    false,
  );
});

test("bytesEqual returns false for empty vs non-empty", () => {
  expect(bytesEqual(new Uint8Array([]), new Uint8Array([0]))).toBe(false);
  expect(bytesEqual(new Uint8Array([0]), new Uint8Array([]))).toBe(false);
});
