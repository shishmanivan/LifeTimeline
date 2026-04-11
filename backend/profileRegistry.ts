import type { ProfileModel } from "../src/profileModel";

/**
 * Seed profile catalog used to bootstrap the runtime identity store.
 * Existing runtime data keeps winning once persisted to disk.
 */
export type Profile = ProfileModel;

export const PROFILE_REGISTRY: readonly Profile[] = [
  {
    id: "1",
    slug: "ivan",
    displayName: "Ivan",
    availability: "public",
    personalDataset: {
      profileId: "1",
    },
  },
  {
    id: "2",
    slug: "anna",
    displayName: "Anna",
    availability: "public",
    personalDataset: {
      profileId: "2",
    },
  },
];
