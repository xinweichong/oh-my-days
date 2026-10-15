declare module "*.webp" {
  const url: string;
  export default url;
}

/** Logo SVGs, inlined by scripts/build-landing.mjs without their <style> and <title>. */
declare module "*.svg" {
  const markup: string;
  export default markup;
}

/** The bot's username, set at build time from local configuration. */
declare const __BOT_USERNAME__: string;
