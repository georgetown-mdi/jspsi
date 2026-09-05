import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { cssVariablesResolver, mantineTheme } from "@theme";

import type { ReactElement, ReactNode } from "react";
import type { MantineProviderProps } from "@mantine/core";
import type { Root } from "react-dom/client";

/**
 * Overrides a browser test may layer onto the app provider config. Only the
 * settings a test varies are exposed; anything else stays fixed at the
 * app root's configuration so a test cannot silently diverge from what ships.
 */
export interface RenderAppOptions {
  /**
   * Pin the rendered subtree to one color scheme, for a test asserting
   * scheme-specific behavior (e.g. the light-only resolver token overrides).
   * Left unset, the provider follows its default color-scheme resolution, as
   * the app root does.
   */
  forceColorScheme?: MantineProviderProps["forceColorScheme"];
}

/**
 * Wraps `node` in a `MantineProvider` configured exactly as the app root
 * (`routes/__root.tsx`) does -- `theme={mantineTheme}` plus
 * `cssVariablesResolver={cssVariablesResolver}`, both from `theme.ts`. A
 * component reading a resolver-overridden token (`dimmed`, `placeholder`, the
 * light-variant status text, `error`) then renders the app's real value, not
 * the Mantine default the app never ships.
 *
 * Returns the provider element rather than mounting it, so it composes into a
 * caller that owns its own root -- {@link createAppMount} for the common case,
 * or a bespoke `createRoot` where a test needs one.
 */
export function renderApp(
  node: ReactNode,
  options: RenderAppOptions = {},
): ReactElement {
  return createElement(
    MantineProvider,
    {
      theme: mantineTheme,
      cssVariablesResolver,
      ...(options.forceColorScheme !== undefined
        ? { forceColorScheme: options.forceColorScheme }
        : {}),
    },
    node,
  );
}

/**
 * The container and React root one browser test file renders the app into,
 * plus the lifecycle around them. Created once per file by
 * {@link createAppMount}; each instance owns its own state, so two mounts in
 * the same file never share a container.
 */
export interface AppMount {
  /**
   * The element the app is rendered into, for a query the `page` locators
   * cannot express (a `textContent` sweep, an attribute-shaped selector).
   * Reading it while nothing is mounted throws rather than yielding
   * `undefined`, so such a query fails loudly instead of vacuously.
   */
  readonly container: HTMLElement;
  /**
   * Renders `node` under the app provider config ({@link renderApp}). The
   * first call creates the container and root; a later call re-renders into
   * the same root, which is how a test drives a prop change the way the app
   * does.
   */
  render: (node: ReactNode, options?: RenderAppOptions) => void;
  /**
   * Unmounts the root and removes the container. Safe to call when nothing is
   * mounted, and leaves the mount ready to render again, so it composes into
   * an `afterEach` that runs whether or not the test mounted anything.
   */
  unmount: () => void;
}

/**
 * Creates the {@link AppMount} a browser test file mounts through.
 */
export function createAppMount(): AppMount {
  let container: HTMLElement | undefined;
  let root: Root | undefined;

  return {
    get container(): HTMLElement {
      if (container === undefined) {
        throw new Error("nothing is mounted: call render() first");
      }
      return container;
    },

    render(node: ReactNode, options: RenderAppOptions = {}): void {
      if (root === undefined) {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
      }
      root.render(renderApp(node, options));
    },

    unmount(): void {
      root?.unmount();
      container?.remove();
      root = undefined;
      container = undefined;
    },
  };
}

/**
 * Yields a macrotask so work React has already scheduled -- the state update
 * behind an in-flight fetch or async decode, a passive effect -- lands before
 * the caller continues. Its main use is ahead of an
 * {@link AppMount.unmount} in a teardown: a synchronous unmount that
 * interleaves with a render corrupts React's scheduler for the rest of the
 * file.
 */
export async function flushPendingUpdates(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
