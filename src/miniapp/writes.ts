import type { UserRecord } from "../storage/users";
import { apiError, type MiniAppDeps } from "./api";

/** Task writes (step 5b). */
export async function handleWrite(
  _request: Request,
  _path: string,
  _user: UserRecord,
  _deps: MiniAppDeps,
): Promise<Response> {
  return apiError("not_found", 404);
}
