import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export interface TarEntry {
  readonly name: string;
  readonly data: Buffer;
}

function readCString(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.toString("utf8", 0, end === -1 ? length : end);
}

// The ustar header self-checksum: the unsigned sum of all 512 header bytes with
// the 8-byte checksum field (148..155) counted as ASCII spaces. Validating it
// lets the walk reject any 512-byte block that is not a header the standard
// writer actually produced -- so an under-declared or mis-parsed size cannot
// desync the walk onto bytes planted inside a member's data and have them read as
// a legitimate entry.
function ustarChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  return sum;
}

// The vendored tarball is ~39 MB uncompressed; a 256 MB ceiling is a wide margin
// that still refuses a gzip bomb before it can exhaust the CI runner.
const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;

/**
 * Minimal gzip + ustar reader returning the regular-file entries of a `.tgz`.
 * Enough to inspect the vendored @openmined/psi.js prebuild tarball's contents
 * without a tar dependency -- deliberately NOT a general extractor, and it treats
 * anything it cannot faithfully read as fatal rather than guessing. Every 512-byte
 * block must be a well-formed ustar header -- valid magic at offset 257 and a
 * valid self-checksum at 148 -- with a strictly-octal size, so a corrupt or
 * crafted archive cannot desync the walk and smuggle a 512-byte block planted
 * inside a member's data past as a phantom entry (which would let a re-vendored
 * tarball hide a mis-built prebuild behind a clean-looking decoy). It also throws
 * on GNU longname/longlink or pax records (which would override the next entry's
 * name) and on base-256 large sizes, and caps decompression against a gzip bomb.
 * The vendored tarball is plain ustar with short paths and valid checksums today,
 * so none of these fire -- but a future re-vendor that changes that breaks CI
 * loudly instead of letting the guard check a mis-named, truncated, or laundered
 * entry set.
 */
export function readTgz(tarballPath: string): TarEntry[] {
  const buf = gunzipSync(readFileSync(tarballPath), {
    maxOutputLength: MAX_DECOMPRESSED_BYTES,
  });
  const entries: TarEntry[] = [];
  for (let off = 0; off + 512 <= buf.length;) {
    const header = buf.subarray(off, off + 512);
    // The archive ends with (at least) one zero-filled block.
    if (header.every((byte) => byte === 0)) break;
    // Refuse any block that is not a genuine ustar header before trusting a single
    // field from it. Without this, an under-declared size could advance the walk
    // too little and land it on a 512-byte block planted inside a member's data,
    // reading it as a legitimate entry -- the silent mis-read that would let a
    // crafted re-vendor pass the manifest guard while shipping a dirty prebuild.
    if (header.toString("latin1", 257, 262) !== "ustar") {
      throw new Error(
        `readTgz: block at offset ${off} in ${tarballPath} is not a ustar header ` +
          "(missing magic) -- corrupt tarball or a walk desynced by a bad size field",
      );
    }
    if (
      parseInt(readCString(header, 148, 8).trim() || "-1", 8) !==
      ustarChecksum(header)
    ) {
      throw new Error(
        `readTgz: header checksum mismatch at offset ${off} in ${tarballPath} ` +
          "(corrupt tarball or a block planted mid-data by a walk desync)",
      );
    }
    const type = String.fromCharCode(header[156]);
    if (type === "L" || type === "K" || type === "x" || type === "g") {
      throw new Error(
        `readTgz: unsupported tar extension record (type '${type}') in ${tarballPath}; ` +
          "the tarball uses long paths or pax metadata this minimal reader cannot " +
          "resolve -- extend readTgz or re-pack as plain ustar",
      );
    }
    const name = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    // ustar sizes are octal ASCII terminated by NUL/space. Parse strictly, not with
    // lenient parseInt (which silently truncates "17778" -> 1777 octal): a size this
    // reader reads differently from a conformant extractor is how the walk's entry
    // boundaries would diverge from what actually installs. A base-256 large-size
    // field (high bit set) also fails this test and is refused.
    const rawSize = readCString(header, 124, 12).trim();
    if (rawSize !== "" && !/^[0-7]+$/.test(rawSize)) {
      throw new Error(
        `readTgz: non-octal size field for "${name}" in ${tarballPath} (base-256 or corrupt header)`,
      );
    }
    const size = rawSize === "" ? 0 : parseInt(rawSize, 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(
        `readTgz: unreadable entry size for "${name}" in ${tarballPath}`,
      );
    }
    const dataStart = off + 512;
    if (type === "0" || type === "\0") {
      entries.push({
        name: prefix ? `${prefix}/${name}` : name,
        data: buf.subarray(dataStart, dataStart + size),
      });
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/**
 * A conservative upper bound on the highest `GLIBC_x.y[.z]` symbol version an
 * ELF binary requires, or null when it references none -- the binary's effective
 * glibc floor (glibc refuses to load it on a host whose libc is older). This
 * scans the raw bytes for any `GLIBC_` version token rather than parsing
 * `.gnu.version_r`, so it needs no binutils and works on any host, but it is an
 * OVER-approximation: a defined or optional version elsewhere in the string
 * tables can only push the reported floor UP, never down. That direction is safe
 * for the guard -- it may spuriously fail a good build (investigate the stray
 * token) but can never pass a build whose real floor is too high. Matches
 * `objdump -T` exactly for the current vendored prebuilds.
 */
export function maxGlibcFloor(binary: Buffer): string | null {
  const text = binary.toString("latin1");
  let max: number[] | null = null;
  for (const m of text.matchAll(/GLIBC_(\d+)\.(\d+)(?:\.(\d+))?/g)) {
    const v = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
    if (max === null || compareVersion(v, max) > 0) max = v;
  }
  if (max === null) return null;
  return max[2] ? `${max[0]}.${max[1]}.${max[2]}` : `${max[0]}.${max[1]}`;
}

/** Compares dotted numeric versions ("2.28" vs "2.38"): -1, 0, or 1. */
export function compareVersion(
  a: number[] | string,
  b: number[] | string,
): number {
  const pa = Array.isArray(a) ? a : a.split(".").map(Number);
  const pb = Array.isArray(b) ? b : b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}
