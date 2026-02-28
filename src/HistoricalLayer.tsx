import { useEffect, useRef, useState } from "react";
import type { HistoricalEvent } from "./history/types";
import { MAX_LANES, CANONICAL_WIDTH_DAYS } from "./history/laneAssignment";

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

export { MAX_LANES, CANONICAL_WIDTH_DAYS };

/** Fixed height of zone below axis for historical events */
export const HIST_ZONE_HEIGHT =
  AXIS_GAP + MAX_LANES * HIST_LANE_HEIGHT + 20;

/** Top (relative to zone) for central lane — main events align here at 10y/5y */
export const MAIN_CENTRAL_TOP_REL =
  AXIS_GAP + HIST_LANE_HEIGHT - HIST_ARTICLE_OFFSET;
/** Offset main axis up (px) — for fine-tuning */
const MAIN_AXIS_OFFSET_UP = 50;
/** Height of main corridor layer — slightly more than scaled main cards */
const MAIN_CORRIDOR_HEIGHT = 250;

type MainEffectMode = "10y" | "5y" | "small" | "none";

type HistoricalCardProps = {
  event: PositionedHistorical;
  cardRefsMap: React.MutableRefObject<Map<string, HTMLDivElement>>;
  top: number;
  getLocalImageUrl?: (e: { date: string; url: string }) => string | undefined;
  historicalImageUrls?: Record<string, string>;
  isMainEvent?: boolean;
  mainEffectMode?: MainEffectMode;
  dimNonMain?: boolean;
  isOpen?: boolean;
};

function HistoricalCard({
  event,
  cardRefsMap,
  top,
  getLocalImageUrl,
  historicalImageUrls,
  isMainEvent = false,
  mainEffectMode = "none",
  dimNonMain = true,
  isOpen = false,
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

  const mainScale =
    mainEffectMode === "10y"
      ? 1.25
      : mainEffectMode === "5y"
        ? 1.13
        : mainEffectMode === "small"
          ? 1.08
          : 1;
  const cardStyle =
    isMainEvent && mainEffectMode !== "none"
      ? { transform: `translateX(-50%) scale(${mainScale})` }
      : { transform: "translateX(-50%)" };

  const dimClass =
    dimNonMain && !isMainEvent && mainEffectMode === "10y"
      ? "hist--dim-10y"
      : dimNonMain && !isMainEvent && mainEffectMode === "5y"
        ? "hist--dim-5y"
        : "";
  const mainClass = isMainEvent && mainEffectMode !== "none" ? "hist--main" : "";
  const mainModeClass =
    isMainEvent && mainEffectMode === "10y"
      ? "hist-main-10y"
      : isMainEvent && mainEffectMode === "5y"
        ? "hist-main-5y"
        : "";
  const openMainClass =
    isMainEvent && isOpen && (mainEffectMode === "10y" || mainEffectMode === "5y")
      ? "hist--main-open"
      : "";

  return (
    <article
      data-event-id={event.id}
      className={`event event-historical ${imageUrl ? "event-photo" : ""} ${mainClass} ${mainModeClass} ${openMainClass} ${dimClass}`.trim()}
      style={{
        left: `${event.xPx}px`,
        top: `${top}px`,
        zIndex: isMainEvent && mainEffectMode !== "none" ? 2 : undefined,
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
  /** At 10y/5y scale: main events emphasized, others dimmed. Main drawn on top. */
  mainEventIds?: Set<string>;
  mainEffectMode?: MainEffectMode;
  /** When false (2y and below): non-main keep color, no dimming */
  dimNonMain?: boolean;
  /** ID of open (modal) event — for main card accent */
  openEventId?: string | null;
};

export function HistoricalLayer({
  events,
  axisY,
  cardRefsMap,
  insideZone = true,
  getLocalImageUrl,
  historicalImageUrls,
  mainEventIds,
  mainEffectMode = "none",
  dimNonMain = true,
  openEventId = null,
}: HistoricalLayerProps) {
  const isEffectActive = mainEffectMode !== "none";
  const sortedEvents =
    isEffectActive && mainEventIds
      ? [...events].sort((a, b) => {
          const aMain = mainEventIds.has(a.id) ? 1 : 0;
          const bMain = mainEventIds.has(b.id) ? 1 : 0;
          return aMain - bMain;
        })
      : events;

  const showMainCorridor =
    (mainEffectMode === "10y" || mainEffectMode === "5y") &&
    mainEventIds &&
    mainEventIds.size > 0;

  return (
    <>
      {showMainCorridor && (
        <div
          className={`main-corridor ${mainEffectMode === "10y" ? "main-corridor-10y" : "main-corridor-5y"}`}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: MAIN_CENTRAL_TOP_REL - MAIN_AXIS_OFFSET_UP,
            height: MAIN_CORRIDOR_HEIGHT,
            zIndex: 0,
            pointerEvents: "none",
          }}
          aria-hidden
        />
      )}
      {sortedEvents.map((event) => {
        const isMain = isEffectActive && mainEventIds?.has(event.id) === true;
        /** Main at 10y/5y: fixed central axis. Others: normal lane position. */
        const top =
          insideZone && event.topRelativeToZone != null
            ? isMain && (mainEffectMode === "10y" || mainEffectMode === "5y")
              ? MAIN_CENTRAL_TOP_REL - MAIN_AXIS_OFFSET_UP
              : event.topRelativeToZone
            : event.yTop - HIST_ARTICLE_OFFSET;

        return (
          <HistoricalCard
            key={event.id}
            event={event}
            cardRefsMap={cardRefsMap}
            top={top}
            getLocalImageUrl={getLocalImageUrl}
            historicalImageUrls={historicalImageUrls}
            isMainEvent={isMain}
            mainEffectMode={mainEffectMode}
            dimNonMain={dimNonMain}
            isOpen={openEventId === event.id}
          />
        );
      })}
    </>
  );
}
