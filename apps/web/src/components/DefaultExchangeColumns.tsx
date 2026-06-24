import { useEffect, useState } from "react";

import { Badge, Group, Paper, Text } from "@mantine/core";

import { loadCSVColumns, sanitizeForDisplay } from "@psilink/core";

import { quickInviteDisclosedColumns } from "@psi/metadataEditing";

interface DefaultExchangeColumnsProps {
  /** The file chosen in the home page's shared drop. The disclosure is derived
   * from its header; an empty selection (or a file the quick path sends nothing
   * from) shows nothing. */
  files: Array<File>;
}

/**
 * The "Default exchange columns" awareness surface, shown under the shared file
 * drop on the home page: the columns the quick (name-only) invite path would send
 * to the partner for matched rows, derived from the file's header.
 *
 * It lives here, beneath the file, rather than inside the invite panel because the
 * one shared drop feeds either compose path: surfacing it in the invite panel made
 * it pop up even when the operator only meant to accept an invitation. Framed as
 * the file's *default* exchange columns (changeable via the invite panel's
 * "Advanced Options"), it reads as a neutral property of the chosen file.
 *
 * The set is {@link quickInviteDisclosedColumns} -- the SAME predicate the quick
 * path's exchange transmits on -- so this cannot over- or under-state what would
 * actually leave the machine. Read is header-only ({@link loadCSVColumns}); a read
 * error is swallowed (best-effort awareness), and the authoritative full parse and
 * its surfaced errors happen at generate. Column names are the operator's own but
 * sanitized for display.
 *
 * Wrapped in a standing polite, atomic live region so its asynchronous appearance
 * after a file is chosen is announced as one unit. Once a file's header is read the
 * surface always shows one of two states, both keyed on the SAME derived array (no
 * second "sends nothing" check that could drift from the wire): when the quick path
 * would send columns, the chip list plus a textual cue that this default set is
 * changed in the invite panel's "Advanced Options"; when it would send none, a brief
 * "no values will be sent" affirmation so the operator gets positive confirmation
 * rather than silence. Neither state carries a control here -- the one "Advanced
 * Options" control lives in the invite panel.
 */
export function DefaultExchangeColumns({ files }: DefaultExchangeColumnsProps) {
  // `undefined` while no file is chosen or its header read is still in flight; an
  // empty array means the quick path would send nothing.
  const [disclosedColumns, setDisclosedColumns] = useState<Array<string>>();

  // Recompute the disclosure each time the selection changes. The cleanup flag
  // drops a stale or post-unmount result -- selecting a new file supersedes an
  // in-flight read of the previous one.
  useEffect(() => {
    if (files.length === 0) {
      setDisclosedColumns(undefined);
      return;
    }
    const file = files[0];
    let cancelled = false;
    setDisclosedColumns(undefined);
    void loadCSVColumns(file)
      .then((columns) => {
        if (!cancelled)
          setDisclosedColumns(quickInviteDisclosedColumns(columns));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [files]);

  return (
    <div role="status" aria-live="polite" aria-atomic="true">
      {disclosedColumns !== undefined &&
        (disclosedColumns.length > 0 ? (
          <Paper withBorder p="md">
            <Text size="sm" fw={600} mb={4}>
              Default exchange columns
            </Text>
            <Text size="sm">
              For each row in your file that matches, you will send your partner
              these elements:
            </Text>
            {/* Informational chips, not controls: a non-interactive Badge list (no
                onClick, no Chip/Pill toggle or remove affordance), marked up as a
                list so assistive tech reads it as a list of names. Changing what is
                sent happens in Advanced, never by editing a chip. tt="none" keeps
                the operator's column names verbatim rather than upper-casing them
                into system-looking tokens. */}
            <Group
              gap="xs"
              mt="xs"
              role="list"
              aria-label="Default columns sent to your partner"
            >
              {disclosedColumns.map((name) => (
                <Badge
                  key={name}
                  role="listitem"
                  variant="light"
                  color="gray"
                  tt="none"
                  radius="sm"
                  size="md"
                  style={{ cursor: "default" }}
                >
                  {sanitizeForDisplay(name)}
                </Badge>
              ))}
            </Group>
            {/* Changeability cue beneath the chips: a textual hint (no control) that
                this is the default set and what is sent is changed in the invite
                panel's "Advanced Options" -- the relationship the "Default" label
                implies but does not otherwise spell out. */}
            <Text size="xs" c="dimmed" mt="xs">
              These are the defaults; change what you send in Advanced Options.
            </Text>
            <Text size="xs" c="dimmed" mt={4}>
              Your partner never receives the values in your non-matching rows.
            </Text>
          </Paper>
        ) : (
          // Empty: the quick path would send no column values for this file. Show a
          // brief affirmation (no control -- Advanced Options lives in the invite
          // panel) rather than an empty render, so the operator gets positive
          // confirmation. This branch is reached only when the SAME derived array is
          // empty, never a second "sends nothing" check, so it cannot drift from
          // what the wire transmits.
          <Paper withBorder p="md">
            <Text size="sm" fw={600} mb={4}>
              Default exchange columns
            </Text>
            <Text size="sm">
              No values will be sent to your partner. Your file&apos;s columns
              are used only to find matches.
            </Text>
          </Paper>
        ))}
    </div>
  );
}
