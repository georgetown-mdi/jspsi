/**
 * The Dropzone drag-state icon colors, shared between the component that paints
 * them ({@link FileDropzone}) and the accessibility-contrast harness that proves
 * they clear WCAG 2.1 1.4.11 (`test/unit/themeContrast.test.ts`). One source so an
 * edit to the rendered shade is necessarily an edit to the asserted shade: a
 * hand-copied `theme.colors.blue[8]` in the test re-derived the shade the
 * component was *supposed* to use, so re-pointing the icon at an inaccessible
 * shade still passed. This is the lighter, single-source-of-truth counterpart to
 * the rendered-pixel pins in `test/browser/themeContrast.test.ts`; the icon color
 * is a literal here (a component-owned inline style), so a shared constant the
 * component consumes is enough -- no render needed to catch a regression.
 */

import type { MantineColorShade } from "@mantine/core";

/** A Mantine palette coordinate: a color name and a shade index (0-9). */
export type PaletteShade = readonly [name: string, shade: MantineColorShade];

/**
 * The accept/reject drag-state icon colors as Mantine palette coordinates, per
 * color scheme. The shade inverts with the scheme because the Dropzone's
 * light-variant drag-over tint does -- a light shade 8 on the light tint, a dark
 * shade 6 on the inverted dark tint -- so both branches are pinned (the
 * `light-dark()` {@link FileDropzone} renders selects per scheme). The shade
 * choices and their measured ratios are documented at the FileDropzone drag-icon
 * styles and enforced in `test/unit/themeContrast.test.ts`.
 */
export const DROPZONE_DRAG_ICON = {
  accept: { light: ["blue", 8], dark: ["blue", 6] },
  reject: { light: ["red", 8], dark: ["red", 6] },
} as const satisfies Record<
  "accept" | "reject",
  { light: PaletteShade; dark: PaletteShade }
>;

/** The CSS custom property naming a palette shade, e.g. `var(--mantine-color-blue-8)`. */
const paletteVar = ([name, shade]: PaletteShade) =>
  `var(--mantine-color-${name}-${shade})`;

/**
 * A `light-dark()` color selecting the scheme-appropriate drag-icon shade -- the
 * form {@link FileDropzone} sets as the icon's inline `color`, which its stroke
 * follows through `currentColor`.
 */
export const dragIconColor = (icon: {
  light: PaletteShade;
  dark: PaletteShade;
}): string => `light-dark(${paletteVar(icon.light)}, ${paletteVar(icon.dark)})`;
