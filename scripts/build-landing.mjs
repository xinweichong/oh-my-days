// Builds the landing page (landing/src) into landing/dist, which the Worker
// serves as static assets at / (ADR 0006): the page prerendered to HTML, the
// script that brings its motion to life, Tailwind CSS, the Figtree display face,
// and images, all with content-hashed names. Run by `npm run check` and the
// Wrangler build.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compile, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { build } from "esbuild";

const SRC = path.resolve("landing/src");
const OUT = path.resolve("landing/dist");
const ASSETS = path.join(OUT, "_landing");
const PUBLIC = "/_landing/";
const PRERENDER = path.resolve("node_modules/.landing-prerender");
const LOGO = path.resolve("docs/identity/logo");

const site = await siteConfig();
await rm(OUT, { recursive: true, force: true });
await mkdir(ASSETS, { recursive: true });

/** Copies a file into the assets folder under a content-hashed name; returns its URL. */
async function emit(source, name) {
  const bytes = await readFile(source);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 10);
  const ext = path.extname(source);
  const file = `${name}-${hash}${ext}`;
  await writeFile(path.join(ASSETS, file), bytes);
  return `${PUBLIC}${file}`;
}

// Inline SVG logos lose their <style> and <title>: inside an HTML page an SVG
// stylesheet applies to the whole document, and the page names the logo itself.
const inlineSvg = {
  name: "inline-svg",
  setup(b) {
    b.onLoad({ filter: /\.svg$/ }, async (args) => {
      const text = await readFile(args.path, "utf8");
      const body = text
        .replace(/<\?xml[^>]*>/, "")
        .replace(/<title>[\s\S]*?<\/title>/, "")
        .replace(/<style>[\s\S]*?<\/style>/, "")
        .replace(/\s+role="img"/, "")
        .trim();
      return { contents: `export default ${JSON.stringify(body)};`, loader: "js" };
    });
  },
};

const shared = {
  bundle: true,
  jsx: "automatic",
  define: {
    "process.env.NODE_ENV": '"production"',
    __BOT_USERNAME__: JSON.stringify(site.bot),
  },
  loader: { ".webp": "file" },
  assetNames: "[name]-[hash]",
  publicPath: PUBLIC,
  plugins: [inlineSvg],
  logLevel: "warning",
};

const client = await build({
  ...shared,
  entryPoints: [path.join(SRC, "main.tsx")],
  outdir: ASSETS,
  entryNames: "app-[hash]",
  format: "esm",
  target: "es2022",
  minify: true,
  legalComments: "none",
  metafile: true,
});
const script = Object.keys(client.metafile.outputs).find((f) => /app-[^/]+\.js$/.test(f));
if (!script) throw new Error("The landing client bundle was not written");

// The same modules, built for Node, render the page once here.
await build({
  ...shared,
  entryPoints: [path.join(SRC, "prerender.tsx")],
  outdir: PRERENDER,
  platform: "node",
  format: "esm",
  packages: "external",
});
const { render } = await import(
  `${pathToFileURL(path.join(PRERENDER, "prerender.js")).href}?${Date.now()}`
);
const body = render();
await rm(PRERENDER, { recursive: true, force: true });

const figtree = await emit(
  "node_modules/@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2",
  "figtree",
);
const compiler = await compile(
  (await readFile(path.join(SRC, "styles.css"), "utf8")).replaceAll("__FIGTREE__", figtree),
  { base: SRC, onDependency() {} },
);
const sources = [
  ...(compiler.root === "none"
    ? []
    : compiler.root === null
      ? [{ base: SRC, pattern: "**/*", negated: false }]
      : [{ ...compiler.root, negated: false }]),
  ...compiler.sources,
];
const css = optimize(compiler.build(new Scanner({ sources }).scan()), { minify: true }).code;
const cssHash = createHash("sha256").update(css).digest("hex").slice(0, 10);
await writeFile(path.join(ASSETS, `app-${cssHash}.css`), css);

