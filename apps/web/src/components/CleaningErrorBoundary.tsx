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
 * The cleaning section's error boundary. A class, as the boundary API requires;
 * self-contained rather than the router's `CatchBoundary`, so cleaning resilience
 * does not depend on the router. Re-renders the children once {@link resetKey}
 * changes (an edit / remap / reset) or the fallback's reset fires.
 *
 * A caught error unmounts the subtree that held keyboard focus; this steers focus
 * to the fallback when it appears and to the recovered children once it clears.
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
 * A local error boundary around the data-prep cleaning section. Contains a throw
 * from the acceptor's missing-field invariant (StandardizationCards'
 * `onMissingField="throw"` arm) here rather than letting it reach the route-level
 * DefaultCatchBoundary, whose only recovery (reload / go back) would discard the
 * operator's consent and parsed file.
 *
 * {@link resetKey} is the field input binding signature: changing it auto-clears
 * the boundary, and the reset button also resets directly. The dev-gated
 * `onCatch` log mirrors DefaultCatchBoundary so an unforeseen error carrying
 * partner bytes never reaches a production console.
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
