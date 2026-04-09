export type ProfileRouteState = {
  routeProfileSlug: string | null;
  isRootShortcut: boolean;
  isSingleSlugRoute: boolean;
  isInvalidProfileRoute: boolean;
};

export function getRouteProfileSlug(pathname: string): string | null {
  const segments = pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  return segments.length === 1 ? decodeURIComponent(segments[0]) : null;
}

export function getProfileRouteState(
  pathname: string,
  options: { hasActiveProfile?: boolean } = {}
): ProfileRouteState {
  const routeProfileSlug = getRouteProfileSlug(pathname);
  const isRootShortcut = pathname === "/";
  const isSingleSlugRoute = routeProfileSlug !== null;
  const isInvalidProfileRoute =
    isSingleSlugRoute && options.hasActiveProfile !== true;

  return {
    routeProfileSlug,
    isRootShortcut,
    isSingleSlugRoute,
    isInvalidProfileRoute,
  };
}
