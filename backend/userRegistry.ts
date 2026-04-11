import { readIdentityStore, type StoredUserRecord } from "./identityStore";
import type { UserModel } from "../src/userModel";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toPublicUser(user: StoredUserRecord): UserModel {
  const { mvpWriteAccessToken: _ignoredToken, ...publicUser } = user;
  return publicUser;
}

export async function listUsers(): Promise<readonly UserModel[]> {
  const store = await readIdentityStore();
  return store.users.map((user) => toPublicUser(user));
}

export async function getUserById(id: string): Promise<UserModel | undefined> {
  const store = await readIdentityStore();
  const user = store.users.find((item) => item.id === id);
  return user ? toPublicUser(user) : undefined;
}

export async function getUserByEmail(
  email: string
): Promise<UserModel | undefined> {
  const normalizedEmail = normalizeEmail(email);
  const store = await readIdentityStore();
  const user = store.users.find(
    (user) => normalizeEmail(user.email) === normalizedEmail
  );
  return user ? toPublicUser(user) : undefined;
}

export async function getUserByMvpWriteAccessToken(
  writeToken: string
): Promise<UserModel | undefined> {
  const store = await readIdentityStore();
  const user = store.users.find(
    (item) => item.mvpWriteAccessToken === writeToken
  );
  return user ? toPublicUser(user) : undefined;
}
