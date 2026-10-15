import { Capture } from "./sections/Capture";
import { Careful } from "./sections/Careful";
import { Footer, Header } from "./sections/Chrome";
import { Clearing } from "./sections/Clearing";
import { Close } from "./sections/Close";
import { Hero } from "./sections/Hero";
import { MiniApp } from "./sections/MiniApp";
import { Setup } from "./sections/Setup";

// The public landing page at / (ADR 0006). The bot's own pages (/privacy,
// /connect, /app) are served by the Worker and link back here.
export function LandingPage() {
  return (
    <>
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-tide px-4 py-3 font-semibold text-on-tide focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <Header />
      <main id="main">
        <Hero />
        <Capture />
        <Clearing />
        <MiniApp />
        <Setup />
        <Careful />
        <Close />
      </main>
      <Footer />
    </>
  );
}
