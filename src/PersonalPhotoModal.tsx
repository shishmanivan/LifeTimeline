import { useEffect, useCallback, useRef, useState } from "react";

export type PersonalPhotoForModal = {
  id: string;
  title: string;
  date: string;
  note?: string;
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
    data: { date: string; title: string; note: string }
  ) => void;
  onReplaceImage: (id: string, file: File) => void;
  onAddPhotoToDay: (file: File) => void;
  onNavigate: (photoId: string) => void;
  onStartLinking: () => void;
  onConfirmLink: (targetPhotoId: string, seriesId: string | null) => void;
  onCancelLink: () => void;
  onCloseLinkPrompt: () => void;
  existingSeries: { id: string; title: string }[];
  onDeletePhoto: (id: string) => void;
  onDeleteAllPhotosInDay: () => void;
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
  onReplaceImage,
  onAddPhotoToDay,
  onNavigate,
  onStartLinking,
  onConfirmLink,
  onCancelLink,
  onCloseLinkPrompt,
  existingSeries,
  onDeletePhoto,
  onDeleteAllPhotosInDay,
}: PersonalPhotoModalProps) {
  const [linkStep, setLinkStep] = useState<"confirm" | "chooseSeries">("confirm");
  const [draftDate, setDraftDate] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftNote, setDraftNote] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addPhotoInputRef = useRef<HTMLInputElement>(null);

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isEditMode) {
          /* could cancel edit - for now just close */
        }
        onClose();
      }
    },
    [onClose, isEditMode]
  );

  useEffect(() => {
    if (isOpen && photo) {
      setDraftDate(photo.date);
      setDraftTitle(photo.title);
      setDraftNote(photo.note ?? "");
    }
  }, [isOpen, photo?.id]);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
  }, [isOpen, handleEscape]);

  const handleDeleteThisPhoto = useCallback(() => {
    if (photo) {
      onDeletePhoto(photo.id);
      onClose();
    }
  }, [photo, onDeletePhoto, onClose]);

  const handleDeleteAllInDay = useCallback(() => {
    onDeleteAllPhotosInDay();
    onClose();
  }, [onDeleteAllPhotosInDay, onClose]);

  const handleSave = useCallback(() => {
    if (photo) {
      onSave(photo.id, {
        date: draftDate,
        title: draftTitle.trim() || "Фото",
        note: draftNote,
      });
    }
  }, [photo, draftDate, draftTitle, draftNote, onSave]);

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
  const hasStartedEditing =
    !!photo &&
    (draftDate !== photo.date ||
      draftTitle !== photo.title ||
      draftNote !== (photo.note ?? ""));
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

  const touchStartRef = useRef<number | null>(null);
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartRef.current = e.touches[0].clientX;
  }, []);
  const onTouchEnd = useCallback(() => {
    touchStartRef.current = null;
  }, []);
  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
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
      className="personal-modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="personal-modal-title"
    >
      <div
        className="personal-modal-card"
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

        <div className="personal-modal-content">
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

          <div className="personal-modal-panel">
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
                <div className="personal-modal-edit-actions">
                  {!hasStartedEditing && (
                    <>
                      <button
                        type="button"
                        className="personal-modal-btn personal-modal-btn-secondary"
                        onClick={handleReplaceImage}
                      >
                        Поменять фото
                      </button>
                      <button
                        type="button"
                        className="personal-modal-btn personal-modal-btn-secondary"
                        onClick={handleAddPhotoToDay}
                      >
                        Добавить фото в этот день
                      </button>
                      <button
                        type="button"
                        className="personal-modal-btn personal-modal-btn-secondary"
                        onClick={onStartLinking}
                      >
                        Связать фото
                      </button>
                      <button
                        type="button"
                        className="personal-modal-btn personal-modal-btn-danger"
                        onClick={handleDeleteThisPhoto}
                      >
                        Удалить это фото
                      </button>
                      <button
                        type="button"
                        className="personal-modal-btn personal-modal-btn-danger"
                        onClick={handleDeleteAllInDay}
                      >
                        Удалить все фото этого дня
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="personal-modal-btn personal-modal-btn-primary"
                    onClick={handleSave}
                  >
                    Сохранить
                  </button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="personal-modal-file-input"
                  onChange={handleFileChange}
                  aria-hidden
                />
                <input
                  ref={addPhotoInputRef}
                  type="file"
                  accept="image/*"
                  className="personal-modal-file-input"
                  onChange={handleAddPhotoFileChange}
                  aria-hidden
                />
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
                <div className="personal-modal-footer">
                  <button
                    type="button"
                    className="personal-modal-btn-edit"
                    onClick={onEdit}
                  >
                    Редактировать
                  </button>
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
      </div>
    </div>
  );
}
