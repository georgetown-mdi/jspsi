/**
 * The daily schedule snippets a hand-off surface shows an operator: the cron
 * entry and the Windows Task Scheduler registration that run a psilink
 * invocation unattended from the folder holding its files.
 *
 * One copy, shared by both hand-off surfaces -- the managed exchange's
 * command-line export panel and the console's recurring hand-off -- so the two
 * cannot diverge.
 *
 * The lines are examples the operator edits: the times are a placeholder daily
 * 2am, and the folder is machine-specific, so what travels is the invocation
 * rather than the schedule.
 */

/** The folder placeholder the POSIX schedule line changes into. The exported or
 * copied files carry no path of their own -- the command reads its config and key
 * from the working directory -- so the one machine-specific value is where the
 * operator put them. */
const POSIX_FOLDER_PLACEHOLDER = "/path/to/your/exchange-folder";

/** The Windows counterpart of {@link POSIX_FOLDER_PLACEHOLDER}. */
const WINDOWS_FOLDER_PLACEHOLDER = "C:\\path\\to\\your\\exchange-folder";

/**
 * The cron line that runs `command` daily at 2am from the folder holding the
 * exchange's files. `command` is already quoted for a POSIX shell, which is what
 * cron hands the line to.
 */
export function cronScheduleLine(command: string): string {
  return `0 2 * * * cd ${POSIX_FOLDER_PLACEHOLDER} && ${command}`;
}

/**
 * The Windows Task Scheduler command that registers `command` daily at 2am from
 * the folder holding the exchange's files. `command` is already quoted for
 * `cmd`.
 *
 * The command is interpolated into the `/TR "..."` argument, so a double quote
 * inside it would end that argument early: schtasks needs each one escaped as
 * `\"` for its argv parse to preserve it for the scheduled `cmd` to re-read.
 * That escape happens here, not at each call site, so every caller gets the
 * same treatment.
 */
export function taskSchedulerLine(command: string): string {
  return (
    `schtasks /Create /TN "psilink exchange" /SC DAILY /ST 02:00 ` +
    `/TR "cmd /c cd /d ${WINDOWS_FOLDER_PLACEHOLDER} && ` +
    `${command.replaceAll('"', '\\"')}"`
  );
}
