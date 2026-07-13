import { Component } from "react";

import { Alert, Button, Stack, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

import { whenDiagnostic } from "@utils/diagnostics";

import type { ErrorInfo, ReactNode } from "react";

type BoundaryProps = {
  children: ReactNode;
  fallback: (reset: () => void) => ReactNode;
  onCatch: (error: unknown) => void;
  resetKey: string;
};

/**
 * The internal React error boundary -- a class, as the boundary API requires, and
 * deliberately self-contained (not the router's `CatchBoundary`) so the cleaning
 * section's resilience does not depend on the router or its dep pre-bundling. It
 * renders the fallback on a caught render error and re-renders the children once the
 * {@link resetKey} changes (an edit / remap / reset to the prepared data) or the
 * fallback's reset fires.
 */
class Boundary extends Component<BoundaryProps, { errored: boolean }> {
  state = { errored: false };

  static getDerivedStateFromError(): { errored: boolean } {
    return { errored: true };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    this.props.onCatch(error);
  }

  componentDidUpdate(prev: BoundaryProps): void {
    // The prepared data changed (a remap / edit / reset), so retry the children.
    if (this.state.errored && prev.resetKey !== this.props.resetKey)
      this.reset();
  }

  reset = (): void => {
    this.setState({ errored: false });
  };

  render(): ReactNode {
    return this.state.errored
      ? this.props.fallback(this.reset)
      : this.props.children;
  }
}

/**
 * A local error boundary around a data-prep cleaning section. StandardizationCards
 * asserts a structural invariant as a runtime check -- on the acceptor every
 * standardization output resolves to a declared linkage field (its
 * `onMissingField="throw"` arm). The check is correct, but were a future regression
 * to trip it the throw would otherwise unwind past the editor to the route-level
 * DefaultCatchBoundary, tearing down the whole page; that boundary's only recovery
 * (reload / go back) would discard the operator's consent and parsed file. This
 * contains the failure to the cleaning section and offers an in-place reset -- also
 * the most likely fix, since it clears the per-field overrides back to the
 * recommended pipeline.
 *
 * {@link resetKey} signs each field's input binding -- the only input to the
 * missing-field invariant -- so a remap auto-clears the boundary. The button
 * also resets it directly, so a click always retries even
 * if the signature is unchanged. The acceptor's thrown message names no
 * partner-controlled value, but the dev-gated `onCatch` log mirrors
 * DefaultCatchBoundary so an unforeseen error carrying partner bytes never reaches a
 * production console.
 */
export function CleaningErrorBoundary({
  children,
  onReset,
  resetKey,
}: {
  children: ReactNode;
  /** Restore the cleaning to its recommended state (the host's reset). */
  onReset: () => void;
  /** A value that changes when a field's input binding changes (the input to the
   * invariant the boundary guards), so it auto-recovers once a remap fixes it. */
  resetKey: string;
}) {
  return (
    <Boundary
      resetKey={resetKey}
      onCatch={(error) =>
        whenDiagnostic(() =>
          console.error("Cleaning section boundary caught:", error),
        )
      }
      fallback={(reset) => (
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertTriangle aria-hidden />}
          title="The cleaning editor hit an unexpected state"
        >
          <Stack gap="sm" align="flex-start">
            <Text size="sm">
              Resetting your field cleaning to the default steps should restore
              it. Your file and consent are unaffected.
            </Text>
            <Button
              size="xs"
              onClick={() => {
                onReset();
                reset();
              }}
            >
              Reset to defaults
            </Button>
          </Stack>
        </Alert>
      )}
    >
      {children}
    </Boundary>
  );
}
