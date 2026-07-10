import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { computeHostKeyFingerprint } from "@psilink/core";

import type { SftpServerHandle, SftpTestServer } from "./types";

const execFileAsync = promisify(execFile);

// The OpenSSH SHA256 host-key fingerprint from a `.pub` line ("ssh-ed25519
// <base64-blob> comment"): the base64 blob is the SSH wire-format public key,
// the exact bytes ssh2's hostVerifier hashes, so this equals the value the
// production verifier pins. The suite pins it because the no-pin default is
// fail-closed.
async function hostKeyFingerprintFromPub(pubPath: string): Promise<string> {
  const pub = await fsp.readFile(pubPath, "utf8");
  const blobB64 = pub.trim().split(/\s+/)[1];
  if (blobB64 === undefined)
    throw new Error(`malformed host public key at ${pubPath}`);
  return computeHostKeyFingerprint(
    new Uint8Array(Buffer.from(blobB64, "base64")),
  );
}

// Where the system OpenSSH server lives. internal-sftp is built into sshd, so no
// separate binary is needed. macOS and the Ubuntu CI runners ship sshd at
// /usr/sbin/sshd; elsewhere it comes from the openssh-server package.
const SSHD_CANDIDATES = ["/usr/sbin/sshd", "/usr/local/sbin/sshd"];

const READY_TIMEOUT_MS = 20_000;
const READY_PROBE_INTERVAL_MS = 100;
// The per-probe socket timeout, kept well above the poll interval: on a loaded
// CI runner the TCP handshake alone can consume the whole interval, so reusing
// READY_PROBE_INTERVAL_MS as the socket timeout would leave no headroom for the
// banner to arrive and report a false not-ready, burning a start attempt.
const READY_PROBE_TIMEOUT_MS = 2_000;
const START_ATTEMPTS = 3;

// The Port in a config handed only to `sshd -t` (extended test mode): it parses
// the config and checks the host keys but never binds a socket, so this value is
// never claimed and cannot collide with the ephemeral ports the server uses.
const VALIDATE_ONLY_PORT = 22222;

/**
 * The hardened native-sshd configurations the conformance suite can run against,
 * selected by PSILINK_SFTP_NATIVE_PROFILE. `baseline` is the Phase-1 config
 * (forced internal-sftp, no chroot) and is the default -- it must stay unchanged.
 * The rest layer on the hardening real deployments use:
 *   - `chroot`: ChrootDirectory confinement. Requires sshd to run as root (for
 *     chroot(2)) over a root-owned jail, so it is a privileged/CI-only leg that
 *     skips where it cannot run (see the runChrootProfile.mjs runner).
 *   - `restricted-crypto`: a modern, locked-down kex/cipher/MAC/host-key/pubkey
 *     policy, proving the pure-JS ssh2 client still negotiates under it.
 *   - `rate-limited`: connection and auth rate limits.
 *   - `allowlist`: an explicit user@host allow matrix.
 */
export type NativeProfile =
  "baseline" | "chroot" | "restricted-crypto" | "rate-limited" | "allowlist";

export const NATIVE_PROFILES: readonly NativeProfile[] = [
  "baseline",
  "chroot",
  "restricted-crypto",
  "rate-limited",
  "allowlist",
];

export interface NativeSshdOptions {
  /** Which hardened configuration to run; defaults to `baseline`. */
  profile?: NativeProfile;
}

// A modern, deliberately narrow crypto policy. Every entry intersects what the
// pure-JS ssh2 client offers by default on Node 26 (curve25519 kex, an ed25519
// host key, AEAD ciphers, ETM MACs, ed25519 user keys), so the positive
// handshake stays green while the server advertises only a locked-down set. The
// host and user keys this backend generates are ed25519, which is why the host
// key and pubkey algorithms can be pinned to ssh-ed25519 alone.
const RESTRICTED_CRYPTO_DIRECTIVES = [
  "KexAlgorithms curve25519-sha256,curve25519-sha256@libssh.org",
  "Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com",
  "MACs hmac-sha2-256-etm@openssh.com,hmac-sha2-512-etm@openssh.com",
  "HostKeyAlgorithms ssh-ed25519",
  "PubkeyAcceptedAlgorithms ssh-ed25519",
];

