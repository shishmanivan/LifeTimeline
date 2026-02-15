import { useEffect, useMemo, useRef, useState } from "react";
import eventsData from "./data/events.json";
import {
  deletePhoto,
  getAllPhotos,
  savePhoto,
  updatePhotoOffsets,
  updatePhotoPreview,
} from "./db";
import { generatePreviewBlob } from "./imagePreview";

type Scale = "30d" | "90d" | "1y" | "2y" | "5y" | "10y";
type EventType = "personal" | "historical";

type TimelineEvent = {
  id: string;
  title: string;
  date: string;
  type: EventType;
  imageUrl?: string;
  offsetY?: number;
  offsetXDays?: number;
};

const scales: Scale[] = ["30d", "90d", "1y", "2y", "5y", "10y"];

const scaleMeta: Record<Scale, { label: string; rangeDays: number }> = {
  "30d": { label: "30 days", rangeDays: 30 },
  "90d": { label: "90 days", rangeDays: 90 },
  "1y": { label: "1 year", rangeDays: 365 },
  "2y": { label: "2 years", rangeDays: 730 },
  "5y": { label: "5 years", rangeDays: 1825 },
  "10y": { label: "10 years", rangeDays: 3650 }
};

const MS_IN_DAY = 24 * 60 * 60 * 1000;
const CARD_WIDTH_PERCENT = 18;
const LANE_HEIGHT = 140;
const EPS = 0.01;

type Offsets = { offsetXDays: number; offsetY: number };

