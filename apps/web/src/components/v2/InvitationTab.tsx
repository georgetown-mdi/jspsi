import { useState } from "react";

import {
  ActionIcon,
  Alert,
  Button,
  Code,
  CopyButton,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useForm } from "@tanstack/react-form";

import { generateInvitation } from "@psi/invitation";

import type { GeneratedInvitation, InvitationLocation } from "@psi/invitation";

/** This page's location, in the shape {@link generateInvitation} consumes. Read
 * only inside the submit handler (client-side), never during render, so it is
 * safe under SSR. */
function invitationLocation(): InvitationLocation {
  return {
    origin: window.location.origin,
    hostname: window.location.hostname,
    port: window.location.port,
  };
}

/** A labelled, copy-to-clipboard view of one shareable artifact. It reads
 * `navigator` at render, so it is kept off the server-rendered tree by the
 * `invitation` state guard at its only call site below: `invitation` starts
 * `undefined`, so the `{invitation && ...}` branch that renders CopyRow does not
 * run during SSR. */
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
          navigator.clipboard ? (
            <CopyButton value={value} timeout={1000}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? "Copied" : "Copy to clipboard"}>
                  <ActionIcon
                    onClick={copy}
                    variant={copied ? "light" : "filled"}
                    aria-label={`Copy ${label.toLowerCase()}`}
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

export function InvitationTab() {
  const [invitation, setInvitation] = useState<GeneratedInvitation>();
  const [error, setError] = useState<string>();

  const form = useForm({
    defaultValues: { inviterName: "" },
    onSubmit: async ({ value }) => {
      setError(undefined);
      try {
        // A fresh secret each time, so generating again supersedes any prior
        // unsent invitation -- a new secret means a new derived rendezvous id,
        // and one invitation is not expected to back more than one exchange.
        setInvitation(
          await generateInvitation({
            inviterName: value.inviterName.trim(),
            location: invitationLocation(),
          }),
        );
      } catch (e) {
        setInvitation(undefined);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
  });

  return (
    <Paper>
      <Text size="md">Invite someone to join you in a data exchange</Text>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <Stack>
          <form.Field
            name="inviterName"
            validators={{
              onChange: ({ value }) =>
                !value.trim() ? "Your name is required" : undefined,
            }}
            children={({ state, handleChange, handleBlur }) => (
              <TextInput
                value={state.value}
                onChange={(e) => handleChange(e.target.value)}
                onBlur={handleBlur}
                error={
                  state.meta.errors.length > 0
                    ? state.meta.errors.join(", ")
                    : undefined
                }
                withAsterisk
                required
                label="Your name"
                description="Recorded in the invitation's linkage terms so your partner can identify you"
                placeholder="Your name"
              />
            )}
          />
          <Button type="submit">
            {invitation ? "Generate a new invitation" : "Generate invitation"}
          </Button>
        </Stack>
      </form>

      {error && (
        <Alert color="red" title="Could not generate invitation" mt="md">
          {error}
        </Alert>
      )}

      {invitation && (
        <Stack mt="md">
          <Title order={3}>Share this invitation</Title>
          <Text size="sm" c="dimmed">
            Send one of these to your partner over a trusted channel (for
            example, secure email). It carries a one-time secret, so treat it as
            confidential and do not post it publicly. Generating a new
            invitation replaces this one.
          </Text>
          <CopyRow
            label="Invitation link"
            description="Opens the accept page with the invitation prefilled"
            value={invitation.deepLink}
          />
          <CopyRow
            label="Invitation code"
            description="Paste into the accept form if the link cannot be used"
            value={invitation.encoded}
          />
        </Stack>
      )}
    </Paper>
  );
}
