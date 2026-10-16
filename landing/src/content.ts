// Everything the landing page says, in one place. Message wording follows the
// bot's real formats (src/application, src/jobs/reminders.ts); names, dates and
// tasks are synthetic.

export const TELEGRAM_URL = `https://t.me/${__BOT_USERNAME__}`;
export const TAGLINE = "A little less to keep in your head.";

export type CaptureKind = "event" | "task";

export interface Thought {
  id: string;
  /** As it sits in your head. */
  text: string;
  /** Position in the desktop field, in % of its box, and a slight tilt. */
  x: number;
  y: number;
  tilt: number;
  /** The message that captures it and the bot's reply. */
  message: string;
  reply: string;
  kind: CaptureKind;
}

export const THOUGHTS: Thought[] = [
  {
    id: "dentist",
    text: "dentist thu 10am?",
    x: 8,
    y: 12,
    tilt: -3,
    message: "Dentist Thu 10am",
    reply: "Event added: Dentist\nThu 22 Oct 2026, 10–11am · Personal",
    kind: "event",
  },
  {
    id: "invoice",
    text: "send the invoice by friday",
    x: 50,
    y: 6,
    tilt: 2,
    message: "Send invoice by Fri 3pm",
    reply: "Task added to Inbox: Send invoice.\nDue Fri 23 Oct, 3pm.",
    kind: "task",
  },
  {
    id: "rent",
    text: "rent's due on the 1st",
    x: 64,
    y: 30,
    tilt: -1.5,
    message: "Pay rent by 1 Nov",
    reply: "Task added to Home: Pay rent.\nDue Sun 1 Nov.",
    kind: "task",
  },
  {
    id: "plumber",
    text: "call the plumber back",
    x: 18,
    y: 34,
    tilt: 1.5,
    message: "Call the plumber",
    reply: "Task added to Inbox: Call the plumber.\nNo deadline.",
    kind: "task",
  },
  {
    id: "milk",
    text: "milk",
    x: 46,
    y: 50,
    tilt: -4,
    message: "Buy milk",
    reply: "Task added to Inbox: Buy milk.\nNo deadline.",
    kind: "task",
  },
  {
    id: "passport",
    text: "passport expires soon",
    x: 4,
    y: 58,
    tilt: 2.5,
    message: "Renew passport by 30 Nov",
    reply: "Task added to Inbox: Renew passport.\nDue Mon 30 Nov.",
    kind: "task",
  },
  {
    id: "haircut",
    text: "haircut sat morning",
    x: 66,
    y: 62,
    tilt: 1,
    message: "Haircut Sat 11am",
    reply: "Event added: Haircut\nSat 24 Oct 2026, 11am–12pm · Personal",
    kind: "event",
  },
  {
    id: "flights",
    text: "book flights before sunday",
    x: 26,
    y: 78,
    tilt: -2,
    message: "Book flights by Sun",
    reply: "Task added to Inbox: Book flights.\nDue Sun 25 Oct.",
    kind: "task",
  },
  {
    id: "expenses",
    text: "expense report!!",
    x: 72,
    y: 84,
    tilt: 3,
    message: "File expense report",
    reply: "Task added to Inbox: File expense report.\nNo deadline.",
    kind: "task",
  },
  {
    id: "dinner",
    text: "dinner fri 7?",
    x: 38,
    y: 22,
    tilt: 4,
    message: "Dinner Fri 7pm",
    reply: "Event added: Dinner\nFri 23 Oct 2026, 7–8pm · Personal",
    kind: "event",
  },
];

/** The two thoughts the capture walkthrough handles; the rest clear at the end. */
export const WALKTHROUGH_IDS = ["dentist", "invoice"] as const;

export const thought = (id: string): Thought => {
  const found = THOUGHTS.find((t) => t.id === id);
  if (!found) throw new Error(`No thought ${id}`);
  return found;
};

export interface Step {
  id: string;
  label: string;
  title: string;
  body: string;
}

