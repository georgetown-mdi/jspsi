import { createElement, useId, useRef } from "react";

import { Box, Collapse, Group, Text, UnstyledButton } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { useReducedMotion } from "@mantine/hooks";

import type { ReactNode } from "react";

/**
 * One collapsible section: a toggle whose accessible name IS the section label, an
 * always-mounted panel wrapper, a reduced-motion-safe chevron, and a focus guard on
 * collapse. The single disclosure idiom the data-prep editors use (the inviter's rail
 * sections and the per-field cleaning cards' sample preview) so the two cannot drift.
 *
 * Three a11y properties are load-bearing:
 *  - The `aria-controls` target is the ALWAYS-MOUNTED `<div id>` wrapper, not the
 *    `Collapse` panel (which Mantine unmounts under `prefers-reduced-motion`), so the
 *    reference never dangles.
 *  - The chevron's rotate transition is suppressed under reduced motion.
 *  - On COLLAPSE, if focus is inside the panel it is moved to the toggle BEFORE the
 *    panel hides -- otherwise the browser drops focus to `<body>` (the common trap when
 *    a user collapses a section while focused on a control inside it).
 *
 * The host owns the open state (controlled), so it can default sections open/closed
 * and key other behavior off them.
 */
export function DisclosureSection({
  label,
  open,
  onToggle,
  children,
  summary,
  headingOrder,
}: {
  /** The section label; becomes the toggle button's accessible name. */
  label: ReactNode;
  /** Whether the panel is expanded (controlled by the host). */
  open: boolean;
  /** Toggle handler; receives the next open state. */
  onToggle: (open: boolean) => void;
  children: ReactNode;
  /** Optional one-line state shown beside the label only when COLLAPSED, so a closed
   * section is not a blind box (e.g. "Attached: MOU-2025-0042" / "None"). Omit for
   * always-open or self-evident sections. */
  summary?: ReactNode;
  /** Render the toggle inside a heading element of this level for landmark
   * navigation. Omit for a sub-control disclosure (e.g. a per-card preview). */
  headingOrder?: 2 | 3 | 4 | 5 | 6;
}) {
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();

  const handleClick = () => {
    // Closing: if focus is inside the panel, move it to the toggle before the panel
    // hides, so a keyboard/SR user editing inside the section is not dropped to
    // <body>. Fires synchronously in the click handler, ahead of the re-render that
    // hides the panel. Opening never strands focus.
    if (open) {
      const panel = panelRef.current;
      if (panel !== null && panel.contains(document.activeElement))
        toggleRef.current?.focus();
    }
    onToggle(!open);
  };

  const toggle = (
    <UnstyledButton
      ref={toggleRef}
      onClick={handleClick}
      aria-expanded={open}
      aria-controls={panelId}
      style={{ width: "100%" }}
    >
      <Group gap="xs" wrap="nowrap">
        <IconChevronRight
          size={16}
          aria-hidden
          style={{
            flexShrink: 0,
            transform: open ? "rotate(90deg)" : "none",
            transition: reduceMotion ? undefined : "transform 150ms ease",
          }}
        />
        <Text size="sm" fw={600}>
          {label}
        </Text>
        {!open && summary !== undefined && (
          <Text size="xs" c="dimmed">
            {summary}
          </Text>
        )}
      </Group>
    </UnstyledButton>
  );

  return (
    <Box>
      {headingOrder !== undefined
        ? createElement(`h${headingOrder}`, { style: { margin: 0 } }, toggle)
        : toggle}
      {/* The always-mounted wrapper carries the aria-controls id; Collapse may unmount
          its inner panel under reduced motion, but this node persists. */}
      <div id={panelId} ref={panelRef}>
        <Collapse expanded={open}>{children}</Collapse>
      </div>
    </Box>
  );
}
