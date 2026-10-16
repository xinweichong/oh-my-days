/**
 * The logo and the tide lines, drawn inline so they follow Telegram's theme
 * without extra requests (ADR 0007). The mark's paths are the approved file's
 * (docs/identity/logo/oh-my-days-mark.svg); in dark themes the horizon takes the
 * reversed file's white. The sun never moves.
 */

const SVG = "http://www.w3.org/2000/svg";

function svg(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

/** The mark, cropped to its drawing so spacing beside it is exact. Decorative by default. */
export function mark(className = "mark", label?: string): SVGElement {
  const root = svg("svg", {
    class: className,
    viewBox: "7 19 50 27",
    ...(label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" }),
  });
  root.append(
    svg("path", { d: "M17 34a15 15 0 0 1 30 0z", class: "mark-sun" }),
    svg("path", { d: "M10 43H54", class: "mark-horizon" }),
  );
  return root;
}

/** Faint contour lines; the page's CSS decides whether they drift (All clear only). */
export function tideLines(
  className: string,
  paths: readonly string[],
  viewBox: string,
): SVGElement {
  const root = svg("svg", {
    class: `tide-lines ${className}`,
    viewBox,
    preserveAspectRatio: "xMinYMin slice",
    "aria-hidden": "true",
  });
  const group = svg("g", {});
  for (const d of paths) group.append(svg("path", { d }));
  root.append(group);
  return root;
}

/** Behind Home's heading, on its right where the title doesn't reach. */
export const HOME_LINES = [
  "M150 30 C 210 10, 260 60, 320 34 S 380 20, 400 40",
  "M130 54 C 200 34, 256 86, 322 58 S 384 44, 400 64",
  "M118 80 C 196 60, 254 112, 324 84 S 386 70, 400 90",
  "M110 108 C 194 88, 256 138, 328 112 S 388 98, 400 118",
  "M108 138 C 196 118, 260 166, 332 142 S 390 128, 400 148",
] as const;

/** Across the middle of the All clear screen, wider than the view so they can drift. */
export const CLEAR_LINES = [
  "M-20 300 C 80 260, 180 340, 280 300 S 460 260, 540 300",
  "M-20 330 C 90 292, 190 368, 290 330 S 466 292, 540 330",
  "M-20 362 C 100 326, 200 398, 300 362 S 470 326, 540 362",
  "M-20 396 C 110 362, 210 430, 310 396 S 476 362, 540 396",
  "M-20 432 C 118 400, 218 464, 318 432 S 480 400, 540 432",
  "M-20 470 C 126 440, 226 500, 326 470 S 486 440, 540 470",
  "M-20 510 C 134 482, 234 538, 334 510 S 490 482, 540 510",
] as const;
