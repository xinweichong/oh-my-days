import { TELEGRAM_URL } from "../content";
import { Lockup } from "./Brand";

export function Header() {
  return (
    // Opaque rather than frosted: a backdrop blur repaints whatever scrolls under it.
    <header className="sticky top-0 z-30 border-b border-line bg-surface">
      <div className="mx-auto flex h-16 max-w-[76rem] items-center justify-between gap-4 px-4 sm:px-6 md:px-8">
        <a href="/" className="-m-2 p-2" aria-label="Oh My Days, home">
          <Lockup className="h-8" />
        </a>
        <nav aria-label="Main" className="flex items-center gap-2 sm:gap-6">
          <a
            href="#how"
            className="hidden min-h-11 items-center text-[15px] text-muted hover:text-ink sm:inline-flex"
          >
            How it works
          </a>
          <a
            href="/privacy"
            className="hidden min-h-11 items-center text-[15px] text-muted hover:text-ink sm:inline-flex"
          >
            Privacy
          </a>
          <a
            href={TELEGRAM_URL}
            target="_blank"
            rel="noopener"
            className="inline-flex min-h-11 items-center rounded-lg bg-tide px-4 text-[15px] font-semibold text-on-tide transition-[filter] hover:brightness-110"
          >
            <span className="sm:hidden">Open</span>
            <span className="hidden sm:inline">Open in Telegram</span>
          </a>
        </nav>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-[76rem] flex-col gap-6 px-4 py-10 sm:px-6 md:flex-row md:items-center md:justify-between md:px-8">
        <div className="flex flex-col gap-2">
          <Lockup className="h-7" />
          <p className="text-sm text-muted">
            Events, tasks and reminders in Telegram, connected to Google Calendar.
          </p>
        </div>
        <nav aria-label="Footer" className="flex gap-6 text-sm">
          <a
            href="/privacy"
            className="inline-flex min-h-11 items-center text-muted hover:text-ink"
          >
            Privacy policy
          </a>
          <a
            href={TELEGRAM_URL}
            target="_blank"
            rel="noopener"
            className="inline-flex min-h-11 items-center text-muted hover:text-ink"
          >
            Telegram
          </a>
        </nav>
      </div>
    </footer>
  );
}
