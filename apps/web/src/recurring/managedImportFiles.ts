/**
 * Which files an import control was given, read off their names before any is
 * opened: one file on its own -- a backup, or a `psilink.yaml` imported as a
 * configuration only -- or a `psilink.yaml` with the `.psilink.key` beside it.
 * The key file is the one whose name ends in `.key`, the name psilink writes
 * (`DEFAULT_KEY_PATH`, `apps/cli/src/keyFile.ts`) and the one a browser download
 * keeps; the other file's contents decide what it is, as they do for one file
 * chosen alone.
 */

import type { ManagedImportGrantNotice } from "./managedImportGrantNotice";

/** The file extension that marks a chosen file as the key file. */
const KEY_FILE_EXTENSION = ".key";

/** What a control's chosen files are, or why they are refused unopened. */
export type ManagedImportFileChoice<TFile> =
  | { kind: "one"; file: TFile }
  | { kind: "pair"; configurationFile: TFile; keyFile: TFile }
  | { kind: "refused"; reason: string };

/** A key file chosen without the configuration it belongs beside. */
export const KEY_FILE_ALONE_REASON =
  "This is a .psilink.key on its own. Choose the psilink.yaml beside it as " +
  "well, both in the same file chooser, and import them together.";

/** Two files chosen, and not one configuration and one key file. */
export const NOT_A_PAIR_REASON =
  "Two files are imported together only as a psilink.yaml and the " +
  ".psilink.key beside it, and exactly one of them has a name ending in .key. " +
  "Choose one file, or those two.";

/** More than two files chosen. */
export const TOO_MANY_FILES_REASON =
  "Choose one file, or a psilink.yaml and the .psilink.key beside it.";

/** What a pair import that installed or revived a record says before the
 * operator opens it: that this exchange runs here now, unlike one imported
 * from its psilink.yaml alone, and the command-line run to stop. */
export const PAIR_IMPORTED_NOTICE: ManagedImportGrantNotice = {
  title: "Imported with its key file",
  lead:
    "This exchange runs in this browser now. If the command line still runs " +
    "it on a schedule, stop that first: each run changes the shared secret, " +
    "and the copy that falls behind can no longer connect to your partner.",
  consequences: [],
};

/** Whether a file's name marks it as the key file. */
function isKeyFileName(name: string): boolean {
  return name.toLowerCase().endsWith(KEY_FILE_EXTENSION);
}

/**
 * Sort a control's chosen files into one file or a configuration and its key
 * file, or refuse them, reading names only. `undefined` where nothing was
 * chosen.
 */
export function managedImportFileChoice<TFile extends { name: string }>(
  files: ReadonlyArray<TFile>,
): ManagedImportFileChoice<TFile> | undefined {
  if (files.length === 0) return undefined;
  if (files.length > 2)
    return { kind: "refused", reason: TOO_MANY_FILES_REASON };
  if (files.length === 1) {
    const [file] = files;
    return isKeyFileName(file.name)
      ? { kind: "refused", reason: KEY_FILE_ALONE_REASON }
      : { kind: "one", file };
  }
  const keys = files.filter((file) => isKeyFileName(file.name));
  const configurations = files.filter((file) => !isKeyFileName(file.name));
  if (keys.length !== 1 || configurations.length !== 1)
    return { kind: "refused", reason: NOT_A_PAIR_REASON };
  return {
    kind: "pair",
    configurationFile: configurations[0],
    keyFile: keys[0],
  };
}
