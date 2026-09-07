import { Badge, Group } from "@mantine/core";

import type { ReactNode } from "react";

/**
 * A non-interactive list of column-name chips: the shared visual for the
 * "these columns" surfaces in the terms panel ({@link InvitationTerms}: the
 * sent-columns disclosure and the inviter's own send). Presentational only,
 * over the display form the caller chose: an entry is either a name the
 * invitation summary escaped, or a `ColumnName` element isolating one of the
 * operator's own file headers. Which of the two a name takes follows its
 * provenance and is decided at the call site; this list decides the layout, and
 * takes the accessible group label and the surrounding copy from the caller.
 *
 * Chips, not controls: no onClick and no remove control, marked up as a list so
 * assistive tech reads it as a list of names. Keyed by index -- neither display
 * form is guaranteed unique -- and tt="none" keeps each name verbatim rather
 * than upper-casing it into a system-looking token.
 *
 * The list's accessible name comes from exactly one of two mutually exclusive
 * props: `label` sets it directly as the group's aria-label, for a caller with no
 * visible caption naming the list; `labelledBy` points aria-labelledby at an
 * existing visible caption's id, so the name derives from that caption rather
 * than a second, separately-authored string that could drift from it.
 */
export function ColumnChips({
  columns,
  label,
  labelledBy,
}: {
  /** One entry per chip, each in the form it displays in. */
  columns: Array<ReactNode>;
} & (
  | {
      /** The list's accessible name, set directly as aria-label. */
      label: string;
      labelledBy?: never;
    }
  | {
      /** Id of a visible caption that names the list via aria-labelledby. */
      labelledBy: string;
      label?: never;
    }
)) {
  return (
    <Group gap="xs" role="list" aria-label={label} aria-labelledby={labelledBy}>
      {columns.map((column, index) => (
        <Badge
          key={index}
          role="listitem"
          variant="light"
          color="gray"
          tt="none"
          radius="sm"
          size="md"
          style={{ cursor: "default" }}
        >
          {column}
        </Badge>
      ))}
    </Group>
  );
}
