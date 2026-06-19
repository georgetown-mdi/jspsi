import { Container, Text } from "@mantine/core";
import { Link } from "@tanstack/react-router";

import classes from "./Shell.module.css";

import type { ReactNode } from "react";

/** The id shared by the skip link's target and the `<main>` landmark, declared
 * once so the two cannot drift apart. */
const MAIN_CONTENT_ID = "main-content";

/**
 * The application shell shared by every route: a "skip to content" link, a
 * banner header whose product wordmark links home, the single `<main>` landmark
 * routes render their page into, and a footer. Mounted once in the root route
 * around the router `Outlet`, so each route supplies only its own page content
 * and its own single `<h1>`.
 *
 * The wrapper is a flex column at least the viewport tall with the main region
 * flexing to fill, so the footer rests at the bottom on short pages.
 */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className={classes.shell}>
      {/* First focusable element in the document, so a keyboard or screen-reader
          user can jump past the header straight to the page content. Visually
          hidden until focused (see Shell.module.css). The onClick moves focus to
          the main landmark in JS rather than letting the browser navigate to the
          fragment, because the accept route carries the invitation token in
          window.location.hash -- a default "#main-content" jump would overwrite
          it, breaking a reload or a copied link. The href is kept so the control
          is announced as a link. (The href is the fallback only before this
          handler is attached; an SPA is interactive post-hydration, which is the
          realistic production path.) */}
      <a
        href={`#${MAIN_CONTENT_ID}`}
        className={classes.skipLink}
        onClick={(event) => {
          event.preventDefault();
          document.getElementById(MAIN_CONTENT_ID)?.focus();
        }}
      >
        Skip to content
      </a>
      <header className={classes.header}>
        <Container size="xl">
          <Link to="/" className={classes.brand}>
            PSI-Link
          </Link>
        </Container>
      </header>
      {/* tabIndex -1 so the skip link can move focus into the landmark itself. */}
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className={classes.main}>
        {children}
      </main>
      <footer className={classes.footer}>
        <Container size="xl">
          <Text size="xs" c="dimmed">
            Invitations carry a one-time secret. Share them only over a channel
            you trust, and never post them publicly.
          </Text>
        </Container>
      </footer>
    </div>
  );
}
