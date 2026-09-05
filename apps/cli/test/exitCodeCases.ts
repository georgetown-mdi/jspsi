import {
  ConnectionError,
  InternalConsistencyError,
  UsageError,
} from "@psilink/core";

import { PERSISTENCE_LOSS_EXIT_CODE } from "../src/eventStream";

/**
 * One error per class `exitCodeForError` (src/util/exit.ts) distinguishes, with
 * the exit code docs/CLI.md's exit-code table states a command reports for it.
 *
 * Every command routes its caught error through that one classification, so a
 * boundary test plants each of these at the call the boundary wraps and asserts
 * the code the process exits with. `plant` returns a fresh error per case so a
 * test can throw it and a later assertion can still name what it threw.
 *
 * @internal test-only
 */
export const ERROR_CLASS_EXIT_CODES: ReadonlyArray<{
  readonly planted: string;
  readonly code: number;
  readonly plant: () => unknown;
}> = [
  {
    planted: "a UsageError",
    code: 64,
    plant: () => new UsageError("the operator supplied something unusable"),
  },
  {
    planted: 'a ConnectionError of kind "usage"',
    code: 64,
    plant: () =>
      new ConnectionError("the caller misused the transport", "usage"),
  },
  {
    planted: 'a ConnectionError of kind "transport"',
    code: 69,
    plant: () => new ConnectionError("the server went away", "transport"),
  },
  {
    planted: "an InternalConsistencyError",
    code: 70,
    plant: () =>
      new InternalConsistencyError("two derivations of one size disagreed"),
  },
  {
    planted: "an Error carrying its own exitCode",
    code: PERSISTENCE_LOSS_EXIT_CODE,
    plant: () =>
      Object.assign(new Error("the result file did not reach disk"), {
        exitCode: PERSISTENCE_LOSS_EXIT_CODE,
      }),
  },
  {
    planted: "a plain Error",
    code: 69,
    plant: () => new Error("something the boundary cannot classify"),
  },
];
