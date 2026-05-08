import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  getHistoricalEventsInRange,
} from "./db";
import {
  createSelectedPersonalPhotoStorage,
  getPersonalPhotoCapabilitiesForAuthenticatedUser,
  loadAuthenticatedCurrentUser,
  loadSelectedAdminProfiles,
  personalPhotoStorageIsServerMode,
} from "./personalPhotoStorageSelector";
import type {
  PhotoRecord,
  PhotoRecordMetadata,
} from "./personalPhotoStorage";
import {
  authenticateWithGoogleViaServer,
  getPhotoViewStatsViaServer,
  loadProfileForCurrentRoute,
  recordPhotoViewViaServer,
  type ServerProfileDto,
} from "./serverPersonalPhotoStorage";
import { getProfileRouteState } from "./profileRouteState";
import { getProfileDatasetProfileId } from "./profileModel";
import type { UserModel } from "./userModel";
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
import { DataBackupModal } from "./DataBackupModal";
import { AdminFunctionsModal } from "./AdminFunctionsModal";
import { RecoverAccessCard } from "./RecoverAccessCard";
import {
  clearActiveBrowserUser,
  clearRememberedBrowserUser,
  getOrCreateBrowserViewerId,
  loadActiveBrowserUser,
  loadRememberedBrowserUser,
  saveActiveBrowserUser,
  saveRememberedBrowserUser,
} from "./browserUserIdentity";
import ppyMainLogoUrl from "../PPYMainLogo.png";
import ppyCompactLogoUrl from "../PPY4cut.png";
import ivanPhotoUrl from "../IvanPhoto.JPG";
import { googleClientId, hasGoogleAuthConfig } from "./googleAuthConfig";
import { loadGoogleIdentityScript } from "./googleIdentityScript";
import {
  normalizePhotoSocialSettings,
  type PhotoSocialSettings,
} from "./photoSocial";

export type { Offsets };

type Scale = "30d" | "60d" | "90d" | "1y" | "2y" | "5y" | "10y";

const scales: Scale[] = ["30d", "60d", "90d", "1y", "2y", "5y", "10y"];
const MOBILE_MAX_SCALE: Scale = "2y";
const MOBILE_MAX_SCALE_INDEX = scales.indexOf(MOBILE_MAX_SCALE);

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
const CARD_TO_TIMELINE_DIST = AXIS_GAP - HIST_ARTICLE_OFFSET;
const EPS = 0.01;
const SCROLL_STOP_DEBOUNCE_MS = 200;
const CARD_VIEWPORT_PADDING = 8;
const CARD_VIEWPORT_ADJUST_EPS = 0.5;

function isMobileTimelineViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 640px)").matches
  );
}

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

function getPersonalPhotoMaxOffsetY(laneIndex: number | undefined): number {
  return (
    PERSONAL_BASE_Y_OFFSET +
    (laneIndex ?? 0) * PERSONAL_LANE_HEIGHT -
    CARD_TO_TIMELINE_DIST
  );
}

function clampPersonalPhotoOffsetY(
  photo: Pick<PersonalPhoto, "laneIndex"> | null,
  offsetY: number
): number {
  return Math.min(offsetY, getPersonalPhotoMaxOffsetY(photo?.laneIndex));
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
const INITIAL_PERSONAL_PHOTO_RADIUS_YEARS = 5;

function toPersonalPhoto(
  record: PhotoRecordMetadata,
  today: string,
  image = ""
): PersonalPhoto {
  return {
    id: record.id,
    title: record.title,
    date: record.date > today ? today : record.date,
    image,
    profileId: record.profileId,
    offsetXDays: record.offsetXDays ?? 0,
    offsetY: record.offsetY ?? 0,
    laneIndex: record.laneIndex,
    note: record.note,
    showOnTimeline: record.showOnTimeline !== false,
    seriesId: record.seriesId,
    seriesReminder: record.seriesReminder,
    social: normalizePhotoSocialSettings(record.social),
  };
}

function getPhotoYear(record: Pick<PhotoRecordMetadata, "date">): number {
  const year = new Date(record.date).getFullYear();
  return Number.isFinite(year) ? year : 0;
}

function prioritizePersonalPhotoMetadata(
  records: PhotoRecordMetadata[],
  center: Date
): PhotoRecordMetadata[] {
  const centerYear = center.getFullYear();
  return [...records].sort((a, b) => {
    const aVisible = a.showOnTimeline !== false;
    const bVisible = b.showOnTimeline !== false;
    const aDistance = Math.abs(getPhotoYear(a) - centerYear);
    const bDistance = Math.abs(getPhotoYear(b) - centerYear);
    const aBucket = !aVisible
      ? 2
      : aDistance <= INITIAL_PERSONAL_PHOTO_RADIUS_YEARS
        ? 0
        : 1;
    const bBucket = !bVisible
      ? 2
      : bDistance <= INITIAL_PERSONAL_PHOTO_RADIUS_YEARS
        ? 0
        : 1;
    if (aBucket !== bBucket) return aBucket - bBucket;
    if (aDistance !== bDistance) return aDistance - bDistance;
    return a.date.localeCompare(b.date);
  });
}

const LAYERS = [
  { id: "main", title: "Основные мировые события" },
  { id: "culture", title: "Культура и искусство" },
  { id: "autos", title: "Автомобили" },
  { id: "tech", title: "Техника и технологии" },
] as const;

type LayerId = (typeof LAYERS)[number]["id"];

function isSingleLayerScale(scale: Scale): boolean {
  return scale === "2y" || scale === "5y" || scale === "10y";
}

function getHighestPriorityLayerId(layers: Set<string>): LayerId {
  return LAYERS.find((layer) => layers.has(layer.id))?.id ?? LAYERS[0].id;
}

function normalizeVisibleLayersForScale(
  layers: Set<string>,
  scale: Scale
): Set<string> {
  if (!isSingleLayerScale(scale)) return layers;
  if (layers.size === 0) return layers;
  return new Set([getHighestPriorityLayerId(layers)]);
}

const TIMELINE_STATE_KEY = "timeline-mvp-state";
const FIRST_VISIT_CENTER_DATE = "2000-01-01";
const FIRST_VISIT_VISIBLE_LAYERS: LayerId[] = ["main"];

function getGoogleAuthErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("conflict")) {
    return "Этот email уже конфликтует с другой учетной записью. Войдите по email, чтобы восстановить доступ, вместо автоматической привязки Google.";
  }
  if (message.includes("email-not-verified")) {
    return "Для входа через Google нужен подтвержденный email в аккаунте Google.";
  }
  if (message.includes("email-missing")) {
    return "Google не вернул email для этого аккаунта.";
  }
  if (message.includes("server-misconfigured")) {
    return "Вход через Google сейчас не настроен на сервере.";
  }
  if (message.includes("invalid-token")) {
    return "Не удалось подтвердить вход через Google. Попробуйте еще раз.";
  }
  return "Не удалось войти через Google. Попробуйте еще раз или используйте вход по email.";
}

