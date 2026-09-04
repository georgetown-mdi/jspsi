import { vi } from "vitest";
import type { MockInstance } from "vitest";

/**
 * Replace `process.exit` with a throw for the duration of a test, so a command
 * handler that exits can be driven to completion and its code asserted.
 *
 * The throw is what makes the capture usable: `process.exit` is typed `never`
 * and the handlers rely on that, so a mock that merely records the code and
 * returns would let the code AFTER the exit run -- an exit boundary would then
 * be tested against a control flow production never takes. The message form is
 * `exit:<code>`, which a test matches with `toThrow("exit:64")` where the code
 * is what it is asserting, and the spy's `toHaveBeenCalledWith` where it is not.
 *
 * The caller restores it (`exitSpy.mockRestore()` in a `finally`, or vitest's
 * `restoreMocks`): a leaked mock turns a later test's real exit into a throw in
 * whatever frame happened to call it.
 *
 * @internal test-only
 */
export function captureProcessExit(): MockInstance<typeof process.exit> {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
}
