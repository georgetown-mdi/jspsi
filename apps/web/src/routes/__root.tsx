/// <reference types="vite/client" />
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  useMatches,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import "@mantine/core/styles.css";
import "@mantine/dropzone/styles.css";
import {
  ColorSchemeScript,
  MantineProvider,
  mantineHtmlProps,
} from "@mantine/core";

import { cssVariablesResolver, mantineTheme } from "@theme";
import { DefaultCatchBoundary } from "@components/DefaultCatchBoundary";
import { NotFound } from "@components/NotFound";
import { Shell } from "@components/Shell";
import { resolveChrome } from "@components/chrome";
import { resolveContentWidth } from "@components/contentWidth";
import { seo } from "@utils/seo";

import type { ReactNode } from "react";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      ...seo({
        title: "Secure Online PSI",
        description:
          "Conduct a data sharing session using a private-set-intersection protocol over a peer-to-peer connection.",
      }),
    ],
    links: [
      {
        rel: "apple-touch-icon",
        sizes: "180x180",
        href: "/apple-touch-icon.png",
      },
      {
        rel: "icon",
        type: "image/png",
        sizes: "32x32",
        href: "/favicon-32x32.png",
      },
      {
        rel: "icon",
        type: "image/png",
        sizes: "16x16",
        href: "/favicon-16x16.png",
      },
      { rel: "manifest", href: "/site.webmanifest" },
      { rel: "icon", href: "/favicon.ico" },
    ],
  }),
  errorComponent: DefaultCatchBoundary,
  notFoundComponent: () => <NotFound />,
  component: RootComponent,
});

function RootComponent() {
  // Read the active route's declared content width here, above the shell, so the
  // shell can size the content column from one value (the route cannot pass it up
  // from inside the Outlet). select returns a primitive, so the root re-renders
  // only when the resolved width actually changes. The chrome seam works the same
  // way: bench routes bring their own page surface and landmarks, so wrapping
  // them in the legacy Shell would nest two <main> elements.
  const contentWidth = useMatches({ select: resolveContentWidth });
  const chrome = useMatches({ select: resolveChrome });
  return (
    <RootDocument>
      {chrome === "bench" ? (
        <Outlet />
      ) : (
        <Shell contentWidth={contentWidth}>
          <Outlet />
        </Shell>
      )}
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <HeadContent />
        <ColorSchemeScript />
      </head>
      <body>
        <MantineProvider
          theme={mantineTheme}
          cssVariablesResolver={cssVariablesResolver}
        >
          {children}
          <TanStackRouterDevtools position="bottom-right" />
          <Scripts />
        </MantineProvider>
      </body>
    </html>
  );
}
