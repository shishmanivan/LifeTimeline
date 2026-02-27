import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  deletePhoto,
  getAllPhotos,
  getHistoricalEventsInRange,
  savePhoto,
  updatePhotoOffsets,
  updatePhotoNote,
  updatePhotoPreview,
  type PhotoRecord,
} from "./db";
import type { HistoricalEvent } from "./history/types";
import { runHistoryIngest } from "./history/ingestHistory";
import { generatePreviewBlob } from "./imagePreview";
import { dateToX, computeLinePath } from "./timelineUtils";
import { MarkerLink } from "./MarkerLink";
import { getLocalImageUrl } from "./history/localPics";
import {
  PersonalLayer,
  type PersonalPhoto,
  type PositionedPhoto,
  type Offsets,
} from "./PersonalLayer";
import {
  HistoricalLayer,
  assignHistoricalLanes,
  AXIS_GAP,
  HIST_ARTICLE_OFFSET,
  HIST_LANE_HEIGHT,
  HIST_ZONE_HEIGHT,
  MAX_LANES,
  type PositionedHistorical,
} from "./HistoricalLayer";
import { HistoricalEventModal } from "./HistoricalEventModal";
import { PersonalPhotoModal } from "./PersonalPhotoModal";

export type { Offsets };

type Scale = "30d" | "60d" | "90d" | "1y" | "2y" | "5y" | "10y";

const scales: Scale[] = ["30d", "60d", "90d", "1y", "2y", "5y", "10y"];

const scaleMeta: Record<Scale, { label: string; rangeDays: number }> = {
  "30d": { label: "30 days", rangeDays: 30 },
  "60d": { label: "60 days", rangeDays: 60 },
  "90d": { label: "90 days", rangeDays: 90 },
  "1y": { label: "1 year", rangeDays: 365 },
  "2y": { label: "2 years", rangeDays: 730 },
  "5y": { label: "5 years", rangeDays: 1825 },
  "10y": { label: "10 years", rangeDays: 3650 },
};

const MS_IN_DAY = 24 * 60 * 60 * 1000;
const CARD_WIDTH_PERCENT = 18;
const LANE_HEIGHT = 140;
const EPS = 0.01;
const SCROLL_STOP_DEBOUNCE_MS = 200;

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

type AnchorPosition = "left" | "center" | "right";

function getAnchorPosition(id: string): AnchorPosition {
  const idx = hashId(id) % 3;
  return idx === 0 ? "left" : idx === 1 ? "center" : "right";
}

const MAX_OFFSET_DAYS: Record<Scale, number> = {
  "30d": 3,
  "60d": 5,
  "90d": 7,
  "1y": 14,
  "2y": 30,
  "5y": 60,
  "10y": 120,
};

