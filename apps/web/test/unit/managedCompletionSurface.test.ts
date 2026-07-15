import { describe, expect, test, vi } from "vitest";

import { managedRerunCompletion } from "@psi/managedCompletionSurface";

import type { ManagedBackupExportHook } from "@psi/managedCompletionSurface";

// The completion surface's backup-refresh hook, tested in Node. A successful re-run
// just rotated the secret, so the previous backup is stale; the surface offers
// "download updated backup" when an exporter is wired, and names it deferred until
// the export artifact item lands.

describe("managedRerunCompletion", () => {
  test("with no exporter wired, the refresh affordance is deferred", () => {
    const completion = managedRerunCompletion();
    expect(completion.backupAffordance).toBe("deferred");
    expect(completion.backupHook).toBeUndefined();
  });

  test("with an exporter wired, the surface offers the refresh and carries the hook", () => {
    const downloadUpdatedBackup = vi.fn(() => Promise.resolve());
    const hook: ManagedBackupExportHook = { downloadUpdatedBackup };
    const completion = managedRerunCompletion(hook);
    expect(completion.backupAffordance).toBe("offer-refresh");
    expect(completion.backupHook).toBe(hook);
  });

  test("the offered hook is the injected exporter -- the action calls it", async () => {
    const downloadUpdatedBackup = vi.fn(() => Promise.resolve());
    const completion = managedRerunCompletion({ downloadUpdatedBackup });
    await completion.backupHook?.downloadUpdatedBackup();
    expect(downloadUpdatedBackup).toHaveBeenCalledTimes(1);
  });
});
