import { Box, Container } from "@mantine/core";

import { DEFAULT_CONTENT_WIDTH } from "@components/contentWidth";

import type { ContainerWidth } from "@theme";
import type { ReactNode } from "react";

/**
 * The application shell shared by every route: the single `<main>` landmark each
 * route renders its page into, sized to the route's declared content width.
 * Mounted once in the root route around the router `Outlet`, so each route supplies
 * only its own page content and its own single `<h1>`.
 *
 * `contentWidth` is the one value a route declares (see {@link resolveContentWidth});
 * the shell sizes the content column to it, so a route can run wide or narrow to a
 * single legible column without picking its own `Container`.
 *
 * Deliberately a bare `<main>` + container -- no banner, product wordmark, or
 * navigation chrome, and so no "skip to content" link (a skip link only earns its
 * place bypassing repeated blocks, and there are none here). This is a small
 * multi-route flow with no cross-page navigation; revisit if a real IA with
 * navigation lands, at which point a header and its skip link would come back
 * together.
 */
export function Shell({
  children,
  contentWidth = DEFAULT_CONTENT_WIDTH,
}: {
  children: ReactNode;
  contentWidth?: ContainerWidth;
}) {
  // The landmark stays full-width (the vertical padding lives on it); the container
  // inside sizes the content to contentWidth.
  return (
    <Box component="main" py="lg">
      <Container size={contentWidth}>{children}</Container>
    </Box>
  );
}
