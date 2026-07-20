// SFTP session setup for the `sftp` channel: the stateful concern that builds
// the ssh2-sftp-client connect options, installs the host-key verifier the
// connect path enforces, and runs the ssh-keyscan-analogue host-key probe. It
// holds live SFTP-session state -- the host key the server presented once its
// pin check passed (observedHostKey), read post-handshake to advertise this
// party's observed fingerprint for cross-party reconciliation -- so, like the
// abortMarker extraction and unlike the pure sftpConnect helpers, it is a class
// FileSyncConnection composes rather than a bag of free functions.
//
// The host-key verification RATIONALE -- why the fingerprint is pinned, the
// fail-closed default, the first-use trust flow, the provider-options
// interaction, and the constant-time-compare hygiene -- is owned by
// docs/SECURITY_DESIGN.md (Transport-layer authentication) and, at the
// implementation tier, docs/spec/CHANNEL_SECURITY.md (SFTP host-key
// verification). This module implements that control and does not restate it.
// The pure host-key primitives it builds on -- the connect-option allowlists,
// the defensive verdict delivery, the blob view -- live in ./sftpConnect, and
// the fingerprint digest / set-membership match / key-type decode live in
// utils/sshHostKey.ts, modules this one neither owns nor extends.
//
// This module is deliberately NOT re-exported by the package barrel (main.ts
// barrels fileSyncConnection.ts via `export *`, not this file), so it stays out
// of the package's public runtime surface while fileSyncConnection.ts composes
// it -- the same pattern as abortMarker.ts and sftpConnect.ts. The connection
// keeps thin delegating members (probeHostKeyFingerprint and the observedHostKey
// getter) so its public and test surface is unchanged.

import type { getLoggerForVerbosity } from "../utils/logger";
import { sanitizeForDisplay } from "../utils/sanitizeForDisplay";
import {
  computeHostKeyFingerprint,
  matchHostKeyFingerprint,
  keyTypeFromBlob,
} from "../utils/sshHostKey";
import {
  DEFAULT_SERVER_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
} from "../config/connection";
import type { SFTPConnectionConfig } from "../config/connection";
import {
  hostKeyBlob,
  settleVerify,
  SFTP_PROVIDER_OPTIONS_ALLOWLIST,
  SFTP_ALGORITHMS_ALLOWED_SUBKEYS,
} from "./sftpConnect";
import type { PresentedHostKey } from "./sftpConnect";
import type { FileTransportClient } from "./fileSyncConnection";

const errMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// The connection primitives the subsystem borrows from FileSyncConnection,
// injected rather than re-derived: `log` and `role` are read live (both are
// reassigned after construction -- `log` when open() rebinds it to a peerId-named
// logger, `role` at rendezvous), and `rawClient` is the raw, unwrapped transport
// the host-key probe dials (set once in the connection constructor, never
// reassigned).
interface SftpSessionDeps {
  log: () => ReturnType<typeof getLoggerForVerbosity>;
  role: () => string;
  rawClient: FileTransportClient;
}

/**
 * SFTP session setup as a self-contained, stateful subsystem
 * {@link FileSyncConnection} composes. Owns the observed-host-key state the
 * connection used to hold inline and exposes the connect-option building,
 * host-key-verifier install, and host-key probe the connection delegates to.
 * External behavior is byte-identical to the inline form; see
 * docs/SECURITY_DESIGN.md (Transport-layer authentication) and
 * docs/spec/CHANNEL_SECURITY.md (SFTP host-key verification).
 *
 * @internal
 */
export class SftpSession {
  // The host key the SFTP server presented on this connection, recorded by the
  // enforcing host-key verifier when its pin check passed (the only success
  // path that reaches a real, authenticated session). Read post-handshake by the
  // orchestrator to advertise this party's observed fingerprint in the
  // authenticated terms exchange for cross-party reconciliation. It
  // stays `undefined` on every path that observes no host key -- a file-drop
  // mount, the browser/proxy SFTP path (neither runs ssh2's hostVerifier), and a
  // refused connection (no-pin fail-closed or a mismatch) that never establishes
  // a session -- so a party with nothing to advertise reconciles to no
  // divergence. Identity/connection-scoped like handshakeRole; not reset per
  // session.
  observedHostKey: PresentedHostKey | undefined;

