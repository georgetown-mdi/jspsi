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

/**
 * Minimal gzip + ustar reader returning the regular-file entries of a `.tgz`.
 * Enough to inspect the vendored @openmined/psi.js prebuild tarball's contents
 * without a tar dependency -- deliberately NOT a general extractor: it skips GNU
 * longname/pax records, which the tarball's short `package/prebuilds/<platform>/`
 * paths (well under the 100-byte ustar name field) never need.
 */
export function readTgz(tarballPath: string): TarEntry[] {
  const buf = gunzipSync(readFileSync(tarballPath));
  const entries: TarEntry[] = [];
  for (let off = 0; off + 512 <= buf.length; ) {
    const header = buf.subarray(off, off + 512);
    // The archive ends with (at least) one zero-filled block.
    if (header.every((byte) => byte === 0)) break;
    const name = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    const size = parseInt(readCString(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156]);
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
 * The highest `GLIBC_x.y[.z]` symbol version an ELF binary references, or null
 * when it references none. glibc's ELF version check refuses to load a binary on
 * a host whose libc is older than this value, so it is the binary's effective
 * glibc floor. Read from the raw bytes (the versions live as ASCII in
 * `.gnu.version_r`), which needs no binutils and works on any host.
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
