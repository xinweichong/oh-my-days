/** Per-user name → email shortcuts for invitations. Names are matched case-insensitively. */
export interface Contact {
  name: string;
  email: string;
}

export function normalizeContactName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export async function findContact(
  db: D1Database,
  userId: string,
  name: string,
): Promise<Contact | null> {
  return db
    .prepare("SELECT name, email FROM contacts WHERE user_id = ? AND normalized_name = ?")
    .bind(userId, normalizeContactName(name))
    .first<Contact>();
}

export async function listContacts(db: D1Database, userId: string): Promise<Contact[]> {
  const { results } = await db
    .prepare("SELECT name, email FROM contacts WHERE user_id = ? ORDER BY normalized_name")
    .bind(userId)
    .all<Contact>();
  return results;
}

export function saveContactStatement(
  db: D1Database,
  userId: string,
  contact: Contact,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO contacts (user_id, normalized_name, name, email, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, normalized_name) DO UPDATE SET name = excluded.name, email = excluded.email`,
    )
    .bind(userId, normalizeContactName(contact.name), contact.name.trim(), contact.email, now);
}

export function deleteContactStatement(
  db: D1Database,
  userId: string,
  name: string,
): D1PreparedStatement {
  return db
    .prepare("DELETE FROM contacts WHERE user_id = ? AND normalized_name = ?")
    .bind(userId, normalizeContactName(name));
}

/** A deliberately simple check: one @, a dot in the domain, no spaces. Google validates further. */
export function isEmailAddress(value: string): boolean {
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value) && value.length <= 254;
}
