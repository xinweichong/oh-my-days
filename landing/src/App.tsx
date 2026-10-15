import { MotionConfig } from "motion/react";
import { LandingPage } from "./LandingPage";

/** Shared by the prerender and the browser, so both render the same tree. */
export function App() {
  return (
    <MotionConfig reducedMotion="user">
      <LandingPage />
    </MotionConfig>
  );
}
