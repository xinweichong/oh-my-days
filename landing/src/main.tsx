import { hydrateRoot } from "react-dom/client";
import { App } from "./App";

// The page arrives prerendered (scripts/build-landing.mjs); this brings its motion to life.
const root = document.getElementById("root");
if (root) hydrateRoot(root, <App />);
