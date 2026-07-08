import {
  ActionIcon,
  Code,
  CopyButton,
  Group,
  Stack,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";

import type { Ref } from "react";

/** A labelled, copy-to-clipboard view of one shareable artifact. It is only ever
 * rendered on the client -- behind the inviter exchange screen, which the compose
 * screen swaps in only from an event handler, so it is absent from the server
 * render and never participates in hydration. The `typeof navigator` check is
 * defence-in-depth (and hides the button on non-secure origins, where
 * `navigator.clipboard` is undefined), not the SSR safety mechanism -- that is the
 * call-site guard. */
function CopyRow({
  label,
  description,
  value,
}: {
  label: string;
  description: string;
  value: string;
}) {
  return (
    <Stack gap={2}>
      <Text size="sm" fw={500}>
        {label}
      </Text>
      <Text size="xs" c="dimmed">
        {description}
      </Text>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Code block style={{ flex: 1, overflowWrap: "anywhere" }}>
          {value}
        </Code>
        {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          typeof navigator !== "undefined" && navigator.clipboard ? (
            <CopyButton value={value} timeout={1000}>
              {({ copied, copy }) => (
                <Tooltip
                  label={copied ? "Copied" : "Copy to clipboard"}
                  // Open on keyboard focus too, not hover only, so keyboard
                  // users get the same affordance.
                  events={{ hover: true, focus: true, touch: true }}
                >
                  <ActionIcon
                    onClick={copy}
                    variant={copied ? "light" : "filled"}
                    // Name reflects the copied state so a screen reader announces
                    // the success (the icon/tooltip change alone is not conveyed
                    // to assistive tech).
                    aria-label={
                      copied ? `${label} copied` : `Copy ${label.toLowerCase()}`
                    }
                  >
                    {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          ) : null
        }
      </Group>
    </Stack>
  );
}

/**
 * The inviter's share block on the exchange screen: the copy-link/code artifacts
 * and the invitation's expiry, weighted above the terms so sharing is the first
 * thing the inviter does while waiting. The exchange screen renders it only while
 * the partner has not connected (`!peerConnected`) and drops it entirely once they
 * do: there is nothing left to share, and Status then shows the run is underway, so
 * a "Partner connected" restatement would only add noise. Focus recovery on connect
 * is handled by the exchange screen (it moves focus to the Status heading), not here.
 */
export function ShareBlock({
  deepLink,
  encoded,
  expires,
  headingRef,
}: {
  deepLink: string;
  encoded: string;
  /** The invitation's expiry instant (ISO 8601), if it carries one. */
  expires?: string;
  /** Focus target for the heading. The inviter exchange screen leads with this
   * block (sharing the link is the urgent post-generate task) and moves initial
   * focus here on mount, so a keyboard/screen-reader user who pressed Generate lands
   * on the link to copy rather than on the unmounted compose button. */
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <Stack gap="sm">
      <Title order={3} ref={headingRef} tabIndex={-1}>
        Share this invitation
      </Title>
      <Text size="sm" c="dimmed">
        Send one of these to your partner over a trusted channel (for example,
        secure email). It carries a one-time secret, so treat it as confidential
        and do not post it publicly. Keep this tab open while your partner
        accepts.
      </Text>
      <CopyRow
        label="Invitation link"
        description="Opens the accept page with the invitation prefilled"
        value={deepLink}
      />
      <CopyRow
        label="Invitation code"
        description="Paste into the accept form if the link cannot be used"
        value={encoded}
      />
      {expires !== undefined && (
        <Text size="xs" c="dimmed">
          {/* Label the time zone: the expiry is one instant, but inviter and
              acceptor may be in different zones, so a bare local wall-clock time
              would read as a different deadline on each end. */}
          This invitation expires{" "}
          {new Date(expires).toLocaleString(undefined, {
            timeZoneName: "short",
          })}
        </Text>
      )}
    </Stack>
  );
}
