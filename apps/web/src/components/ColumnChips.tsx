import { Badge, Group } from "@mantine/core";

/**
 * A non-interactive list of column-name chips: the shared visual for the
 * "these columns" surfaces -- the home page's default exchange columns
 * ({@link DefaultExchangeColumns}) and the invitation preview's sent-columns
 * disclosure ({@link InvitationTerms}). Presentational only: the caller passes
 * names that are already safe to display (the home page sanitizes its
 * operator-entered headers; the invitation summary pre-sanitizes any
 * partner-controlled name) and supplies the accessible group label and the
 * surrounding copy.
 *
 * Chips, not controls: no onClick and no remove affordance, marked up as a list
 * so assistive tech reads it as a list of names. Keyed by index -- a sanitized
 * name is not guaranteed unique -- and tt="none" keeps each name verbatim rather
 * than upper-casing it into a system-looking token.
 */
export function ColumnChips({
  columns,
  label,
}: {
  columns: Array<string>;
  /** The list's accessible name (aria-label on the role=list group). */
  label: string;
}) {
  return (
    <Group gap="xs" role="list" aria-label={label}>
      {columns.map((name, index) => (
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
          {name}
        </Badge>
      ))}
    </Group>
  );
}
