import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { SftpServerHandle, SftpTestServer } from "./types";

const execFileAsync = promisify(execFile);

// Where the system OpenSSH server lives. internal-sftp is built into sshd, so no
// separate binary is needed. macOS and the Ubuntu CI runners ship sshd at
// /usr/sbin/sshd; elsewhere it comes from the openssh-server package.
const SSHD_CANDIDATES = ["/usr/sbin/sshd", "/usr/local/sbin/sshd"];

const READY_TIMEOUT_MS = 20_000;
const READY_PROBE_INTERVAL_MS = 100;
const START_ATTEMPTS = 3;

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

// A free loopback port. There is an unavoidable gap between closing this probe
// socket and sshd binding the port, so start() retries on an early exit.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
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
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
    socket.once("data", (chunk) =>
      settle(chunk.toString("utf8", 0, 4) === "SSH-"),
    );
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

interface NativeAttempt {
  child: ChildProcess;
  stderr: { value: string };
}

/**
 * Spawn a native OpenSSH sshd as an unprivileged child running internal-sftp
 * without a chroot (the Phase-1 native backend). It authenticates two distinct
 * client keys -- both mapped to the current OS user, since an unprivileged sshd
 * cannot authenticate users that do not exist in the OS -- over a single shared
 * served directory, which is the served-directory fidelity the rendezvous
 * protocol needs. Password auth as the current user is the fiddliest path
 * (PAM/shadow), so this backend authenticates by public key; the bulk
 * password-auth coverage runs against the in-process backend.
 *
 * @internal exported for testing
 */
export async function startNativeSshdServer(): Promise<SftpTestServer> {
  const sshd = await resolveSshd();
  const osUser = os.userInfo().username;

  const workDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "psilink-sftp-sshd-"),
  );
  const backingDir = path.join(workDir, "srv");
  await fsp.mkdir(backingDir, { recursive: true });

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

  const authorizedKeysPath = path.join(workDir, "authorized_keys");
  await fsp.writeFile(authorizedKeysPath, `${useraPub}${userbPub}`, {
    mode: 0o600,
  });

  // StrictModes off so sshd accepts key files under a world-readable temp dir;
  // internal-sftp without ChrootDirectory (root-owned components are
  // unattainable unprivileged) serves backingDir at its real absolute path.
  const configBody = [
    "ListenAddress 127.0.0.1",
    `HostKey ${hostKeyPath}`,
    "LogLevel ERROR",
    "UsePAM no",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PubkeyAuthentication yes",
    `AuthorizedKeysFile ${authorizedKeysPath}`,
    "Subsystem sftp internal-sftp",
    "StrictModes no",
    `AllowUsers ${osUser}`,
    "",
  ].join("\n");

  const handle: SftpServerHandle = {
    host: "127.0.0.1",
    port: 0,
    backingDir,
    remoteRoot: backingDir,
    usera: { username: osUser, privateKey: useraPriv },
    userb: { username: osUser, privateKey: userbPriv },
  };

  let attempt: NativeAttempt | undefined;
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
      handle.port = port;
      attempt = { child, stderr };
      break;
    }

    child.kill("SIGKILL");
    lastError = stderr.value.trim();
  }

  if (!attempt) {
    await fsp.rm(workDir, { recursive: true, force: true });
    throw new Error(
      `Native sshd did not accept connections within ` +
        `${READY_TIMEOUT_MS / 1000}s over ${START_ATTEMPTS} attempts.` +
        (lastError ? `\nLast sshd stderr:\n${lastError}` : ""),
    );
  }

  const { child } = attempt;
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
    },
  };
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
    if (await sshBannerReady(port, READY_PROBE_INTERVAL_MS)) return true;
    await new Promise((r) => setTimeout(r, READY_PROBE_INTERVAL_MS));
  }
  return false;
}
