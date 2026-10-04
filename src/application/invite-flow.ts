import { findContact, isEmailAddress, saveContactStatement } from "../storage/contacts";
import {
  clearPendingInputStatement,
  type PendingInput,
  setPendingInputStatement,
  type UiAction,
} from "../storage/interactions";
import type { UserRecord } from "../storage/users";
import type { InboundCallback, InboundMessage } from "../telegram/update";
import type { SourceFor } from "./calendar-view";
import { guestChangePreview, PATCH_EVENT, type PatchEventIntent } from "./event-operations";
import { prepareProposal } from "./proposals";
import { ActionButtons, combine, message, type Reaction } from "./reactions";
import { PENDING_INPUT_TTL_MS, type SetupDeps } from "./setup";
import { answer, keyboardMessage } from "./ui";

/**
 * Inviting guests (spec §5): explicit email addresses or saved contact names.
 * An unknown name is never guessed: the bot asks for the address and offers to
 * save it. Invitations go out only after a preview showing every recipient.
 */

export interface InviteDeps extends SetupDeps {
  sourceFor: SourceFor;
}

interface InviteState {
  calendarId: string;
  eventId: string;
  emails: string[];
  /** Names still needing an address, in the order given. */
  unknown: string[];
}

const MAX_INVITEES = 20;

export function isInviteAction(action: string): boolean {
  return action === "event_invite" || action === "event_save_contact";
}

export function isInviteInput(kind: string): boolean {
  return kind === "event_invite" || kind === "event_contact_email";
}

export async function handleInviteAction(
  deps: InviteDeps,
  user: UserRecord,
  callback: InboundCallback,
  { action, payload }: UiAction,
): Promise<Reaction> {
  if (action === "event_save_contact") {
    const name = String(payload.name ?? "");
    const email = String(payload.email ?? "");
    if (!name || !isEmailAddress(email)) return answer(callback, "This button is no longer valid.");
    return combine(answer(callback, `Saved ${name}.`), {
      replies: [],
      statements: (db) => [saveContactStatement(db, user.id, { name, email }, deps.clock.now())],
    });
  }
  const now = deps.clock.now();
  return combine(answer(callback), {
    replies: [
      {
        method: "sendMessage",
        params: {
          chat_id: user.privateChatId,
          text: "Who should I invite? Send email addresses or saved contact names, separated by commas.",
        },
      },
    ],
    statements: (db) => [
      setPendingInputStatement(db, user.id, "event_invite", now + PENDING_INPUT_TTL_MS, now, {
        calendarId: payload.calendarId,
        eventId: payload.eventId,
      }),
    ],
  });
}

export async function handleInviteInput(
  deps: InviteDeps,
  user: UserRecord,
  input: InboundMessage,
  pending: PendingInput,
): Promise<Reaction> {
  const text = (input.text ?? "").trim();
  const payload = pending.payload as Partial<InviteState>;
  const calendarId = String(payload.calendarId ?? "");
  const eventId = String(payload.eventId ?? "");

  if (pending.kind === "event_invite") {
    const entries = text
      .split(/[,;\n]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (entries.length === 0 || entries.length > MAX_INVITEES) {
      return message(
        user.privateChatId,
        `Send up to ${MAX_INVITEES} email addresses or contact names.`,
      );
    }
    const state: InviteState = { calendarId, eventId, emails: [], unknown: [] };
    for (const entry of entries) {
      if (entry.includes("@")) {
        if (!isEmailAddress(entry)) {
          return message(
            user.privateChatId,
            `${entry} doesn't look like an email address. Send the list again.`,
          );
        }
        state.emails.push(entry.toLowerCase());
        continue;
      }
      const contact = await findContact(deps.db, user.id, entry);
      if (contact) state.emails.push(contact.email.toLowerCase());
      else state.unknown.push(entry);
    }
    return next(deps, user, state, input.messageId);
  }

  // event_contact_email: the address for the first unknown name.
  const state: InviteState = {
    calendarId,
    eventId,
    emails: payload.emails ?? [],
    unknown: payload.unknown ?? [],
  };
  const name = state.unknown[0];
  if (!name) return expired(user);
  if (!isEmailAddress(text)) {
    return message(
      user.privateChatId,
      `That doesn't look like an email address. Send ${name}'s email address.`,
    );
  }
  const email = text.toLowerCase();
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const offer: Reaction = {
    replies: [
      keyboardMessage(
        user,
        `Save ${name} as ${email} for next time?`,
        {
          inline_keyboard: [
            [buttons.button(`Save ${name}`, "event_save_contact", { name, email })],
          ],
        },
        null,
      ),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  };
  return combine(
    offer,
    await next(
      deps,
      user,
      { ...state, emails: [...state.emails, email], unknown: state.unknown.slice(1) },
      input.messageId,
    ),
  );
}

/** Asks for the next unknown address, or shows the invitation preview. */
async function next(
  deps: InviteDeps,
  user: UserRecord,
  state: InviteState,
  messageId: number,
): Promise<Reaction> {
  const now = deps.clock.now();
  const name = state.unknown[0];
  if (name) {
    return {
      replies: [
        {
          method: "sendMessage",
          params: {
            chat_id: user.privateChatId,
            text: `I don't have an email address for ${name}. Send it, and I'll offer to save it.`,
          },
        },
      ],
      statements: (db) => [
        setPendingInputStatement(
          db,
          user.id,
          "event_contact_email",
          now + PENDING_INPUT_TTL_MS,
          now,
          { ...state },
        ),
      ],
    };
  }

  const source = await deps.sourceFor(user.id);
  const live = source ? await source.getEvent(state.calendarId, state.eventId) : null;
  if (!live?.ok || live.value.status === "cancelled") {
    return combine(
      clear(user),
      message(
        user.privateChatId,
        "I couldn't read that event from Google Calendar. Try again shortly.",
      ),
    );
  }
  if (live.value.organizerSelf === false) {
    return combine(
      clear(user),
      message(
        user.privateChatId,
        "Someone else organizes this event, so only they can invite guests.",
      ),
    );
  }
  const existing = (live.value.attendees ?? []).map((a) => a.toLowerCase());
  const add = [...new Set(state.emails)].filter((e) => !existing.includes(e));
  if (add.length === 0) {
    return combine(
      clear(user),
      message(user.privateChatId, "They're all already invited. Nothing was sent."),
    );
  }
  const intent: PatchEventIntent = {
    calendarId: state.calendarId,
    eventId: state.eventId,
    title: live.value.fields.summary,
    base: {},
    patch: {},
    addAttendees: add,
    notify: { recipients: [...existing, ...add] },
  };
  const prepared = await prepareProposal(deps, user, {
    kind: PATCH_EVENT,
    idempotencyKey: `invite:${messageId}`,
    intent,
    confirmation: guestChangePreview(intent),
  });
  return combine(clear(user), { replies: prepared.replies, statements: prepared.statements });
}

function clear(user: UserRecord): Reaction {
  return { replies: [], statements: (db) => [clearPendingInputStatement(db, user.id)] };
}

function expired(user: UserRecord): Reaction {
  return combine(
    clear(user),
    message(
      user.privateChatId,
      "That invitation expired. Open the event from /event to start again.",
    ),
  );
}
