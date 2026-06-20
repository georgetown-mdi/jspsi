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
 * thing the inviter does while waiting. Once the partner connects (`connected`),
 * it collapses to a one-line "Partner connected" indicator rather than vanishing,
 * so the screen does not reflow out from under the inviter mid-glance and the
 * connection is positively confirmed.
 */
export function ShareBlock({
  deepLink,
  encoded,
  expires,
  connected,
  headingRef,
  connectedRef,
}: {
  deepLink: string;
  encoded: string;
  /** The invitation's expiry instant (ISO 8601), if it carries one. */
  expires?: string;
  /** Whether the partner has connected; collapses the block to a one-liner. */
  connected: boolean;
  // tabIndex + ref so the exchange screen can move focus to the share heading on
  // mount, taking a keyboard/screen-reader user who pressed Generate to the new
  // screen rather than leaving focus on the unmounted compose button.
  headingRef?: Ref<HTMLHeadingElement>;
  // tabIndex + ref on the collapsed "Partner connected" indicator so the exchange
  // screen can recover focus onto it when the block collapses out from under a
  // keyboard/screen-reader user (see ExchangeView's peer-connect focus effect).
  connectedRef?: Ref<HTMLDivElement>;
}) {
  if (connected) {
    return (
      <Group gap="xs" ref={connectedRef} tabIndex={-1}>
        <IconCheck size={18} aria-hidden />
        <Text fw={500}>Partner connected</Text>
      </Group>
    );
  }
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
