import { useEffect, useCallback } from "react";
import type { HistoricalEvent } from "./history/types";
import { useResolvedImageUrl } from "./HistoricalLayer";

type HistoricalEventModalProps = {
  event: HistoricalEvent | null;
  isOpen: boolean;
  onClose: () => void;
  getLocalImageUrl?: (e: { date: string; url: string }) => string | undefined;
  historicalImageUrls?: Record<string, string>;
};

const EMPTY_EVENT: HistoricalEvent = {
  id: "",
  date: "",
  url: "",
  title: "",
  lang: "en",
  sourceFile: "",
  sourceLine: 0,
  updatedAt: "",
  enrichVersion: 0,
};

export function HistoricalEventModal({
  event,
  isOpen,
  onClose,
  getLocalImageUrl,
  historicalImageUrls,
}: HistoricalEventModalProps) {
  const imageUrl = useResolvedImageUrl(
    event ?? EMPTY_EVENT,
    getLocalImageUrl,
    historicalImageUrls
  );

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
  }, [isOpen, handleEscape]);

  if (!isOpen || !event) return null;

  const linkUrl = event.ruUrl ?? event.url;
  const linkDomain = event.ruUrl
    ? "Wikipedia"
    : event.url.includes("wikipedia.org")
      ? "Wikipedia"
      : undefined;

  return (
    <div
      className="historical-modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="historical-modal-title"
    >
      <div
        className="historical-modal-card"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="historical-modal-close"
          onClick={onClose}
          aria-label="Закрыть"
        >
          ×
        </button>

        <div className="historical-modal-content">
          <div className="historical-modal-image-wrap">
            {imageUrl ? (
              <img
                src={imageUrl}
                alt={event.title}
                className="historical-modal-image"
              />
            ) : (
              <div className="historical-modal-image-placeholder" />
            )}
          </div>

          <div className="historical-modal-text">
            <a
              id="historical-modal-title"
              href={linkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="historical-modal-title"
            >
              {event.title}
            </a>
            <div className="historical-modal-date">{event.date}</div>
            {linkDomain && (
              <div className="historical-modal-source">{linkDomain}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