// Realistic connection/auth rate limits, kept loose enough that a slow CI run --
// the heavy-exchange tests run ~13x slower on this backend on CI -- cannot trip
// them and turn a perf issue into a flaky failure. LoginGraceTime bounds the
// per-connection auth window (auth completes in well under a second normally);
// MaxStartups governs concurrent UNAUTHENTICATED connections (the suite opens a
// couple at a time); MaxSessions caps sessions per connection (the adapter uses
// one). PerSourcePenalties is appended separately, gated on sshd support, since
// it is unknown on OpenSSH older than the CI/runner version.
const RATE_LIMITED_DIRECTIVES = [
  "MaxAuthTries 4",
  "LoginGraceTime 30",
  "MaxStartups 10:30:60",
  "MaxSessions 10",
];

// Channel confinement that ForceCommand does not imply: ForceCommand pins the
// executed command to internal-sftp, but the session can still open forwarding,
// tunnel, and X11 channels, so a real internal-sftp deployment pairs it with
// these. Applied to the chroot profile, whose session authenticates as root --
// completing the jail, since one that still allows TCP forwarding is a weak jail.
// The conformance suite never forwards, so pinning them off cannot affect a run.
const CHROOT_CONFINEMENT_DIRECTIVES = [
  "AllowTcpForwarding no",
  "AllowAgentForwarding no",
  "PermitTunnel no",
  "X11Forwarding no",
];

async function resolveSshd(): Promise<string> {
  for (const candidate of SSHD_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const { stdout } = await execFileAsync("sh", ["-c", "command -v sshd"]);
    const found = stdout.trim();
    if (found) return found;
  } catch {
    // fall through to the error below
  }
  throw new Error(
    "The native sshd test backend requires OpenSSH's sshd on PATH " +
      "(install openssh-server); none was found.",
  );
}

/**
 * Whether the chroot profile can run here. ChrootDirectory requires sshd to call
 * chroot(2) (root only) over a jail whose every path component is root-owned and
 * not group/world-writable, so the unprivileged child sshd this backend normally
 * runs cannot do it. The leg therefore needs the whole test process to run as
 * root on Linux; the reason string is surfaced to the operator when it cannot.
 * The backstop in startNativeSshdServer calls this; the chroot runner
 * (runChrootProfile.mjs) re-implements the same check in plain JS, since it must
 * decide to skip before this module -- and vitest -- is ever loaded.
 *
 * @internal exported for testing
 */
export function chrootCapability(): { ok: boolean; reason: string } {
  if (process.platform !== "linux") {
    return {
      ok: false,
      reason:
        `the chroot profile needs Linux for ChrootDirectory + chroot(2); ` +
        `this host is ${process.platform}`,
    };
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (uid !== 0) {
    return {
      ok: false,
      reason:
        `the chroot profile needs sshd to run as root (uid 0) to chroot(2) ` +
        `and own the jail; current uid is ${uid}`,
    };
  }
  return { ok: true, reason: "" };
}

// A free loopback port. There is an unavoidable gap between closing this probe
// socket and sshd binding the port, so start() retries on an early exit.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address !== "object" || !address) {
        // A null address would otherwise resolve to port 0, which sshd binds to
        // a kernel-assigned port it never reports back -- an opaque readiness
        // timeout. Fail loudly instead.
        probe.close(() =>
          reject(new Error("could not determine a free loopback port")),
        );
        return;
      }
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

// Readiness must be gated on a real SSH banner, not a bare TCP accept: sshd
// binds and accepts connections before its per-connection session machinery is
// ready, so a connect-only probe returns early and the first real handshake gets
// reset. Waiting for the "SSH-..." identification string the server sends on a
// fresh connection means sshd is actually answering handshakes.
function sshBannerReady(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let received = Buffer.alloc(0);
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
    // sshd may accept then drop the connection before sending a banner; that
    // emits 'close' with no prior 'error', so settle here rather than waiting out
    // the full probe timeout before the retry loop advances.
    socket.once("close", () => settle(false));
    socket.on("data", (chunk) => {
      // Accumulate: the banner is spec-legal to arrive split across reads, so
      // judging only the first chunk could falsely report not-ready and burn a
      // start attempt. Wait until four bytes are in hand, then check the prefix.
      received = Buffer.concat([
        received,
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      ]);
      if (received.length < 4) return;
      settle(received.toString("utf8", 0, 4) === "SSH-");
    });
    socket.connect(port, "127.0.0.1");
  });
}

