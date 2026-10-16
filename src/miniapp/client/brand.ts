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
