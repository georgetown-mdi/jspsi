import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";

import { Button, Center, Paper, Stack, Text, Textarea } from "@mantine/core";

/**
 * Peel the encoded invitation token out of what the user pasted. A deep-link URL
 * carries the token in its fragment (`<origin>/accept#<token>`), so everything
 * after the first `#` is the token; a bare code has no `#` and is used as-is.
 * Taking the fragment keeps the confidential token out of any query string, the
 * same reason the inviter places it in the fragment.
 */
function tokenFromInput(input: string): string {
  const trimmed = input.trim();
  const hash = trimmed.indexOf("#");
  return hash === -1 ? trimmed : trimmed.slice(hash + 1);
}

/**
 * Homepage accept form: takes either a bare encoded invitation or a pasted
 * deep-link URL and routes to the `/accept` consent page with the token in the
 * URL fragment -- the same destination the inviter's deep-link points at. The
 * decode, terms review, expiry enforcement, and rendezvous all live on `/accept`.
 */
export default function AcceptForm() {
  const navigate = useNavigate();

  const form = useForm({
    defaultValues: { invitation: "" },
    onSubmit: ({ value }) => {
      const token = tokenFromInput(value.invitation);
      if (!token) return;
      // The token rides in the fragment, never a search param, so this
      // confidential value is not sent to the server (matching the inviter's
      // deep-link). `/accept` reads it from `window.location.hash`.
      void navigate({ to: "/accept", hash: token });
    },
  });

  return (
    <Paper>
      <Text size="md">Accept an invitation you were sent</Text>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <Stack>
          <form.Field
            name="invitation"
            validators={{
              onChange: ({ value }) =>
                !tokenFromInput(value)
                  ? "An invitation is required"
                  : undefined,
            }}
            children={({ state, handleChange, handleBlur }) => (
              <Textarea
                value={state.value}
                onChange={(e) => handleChange(e.target.value)}
                onBlur={handleBlur}
                error={
                  (state.meta.isBlurred || form.state.submissionAttempts > 0) &&
                  state.meta.errors.length > 0
                    ? state.meta.errors.join(", ")
                    : undefined
                }
                errorProps={{ role: "alert" }}
                withAsterisk
                required
                autosize
                minRows={2}
                label="Invitation link or code"
                description="Paste the link or code your partner sent you"
                placeholder="https://...#... or the bare code"
              />
            )}
          />
          <Center>
            <Button type="submit">Review invitation</Button>
          </Center>
        </Stack>
      </form>
    </Paper>
  );
}
