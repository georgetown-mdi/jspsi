import { useId, useState } from "react";

import {
  Collapse,
  Group,
  Paper,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";

import { IconChevronRight } from "@tabler/icons-react";

import type { ReactNode } from "react";

/**
 * A bordered card whose body collapses behind a single disclosure header -- the
 * shared shell for the per-field cleaning cards in the inviter's "Clean and bind
 * your fields" workbench ({@link StandardizationWorkbench}) and the acceptor's
 * "Clean your data to match" editor ({@link PrepareData}). Each card starts
 * collapsed to a one-line header (the safe semantic-type label, e.g. "Social
 * Security number"), so a long list of fields reads as a scannable index and the
 * dense step/preview detail is one expand away.
 *
 * The disclosure mirrors the master-detail pattern in {@link InvitationTerms}:
 * aria-expanded + aria-controls on the toggle, the id on the always-mounted wrapper
 * (not the Collapse panel) so the reference survives Mantine's reduced-motion
 * unmount of the closed panel, and the panel hidden from assistive tech + the tab
 * order while closed.
 *
 * {@link headerExtra} renders beside the title, OUTSIDE the collapse, so a signal
 * that must stay visible while the body is collapsed (the acceptor's silent-empty
 * coverage warning) is not buried with the detail.
 */
export function CollapsibleFieldCard({
  title,
  headerExtra,
  defaultOpen = false,
  children,
}: {
  /** The always-visible header label (a safe semantic-type label, never a
   * partner-controlled field name). */
  title: string;
  /** Optional node rendered beside the title and outside the collapse, for a signal
   * that must stay visible while the body is collapsed. */
  headerExtra?: ReactNode;
  /** Whether the card starts expanded. Defaults to collapsed. */
  defaultOpen?: boolean;
  /** The collapsible body. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Stable id linking the toggle (aria-controls) to its always-mounted panel
  // wrapper; useId keeps it consistent across SSR and hydration.
  const panelId = useId();
  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <UnstyledButton
            onClick={() => setOpen((isOpen) => !isOpen)}
            aria-expanded={open}
            aria-controls={panelId}
          >
            <Group gap={4} wrap="nowrap">
              <IconChevronRight
                size={16}
                aria-hidden
                style={{
                  transform: open ? "rotate(90deg)" : "rotate(0deg)",
                  transition: "transform 150ms ease",
                }}
              />
              <Text size="sm" fw={600}>
                {title}
              </Text>
            </Group>
          </UnstyledButton>
          {headerExtra}
        </Group>
        {/* aria-controls points at this always-mounted wrapper, not the Collapse
            panel: under respectReducedMotion the closed panel is unmounted, which
            would dangle an id held on the panel itself. */}
        <div id={panelId}>
          <Collapse expanded={open}>{children}</Collapse>
        </div>
      </Stack>
    </Paper>
  );
}
