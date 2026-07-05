import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, test } from "vitest";

import { readTgz } from "./prebuildTarball";

// readTgz is the manifest guard's parser, and the bytes it reads are the vendored
// tarball -- which a malicious/compromised re-vendor controls (the sha256 sidecar
// proves only that the bytes are the committed ones, not that they are honest). A
// block readTgz mis-reads as a phantom entry is the highest-value bug: it would let
// a dirty prebuild slip past the guard behind a clean-looking decoy. These pin the
// fail-loud contract -- readTgz must reject anything that is not well-formed ustar
// rather than desync its walk onto planted or mis-sized data.

// Builds one well-formed ustar header (valid magic + self-checksum) so each case
// below can corrupt exactly one property and prove readTgz rejects it.
function ustarHeader(name: string, size: number, type = "0"): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, "utf8"); // name (0..99)
  h.write("000644 \0", 100, "latin1"); // mode
  h.write("000000 \0", 108, "latin1"); // uid
  h.write("000000 \0", 116, "latin1"); // gid
  h.write(size.toString(8).padStart(11, "0"), 124, "latin1"); // size (124..135)
  h.write("00000000000", 136, "latin1"); // mtime
  h.write(type, 156, "latin1"); // typeflag
  h.write("ustar\0", 257, "latin1"); // magic (257..262)
  h.write("00", 263, "latin1"); // version
  return withChecksum(h);
}

// Fills the checksum field with spaces, sums the header, and writes the standard
// "6 octal digits, NUL, space" checksum. Re-run after mutating any other byte.
function withChecksum(h: Buffer): Buffer {
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return h;
}

function member(name: string, data: Buffer, type = "0"): Buffer {
  const pad = data.length % 512 === 0 ? 0 : 512 - (data.length % 512);
  return Buffer.concat([
    ustarHeader(name, data.length, type),
    data,
    Buffer.alloc(pad),
  ]);
}

const eof = Buffer.alloc(1024); // two trailing zero blocks

describe("readTgz fail-loud hardening", () => {
  let dir = "";
  const write = (buf: Buffer): string => {
    dir = mkdtempSync(join(tmpdir(), "tgz-"));
    const path = join(dir, "t.tgz");
    writeFileSync(path, gzipSync(buf));
    return path;
  };
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("reads a well-formed ustar archive (positive control)", () => {
    const tar = Buffer.concat([
      member("package/a.txt", Buffer.from("hello")),
      member("package/b.bin", Buffer.from([1, 2, 3, 4])),
      eof,
    ]);
    const entries = readTgz(write(tar));
    expect(entries.map((e) => e.name)).toEqual([
      "package/a.txt",
      "package/b.bin",
    ]);
    expect(entries[0].data.toString("utf8")).toBe("hello");
    expect([...entries[1].data]).toEqual([1, 2, 3, 4]);
  });

  test("throws on a header whose self-checksum does not match", () => {
    const h = ustarHeader("package/x", 0);
    h[148] ^= 1; // perturb the stored checksum without touching the summed bytes
    expect(() => readTgz(write(Buffer.concat([h, eof])))).toThrow(
      /checksum mismatch/,
    );
  });

  test("throws on a block missing the ustar magic (a non-header block)", () => {
    const h = ustarHeader("package/x", 0);
    h.fill(0, 257, 263); // wipe magic; models the walk landing on planted mid-data
    expect(() => readTgz(write(Buffer.concat([h, eof])))).toThrow(
      /not a ustar header/,
    );
  });

  test("throws on a non-octal size field instead of truncating it", () => {
    const h = ustarHeader("package/x", 0);
    h.fill(0, 124, 136);
    h.write("17778", 124, "latin1"); // lenient parseInt would read 1777 and desync
    withChecksum(h); // recompute so the size check, not the checksum, is exercised
    expect(() => readTgz(write(Buffer.concat([h, eof])))).toThrow(/non-octal/);
  });

  test("throws on a GNU/pax extension record it cannot resolve", () => {
    const h = ustarHeader("././@LongLink", 0, "L");
    expect(() => readTgz(write(Buffer.concat([h, eof])))).toThrow(
      /unsupported tar extension record/,
    );
  });
});
