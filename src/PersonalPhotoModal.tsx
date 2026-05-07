import { useEffect, useCallback, useRef, useState } from "react";
import {
  CLOSE_REACTION,
  normalizePhotoSocialSettings,
  type PhotoSocialSettings,
} from "./photoSocial";

export type PersonalPhotoForModal = {
  id: string;
  title: string;
  date: string;
  note?: string;
  seriesId?: string;
  seriesReminder?: boolean;
  social?: PhotoSocialSettings;
};

export type PhotoInSeriesForModal = {
  id: string;
  image: string;
  date: string;
  title: string;
};

type PersonalPhotoModalProps = {
  photo: PersonalPhotoForModal | null;
  photosInDay: PersonalPhotoForModal[];
  photosInSeries: PhotoInSeriesForModal[];
  seriesTitle: string | null;
  imageUrl: string | null;
  isOpen: boolean;
  isEditMode: boolean;
  isLinkingMode: boolean;
  linkingSourcePhotoId: string | null;
  onClose: () => void;
  onEdit: () => void;
  onSave: (
    id: string,
    data: {
      date: string;
      title: string;
      note: string;
      seriesReminder: boolean;
      social: PhotoSocialSettings;
    }
  ) => void;
  onRenameSeries: (seriesId: string, title: string) => void | Promise<void>;
  onReplaceImage: (id: string, file: File) => void;
  onAddPhotoToDay: (file: File) => void;
  onNavigate: (photoId: string) => void;
  onStartLinking: () => void;
  onConfirmLink: (targetPhotoId: string, seriesId: string | null) => void;
  onUnlinkFromSeries: (id: string) => void;
  onCancelLink: () => void;
  onCloseLinkPrompt: () => void;
  existingSeries: { id: string; title: string }[];
  onDeletePhoto: (id: string) => boolean | Promise<boolean>;
  onDeleteAllPhotosInDay: () => boolean | Promise<boolean>;
  disableNonMetadataActions?: boolean;
  allowMetadataEdit?: boolean;
  allowReplacePhoto?: boolean;
  allowDeletePhoto?: boolean;
  allowAddPhotoToDay?: boolean;
  allowDeleteAllPhotosInDay?: boolean;
  allowSeriesLinking?: boolean;
  allowSeriesUnlinking?: boolean;
  adminPhotoViewCount?: number | null;
  disabledActionsMessage?: string;
};

const todayStr = () => new Date().toISOString().slice(0, 10);

