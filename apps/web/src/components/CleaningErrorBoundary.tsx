import { Component, createRef } from "react";

import { Alert, Button, Stack, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

import { whenDiagnostic } from "@utils/diagnostics";

import type { ErrorInfo, ReactNode, RefObject } from "react";

type FallbackRef = RefObject<HTMLDivElement | null>;

type BoundaryProps = {
  children: ReactNode;
  fallback: (reset: () => void, ref: FallbackRef) => ReactNode;
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
 *
 * A caught error unmounts the subtree that held keyboard focus, so the boundary
 * steers focus across each swap: to the fallback region when it appears, and to the
 * recovered children when it clears, so focus is never left on a removed node.
 */
class Boundary extends Component<BoundaryProps, { errored: boolean }> {
  state = { errored: false };
  private readonly fallbackRef: FallbackRef = createRef();
  private readonly childrenRef = createRef<HTMLDivElement>();
  // Whether the current fallback appearance has already claimed focus. A caught
  // error derives `errored` within the failing render itself, so there is no
  // separate errored=false -> true commit to detect; this instead marks a fresh
  // fallback so its focus fires once, and clears on recovery for the next catch.
  private fallbackFocused = false;
  private focusTimer: ReturnType<typeof setTimeout> | undefined;

  static getDerivedStateFromError(): { errored: boolean } {
    return { errored: true };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    this.props.onCatch(error);
  }

  componentDidMount(): void {
    this.steerFocus();
  }

  componentDidUpdate(prev: BoundaryProps): void {
    // The prepared data changed (a remap / edit / reset), so retry the children.
    if (this.state.errored && prev.resetKey !== this.props.resetKey)
      this.reset();
    this.steerFocus();
  }

  componentWillUnmount(): void {
    clearTimeout(this.focusTimer);
  }

  // Focus is deferred a task past the commit rather than set here directly:
  // unmounting the focused child blurs focus to <body> as the DOM mutates, and that
  // blur lands after this lifecycle, so a synchronous focus is immediately undone.
  private steerFocus(): void {
    if (this.state.errored === this.fallbackFocused) return;
    this.fallbackFocused = this.state.errored;
    const target = this.state.errored ? this.fallbackRef : this.childrenRef;
    clearTimeout(this.focusTimer);
    this.focusTimer = setTimeout(() => target.current?.focus());
  }

  reset = (): void => {
    this.setState({ errored: false });
  };

  render(): ReactNode {
    return this.state.errored ? (
      this.props.fallback(this.reset, this.fallbackRef)
    ) : (
      <div ref={this.childrenRef} tabIndex={-1}>
        {this.props.children}
      </div>
    );
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
      fallback={(reset, ref) => (
        <Alert
          ref={ref}
          tabIndex={-1}
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
