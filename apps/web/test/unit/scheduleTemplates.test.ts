import { expect, test } from "vitest";

import {
  cronScheduleLine,
  taskSchedulerLine,
} from "@recurring/scheduleTemplates";

// The two schedule snippets both hand-off surfaces show. An operator copies
// these verbatim into cron or schtasks, so what is checked here is the text they
// paste: the command runs from the folder the placeholder names, and the Windows
// registration survives a command that holds quotes of its own.

const COMMAND = "psilink exchange input.csv results.csv";

test("the cron line runs the command daily at 2am from the exchange folder", () => {
  expect(cronScheduleLine(COMMAND)).toBe(
    `0 2 * * * cd /path/to/your/exchange-folder && ${COMMAND}`,
  );
});

test("the Task Scheduler line registers the same run for Windows", () => {
  const line = taskSchedulerLine(COMMAND);
  expect(line).toContain('schtasks /Create /TN "psilink exchange"');
  expect(line).toContain("/SC DAILY /ST 02:00");
  expect(line).toContain(
    `/TR "cmd /c cd /d C:\\path\\to\\your\\exchange-folder && ${COMMAND}"`,
  );
});

test("a command holding quotes keeps them inside the /TR argument", () => {
  // Inside /TR "...", an unescaped double quote from the command would end that
  // argument early and register a task that runs a truncated command. schtasks
  // preserves a `\"` for the scheduled cmd to re-read, which is what a Direct
  // invocation with a spaced label needs.
  const quoted = 'psilink "--identity=Agency A" input.csv results.csv';
  const line = taskSchedulerLine(quoted);
  expect(line).toContain('\\"--identity=Agency A\\"');
  // Two delimiters around the task name, two around the /TR argument, and none
  // of the command's own: every quote in the line is accounted for.
  expect(line.match(/(?<!\\)"/g)).toHaveLength(4);
});