  constructor(private readonly deps: SftpSessionDeps) {}

  /**
   * Build the ssh2-sftp-client connect options for an sftp config, EXCEPT the
   * `hostVerifier` (the caller installs the verifier appropriate to its path:
   * enforce, fail-closed, or capture). The operator's opaque providerOptions are
   * applied FIRST through the default-deny allowlist, then psilink's own
   * security-critical fields -- host, credentials, the managed readyTimeout --
   * are assigned AFTER and always win, so a providerOptions entry can never
   * override them even if the allowlist were loosened. Shared by the `sftp`
   * connect path and {@link probeHostKeyFingerprint} so the probe negotiates with
   * the exact same options (and therefore the same host-key type) the real
   * connect uses; only credentials differ, gated by `includeCredentials`.
   *
   * `includeCredentials` is false for the host-key probe, which refuses before
   * authenticating and so needs no credential. Omitting them is not merely tidy:
   * the probe runs before `@path` credential refs are resolved, so an included
   * `privateKey`/`password` could still be an unresolved "@/path" string, and
   * ssh2 parses `privateKey` eagerly at connect time -- it would abort the probe
   * with "Unsupported key format" before ever reading the host key. Credentials
   * never affect host-key negotiation, so the probe still sees the same key.
   */
  buildConnectOptions(
    config: SFTPConnectionConfig,
    { includeCredentials }: { includeCredentials: boolean },
  ): Record<string, unknown> {
    const connectOptions: Record<string, unknown> = {};
    this.applyProviderOptions(connectOptions, config.providerOptions);

    connectOptions["host"] = config.server.host;
    connectOptions["maxReconnectAttempts"] =
      config.options?.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    if (config.server.port !== undefined)
      connectOptions["port"] = config.server.port;
    if (config.server.username !== undefined)
      connectOptions["username"] = config.server.username;
    if (includeCredentials) {
      if (config.server.password !== undefined)
        connectOptions["password"] = config.server.password;
      if (config.server.privateKey !== undefined)
        connectOptions["privateKey"] = config.server.privateKey;
      if (config.server.privateKeyPassphrase !== undefined)
        connectOptions["passphrase"] = config.server.privateKeyPassphrase;
      // Offer the keyboard-interactive auth method alongside `password` for a
      // server that disables the direct `password` method but accepts the same
      // password over keyboard-interactive (ssh2 tries password first, then
      // keyboard-interactive, exactly as a GUI SFTP client does). The transport
      // adapter reads this flag to install a handler that answers the server's
      // prompts with `password`; gated on a password being present so the handler
      // always has a value to answer with (the schema also refines this). Nothing
      // is installed unless the operator opted in, so default behavior is
      // unchanged. See SSH2SFTPClientAdapter.connect and docs/EXCHANGE_REFERENCE.md.
      if (
        config.server.keyboardInteractive === true &&
        config.server.password !== undefined
      )
        connectOptions["tryKeyboard"] = true;
    }
    // serverConnectTimeoutMs for SFTP is enforced by ssh2 via readyTimeout, not a
    // Promise.race wrapper -- the per-attempt deadline is equivalent. Always set:
    // the schema defaults the field to DEFAULT_SERVER_CONNECT_TIMEOUT_MS, and the
    // ?? fallback covers a config built without an options block at all, so an
    // unset value gets the documented 30000 ms deadline rather than dropping to
    // ssh2's shorter (~20s) internal default.
    connectOptions["readyTimeout"] =
      config.options?.serverConnectTimeoutMs ??
      DEFAULT_SERVER_CONNECT_TIMEOUT_MS;
    return connectOptions;
  }

