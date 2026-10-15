import { AGENDA, REMINDER, SNOOZED, thought } from "../content";
import { usePhases } from "../lib/usePhases";
import { useTypewriter } from "../vendor/kokonut/useTypewriter";
import { Bubble, DayLabel, TypingDots } from "./Chat";

// The scripted walkthrough shared by the desktop stage and the phone stack.
// Each step plays a few phases; the elements below are what each phase shows.

export type Status = "idle" | "active" | "done";

/** Phase timings per step, in ms between phases. */
const SCRIPTS = [
  // event: highlight and type, send, bot typing, reply, lands in Calendar
  [350, 1500, 450, 850, 500],
  // task: same shape
  [350, 1650, 450, 850, 500],
  // 8am agenda: day changes, bot typing, agenda, today lit
  [300, 800, 900, 400],
  // reminder: arrives, Snooze pressed, choices, Tomorrow pressed, reply, reminder moves
  [350, 1100, 450, 900, 450, 600],
] as const;

export const FINAL_PHASE = SCRIPTS.map((s) => s.length);

export interface StepView {
  phase: number;
  /** Chat elements this step contributes, in order. */
  messages: React.ReactNode[];
  /** Composer text while typing. */
  composer: { text: string; busy: boolean };
}

const CAPTURES = [thought("dentist"), thought("invoice")] as const;
const CAPTURE_TIMES = ["9:12pm", "9:14pm"];

export function useStep(index: number, status: Status, withDayLabels: boolean): StepView {
  const script = SCRIPTS[index] ?? [];
  const phase = usePhases(script, status === "active", status === "done");
  const capture = index < 2 ? CAPTURES[index as 0 | 1] : undefined;
  const typed = useTypewriter(capture?.message ?? "", {
    active: capture !== undefined && phase === 1,
    complete: phase >= 2,
    seed: index + 3,
  });
  const messages: React.ReactNode[] = [];
  const time = CAPTURE_TIMES[index] ?? "";

  if (capture) {
    if (index === 0 && withDayLabels && phase >= 2)
      messages.push(<DayLabel key="wed">Wednesday 21 October</DayLabel>);
    if (phase >= 2)
      messages.push(
        <Bubble key={`${capture.id}-me`} from="me" time={time}>
          {capture.message}
        </Bubble>,
      );
    if (phase === 3) messages.push(<TypingDots key={`${capture.id}-typing`} />);
    if (phase >= 4)
      messages.push(
        <Bubble key={`${capture.id}-bot`} from="bot" time={time} buttons={[["Undo"]]}>
          {capture.reply}
        </Bubble>,
      );
    return {
      phase,
      messages,
      composer: { text: phase === 1 ? typed.shown : "", busy: typed.busy },
    };
  }

  if (index === 2) {
    if (withDayLabels && phase >= 1)
      messages.push(<DayLabel key="fri">Friday 23 October</DayLabel>);
    if (phase === 2) messages.push(<TypingDots key="agenda-typing" />);
    if (phase >= 3)
      messages.push(
        <Bubble
          key="agenda"
          from="bot"
          time="8:00am"
          buttons={[["View tasks", "View week"], ["Open app"]]}
        >
          {AGENDA}
        </Bubble>,
      );
    return { phase, messages, composer: { text: "", busy: false } };
  }

  // The reminder and its snooze.
  if (phase >= 1) {
    const choices = phase >= 3;
    messages.push(
      <Bubble
        key="reminder"
        from="bot"
        time="2:00pm"
        buttons={
          choices ? [["In 1 hour", "Tomorrow at 8am"], ["Choose date/time"]] : [["Done", "Snooze"]]
        }
        pressed={phase === 2 ? "Snooze" : phase === 4 ? "Tomorrow at 8am" : null}
      >
        {REMINDER}
      </Bubble>,
    );
  }
  if (phase >= 5)
    messages.push(
      <Bubble key="snoozed" from="bot" time="2:01pm">
        {SNOOZED}
      </Bubble>,
    );
  return { phase, messages, composer: { text: "", busy: false } };
}
