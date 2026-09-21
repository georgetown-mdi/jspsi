import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

// An InProcessPsiEngine generates its own key through createWithNewKey, so a
// test cannot know it and cannot drive a single unchunked call under the same
// key to compare against. Wrapping a backend so that call hands back a
// fixed-key object is what lets one key drive both sides of a byte-identity
// comparison. Test-only: nothing on the shipped path builds an engine from a
// caller-chosen key.

/** A 32-byte key, deterministic per `fill` and inside the curve's order. */
export function psiTestKey(fill: number): Uint8Array {
  const key = new Uint8Array(32).fill(fill);
  key[0] = 0x00;
  return key;
}

/**
 * `library` with `createWithNewKey` answering from `serverKey` / `clientKey`,
 * so an engine built over it holds the key the caller already has.
 */
export function fixedKeyPsiLibrary(
  library: PSILibrary,
  serverKey: Uint8Array,
  clientKey: Uint8Array,
): PSILibrary {
  const server = library.server;
  const client = library.client;
  return {
    ...library,
    ...(server === undefined
      ? {}
      : {
          server: {
            ...server,
            createWithNewKey: (revealIntersection?: boolean) =>
              server.createFromKey(serverKey, revealIntersection),
          },
        }),
    ...(client === undefined
      ? {}
      : {
          client: {
            ...client,
            createWithNewKey: (revealIntersection?: boolean) =>
              client.createFromKey(clientKey, revealIntersection),
          },
        }),
  };
}