  /**
   * Copy the operator's opaque `providerOptions` into `connectOptions`, filtered
   * through {@link SFTP_PROVIDER_OPTIONS_ALLOWLIST}. A non-allowlisted key is
   * dropped with a warning (so an operator who relied on it can see why it had no
   * effect); `algorithms` passes through with its sub-object filtered by
   * {@link filterAlgorithms}. Called before the security-critical fields are
   * assigned, so an allowlisted key that ever collided with one of psilink's own
   * host/credential fields would still lose to the structured value assigned
   * afterward -- defense in depth atop the allowlist, which already excludes
   * every such field (the host-key-verification keys included).
   *
   * Matching is by exact key string and need not be exhaustive about ssh2's
   * spellings, precisely because this is a default-deny allowlist: any key it
   * does not name is dropped regardless of how ssh2 would have read it. That
   * distinction matters -- ssh2 honors more than the canonical names (`hostname`
   * is an alias for `host` and takes precedence over it; `user` is an alias for
   * `username`) and treats keys case-sensitively, so a deny-list would have to
   * enumerate every synonym and casing to be safe, whereas default-deny covers
   * them all by construction. This is also why providerOptions can be left
   * un-normalized.
   */
  private applyProviderOptions(
    connectOptions: Record<string, unknown>,
    providerOptions: Record<string, unknown> | undefined,
  ): void {
    if (providerOptions === undefined) return;
    for (const [key, value] of Object.entries(providerOptions)) {
      if (!SFTP_PROVIDER_OPTIONS_ALLOWLIST.has(key)) {
        this.deps
          .log()
          .warn(
            `[${this.deps.role()}] ignoring connection.providerOptions.` +
              `${sanitizeForDisplay(key)}: not in the allowed set of SFTP ` +
              `transport-tuning options. The connection target, credentials, ` +
              `and host-key verification are set from connection.server and ` +
              `cannot be overridden here; any other key is dropped as a ` +
              `default-deny precaution.`,
          );
        continue;
      }
      if (key === "algorithms") {
        const filtered = this.filterAlgorithms(value);
        if (filtered !== undefined) connectOptions["algorithms"] = filtered;
        continue;
      }
      connectOptions[key] = value;
    }
  }

