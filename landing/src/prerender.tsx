import { renderToString } from "react-dom/server";
import { App } from "./App";

/** Build time only: the landing page as HTML for scripts/build-landing.mjs. */
export function render(): string {
  return renderToString(<App />);
}