async function keygen(keyPath: string): Promise<void> {
  // OpenSSH's own ed25519 keys parse back reliably (unlike ssh2's generator), and
  // -N "" leaves them passphrase-free for unattended auth.
  await execFileAsync("ssh-keygen", [
    "-t",
    "ed25519",
    "-f",
    keyPath,
    "-N",
    "",
    "-q",
  ]);
}

// Validate a complete sshd config with `sshd -t` (extended test mode: it parses
// the config and checks the host keys without binding). Returns the captured
// stderr so a profile whose directives the locally resolved sshd does not
// understand -- macOS ships a different OpenSSH than the Ubuntu runners -- fails
// loudly with the exact complaint instead of an opaque start timeout.
async function validateConfig(
  sshd: string,
  configPath: string,
): Promise<{ ok: boolean; stderr: string }> {
  try {
    const { stderr } = await execFileAsync(sshd, ["-t", "-f", configPath]);
    return { ok: true, stderr };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, stderr: (e.stderr ?? e.message ?? "").trim() };
  }
}

// Whether the locally resolved sshd accepts PerSourcePenalties -- the one
// rate-limit directive that cannot be validated as part of the served config,
// because an sshd too old to know it (before OpenSSH 9.8) would reject the whole
// rate-limited config at the validation step, turning a soft capability gap into
// a hard test failure. So it is probed in isolation with a minimal config. The
// probe mirrors the served config's `StrictModes no` so the host key under the
// world-readable temp workDir is judged on the directive's validity, not
// key-file permission strictness (which would false-negative and silently drop a
// supported directive); the probe file is removed in the finally.
async function sshdSupportsPerSourcePenalties(
  sshd: string,
  hostKeyPath: string,
  workDir: string,
): Promise<boolean> {
  const probePath = path.join(workDir, "sshd_probe_persourcepenalties");
  try {
    await fsp.writeFile(
      probePath,
      [
        `Port ${VALIDATE_ONLY_PORT}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${hostKeyPath}`,
        "StrictModes no",
        "PerSourcePenalties yes",
        "",
      ].join("\n"),
    );
    const { ok } = await validateConfig(sshd, probePath);
    return ok;
  } finally {
    await fsp.rm(probePath, { force: true });
  }
}

interface NativeAttempt {
  child: ChildProcess;
  stderr: { value: string };
}

/**
 * Spawn a native OpenSSH sshd as a child running internal-sftp, in one of the
 * hardened profiles (see NativeProfile). The `baseline` default is the Phase-1
 * config: an unprivileged child serving a real temp-dir path without a chroot.
 * It authenticates two distinct client keys -- both mapped to the current OS
 * user, since an unprivileged sshd cannot authenticate users that do not exist
 * in the OS -- over a single shared served directory, which is the
 * served-directory fidelity the rendezvous protocol needs. Password auth as the
 * current user is the fiddliest path (PAM/shadow), so this backend authenticates
 * by public key; the bulk password-auth coverage runs against the in-process
 * backend.
 *
 * The hardened profiles layer additional sshd directives (and, for `chroot`, a
 * root-owned jail and a root sshd) onto that same backend, each run against the
 * unchanged conformance suite.
 *
 * @internal exported for testing
 */
