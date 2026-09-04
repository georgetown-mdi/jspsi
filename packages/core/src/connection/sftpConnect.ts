// SFTP connect-option building and host-key verification: the pure helpers
// and constants the `sftp` channel's connect path shares across its three
// host-key verifier forms (enforce, fail-closed, capture). Everything here
// is a pure function of its arguments or a module constant, kept in one
// place rather than re-derived per verifier. The methods that close over
// session state (buildConnectOptions, applyProviderOptions,
// filterAlgorithms, probeHostKeyFingerprint, and the three verifiers) live
// on the SftpSession subsystem in ./sftpSession, which imports these back.
//
// The host-key verification rationale -- why the fingerprint is pinned, the
// fail-closed default, the first-use trust flow -- is owned by
// docs/SECURITY_DESIGN.md and, at the implementation tier,
// docs/spec/CHANNEL_SECURITY.md; this module implements pieces of that
// control and does not restate it. The shared host-key primitives it builds
// on live in utils/sshHostKey.ts, a module this one neither owns nor
// extends.
//
// Not re-exported by the package barrel (main.ts barrels
// fileSyncConnection.ts, not this file), so an `@internal` export here
// stays out of the public runtime surface while fileSyncConnection.ts can
// still import it -- the same pattern as fileSyncNames.ts and
// fileSyncConstants.ts. PresentedHostKey keeps its public surface via
// re-export from fileSyncConnection.ts (which IS barrelled).

/**
 * The host key a server presented on the SFTP channel, as observed by
 * {@link SftpSession.probeHostKeyFingerprint}. Both fields are public
 * (a host key and its fingerprint are not secret): the CLI shows them to the
 * operator on a first-use trust prompt and persists `fingerprint` as the pin.
 */
export interface PresentedHostKey {
  /**
   * OpenSSH SHA256 fingerprint of the presented key, e.g. `SHA256:abc...xyz`,
   * byte-identical to what `ssh-keygen -lf` prints and what
   * `connection.server.host_key_fingerprint` pins.
   */
  fingerprint: string;
  /**
   * SSH key-type string, e.g. `ssh-ed25519`: whatever {@link keyTypeFromBlob}
   * returned for the presented blob -- the type verbatim within its charset
   * and length bound, `(unknown:<hex>)` for a type outside it, or
   * `(unknown)` for a blob naming no type.
   *
   * Stored unsanitized: it must reach an operator only through a display
   * sink that escapes it -- {@link sanitizeForDisplay} at a log or console
   * call site, or `sanitizeErrorForDisplay` when composed into an error. The
   * bound above applies only to a locally observed key; the partner's
   * advertised value arrives on this field through the terms exchange under
   * a length bound alone (`protocolSetup.ts`), so it can still hold
   * control/BIDI bytes. The sibling `fingerprint` is base64 and needs no
   * escaping.
   */
  keyType: string;
}

/**
 * View an ssh2 hostVerifier `keyBlob` (a Node Buffer) as a Uint8Array over
 * the same bytes, the input type the sshHostKey primitives take. A Buffer is
 * a Uint8Array view onto a (possibly shared, pooled) ArrayBuffer, so the
 * byteOffset and byteLength must pass through -- a bare
 * `new Uint8Array(buf.buffer)` would read the whole backing pool, not just
 * this key. Shared by all three host-key verifiers.
 *
 * @internal
 */
export const hostKeyBlob = (keyBlob: Buffer): Uint8Array<ArrayBuffer> =>
  new Uint8Array(
    keyBlob.buffer as ArrayBuffer,
    keyBlob.byteOffset,
    keyBlob.byteLength,
  );

/**
 * Deliver an ssh2 hostVerifier verdict defensively. Our verifiers return
 * `undefined` (the void async IIFE), so ssh2 parks the handshake and waits
 * for this callback. If the handshake tears down for an unrelated reason
 * while the async check is pending (ssh2's readyTimeout, or a socket error,
 * during the host-key hash/compare), ssh2 has already destructed its
 * protocol by the time verify() runs, and a late call throws against the
 * dead protocol. The connection is already aborted, so the verdict is moot;
 * swallow the throw, since an escaped one would reject the void-ed IIFE,
 * showing up as an unhandled promise rejection rather than a wrong verdict.
 * Shared by all three verifiers.
 *
 * @internal
 */
export const settleVerify = (
  verify: (permitted: boolean) => void,
  permitted: boolean,
): void => {
  try {
    verify(permitted);
  } catch {
    // swallow: see settleVerify header
  }
};

/**
 * `ssh2-sftp-client` connect options an operator may set through the opaque
 * `connection.providerOptions` map for the SFTP channel. Default-deny: only
 * these non-security transport-tuning options pass through; every other key
 * -- including ssh2's connection-target, credential, and
 * host-key-verification options, and any option a future ssh2 version adds
 * -- is dropped with a warning, so `providerOptions` can never override the
 * security-critical connect options psilink derives from
 * `connection.server`. This closes a latent injection sink: untrusted input
 * routed into `providerOptions` still could not redirect the host, swap
 * credentials, or disable host-key verification.
 *
 * An allowlist, not a forbid-list: ssh2's security-sensitive option surface
 * is large and grows across versions, and several entries are non-obvious
 * auth vectors -- `sock` redirects the connection without touching `host`;
 * `authHandler` re-supplies every credential as one callback;
 * `agent`/`agentForward` and `localHostname`/`localUsername` are auth
 * vectors; `algorithms.serverHostKey` is sensitive but nested inside an
 * otherwise-benign object. A forbid-list fails open on anything it misses; a
 * small, stable allowlist fails closed instead -- a forgotten benign key is
 * a visible functional gap, never a silent security regression.
 *
 * `readyTimeout` is excluded: psilink derives it from
 * `serverConnectTimeoutMs`, and the structured value must win. `algorithms`
 * is permitted but filtered to its non-host-key sub-categories (see
 * {@link SftpSession.filterAlgorithms}). See docs/EXCHANGE_REFERENCE.md
 * (`connection.provider_options`).
 *
 * @internal
 */
export const SFTP_PROVIDER_OPTIONS_ALLOWLIST: ReadonlySet<string> = new Set([
  "keepaliveInterval",
  "keepaliveCountMax",
  "strictVendor",
  "algorithms",
]);

/**
 * Sub-categories of ssh2's `algorithms` option an operator may tune through
 * `providerOptions`. `serverHostKey` is excluded: it constrains which
 * host-key types are accepted -- a host-key-trust decision -- so allowing it
 * would let the opaque map weaken host-key negotiation, exactly what
 * {@link SFTP_PROVIDER_OPTIONS_ALLOWLIST} exists to prevent. The categories
 * here (cipher / HMAC / key-exchange / compression) are transport tuning
 * with no host-identity bearing.
 *
 * @internal
 */
export const SFTP_ALGORITHMS_ALLOWED_SUBKEYS: ReadonlySet<string> = new Set([
  "cipher",
  "hmac",
  "kex",
  "compress",
]);
