// SFTP connect-option building and host-key verification: the pure helpers and
// constants the `sftp` channel's connect path shares across its three
// host-key verifier forms (enforce, fail-closed, capture). Everything here is a
// pure function of its arguments or a module constant -- no instance state, no
// I/O -- so the blob view, the defensive verdict delivery, and the two
// provider-option allowlists live in one place rather than being re-derived per
// verifier. The methods that CLOSE OVER session state (buildConnectOptions,
// applyProviderOptions, filterAlgorithms, probeHostKeyFingerprint, and the three
// verifiers) live in ./sftpSession on the SftpSession subsystem; they import
// these back.
//
// The host-key verification RATIONALE -- why the fingerprint is pinned, the
// fail-closed default, the first-use trust flow, the provider-options
// interaction, and the constant-time-compare hygiene -- is owned by
// docs/SECURITY_DESIGN.md (Transport-layer authentication) and, at the
// implementation tier, docs/spec/CHANNEL_SECURITY.md (SFTP host-key
// verification). This module implements pieces of that control and does not
// restate it. The shared host-key primitives it builds on (the fingerprint
// digest, the set-membership match, the key-type decode) live in
// utils/sshHostKey.ts, a separate module this one neither owns nor extends.
//
// This module is deliberately NOT re-exported by the package barrel (main.ts
// barrels fileSyncConnection.ts via `export *`, not this file), so an
// `@internal` export here stays out of the package's public runtime surface
// while fileSyncConnection.ts can still import it -- the same pattern as
// fileSyncNames.ts and fileSyncConstants.ts. PresentedHostKey keeps its public
// surface by being re-exported from fileSyncConnection.ts (which IS barrelled).

/**
 * The host key a server presented on the SFTP channel, as observed by
 * {@link SftpSession.probeHostKeyFingerprint}. Both fields are public
 * (a host key and its fingerprint are not secret): the CLI surfaces them to the
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
   * SSH key-type string decoded from the presented blob, e.g. `ssh-ed25519`.
   * `(unknown)` when the blob is malformed (see {@link keyTypeFromBlob}).
   *
   * Server-controlled and stored UNsanitized: route it through
   * {@link sanitizeForDisplay} before showing it to an operator (terminal, log),
   * as a hostile server can put control/BIDI bytes in the key type. The sibling
   * `fingerprint` is base64 and needs no escaping.
   */
  keyType: string;
}

/**
 * View an ssh2 hostVerifier `keyBlob` (a Node Buffer) as a Uint8Array over the
 * same bytes, the input type the sshHostKey primitives take. A Buffer is a
 * Uint8Array view onto a (possibly shared, pooled) ArrayBuffer, so the byteOffset
 * and byteLength must be carried through -- a bare `new Uint8Array(buf.buffer)`
 * would read the whole backing pool, not just this key. Shared by all three
 * host-key verifiers (enforce, fail-closed, capture).
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
 * `undefined` (the void async IIFE), so ssh2 parks the handshake and waits for
 * this callback. If the handshake is torn down for an UNRELATED reason while our
 * async check is still pending -- ssh2's readyTimeout firing, or a socket error,
 * during the host-key hash/compare -- ssh2 has already destructed its protocol by
 * the time we call verify(); a late verify() then throws against the dead
 * protocol. The connection is already aborted, so the verdict is moot; swallow
 * the throw, because an escaped one would reject the void-ed IIFE and surface as
 * an unhandled promise rejection (a flaky test or stray process-level rejection),
 * never a wrong verdict. Shared by all three verifiers (enforce, fail-closed,
 * capture).
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
 * these non-security transport-tuning options pass through; every other key --
 * including ssh2's connection-target, credential, and host-key-verification
 * options, and any option a future ssh2 version adds -- is dropped (with a
 * warning), so `providerOptions` can never override the security-critical
 * connect options psilink derives from the operator's own `connection.server`
 * config. This closes a latent injection sink: were untrusted input ever routed
 * into `providerOptions`, it still could not redirect the host, swap
 * credentials, or disable host-key verification.
 *
 * An allowlist, not a forbid-list, because ssh2's security-sensitive option
 * surface is large and treacherous: `sock` redirects the connection without
 * touching `host`; `authHandler` re-supplies every credential as one callback;
 * `agent`/`agentForward` and `localHostname`/`localUsername` are non-obvious
 * auth vectors; `algorithms.serverHostKey` is sensitive but nested inside an
 * otherwise-benign object; and the set grows across ssh2 versions. A forbid-list
 * fails OPEN whenever it misses one of those (a silent override). The benign
 * tuning set named here is small and stable, so the allowlist fails CLOSED -- a
 * forgotten benign key is a visible, logged functional gap, never a silent
 * security regression.
 *
 * `readyTimeout` is intentionally excluded: psilink derives it from
 * `serverConnectTimeoutMs`, and the structured value must win. `algorithms` is
 * permitted but handled specially (see {@link SftpSession.filterAlgorithms}),
 * filtered to its non-host-key sub-categories. See docs/EXCHANGE_REFERENCE.md
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
 * `providerOptions`. `serverHostKey` is deliberately excluded: it constrains
 * which host-key TYPES are accepted -- a host-key-trust decision -- so allowing
 * it would let the opaque map weaken host-key negotiation, exactly what
 * {@link SFTP_PROVIDER_OPTIONS_ALLOWLIST} exists to prevent. The categories here
 * (cipher / HMAC / key-exchange / compression) are transport tuning with no
 * host-identity bearing.
 *
 * @internal
 */
export const SFTP_ALGORITHMS_ALLOWED_SUBKEYS: ReadonlySet<string> = new Set([
  "cipher",
  "hmac",
  "kex",
  "compress",
]);
