import type { ProfileModel } from "../../src/profileModel";
import type { UserModel } from "../../src/userModel";

export function mayUserWriteProfile(
  authUser: UserModel | null,
  profile: ProfileModel | null
): boolean {
  if (authUser === null || profile === null) {
    return false;
  }
  if (authUser.role === "admin") {
    return true;
  }
  return profile.ownerUserId === authUser.id;
}

export function mayUserAdmin(authUser: UserModel | null): boolean {
  return authUser?.role === "admin";
}
