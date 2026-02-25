import { useEffect, useCallback, useRef, useState } from "react";

export type PersonalPhotoForModal = {
  id: string;
  title: string;
  date: string;
  note?: string;
};

type PersonalPhotoModalProps = {
  photo: PersonalPhotoForModal | null;
  imageUrl: string | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (id: string, note: string) => void;
};

const DEBOUNCE_MS = 600;

export function PersonalPhotoModal({
  photo,
  imageUrl,
  isOpen,
  onClose,
  onSave,
}: PersonalPhotoModalProps) {
  const [draftNote, setDraftNote] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef("");

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (isOpen && photo) {
      setDraftNote(photo.note ?? "");
      lastSavedRef.current = photo.note ?? "";
    }
  }, [isOpen, photo]);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
  }, [isOpen, handleEscape]);

  const flushSave = useCallback(
    (note: string) => {
      if (photo && note !== lastSavedRef.current) {
        lastSavedRef.current = note;
        onSave(photo.id, note);
      }
    },
    [photo, onSave]
  );

  useEffect(() => {
    if (!isOpen || !photo) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      flushSave(draftNote);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [draftNote, isOpen, photo, flushSave]);

  const handleClose = useCallback(() => {
    flushSave(draftNote);
    onClose();
  }, [draftNote, flushSave, onClose]);

  if (!isOpen || !photo) return null;

  return (
    <div
      className="personal-modal-overlay"
      onClick={handleClose}
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
          onClick={handleClose}
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
            <h2 id="personal-modal-title" className="personal-modal-title">
              {photo.title}
            </h2>
            <div className="personal-modal-date">{photo.date}</div>
            <textarea
              className="personal-modal-note"
              value={draftNote}
              onChange={(e) => setDraftNote(e.target.value)}
              placeholder="Добавить описание..."
              rows={6}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
