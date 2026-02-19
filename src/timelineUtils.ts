const MS_IN_DAY = 24 * 60 * 60 * 1000;

/**
 * Convert a date to X position in pixels.
 * Uses axisStart as origin and pxPerDay for scale.
 */
export function dateToX(
  date: Date | string,
  axisStart: Date,
  pxPerDay: number
): number {
  const dateMs = typeof date === "string" ? new Date(date).getTime() : date.getTime();
  const startMs = axisStart.getTime();
  const daysFromStart = (dateMs - startMs) / MS_IN_DAY;
  return daysFromStart * pxPerDay;
}

/**
 * Compute SVG path from card anchor to axis.
 * anchorAboveAxis: true for personal (line goes down), false for historical (line goes up).
 */
export function computeLinePath(
  anchorX: number,
  anchorY: number,
  xEvent: number,
  axisY: number,
  anchorAboveAxis: boolean
): { path: string; totalLength: number } {
  const dx = xEvent - anchorX;
  const verticalDist = Math.abs(axisY - anchorY);
  const horizontalDist = Math.abs(dx);
  const path = `M ${anchorX} ${anchorY} L ${anchorX} ${axisY} L ${xEvent} ${axisY}`;
  const totalLength = verticalDist + horizontalDist;
  return { path, totalLength };
}
