import { CAREFUL, QUESTIONS } from "../content";
import { BouncyAccordion } from "../vendor/beui/BouncyAccordion";

export function Careful() {
  return (
    <section aria-labelledby="careful-title" className="border-t border-line bg-sunk">
      <div className="mx-auto max-w-[76rem] px-4 py-20 sm:px-6 md:px-8 md:py-28">
        <h2
          id="careful-title"
          className="max-w-[16ch] font-display text-4xl leading-[1.05] font-semibold tracking-[-0.025em] text-ink md:text-5xl"
        >
          Careful with your calendar.
        </h2>
        <dl className="mt-12 grid gap-x-12 md:grid-cols-2">
          {CAREFUL.map((c) => (
            <div key={c.title} className="border-t border-line-strong/40 py-6">
              <dt className="font-display text-xl font-semibold tracking-[-0.01em] text-ink">
                {c.title}
              </dt>
              <dd className="mt-2 max-w-[48ch] text-base leading-6 text-muted">{c.body}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-14 grid gap-8 md:grid-cols-12">
          <h3 className="font-display text-2xl font-semibold tracking-[-0.015em] text-ink md:col-span-4">
            Questions
          </h3>
          <div className="md:col-span-8">
            <BouncyAccordion items={QUESTIONS} className="divide-y divide-line" />
            <p className="mt-6 text-base text-muted">
              Everything stored, and why, is in the{" "}
              <a
                href="/privacy"
                className="font-medium text-tide underline decoration-tide/40 hover:decoration-tide"
              >
                privacy policy
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
