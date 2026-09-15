import { execFileSync } from "node:child_process";

/**
 * The current user's domain-qualified name (DOMAIN\user), the principal the
 * owner-only writers grant Modify and the only non-inherited entry a narrowed
 * file may have.
 *
 * @internal test-only helper
 */
export function currentWindowsUser(): string {
  return execFileSync("whoami", [], { encoding: "utf8" }).trim();
}

/**
 * One parsed line of `icacls <file>` output: the principal and the raw flag/
 * rights token after the `:(` separator (e.g. "(I)(M)" or "(R)"). The first
 * line of icacls output echoes the path before the first entry; the trailing
 * "Successfully processed" summary line has no `:(` and is skipped.
 *
 * @internal test-only helper
 */
export interface Ace {
  principal: string;
  rights: string;
}

/**
 * The access list `icacls` prints for `filePath`, one entry per grant.
 *
 * @internal test-only helper
 */
export function readAcl(filePath: string): Ace[] {
  const output = execFileSync("icacls", [filePath], { encoding: "utf8" });
  const echoed = filePath.replace(/\//g, "\\");
  const aces: Ace[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    let line = rawLine;
    if (line.startsWith(echoed)) line = line.slice(echoed.length).trimStart();
    const trimmed = line.trim();
    const sep = trimmed.indexOf(":(");
    if (sep === -1) continue;
    aces.push({
      principal: trimmed.slice(0, sep).trim(),
      rights: trimmed.slice(sep + 1),
    });
  }
  return aces;
}

// The principals the load-time check treats as owner-equivalent (EXEMPT_SIDS,
// S-1-5-18 and S-1-5-32-544 in src/fileUtils.ts), under the names icacls prints
// for them: SYSTEM and the local Administrators group hold standing access to
// every file on the host, and the writers' narrowing leaves them in place.
// icacls prints a display name rather than a SID and localizes the name of a
// built-in principal, so on a Windows installed in another language these two
// entries do not match and the assertions below go red.
const OWNER_EQUIVALENT_PRINCIPALS = [
  "nt authority\\system",
  "builtin\\administrators",
];

/**
 * True when the file's access list grants only `owner` and those two
 * principals, with no inherited entry and no other explicit principal -- the
 * owner-only state the writers must produce. Deny entries are restrictive and
 * ignored.
 *
 * @internal test-only helper
 */
export function isOwnerOnly(filePath: string, owner: string): boolean {
  const aces = readAcl(filePath);
  if (aces.length === 0) return false;
  return aces.every((ace) => {
    if (ace.rights.includes("(DENY)")) return true;
    const principal = ace.principal.toLowerCase();
    if (OWNER_EQUIVALENT_PRINCIPALS.includes(principal)) return true;
    if (ace.rights.includes("(I)")) return false;
    return principal === owner.toLowerCase();
  });
}

/**
 * The rights icacls prints for each of `owner`'s own entries.
 *
 * @internal test-only helper
 */
export function ownerRights(filePath: string, owner: string): string[] {
  return readAcl(filePath)
    .filter((ace) => ace.principal.toLowerCase() === owner.toLowerCase())
    .map((ace) => ace.rights);
}
