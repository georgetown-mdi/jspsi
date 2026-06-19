import { Container } from "@mantine/core";
import { Link } from "@tanstack/react-router";

import classes from "./Shell.module.css";

import type { ReactNode } from "react";

/** The id shared by the skip link's target and the `<main>` landmark, declared
 * once so the two cannot drift apart. */
const MAIN_CONTENT_ID = "main-content";

/**
 * The application shell shared by every route: a "skip to content" link, a
 * banner header whose product wordmark links home, and the single `<main>`
 * landmark routes render their page into. Mounted once in the root route around
 * the router `Outlet`, so each route supplies only its own page content and its
 * own single `<h1>`.
 *
 * Built as a plain layout rather than Mantine's AppShell, whose responsive
 * navbar/aside machinery is unneeded for a single header link; revisit that
 * choice if the planned IA restructure adds real navigation or nested layouts.
 */
export function Shell({ children }: { children: ReactNode }) {
  return (
    // position: relative (in the stylesheet) anchors the absolutely positioned
    // skip link's containing block here rather than to an arbitrary ancestor.
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
    </div>
  );
}
