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
 *
 * The list's accessible name comes from exactly one of two mutually exclusive
 * props: `label` sets it directly as the group's aria-label, for a caller with no
 * visible caption naming the list; `labelledBy` points aria-labelledby at an
 * existing visible caption's id, for a caller whose caption already names the list
 * -- so the list's name derives from that one visible caption rather than a second,
 * separately-authored aria-label string that could drift from it. This does not
 * reduce how often a screen reader speaks the caption: a named list is still
 * announced by name at its boundary, as any labelled region is (cf. a fieldset's
 * legend); labelledby only makes the visible caption the single source of that name.
 */
export function ColumnChips({
  columns,
  label,
  labelledBy,
}: {
  columns: Array<string>;
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
