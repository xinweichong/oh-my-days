/** Builds unsigned synthetic ID tokens for tests (signature is not checked; see oauth.ts). */
export function idToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(claims)}.sig`;
}

export const CLIENT_ID = "test-client.apps.googleusercontent.com";

export function googleClaims(sub: string, email: string): Record<string, unknown> {
  return { iss: "https://accounts.google.com", aud: CLIENT_ID, sub, email, email_verified: true };
}
