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
 * without a tar dependency -- deliberately NOT a general extractor. Rather than
 * silently mis-read the formats it does not handle, it throws: a GNU
 * longname/longlink or pax record would override the following entry's name, so
 * a >100-byte path could otherwise truncate and a prebuild go unseen; and a
 * base-256 large-size field would desync the walk. The vendored tarball is plain
 * ustar with short paths today, so neither fires -- but a future re-vendor that
 * changes that breaks CI loudly instead of letting the guard check a mis-named
 * or truncated entry set.
 */
export function readTgz(tarballPath: string): TarEntry[] {
  const buf = gunzipSync(readFileSync(tarballPath));
  const entries: TarEntry[] = [];
  for (let off = 0; off + 512 <= buf.length; ) {
    const header = buf.subarray(off, off + 512);
    // The archive ends with (at least) one zero-filled block.
    if (header.every((byte) => byte === 0)) break;
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
    const size = parseInt(readCString(header, 124, 12).trim() || "0", 8);
    // A GNU base-256 large-size field (>= 8 GiB) parses to NaN here; refuse it
    // rather than let `Math.ceil(NaN / 512)` desync the walk and silently drop
    // every later entry. No PSI prebuild is remotely this large.
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(
        `readTgz: unreadable entry size for "${name}" in ${tarballPath} (base-256 or corrupt header)`,
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
