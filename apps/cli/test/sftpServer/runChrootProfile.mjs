// Run the integration conformance suite against the chroot-hardened native sshd
// backend. The chroot profile needs sshd running as root (to call chroot(2))
// over a root-owned jail, so this leg only runs on Linux as root; everywhere
// else (local macOS, the unprivileged dev container) it prints a clear message
// and exits 0 -- a true skip, mirroring the in-process-only skips inside the
// suite rather than a confusing failure. CI invokes it under sudo on the Ubuntu
// runner, where it detects root and runs the suite green.
//
// The capability check is duplicated here (kept trivially in sync with
// chrootCapability() in nativeSshdServer.ts) so the skip happens before vitest
// and the native backend are ever loaded; the backend keeps its own check as a
// backstop for a direct PSILINK_SFTP_NATIVE_PROFILE=chroot invocation.
import { spawn } from "node:child_process";

function chrootCapability() {
  if (process.platform !== "linux") {
    return {
      ok: false,
      reason: `needs Linux for ChrootDirectory + chroot(2); this host is ${process.platform}`,
    };
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (uid !== 0) {
    return {
      ok: false,
      reason: `needs sshd to run as root (uid 0); current uid is ${uid} (re-run under sudo)`,
    };
  }
  return { ok: true, reason: "" };
}

const cap = chrootCapability();
if (!cap.ok) {
  // A clean skip (exit 0) is right for local/dev where chroot cannot run -- but
  // in CI this leg is the ONLY coverage of the chroot path, so a silent skip
  // there would go green having tested nothing. PSILINK_SFTP_CHROOT_REQUIRED=1
  // (set by the CI leg) turns the skip into a loud failure, so a broken sudo
  // elevation or a runner change cannot mask the chroot tests never running.
  const required = process.env.PSILINK_SFTP_CHROOT_REQUIRED === "1";
  const verb = required ? "FAIL" : "SKIP";
  console[required ? "error" : "log"](
    `[sftp-test-server] ${verb} native chroot profile: ${cap.reason}. ` +
      (required
        ? `This leg requires root on Linux (it runs the suite under sudo).`
        : `Run on Linux as root (CI runs it under sudo).`),
  );
  process.exit(required ? 1 : 0);
}

const child = spawn("npm", ["run", "test:integration"], {
  stdio: "inherit",
  env: {
    ...process.env,
    PSILINK_SFTP_BACKEND: "native",
    PSILINK_SFTP_NATIVE_PROFILE: "chroot",
  },
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
child.on("error", (err) => {
  console.error(`[sftp-test-server] failed to spawn vitest: ${err.message}`);
  process.exit(1);
});