function formatAxisDate(d: Date, scale: Scale): string {
  if (scale === "2y" || scale === "5y" || scale === "10y") {
    return String(d.getFullYear());
  }
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

function getMinImportanceForScale(scale: Scale): number {
  if (scale === "30d" || scale === "60d" || scale === "90d") return 3;
  if (scale === "1y") return 3;
  return 2;
}

function clampCenterToToday(center: Date, scale: Scale): Date {
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const halfRange = scaleMeta[scale].rangeDays / 2;
  const maxCenterMs = today.getTime() - halfRange * MS_IN_DAY;
  return center.getTime() > maxCenterMs ? new Date(maxCenterMs) : center;
}

type AddPhotoModalProps = {
  onClose: () => void;
  onSubmit: (file: File, date: string, caption: string) => void;
};

const todayStr = () => new Date().toISOString().slice(0, 10);

function AddPhotoModal({ onClose, onSubmit }: AddPhotoModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [date, setDate] = useState(todayStr());
  const [caption, setCaption] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (file) {
      onSubmit(file, date, caption.trim());
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Добавить фото</h2>
        <form onSubmit={handleSubmit}>
          <div className="modal-field">
            <label>Файл</label>
            <input
              type="file"
              accept="image/*"
              required
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="modal-field">
            <label>Дата</label>
            <input
              type="date"
              value={date}
              max={todayStr()}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </div>
          <div className="modal-field">
            <label>Подпись (опционально)</label>
            <input
              type="text"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Краткое описание"
            />
          </div>
          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              Отмена
            </button>
            <button type="submit" disabled={!file}>
              Добавить
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function App() {
  const [scaleIndex, setScaleIndex] = useState(2);
  const [personalPhotos, setPersonalPhotos] = useState<PersonalPhoto[]>([]);
  const [historicalEvents, setHistoricalEvents] = useState<HistoricalEvent[]>([]);
  const [historicalImageUrls, setHistoricalImageUrls] = useState<
    Record<string, string>
  >({});
  const [layoutInfo, setLayoutInfo] = useState<{
    width: number;
    height: number;
    axisY: number;
  } | null>(null);
  const objectUrlsRef = useRef<Map<string, string>>(new Map());
  const imageBlobsRef = useRef<Map<string, Blob>>(new Map());
  const overlayUrlRef = useRef<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [overlayPhotoId, setOverlayPhotoId] = useState<string | null>(null);
  const [overlayUrl, setOverlayUrl] = useState<string | null>(null);
  const [selectedHistoricalEvent, setSelectedHistoricalEvent] =
    useState<HistoricalEvent | null>(null);
  const [centerDate, setCenterDate] = useState(() =>
    clampCenterToToday(new Date(), "1y")
  );
  const [isDragging, setIsDragging] = useState(false);
  const [cardDragging, setCardDragging] = useState<string | null>(null);
  const [pendingOffsets, setPendingOffsets] = useState<Record<string, Offsets>>(
    {}
  );
  const dragRef = useRef<{ startX: number; startCenterMs: number } | null>(null);
  const cardDragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    startOffsetXDays: number;
    startOffsetY: number;
  } | null>(null);
  const cardDragLastRef = useRef<{
    offsetXDays: number;
    offsetY: number;
  } | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const axisRef = useRef<HTMLDivElement>(null);
  const personalCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const historicalCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [visiblePhotoIds, setVisiblePhotoIds] = useState<Set<string>>(new Set());
  const [visibleHistIds, setVisibleHistIds] = useState<Set<string>>(new Set());
  const [animatedLines, setAnimatedLines] = useState<Set<string>>(new Set());
  const [linesData, setLinesData] = useState<
    { id: string; path: string; totalLength: number }[]
  >([]);
  const seenInViewportRef = useRef<Set<string>>(new Set());
  const visiblePhotoIdsRef = useRef<Set<string>>(new Set());
  const visibleHistIdsRef = useRef<Set<string>>(new Set());
  const scrollStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleScrollStopRef = useRef<() => void>(() => {});
  const thumbnailUrlCacheRef = useRef<Map<string, string>>(new Map());
  const scale = scales[scaleIndex];

  const getActiveOffsets = (id: string): Offsets => {
    const pend = pendingOffsets[id];
    if (pend) return pend;
    const p = personalPhotos.find((x) => x.id === id);
    if (p) return { offsetXDays: p.offsetXDays, offsetY: p.offsetY };
    return { offsetXDays: 0, offsetY: 0 };
  };

  const isDirty = (id: string): boolean => {
    const pend = pendingOffsets[id];
    if (!pend) return false;
    const p = personalPhotos.find((x) => x.id === id);
    if (!p) return true;
    return (
      Math.abs(pend.offsetXDays - p.offsetXDays) > EPS ||
      Math.abs(pend.offsetY - p.offsetY) > 1
    );
  };

  useEffect(() => {
    let cancelled = false;
    getAllPhotos().then(async (records) => {
      if (cancelled) return;
      const today = todayStr();
      const photos: PersonalPhoto[] = records.map((r) => {
        const date = r.date > today ? today : r.date;
        const image = URL.createObjectURL(r.previewBlob ?? r.imageBlob);
        objectUrlsRef.current.set(r.id, image);
        imageBlobsRef.current.set(r.id, r.imageBlob);
        return {
          id: r.id,
          title: r.title,
          date,
          image,
          offsetXDays: r.offsetXDays ?? 0,
          offsetY: r.offsetY ?? 0,
          note: r.note,
        };
      });
      setPersonalPhotos(photos);

      for (const r of records) {
        if (cancelled) break;
        if (r.previewBlob) continue;
        try {
          const previewBlob = await generatePreviewBlob(r.imageBlob);
          if (cancelled) return;
          await updatePhotoPreview(r.id, previewBlob);
          if (cancelled) return;
          const oldUrl = objectUrlsRef.current.get(r.id);
          if (oldUrl) URL.revokeObjectURL(oldUrl);
          const newImage = URL.createObjectURL(previewBlob);
          objectUrlsRef.current.set(r.id, newImage);
          setPersonalPhotos((prev) =>
            prev.map((p) => (p.id === r.id ? { ...p, image: newImage } : p))
          );
        } catch {
          /* keep original */
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const urls: Record<string, string> = {};
    const createdBlobUrls: string[] = [];
    historicalEvents.forEach((e) => {
      if (e.previewBlob) {
        const url = URL.createObjectURL(e.previewBlob);
        urls[e.id] = url;
        createdBlobUrls.push(url);
      } else if (e.thumbnailUrl) {
        const cached = thumbnailUrlCacheRef.current.get(e.id);
        if (cached) {
          urls[e.id] = cached;
        }
      }
    });
    setHistoricalImageUrls((prev) => {
      Object.entries(prev).forEach(([id, u]) => {
        const stillNeeded = id in urls && urls[id] === u;
        const isCached = thumbnailUrlCacheRef.current.get(id) === u;
        if (!stillNeeded && !isCached) {
          URL.revokeObjectURL(u);
        }
      });
      return urls;
    });
    return () => {
      createdBlobUrls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [historicalEvents]);

  useEffect(() => {
    let cancelled = false;
    const toFetch = historicalEvents.filter(
      (e) =>
        e.thumbnailUrl &&
        !e.previewBlob &&
        !thumbnailUrlCacheRef.current.has(e.id)
    );
    toFetch.forEach(async (e) => {
      if (cancelled) return;
      try {
        const res = await fetch(e.thumbnailUrl!, { mode: "cors" });
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        if (cancelled) return;
        const blobUrl = URL.createObjectURL(blob);
        thumbnailUrlCacheRef.current.set(e.id, blobUrl);
        setHistoricalImageUrls((prev) =>
          prev[e.id] ? prev : { ...prev, [e.id]: blobUrl }
        );
      } catch {
        /* ignore */
      }
    });
    return () => {
      cancelled = true;
    };
  }, [historicalEvents]);

  useEffect(() => {
    setCenterDate((prev) => clampCenterToToday(prev, scale));
  }, [scale]);

  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlsRef.current.clear();
      thumbnailUrlCacheRef.current.forEach((url) => URL.revokeObjectURL(url));
      thumbnailUrlCacheRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (overlayUrlRef.current) {
      URL.revokeObjectURL(overlayUrlRef.current);
      overlayUrlRef.current = null;
    }
    if (overlayPhotoId) {
      const blob = imageBlobsRef.current.get(overlayPhotoId);
      if (blob) {
        const url = URL.createObjectURL(blob);
        overlayUrlRef.current = url;
        setOverlayUrl(url);
      } else {
        setOverlayUrl(null);
      }
    } else {
      setOverlayUrl(null);
    }
    return () => {
      if (overlayUrlRef.current) {
        URL.revokeObjectURL(overlayUrlRef.current);
        overlayUrlRef.current = null;
      }
    };
  }, [overlayPhotoId]);

  useEffect(() => {
    const onWheel = (e: WheelEvent) => e.preventDefault();
    document.addEventListener("wheel", onWheel, { passive: false });
    return () => document.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    visiblePhotoIdsRef.current = visiblePhotoIds;
    visibleHistIdsRef.current = visibleHistIds;
  }, [visiblePhotoIds, visibleHistIds]);

  useEffect(() => {
    const fireScrollStop = () => {
      const photoIds = visiblePhotoIdsRef.current;
      const histIds = visibleHistIdsRef.current;
      const candidates = new Set<string>();
      [...photoIds, ...histIds].forEach((id) => {
        if (!seenInViewportRef.current.has(id)) candidates.add(id);
      });
      candidates.forEach((id) => seenInViewportRef.current.add(id));
      if (candidates.size > 0) {
        setAnimatedLines((prev) => {
          const next = new Set(prev);
          candidates.forEach((id) => next.add(id));
          return next;
        });
      }
    };
    const schedule = () => {
      if (scrollStopTimerRef.current) clearTimeout(scrollStopTimerRef.current);
      scrollStopTimerRef.current = setTimeout(() => {
        scrollStopTimerRef.current = null;
        fireScrollStop();
      }, SCROLL_STOP_DEBOUNCE_MS);
    };
    scheduleScrollStopRef.current = schedule;
    const el = timelineRef.current;
    if (!el) return;
    schedule();
    el.addEventListener("wheel", schedule);
    const onMove = () => schedule();
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onMove);
    return () => {
      el.removeEventListener("wheel", schedule);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onMove);
      if (scrollStopTimerRef.current) clearTimeout(scrollStopTimerRef.current);
    };
  }, []);

  const [altHeld, setAltHeld] = useState(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey) setAltHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!e.altKey) {
        setAltHeld(false);
        setCardDragging(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  const effectiveCenter = useMemo(
    () => clampCenterToToday(centerDate, scale),
    [centerDate, scale]
  );

  const axisDates = useMemo(() => {
    const halfRange = scaleMeta[scale].rangeDays / 2;
    const centerMs = effectiveCenter.getTime();
    const halfMs = halfRange * MS_IN_DAY;
    return {
      start: new Date(centerMs - halfMs),
      mid: new Date(centerMs),
      end: new Date(centerMs + halfMs),
    };
  }, [effectiveCenter, scale]);

  const axisTicks = useMemo(() => {
    const { start, end } = axisDates;
    const startMs = start.getTime();
    const endMs = end.getTime();
    const rangeMs = endMs - startMs;
    const ticks: { date: Date; percent: number; isMajor: boolean }[] = [];
    const d = new Date(start);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    while (d.getTime() <= endMs) {
      const ms = d.getTime();
      if (ms >= startMs) {
        const percent = (rangeMs > 0 ? (ms - startMs) / rangeMs : 0) * 100;
        ticks.push({
          date: new Date(d),
          percent,
          isMajor: d.getMonth() === 0,
        });
      }
      d.setMonth(d.getMonth() + 1);
    }
    return ticks;
  }, [axisDates]);

  useEffect(() => {
    runHistoryIngest();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const { start, end } = axisDates;
    const rangeDays = scaleMeta[scale].rangeDays;
    const overscanDays = Math.min(90, Math.floor(rangeDays / 2));
    const overscanMs = overscanDays * MS_IN_DAY;
    const fetchStart = new Date(start.getTime() - overscanMs);
    const fetchEnd = new Date(end.getTime() + overscanMs);
    const startISO = fetchStart.toISOString().slice(0, 10);
    const endISO = fetchEnd.toISOString().slice(0, 10);
    (async () => {
      const events = await getHistoricalEventsInRange(startISO, endISO);
      if (!cancelled) setHistoricalEvents(events);
    })();
    return () => {
      cancelled = true;
    };
  }, [axisDates, scale]);

  const positionedPersonal = useMemo((): PositionedPhoto[] => {
    if (!layoutInfo) return [];
    const { width } = layoutInfo;
    const rangeDays = scaleMeta[scale].rangeDays;
    const pxPerDay = width / rangeDays;
    const axisStart = axisDates.start;
    const maxOffset = MAX_OFFSET_DAYS[scale];

    const withPosition = personalPhotos
      .map((photo) => {
        const active = getActiveOffsets(photo.id);
        const offsetXDays = Math.max(
          -maxOffset,
          Math.min(maxOffset, active.offsetXDays)
        );
        let xPx = dateToX(photo.date, axisStart, pxPerDay);
        xPx += offsetXDays * pxPerDay;
        return {
          ...photo,
          xPx,
          offsetXDays,
          offsetY: active.offsetY,
        };
      })
      .filter((p) => p.xPx >= -50 && p.xPx <= width + 50)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    const hasManualOffset = (p: (typeof withPosition)[0]) =>
      Math.abs(p.offsetY) > EPS || Math.abs(p.offsetXDays) > EPS;
    const autoLayout = withPosition.filter((p) => !hasManualOffset(p));
    const manualLayout = withPosition.filter(hasManualOffset);

    const lanes: number[] = [];
    const assignLane = (p: (typeof withPosition)[0]): number => {
      const cardWidthPx = (CARD_WIDTH_PERCENT / 100) * width;
      for (let i = 0; ; i++) {
        const lastX = lanes[i];
        const overlaps =
          lastX !== undefined && Math.abs(p.xPx - lastX) < cardWidthPx;
        if (!overlaps) {
          lanes[i] = p.xPx;
          return i;
        }
      }
    };

    return [
      ...autoLayout.map((p) => ({ ...p, laneIndex: assignLane(p) })),
      ...manualLayout.map((p) => ({ ...p, laneIndex: 0, isManual: true })),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }, [
    personalPhotos,
    layoutInfo,
    scale,
    axisDates,
    pendingOffsets,
  ]);

  const historicalWithLanes = useMemo(() => {
    if (import.meta.env.DEV) {
      console.debug("[layout] historicalWithLanes recompute", {
        eventCount: historicalEvents.length,
      });
    }
    return assignHistoricalLanes(historicalEvents);
  }, [historicalEvents]);

  const positionedHistorical = useMemo((): PositionedHistorical[] => {
    if (import.meta.env.DEV) {
      console.debug("[layout] historical recompute", {
        deps: { historicalWithLanes: historicalWithLanes.length, layoutInfo: !!layoutInfo, scale, axisDates },
      });
    }
    if (!layoutInfo) return [];
    const { width, axisY } = layoutInfo;
    const rangeDays = scaleMeta[scale].rangeDays;
    const pxPerDay = width / rangeDays;
    const axisStart = axisDates.start;
    const minImportance = getMinImportanceForScale(scale);
    const showCompactOnly = scale === "30d" || scale === "60d" || scale === "90d";
    const isCompactOnlyFile = (f: string) => /[-_]2\./.test(f); // *-2.tsv or *_2.tsv: only 30d/60d/90d

    const filtered = historicalWithLanes.filter((e) => {
      if (isCompactOnlyFile(e.sourceFile) && !showCompactOnly) return false;
      return (e.importance ?? 3) >= minImportance;
    });

    const overscanPx = width * 1.5;
    const xMin = -overscanPx;
    const xMax = width + overscanPx;

    return filtered
      .map((e) => {
        const xPx = dateToX(e.date, axisStart, pxPerDay);
        const laneIdx = Math.min(e.laneIndex, MAX_LANES - 1);
        const yTop =
          axisY +
          AXIS_GAP +
          laneIdx * HIST_LANE_HEIGHT;
        const topRelativeToZone = yTop - HIST_ARTICLE_OFFSET - axisY;
        return {
          ...e,
          xPx,
          yTop,
          topRelativeToZone,
        };
      })
      .filter((e) => e.xPx >= xMin && e.xPx <= xMax);
  }, [
    historicalWithLanes,
    layoutInfo,
    scale,
    axisDates,
  ]);

  const measureLayout = useCallback(() => {
    const timeline = timelineRef.current;
    const axis = axisRef.current;
    if (!timeline || !axis) return;

    const tlRect = timeline.getBoundingClientRect();
    const axisRect = axis.getBoundingClientRect();
    const axisY = axisRect.top - tlRect.top + axisRect.height / 2;

    setLayoutInfo((prev) => {
      if (
        prev &&
        prev.width === tlRect.width &&
        prev.height === tlRect.height &&
        prev.axisY === axisY
      )
        return prev;
      return { width: tlRect.width, height: tlRect.height, axisY };
    });
  }, []);

  useLayoutEffect(() => {
    measureLayout();
  }, [measureLayout, scale, centerDate]);

  useEffect(() => {
    window.addEventListener("resize", measureLayout);
    return () => window.removeEventListener("resize", measureLayout);
  }, [measureLayout]);

  useLayoutEffect(() => {
    const personalIds = new Set(positionedPersonal.map((p) => p.id));
    const histIds = new Set(positionedHistorical.map((e) => e.id));
    const root = timelineRef.current;
    if (!root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePhotoIds((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const el = e.target as HTMLElement;
            const id =
              el.getAttribute("data-event-id") ??
              el.closest("[data-event-id]")?.getAttribute("data-event-id");
            if (!id) continue;
            if (personalIds.has(id)) {
              if (e.isIntersecting) next.add(id);
              else next.delete(id);
            }
          }
          return next;
        });
        setVisibleHistIds((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const el = e.target as HTMLElement;
            const id =
              el.getAttribute("data-event-id") ??
              el.closest("[data-event-id]")?.getAttribute("data-event-id");
            if (!id) continue;
            if (histIds.has(id)) {
              if (e.isIntersecting) next.add(id);
              else next.delete(id);
            }
          }
          return next;
        });
      },
      { root, rootMargin: "0px", threshold: 0.1 }
    );

    positionedPersonal.forEach((p) => {
      const el = personalCardRefs.current.get(p.id);
      if (el) observer.observe(el);
    });
    positionedHistorical.forEach((e) => {
      const el = historicalCardRefs.current.get(e.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [positionedPersonal, positionedHistorical]);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    const axis = axisRef.current;
    if (!timeline || !layoutInfo) return;

    const { width, axisY } = layoutInfo;
    const tlRect = timeline.getBoundingClientRect();
    const axisRect = axis!.getBoundingClientRect();
    const axisYActual = axisRect.top - tlRect.top + axisRect.height / 2;

    const lines: { id: string; path: string; totalLength: number }[] = [];

    const rangeDays = scaleMeta[scale].rangeDays;
    const pxPerDay = width / rangeDays;
    const axisStart = axisDates.start;
    const xEventForDate = (date: string) =>
      dateToX(date, axisStart, pxPerDay);

    for (const photo of positionedPersonal) {
      if (!visiblePhotoIds.has(photo.id)) continue;
      if (cardDragging === photo.id) continue;
      if (isDirty(photo.id)) continue;
      const card = personalCardRefs.current.get(photo.id);
      if (!card) continue;

      const cardRect = card.getBoundingClientRect();
      const cardLeft = cardRect.left - tlRect.left;
      const cardBottom = cardRect.top - tlRect.top + cardRect.height;
      const cardWidth = cardRect.width;
      const pos = getAnchorPosition(photo.id);
      const anchorPct = pos === "left" ? 0 : pos === "center" ? 0.5 : 1;
      const anchorX = cardLeft + cardWidth * anchorPct;
      const xEvent = xEventForDate(photo.date) + photo.offsetXDays * pxPerDay;

      const { path, totalLength } = computeLinePath(
        anchorX,
        cardBottom,
        xEvent,
        axisYActual,
        true
      );
      lines.push({ id: photo.id, path, totalLength });
    }

    for (const ev of positionedHistorical) {
      if (!visibleHistIds.has(ev.id)) continue;
      const card = historicalCardRefs.current.get(ev.id);
      if (!card) continue;

      const cardRect = card.getBoundingClientRect();
      const cardLeft = cardRect.left - tlRect.left;
      const cardWidth = cardRect.width;
      const pos = getAnchorPosition(ev.id);
      const anchorPct = pos === "left" ? 0 : pos === "center" ? 0.5 : 1;
      const anchorX = cardLeft + cardWidth * anchorPct;
      const xEvent = xEventForDate(ev.date);

      const { path, totalLength } = computeLinePath(
        anchorX,
        ev.yTop,
        xEvent,
        axisYActual,
        false
      );
      lines.push({ id: ev.id, path, totalLength });
    }

    setLinesData(lines);
  }, [
    positionedPersonal,
    positionedHistorical,
    visiblePhotoIds,
    visibleHistIds,
    layoutInfo,
    scale,
    axisDates,
    pendingOffsets,
    cardDragging,
  ]);

  const resetLineAnimation = (id: string) => {
    seenInViewportRef.current.delete(id);
    setAnimatedLines((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    scheduleScrollStopRef.current();
  };

  const handleAddPhoto = (file: File, date: string, caption: string) => {
    const safeDate = date > todayStr() ? todayStr() : date;
    const id = `photo-${Date.now()}`;
    imageBlobsRef.current.set(id, file);
    generatePreviewBlob(file)
      .then((previewBlob) => {
        const record: PhotoRecord = {
          id,
          title: caption || "Фото",
          date: safeDate,
          type: "personal",
          imageBlob: file,
          previewBlob,
          offsetY: 0,
          offsetXDays: 0,
        };
        return savePhoto(record).then(() => {
          const image = URL.createObjectURL(previewBlob);
          objectUrlsRef.current.set(id, image);
          setPersonalPhotos((prev) => [
            ...prev,
            {
              id,
              title: record.title,
              date: record.date,
              image,
              offsetXDays: 0,
              offsetY: 0,
              note: record.note,
            },
          ]);
        });
      })
      .catch(() => {
        const record: PhotoRecord = {
          id,
          title: caption || "Фото",
          date: safeDate,
          type: "personal",
          imageBlob: file,
          offsetY: 0,
          offsetXDays: 0,
        };
        savePhoto(record).then(() => {
          const image = URL.createObjectURL(file);
          objectUrlsRef.current.set(id, image);
          setPersonalPhotos((prev) => [
            ...prev,
            {
              id,
              title: record.title,
              date: record.date,
              image,
              offsetXDays: 0,
              offsetY: 0,
              note: record.note,
            },
          ]);
        });
      });
  };

  const handleConfirmOffsets = (id: string) => {
    const pend = pendingOffsets[id];
    if (!pend) return;
    setCardDragging(null);
    setPersonalPhotos((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, offsetXDays: pend.offsetXDays, offsetY: pend.offsetY } : p
      )
    );
    updatePhotoOffsets(id, pend.offsetY, pend.offsetXDays).catch(() => {});
    setPendingOffsets((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    resetLineAnimation(id);
  };

  const handleCancelOffsets = (id: string) => {
    setCardDragging(null);
    setPendingOffsets((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    resetLineAnimation(id);
  };

  const handleDeletePhoto = (id: string) => {
    if (!window.confirm("Удалить фото? Это действие нельзя отменить.")) return;
    setCardDragging(null);
    const url = objectUrlsRef.current.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      objectUrlsRef.current.delete(id);
    }
    imageBlobsRef.current.delete(id);
    if (overlayPhotoId === id) setOverlayPhotoId(null);
    setPendingOffsets((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    deletePhoto(id).then(() => {
      setPersonalPhotos((prev) => prev.filter((p) => p.id !== id));
    });
  };

  const onWheel: React.WheelEventHandler<HTMLDivElement> = (e) => {
    e.preventDefault();
    const direction = e.deltaY > 0 ? 1 : -1;
    setScaleIndex((current) => {
      const next = current + direction;
      if (next < 0 || next >= scales.length) return current;
      return next;
    });
  };

  const onTimelineMouseDown: React.MouseEventHandler<HTMLDivElement> = (e) => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest(".card-image") && !e.altKey) return;
    const histCard = target.closest(".event-historical");
    if (histCard) {
      e.preventDefault();
      e.stopPropagation();
      const id = histCard.getAttribute("data-event-id");
      const ev = positionedHistorical.find((x) => x.id === id);
      if (ev) setSelectedHistoricalEvent(ev);
      return;
    }
    const photoCard = target.closest(".event-personal.event-photo");
    if (e.altKey && photoCard) {
      const id = photoCard.getAttribute("data-event-id");
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        const ev = personalPhotos.find((p) => p.id === id);
        if (ev) {
          setCardDragging(id);
          const active = getActiveOffsets(id);
          cardDragRef.current = {
            id,
            startX: e.clientX,
            startY: e.clientY,
            startOffsetXDays: active.offsetXDays,
            startOffsetY: active.offsetY,
          };
          cardDragLastRef.current = {
            offsetXDays: active.offsetXDays,
            offsetY: active.offsetY,
          };
        }
      }
      return;
    }
    setIsDragging(true);
    dragRef.current = {
      startX: e.clientX,
      startCenterMs: effectiveCenter.getTime(),
    };
  };

  useEffect(() => {
    if (!isDragging) return;
    const el = timelineRef.current;
    if (!el) return;
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const { startX, startCenterMs } = dragRef.current;
      const width = el.offsetWidth;
      const halfRange = scaleMeta[scale].rangeDays / 2;
      const rangeMs = halfRange * 2 * MS_IN_DAY;
      const deltaX = e.clientX - startX;
      const deltaMs = (deltaX / width) * rangeMs;
      setCenterDate(
        clampCenterToToday(new Date(startCenterMs - deltaMs), scale)
      );
    };
    const onMouseUp = () => {
      setIsDragging(false);
      dragRef.current = null;
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDragging, scale]);

  useEffect(() => {
    if (!cardDragging || !cardDragRef.current) return;
    const el = timelineRef.current;
    if (!el) return;
    const maxOffset = MAX_OFFSET_DAYS[scale];
    const rangeDays = scaleMeta[scale].rangeDays;
    const onMouseMove = (e: MouseEvent) => {
      if (!cardDragRef.current) return;
      const { id, startX, startY, startOffsetXDays, startOffsetY } =
        cardDragRef.current;
      const width = el.offsetWidth;
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      const deltaDays = (deltaX / width) * rangeDays;
      const rawX = startOffsetXDays + deltaDays;
      const offsetXDays =
        Math.round(
          Math.max(-maxOffset, Math.min(maxOffset, rawX)) * 10
        ) / 10;
      const offsetY = startOffsetY + deltaY;
      cardDragLastRef.current = { offsetXDays, offsetY };
      setPendingOffsets((prev) => ({ ...prev, [id]: { offsetXDays, offsetY } }));
    };
    const onMouseUp = () => {
      if (!cardDragRef.current) return;
      const { id } = cardDragRef.current;
      const last = cardDragLastRef.current;
      const offsetXDays =
        last?.offsetXDays ?? cardDragRef.current.startOffsetXDays;
      const offsetY = last?.offsetY ?? cardDragRef.current.startOffsetY;
      setPendingOffsets((prev) => ({ ...prev, [id]: { offsetXDays, offsetY } }));
      cardDragRef.current = null;
      cardDragLastRef.current = null;
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [cardDragging, scale]);

  return (
    <div className="page" onWheel={onWheel}>
      <header className="top-bar">
        <h1>Timeline MVP</h1>
        <div className="top-bar-right">
          <button
            type="button"
            className="btn-add-photo"
            onClick={() => setModalOpen(true)}
          >
            + Добавить фото
          </button>
          <div className="scale">Scale: {scaleMeta[scale].label}</div>
        </div>
      </header>

      {modalOpen && (
        <AddPhotoModal
          onClose={() => setModalOpen(false)}
          onSubmit={handleAddPhoto}
        />
      )}

      {overlayPhotoId && (
        <PersonalPhotoModal
          photo={
            (() => {
              const p = personalPhotos.find((x) => x.id === overlayPhotoId);
              return p
                ? { id: p.id, title: p.title, date: p.date, note: p.note }
                : null;
            })()
          }
          imageUrl={overlayUrl}
          isOpen={true}
          onClose={() => setOverlayPhotoId(null)}
          onSave={(id, note) => {
            updatePhotoNote(id, note).then(() => {
              setPersonalPhotos((prev) =>
                prev.map((p) => (p.id === id ? { ...p, note } : p))
              );
            });
          }}
        />
      )}

      <HistoricalEventModal
        event={selectedHistoricalEvent}
        isOpen={selectedHistoricalEvent != null}
        onClose={() => setSelectedHistoricalEvent(null)}
        getLocalImageUrl={getLocalImageUrl}
        historicalImageUrls={historicalImageUrls}
      />

      <main
        ref={timelineRef}
        className={`timeline ${isDragging ? "timeline-dragging" : ""}`}
        onMouseDown={onTimelineMouseDown}
      >
        <div ref={axisRef} className="axis">
          {axisTicks.map((t) => (
            <div
              key={t.date.getTime()}
              className={`axis-tick axis-tick-${t.isMajor ? "major" : "minor"}`}
              style={{ left: `${t.percent}%` }}
            />
          ))}
          <span className="axis-date axis-date-start">
            {formatAxisDate(axisDates.start, scale)}
          </span>
          <span className="axis-date axis-date-mid">
            {formatAxisDate(axisDates.mid, scale)}
          </span>
          <span className="axis-date axis-date-end">
            {formatAxisDate(axisDates.end, scale)}
          </span>
        </div>

        <svg className="timeline-lines-overlay" aria-hidden>
          {linesData.map((line) => (
            <MarkerLink
              key={line.id}
              path={line.path}
              totalLength={line.totalLength}
              animate={animatedLines.has(line.id)}
            />
          ))}
        </svg>

        {layoutInfo && (
          <>
            <PersonalLayer
              photos={positionedPersonal}
              axisY={layoutInfo.axisY}
              cardRefsMap={personalCardRefs}
              cardDragging={cardDragging}
              pendingOffsets={pendingOffsets}
              getActiveOffsets={getActiveOffsets}
              isDirty={isDirty}
              altHeld={altHeld}
              onDelete={handleDeletePhoto}
              onConfirmOffsets={handleConfirmOffsets}
              onCancelOffsets={handleCancelOffsets}
              onOverlayOpen={setOverlayPhotoId}
            />
            <div
              className="historical-zone"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: layoutInfo.axisY,
                height: HIST_ZONE_HEIGHT,
                overflow: "visible",
              }}
            >
              <HistoricalLayer
                events={positionedHistorical}
                axisY={layoutInfo.axisY}
                cardRefsMap={historicalCardRefs}
                getLocalImageUrl={getLocalImageUrl}
                historicalImageUrls={historicalImageUrls}
              />
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
