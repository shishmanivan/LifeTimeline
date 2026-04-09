/**
 * Explicit file-backed profile catalog (MVP: one row). Add entries here when
 * supporting more profiles; lookup stays in `profiles.ts`.
 */
export type Profile = {
  id: string;
  slug: string;
  displayName: string;
};

export const PROFILE_REGISTRY: readonly Profile[] = [
  {
    id: "1",
    slug: "ivan",
    displayName: "Ivan",
  },
];
