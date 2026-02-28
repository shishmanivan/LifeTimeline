import type { HistoricalEvent } from "./types";

const MS_IN_DAY = 24 * 60 * 60 * 1000;
export const MAX_LANES = 3;
/** Overlap window: events within ±half this are placed in different lanes */
export const CANONICAL_WIDTH_DAYS = 45;

function djb2Hash(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Stable lane assignment. Try lanes 0..1 with collision; overflow to lane 2.
 * Exception: when overflow would be used, put in lane 1 with overlap instead (never lane 2).
 * Called at ingest time only — result is stored in DB. Never recalculate at display time.
 */
export function assignHistoricalLanes(
  events: HistoricalEvent[]
): (HistoricalEvent & { laneIndex: number })[] {
  const sorted = [...events].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );
  const halfW = CANONICAL_WIDTH_DAYS / 2;
  const halfWMs = halfW * MS_IN_DAY;
  const collidableLanes = MAX_LANES - 1;
  const laneIntervals: { start: number; end: number }[][] = [];

  const result: (HistoricalEvent & { laneIndex: number })[] = [];

  for (const ev of sorted) {
    const evMs = new Date(ev.date).getTime();
    const rangeStart = evMs - halfWMs;
    const rangeEnd = evMs + halfWMs;
    const baseLane = djb2Hash(ev.id) % collidableLanes;
    const freeLanes: number[] = [];
    for (let offset = 0; offset < collidableLanes; offset++) {
      const laneIdx = (baseLane + offset) % collidableLanes;
      const intervals = laneIntervals[laneIdx] ?? [];
      const overlaps = intervals.some(
        (iv) => rangeStart < iv.end && iv.start < rangeEnd
      );
      if (!overlaps) freeLanes.push(laneIdx);
    }

    const laneIdx =
      freeLanes.length > 1
        ? freeLanes.reduce((a, b) =>
            (laneIntervals[a]?.length ?? 0) <= (laneIntervals[b]?.length ?? 0)
              ? a
              : b
          )
        : freeLanes[0] ?? 1;

    if (freeLanes.length > 0) {
      if (!laneIntervals[laneIdx]) laneIntervals[laneIdx] = [];
      laneIntervals[laneIdx].push({ start: rangeStart, end: rangeEnd });
      result.push({ ...ev, laneIndex: laneIdx });
    } else {
      result.push({ ...ev, laneIndex: 1 });
    }
  }

  return result;
}
