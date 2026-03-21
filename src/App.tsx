import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  assignPersonalLaneIndex,
  deletePhoto,
  getAllPhotos,
  getPhoto,
  getAllSeries,
  getHistoricalEventsInRange,
  savePhoto,
  saveSeries,
  updatePhotoOffsets,
  updatePhotoMetadata,
  updatePhotoImage,
  updatePhotoSeriesId,
  updatePhotoPreview,
  type PhotoRecord,
  type SeriesRecord,
} from "./db";
import type { HistoricalEvent } from "./history/types";
import { runHistoryIngest } from "./history/ingestHistory";
import { generatePreviewBlob } from "./imagePreview";
import { dateToX, computeLinePath, getBaseDate } from "./timelineUtils";
import { MarkerLink } from "./MarkerLink";
import { getLocalImageUrl } from "./history/localPics";
import { getMainEventIds } from "./history/mainEvents";
import {
  PersonalLayer,
  type PersonalPhoto,
  type PositionedPhoto,
  type Offsets,
} from "./PersonalLayer";
import {
  HistoricalLayer,
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
  "30d": { label: "30 дней", rangeDays: 30 },
  "60d": { label: "60 дней", rangeDays: 60 },
  "90d": { label: "90 дней", rangeDays: 90 },
  "1y": { label: "1 год", rangeDays: 365 },
  "2y": { label: "2 года", rangeDays: 730 },
  "5y": { label: "5 лет", rangeDays: 1825 },
  "10y": { label: "10 лет", rangeDays: 3650 },
};

const MS_IN_DAY = 24 * 60 * 60 * 1000;
const LANE_HEIGHT = 140;
const PERSONAL_BASE_Y_OFFSET = 120;
const PERSONAL_LANE_HEIGHT = 160;
/** Card: width 120, image 4:3 = 90, title ~40 */
const PERSONAL_CARD_HEIGHT = 130;
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

const LAYERS = [
  { id: "main", title: "Основные мировые события" },
  { id: "culture", title: "Культура и искусство" },
  { id: "autos", title: "Автомобили" },
] as const;

const TIMELINE_STATE_KEY = "timeline-mvp-state";

type PersistedTimelineState = {
  scaleIndex?: number;
  centerDate?: string;
  visibleLayers?: string[];
};

