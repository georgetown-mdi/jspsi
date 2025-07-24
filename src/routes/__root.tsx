/// <reference types="vite/client" />
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'
import type { ReactNode } from 'react';

import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'

import {
  ColorSchemeScript,
  MantineProvider,
  mantineHtmlProps
} from '@mantine/core';
import '@mantine/core/styles.css';
import '@mantine/dropzone/styles.css';

import { seo } from '../utils/seo';
import { DefaultCatchBoundary } from '../components/DefaultCatchBoundary';
import { NotFound } from '../components/NotFound';

import { mantineTheme } from '../theme'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      ...seo({
        title: 'Secure Online PSI',
        description: 'Conduct a data sharing session using a private-set-intersection protocol over a peer-to-peer connection.'
      }),
    ],
  }),
  errorComponent: DefaultCatchBoundary,
  notFoundComponent: () => <NotFound />,
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
      <TanStackRouterDevtools />
    </RootDocument>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html {...mantineHtmlProps}>
      <head>
        <HeadContent />
        <ColorSchemeScript />
      </head>
      <body>
        <MantineProvider theme={mantineTheme}>
          {children}
          <Scripts />
        </MantineProvider>
      </body>
    </html>
  )
}