function formatSeriesDate(dateStr: string): string {
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${day}.${m}.${y}`;
}

export function PersonalPhotoModal({
  photo,
  photosInDay,
  photosInSeries,
  seriesTitle,
  imageUrl,
  isOpen,
  isEditMode,
  isLinkingMode,
  linkingSourcePhotoId,
  onClose,
  onEdit,
  onSave,
  onRenameSeries,
  onReplaceImage,
  onAddPhotoToDay,
  onNavigate,
  onStartLinking,
  onConfirmLink,
  onUnlinkFromSeries,
  onCancelLink,
  onCloseLinkPrompt,
  existingSeries,
  onDeletePhoto,
  onDeleteAllPhotosInDay,
  disableNonMetadataActions = false,
  allowMetadataEdit = false,
  allowReplacePhoto = false,
  allowDeletePhoto = false,
  allowAddPhotoToDay = false,
  allowDeleteAllPhotosInDay = false,
  allowSeriesLinking = false,
  allowSeriesUnlinking = false,
  adminPhotoViewCount = null,
  disabledActionsMessage = "Server mode: image/add/delete actions are still disabled for now",
}: PersonalPhotoModalProps) {
  const [linkStep, setLinkStep] = useState<"confirm" | "chooseSeries">("confirm");
  const [draftDate, setDraftDate] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftNote, setDraftNote] = useState("");
  const [draftSeriesReminder, setDraftSeriesReminder] = useState(false);
  const [draftSocial, setDraftSocial] = useState<PhotoSocialSettings>(
    normalizePhotoSocialSettings(undefined)
  );
  const [renamingSeries, setRenamingSeries] = useState(false);
  const [draftSeriesTitle, setDraftSeriesTitle] = useState("");
  const [seriesGalleryOpen, setSeriesGalleryOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addPhotoInputRef = useRef<HTMLInputElement>(null);
  const seriesTitleInputRef = useRef<HTMLInputElement>(null);
  const photoModalContentRef = useRef<HTMLDivElement>(null);
  const panelTouchStartRef = useRef<{ x: number; y: number } | null>(null);
  const currentSeriesIndex = photo
    ? photosInSeries.findIndex((p) => p.id === photo.id)
    : -1;
  const canSetSeriesReminder = !!photo?.seriesId && currentSeriesIndex > 0;
  const savedSeriesReminder =
    canSetSeriesReminder && photo?.seriesReminder === true;

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (seriesGalleryOpen) {
          setSeriesGalleryOpen(false);
          return;
        }
        if (isEditMode) {
          /* could cancel edit - for now just close */
        }
        onClose();
      }
    },
    [onClose, isEditMode, seriesGalleryOpen]
  );

  useEffect(() => {
    if (isOpen && photo) {
      setDraftDate(photo.date);
      setDraftTitle(photo.title);
      setDraftNote(photo.note ?? "");
      setDraftSeriesReminder(savedSeriesReminder);
      setDraftSocial(normalizePhotoSocialSettings(photo.social));
      setRenamingSeries(false);
      setSeriesGalleryOpen(false);
    }
  }, [isOpen, photo?.id, savedSeriesReminder]);

  useEffect(() => {
    if (!isOpen || photosInSeries.length <= 1) {
      setSeriesGalleryOpen(false);
    }
  }, [isOpen, photosInSeries.length]);

  useEffect(() => {
    if (!isOpen) return;
    if (!photo?.seriesId) {
      setDraftSeriesTitle("");
      setRenamingSeries(false);
      return;
    }
    if (!renamingSeries) {
      setDraftSeriesTitle(seriesTitle ?? "");
    }
  }, [isOpen, photo?.seriesId, seriesTitle, renamingSeries]);

  useEffect(() => {
    if (renamingSeries) {
      seriesTitleInputRef.current?.focus();
      seriesTitleInputRef.current?.select();
    }
  }, [renamingSeries]);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
  }, [isOpen, handleEscape]);

  const handleDeleteThisPhoto = useCallback(async () => {
    if (!photo) return;
    const deleted = await onDeletePhoto(photo.id);
    if (deleted) {
      onClose();
    }
  }, [photo, onDeletePhoto, onClose]);

  const handleDeleteAllInDay = useCallback(async () => {
    const deleted = await onDeleteAllPhotosInDay();
    if (deleted) {
      onClose();
    }
  }, [onDeleteAllPhotosInDay, onClose]);

  const handleUnlinkSeries = useCallback(() => {
    if (photo) {
      onUnlinkFromSeries(photo.id);
    }
  }, [photo, onUnlinkFromSeries]);

  const handleRenameSeriesSave = useCallback(async () => {
    if (!photo?.seriesId) return;
    const title = draftSeriesTitle.trim();
    if (!title) {
      alert("Название серии не может быть пустым.");
      return;
    }
    try {
      await onRenameSeries(photo.seriesId, title);
      setRenamingSeries(false);
    } catch (err) {
      console.error("[series] rename failed", err);
      alert("Ошибка переименования серии. Попробуйте ещё раз.");
    }
  }, [photo?.seriesId, draftSeriesTitle, onRenameSeries]);

  const handleSave = useCallback(() => {
    if (photo) {
      onSave(photo.id, {
        date: draftDate,
        title: draftTitle.trim() || "Фото",
        note: draftNote,
        seriesReminder: canSetSeriesReminder ? draftSeriesReminder : false,
        social: draftSocial,
      });
    }
  }, [
    photo,
    draftDate,
    draftTitle,
    draftNote,
    draftSeriesReminder,
    draftSocial,
    canSetSeriesReminder,
    onSave,
  ]);

  const handleAllowReactionsChange = useCallback((enabled: boolean) => {
    setDraftSocial({
      reactionsEnabled: enabled,
      allowedReactions: enabled ? [CLOSE_REACTION] : [],
    });
  }, []);

  const handleCloseReactionChange = useCallback((enabled: boolean) => {
    setDraftSocial((current) => ({
      ...current,
      allowedReactions: enabled ? [CLOSE_REACTION] : [],
    }));
  }, []);

  const handleReplaceImage = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (file && photo) {
        onReplaceImage(photo.id, file);
      }
    },
    [photo, onReplaceImage]
  );

  const handleAddPhotoToDay = useCallback(() => {
    addPhotoInputRef.current?.click();
  }, []);

  const handleAddPhotoFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (file) {
        onAddPhotoToDay(file);
      }
    },
    [onAddPhotoToDay]
  );

  const currentIndex = photo
    ? photosInDay.findIndex((p) => p.id === photo.id)
    : -1;
  const canCycle = photosInDay.length > 1;
  const hasSeriesGallery = photosInSeries.length > 1;
  const hasStartedEditing =
    !!photo &&
    (draftDate !== photo.date ||
      draftTitle !== photo.title ||
      draftNote !== (photo.note ?? "") ||
      draftSeriesReminder !== savedSeriesReminder);
  const seriesReminderTarget =
    savedSeriesReminder && currentSeriesIndex > 0
      ? photosInSeries[currentSeriesIndex - 1]
      : null;
  const prevPhoto = canCycle
    ? photosInDay[currentIndex <= 0 ? photosInDay.length - 1 : currentIndex - 1]
    : null;
  const nextPhoto = canCycle
    ? photosInDay[currentIndex >= photosInDay.length - 1 ? 0 : currentIndex + 1]
    : null;

  const handlePrev = useCallback(() => {
    if (prevPhoto) onNavigate(prevPhoto.id);
  }, [prevPhoto, onNavigate]);

  const handleNext = useCallback(() => {
    if (nextPhoto) onNavigate(nextPhoto.id);
  }, [nextPhoto, onNavigate]);

  const handleReadText = useCallback(() => {
    const content = photoModalContentRef.current;
    if (!content) return;
    content.scrollTo({
      left: content.clientWidth,
      behavior: "smooth",
    });
  }, []);

  const handleShowPhoto = useCallback(() => {
    const content = photoModalContentRef.current;
    if (!content) return;
    content.scrollTo({
      left: 0,
      behavior: "smooth",
    });
  }, []);

  const onPanelTouchStart = useCallback((e: React.TouchEvent) => {
    if (!window.matchMedia("(max-width: 640px)").matches) return;
    panelTouchStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
    };
  }, []);

  const onPanelTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const start = panelTouchStartRef.current;
      if (!start) return;
      const deltaX = e.touches[0].clientX - start.x;
      const deltaY = e.touches[0].clientY - start.y;
      if (Math.abs(deltaX) < 72 || Math.abs(deltaX) < Math.abs(deltaY) * 1.4) {
        return;
      }
      handleShowPhoto();
      panelTouchStartRef.current = null;
    },
    [handleShowPhoto]
  );

  const onPanelTouchEnd = useCallback(() => {
    panelTouchStartRef.current = null;
  }, []);

  const touchStartRef = useRef<number | null>(null);
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (window.matchMedia("(max-width: 640px)").matches) return;
    touchStartRef.current = e.touches[0].clientX;
  }, []);
  const onTouchEnd = useCallback(() => {
    touchStartRef.current = null;
  }, []);
  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (window.matchMedia("(max-width: 640px)").matches) return;
      if (touchStartRef.current === null) return;
      const delta = e.touches[0].clientX - touchStartRef.current;
      const threshold = 50;
      if (delta < -threshold && nextPhoto) {
        onNavigate(nextPhoto.id);
        touchStartRef.current = null;
      } else if (delta > threshold && prevPhoto) {
        onNavigate(prevPhoto.id);
        touchStartRef.current = null;
      }
    },
    [prevPhoto, nextPhoto, onNavigate]
  );

  const isLinkTarget =
    isLinkingMode &&
    linkingSourcePhotoId &&
    photo &&
    photo.id !== linkingSourcePhotoId;
  const isLinkSource =
    isLinkingMode && linkingSourcePhotoId && photo?.id === linkingSourcePhotoId;

  useEffect(() => {
    if (isLinkTarget) setLinkStep("confirm");
  }, [isLinkTarget, photo?.id]);

  if (!isOpen || !photo) return null;

  const photoSocial = normalizePhotoSocialSettings(photo.social);
  const canShowCloseReaction =
    photoSocial.reactionsEnabled &&
    photoSocial.allowedReactions.includes(CLOSE_REACTION);

  if (isLinkSource) {
    return (
      <div
        className="personal-modal-overlay"
        onClick={onCloseLinkPrompt}
        role="dialog"
        aria-modal="true"
      >
        <div
          className="personal-modal-card personal-modal-card-compact"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="personal-modal-link-hint">
            Режим связывания. Закройте и нажмите на другое фото на таймлайне.
          </p>
          <div className="personal-modal-link-actions">
            <button
              type="button"
              className="personal-modal-btn personal-modal-btn-secondary"
              onClick={onCloseLinkPrompt}
            >
              Закрыть
            </button>
            <button
              type="button"
              className="personal-modal-btn personal-modal-btn-secondary"
              onClick={onCancelLink}
            >
              Отмена
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (isLinkTarget) {
    const handleSelectSeries = (seriesId: string | null) => {
      onConfirmLink(photo.id, seriesId);
    };

    return (
      <div
        className="personal-modal-overlay"
        onClick={onCancelLink}
        role="dialog"
        aria-modal="true"
      >
        <div
          className="personal-modal-card"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="personal-modal-close"
            onClick={onCancelLink}
            aria-label="Закрыть"
          >
            ×
          </button>
          <div className="personal-modal-content">
            <div className="personal-modal-image-wrap">
              {imageUrl ? (
                <img
                  src={imageUrl}
                  alt={photo.title}
                  className="personal-modal-image"
                />
              ) : (
                <div className="personal-modal-image-placeholder" />
              )}
            </div>
            <div className="personal-modal-panel">
              {linkStep === "confirm" ? (
                <>
                  <h2 className="personal-modal-title">{photo.title}</h2>
                  <div className="personal-modal-date">{photo.date}</div>
                  <p className="personal-modal-link-hint">
                    Связать это фото с выбранным?
                  </p>
                  <div className="personal-modal-link-actions">
                    <button
                      type="button"
                      className="personal-modal-btn personal-modal-btn-secondary"
                      onClick={() => onCancelLink()}
                    >
                      Отмена
                    </button>
                    <button
                      type="button"
                      className="personal-modal-btn personal-modal-btn-primary"
                      onClick={() => setLinkStep("chooseSeries")}
                    >
                      Связать
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h2 className="personal-modal-title">Выберите группу</h2>
                  <div className="personal-modal-series-list">
                    {existingSeries.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className="personal-modal-series-item"
                        onClick={() => handleSelectSeries(s.id)}
                      >
                        {s.title}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="personal-modal-series-item personal-modal-series-item-new"
                      onClick={() => handleSelectSeries(null)}
                    >
                      Новая группа
                    </button>
                  </div>
                  <div className="personal-modal-link-actions">
                    <button
                      type="button"
                      className="personal-modal-btn personal-modal-btn-secondary"
                      onClick={() => setLinkStep("confirm")}
                    >
                      Назад
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="personal-modal-overlay personal-modal-overlay-photo"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="personal-modal-title"
    >
      <div
        className="personal-modal-card personal-modal-card-photo"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="personal-modal-close"
          onClick={onClose}
          aria-label="Закрыть"
        >
          ×
        </button>

        <div className="personal-modal-content" ref={photoModalContentRef}>
          <div
            className="personal-modal-image-wrap"
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          >
            {imageUrl ? (
              <img
                src={imageUrl}
                alt={photo.title}
                className="personal-modal-image"
              />
            ) : (
              <div className="personal-modal-image-placeholder" />
            )}
            {seriesReminderTarget && !isEditMode && (
              <button
                type="button"
                className="personal-modal-series-reminder personal-modal-series-reminder-photo"
                onClick={() => onNavigate(seriesReminderTarget.id)}
              >
                Начало здесь
              </button>
            )}
            <div className="personal-modal-mobile-actions">
              {seriesReminderTarget && !isEditMode && (
                <button
                  type="button"
                  className="personal-modal-series-reminder personal-modal-series-reminder-mobile"
                  onClick={() => onNavigate(seriesReminderTarget.id)}
                >
                  Начало здесь
                </button>
              )}
              <button
                type="button"
                className="personal-modal-read-text-trigger"
                onClick={handleReadText}
              >
                Читать текст
              </button>
              {hasSeriesGallery && (
                <button
                  type="button"
                  className="personal-modal-series-mobile-trigger"
                  onClick={() => setSeriesGalleryOpen(true)}
                >
                  Фото серии
                </button>
              )}
            </div>
            {photosInDay.length > 1 && (
              <div className="personal-modal-nav">
                <button
                  type="button"
                  className="personal-modal-nav-btn"
                  onClick={handlePrev}
                  disabled={!canCycle}
                  aria-label="Предыдущее фото"
                >
                  ←
                </button>
                <span className="personal-modal-nav-counter">
                  {currentIndex + 1} / {photosInDay.length}
                </span>
                <button
                  type="button"
                  className="personal-modal-nav-btn"
                  onClick={handleNext}
                  disabled={!canCycle}
                  aria-label="Следующее фото"
                >
                  →
                </button>
              </div>
            )}
          </div>

          <div
            className="personal-modal-panel"
            onTouchStart={onPanelTouchStart}
            onTouchMove={onPanelTouchMove}
            onTouchEnd={onPanelTouchEnd}
          >
            {isEditMode ? (
              <>
                <div className="personal-modal-field">
                  <label>Дата фото</label>
                  <input
                    type="date"
                    value={draftDate}
                    max={todayStr()}
                    onChange={(e) => setDraftDate(e.target.value)}
                    className="personal-modal-input"
                  />
                </div>
                <div className="personal-modal-field">
                  <label>Подпись фото</label>
                  <input
                    type="text"
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    placeholder="Краткая подпись"
                    className="personal-modal-input"
                  />
                </div>
                {photo.seriesId && (
                  <div className="personal-modal-field personal-modal-field-series">
                    <label>Серия</label>
                    {!renamingSeries ? (
                      <div className="personal-modal-series-rename-row">
                        <div
                          className="personal-modal-series-name"
                          title={seriesTitle ?? ""}
                        >
                          {seriesTitle ?? "Серия"}
                        </div>
                        <button
                          type="button"
                          className="personal-modal-btn personal-modal-btn-secondary"
                          onClick={() => setRenamingSeries(true)}
                          disabled={!allowMetadataEdit}
                          title={!allowMetadataEdit ? disabledActionsMessage : undefined}
                        >
                          Переименовать серию
                        </button>
                      </div>
                    ) : (
                      <>
                        <input
                          ref={seriesTitleInputRef}
                          type="text"
                          value={draftSeriesTitle}
                          onChange={(e) => setDraftSeriesTitle(e.target.value)}
                          placeholder="Название серии"
                          className="personal-modal-input"
                        />
                        <div className="personal-modal-series-rename-actions">
                          <button
                            type="button"
                            className="personal-modal-btn personal-modal-btn-secondary"
                            onClick={() => setRenamingSeries(false)}
                          >
                            Отмена
                          </button>
                          <button
                            type="button"
                            className="personal-modal-btn personal-modal-btn-primary"
                            onClick={() => void handleRenameSeriesSave()}
                            disabled={!draftSeriesTitle.trim() || !allowMetadataEdit}
                            title={!allowMetadataEdit ? disabledActionsMessage : undefined}
                          >
                            Сохранить название
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
                <div className="personal-modal-field personal-modal-field-note">
                  <label>Текст карточки</label>
                  <textarea
                    className={`personal-modal-note ${hasStartedEditing ? "personal-modal-note-expanded" : ""}`}
                    value={draftNote}
                    onChange={(e) => setDraftNote(e.target.value)}
                    placeholder="Добавить описание..."
                    rows={hasStartedEditing ? 16 : 6}
                  />
                </div>
                {canSetSeriesReminder && (
                  <label className="personal-modal-checkbox">
                    <input
                      type="checkbox"
                      checked={draftSeriesReminder}
                      onChange={(e) => setDraftSeriesReminder(e.target.checked)}
                    />
                    <span>Поставить напоминание о серии</span>
                  </label>
                )}
                <div className="personal-modal-social-settings">
                  <div className="personal-modal-social-title">Social interaction</div>
                  <label className="personal-modal-checkbox">
                    <input
                      type="checkbox"
                      checked={draftSocial.reactionsEnabled}
                      onChange={(e) => handleAllowReactionsChange(e.target.checked)}
                    />
                    <span>Allow reactions</span>
                  </label>
                  {draftSocial.reactionsEnabled && (
                    <div className="personal-modal-social-nested">
                      <div className="personal-modal-social-label">
                        Allowed reactions
                      </div>
                      <label className="personal-modal-checkbox">
                        <input
                          type="checkbox"
                          checked={draftSocial.allowedReactions.includes(CLOSE_REACTION)}
                          onChange={(e) =>
                            handleCloseReactionChange(e.target.checked)
                          }
                        />
                        <span>Feels close</span>
                      </label>
                    </div>
                  )}
                </div>
                <div className="personal-modal-edit-actions">
                  {disableNonMetadataActions && allowMetadataEdit && (
                    <p className="personal-readonly-note personal-readonly-note-compact">
                      {disabledActionsMessage}
                    </p>
                  )}
                  {!hasStartedEditing && (
                    <>
                      <button
                        type="button"
                        className="personal-modal-btn personal-modal-btn-secondary"
                        onClick={handleReplaceImage}
                        disabled={!allowReplacePhoto}
                        title={
                          !allowReplacePhoto
                            ? disabledActionsMessage
                            : undefined
                        }
                      >
                        Поменять фото
                      </button>
                      <button
                        type="button"
                        className="personal-modal-btn personal-modal-btn-secondary"
                        onClick={handleAddPhotoToDay}
                        disabled={!allowAddPhotoToDay}
                        title={
                          !allowAddPhotoToDay
                            ? disabledActionsMessage
                            : undefined
                        }
                      >
                        Добавить фото в этот день
                      </button>
                      <button
                        type="button"
                        className="personal-modal-btn personal-modal-btn-secondary"
                        onClick={onStartLinking}
                        disabled={disableNonMetadataActions && !allowSeriesLinking}
                        title={
                          disableNonMetadataActions && !allowSeriesLinking
                            ? disabledActionsMessage
                            : undefined
                        }
                      >
                        Связать фото
                      </button>
                      {photo.seriesId && (
                        <button
                          type="button"
                          className="personal-modal-btn personal-modal-btn-secondary"
                          onClick={handleUnlinkSeries}
                          disabled={disableNonMetadataActions && !allowSeriesUnlinking}
                          title={
                            disableNonMetadataActions && !allowSeriesUnlinking
                              ? disabledActionsMessage
                              : undefined
                          }
                        >
                          Убрать из серии
                        </button>
                      )}
                      <button
                        type="button"
                        className="personal-modal-btn personal-modal-btn-danger"
                        onClick={handleDeleteThisPhoto}
                        disabled={!allowDeletePhoto}
                        title={
                          !allowDeletePhoto
                            ? disabledActionsMessage
                            : undefined
                        }
                      >
                        Удалить это фото
                      </button>
                      <button
                        type="button"
                        className="personal-modal-btn personal-modal-btn-danger"
                        onClick={handleDeleteAllInDay}
                        disabled={!allowDeleteAllPhotosInDay}
                        title={
                          !allowDeleteAllPhotosInDay
                            ? disabledActionsMessage
                            : undefined
                        }
                      >
                        Удалить все фото этого дня
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="personal-modal-btn personal-modal-btn-primary"
                    onClick={handleSave}
                    disabled={!allowMetadataEdit}
                    title={!allowMetadataEdit ? disabledActionsMessage : undefined}
                  >
                    Сохранить
                  </button>
                </div>
                {(allowReplacePhoto || allowAddPhotoToDay) && (
                  <>
                    {allowReplacePhoto && (
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        className="personal-modal-file-input"
                        onChange={handleFileChange}
                        aria-hidden
                      />
                    )}
                    {allowAddPhotoToDay && (
                      <input
                        ref={addPhotoInputRef}
                        type="file"
                        accept="image/*"
                        className="personal-modal-file-input"
                        onChange={handleAddPhotoFileChange}
                        aria-hidden
                      />
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                <h2 id="personal-modal-title" className="personal-modal-title">
                  {photo.title}
                </h2>
                <div className="personal-modal-date">{photo.date}</div>
                <div className="personal-modal-note-readonly">
                  {photo.note || "—"}
                </div>
                {canShowCloseReaction && (
                  <div className="personal-modal-reactions">
                    <button
                      type="button"
                      className="personal-modal-reaction-placeholder"
                      disabled
                    >
                      Мне это близко
                    </button>
                  </div>
                )}
                <div className="personal-modal-footer">
                  {disableNonMetadataActions && allowMetadataEdit && (
                    <p className="personal-readonly-note personal-readonly-note-compact">
                      {disabledActionsMessage}
                    </p>
                  )}
                  {allowMetadataEdit && adminPhotoViewCount !== null && (
                    <span className="personal-modal-admin-views">
                      Просмотров: {adminPhotoViewCount}
                    </span>
                  )}
                  {allowMetadataEdit && (
                    <button
                      type="button"
                      className="personal-modal-btn-edit"
                      onClick={onEdit}
                    >
                      Редактировать
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {photosInSeries.length > 1 && (
          <div className="personal-modal-series">
            <div className="personal-modal-series-title">
              {seriesTitle ? `Серия: ${seriesTitle}` : "Связанные фото"}
            </div>
            <div className="personal-modal-series-scroll">
              {photosInSeries.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`personal-modal-series-thumb ${p.id === photo.id ? "personal-modal-series-thumb-active" : ""}`}
                  onClick={() => p.id !== photo.id && onNavigate(p.id)}
                >
                  {p.image ? (
                    <img
                      src={p.image}
                      alt={p.title}
                      className="personal-modal-series-thumb-img"
                    />
                  ) : (
                    <div className="personal-modal-series-thumb-placeholder" />
                  )}
                  <span className="personal-modal-series-thumb-date">
                    {formatSeriesDate(p.date)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        {hasSeriesGallery && seriesGalleryOpen && (
          <div
            className="personal-modal-series-gallery"
            aria-label="Фото серии"
            onClick={() => setSeriesGalleryOpen(false)}
          >
            <div
              className="personal-modal-series-gallery-panel"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="personal-modal-series-gallery-header">
                <div className="personal-modal-series-gallery-heading">
                  <div className="personal-modal-series-gallery-eyebrow">
                    Фото серии
                  </div>
                  <h3 className="personal-modal-series-gallery-title">
                    {seriesTitle ?? "Связанные фото"}
                  </h3>
                </div>
                <button
                  type="button"
                  className="personal-modal-series-gallery-close"
                  onClick={() => setSeriesGalleryOpen(false)}
                  aria-label="Закрыть фото серии"
                >
                  ×
                </button>
              </div>
              <div className="personal-modal-series-gallery-grid">
                {photosInSeries.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`personal-modal-series-gallery-item ${p.id === photo.id ? "personal-modal-series-gallery-item-active" : ""}`}
                    onClick={() => {
                      if (p.id !== photo.id) onNavigate(p.id);
                      setSeriesGalleryOpen(false);
                    }}
                  >
                    <span className="personal-modal-series-gallery-image-wrap">
                      {p.image ? (
                        <img
                          src={p.image}
                          alt={p.title}
                          className="personal-modal-series-gallery-image"
                        />
                      ) : (
                        <span className="personal-modal-series-gallery-placeholder" />
                      )}
                    </span>
                    <span className="personal-modal-series-gallery-meta">
                      <span className="personal-modal-series-gallery-date">
                        {formatSeriesDate(p.date)}
                      </span>
                      <span className="personal-modal-series-gallery-caption">
                        {p.title}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