function loadTimelineState(): PersistedTimelineState {
  try {
    const raw = localStorage.getItem(TIMELINE_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedTimelineState;
    return parsed;
  } catch {
    return {};
  }
}

function saveTimelineState(partial: Partial<PersistedTimelineState>): void {
  try {
    const current = loadTimelineState();
    const merged = { ...current, ...partial };
    localStorage.setItem(TIMELINE_STATE_KEY, JSON.stringify(merged));
  } catch {
    /* ignore */
  }
}

function getEventLayerId(event: { sourceFile: string }): string {
  const f = event.sourceFile.toLowerCase().replace(/\\/g, "/");
  if (f.includes("culture") || f.includes("культура")) return "culture";
  if (f.includes("autos/") || f.startsWith("autos/")) return "autos";
  return "main";
}

type GotoDateModalProps = {
  initialDate?: string;
  onClose: () => void;
  onGoToDate: (dateStr: string) => void;
};

type LayersModalProps = {
  visibleLayers: Set<string>;
  onToggle: (layerId: string) => void;
  onClose: () => void;
};

function LayersModal({ visibleLayers, onToggle, onClose }: LayersModalProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Слои</h2>
        <div className="modal-field" style={{ flexDirection: "column", gap: 8 }}>
          {LAYERS.map((layer) => (
            <label key={layer.id} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={visibleLayers.has(layer.id)}
                onChange={() => onToggle(layer.id)}
              />
              <span>{layer.title}</span>
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}

function GotoDateModal({ initialDate = todayStr(), onClose, onGoToDate }: GotoDateModalProps) {
  const [date, setDate] = useState(initialDate);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onGoToDate(date);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Перейти к дате</h2>
        <form onSubmit={handleSubmit}>
          <div className="modal-field">
            <label>Дата</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              max={todayStr()}
              autoFocus
            />
          </div>
          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              Отмена
            </button>
            <button type="submit">Перейти</button>
          </div>
        </form>
      </div>
    </div>
  );
}

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
  const persisted = useMemo(loadTimelineState, []);

  const [scaleIndex, setScaleIndex] = useState(() => {
    const i = persisted.scaleIndex;
    if (typeof i === "number" && i >= 0 && i < scales.length) return i;
    return 2;
  });
  const [personalPhotos, setPersonalPhotos] = useState<PersonalPhoto[]>([]);
  const [historicalEvents, setHistoricalEvents] = useState<HistoricalEvent[]>([]);
  const [layoutInfo, setLayoutInfo] = useState<{
    width: number;
    height: number;
    axisY: number;
  } | null>(null);
  const objectUrlsRef = useRef<Map<string, string>>(new Map());
  const imageBlobsRef = useRef<Map<string, Blob>>(new Map());
  const overlayUrlRef = useRef<string | null>(null);
  const overlayPhotoIdRef = useRef<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [gotoDateModalOpen, setGotoDateModalOpen] = useState(false);
  const [layersModalOpen, setLayersModalOpen] = useState(false);
  const [visibleLayers, setVisibleLayers] = useState<Set<string>>(() => {
    const ids = LAYERS.map((l) => l.id) as string[];
    const saved = persisted.visibleLayers;
    if (Array.isArray(saved) && saved.length > 0) {
      const valid = saved.filter((id) => ids.includes(id));
      if (valid.length > 0) return new Set(valid);
    }
    return new Set(ids);
  });
  const [overlayPhotoId, setOverlayPhotoId] = useState<string | null>(null);
  const [overlayUrl, setOverlayUrl] = useState<string | null>(null);
  const [overlayEditMode, setOverlayEditMode] = useState(false);
  const [linkingMode, setLinkingMode] = useState(false);
  const [linkingSourcePhotoId, setLinkingSourcePhotoId] = useState<string | null>(
    null
  );
  const [hoveredPhotoId, setHoveredPhotoId] = useState<string | null>(null);
  const [hoveredSeriesId, setHoveredSeriesId] = useState<string | null>(null);
  const hoverSeriesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [seriesMap, setSeriesMap] = useState<Record<string, string>>({});
  const [selectedHistoricalEvent, setSelectedHistoricalEvent] =
    useState<HistoricalEvent | null>(null);
  const [centerDate, setCenterDate] = useState(() => {
    const s = persisted.centerDate;
    const scaleIdx = typeof persisted.scaleIndex === "number" && persisted.scaleIndex >= 0 && persisted.scaleIndex < scales.length
      ? persisted.scaleIndex
      : 2;
    const scaleForClamp = scales[scaleIdx] as Scale;
    if (typeof s === "string") {
      const d = new Date(s);
      if (!isNaN(d.getTime())) return clampCenterToToday(d, scaleForClamp);
    }
    return clampCenterToToday(new Date(), scaleForClamp);
  });
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
  const [mainEventIds, setMainEventIds] = useState<Set<string>>(new Set());
  const [mainEventAnimatedIds, setMainEventAnimatedIds] = useState<Set<string>>(new Set());
  const [linesData, setLinesData] = useState<
    { id: string; path: string; totalLength: number; lineVariant?: string }[]
  >([]);
  const [mainMarkersData, setMainMarkersData] = useState<
    { id: string; xPx: number; yAxis: number; yCardTop: number; scale: "10y" | "5y" | "small" }[]
  >([]);
  const seenInViewportRef = useRef<Set<string>>(new Set());
  const visiblePhotoIdsRef = useRef<Set<string>>(new Set());
  const visibleHistIdsRef = useRef<Set<string>>(new Set());
  const scrollStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleScrollStopRef = useRef<() => void>(() => {});
  const centerDateRef = useRef(centerDate);
  const saveStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [liftedHistId, setLiftedHistId] = useState<string | null>(null);
  const hoverLiftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const loadPhotosFromDb = useCallback(async () => {
    const records = await getAllPhotos();
    const today = todayStr();
    const photos: PersonalPhoto[] = records.map((r) => {
      const date = r.date > today ? today : r.date;
      const showOnTimeline = r.showOnTimeline !== false;
      if (showOnTimeline) {
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
          laneIndex: r.laneIndex,
          note: r.note,
          showOnTimeline: true,
          seriesId: r.seriesId,
        };
      }
      return {
        id: r.id,
        title: r.title,
        date,
        image: "",
        offsetXDays: r.offsetXDays ?? 0,
        offsetY: r.offsetY ?? 0,
        laneIndex: r.laneIndex,
        note: r.note,
        showOnTimeline: false,
        seriesId: r.seriesId,
      };
    });
    setPersonalPhotos(photos);

    for (const r of records) {
      if (r.showOnTimeline === false) continue;
      if (r.previewBlob) continue;
      try {
        const previewBlob = await generatePreviewBlob(r.imageBlob);
        await updatePhotoPreview(r.id, previewBlob);
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
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadPhotosFromDb().catch((err) => {
      if (!cancelled) console.error("[photos] load failed", err);
    });
    return () => {
      cancelled = true;
    };
  }, [loadPhotosFromDb]);

  useEffect(() => {
    getAllSeries().then((series) => {
      const map: Record<string, string> = {};
      series.forEach((s) => {
        map[s.id] = s.title;
      });
      setSeriesMap(map);
    });
  }, []);

  useEffect(() => {
    setCenterDate((prev) => clampCenterToToday(prev, scale));
  }, [scale]);

  centerDateRef.current = centerDate;

  useEffect(() => {
    saveTimelineState({
      scaleIndex,
      visibleLayers: Array.from(visibleLayers),
    });
  }, [scaleIndex, visibleLayers]);

  useEffect(() => {
    if (saveStateTimerRef.current) clearTimeout(saveStateTimerRef.current);
    saveStateTimerRef.current = setTimeout(() => {
      saveStateTimerRef.current = null;
      saveTimelineState({
        centerDate: centerDate.toISOString().slice(0, 10),
      });
    }, 400);
    return () => {
      if (saveStateTimerRef.current) clearTimeout(saveStateTimerRef.current);
    };
  }, [centerDate]);

  useEffect(() => {
    const onBeforeUnload = () => {
      saveTimelineState({
        scaleIndex,
        centerDate: centerDateRef.current.toISOString().slice(0, 10),
        visibleLayers: Array.from(visibleLayers),
      });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [scaleIndex, visibleLayers]);

  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlsRef.current.clear();
    };
  }, []);

  const loadSecondaryPhotoBlob = useCallback(async (id: string) => {
    if (imageBlobsRef.current.has(id)) return;
    const record = await getPhoto(id);
    if (!record) return;
    const url = URL.createObjectURL(record.imageBlob);
    objectUrlsRef.current.set(id, url);
    imageBlobsRef.current.set(id, record.imageBlob);
    setPersonalPhotos((prev) =>
      prev.map((p) => (p.id === id ? { ...p, image: url } : p))
    );
  }, []);

  useEffect(() => {
    overlayPhotoIdRef.current = overlayPhotoId;
  }, [overlayPhotoId]);

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
        const id = overlayPhotoId;
        getPhoto(id).then((record) => {
          if (!record || overlayPhotoIdRef.current !== id) return;
          const blob = imageBlobsRef.current.get(id);
          if (blob) return;
          const url = URL.createObjectURL(record.imageBlob);
          imageBlobsRef.current.set(id, record.imageBlob);
          overlayUrlRef.current = url;
          setOverlayUrl(url);
          setPersonalPhotos((prev) =>
            prev.map((p) => (p.id === id ? { ...p, image: url } : p))
          );
        });
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
    if (!overlayPhotoId) return;
    const current = personalPhotos.find((p) => p.id === overlayPhotoId);
    if (!current) return;
    const dayIds = personalPhotos
      .filter((p) => p.date === current.date)
      .map((p) => p.id);
    const seriesIds = current.seriesId
      ? personalPhotos
          .filter((p) => p.seriesId === current.seriesId)
          .map((p) => p.id)
      : [];
    const toLoad = [...new Set([...dayIds, ...seriesIds])].filter(
      (id) => !imageBlobsRef.current.has(id)
    );
    toLoad.forEach((id) => loadSecondaryPhotoBlob(id));
  }, [overlayPhotoId, personalPhotos, loadSecondaryPhotoBlob]);

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".personal-modal-overlay, .modal-overlay, .historical-modal-overlay")) {
        return;
      }
      e.preventDefault();
    };
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
    if (hoverSeriesTimerRef.current) {
      clearTimeout(hoverSeriesTimerRef.current);
      hoverSeriesTimerRef.current = null;
    }
    if (!hoveredPhotoId) {
      setHoveredSeriesId(null);
      return;
    }
    const photo = personalPhotos.find((p) => p.id === hoveredPhotoId);
    if (!photo?.seriesId) {
      setHoveredSeriesId(null);
      return;
    }
    hoverSeriesTimerRef.current = setTimeout(() => {
      hoverSeriesTimerRef.current = null;
      setHoveredSeriesId(photo.seriesId ?? null);
    }, 1000);
    return () => {
      if (hoverSeriesTimerRef.current) {
        clearTimeout(hoverSeriesTimerRef.current);
      }
    };
  }, [hoveredPhotoId, personalPhotos]);

  const isPhotoDimmed = useCallback(
    (photoId: string): boolean => {
      if (!hoveredSeriesId) return false;
      const photo = personalPhotos.find((p) => p.id === photoId);
      return !photo || photo.seriesId !== hoveredSeriesId;
    },
    [hoveredSeriesId, personalPhotos]
  );

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

  const isTimelineEraArchive = useMemo(() => {
    const year = effectiveCenter.getFullYear();
    return year >= 1800 && year <= 1950;
  }, [effectiveCenter]);

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

  const [ingestVersion, setIngestVersion] = useState(0);
  const [ingestRefreshing, setIngestRefreshing] = useState(false);
  useEffect(() => {
    runHistoryIngest().finally(() => setIngestVersion((v) => v + 1));
  }, []);

  const handleRefreshTimeline = useCallback(async () => {
    setIngestRefreshing(true);
    try {
      await runHistoryIngest();
      setIngestVersion((v) => v + 1);
    } finally {
      setIngestRefreshing(false);
    }
  }, []);

  useEffect(() => {
    getMainEventIds().then(setMainEventIds);
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
  }, [axisDates, scale, ingestVersion]);

  const photosForTimeline = useMemo(
    () => personalPhotos.filter((p) => p.showOnTimeline !== false),
    [personalPhotos]
  );

  const positionedPersonal = useMemo((): PositionedPhoto[] => {
    if (!layoutInfo) return [];
    const { width } = layoutInfo;
    const rangeDays = scaleMeta[scale].rangeDays;
    const pxPerDay = width / rangeDays;
    const axisStart = axisDates.start;
    const maxOffset = MAX_OFFSET_DAYS[scale];

    const withPosition = photosForTimeline
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
          laneIndex: photo.laneIndex ?? 0,
        };
      })
      .filter((p) => p.xPx >= -50 && p.xPx <= width + 50)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    return withPosition;
  }, [
    photosForTimeline,
    layoutInfo,
    scale,
    axisDates,
    pendingOffsets,
  ]);

  const seriesBadgePosition = useMemo((): { left: number; top: number; align: "above" | "left" | "right" } | null => {
    if (!hoveredSeriesId || !layoutInfo) return null;
    const seriesPhotos = positionedPersonal.filter((p) => p.seriesId === hoveredSeriesId);
    if (seriesPhotos.length === 0) return null;
    const baseY = layoutInfo.axisY - PERSONAL_BASE_Y_OFFSET;
    const SAFE_TOP = 48;
    const GAP = 12;
    let minX = Infinity;
    let maxX = -Infinity;
    let minCardTop = Infinity;
    let maxCardBottom = -Infinity;
    for (const p of seriesPhotos) {
      const offsetY = getActiveOffsets(p.id).offsetY;
      const y = baseY - (p.laneIndex ?? 0) * PERSONAL_LANE_HEIGHT + offsetY;
      const cardTop = y - PERSONAL_CARD_HEIGHT;
      const cardBottom = y;
      minX = Math.min(minX, p.xPx - 60);
      maxX = Math.max(maxX, p.xPx + 60);
      minCardTop = Math.min(minCardTop, cardTop);
      maxCardBottom = Math.max(maxCardBottom, cardBottom);
    }
    const centerX = (minX + maxX) / 2;
    const centerY = (minCardTop + maxCardBottom) / 2;
    const spaceAbove = minCardTop - GAP;
    if (spaceAbove >= SAFE_TOP) {
      return { left: centerX, top: minCardTop - GAP, align: "above" };
    }
    const leftEdge = minX - GAP;
    const rightEdge = maxX + GAP;
    const { width } = layoutInfo;
    if (leftEdge >= 80) {
      return { left: leftEdge, top: centerY, align: "left" };
    }
    if (rightEdge <= width - 80) {
      return { left: rightEdge, top: centerY, align: "right" as const };
    }
    return { left: centerX, top: Math.max(SAFE_TOP, centerY - 20), align: "above" };
  }, [hoveredSeriesId, layoutInfo, positionedPersonal, pendingOffsets, personalPhotos]);

  /** Use stored laneIndex — never recalculate (assigned at ingest) */
  const historicalWithLanes = useMemo(() => {
    return historicalEvents.map((e) => ({
      ...e,
      laneIndex: e.laneIndex ?? 0,
    }));
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

    const withPos = filtered
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

    const OVERLAP_OFFSET_PX = 25;
    const byDate = new Map<string, (typeof withPos)[number][]>();
    for (const ev of withPos) {
      const baseDate = getBaseDate(ev.date);
      const list = byDate.get(baseDate) ?? [];
      list.push(ev);
      byDate.set(baseDate, list);
    }
    const overlapIds = new Set<string>();
    for (const list of byDate.values()) {
      if (list.length < 3) continue;
      const byLane = new Map<number, (typeof list)[number][]>();
      for (const ev of list) {
        const laneList = byLane.get(ev.laneIndex) ?? [];
        laneList.push(ev);
        byLane.set(ev.laneIndex, laneList);
      }
      for (const laneList of byLane.values()) {
        if (laneList.length < 2) continue;
        const sorted = [...laneList].sort((a, b) => a.id.localeCompare(b.id));
        overlapIds.add(sorted[0].id);
      }
    }

    return withPos.map((e) =>
      overlapIds.has(e.id) ? { ...e, overlapOffsetY: OVERLAP_OFFSET_PX } : e
    );
  }, [
    historicalWithLanes,
    layoutInfo,
    scale,
    axisDates,
  ]);

  const visiblePositionedHistorical = useMemo(
    () => positionedHistorical.filter((e) => visibleLayers.has(getEventLayerId(e))),
    [positionedHistorical, visibleLayers]
  );

  const toggleLayer = useCallback((layerId: string) => {
    setVisibleLayers((prev) => {
      const next = new Set(prev);
      if (next.has(layerId)) next.delete(layerId);
      else next.add(layerId);
      return next;
    });
  }, []);

  const histIdsSet = useMemo(
    () => new Set(visiblePositionedHistorical.map((e) => e.id)),
    [visiblePositionedHistorical]
  );

  const onHistoricalZoneMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (hoverLiftTimerRef.current) {
        clearTimeout(hoverLiftTimerRef.current);
        hoverLiftTimerRef.current = null;
      }
      const elements = document.elementsFromPoint(e.clientX, e.clientY);
      const articlesAtPoint: string[] = [];
      for (const el of elements) {
        const article = (el as HTMLElement).closest?.(".event-historical[data-event-id]");
        if (article) {
          const id = article.getAttribute("data-event-id");
          if (id && histIdsSet.has(id) && !articlesAtPoint.includes(id)) {
            articlesAtPoint.push(id);
          }
        }
      }
      const bottomId = articlesAtPoint[articlesAtPoint.length - 1];
      if (bottomId) {
        hoverLiftTimerRef.current = setTimeout(() => {
          hoverLiftTimerRef.current = null;
          setLiftedHistId(bottomId);
        }, 500);
      }
    },
    [histIdsSet]
  );

  const onHistoricalZoneMouseLeave = useCallback(() => {
    if (hoverLiftTimerRef.current) {
      clearTimeout(hoverLiftTimerRef.current);
      hoverLiftTimerRef.current = null;
    }
    setLiftedHistId(null);
  }, []);

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
    const histIds = new Set(visiblePositionedHistorical.map((e) => e.id));
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
    visiblePositionedHistorical.forEach((e) => {
      const el = historicalCardRefs.current.get(e.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [positionedPersonal, visiblePositionedHistorical]);

  useEffect(() => {
    if (scale !== "10y" && scale !== "5y") return;
    setMainEventAnimatedIds((prev) => {
      const next = new Set<string>();
      for (const id of visibleHistIds) {
        if (mainEventIds.has(id)) next.add(id);
      }
      if (next.size !== prev.size || [...next].some((id) => !prev.has(id)))
        return next;
      return prev;
    });
  }, [visibleHistIds, mainEventIds, scale]);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    const axis = axisRef.current;
    if (!timeline || !layoutInfo) return;

    const { width } = layoutInfo;
    const tlRect = timeline.getBoundingClientRect();
    const axisRect = axis!.getBoundingClientRect();
    const axisYActual = axisRect.top - tlRect.top + axisRect.height / 2;

    const lines: { id: string; path: string; totalLength: number; lineVariant?: "normal" | "dim-10y" | "dim-5y" }[] = [];
    const rangeDays = scaleMeta[scale].rangeDays;
    const pxPerDay = width / rangeDays;
    const axisStart = axisDates.start;
    const xEventForDate = (date: string) =>
      dateToX(date, axisStart, pxPerDay);

    for (const photo of positionedPersonal) {
      if (!visiblePhotoIds.has(photo.id)) continue;
      if (cardDragging === photo.id) continue;
      if (isDirty(photo.id)) continue;
      if (hoveredSeriesId && (!photo.seriesId || photo.seriesId !== hoveredSeriesId)) continue;
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
      lines.push({ id: photo.id, path, totalLength, lineVariant: "normal" });
    }

    const mainMarkers: { id: string; xPx: number; yAxis: number; yCardTop: number; scale: "10y" | "5y" | "small" }[] = [];

    for (const ev of visiblePositionedHistorical) {
      if (!visibleHistIds.has(ev.id)) continue;
      const card = historicalCardRefs.current.get(ev.id);
      if (!card) continue;

      const cardRect = card.getBoundingClientRect();
      const cardLeft = cardRect.left - tlRect.left;
      const cardTop = cardRect.top - tlRect.top;
      const cardWidth = cardRect.width;
      const pos = getAnchorPosition(ev.id);
      const anchorPct = pos === "left" ? 0 : pos === "center" ? 0.5 : 1;
      const anchorX = cardLeft + cardWidth * anchorPct;
      const xEvent = xEventForDate(ev.date);

      const isMain = mainEventIds.has(ev.id);

      if (isMain) {
        const markerScale =
          scale === "10y" ? "10y" : scale === "5y" ? "5y" : "small";
        mainMarkers.push({
          id: ev.id,
          xPx: xEvent,
          yAxis: axisYActual,
          yCardTop: cardTop,
          scale: markerScale,
        });
        continue;
      }

      const { path, totalLength } = computeLinePath(
        anchorX,
        cardTop,
        xEvent,
        axisYActual,
        false
      );
      const lineVariant =
        scale === "10y"
          ? "dim-10y"
          : scale === "5y"
            ? "dim-5y"
            : "normal";
      lines.push({ id: ev.id, path, totalLength, lineVariant });
    }

    setLinesData(lines);
    setMainMarkersData(mainMarkers);
  }, [
    positionedPersonal,
    visiblePositionedHistorical,
    visiblePhotoIds,
    visibleHistIds,
    layoutInfo,
    scale,
    axisDates,
    pendingOffsets,
    cardDragging,
    mainEventIds,
    hoveredSeriesId,
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
        return getAllPhotos().then((all) => {
          const newRecord: PhotoRecord = {
            id,
            title: caption || "Фото",
            date: safeDate,
            type: "personal",
            imageBlob: file,
            previewBlob,
            offsetY: 0,
            offsetXDays: 0,
          };
          const withLanes = assignPersonalLaneIndex([
            ...all,
            { ...newRecord, showOnTimeline: true },
          ]);
          const assigned = withLanes.find((r) => r.id === id);
          newRecord.laneIndex = assigned?.laneIndex ?? 0;
          return savePhoto(newRecord).then(() => {
            const image = URL.createObjectURL(previewBlob);
            objectUrlsRef.current.set(id, image);
            setPersonalPhotos((prev) => [
              ...prev,
              {
                id,
                title: newRecord.title,
                date: newRecord.date,
                image,
                offsetXDays: 0,
                offsetY: 0,
                laneIndex: newRecord.laneIndex,
                note: newRecord.note,
              },
            ]);
          });
        });
      })
      .catch(() => {
        getAllPhotos().then((all) => {
          const newRecord: PhotoRecord = {
            id,
            title: caption || "Фото",
            date: safeDate,
            type: "personal",
            imageBlob: file,
            offsetY: 0,
            offsetXDays: 0,
          };
          const withLanes = assignPersonalLaneIndex([
            ...all,
            { ...newRecord, showOnTimeline: true },
          ]);
          const assigned = withLanes.find((r) => r.id === id);
          newRecord.laneIndex = assigned?.laneIndex ?? 0;
          savePhoto(newRecord).then(() => {
            const image = URL.createObjectURL(file);
            objectUrlsRef.current.set(id, image);
            setPersonalPhotos((prev) => [
              ...prev,
              {
                id,
                title: newRecord.title,
                date: newRecord.date,
                image,
                offsetXDays: 0,
                offsetY: 0,
                laneIndex: newRecord.laneIndex,
                note: newRecord.note,
              },
            ]);
          });
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

  const photosInDay = useMemo(() => {
    if (!overlayPhotoId) return [];
    const current = personalPhotos.find((p) => p.id === overlayPhotoId);
    if (!current) return [];
    return personalPhotos
      .filter((p) => p.date === current.date)
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [overlayPhotoId, personalPhotos]);

  const photosInSeries = useMemo(() => {
    if (!overlayPhotoId) return [];
    const current = personalPhotos.find((p) => p.id === overlayPhotoId);
    if (!current?.seriesId) return [];
    return personalPhotos
      .filter((p) => p.seriesId === current.seriesId)
      .sort((a, b) => {
        const d = new Date(a.date).getTime() - new Date(b.date).getTime();
        return d !== 0 ? d : a.id.localeCompare(b.id);
      });
  }, [overlayPhotoId, personalPhotos]);

  const seriesTitle = useMemo(() => {
    const current = personalPhotos.find((p) => p.id === overlayPhotoId);
    if (!current?.seriesId) return null;
    return seriesMap[current.seriesId] ?? null;
  }, [overlayPhotoId, personalPhotos, seriesMap]);

  const handleOverlayClose = useCallback(() => {
    setOverlayPhotoId(null);
    setOverlayEditMode(false);
    setLinkingMode(false);
    setLinkingSourcePhotoId(null);
  }, []);

  const handleStartLinking = useCallback(() => {
    const sourceId = overlayPhotoId;
    setOverlayPhotoId(null);
    setOverlayEditMode(false);
    setLinkingMode(true);
    setLinkingSourcePhotoId(sourceId);
  }, [overlayPhotoId]);

  const handleCancelLink = useCallback(() => {
    setLinkingMode(false);
    setLinkingSourcePhotoId(null);
    setOverlayPhotoId(null);
  }, []);

  useEffect(() => {
    if (!linkingMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleCancelLink();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [linkingMode, handleCancelLink]);

  const handleConfirmLink = useCallback(
    async (targetPhotoId: string, chosenSeriesId: string | null) => {
      const sourceId = linkingSourcePhotoId;
      if (!sourceId) return;
      const sourcePhoto = personalPhotos.find((p) => p.id === sourceId);
      const targetPhoto = personalPhotos.find((p) => p.id === targetPhotoId);
      if (!sourcePhoto || !targetPhoto) return;

      const sourceSeries = sourcePhoto.seriesId;
      const targetSeries = targetPhoto.seriesId;

      if (sourceSeries && targetSeries && sourceSeries !== targetSeries) {
        alert(
          "Оба фото уже в разных сериях. Объединение серий пока не поддерживается. Сначала отвяжите одно из фото от серии."
        );
        return;
      }

      setLinkingMode(false);
      setLinkingSourcePhotoId(null);
      setOverlayPhotoId(null);

      let seriesId: string;
      if (chosenSeriesId) {
        seriesId = chosenSeriesId;
      } else {
        const title =
          prompt("Название новой группы:", "Я и Саня")?.trim() ?? "Серия";
        seriesId = `series-${Date.now()}`;
        await saveSeries({ id: seriesId, title });
        setSeriesMap((prev) => ({ ...prev, [seriesId]: title }));
      }

      try {
        await updatePhotoSeriesId(sourceId, seriesId);
        await updatePhotoSeriesId(targetPhotoId, seriesId);
      } catch (err) {
        console.error("[link] DB update failed", err);
        alert("Ошибка сохранения связи. Попробуйте ещё раз.");
        return;
      }

      await loadPhotosFromDb();
    },
    [linkingSourcePhotoId, personalPhotos, loadPhotosFromDb]
  );

  const handleOverlaySave = useCallback(
    (
      id: string,
      data: { date: string; title: string; note: string }
    ) => {
      updatePhotoMetadata(id, data).then(() => {
        setPersonalPhotos((prev) =>
          prev.map((p) =>
            p.id === id
              ? { ...p, date: data.date, title: data.title, note: data.note }
              : p
          )
        );
        setOverlayEditMode(false);
      });
    },
    []
  );

  const handleReplaceImage = useCallback(
    (id: string, file: File) => {
      generatePreviewBlob(file)
        .then((previewBlob) => {
          return updatePhotoImage(id, file, previewBlob).then(() => {
            const url = objectUrlsRef.current.get(id);
            if (url) URL.revokeObjectURL(url);
            const newUrl = URL.createObjectURL(previewBlob);
            objectUrlsRef.current.set(id, newUrl);
            imageBlobsRef.current.set(id, file);
            setPersonalPhotos((prev) =>
              prev.map((p) => (p.id === id ? { ...p, image: newUrl } : p))
            );
            if (overlayPhotoId === id) {
              setOverlayUrl(newUrl);
            }
          });
        })
        .catch(() => {
          updatePhotoImage(id, file).then(() => {
            const url = objectUrlsRef.current.get(id);
            if (url) URL.revokeObjectURL(url);
            const newUrl = URL.createObjectURL(file);
            objectUrlsRef.current.set(id, newUrl);
            imageBlobsRef.current.set(id, file);
            setPersonalPhotos((prev) =>
              prev.map((p) => (p.id === id ? { ...p, image: newUrl } : p))
            );
            if (overlayPhotoId === id) {
              setOverlayUrl(newUrl);
            }
          });
        });
    },
    [overlayPhotoId]
  );

  const handleAddPhotoToDay = useCallback(
    (file: File) => {
      const current = personalPhotos.find((p) => p.id === overlayPhotoId);
      if (!current) return;
      const safeDate =
        current.date > todayStr() ? todayStr() : current.date;
      const id = `photo-${Date.now()}`;
      imageBlobsRef.current.set(id, file);
      generatePreviewBlob(file)
        .then((previewBlob) => {
          return getAllPhotos().then((all) => {
            const newRecord: PhotoRecord = {
              id,
              title: "Фото",
              date: safeDate,
              type: "personal",
              imageBlob: file,
              previewBlob,
              offsetY: 0,
              offsetXDays: 0,
              showOnTimeline: false,
            };
            const withLanes = assignPersonalLaneIndex([
              ...all,
              { ...newRecord, showOnTimeline: true },
            ]);
            const assigned = withLanes.find((r) => r.id === id);
            newRecord.laneIndex = assigned?.laneIndex ?? 0;
            return savePhoto(newRecord).then(() => {
              const image = URL.createObjectURL(previewBlob);
              objectUrlsRef.current.set(id, image);
              setPersonalPhotos((prev) => [
                ...prev,
                {
                  id,
                  title: newRecord.title,
                  date: newRecord.date,
                  image,
                  offsetXDays: 0,
                  offsetY: 0,
                  laneIndex: newRecord.laneIndex,
                  note: newRecord.note,
                  showOnTimeline: false,
                },
              ]);
              setOverlayPhotoId(id);
              setOverlayUrl(image);
            });
          });
        })
        .catch(() => {
          getAllPhotos().then((all) => {
            const newRecord: PhotoRecord = {
              id,
              title: "Фото",
              date: safeDate,
              type: "personal",
              imageBlob: file,
              offsetY: 0,
              offsetXDays: 0,
              showOnTimeline: false,
            };
            const withLanes = assignPersonalLaneIndex([
              ...all,
              { ...newRecord, showOnTimeline: true },
            ]);
            const assigned = withLanes.find((r) => r.id === id);
            newRecord.laneIndex = assigned?.laneIndex ?? 0;
            savePhoto(newRecord).then(() => {
              const image = URL.createObjectURL(file);
              objectUrlsRef.current.set(id, image);
              setPersonalPhotos((prev) => [
                ...prev,
                {
                  id,
                  title: newRecord.title,
                  date: newRecord.date,
                  image,
                  offsetXDays: 0,
                  offsetY: 0,
                  laneIndex: newRecord.laneIndex,
                  note: newRecord.note,
                  showOnTimeline: false,
                },
              ]);
              setOverlayPhotoId(id);
              setOverlayUrl(image);
            });
          });
        });
    },
    [overlayPhotoId, personalPhotos]
  );

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

  const handleDeleteAllPhotosInDay = useCallback(() => {
    if (!overlayPhotoId) return;
    const current = personalPhotos.find((p) => p.id === overlayPhotoId);
    if (!current) return;
    const toDelete = personalPhotos.filter((p) => p.date === current.date);
    if (toDelete.length === 0) return;
    const msg =
      toDelete.length === 1
        ? "Удалить фото? Это действие нельзя отменить."
        : `Удалить все ${toDelete.length} фото этого дня? Это действие нельзя отменить.`;
    if (!window.confirm(msg)) return;
    setCardDragging(null);
    setOverlayPhotoId(null);
    toDelete.forEach((p) => {
      const url = objectUrlsRef.current.get(p.id);
      if (url) {
        URL.revokeObjectURL(url);
        objectUrlsRef.current.delete(p.id);
      }
      imageBlobsRef.current.delete(p.id);
    });
    setPendingOffsets((prev) => {
      const next = { ...prev };
      toDelete.forEach((p) => delete next[p.id]);
      return next;
    });
    Promise.all(toDelete.map((p) => deletePhoto(p.id))).then(() => {
      const ids = new Set(toDelete.map((p) => p.id));
      setPersonalPhotos((prev) => prev.filter((p) => !ids.has(p.id)));
    });
  }, [overlayPhotoId, personalPhotos]);

  const onWheel: React.WheelEventHandler<HTMLDivElement> = (e) => {
    if (overlayPhotoId || modalOpen || linkingMode) {
      const target = e.target as HTMLElement;
      if (target.closest(".personal-modal-overlay, .modal-overlay")) {
        return;
      }
      e.preventDefault();
      return;
    }
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
    scheduleScrollStopRef.current();
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
            className="top-bar-btn"
            onClick={() => setGotoDateModalOpen(true)}
          >
            Перейти к дате
          </button>
          <button
            type="button"
            className="top-bar-btn"
            onClick={() => setLayersModalOpen(true)}
          >
            Слои
          </button>
          <button
            type="button"
            className="top-bar-btn"
            onClick={handleRefreshTimeline}
            disabled={ingestRefreshing}
          >
            {ingestRefreshing ? "Загрузка…" : "Обновить таймлайн"}
          </button>
          <button
            type="button"
            className="top-bar-btn"
            onClick={() => setModalOpen(true)}
          >
            + Добавить фото
          </button>
          <div className="scale">Масштаб: {scaleMeta[scale].label}</div>
        </div>
      </header>

      {modalOpen && (
        <AddPhotoModal
          onClose={() => setModalOpen(false)}
          onSubmit={handleAddPhoto}
        />
      )}

      {gotoDateModalOpen && (
        <GotoDateModal
          initialDate={centerDate.toISOString().slice(0, 10)}
          onClose={() => setGotoDateModalOpen(false)}
          onGoToDate={(dateStr) => {
            const d = new Date(dateStr);
            setCenterDate(clampCenterToToday(d, scale));
            setGotoDateModalOpen(false);
          }}
        />
      )}

      {layersModalOpen && (
        <LayersModal
          visibleLayers={visibleLayers}
          onToggle={toggleLayer}
          onClose={() => setLayersModalOpen(false)}
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
          photosInDay={photosInDay.map((p) => ({
            id: p.id,
            title: p.title,
            date: p.date,
            note: p.note,
          }))}
          imageUrl={overlayUrl}
          isOpen={true}
          isEditMode={overlayEditMode}
          isLinkingMode={linkingMode}
          linkingSourcePhotoId={linkingSourcePhotoId}
          onClose={handleOverlayClose}
          onEdit={() => setOverlayEditMode(true)}
          onSave={handleOverlaySave}
          onReplaceImage={handleReplaceImage}
          onAddPhotoToDay={handleAddPhotoToDay}
          onNavigate={setOverlayPhotoId}
          photosInSeries={photosInSeries.map((p) => ({
            id: p.id,
            image: p.image,
            date: p.date,
            title: p.title,
          }))}
          seriesTitle={seriesTitle}
          onStartLinking={handleStartLinking}
          onConfirmLink={handleConfirmLink}
          onCancelLink={handleCancelLink}
          onCloseLinkPrompt={() => setOverlayPhotoId(null)}
          existingSeries={Object.entries(seriesMap).map(([id, title]) => ({
            id,
            title,
          }))}
          onDeletePhoto={handleDeletePhoto}
          onDeleteAllPhotosInDay={handleDeleteAllPhotosInDay}
        />
      )}

      {linkingMode && !overlayPhotoId && (
        <div className="linking-mode-banner">
          <span>Режим связывания. Нажмите на другое фото на таймлайне.</span>
          <button
            type="button"
            className="linking-mode-cancel"
            onClick={handleCancelLink}
          >
            Отмена
          </button>
        </div>
      )}

      <HistoricalEventModal
        event={selectedHistoricalEvent}
        isOpen={selectedHistoricalEvent != null}
        onClose={() => setSelectedHistoricalEvent(null)}
        getLocalImageUrl={getLocalImageUrl}
      />

      <main
        ref={timelineRef}
        className={`timeline ${isDragging ? "timeline-dragging" : ""} ${isTimelineEraArchive ? "timeline-era-archive" : ""}`.trim()}
        onMouseDown={onTimelineMouseDown}
      >
        <div ref={axisRef} className="axis timelineAxis">
          {axisTicks.map((t) => (
            <div
              key={t.date.getTime()}
              className={`axis-tick timelineTick axis-tick-${t.isMajor ? "major" : "minor"}`}
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

        {hoveredSeriesId && seriesMap[hoveredSeriesId] && seriesBadgePosition && (
          <div
            className="series-title-badge"
            aria-hidden
            style={{
              left: `${seriesBadgePosition.left}px`,
              top: `${seriesBadgePosition.top}px`,
              transform:
                seriesBadgePosition.align === "above"
                  ? "translate(-50%, -100%)"
                  : seriesBadgePosition.align === "left"
                    ? "translate(-100%, -50%)"
                    : "translateY(-50%)",
            }}
          >
            {seriesMap[hoveredSeriesId]}
          </div>
        )}

        <svg className="timeline-lines-overlay" aria-hidden>
          {linesData.map((line) => (
            <MarkerLink
              key={line.id}
              path={line.path}
              totalLength={line.totalLength}
              animate={animatedLines.has(line.id)}
              lineVariant={line.lineVariant as "normal" | "dim-10y" | "dim-5y" | undefined}
            />
          ))}
        </svg>

        {mainMarkersData.length > 0 && (
          <svg className="main-markers-overlay" aria-hidden>
            {mainMarkersData.map((m) => {
              const shouldAnimate = (scale === "10y" || scale === "5y") && m.scale !== "small";
              const isAnimated = mainEventAnimatedIds.has(m.id);
              const lineLength = Math.abs(m.yCardTop - m.yAxis);
              const animateIn = shouldAnimate && isAnimated;
              const showInitial = shouldAnimate && !isAnimated;
              return (
                <g
                  key={m.id}
                  className={
                    showInitial
                      ? "main-marker main-marker-initial"
                      : animateIn
                        ? "main-marker main-marker-animated"
                        : "main-marker"
                  }
                >
                  <line
                    x1={m.xPx}
                    y1={m.yAxis}
                    y2={m.yCardTop}
                    x2={m.xPx}
                    className={`main-marker-line main-marker-line-${m.scale}`}
                    style={
                      shouldAnimate
                        ? {
                            strokeDasharray: lineLength,
                            strokeDashoffset: isAnimated ? 0 : lineLength,
                          }
                        : undefined
                    }
                  />
                  <circle
                    cx={m.xPx}
                    cy={m.yCardTop}
                    r={m.scale === "10y" ? 4 : 3}
                    className="main-marker-dot main-marker-dot-card"
                  />
                  <circle
                    cx={m.xPx}
                    cy={m.yAxis}
                    r={m.scale === "10y" ? 4 : 3}
                    className="main-marker-dot main-marker-dot-axis"
                  />
                </g>
              );
            })}
          </svg>
        )}

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
              onConfirmOffsets={handleConfirmOffsets}
              onCancelOffsets={handleCancelOffsets}
              onOverlayOpen={setOverlayPhotoId}
              onPhotoHover={setHoveredPhotoId}
              isPhotoDimmed={isPhotoDimmed}
            />
            {!linkingMode && (
              <div
                className={`historical-zone ${scale !== "10y" && scale !== "5y" ? "historical-zone-all-color" : ""}`.trim()}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: layoutInfo.axisY,
                  height: HIST_ZONE_HEIGHT,
                  overflow: "visible",
                }}
                onMouseMove={onHistoricalZoneMouseMove}
                onMouseLeave={onHistoricalZoneMouseLeave}
              >
                <HistoricalLayer
                events={visiblePositionedHistorical}
                axisY={layoutInfo.axisY}
                cardRefsMap={historicalCardRefs}
                getLocalImageUrl={getLocalImageUrl}
                mainEventIds={mainEventIds}
                mainEffectMode={
                  scale === "10y" ? "10y" : "5y"
                }
                dimNonMain={scale === "10y" || scale === "5y"}
                openEventId={selectedHistoricalEvent?.id ?? null}
                mainEventAnimatedIds={mainEventAnimatedIds}
                shouldAnimateMain={scale === "10y" || scale === "5y"}
                liftedHistId={liftedHistId}
                isTimelineEraArchive={isTimelineEraArchive}
              />
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

export default App;
