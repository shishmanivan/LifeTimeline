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

/**
 * Deterministic tilt for archival effect (XIX century).
 * Three-tier distribution: 70% nearly flat (-0.3°..+0.3°), 25% moderate (-0.7°..+0.7°), 5% noticeable (-1.2°..+1.2°).
 */
export function getCardTiltFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  }
  const abs = Math.abs(h);
  const r = (abs % 10000) / 10000;
  const r2 = ((abs >>> 4) % 10000) / 10000; // different "random" value for angle within tier

  let tilt: number;
  if (r < 0.7) {
    tilt = (r2 - 0.5) * 0.6;
  } else if (r < 0.95) {
    tilt = (r2 - 0.5) * 1.4;
  } else {
    tilt = (r2 - 0.5) * 2.4;
  }
  return tilt;
}
