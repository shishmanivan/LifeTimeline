import { PROFILE_REGISTRY, type Profile } from "./profileRegistry";

export type { Profile };

export function getProfileBySlug(slug: string): Profile | undefined {
  return PROFILE_REGISTRY.find((p) => p.slug === slug);
}

export function getDefaultProfile(): Profile {
  return PROFILE_REGISTRY[0];
}
