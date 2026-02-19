import { useLayoutEffect, useRef, useState } from "react";
import type { HistoricalEvent } from "./history/types";

export type PositionedHistorical = HistoricalEvent & {
  xPx: number;
  laneIndex: number;
  imageUrl?: string;
  /** Top of card in timeline coords; anchorY for line */
  yTop: number;
  /** Top of article relative to zone (zone starts at axisY) */
  topRelativeToZone?: number;
};

export const HIST_CARD_WIDTH_PX = 120;
export const HIST_CARD_GAP_PX = 8;
export const AXIS_GAP = 20;
/** Lane height: image(4:3) + title(4 lines max) + padding. Fixed, zoom-independent. */
export const HIST_LANE_HEIGHT = 195;
/** Margin above card: article.top = yTop - this so card top = yTop */
export const HIST_ARTICLE_OFFSET = 8;
const MS_IN_DAY = 24 * 60 * 60 * 1000;

/** Stable lane assignment: independent of zoom/pxPerDay */
export const MAX_LANES = 3;
export const CANONICAL_WIDTH_DAYS = 24;

/** Fixed height of zone below axis for historical events */
export const HIST_ZONE_HEIGHT =
  AXIS_GAP + MAX_LANES * HIST_LANE_HEIGHT + 20;

function djb2Hash(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Stable lane assignment. Depends ONLY on events (id, date), CANONICAL_WIDTH_DAYS, MAX_LANES.
 * Try lanes 0..MAX_LANES-2 with collision check; if none fit, overflow to lane MAX_LANES-1.
 * laneIndex is always < MAX_LANES.
 */
export function assignHistoricalLanes(
  events: HistoricalEvent[]
): (HistoricalEvent & { laneIndex: number })[] {
  const sorted = [...events].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );
  const halfW = CANONICAL_WIDTH_DAYS / 2;
  const halfWMs = halfW * MS_IN_DAY;
  const overflowLane = MAX_LANES - 1;
  const collidableLanes = MAX_LANES - 1;
  /** Per-lane: array of {start, end} for placed intervals (lanes 0..overflowLane-1) */
  const laneIntervals: { start: number; end: number }[][] = [];

  return sorted.map((ev) => {
    const evMs = new Date(ev.date).getTime();
    const rangeStart = evMs - halfWMs;
    const rangeEnd = evMs + halfWMs;
    const baseLane = djb2Hash(ev.id) % collidableLanes;

    for (let offset = 0; offset < collidableLanes; offset++) {
      const laneIdx = (baseLane + offset) % collidableLanes;
      const intervals = laneIntervals[laneIdx] ?? [];
      const overlaps = intervals.some(
        (iv) => rangeStart < iv.end && iv.start < rangeEnd
      );
      if (!overlaps) {
        if (!laneIntervals[laneIdx]) laneIntervals[laneIdx] = [];
        laneIntervals[laneIdx].push({ start: rangeStart, end: rangeEnd });
        return { ...ev, laneIndex: laneIdx };
      }
    }
    return { ...ev, laneIndex: overflowLane };
  });
}

type HistoricalCardProps = {
  event: PositionedHistorical;
  cardRefsMap: React.MutableRefObject<Map<string, HTMLDivElement>>;
  top: number;
};

function HistoricalCard({
  event,
  cardRefsMap,
  top,
}: HistoricalCardProps) {
  const titleRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    const isOverflowing = el.scrollHeight > el.clientHeight;
    setExpanded(isOverflowing);
  }, [event.title]);

  return (
    <article
      data-event-id={event.id}
      className={`event event-historical ${event.imageUrl ? "event-photo" : ""}`}
      style={{
        left: `${event.xPx}px`,
        top: `${top}px`,
        transform: "translateX(-50%)",
      }}
    >
      <div
        className={`card card-historical ${expanded ? "expanded" : ""}`}
        ref={(el) => {
          if (el) cardRefsMap.current.set(event.id, el);
          else cardRefsMap.current.delete(event.id);
        }}
      >
        <div className="cardImage">
          {event.imageUrl ? (
            <img src={event.imageUrl} alt={event.title} />
          ) : (
            <div className="card-image-placeholder" />
          )}
        </div>
        <div
          ref={titleRef}
          className="cardTitle titleHistorical"
          title={event.summary ?? ""}
        >
          {event.title}
        </div>
      </div>
    </article>
  );
}

type HistoricalLayerProps = {
  events: PositionedHistorical[];
  axisY: number;
  cardRefsMap: React.MutableRefObject<Map<string, HTMLDivElement>>;
  /** When inside zone wrapper: use topRelativeToZone for positioning */
  insideZone?: boolean;
};

export function HistoricalLayer({
  events,
  axisY,
  cardRefsMap,
  insideZone = true,
}: HistoricalLayerProps) {
  return (
    <>
      {events.map((event) => {
        const top =
          insideZone && event.topRelativeToZone != null
            ? event.topRelativeToZone
            : event.yTop - HIST_ARTICLE_OFFSET;

        return (
          <HistoricalCard
            key={event.id}
            event={event}
            cardRefsMap={cardRefsMap}
            top={top}
          />
        );
      })}
    </>
  );
}