export async function startNativeSshdServer(
  options: NativeSshdOptions = {},
): Promise<SftpTestServer> {
  const profile = options.profile ?? "baseline";
  const isChroot = profile === "chroot";
  if (isChroot) {
    const cap = chrootCapability();
    if (!cap.ok) {
      // Backstop for a direct `PSILINK_SFTP_NATIVE_PROFILE=chroot` run that
      // bypasses the runChrootProfile.mjs runner (which skips cleanly instead);
      // fail with the actionable reason rather than a confusing chroot error.
      throw new Error(
        `Cannot start the chroot native-sshd profile: ${cap.reason}. ` +
          `Run it as root on Linux (the test:integration:native-chroot script, ` +
          `under sudo on CI), or pick a different PSILINK_SFTP_NATIVE_PROFILE.`,
      );
    }
  }

  const sshd = await resolveSshd();
  const osUser = os.userInfo().username;

  const workDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "psilink-sftp-sshd-"),
  );
  // The chroot jail lives outside workDir: ChrootDirectory requires every path
  // component to be root-owned and not group/world-writable, which os.tmpdir()
  // (world-writable) can never satisfy. /run is root-owned, so a jail under it
  // qualifies; mkdtemp creates it owned by the running root process, and the
  // chmod below pins it to 0700 explicitly rather than leaning on mkdtemp's mode.
  let jailDir: string | undefined;
  // Everything below creates files (keys, config, the jail); on any failure
  // before a server is handed back the catch removes both dirs so generated
  // private keys are not left on disk.
  try {
    let backingDir: string;
    let remoteRoot: string;
    if (isChroot) {
      jailDir = await fsp.mkdtemp("/run/psilink-sftp-chroot-");
      // Enforce the jail's ownership requirement in code: 0700 is root-owned and
      // not group/world-writable, so ChrootDirectory accepts it.
      await fsp.chmod(jailDir, 0o700);
      backingDir = path.join(jailDir, "srv");
      // The served subdir is the writable root inside the jail; the session runs
      // as root (the only user a root sshd authenticates here), so 0755 is
      // enough for it to write while keeping the jail itself owner-only.
      await fsp.mkdir(backingDir, { mode: 0o755 });
      // Inside the jail "/" is jailDir, so the served subdir is reached at
      // "/srv" over SFTP; remoteRoot already models a served path that differs
      // from the host path, so the conformance suite needs no change.
      remoteRoot = "/srv";
    } else {
      backingDir = path.join(workDir, "srv");
      await fsp.mkdir(backingDir, { recursive: true });
      remoteRoot = backingDir;
    }

    const hostKeyPath = path.join(workDir, "ssh_host_ed25519_key");
    const useraKeyPath = path.join(workDir, "usera_id_ed25519");
    const userbKeyPath = path.join(workDir, "userb_id_ed25519");
    await Promise.all([
      keygen(hostKeyPath),
      keygen(useraKeyPath),
      keygen(userbKeyPath),
    ]);

    const [useraPriv, userbPriv, useraPub, userbPub] = await Promise.all([
      fsp.readFile(useraKeyPath, "utf8"),
      fsp.readFile(userbKeyPath, "utf8"),
      fsp.readFile(`${useraKeyPath}.pub`, "utf8"),
      fsp.readFile(`${userbKeyPath}.pub`, "utf8"),
    ]);

    const hostKeyFingerprint = await hostKeyFingerprintFromPub(
      `${hostKeyPath}.pub`,
    );

    const authorizedKeysPath = path.join(workDir, "authorized_keys");
    // One key per line with an explicit separator, rather than relying on
    // ssh-keygen's .pub files always carrying a trailing newline.
    await fsp.writeFile(
      authorizedKeysPath,
      `${useraPub.trimEnd()}\n${userbPub.trimEnd()}\n`,
      { mode: 0o600 },
    );

    // The base config is the unchanged baseline: StrictModes off so sshd accepts
    // key files under a world-readable temp dir; internal-sftp serves backingDir.
    // The non-chroot profiles serve it at its real absolute path (root-owned
    // chroot components are unattainable unprivileged); the chroot profile adds
    // ChrootDirectory below. The adapter only ever opens the SFTP subsystem;
    // ForceCommand pins every session to internal-sftp so an authenticated
    // connection cannot open a shell or run an arbitrary command as the OS user.
    // The allowlist profile narrows AllowUsers to an explicit user@host matrix;
    // every other profile keeps the plain baseline allowlist.
    const allowUsers =
      profile === "allowlist"
        ? `AllowUsers ${osUser}@127.0.0.1`
        : `AllowUsers ${osUser}`;
    const directives = [
      "ListenAddress 127.0.0.1",
      `HostKey ${hostKeyPath}`,
      "LogLevel ERROR",
      "UsePAM no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      `AuthorizedKeysFile ${authorizedKeysPath}`,
      "Subsystem sftp internal-sftp",
      "ForceCommand internal-sftp",
      "StrictModes no",
      allowUsers,
    ];
    if (isChroot)
      // Keeps the plain `AllowUsers ${osUser}` from the base: the user@host
      // allow matrix is the allowlist profile's dimension, not this one's, which
      // exercises the jail and channel confinement.
      directives.push(
        `ChrootDirectory ${jailDir}`,
        ...CHROOT_CONFINEMENT_DIRECTIVES,
      );
    if (profile === "restricted-crypto")
      directives.push(...RESTRICTED_CRYPTO_DIRECTIVES);
    if (profile === "rate-limited") {
      directives.push(...RATE_LIMITED_DIRECTIVES);
      // PerSourcePenalties only on a new-enough OpenSSH; probe before adding so
      // an older local sshd does not reject the whole rate-limited config. It
      // penalizes misbehaving SOURCE addresses, never clean loopback traffic, so
      // it cannot trip the suite's successful connections.
      if (await sshdSupportsPerSourcePenalties(sshd, hostKeyPath, workDir)) {
        directives.push("PerSourcePenalties yes");
      }
    }
    const configBody = `${directives.join("\n")}\n`;

    // Validate before spending start attempts so an unsupported directive on
    // this host's sshd surfaces as a clear error, not a readiness timeout.
    const validationConfigPath = path.join(workDir, "sshd_config_validate");
    await fsp.writeFile(
      validationConfigPath,
      `Port ${VALIDATE_ONLY_PORT}\n${configBody}`,
    );
    const validation = await validateConfig(sshd, validationConfigPath);
    if (!validation.ok) {
      throw new Error(
        `Native sshd rejected the "${profile}" profile config` +
          (validation.stderr ? `:\n${validation.stderr}` : "."),
      );
    } else if (validation.stderr) {
      // sshd -t accepted the config but emitted a warning (e.g. a deprecated
      // directive). Surface it instead of dropping it, so a notice of a future
      // breakage is visible in the test log rather than silent.
      console.warn(
        `[sftp-test-server] sshd -t warning for the "${profile}" profile:\n` +
          validation.stderr,
      );
    }

    let attempt: NativeAttempt | undefined;
    let boundPort = 0;
    let lastError = "";
    for (let i = 0; i < START_ATTEMPTS; i += 1) {
      const port = await freePort();
      const configPath = path.join(workDir, `sshd_config_${port}`);
      await fsp.writeFile(configPath, `Port ${port}\n${configBody}`);

      const stderr = { value: "" };
      // -D keeps sshd in the foreground (so the child is the server, not a daemon
      // it forks off); -e logs to stderr, captured for diagnostics.
      const child = spawn(sshd, ["-D", "-e", "-f", configPath], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr?.on("data", (chunk) => (stderr.value += String(chunk)));

      const exited = { value: false };
      child.once("exit", () => (exited.value = true));

      const ready = await waitForPortOrExit(port, exited);
      if (ready) {
        boundPort = port;
        attempt = { child, stderr };
        break;
      }

      child.kill("SIGKILL");
      lastError = stderr.value.trim();
    }

    if (!attempt) {
      throw new Error(
        `Native sshd (${profile}) did not accept connections within ` +
          `${READY_TIMEOUT_MS / 1000}s over ${START_ATTEMPTS} attempts.` +
          (lastError ? `\nLast sshd stderr:\n${lastError}` : ""),
      );
    }

    const { child } = attempt;
    const jailToClean = jailDir;
    // Build the handle now the bound port is known, rather than constructing it
    // with a placeholder and mutating it inside the retry loop.
    const handle: SftpServerHandle = {
      host: "127.0.0.1",
      port: boundPort,
      backingDir,
      remoteRoot,
      hostKeyFingerprint,
      usera: { username: osUser, privateKey: useraPriv, hostKeyFingerprint },
      userb: { username: osUser, privateKey: userbPriv, hostKeyFingerprint },
    };
    return {
      handle,
      async stop() {
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null)
            return resolve();
          child.once("exit", () => resolve());
          child.kill("SIGTERM");
          // Hard stop if it ignores SIGTERM.
          setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
        });
        await fsp.rm(workDir, { recursive: true, force: true });
        if (jailToClean)
          await fsp.rm(jailToClean, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await fsp.rm(workDir, { recursive: true, force: true });
    if (jailDir) await fsp.rm(jailDir, { recursive: true, force: true });
    throw err;
  }
}

// Resolve true once the port accepts, false if sshd exits first or the deadline
// passes.
async function waitForPortOrExit(
  port: number,
  exited: { value: boolean },
): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited.value) return false;
    if (await sshBannerReady(port, READY_PROBE_TIMEOUT_MS)) return true;
    await new Promise((r) => setTimeout(r, READY_PROBE_INTERVAL_MS));
  }
  return false;
}
