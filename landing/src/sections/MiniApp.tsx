import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import home from "../assets/screens/home.webp";
import listDark from "../assets/screens/list-dark.webp";
import overdue from "../assets/screens/overdue.webp";
import snooze from "../assets/screens/snooze.webp";
import { MINI_APP_SCREENS } from "../content";
import { EASE_OUT } from "../lib/ease";
import { Tab, Tabs, TabsList, TabsPanel } from "../vendor/beui/Tabs";

const SOURCES: Record<(typeof MINI_APP_SCREENS)[number]["id"], string> = {
  home,
  overdue,
  list: listDark,
  snooze,
};

const POINTS = [
  {
    title: "What's next, at a glance.",
    body: "The next event or deadline, then Today, Overdue, This week and No deadline with their counts.",
  },
  {
    title: "One tap to complete.",
    body: "The check fills, Undo appears for a moment, and the ✓ shows in Google Calendar.",
  },
  {
    title: "Swipe to snooze.",
    body: "Snoozing moves reminders only. Deadlines stay where they are.",
  },
];

export function MiniApp() {
  const [screen, setScreen] = useState<string>("home");
  const reduce = useReducedMotion();
  const current = MINI_APP_SCREENS.find((s) => s.id === screen) ?? MINI_APP_SCREENS[0];
  return (
    <section aria-labelledby="app-title" className="border-t border-line bg-sunk">
      <div className="mx-auto grid max-w-[76rem] items-center gap-12 px-4 py-20 sm:px-6 md:grid-cols-12 md:gap-8 md:px-8 md:py-28">
        <div className="md:col-span-6 lg:col-span-5">
          <h2
            id="app-title"
            className="font-display text-4xl leading-[1.05] font-semibold tracking-[-0.025em] text-ink md:text-5xl"
          >
            Your tasks, one tap from the chat.
          </h2>
          <p className="mt-4 max-w-[40ch] text-lg leading-7 text-muted">
            The Mini App opens inside Telegram, from the agenda or the button under the message box.
            It follows your Telegram theme.
          </p>
          <dl className="mt-10 flex flex-col">
            {POINTS.map((p) => (
              <div key={p.title} className="border-t border-line py-4">
                <dt className="text-[17px] font-semibold text-ink">{p.title}</dt>
                <dd className="mt-1 text-base leading-6 text-muted">{p.body}</dd>
              </div>
            ))}
          </dl>
        </div>
        <Tabs
          value={screen}
          onValueChange={setScreen}
          className="flex flex-col items-center gap-6 md:col-span-6 lg:col-span-6 lg:col-start-7"
        >
          <TabsPanel>
            <figure className="flex flex-col items-center">
              <div className="relative aspect-[390/844] h-[min(68svh,40rem)] rounded-[2.6rem] border border-line bg-raised p-2 shadow-lift">
                <div className="relative h-full w-full overflow-hidden rounded-[2.1rem] bg-sunk">
                  <AnimatePresence initial={false} mode="popLayout">
                    <motion.img
                      key={current.id}
                      src={SOURCES[current.id]}
                      alt={current.alt}
                      width={780}
                      height={1688}
                      loading="lazy"
                      decoding="async"
                      initial={reduce ? false : { opacity: 0, scale: 1.02, filter: "blur(6px)" }}
                      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                      exit={reduce ? { opacity: 0 } : { opacity: 0, transition: { duration: 0.2 } }}
                      transition={{ duration: 0.45, ease: EASE_OUT }}
                      className="absolute inset-0 h-full w-full object-cover object-top"
                    />
                  </AnimatePresence>
                </div>
              </div>
              <figcaption className="mt-3 text-[13px] text-muted">
                Screens from the Mini App · demo data
              </figcaption>
            </figure>
          </TabsPanel>
          <TabsList label="Mini App screens">
            {MINI_APP_SCREENS.map((s) => (
              <Tab key={s.id} value={s.id}>
                {s.label}
              </Tab>
            ))}
          </TabsList>
        </Tabs>
      </div>
    </section>
  );
}
