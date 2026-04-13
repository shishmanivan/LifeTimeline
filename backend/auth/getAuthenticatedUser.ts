import type { IncomingMessage } from "node:http";
import type { UserModel } from "../../src/userModel";
import { getUserByMvpWriteAccessToken } from "../userRegistry";

/** Lowercase header name; Node normalizes incoming keys to lowercase. */
const PERSONAL_WRITE_TOKEN_HEADER = "x-personal-write-token";

function getWriteTokenFromRequest(req: IncomingMessage): string | undefined {
  const header = req.headers[PERSONAL_WRITE_TOKEN_HEADER];
  const requestToken = Array.isArray(header) ? header[0] : header;
  return typeof requestToken === "string" ? requestToken : undefined;
}

/** Maps the personal write header to a real stored `UserModel`. */
export async function getAuthenticatedUserFromRequest(
  req: IncomingMessage
): Promise<UserModel | null> {
  const requestToken = getWriteTokenFromRequest(req);
  if (!requestToken) {
    console.log("[auth] getAuthenticatedUserFromRequest: null");
    return null;
  }

  const userFromStore = await getUserByMvpWriteAccessToken(requestToken);
  if (userFromStore) {
    console.log(
      `[auth] getAuthenticatedUserFromRequest: resolved id=${userFromStore.id} role=${userFromStore.role}`
    );
    return userFromStore;
  }

  console.log("[auth] getAuthenticatedUserFromRequest: null");
  return null;
}
