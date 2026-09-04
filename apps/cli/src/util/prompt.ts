// Asking the operator a question on the terminal. Every question goes to stderr
// so stdout stays reserved for a command's result data, and stdin is read
// through one readline interface at a time.

import readline from "node:readline/promises";

/**
 * The stream a confirmation prompt asks on -- stderr, so stdout stays reserved
 * for a command's result data. {@link promptConfirm} and {@link writePromptLine}
 * both write through this one binding rather than naming `process.stderr`
 * separately, so text a caller must show WITH a prompt cannot land on a different
 * descriptor than the question does.
 */
const promptStream = process.stderr;

/**
 * Write one line where {@link promptConfirm} asks, for text the operator must
 * see whatever the diagnostic sink and level are -- the accept consent
 * surface, which the prompt's own question is answered against. Plain: no
 * log prefix, since this is prompt-adjacent text rather than a diagnostic
 * record (a `--log-file` copy of the same line still holds the prefix).
 *
 * Best-effort: a wedged stream drops the line rather than throwing back into
 * the caller. The drop is not reported, so a run whose prompt stream fails
 * partway through the surface can reach the question having shown only part
 * of it. That is a stated limit, recorded for the operator under acceptance
 * in docs/CLI.md.
 */
export function writePromptLine(line: string): void {
  try {
    promptStream.write(`${line}\n`);
  } catch {
    // Dropped; see the limit above.
  }
}

/**
 * Ask `question` on the prompt stream and resolve to the line the user typed,
 * raw -- neither trimmed nor interpreted, since what a blank or padded answer
 * means belongs to the caller that asked. EOF and a non-interactive stdin
 * both resolve to the empty string, the same "nothing was answered" every
 * caller of {@link promptConfirm} treats as a decline.
 *
 * The one place a question is asked: {@link promptConfirm} is this with a
 * y/N suffix and its answer interpreted, so `process.stdin` is read through
 * one readline interface at a time and every question goes to
 * {@link promptStream} (stderr). stdin is single-use, so a command whose
 * input CSV is `-` must not reach either of them.
 */
export async function promptFreeText(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: promptStream,
  });
  try {
    // `rl.question()` never settles when stdin reaches EOF (a closed or
    // piped-empty stdin) -- a long-standing readline/promises behavior
    // (nodejs/node#53497). Race it against the interface's "close" event
    // (which does fire on EOF) so a closed stdin resolves to the empty
    // answer instead of leaving the promise pending forever.
    return await new Promise<string>((resolve) => {
      rl.once("close", () => resolve(""));
      void rl.question(`${question} `).then(resolve, () => resolve(""));
    });
  } finally {
    rl.close();
  }
}

/**
 * Prompt the user to confirm on the terminal, returning true only on an
 * explicit yes. Anything else (including EOF or a non-interactive stdin)
 * defaults to no. Prompts on stderr so stdout stays reserved for exchange
 * results.
 */
export async function promptConfirm(question: string): Promise<boolean> {
  const normalized = (await promptFreeText(`${question} [y/N]`))
    .trim()
    .toLowerCase();
  return normalized === "y" || normalized === "yes";
}