  /**
   * Filter an operator-supplied ssh2 `algorithms` value to the allowed
   * sub-categories (see {@link SFTP_ALGORITHMS_ALLOWED_SUBKEYS}), dropping
   * `serverHostKey` and any unrecognized sub-key with a warning. Returns the
   * filtered object, or `undefined` when the value is not a plain object or
   * nothing survives the filter -- so the `algorithms` key is omitted entirely
   * rather than forwarded as an empty object.
   */
  private filterAlgorithms(
    value: unknown,
  ): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.deps
        .log()
        .warn(
          `[${this.deps.role()}] ignoring connection.providerOptions.algorithms: ` +
            `expected an object of algorithm categories`,
        );
      return undefined;
    }
    const filtered: Record<string, unknown> = {};
    for (const [subKey, subValue] of Object.entries(value)) {
      if (SFTP_ALGORITHMS_ALLOWED_SUBKEYS.has(subKey)) {
        filtered[subKey] = subValue;
      } else {
        this.deps
          .log()
          .warn(
            `[${this.deps.role()}] ignoring connection.providerOptions.algorithms.` +
              `${sanitizeForDisplay(subKey)}: only ` +
              `${[...SFTP_ALGORITHMS_ALLOWED_SUBKEYS].join("/")} may be tuned ` +
              `here (host-key-type negotiation is not operator-overridable)`,
          );
      }
    }
    return Object.keys(filtered).length > 0 ? filtered : undefined;
  }

  /**
   * Install the connect path's host-key verifier onto `connectOptions` and return
   * a handle exposing the human-readable failure it captures. Installed AFTER
   * providerOptions (which the allowlist already strips of hostVerifier/hostHash)
   * so a providerOptions entry can never win even if the allowlist were loosened.
   * Applies to the CLI sftp channel only -- the browser/proxy SFTP path and
   * filedrop do not run ssh2's hostVerifier.
   *
   * The returned `mismatchDetails()` captures the failure from inside the async
   * hostVerifier callback so the caller's connect catch can re-throw with the
   * detail rather than ssh2's opaque "Host denied (verification failed)". It is
   * set before verify(false), so it is populated by the time the rejection
   * propagates from the caller's connect().
   */
  installEnforcingVerifier(
    connectOptions: Record<string, unknown>,
    config: SFTPConnectionConfig,
  ): { mismatchDetails(): string | undefined } {
    let mismatchDetails: string | undefined;
    // One or many pinned fingerprints, normalized to a list. A list stages a
    // rotated host key alongside the current one during a rekey window: a key
    // matching ANY pin is accepted. An empty list (rejected at config parse,
    // but defended here for a direct library caller) falls through to the
    // no-pin fail-closed path below rather than accepting any key.
    const pins =
      config.server.hostKeyFingerprint === undefined
        ? []
        : Array.isArray(config.server.hostKeyFingerprint)
          ? config.server.hostKeyFingerprint
          : [config.server.hostKeyFingerprint];
    if (pins.length > 0) {
      connectOptions["hostVerifier"] = (
        keyBlob: Buffer,
        verify: (permitted: boolean) => void,
      ): void => {
        void (async () => {
          try {
            const blob = hostKeyBlob(keyBlob);
            const matched = await matchHostKeyFingerprint(blob, pins);
            if (matched !== undefined) {
              // Record the observed key for the post-handshake cross-party
              // reconciliation (see observedHostKey). `matched` is the pin the
              // server's key satisfied (already canonical, format-validated),
              // so the presented fingerprint equals it -- reuse it rather than
              // re-hash on every connect. With several pins this is the one the
              // server actually presented, which is what the partner compares.
              // keyTypeFromBlob is server-controlled and stored UNsanitized;
              // the reconciliation escapes it before display.
              this.observedHostKey = {
                fingerprint: matched,
                keyType: keyTypeFromBlob(blob),
              };
              settleVerify(verify, true);
            } else {
              // Re-hash on the mismatch branch (which tears the connection down
              // anyway) rather than widen matchHostKeyFingerprint's contract to
              // also surface the digest of a non-matching key.
              const presented = await computeHostKeyFingerprint(blob);
              // keyTypeFromBlob decodes UTF-8 straight from the
              // server-controlled blob, so it is escaped and quoted before it
              // reaches the operator-facing message; the presented fingerprint
              // is base64 and the pins are format-validated, so neither needs
              // it.
              const keyType = sanitizeForDisplay(keyTypeFromBlob(blob));
              // Name the presented fingerprint and the pinned set so the
              // operator can see exactly what was offered against what was
              // trusted (the singular vs. plural wording adapts to the pin
              // count).
              const pinnedDescription =
                pins.length === 1
                  ? `the pinned fingerprint ${pins[0]}`
                  : `any of the ${pins.length} pinned fingerprints ` +
                    `(${pins.join(", ")})`;
              // A changed key is never auto-accepted (the ssh model): the
              // recovery is to verify out-of-band, then re-pin deliberately --
              // add the new value (keeping or dropping the old), or clear the
              // field and re-establish trust on first use interactively.
              mismatchDetails =
                `the server presented a host key of type '${keyType}' with ` +
                `fingerprint ${presented}, which does not match ` +
                `${pinnedDescription}. This may be a legitimate key rotation ` +
                `or an active attack -- only the server administrator can ` +
                `disambiguate. If the key was rotated, verify the new ` +
                `fingerprint out-of-band, then add it to ` +
                `connection.server.host_key_fingerprint (alongside or in ` +
                `place of the old) or remove that field and re-run ` +
                `interactively to re-establish trust on first use. A changed ` +
                `key is never auto-accepted.`;
              settleVerify(verify, false);
            }
          } catch (err) {
            mismatchDetails = `failed to verify host key: ` + errMessage(err);
            settleVerify(verify, false);
          }
        })();
      };
    } else {
      // No pin: fail closed (replaces the former warn-and-proceed). The CLI's
      // first-use flow normally pins the key before open(), so this path is the
      // backstop for a direct/library caller and the default posture for an
      // unpinned config. The presented fingerprint is surfaced so a caller can
      // verify it out-of-band and pin it.
      connectOptions["hostVerifier"] = (
        keyBlob: Buffer,
        verify: (permitted: boolean) => void,
      ): void => {
        void (async () => {
          try {
            const blob = hostKeyBlob(keyBlob);
            const presented = await computeHostKeyFingerprint(blob);
            const keyType = sanitizeForDisplay(keyTypeFromBlob(blob));
            mismatchDetails =
              `no host_key_fingerprint is pinned for ` +
              `${sanitizeForDisplay(config.server.host)}, so the server's ` +
              `identity cannot be verified and the connection is refused. The ` +
              `server presented a host key of type '${keyType}' with ` +
              `fingerprint ${presented}; verify it out-of-band and set ` +
              `connection.server.host_key_fingerprint to pin it.`;
            settleVerify(verify, false);
          } catch (err) {
            mismatchDetails =
              `no host_key_fingerprint is pinned and the presented host key ` +
              `could not be read (${errMessage(err)}); refusing to proceed.`;
            settleVerify(verify, false);
          }
        })();
      };
    }
    return { mismatchDetails: () => mismatchDetails };
  }

  /**
   * Connect only far enough to observe the server's presented host key, then
   * REFUSE the connection -- the ssh-keyscan analogue used to establish a
   * first-use pin. The installed hostVerifier records the presented
   * fingerprint/key-type and immediately calls `verify(false)`, so the handshake
   * aborts at host-key verification, BEFORE any credential is presented to the
   * (still-unverified) server, and without ever waiting on a user prompt inside
   * the handshake (which would race ssh2's `readyTimeout`). The caller then
   * decides whether to trust and pin the returned fingerprint out of band; the
   * subsequent real {@link FileSyncConnection.open} re-verifies it, so a key
   * swapped between this probe and that connect is still caught.
   *
   * Uses the raw (unbounded) transport: the verifier rejects as soon as the key
   * is presented, so there is no withheld-callback window for the peer-inactivity
   * budget to guard, and the connect is already bounded by ssh2's readyTimeout.
   *
   * @throws if the connect resolves without the verifier firing (no key was
   *   observed), or rejects for a reason other than the deliberate refusal.
   */
  async probeHostKeyFingerprint(
    config: SFTPConnectionConfig,
  ): Promise<PresentedHostKey> {
    const connectOptions = this.buildConnectOptions(config, {
      includeCredentials: false,
    });
    let captured: PresentedHostKey | undefined;
    let captureError: unknown;
    let connectError: unknown;
    connectOptions["hostVerifier"] = (
      keyBlob: Buffer,
      verify: (permitted: boolean) => void,
    ): void => {
      void (async () => {
        try {
          const blob = hostKeyBlob(keyBlob);
          captured = {
            fingerprint: await computeHostKeyFingerprint(blob),
            keyType: keyTypeFromBlob(blob),
          };
        } catch (err) {
          captureError = err;
        }
        // Always refuse: this connection exists only to read the host key, never
        // to authenticate. The refusal surfaces as the expected connect rejection
        // below, from which `captured` is returned. settleVerify guards a late
        // refusal: if the handshake was already torn down (e.g. readyTimeout)
        // while computeHostKeyFingerprint was awaiting, verify(false) would throw
        // against the dead protocol and reject this void-ed IIFE.
        settleVerify(verify, false);
      })();
    };

    try {
      await this.deps.rawClient.connect(connectOptions);
    } catch (err) {
      // A rejection is expected when the verifier fired: verify(false) aborts the
      // handshake, from which the captured key is returned below. Record the
      // cause ONLY when no key was read -- a genuine connect failure (e.g. an
      // unreachable host) -- so it is surfaced rather than masked behind the
      // generic "presented no key" message.
      if (captured === undefined) connectError = err;
    } finally {
      // verify(false) already tears the handshake down, but end() is the explicit
      // teardown; run it on every path (the success return included) so the probe
      // never leaves a client open.
      await this.deps.rawClient.end().catch(() => {});
    }

    if (captured !== undefined) return captured;
    if (captureError !== undefined)
      throw new Error(
        `failed to read the server's host key: ${errMessage(captureError)}`,
      );
    // The connect rejected before the verifier ever fired -- the host key was
    // never presented. Preserve the original cause so the operator can tell an
    // unreachable host from any other SSH failure.
    if (connectError !== undefined)
      throw new Error(
        `could not read the server's host key: ${errMessage(connectError)}`,
        { cause: connectError },
      );
    // The connect resolved without the verifier firing: a completed connection
    // that presented no host key (not expected for SSH).
    throw new Error(
      `could not determine the server's host key: the connection did not ` +
        `present one before completing`,
    );
  }
}