const MAX_OFFSET_DAYS: Record<Scale, number> = {
  "30d": 3,
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
  const [personalPhotos, setPersonalPhotos] = useState<TimelineEvent[]>([]);
  const objectUrlsRef = useRef<Map<string, string>>(new Map());
  const imageBlobsRef = useRef<Map<string, Blob>>(new Map());
  const overlayUrlRef = useRef<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [overlayPhotoId, setOverlayPhotoId] = useState<string | null>(null);
  const [overlayUrl, setOverlayUrl] = useState<string | null>(null);
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
  const cardDragLastRef = useRef<{ offsetXDays: number; offsetY: number } | null>(
    null
  );
  const timelineRef = useRef<HTMLDivElement>(null);
  const scale = scales[scaleIndex];
  const staticEvents = eventsData as TimelineEvent[];
  const events = useMemo(
    () => [...staticEvents, ...personalPhotos],
    [staticEvents, personalPhotos]
  );

  const getActiveOffsets = (id: string): Offsets => {
    const pend = pendingOffsets[id];
    if (pend) return pend;
    const p = personalPhotos.find((x) => x.id === id);
    return {
      offsetXDays: p?.offsetXDays ?? 0,
      offsetY: p?.offsetY ?? 0,
    };
  };
  useEffect(() => {
    let cancelled = false;
    getAllPhotos().then(async (records) => {
      if (cancelled) return;
      const today = todayStr();
      const events: TimelineEvent[] = records.map((r) => {
        const date = r.date > today ? today : r.date;
        const displayBlob = r.previewBlob ?? r.imageBlob;
        const imageUrl = URL.createObjectURL(displayBlob);
        objectUrlsRef.current.set(r.id, imageUrl);
        imageBlobsRef.current.set(r.id, r.imageBlob);
        return {
          id: r.id,
          title: r.title,
          date,
          type: "personal",
          imageUrl,
          offsetY: r.offsetY ?? 0,
          offsetXDays: r.offsetXDays ?? 0,
        };
      });
      setPersonalPhotos(events);

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
          const newUrl = URL.createObjectURL(previewBlob);
          objectUrlsRef.current.set(r.id, newUrl);
          setPersonalPhotos((prev) =>
            prev.map((p) =>
              p.id === r.id ? { ...p, imageUrl: newUrl } : p
            )
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
    setCenterDate((prev) => clampCenterToToday(prev, scale));
  }, [scale]);

  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlsRef.current.clear();
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

  const [altHeld, setAltHeld] = useState(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey) setAltHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!e.altKey) setAltHeld(false);
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

  const positionedEvents = useMemo(() => {
    const halfRange = scaleMeta[scale].rangeDays / 2;
    const rangeDays = scaleMeta[scale].rangeDays;
    const centerMs = effectiveCenter.getTime();
    const maxOffset = MAX_OFFSET_DAYS[scale];

    const withPosition = events
      .map((event) => {
        const eventMs = new Date(event.date).getTime();
        const diffDays = (eventMs - centerMs) / MS_IN_DAY;
        const ratio = diffDays / halfRange;
        let xPercent = 50 + ratio * 50;

        const active = getActiveOffsets(event.id);
        const offsetXDays = Math.max(
          -maxOffset,
          Math.min(maxOffset, active.offsetXDays)
        );
        const offsetXPercent = (offsetXDays / rangeDays) * 100;
        xPercent += offsetXPercent;

        return {
          ...event,
          xPercent,
          diffDays,
          offsetXDays,
          offsetY: active.offsetY,
        };
      })
      .filter((event) => event.xPercent >= 0 && event.xPercent <= 100)
      .sort((a, b) => a.diffDays - b.diffDays);

    const personal = withPosition.filter((e) => e.type === "personal");
    const historical = withPosition.filter((e) => e.type !== "personal");

    const hasManualOffset = (ev: (typeof withPosition)[0]) =>
      ev.type === "personal" &&
      (Math.abs(ev.offsetY ?? 0) > EPS || Math.abs(ev.offsetXDays ?? 0) > EPS);

    const autoLayout = personal.filter((e) => !hasManualOffset(e));
    const manualLayout = personal.filter(hasManualOffset);

    const lanes: number[][] = [];
    const assignLane = (ev: (typeof withPosition)[0]): number => {
      for (let laneIdx = 0; ; laneIdx++) {
        const lane = lanes[laneIdx] ?? [];
        const overlaps = lane.some(
          (x) => Math.abs(x - ev.xPercent) < CARD_WIDTH_PERCENT
        );
        if (!overlaps) {
          if (!lanes[laneIdx]) lanes[laneIdx] = [];
          lanes[laneIdx].push(ev.xPercent);
          return laneIdx;
        }
      }
    };

    const personalWithLanes = [
      ...autoLayout.map((ev) => ({ ...ev, laneIndex: assignLane(ev) })),
      ...manualLayout.map((ev) => ({ ...ev, laneIndex: 0, isManual: true })),
    ];
    const historicalWithLanes = historical.map((ev) => ({
      ...ev,
      laneIndex: 0,
    }));

    return [...personalWithLanes, ...historicalWithLanes].sort(
      (a, b) => a.diffDays - b.diffDays
    );
  }, [events, scale, effectiveCenter, pendingOffsets, personalPhotos]);

  const handleAddPhoto = (file: File, date: string, caption: string) => {
    const safeDate = date > todayStr() ? todayStr() : date;
    const id = `photo-${Date.now()}`;
    imageBlobsRef.current.set(id, file);
    generatePreviewBlob(file)
      .then((previewBlob) => {
        const record = {
          id,
          title: caption || "Фото",
          date: safeDate,
          type: "personal" as const,
          imageBlob: file,
          previewBlob,
          offsetY: 0,
          offsetXDays: 0,
        };
        return savePhoto(record).then(() => {
          const imageUrl = URL.createObjectURL(previewBlob);
          objectUrlsRef.current.set(id, imageUrl);
          setPersonalPhotos((prev) => [
            ...prev,
            {
              id,
              title: record.title,
              date: record.date,
              type: "personal",
              imageUrl,
              offsetY: 0,
              offsetXDays: 0,
            },
          ]);
        });
      })
      .catch(() => {
        const record = {
          id,
          title: caption || "Фото",
          date: safeDate,
          type: "personal" as const,
          imageBlob: file,
          offsetY: 0,
          offsetXDays: 0,
        };
        savePhoto(record).then(() => {
          const imageUrl = URL.createObjectURL(file);
          objectUrlsRef.current.set(id, imageUrl);
          setPersonalPhotos((prev) => [
            ...prev,
            {
              id,
              title: record.title,
              date: record.date,
              type: "personal",
              imageUrl,
              offsetY: 0,
              offsetXDays: 0,
            },
          ]);
        });
      });
  };

  const handleConfirmOffsets = (id: string) => {
    const pend = pendingOffsets[id];
    if (!pend) return;
    setPersonalPhotos((prev) =>
      prev.map((p) =>
        p.id === id
          ? { ...p, offsetXDays: pend.offsetXDays, offsetY: pend.offsetY }
          : p
      )
    );
    updatePhotoOffsets(id, pend.offsetY, pend.offsetXDays).catch(() => {});
    setPendingOffsets((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const handleCancelOffsets = (id: string) => {
    setPendingOffsets((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const handleDeletePhoto = (id: string) => {
    if (!window.confirm("Удалить фото? Это действие нельзя отменить.")) return;
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

  const onWheel: React.WheelEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault();
    const direction = event.deltaY > 0 ? 1 : -1;

    setScaleIndex((current) => {
      const next = current + direction;
      if (next < 0 || next >= scales.length) {
        return current;
      }
      return next;
    });
  };

  const onTimelineMouseDown: React.MouseEventHandler<HTMLDivElement> = (e) => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest(".card-image") && !e.altKey) return;
    const photoCard = target.closest(".event-photo");
    if (e.altKey && photoCard) {
      const id = photoCard.getAttribute("data-event-id");
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        const ev = personalPhotos.find((p) => p.id === id);
        if (ev) {
          setCardDragging(id);
          const active = getActiveOffsets(id);
          const startOffsetXDays = active.offsetXDays;
          const startOffsetY = active.offsetY;
          cardDragRef.current = {
            id,
            startX: e.clientX,
            startY: e.clientY,
            startOffsetXDays,
            startOffsetY,
          };
          cardDragLastRef.current = { offsetXDays: startOffsetXDays, offsetY: startOffsetY };
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
      const offsetXDays = Math.round(
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
      setPendingOffsets((prev) => ({
        ...prev,
        [id]: { offsetXDays, offsetY },
      }));
      setCardDragging(null);
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
        <div
          className="overlay"
          onClick={() => setOverlayPhotoId(null)}
        >
          {overlayUrl && (
            <img
              src={overlayUrl}
              alt=""
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      )}

      <main
        ref={timelineRef}
        className={`timeline ${isDragging ? "timeline-dragging" : ""}`}
        onMouseDown={onTimelineMouseDown}
      >
        <div className="axis">
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

        {positionedEvents.map((event) => (
          <article
            key={event.id}
            data-event-id={event.id}
            className={`event ${event.type} ${event.imageUrl ? "event-photo" : ""} ${cardDragging === event.id ? "event-photo-dragging" : ""} ${altHeld && event.imageUrl ? "event-photo-grab" : ""}`}
            style={{
              left: `${event.xPercent}%`,
              ...(event.type === "personal" && {
                transform: (event as { isManual?: boolean }).isManual
                  ? `translate(-50%, calc(-100% + ${event.offsetY ?? 0}px))`
                  : `translate(-50%, calc(-100% - ${(event.laneIndex ?? 0) * LANE_HEIGHT}px))`,
              }),
            }}
          >
            <div className="dot" />
            <div className="card">
              {event.imageUrl ? (() => {
                const saved = {
                  offsetXDays:
                    personalPhotos.find((p) => p.id === event.id)
                      ?.offsetXDays ?? 0,
                  offsetY:
                    personalPhotos.find((p) => p.id === event.id)
                      ?.offsetY ?? 0,
                };
                const pend = pendingOffsets[event.id];
                const isDirty =
                  pend &&
                  (Math.abs(pend.offsetXDays - saved.offsetXDays) > EPS ||
                    Math.abs(pend.offsetY - saved.offsetY) > 1);
                return (
                  <>
                    {isDirty && (
                      <>
                        <button
                          type="button"
                          className="card-delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeletePhoto(event.id);
                          }}
                          title="Удалить"
                          aria-label="Удалить"
                        >
                          ×
                        </button>
                        <button
                          type="button"
                          className="card-confirm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleConfirmOffsets(event.id);
                          }}
                          title="Принять"
                          aria-label="Принять"
                        >
                          ✅
                        </button>
                        <button
                          type="button"
                          className="card-reset"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCancelOffsets(event.id);
                          }}
                          title="Отменить"
                          aria-label="Отменить"
                        >
                          ↺
                        </button>
                      </>
                    )}
                    <img
                      src={event.imageUrl}
                      alt={event.title}
                      className={`card-image ${isDirty ? "" : "card-image-clickable"}`}
                      draggable={false}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!isDirty) setOverlayPhotoId(event.id);
                      }}
                    />
                    <div className="card-caption">{event.title}</div>
                  </>
                );
              })() : (
                <>
                  <div className="date">{event.date}</div>
                  <div className="title">{event.title}</div>
                </>
              )}
            </div>
          </article>
        ))}
      </main>
    </div>
  );
}

export default App;