export const STEPS: Step[] = [
  {
    id: "event",
    label: "Event",
    title: "Type it the way you'd say it.",
    body: "One message becomes an event in Google Calendar. The reply shows exactly what was added, with Undo.",
  },
  {
    id: "task",
    label: "Task",
    title: "Tasks keep their deadlines.",
    body: "Tasks live in lists, and each deadline appears in its own calendar, Tasks - Oh My Days, marked free so it never blocks your time.",
  },
  {
    id: "agenda",
    label: "Agenda",
    title: "The day comes back at 8am.",
    body: "Each morning one message lists today's events and what's due. Nothing to open, nothing to remember to check.",
  },
  {
    id: "snooze",
    label: "Reminder",
    title: "Snooze the reminder, not the deadline.",
    body: "Reminders arrive before deadlines with Done and Snooze. Snoozing moves the next reminder only; the deadline stays where it was.",
  },
];

export const AGENDA = [
  "Here's your day.",
  "Fri 23 Oct 2026",
  "",
  "Events",
  "• 9:30–10am Standup",
  "",
  "Due today",
  "• [Inbox] Send invoice · 3pm",
].join("\n");

export const REMINDER = "Due in 1 hour: [Inbox] Send invoice\nDue Fri 23 Oct, 3pm";
export const SNOOZED =
  "I'll remind you on Sat 24 Oct at 8am.\nDeadline unchanged: Fri 23 Oct, 3pm.";

export const CAREFUL = [
  {
    title: "Pending is never shown as done.",
    body: "If Google Calendar can't be reached, I say so and retry. One notice, then one result.",
  },
  {
    title: "Big changes wait for you.",
    body: "Deleting, changing a whole series, or notifying guests needs a confirmation bound to that exact change.",
  },
  {
    title: "No language model reads your messages.",
    body: "Capture runs on a fixed local grammar. What you type is not sent to an AI service.",
  },
  {
    title: "Kept as briefly as possible.",
    body: "Message text is deleted once handled. Google tokens are encrypted with a key kept outside the database.",
  },
];

export const QUESTIONS = [
  {
    id: "who",
    title: "Who can use Oh My Days?",
    description:
      "People on an invitation list. The bot answers only those accounts; anyone else is told the bot is private. There is no public sign-up.",
  },
  {
    id: "google",
    title: "What can it do in my Google account?",
    description:
      "It reads and writes events in the calendars you select and creates its own task calendar. Google's permission screen may grant broader access than the calendars you choose in Telegram; Oh My Days only uses the ones you select. You can remove access at any time from your Google Account.",
  },
  {
    id: "stored",
    title: "What does it store?",
    description:
      "Your Telegram and Google account identifiers, your calendars and settings, a short-lived copy of events in selected calendars, and your tasks. Event descriptions and guest lists are not stored. The privacy policy lists everything.",
  },
  {
    id: "cost",
    title: "Does it cost anything?",
    description:
      "No. Oh My Days is a private project run on free tiers for invited users. There are no ads, and data is never sold.",
  },
];

export const MINI_APP_SCREENS = [
  {
    id: "home",
    label: "Home",
    alt: "Mini App home: the logo beside Wednesday, Gym next at 7pm in 2 hr 24 min, quick add, Today 6, Overdue 3 (oldest 62 days), This week 4, and lists with overdue counts",
  },
  {
    id: "overdue",
    label: "Overdue",
    alt: "Overdue screen: Pay rent missed twice, folded under its monthly series, and File expense report one day overdue",
  },
  {
    id: "list",
    label: "List",
    alt: "The Work list in dark mode: four open tasks grouped into Overdue, Today and Later",
  },
  {
    id: "snooze",
    label: "Snooze",
    alt: "Snooze sheet for Send invoice to Northwind: In 1 hour, This evening, Tomorrow or Monday, each with its time, or a day and time; the deadline stays",
  },
] as const;
