import { useEffect, useRef, useState } from "react";
import type { HistoricalEvent } from "./history/types";

/** Resolve image URL: HistoryPics > cached > previewBlob > thumbnailUrl */
export function useResolvedImageUrl(
  event: HistoricalEvent,
  getLocalImageUrl?: (e: { date: string; url: string }) => string | undefined,
  historicalImageUrls?: Record<string, string>
): string | undefined {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const local = getLocalImageUrl?.(event);
  const cached = historicalImageUrls?.[event.id];
  const thumb = event.thumbnailUrl;

  useEffect(() => {
    if (event.previewBlob && !local && !cached) {
      const url = URL.createObjectURL(event.previewBlob);
      setBlobUrl(url);
      return () => URL.revokeObjectURL(url);
    }
  }, [event.previewBlob, event.id, local, cached]);

  return local ?? cached ?? blobUrl ?? thumb;
}

export type PositionedHistorical = HistoricalEvent & {
  xPx: number;
  laneIndex: number;
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
export const CANONICAL_WIDTH_DAYS = 12;

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
  getLocalImageUrl?: (e: { date: string; url: string }) => string | undefined;
  historicalImageUrls?: Record<string, string>;
  isMainEvent?: boolean;
  isMainEffectActive?: boolean;
};

function HistoricalCard({
  event,
  cardRefsMap,
  top,
  getLocalImageUrl,
  historicalImageUrls,
  isMainEvent = false,
  isMainEffectActive = false,
}: HistoricalCardProps) {
  const imageUrl = useResolvedImageUrl(event, getLocalImageUrl, historicalImageUrls);
  const [imgLoaded, setImgLoaded] = useState(false);

  if (import.meta.env.DEV) {
    const isTikTok =
      event.date === "2019-02-15" &&
      (event.title?.toLowerCase().includes("tiktok") ?? false);
    if (isTikTok) {
      console.log("[history-debug]", {
        id: event.id,
        date: event.date,
        laneIndex: event.laneIndex,
        computedTop: top,
        appliedOffsetY: 0,
        recordOffsetY: undefined,
        recordOffsetXDays: undefined,
      });
    }
  }

  const cardStyle =
    isMainEvent
      ? { transform: "translateX(-50%) scale(1.2)", opacity: 1 }
      : isMainEffectActive
        ? { transform: "translateX(-50%)", opacity: 0.45 }
        : { transform: "translateX(-50%)" };

  return (
    <article
      data-event-id={event.id}
      className={`event event-historical ${imageUrl ? "event-photo" : ""} ${isMainEvent ? "event-main" : ""}`}
      style={{
        left: `${event.xPx}px`,
        top: `${top}px`,
        ...cardStyle,
      }}
    >
      <div
        className="card card-historical"
        ref={(el) => {
          if (el) cardRefsMap.current.set(event.id, el);
          else cardRefsMap.current.delete(event.id);
        }}
      >
        <div className="cardImage cardImage-historical">
          <div className="card-image-placeholder" aria-hidden="true" />
          {imageUrl && (
            <img
              src={imageUrl}
              alt={event.title}
              onLoad={() => setImgLoaded(true)}
              className="card-image-img"
              style={{
                opacity: imgLoaded ? 1 : 0,
                transition: "opacity 200ms ease-out",
              }}
            />
          )}
        </div>
        <div className="cardTitle titleHistorical" title={event.summary ?? ""}>
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
  getLocalImageUrl?: (e: { date: string; url: string }) => string | undefined;
  historicalImageUrls?: Record<string, string>;
  /** At 10y scale: main events are emphasized, others dimmed. Main drawn on top. */
  mainEventIds?: Set<string>;
  isMainEffectActive?: boolean;
};

export function HistoricalLayer({
  events,
  axisY,
  cardRefsMap,
  insideZone = true,
  getLocalImageUrl,
  historicalImageUrls,
  mainEventIds,
  isMainEffectActive = false,
}: HistoricalLayerProps) {
  const sortedEvents = isMainEffectActive && mainEventIds
    ? [...events].sort((a, b) => {
        const aMain = mainEventIds.has(a.id) ? 1 : 0;
        const bMain = mainEventIds.has(b.id) ? 1 : 0;
        return aMain - bMain;
      })
    : events;

  return (
    <>
      {sortedEvents.map((event) => {
        const top =
          insideZone && event.topRelativeToZone != null
            ? event.topRelativeToZone
            : event.yTop - HIST_ARTICLE_OFFSET;
        const isMain = isMainEffectActive && mainEventIds?.has(event.id) === true;

        return (
          <HistoricalCard
            key={event.id}
            event={event}
            cardRefsMap={cardRefsMap}
            top={top}
            getLocalImageUrl={getLocalImageUrl}
            historicalImageUrls={historicalImageUrls}
            isMainEvent={isMain}
            isMainEffectActive={isMainEffectActive}
          />
        );
      })}
    </>
  );
}