const icon = await emit(path.join(LOGO, "oh-my-days-mark.svg"), "mark");
const touchIcon = await emit(path.join(LOGO, "oh-my-days-avatar-512.png"), "avatar");
const banner = await emit(path.join(LOGO, "oh-my-days-banner.png"), "banner");

const title = "Oh My Days · A little less to keep in your head";
const description =
  "Events, tasks and reminders in Telegram, connected to Google Calendar. Type a message; it lands in your calendar.";
const absolute = (url) => (site.origin ? `${site.origin}${url}` : url);
const html = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${description}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1615" media="(prefers-color-scheme: dark)">
<link rel="icon" href="${icon}" type="image/svg+xml">
<link rel="apple-touch-icon" href="${touchIcon}">
<link rel="preload" href="${figtree}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${PUBLIC}app-${cssHash}.css">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Oh My Days">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${absolute(banner)}">
${site.origin ? `<meta property="og:url" content="${site.origin}/">\n<link rel="canonical" href="${site.origin}/">\n` : ""}<meta name="twitter:card" content="summary_large_image">
<script type="module" src="${PUBLIC}${path.basename(script)}"></script>
</head>
<body>
<div id="root">${body}</div>
</body>
</html>
`;

// The page must keep what Google's OAuth review and visitors rely on.
const required = ['href="/privacy"', `https://t.me/${site.bot}`, "Oh My Days", "Google Calendar"];
for (const text of required) {
  if (!html.includes(text)) throw new Error(`The landing page lost ${text}`);
}
const allowedHosts = new Set(["t.me", "myaccount.google.com", "developers.google.com"]);
if (site.origin) allowedHosts.add(new URL(site.origin).host);
for (const [, url] of html.matchAll(/(?:href|src|content)="(https?:\/\/[^"]+)"/g)) {
  const { host } = new URL(url);
  if (!allowedHosts.has(host)) throw new Error(`The landing page links to ${host}`);
}
await writeFile(path.join(OUT, "index.html"), html);

// Static asset headers (Workers Static Assets reads _headers). The page runs
// only its own script; it fetches nothing, so connect-src stays closed.
await writeFile(
  path.join(OUT, "_headers"),
  `/
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Cache-Control: public, max-age=0, must-revalidate
/_landing/*
  Cache-Control: public, max-age=31536000, immutable
  X-Content-Type-Options: nosniff
`,
);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(
  `Landing page: html ${kb(html.length)}, js ${kb(client.metafile.outputs[script].bytes)}, css ${kb(css.length)} (bot @${site.bot}${site.origin ? `, ${site.origin}` : ""})`,
);

/**
 * The bot username and public origin are production values, kept out of the
 * repository: they come from wrangler.production.local.json when it exists (as
 * for a deploy), else from .dev.vars (local development), else synthetic test
 * values (CI, which never deploys).
 */
async function siteConfig() {
  if (existsSync("wrangler.production.local.json")) {
    const local = JSON.parse(await readFile("wrangler.production.local.json", "utf8"));
    const bot = local.vars?.TELEGRAM_BOT_USERNAME;
    if (typeof bot === "string" && bot) {
      return { bot, origin: originOf(local.vars?.PUBLIC_BASE_URL) };
    }
  }
  if (existsSync(".dev.vars")) {
    const vars = Object.fromEntries(
      (await readFile(".dev.vars", "utf8"))
        .split("\n")
        .map((line) => /^\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line))
        .filter(Boolean)
        .map((m) => [m[1], m[2]]),
    );
    if (vars.TELEGRAM_BOT_USERNAME) return { bot: vars.TELEGRAM_BOT_USERNAME, origin: null };
  }
  return { bot: "omd_test_bot", origin: null };
}

function originOf(url) {
  if (typeof url !== "string") return null;
  try {
    const { origin, protocol } = new URL(url);
    return protocol === "https:" ? origin : null;
  } catch {
    return null;
  }
}