function getAccountInitials(email: string): string {
  const localPart = email.split("@")[0]?.trim() || email.trim();
  const normalized = localPart.replace(/[._-]+/g, " ");
  const parts = normalized
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
  }

  const compact = (parts[0] ?? localPart).replace(/\s+/g, "");
  return compact.slice(0, 2).toUpperCase() || "?";
}

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
  if (f.includes("tech/") || f.startsWith("tech/")) return "tech";
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
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Слои</h2>
        <div className="modal-field">
          <div className="layers-modal-list">
            {LAYERS.map((layer) => (
              <label key={layer.id} className="layers-modal-pill">
                <input
                  type="checkbox"
                  checked={visibleLayers.has(layer.id)}
                  onChange={() => onToggle(layer.id)}
                />
                <span>{layer.title}</span>
              </label>
            ))}
          </div>
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (file) {
      onSubmit(file, date, caption.trim());
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Добавить фото</h2>
        <form onSubmit={handleSubmit}>
          <div className="modal-field">
            <label>Файл</label>
            <div className="modal-file-row">
              <button
                type="button"
                className="modal-btn"
                onClick={() => fileInputRef.current?.click()}
              >
                Выбрать файл
              </button>
              <div className={`modal-file-pill${file ? " is-selected" : ""}`}>
                {file ? file.name : "Файл не выбран"}
              </div>
              <input
                ref={fileInputRef}
                className="modal-file-input"
                type="file"
                accept="image/*"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
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
  const [rememberedBrowserUser, setRememberedBrowserUser] = useState(() =>
    loadRememberedBrowserUser()
  );
  const [activeBrowserUser, setActiveBrowserUser] = useState(() =>
    loadActiveBrowserUser()
  );
  const [authenticatedUser, setAuthenticatedUser] = useState<UserModel | null>(null);
  const authenticatedUserRef = useRef<UserModel | null>(null);
  authenticatedUserRef.current = authenticatedUser;

  const personalPhotoStorage = useMemo(
    () =>
      createSelectedPersonalPhotoStorage(undefined, {
        assertWriteAllowed: () => {
          if (!personalPhotoStorageIsServerMode) return;
          if (!authenticatedUserRef.current) {
            throw new Error("Not authenticated");
          }
        },
      }),
    []
  );
  const personalPhotoCapabilities = useMemo(
    () => getPersonalPhotoCapabilitiesForAuthenticatedUser(authenticatedUser),
    [authenticatedUser]
  );
  const {
    assignPersonalLaneIndex,
    deletePhoto,
    deletePhotosInDay,
    getAllPhotoMetadata,
    getAllSeries,
    getPhoto,
    getPhotoTimelineImage,
    savePhoto,
    saveSeries,
    updatePhotoImage,
    updatePhotoMetadata,
    updatePhotoOffsets,
    updatePhotoPreview,
    updatePhotoSeriesId,
  } = personalPhotoStorage;
  const {
    canWrite,
    canAddPhoto,
    canAddPhotoToDay,
    canDeleteAllPhotosInDay,
    canDeletePhoto,
    canEditMetadata,
    canEditOffsets,
    canImportBackup,
    canLinkSeries,
    canReplacePhoto,
    canUnlinkSeries,
    canWritePreview,
  } = personalPhotoCapabilities;
  const loadPhotosGenerationRef = useRef(0);
  const lastTrackedOpenPhotoIdRef = useRef<string | null>(null);
  const publicServerReadOnlyUx =
    personalPhotoStorageIsServerMode && !canWrite;
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const [googleScriptStatus, setGoogleScriptStatus] = useState<
    "idle" | "loading" | "loaded" | "error"
  >("idle");
  const [googleAuthErrorMessage, setGoogleAuthErrorMessage] = useState<string | null>(
    null
  );

  const refreshAuthenticatedUser = useCallback(async () => {
    if (!personalPhotoStorageIsServerMode) {
      setAuthenticatedUser(null);
      return;
    }
    try {
      const user = await loadAuthenticatedCurrentUser();
      setAuthenticatedUser(user);
    } catch (err) {
      setAuthenticatedUser(null);
      console.error("[auth] load current user failed", err);
    }
  }, []);

  const handleBrowserActiveSignOut = useCallback(() => {
    clearActiveBrowserUser();
    setActiveBrowserUser(null);
    setAuthenticatedUser(null);
    setAccountMenuOpen(false);
    if (typeof window !== "undefined") {
      window.location.assign("/");
    }
  }, []);
  const handleForgetThisDevice = useCallback(() => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Удалить сохранённые данные профиля в этом браузере? Понадобится снова войти или восстановить доступ."
      )
    ) {
      return;
    }
    clearActiveBrowserUser();
    clearRememberedBrowserUser();
    setActiveBrowserUser(null);
    setRememberedBrowserUser(null);
    setAuthenticatedUser(null);
    setAccountMenuOpen(false);
  }, []);
  const persisted = useMemo(loadTimelineState, []);

  const [scaleIndex, setScaleIndex] = useState(() => {
    const i = persisted.scaleIndex;
    const initial = typeof i === "number" && i >= 0 && i < scales.length ? i : 2;
    return isMobileTimelineViewport()
      ? Math.min(initial, MOBILE_MAX_SCALE_INDEX)
      : initial;
  });
  const [isMobileTimeline, setIsMobileTimeline] = useState(
    isMobileTimelineViewport
  );
  const [activeProfile, setActiveProfile] = useState<ServerProfileDto | null>(null);
  const [personalPhotos, setPersonalPhotos] = useState<PersonalPhoto[]>([]);
  const [historicalEvents, setHistoricalEvents] = useState<HistoricalEvent[]>([]);
  const [layoutInfo, setLayoutInfo] = useState<{
    width: number;
    height: number;
    axisY: number;
  } | null>(null);
  const objectUrlsRef = useRef<Map<string, string>>(new Map());
  const imageBlobsRef = useRef<Map<string, Blob>>(new Map());
  const fullPhotoLoadRequestsRef = useRef<Map<string, Promise<Blob | null>>>(
    new Map()
  );
  const overlayUrlRef = useRef<string | null>(null);
  const overlayPhotoIdRef = useRef<string | null>(null);
  const googleButtonContainerRef = useRef<HTMLDivElement | null>(null);
  const googleIdentityInitializedRef = useRef(false);
  const googleButtonRenderedRef = useRef(false);
  const googleLoginInFlightRef = useRef(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [gotoDateModalOpen, setGotoDateModalOpen] = useState(false);
  const [layersModalOpen, setLayersModalOpen] = useState(false);
  const [dataBackupModalOpen, setDataBackupModalOpen] = useState(false);
  const [adminFunctionsModalOpen, setAdminFunctionsModalOpen] = useState(false);
  const [adminProfiles, setAdminProfiles] = useState<ServerProfileDto[]>([]);
  const [adminProfilesLoading, setAdminProfilesLoading] = useState(false);
  const [adminProfilesError, setAdminProfilesError] = useState<string | null>(null);
  const [visibleLayers, setVisibleLayers] = useState<Set<string>>(() => {
    const ids = LAYERS.map((l) => l.id) as string[];
    if ("visibleLayers" in persisted && Array.isArray(persisted.visibleLayers)) {
      const valid = persisted.visibleLayers.filter((id) => ids.includes(id));
      return normalizeVisibleLayersForScale(new Set(valid), scales[scaleIndex] as Scale);
    }
    return normalizeVisibleLayersForScale(
      new Set(FIRST_VISIT_VISIBLE_LAYERS),
      scales[scaleIndex] as Scale
    );
  });
  const [overlayPhotoId, setOverlayPhotoId] = useState<string | null>(null);
  const [overlayUrl, setOverlayUrl] = useState<string | null>(null);
  const [adminOverlayPhotoViewCount, setAdminOverlayPhotoViewCount] = useState<
    number | null
  >(null);
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
    const persistedScaleIdx = typeof persisted.scaleIndex === "number" && persisted.scaleIndex >= 0 && persisted.scaleIndex < scales.length
      ? persisted.scaleIndex
      : 2;
    const scaleIdx = isMobileTimelineViewport()
      ? Math.min(persistedScaleIdx, MOBILE_MAX_SCALE_INDEX)
      : persistedScaleIdx;
    const scaleForClamp = scales[scaleIdx] as Scale;
    if (typeof s === "string") {
      const d = new Date(s);
      if (!isNaN(d.getTime())) return clampCenterToToday(d, scaleForClamp);
    }
    return clampCenterToToday(new Date(FIRST_VISIT_CENTER_DATE), scaleForClamp);
  });
  const [isDragging, setIsDragging] = useState(false);
  const [cardDragging, setCardDragging] = useState<string | null>(null);
  const [pendingOffsets, setPendingOffsets] = useState<Record<string, Offsets>>(
    {}
  );
  const [timelinePanY, setTimelinePanY] = useState(0);
  const timelinePanYRef = useRef(0);
  const [timelinePanBounds, setTimelinePanBounds] = useState<{
    min: number;
    max: number;
  }>({ min: 0, max: 0 });
  const timelinePanBoundsRef = useRef<{ min: number; max: number }>({
    min: 0,
    max: 0,
  });
  const [timelineAutoCentering, setTimelineAutoCentering] = useState(false);
  const autoCenterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleCenterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startCenterMs: number;
  } | null>(null);
  const timelinePointersRef = useRef<Map<number, { x: number; y: number }>>(
    new Map()
  );
  const pinchZoomRef = useRef<{
    lastDistance: number;
    accumulatedDelta: number;
  } | null>(null);
  const cardDragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    startOffsetXDays: number;
    startOffsetY: number;
    maxOffsetY: number;
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
  const [cardViewportAdjustY, setCardViewportAdjustY] = useState<Record<string, number>>(
    {}
  );
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
  const currentPathname = useMemo(
    () => (typeof window === "undefined" ? "/" : window.location.pathname),
    []
  );
  const isLandingRoute = currentPathname === "/";
  const canRenderGoogleButton =
    isLandingRoute &&
    hasGoogleAuthConfig() &&
    googleScriptStatus === "loaded" &&
    typeof window !== "undefined" &&
    window.google?.accounts?.id !== undefined;
  const googleAuthStatusMessage =
    googleAuthErrorMessage ??
    (hasGoogleAuthConfig() && googleScriptStatus === "error"
      ? "Не удалось загрузить вход через Google. Обновите страницу или используйте вход по email."
      : null);
  const {
    routeProfileSlug,
    isRootShortcut: isOwnerShortcutRoute,
    isInvalidProfileRoute: isMissingProfileRoute,
  } = useMemo(
    () =>
      getProfileRouteState(currentPathname, {
        hasActiveProfile: activeProfile !== null,
      }),
    [activeProfile, currentPathname]
  );
  const canonicalProfilePath = useMemo(() => {
    if (activeProfile) {
      return `/${activeProfile.slug}`;
    }
    return null;
  }, [activeProfile]);
  const activeProfileDatasetProfileId = activeProfile
    ? getProfileDatasetProfileId(activeProfile)
    : null;
  const isAuthenticatedAdmin = authenticatedUser?.role === "admin";
  const isAuthenticatedOwnerViewingCurrentProfile =
    authenticatedUser !== null &&
    activeProfile !== null &&
    (activeProfile.ownerUserId === authenticatedUser.id ||
      authenticatedUser.primaryProfileId === activeProfile.id ||
      authenticatedUser.primaryProfileId ===
        getProfileDatasetProfileId(activeProfile));
  const canAccessAdminFunctions =
    personalPhotoStorageIsServerMode && isAuthenticatedAdmin;
  const canManageCurrentProfile = personalPhotoStorageIsServerMode
    ? isAuthenticatedAdmin || isAuthenticatedOwnerViewingCurrentProfile
    : true;
  const canAddPhotoForCurrentView = canAddPhoto && canManageCurrentProfile;
  const canAddPhotoToDayForCurrentView =
    canAddPhotoToDay && canManageCurrentProfile;
  const canDeleteAllPhotosInDayForCurrentView =
    canDeleteAllPhotosInDay && canManageCurrentProfile;
  const canDeletePhotoForCurrentView =
    canDeletePhoto && canManageCurrentProfile;
  const canEditMetadataForCurrentView =
    canEditMetadata && canManageCurrentProfile;
  const canEditOffsetsForCurrentView =
    canEditOffsets && canManageCurrentProfile;
  const canImportBackupForCurrentView =
    canImportBackup && canManageCurrentProfile;
  const canLinkSeriesForCurrentView =
    canLinkSeries && canManageCurrentProfile;
  const canReplacePhotoForCurrentView =
    canReplacePhoto && canManageCurrentProfile;
  const canUnlinkSeriesForCurrentView =
    canUnlinkSeries && canManageCurrentProfile;
  const accountInitials = authenticatedUser
    ? getAccountInitials(authenticatedUser.email)
    : "";
  const ownProfileSlug =
    authenticatedUser && activeBrowserUser?.userId === authenticatedUser.id
      ? activeBrowserUser.profileSlug
      : authenticatedUser && rememberedBrowserUser?.userId === authenticatedUser.id
        ? rememberedBrowserUser.profileSlug
        : null;
  const shouldShowReturnToOwnProfile =
    Boolean(ownProfileSlug) &&
    activeProfile !== null &&
    activeProfile.slug !== ownProfileSlug;

  const handleReturnToOwnProfile = useCallback(() => {
    if (!ownProfileSlug || typeof window === "undefined") return;
    setAccountMenuOpen(false);
    window.location.assign(`/${ownProfileSlug}`);
  }, [ownProfileSlug]);

  const getActiveOffsets = (id: string): Offsets => {
    const p = personalPhotos.find((x) => x.id === id);
    const pend = pendingOffsets[id];
    if (pend) {
      return {
        offsetXDays: pend.offsetXDays,
        offsetY: clampPersonalPhotoOffsetY(p ?? null, pend.offsetY),
      };
    }
    if (p) {
      return {
        offsetXDays: p.offsetXDays,
        offsetY: clampPersonalPhotoOffsetY(p, p.offsetY),
      };
    }
    return { offsetXDays: 0, offsetY: 0 };
  };

  const isDirty = (id: string): boolean => {
    const pend = pendingOffsets[id];
    if (!pend) return false;
    const p = personalPhotos.find((x) => x.id === id);
    if (!p) return true;
    const storedOffsetY = clampPersonalPhotoOffsetY(p, p.offsetY);
    return (
      Math.abs(pend.offsetXDays - p.offsetXDays) > EPS ||
      Math.abs(pend.offsetY - storedOffsetY) > 1
    );
  };

  const loadPhotosFromDb = useCallback(async () => {
    const generation = loadPhotosGenerationRef.current + 1;
    loadPhotosGenerationRef.current = generation;
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current.clear();
    imageBlobsRef.current.clear();

    const records = await getAllPhotoMetadata();
    if (loadPhotosGenerationRef.current !== generation) return;

    const today = todayStr();
    setPersonalPhotos(records.map((record) => toPersonalPhoto(record, today)));

    const orderedRecords = prioritizePersonalPhotoMetadata(
      records,
      centerDateRef.current
    );

    for (const record of orderedRecords) {
      if (loadPhotosGenerationRef.current !== generation) return;
      if (record.showOnTimeline === false) continue;
      try {
        const timelineImage = await getPhotoTimelineImage(record.id);
        if (!timelineImage || loadPhotosGenerationRef.current !== generation) {
          continue;
        }

        const imageUrl = URL.createObjectURL(timelineImage.imageBlob);
        objectUrlsRef.current.set(record.id, imageUrl);
        if (timelineImage.originalBlob) {
          imageBlobsRef.current.set(record.id, timelineImage.originalBlob);
        }
        setPersonalPhotos((prev) =>
          prev.map((photo) =>
            photo.id === record.id ? { ...photo, image: imageUrl } : photo
          )
        );

        /* Policy-controlled preview writes: disabled in server mode. */
        if (canWritePreview && !record.hasPreview && timelineImage.originalBlob) {
          try {
            const previewBlob = await generatePreviewBlob(timelineImage.originalBlob);
            if (loadPhotosGenerationRef.current !== generation) return;
            await updatePhotoPreview(record.id, previewBlob);
            if (loadPhotosGenerationRef.current !== generation) return;
            const oldUrl = objectUrlsRef.current.get(record.id);
            if (oldUrl) URL.revokeObjectURL(oldUrl);
            const previewUrl = URL.createObjectURL(previewBlob);
            objectUrlsRef.current.set(record.id, previewUrl);
            setPersonalPhotos((prev) =>
              prev.map((photo) =>
                photo.id === record.id ? { ...photo, image: previewUrl } : photo
              )
            );
          } catch {
            /* keep original */
          }
        }
      } catch {
        /* keep unloaded */
      }
    }
  }, [canWritePreview, getAllPhotoMetadata, getPhotoTimelineImage, updatePhotoPreview]);

  const loadSeriesMapFromStorage = useCallback(async () => {
    const series = await getAllSeries();
    const map: Record<string, string> = {};
    series.forEach((s) => {
      map[s.id] = s.title;
    });
    setSeriesMap(map);
  }, []);

  const refreshSeriesUiState = useCallback(async () => {
    setHoveredPhotoId(null);
    setHoveredSeriesId(null);
    await Promise.all([loadPhotosFromDb(), loadSeriesMapFromStorage()]);
  }, [loadPhotosFromDb, loadSeriesMapFromStorage]);

  const handleBackupImportDone = useCallback(() => {
    refreshSeriesUiState().catch((err) =>
      console.error("[photos] reload after import", err)
    );
  }, [refreshSeriesUiState]);

  useEffect(() => {
    if (!hasGoogleAuthConfig()) return;
    let cancelled = false;
    setGoogleScriptStatus("loading");
    loadGoogleIdentityScript()
      .then(() => {
        if (!cancelled) setGoogleScriptStatus("loaded");
      })
      .catch(() => {
        if (!cancelled) setGoogleScriptStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!accountMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const menu = accountMenuRef.current;
      if (!menu || menu.contains(event.target as Node)) return;
      setAccountMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAccountMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [accountMenuOpen]);

  useEffect(() => {
    if (!canRenderGoogleButton) {
      googleButtonRenderedRef.current = false;
      return;
    }
    const googleId = window.google?.accounts?.id;
    const container = googleButtonContainerRef.current;
    if (!googleId || !container) return;

    if (!googleIdentityInitializedRef.current) {
      googleId.initialize({
        client_id: googleClientId,
        callback: (response) => {
          if (!response.credential || googleLoginInFlightRef.current) {
            return;
          }
          googleLoginInFlightRef.current = true;
          setGoogleAuthErrorMessage(null);
          void (async () => {
            try {
              const result = await authenticateWithGoogleViaServer({
                credential: response.credential,
              });
              setGoogleAuthErrorMessage(null);
              const rememberedUser = saveRememberedBrowserUser(result);
              setRememberedBrowserUser(rememberedUser);
              if (rememberedUser) {
                saveActiveBrowserUser(rememberedUser);
                setActiveBrowserUser(rememberedUser);
              }
              if (personalPhotoStorageIsServerMode) {
                await refreshAuthenticatedUser();
              }
              if (typeof window !== "undefined") {
                window.location.assign(`/${result.profile.slug}`);
              }
            } catch (error) {
              console.error("[auth] Google sign-in failed", error);
              setGoogleAuthErrorMessage(getGoogleAuthErrorMessage(error));
            } finally {
              googleLoginInFlightRef.current = false;
            }
          })();
        },
      });
      googleIdentityInitializedRef.current = true;
    }

    if (googleButtonRenderedRef.current) return;
    container.replaceChildren();
    googleId.renderButton(container, {
      theme: "outline",
      size: "large",
      text: "continue_with",
      shape: "rectangular",
    });
    googleButtonRenderedRef.current = true;
  }, [canRenderGoogleButton, refreshAuthenticatedUser]);

  useEffect(() => {
    if (isLandingRoute) return;
    let cancelled = false;
    loadPhotosFromDb().catch((err) => {
      if (!cancelled) console.error("[photos] load failed", err);
    });
    return () => {
      cancelled = true;
    };
  }, [isLandingRoute, loadPhotosFromDb]);

  useEffect(() => {
    let cancelled = false;

    if (!personalPhotoStorageIsServerMode) {
      setActiveProfile(null);
      return () => {
        cancelled = true;
      };
    }

    if (isLandingRoute) {
      setActiveProfile(null);
      return () => {
        cancelled = true;
      };
    }

    loadProfileForCurrentRoute()
      .then((profile) => {
        if (!cancelled) {
          setActiveProfile(profile);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setActiveProfile(null);
          console.error("[profile] load failed", err);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isLandingRoute]);

  /** Resolve session from GET /api/me (write token from storage). Re-run when active token row changes. */
  useEffect(() => {
    let cancelled = false;
    if (!personalPhotoStorageIsServerMode) {
      setAuthenticatedUser(null);
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        const user = await loadAuthenticatedCurrentUser();
        if (!cancelled) {
          setAuthenticatedUser(user);
        }
      } catch (err) {
        if (!cancelled) {
          setAuthenticatedUser(null);
          console.error("[auth] load current user failed", err);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeBrowserUser, personalPhotoStorageIsServerMode]);

  useEffect(() => {
    if (isLandingRoute) return;
    loadSeriesMapFromStorage().catch((err) =>
      console.error("[series] load failed", err)
    );
  }, [isLandingRoute, loadSeriesMapFromStorage]);

  useEffect(() => {
    if (!adminFunctionsModalOpen || !canAccessAdminFunctions) return;
    let cancelled = false;

    setAdminProfilesLoading(true);
    setAdminProfilesError(null);
    loadSelectedAdminProfiles()
      .then((profiles) => {
        if (!cancelled) {
          setAdminProfiles(profiles);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setAdminProfilesError(
            err instanceof Error ? err.message : String(err)
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAdminProfilesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [adminFunctionsModalOpen, canAccessAdminFunctions]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const syncMobileState = () => setIsMobileTimeline(media.matches);
    syncMobileState();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", syncMobileState);
      return () => media.removeEventListener("change", syncMobileState);
    }
    media.addListener(syncMobileState);
    return () => media.removeListener(syncMobileState);
  }, []);

  useEffect(() => {
    if (!isMobileTimeline) return;
    setScaleIndex((current) => Math.min(current, MOBILE_MAX_SCALE_INDEX));
  }, [isMobileTimeline]);

  useEffect(() => {
    if (!isSingleLayerScale(scale)) return;
    setVisibleLayers((prev) => {
      const next = normalizeVisibleLayersForScale(prev, scale);
      if (next.size === prev.size && [...next].every((id) => prev.has(id))) {
        return prev;
      }
      return next;
    });
  }, [scale]);

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

  const loadFullPhotoBlob = useCallback(
    async (id: string): Promise<Blob | null> => {
      const cachedBlob = imageBlobsRef.current.get(id);
      if (cachedBlob) return cachedBlob;

      const pendingRequest = fullPhotoLoadRequestsRef.current.get(id);
      if (pendingRequest) return pendingRequest;

      const request = getPhoto(id)
        .then((record) => {
          if (!record) return null;
          const previousUrl = objectUrlsRef.current.get(id);
          const url = URL.createObjectURL(record.imageBlob);
          objectUrlsRef.current.set(id, url);
          imageBlobsRef.current.set(id, record.imageBlob);
          setPersonalPhotos((prev) =>
            prev.map((p) => (p.id === id ? { ...p, image: url } : p))
          );
          if (previousUrl) URL.revokeObjectURL(previousUrl);
          return record.imageBlob;
        })
        .catch(() => null)
        .finally(() => {
          fullPhotoLoadRequestsRef.current.delete(id);
        });

      fullPhotoLoadRequestsRef.current.set(id, request);
      return request;
    },
    [getPhoto]
  );

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
        loadFullPhotoBlob(id).then((blob) => {
          if (!blob || overlayPhotoIdRef.current !== id) return;
          const url = URL.createObjectURL(blob);
          overlayUrlRef.current = url;
          setOverlayUrl(url);
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
  }, [overlayPhotoId, loadFullPhotoBlob]);

  useEffect(() => {
    if (!overlayPhotoId) return;
    if (!imageBlobsRef.current.has(overlayPhotoId)) return;
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
    let cancelled = false;
    let nextIndex = 0;
    const workerCount = Math.min(2, toLoad.length);
    const runWorker = async () => {
      while (!cancelled) {
        const id = toLoad[nextIndex];
        nextIndex += 1;
        if (!id) return;
        await loadFullPhotoBlob(id);
      }
    };
    for (let i = 0; i < workerCount; i += 1) {
      void runWorker();
    }
    return () => {
      cancelled = true;
    };
  }, [overlayPhotoId, personalPhotos, loadFullPhotoBlob]);

  useEffect(() => {
    if (!personalPhotoStorageIsServerMode) return;
    if (!overlayPhotoId) {
      lastTrackedOpenPhotoIdRef.current = null;
      return;
    }
    if (lastTrackedOpenPhotoIdRef.current === overlayPhotoId) return;
    if (!personalPhotos.some((photo) => photo.id === overlayPhotoId)) return;

    lastTrackedOpenPhotoIdRef.current = overlayPhotoId;
    const viewerId = getOrCreateBrowserViewerId();
    recordPhotoViewViaServer(overlayPhotoId, viewerId)
      .then((response) => {
        if (isAuthenticatedAdmin && overlayPhotoIdRef.current === overlayPhotoId) {
          setAdminOverlayPhotoViewCount(response.stats.uniqueViews);
        }
      })
      .catch((error) => {
        console.error("[views] photo view tracking failed", error);
      });
  }, [overlayPhotoId, personalPhotos, isAuthenticatedAdmin]);

  useEffect(() => {
    if (!personalPhotoStorageIsServerMode || !isAuthenticatedAdmin || !overlayPhotoId) {
      setAdminOverlayPhotoViewCount(null);
      return;
    }

    let cancelled = false;
    setAdminOverlayPhotoViewCount(null);
    getPhotoViewStatsViaServer(overlayPhotoId)
      .then((stats) => {
        if (!cancelled) {
          setAdminOverlayPhotoViewCount(stats.uniqueViews);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setAdminOverlayPhotoViewCount(null);
        }
        console.error("[views] admin stats load failed", error);
      });

    return () => {
      cancelled = true;
    };
  }, [overlayPhotoId, isAuthenticatedAdmin]);

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
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onMove);
    document.addEventListener("pointercancel", onMove);
    return () => {
      el.removeEventListener("wheel", schedule);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onMove);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onMove);
      document.removeEventListener("pointercancel", onMove);
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
  useEffect(() => {
    runHistoryIngest().finally(() => setIngestVersion((v) => v + 1));
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
      if (isSingleLayerScale(scale)) {
        if (prev.has(layerId)) return new Set();
        return new Set([layerId]);
      }
      const next = new Set(prev);
      if (next.has(layerId)) next.delete(layerId);
      else next.add(layerId);
      return next;
    });
  }, [scale]);

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
    if (!layoutInfo) return;
    const timeline = timelineRef.current;
    if (!timeline) return;

    const tlRect = timeline.getBoundingClientRect();
    const topLimit = CARD_VIEWPORT_PADDING;
    const bottomLimit = layoutInfo.height - CARD_VIEWPORT_PADDING;
    const availableHeight = bottomLimit - topLimit;

    const measureDesiredAdjust = (
      card: HTMLDivElement,
      previousAdjust: number,
      kind: "personal" | "historical"
    ): number => {
      const rect = card.getBoundingClientRect();
      const currentTop = rect.top - tlRect.top;
      const currentBottom = rect.bottom - tlRect.top;
      const baseTop = currentTop - previousAdjust;
      const baseBottom = currentBottom - previousAdjust;
      const cardHeight = currentBottom - currentTop;

      let desiredAdjust = 0;
      if (cardHeight > availableHeight) {
        desiredAdjust = topLimit - baseTop;
      } else if (baseTop < topLimit) {
        desiredAdjust = topLimit - baseTop;
      } else if (baseBottom > bottomLimit) {
        desiredAdjust = bottomLimit - baseBottom;
      }

      if (kind === "personal") {
        const maxPersonalBottom = layoutInfo.axisY - CARD_TO_TIMELINE_DIST;
        desiredAdjust = Math.min(desiredAdjust, maxPersonalBottom - baseBottom);
      } else {
        const minHistoricalTop = layoutInfo.axisY + CARD_TO_TIMELINE_DIST;
        desiredAdjust = Math.max(desiredAdjust, minHistoricalTop - baseTop);
      }

      return Math.round(desiredAdjust * 10) / 10;
    };

    setCardViewportAdjustY((prev) => {
      const next: Record<string, number> = {};
      let changed = false;

      for (const photo of positionedPersonal) {
        const card = personalCardRefs.current.get(photo.id);
        if (!card) continue;
        const key = `p:${photo.id}`;
        const desired = measureDesiredAdjust(
          card,
          prev[key] ?? 0,
          "personal"
        );
        if (Math.abs(desired) > CARD_VIEWPORT_ADJUST_EPS) {
          next[key] = desired;
        }
      }

      for (const event of visiblePositionedHistorical) {
        const card = historicalCardRefs.current.get(event.id);
        if (!card) continue;
        const key = `h:${event.id}`;
        const desired = measureDesiredAdjust(
          card,
          prev[key] ?? 0,
          "historical"
        );
        if (Math.abs(desired) > CARD_VIEWPORT_ADJUST_EPS) {
          next[key] = desired;
        }
      }

      const prevKeys = Object.keys(prev);
      if (prevKeys.length !== Object.keys(next).length) {
        changed = true;
      } else {
        for (const key of prevKeys) {
          if (Math.abs((prev[key] ?? 0) - (next[key] ?? 0)) > CARD_VIEWPORT_ADJUST_EPS) {
            changed = true;
            break;
          }
        }
      }

      return changed ? next : prev;
    });
  }, [
    layoutInfo,
    positionedPersonal,
    visiblePositionedHistorical,
    cardViewportAdjustY,
  ]);

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
    cardViewportAdjustY,
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

  const handleAddPhoto = async (file: File, date: string, caption: string) => {
    if (!canAddPhotoForCurrentView) return;
    const safeDate = date > todayStr() ? todayStr() : date;
    const id = `photo-${Date.now()}`;
    imageBlobsRef.current.set(id, file);
    let previewBlob: Blob | undefined;
    try {
      previewBlob = await generatePreviewBlob(file);
    } catch {
      previewBlob = undefined;
    }

    const existingRecordsForLaneAssignment: PhotoRecord[] = personalPhotos.map(
      (photo) => ({
        id: photo.id,
        title: photo.title,
        date: photo.date,
        type: "personal",
        imageBlob: new Blob(),
        offsetY: photo.offsetY,
        offsetXDays: photo.offsetXDays,
        laneIndex: photo.laneIndex,
        note: photo.note,
        showOnTimeline: photo.showOnTimeline,
        seriesId: photo.seriesId,
        seriesReminder: photo.seriesReminder,
      })
    );
    const newRecord: PhotoRecord = {
      id,
      title: caption || "Фото",
      date: safeDate,
      type: "personal",
      ...(activeProfileDatasetProfileId
        ? { profileId: activeProfileDatasetProfileId }
        : {}),
      imageBlob: file,
      previewBlob,
      offsetY: 0,
      offsetXDays: 0,
      showOnTimeline: true,
    };
    const withLanes = assignPersonalLaneIndex([
      ...existingRecordsForLaneAssignment,
      newRecord,
    ]);
    const assigned = withLanes.find((r) => r.id === id);
    newRecord.laneIndex = assigned?.laneIndex ?? 0;

    try {
      await savePhoto(newRecord);
    } catch (err) {
      imageBlobsRef.current.delete(id);
      console.error("[add] save failed", err);
      alert("Ошибка сохранения фото. Попробуйте ещё раз.");
      return;
    }

    const image = URL.createObjectURL(previewBlob ?? file);
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
        showOnTimeline: true,
        seriesReminder: newRecord.seriesReminder,
      },
    ]);
  };

  const handleConfirmOffsets = (id: string) => {
    if (!canEditOffsetsForCurrentView) return;
    const pend = pendingOffsets[id];
    if (!pend) return;
    const photo = personalPhotos.find((p) => p.id === id) ?? null;
    const offsetY = clampPersonalPhotoOffsetY(photo, pend.offsetY);
    setCardDragging(null);
    setPersonalPhotos((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, offsetXDays: pend.offsetXDays, offsetY } : p
      )
    );
    updatePhotoOffsets(id, offsetY, pend.offsetXDays).catch(() => {});
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
    if (!canLinkSeriesForCurrentView) return;
    const sourceId = overlayPhotoId;
    setOverlayPhotoId(null);
    setOverlayEditMode(false);
    setLinkingMode(true);
    setLinkingSourcePhotoId(sourceId);
  }, [canLinkSeriesForCurrentView, overlayPhotoId]);

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
      if (!canLinkSeriesForCurrentView) return;
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
        await saveSeries({
          id: seriesId,
          title,
          profileId:
            sourcePhoto.profileId ??
            targetPhoto.profileId ??
            activeProfileDatasetProfileId ??
            "",
        });
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

      await refreshSeriesUiState();
    },
    [
      canLinkSeriesForCurrentView,
      linkingSourcePhotoId,
      personalPhotos,
      refreshSeriesUiState,
    ]
  );

  const handleUnlinkFromSeries = useCallback(
    async (photoId: string) => {
      if (!canUnlinkSeriesForCurrentView) return;
      if (!window.confirm("Убрать фото из серии?")) return;

      try {
        await updatePhotoSeriesId(photoId, undefined);
        setOverlayEditMode(false);
        await refreshSeriesUiState();
      } catch (err) {
        console.error("[unlink] DB update failed", err);
        alert("Ошибка сохранения. Попробуйте ещё раз.");
      }
    },
    [canUnlinkSeriesForCurrentView, refreshSeriesUiState]
  );

  const handleRenameSeries = useCallback(
    async (seriesId: string, title: string) => {
      if (!canEditMetadataForCurrentView) return;
      const nextTitle = title.trim();
      if (!nextTitle) return;

      try {
        const series = await getAllSeries();
        const existing = series.find((s) => s.id === seriesId) ?? null;
        const profileId =
          existing?.profileId ?? activeProfileDatasetProfileId ?? "";

        await saveSeries({ id: seriesId, title: nextTitle, profileId });
        setSeriesMap((prev) => ({ ...prev, [seriesId]: nextTitle }));
      } catch (err) {
        console.error("[series] rename failed", err);
        alert(
          "РћС€РёР±РєР° РїРµСЂРµРёРјРµРЅРѕРІР°РЅРёСЏ СЃРµСЂРёРё. РџРѕРїСЂРѕР±СѓР№С‚Рµ РµС‰С‘ СЂР°Р·."
        );
      }
    },
    [
      canEditMetadataForCurrentView,
      getAllSeries,
      saveSeries,
      activeProfileDatasetProfileId,
    ]
  );

  const handleOverlaySave = useCallback(
    (
      id: string,
      data: {
        date: string;
        title: string;
        note: string;
        seriesReminder: boolean;
        social: PhotoSocialSettings;
      }
    ) => {
      if (!canEditMetadataForCurrentView) return;
      updatePhotoMetadata(id, data)
        .then(() => {
          setPersonalPhotos((prev) =>
            prev.map((p) =>
              p.id === id
                ? {
                    ...p,
                    date: data.date,
                    title: data.title,
                    note: data.note,
                    seriesReminder: data.seriesReminder,
                    social: data.social,
                  }
                : p
            )
          );
          setOverlayEditMode(false);
        })
        .catch((err) => {
          console.error("[photos] metadata save failed", err);
          alert(
            "Не удалось сохранить изменения. Обновите страницу и попробуйте ещё раз."
          );
        });
    },
    [canEditMetadataForCurrentView, updatePhotoMetadata]
  );

  const handleReplaceImage = useCallback(
    (id: string, file: File) => {
      if (!canReplacePhotoForCurrentView) return;
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
    [canReplacePhotoForCurrentView, overlayPhotoId]
  );

  const handleAddPhotoToDay = useCallback(
    async (file: File) => {
      if (!canAddPhotoToDayForCurrentView) return;
      const current = personalPhotos.find((p) => p.id === overlayPhotoId);
      if (!current) return;
      const safeDate =
        current.date > todayStr() ? todayStr() : current.date;
      const id = `photo-${Date.now()}`;
      imageBlobsRef.current.set(id, file);
      let previewBlob: Blob | undefined;
      try {
        previewBlob = await generatePreviewBlob(file);
      } catch {
        previewBlob = undefined;
      }

      const existingRecordsForLaneAssignment: PhotoRecord[] = personalPhotos.map(
        (photo) => ({
          id: photo.id,
          title: photo.title,
          date: photo.date,
          type: "personal",
          imageBlob: new Blob(),
          offsetY: photo.offsetY,
          offsetXDays: photo.offsetXDays,
          laneIndex: photo.laneIndex,
          note: photo.note,
          showOnTimeline: photo.showOnTimeline,
          seriesId: photo.seriesId,
          seriesReminder: photo.seriesReminder,
          social: normalizePhotoSocialSettings(photo.social),
        })
      );
      const newRecord: PhotoRecord = {
        id,
        title: "Фото",
        date: safeDate,
        type: "personal",
        ...(activeProfileDatasetProfileId
          ? { profileId: activeProfileDatasetProfileId }
          : {}),
        imageBlob: file,
        previewBlob,
        offsetY: 0,
        offsetXDays: 0,
        showOnTimeline: false,
        social: normalizePhotoSocialSettings(undefined),
      };
      const withLanes = assignPersonalLaneIndex([
        ...existingRecordsForLaneAssignment,
        { ...newRecord, showOnTimeline: true },
      ]);
      const assigned = withLanes.find((r) => r.id === id);
      newRecord.laneIndex = assigned?.laneIndex ?? 0;

      try {
        await savePhoto(newRecord);
      } catch (err) {
        imageBlobsRef.current.delete(id);
        console.error("[add-to-day] save failed", err);
        alert("Ошибка сохранения фото. Попробуйте ещё раз.");
        return;
      }

      const image = URL.createObjectURL(previewBlob ?? file);
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
          seriesReminder: newRecord.seriesReminder,
          social: normalizePhotoSocialSettings(newRecord.social),
        },
      ]);
      setOverlayPhotoId(id);
      setOverlayUrl(image);
    },
    [
      activeProfileDatasetProfileId,
      canAddPhotoToDayForCurrentView,
      overlayPhotoId,
      personalPhotos,
    ]
  );

  const handleDeletePhoto = useCallback(
    async (id: string) => {
      if (!canDeletePhotoForCurrentView) return false;
      if (!window.confirm("Удалить фото? Это действие нельзя отменить.")) return false;

      try {
        await deletePhoto(id);
      } catch (err) {
        console.error("[delete] failed", err);
        alert("Ошибка удаления фото. Попробуйте ещё раз.");
        return false;
      }

      setCardDragging(null);
      setHoveredPhotoId(null);
      setHoveredSeriesId(null);
      setOverlayEditMode(false);
      const url = objectUrlsRef.current.get(id);
      if (url) {
        URL.revokeObjectURL(url);
        objectUrlsRef.current.delete(id);
      }
      imageBlobsRef.current.delete(id);
      if (overlayPhotoId === id) {
        setOverlayPhotoId(null);
        setOverlayUrl(null);
      }
      setPendingOffsets((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setPersonalPhotos((prev) => prev.filter((p) => p.id !== id));
      return true;
    },
    [canDeletePhotoForCurrentView, overlayPhotoId]
  );

  const handleDeleteAllPhotosInDay = useCallback(async (): Promise<boolean> => {
    if (!canDeleteAllPhotosInDayForCurrentView) return false;
    if (!overlayPhotoId) return false;
    const current = personalPhotos.find((p) => p.id === overlayPhotoId);
    if (!current) return false;
    const targetDate = current.date;
    const toDelete = personalPhotos.filter((p) => p.date === targetDate);
    if (toDelete.length === 0) return false;
    const msg =
      toDelete.length === 1
        ? "Удалить фото? Это действие нельзя отменить."
        : `Удалить все ${toDelete.length} фото этого дня? Это действие нельзя отменить.`;
    if (!window.confirm(msg)) return false;

    const cleanupDeletedPhotos = (deletedIds: string[]) => {
      const ids = new Set(deletedIds);
      setCardDragging(null);
      setHoveredPhotoId(null);
      setHoveredSeriesId(null);
      setOverlayEditMode(false);
      setOverlayPhotoId(null);
      setOverlayUrl(null);
      toDelete
        .filter((p) => ids.has(p.id))
        .forEach((p) => {
          const url = objectUrlsRef.current.get(p.id);
          if (url) {
            URL.revokeObjectURL(url);
            objectUrlsRef.current.delete(p.id);
          }
          imageBlobsRef.current.delete(p.id);
        });
      setPendingOffsets((prev) => {
        const next = { ...prev };
        deletedIds.forEach((id) => delete next[id]);
        return next;
      });
      setPersonalPhotos((prev) => prev.filter((p) => !ids.has(p.id)));
    };
    try {
      const deletedIds = await deletePhotosInDay(targetDate);
      const idsToCleanup =
        deletedIds.length > 0 ? deletedIds : toDelete.map((photo) => photo.id);
      cleanupDeletedPhotos(idsToCleanup);
      return idsToCleanup.length > 0;
    } catch (err) {
      console.error("[delete-day] failed", err);
      alert("Ошибка удаления фото за день. Попробуйте ещё раз.");
      return false;
    }
  }, [canDeleteAllPhotosInDayForCurrentView, overlayPhotoId, personalPhotos]);

  const changeScale = useCallback((direction: 1 | -1) => {
    const maxScaleIndex = isMobileTimeline
      ? MOBILE_MAX_SCALE_INDEX
      : scales.length - 1;
    setScaleIndex((current) => {
      const next = current + direction;
      if (next < 0 || next > maxScaleIndex) return current;
      return next;
    });
  }, [isMobileTimeline]);

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
    changeScale(e.deltaY > 0 ? 1 : -1);
  };

  useEffect(() => {
    timelinePanYRef.current = timelinePanY;
  }, [timelinePanY]);

  useEffect(() => {
    timelinePanBoundsRef.current = timelinePanBounds;
  }, [timelinePanBounds]);

  const cancelAutoCenter = useCallback(() => {
    if (autoCenterTimerRef.current) {
      clearTimeout(autoCenterTimerRef.current);
      autoCenterTimerRef.current = null;
    }
    setTimelineAutoCentering(false);
  }, []);

  const startAutoCenter = useCallback(() => {
    cancelAutoCenter();
    if (idleCenterTimerRef.current) {
      clearTimeout(idleCenterTimerRef.current);
      idleCenterTimerRef.current = null;
    }
    setTimelineAutoCentering(true);
    setTimelinePanY(0);
    autoCenterTimerRef.current = setTimeout(() => {
      autoCenterTimerRef.current = null;
      setTimelineAutoCentering(false);
    }, 3100);
  }, [cancelAutoCenter]);

  const scheduleIdleCenter = useCallback(() => {
    if (idleCenterTimerRef.current) clearTimeout(idleCenterTimerRef.current);
    if (timelinePanYRef.current === 0) return;
    idleCenterTimerRef.current = setTimeout(() => {
      idleCenterTimerRef.current = null;
      startAutoCenter();
    }, 10_000);
  }, [startAutoCenter]);

  useEffect(() => {
    if (!overlayPhotoId) return;
    startAutoCenter();
  }, [overlayPhotoId, startAutoCenter]);

  useEffect(() => {
    const getPinchDistance = (): number | null => {
      const points = [...timelinePointersRef.current.values()];
      if (points.length < 2) return null;
      const [a, b] = points;
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    const resetTouchGesture = (): void => {
      pinchZoomRef.current = null;
      if (dragRef.current) {
        dragRef.current = null;
        setIsDragging(false);
        scheduleIdleCenter();
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!timelinePointersRef.current.has(e.pointerId)) return;
      timelinePointersRef.current.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
      });

      if (timelinePointersRef.current.size < 2) return;
      e.preventDefault();
      const distance = getPinchDistance();
      if (distance === null) return;
      if (!pinchZoomRef.current) {
        pinchZoomRef.current = { lastDistance: distance, accumulatedDelta: 0 };
        return;
      }

      const pinch = pinchZoomRef.current;
      const delta = distance - pinch.lastDistance;
      pinch.lastDistance = distance;
      pinch.accumulatedDelta += delta;

      const thresholdPx = 28;
      if (Math.abs(pinch.accumulatedDelta) < thresholdPx) return;

      changeScale(pinch.accumulatedDelta > 0 ? -1 : 1);
      pinch.accumulatedDelta = 0;
    };

    const onPointerEnd = (e: PointerEvent) => {
      if (!timelinePointersRef.current.has(e.pointerId)) return;
      timelinePointersRef.current.delete(e.pointerId);
      if (timelinePointersRef.current.size < 2) {
        resetTouchGesture();
      } else {
        const distance = getPinchDistance();
        pinchZoomRef.current =
          distance === null ? null : { lastDistance: distance, accumulatedDelta: 0 };
      }
    };

    document.addEventListener("pointermove", onPointerMove, { passive: false });
    document.addEventListener("pointerup", onPointerEnd);
    document.addEventListener("pointercancel", onPointerEnd);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerEnd);
      document.removeEventListener("pointercancel", onPointerEnd);
    };
  }, [changeScale, scheduleIdleCenter]);

  useEffect(() => {
    return () => {
      if (autoCenterTimerRef.current) clearTimeout(autoCenterTimerRef.current);
      if (idleCenterTimerRef.current) clearTimeout(idleCenterTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect();
      const height = rect.height;
      const cards = [
        ...personalCardRefs.current.values(),
        ...historicalCardRefs.current.values(),
      ];
      if (cards.length === 0 || height <= 0) {
        setTimelinePanBounds({ min: 0, max: 0 });
        setTimelinePanY(0);
        return;
      }
      let minTop = Infinity;
      let maxBottom = -Infinity;
      for (const card of cards) {
        const r = card.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const relTop = r.top - rect.top;
        const relBottom = r.bottom - rect.top;
        if (relTop < minTop) minTop = relTop;
        if (relBottom > maxBottom) maxBottom = relBottom;
      }
      if (!isFinite(minTop) || !isFinite(maxBottom)) {
        setTimelinePanBounds({ min: 0, max: 0 });
        setTimelinePanY(0);
        return;
      }

      const paddingPx = 8;
      const bottomOverflow = maxBottom > height - paddingPx;
      const topOverflow = minTop < paddingPx;

      let min = 0;
      let max = 0;
      if (bottomOverflow) {
        // Drag down should reveal bottom cards (content moves up => panY becomes negative).
        min = Math.min(min, timelinePanYRef.current + (height - paddingPx - maxBottom));
      }
      if (topOverflow) {
        // Drag up should reveal top cards (content moves down => panY becomes positive).
        max = Math.max(max, timelinePanYRef.current + (paddingPx - minTop));
      }

      setTimelinePanBounds({ min, max });
      setTimelinePanY((prev) => Math.max(min, Math.min(max, prev)));
      if (min === 0 && max === 0 && timelinePanYRef.current !== 0) {
        startAutoCenter();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [
    layoutInfo,
    positionedPersonal.length,
    visiblePositionedHistorical.length,
    Object.keys(pendingOffsets).length,
    scale,
    startAutoCenter,
  ]);

  const onTimelinePointerDown: React.PointerEventHandler<HTMLDivElement> = (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.pointerType === "touch") {
      timelinePointersRef.current.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
      });
      if (timelinePointersRef.current.size >= 2) {
        e.preventDefault();
        e.stopPropagation();
        cancelAutoCenter();
        setIsDragging(false);
        dragRef.current = null;
        const points = [...timelinePointersRef.current.values()];
        const a = points[0]!;
        const b = points[1]!;
        pinchZoomRef.current = {
          lastDistance: Math.hypot(a.x - b.x, a.y - b.y),
          accumulatedDelta: 0,
        };
        return;
      }
    }
    if (!e.isPrimary) return;
    const target = e.target as Element;
    const photoCard = target.closest(".event-personal.event-photo");
    if (!e.altKey && photoCard) return;
    const histCard = target.closest(".event-historical");
    if (histCard) {
      return;
    }
    if (e.altKey && photoCard) {
      if (!canEditOffsetsForCurrentView) return;
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
            maxOffsetY: getPersonalPhotoMaxOffsetY(ev.laneIndex),
          };
          cardDragLastRef.current = {
            offsetXDays: active.offsetXDays,
            offsetY: active.offsetY,
          };
        }
      }
      return;
    }
    cancelAutoCenter();
    setIsDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startCenterMs: effectiveCenter.getTime(),
    };
    scheduleScrollStopRef.current();
  };

  useEffect(() => {
    if (!isDragging) return;
    const el = timelineRef.current;
    if (!el) return;
    const onPointerMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const { pointerId, startX, startCenterMs } = dragRef.current;
      if (e.pointerId !== pointerId) return;
      const deltaX = e.clientX - startX;
      const width = el.offsetWidth;
      const halfRange = scaleMeta[scale].rangeDays / 2;
      const rangeMs = halfRange * 2 * MS_IN_DAY;
      const deltaMs = (deltaX / width) * rangeMs;
      setCenterDate(
        clampCenterToToday(new Date(startCenterMs - deltaMs), scale)
      );
    };
    const onPointerUp = (e: PointerEvent) => {
      if (dragRef.current && e.pointerId !== dragRef.current.pointerId) return;
      setIsDragging(false);
      dragRef.current = null;
      scheduleIdleCenter();
    };
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
    };
  }, [cancelAutoCenter, isDragging, scale, scheduleIdleCenter]);

  useEffect(() => {
    if (!cardDragging || !cardDragRef.current) return;
    const el = timelineRef.current;
    if (!el) return;
    const maxOffset = MAX_OFFSET_DAYS[scale];
    const rangeDays = scaleMeta[scale].rangeDays;
    const onMouseMove = (e: MouseEvent) => {
      if (!cardDragRef.current) return;
      const { id, startX, startY, startOffsetXDays, startOffsetY, maxOffsetY } =
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
      const offsetY = Math.min(maxOffsetY, startOffsetY + deltaY);
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

  if (currentPathname === "/") {
    /** Step 6 baseline 112px; Step 7 ~20% smaller → 112 × 0.8 ≈ 90. */
    const landingAvatarPx = 90;
    const landingPageBg = "#e6e6e6";
    /** Resume shortcut uses remembered identity only; live auth comes from /api/me. */
    const landingSessionUser = rememberedBrowserUser;
    return (
      <div
        className="page page-landing"
        style={{
          padding: 0,
          gap: 0,
          background: landingPageBg,
          color: "#111",
        }}
      >
        <main className="landing-main">
          <div className="landing-shell">
            <div className="landing-visual">
              <div className="landing-logo-wrap">
                <img
                  src={ppyMainLogoUrl}
                  alt="PastPresentYou"
                  style={{
                    display: "block",
                    width: "100%",
                    maxWidth: "680px",
                    height: "auto",
                  }}
                />
                <div className="landing-owner-invite">
                  <a
                    href="/ivan"
                    className="landing-owner-photo-invite"
                    style={{
                      display: "block",
                      lineHeight: 0,
                      borderRadius: "50%",
                      pointerEvents: "auto",
                    }}
                  >
                    <img
                      src={ivanPhotoUrl}
                      alt="Открыть профиль"
                      width={landingAvatarPx}
                      height={landingAvatarPx}
                      style={{
                        width: "min(90px, 18vw)",
                        height: "min(90px, 18vw)",
                        borderRadius: "50%",
                        objectFit: "cover",
                        display: "block",
                      }}
                    />
                  </a>
                  <p className="landing-owner-invite-copy">
                    Посмотрите мой профиль
                  </p>
                </div>
              </div>
            </div>

            <div className="landing-auth-column">
              {canRenderGoogleButton ? (
                <div
                  ref={googleButtonContainerRef}
                  style={{ minHeight: 40, margin: "0 0 12px" }}
                />
              ) : null}
              {googleAuthStatusMessage ? (
                <p className="registration-error" role="alert">
                  {googleAuthStatusMessage}
                </p>
              ) : null}
              {landingSessionUser && (
                <section className="registration-card registration-card-primary landing-auth-resume-card">
                  <button
                    type="button"
                    className="registration-submit"
                    onClick={() => {
                      if (!rememberedBrowserUser) return;
                      const targetSlug = rememberedBrowserUser.profileSlug;
                      saveActiveBrowserUser(rememberedBrowserUser);
                      setActiveBrowserUser(rememberedBrowserUser);

                      if (typeof window !== "undefined") {
                        window.location.assign(`/${targetSlug}`);
                      }
                    }}
                  >
                    Вернуться как {landingSessionUser.profileDisplayName}
                  </button>
                </section>
              )}

              {landingSessionUser && (
                <p className="landing-auth-or-divider" role="presentation">
                  — или —
                </p>
              )}

              <RecoverAccessCard
                onRecovered={(profileSlug, rememberedUser) => {
                  setRememberedBrowserUser(rememberedUser);
                  if (rememberedUser) {
                    saveActiveBrowserUser(rememberedUser);
                    setActiveBrowserUser(rememberedUser);
                  }
                  void (async () => {
                    if (personalPhotoStorageIsServerMode) {
                      await refreshAuthenticatedUser();
                    }
                    if (typeof window !== "undefined") {
                      window.location.assign(`/${profileSlug}`);
                    }
                  })();
                }}
              />
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="page" onWheel={onWheel}>
      <header className="top-bar">
        <a className="top-bar-home-link" href="/" aria-label="Go to main page">
          <img
            className="top-bar-home-logo"
            src={ppyCompactLogoUrl}
            alt="Past Present You"
          />
        </a>
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
          {canAccessAdminFunctions && (
            <button
              type="button"
              className="top-bar-btn"
              onClick={() => setAdminFunctionsModalOpen(true)}
            >
              Админ функции
            </button>
          )}
          {canImportBackupForCurrentView && (
            <button
              type="button"
              className="top-bar-btn"
              onClick={() => setDataBackupModalOpen(true)}
              title="Сохранить подписи и фото в файлы на диск"
            >
              Резервная копия…
            </button>
          )}
          {!publicServerReadOnlyUx && (
            <button
              type="button"
              className="top-bar-btn"
              onClick={() => {
                if (canAddPhotoForCurrentView) setModalOpen(true);
              }}
              disabled={!canAddPhotoForCurrentView}
            >
              + Добавить фото
            </button>
          )}
          {isMissingProfileRoute && (
            <div className="top-bar-note">
              Профиль не найден: @{routeProfileSlug}
            </div>
          )}
          {isOwnerShortcutRoute &&
            !isMissingProfileRoute &&
            canonicalProfilePath && (
            <div className="top-bar-note">
              Канонический профиль: `{canonicalProfilePath}`
            </div>
          )}
          {publicServerReadOnlyUx ? (
            <div className="top-bar-note top-bar-note-readonly">
              Личный слой: только просмотр.
            </div>
          ) : null}
          <div className="scale">Масштаб: {scaleMeta[scale].label}</div>
          {authenticatedUser && (
            <div className="account-menu" ref={accountMenuRef}>
              <button
                type="button"
                className="account-avatar-button"
                onClick={() => setAccountMenuOpen((open) => !open)}
                aria-label="Открыть меню профиля"
                aria-haspopup="menu"
                aria-expanded={accountMenuOpen}
                title={authenticatedUser.email}
              >
                {accountInitials}
              </button>
              {accountMenuOpen && (
                <div className="account-menu-panel" role="menu">
                  <div className="account-menu-header">
                    <div className="account-menu-avatar" aria-hidden="true">
                      {accountInitials}
                    </div>
                    <div className="account-menu-user">
                      <div className="account-menu-email">
                        {authenticatedUser.email}
                      </div>
                      {activeProfile && (
                        <div className="account-menu-profile">
                          @{activeProfile.slug}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="account-menu-actions">
                    {shouldShowReturnToOwnProfile && (
                      <button
                        type="button"
                        className="account-menu-action"
                        onClick={handleReturnToOwnProfile}
                        role="menuitem"
                      >
                        Вернуться в свой профиль
                      </button>
                    )}
                    <button
                      type="button"
                      className="account-menu-action"
                      onClick={handleBrowserActiveSignOut}
                      role="menuitem"
                    >
                      Выйти
                    </button>
                    <button
                      type="button"
                      className="account-menu-action account-menu-action-destructive"
                      onClick={handleForgetThisDevice}
                      role="menuitem"
                    >
                      Забыть это устройство
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      {modalOpen && canAddPhotoForCurrentView && (
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

      {dataBackupModalOpen && (
        <DataBackupModal
          onClose={() => setDataBackupModalOpen(false)}
          onImportDone={handleBackupImportDone}
          isReadOnly={!canImportBackupForCurrentView}
        />
      )}

      {adminFunctionsModalOpen && canAccessAdminFunctions && (
        <AdminFunctionsModal
          isOpen={adminFunctionsModalOpen}
          onClose={() => setAdminFunctionsModalOpen(false)}
          profiles={adminProfiles}
          isLoading={adminProfilesLoading}
          errorMessage={adminProfilesError}
        />
      )}

      {overlayPhotoId && (
        <PersonalPhotoModal
          photo={
            (() => {
              const p = personalPhotos.find((x) => x.id === overlayPhotoId);
              return p
                ? {
                    id: p.id,
                    title: p.title,
                    date: p.date,
                    note: p.note,
                    seriesId: p.seriesId,
                    seriesReminder: p.seriesReminder,
                    social: p.social,
                  }
                : null;
            })()
          }
          photosInDay={photosInDay.map((p) => ({
            id: p.id,
            title: p.title,
            date: p.date,
            note: p.note,
            seriesReminder: p.seriesReminder,
            social: p.social,
          }))}
          imageUrl={overlayUrl}
          isOpen={true}
          isEditMode={overlayEditMode}
          isLinkingMode={linkingMode}
          linkingSourcePhotoId={linkingSourcePhotoId}
          onClose={handleOverlayClose}
          onEdit={() => {
            if (canEditMetadataForCurrentView) {
              setOverlayEditMode(true);
            }
          }}
          onSave={handleOverlaySave}
          onRenameSeries={handleRenameSeries}
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
          onUnlinkFromSeries={handleUnlinkFromSeries}
          onCancelLink={handleCancelLink}
          onCloseLinkPrompt={() => setOverlayPhotoId(null)}
          existingSeries={Object.entries(seriesMap).map(([id, title]) => ({
            id,
            title,
          }))}
          onDeletePhoto={handleDeletePhoto}
          onDeleteAllPhotosInDay={handleDeleteAllPhotosInDay}
          disableNonMetadataActions={
            !canReplacePhotoForCurrentView ||
            !canAddPhotoToDayForCurrentView ||
            !canDeletePhotoForCurrentView ||
            !canDeleteAllPhotosInDayForCurrentView
          }
          allowMetadataEdit={canEditMetadataForCurrentView}
          allowReplacePhoto={canReplacePhotoForCurrentView}
          allowDeletePhoto={canDeletePhotoForCurrentView}
          allowAddPhotoToDay={canAddPhotoToDayForCurrentView}
          allowDeleteAllPhotosInDay={canDeleteAllPhotosInDayForCurrentView}
          allowSeriesLinking={canLinkSeriesForCurrentView}
          allowSeriesUnlinking={canUnlinkSeriesForCurrentView}
          isAuthenticated={authenticatedUser !== null}
          adminPhotoViewCount={
            isAuthenticatedAdmin ? adminOverlayPhotoViewCount : null
          }
        />
      )}

      {linkingMode && !overlayPhotoId && !publicServerReadOnlyUx && (
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
        onPointerDown={onTimelinePointerDown}
      >
        {activeProfile && (
          <div className="timeline-profile-notes">
            <div className="top-bar-note" title={`@${activeProfile.slug}`}>
              Профиль: {activeProfile.displayName || `@${activeProfile.slug}`}
            </div>
            {canManageCurrentProfile && (
              <div className="top-bar-note top-bar-note-success">
                Это ваш профиль
              </div>
            )}
          </div>
        )}
        <div
          className="timeline-pan"
          style={{
            transform: `translateY(${timelinePanY}px)`,
            transition: timelineAutoCentering ? "transform 3s ease-out" : undefined,
          }}
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
              viewportAdjustY={cardViewportAdjustY}
              cardDragging={cardDragging}
              pendingOffsets={pendingOffsets}
              getActiveOffsets={getActiveOffsets}
              isDirty={isDirty}
              altHeld={altHeld}
              showOffsetCommitControls={canEditOffsetsForCurrentView}
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
                viewportAdjustY={cardViewportAdjustY}
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
                onEventOpen={setSelectedHistoricalEvent}
              />
              </div>
            )}
          </>
        )}
        </div>
      </main>
    </div>
  );
}

export default App;
