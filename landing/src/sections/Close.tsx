import { TELEGRAM_URL } from "../content";
import { TopoBackground } from "../vendor/kokonut/TopoBackground";
import { Mark } from "./Brand";
import { PrimaryLink } from "./Links";

/** The close: the one tide-drenched band on the page, the sun still above the line. */
export function Close() {
  return (
    <section aria-labelledby="close-title" className="px-4 py-16 sm:px-6 md:px-8 md:py-24">
      <div className="relative mx-auto max-w-[76rem] overflow-hidden rounded-[28px] bg-[#0b6b62] px-6 py-14 text-white md:px-14 md:py-20">
        <div className="absolute inset-y-0 right-0 hidden w-[60%] text-white md:block">
          <TopoBackground seed={21} speed={0.5} />
        </div>
        <Mark reversed className="relative h-16 md:h-20" />
        <h2
          id="close-title"
          className="relative mt-6 max-w-[16ch] font-display text-4xl leading-[1.04] font-semibold tracking-[-0.025em] md:text-6xl"
        >
          Start with one message.
        </h2>
        <p className="relative mt-4 max-w-[40ch] text-lg leading-7 text-white/85">
          Open the bot, send /start, and connect Google Calendar. Oh My Days is by invitation.
        </p>
        <PrimaryLink href={TELEGRAM_URL} inverse className="relative mt-8">
          Open in Telegram
        </PrimaryLink>
      </div>
    </section>
  );
}
