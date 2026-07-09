// Fixtures shared by the browser PSI suites that run a real exchange over the
// live rendezvous (invitedPSI, exchangeLifecycle): the reachability probe and the
// matching server/client datasets with their firstName-only linkage terms.

/** Probe the PeerJS coordination server at `hostString` with a short timeout, so
 * an unreachable server lets the caller skip its suite rather than failing. Call
 * this inside a hook, never at module scope: the networked exchange used to run
 * during import, where a "Failed to fetch" took down the entire browser project
 * (0 tests collected), hiding the server-less vector suites that share it. */
export async function canReachServer(hostString: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    await fetch(`${hostString}/`, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const serverRows = [
  { first_name: "Alice" },
  { first_name: "Bob" },
  { first_name: "Carol" },
  { first_name: "David" },
  { first_name: "Elizabeth" },
  { first_name: "Frank" },
  { first_name: "Greta" },
];
export const clientRows = [
  { first_name: "Carol" },
  { first_name: "Elizabeth" },
  { first_name: "Henry" },
];

// The default linkage-key templates all require SSN/DOB/lastName combinations, so
// none survive filtering for a firstName-only dataset. Provide one explicit key so
// both parties produce valid, matching linkage terms.
export const firstNameOnlyTerms = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi" as const,
  linkageStrategy: "cascade" as const,
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "first_name" as const }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};
