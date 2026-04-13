export type Offsets = { offsetXDays: number; offsetY: number };

export type PersonalPhoto = {
  id: string;
  title: string;
  date: string;
  image: string;
  profileId?: string;
  offsetXDays: number;
  offsetY: number;
  laneIndex?: number;
  note?: string;
  showOnTimeline?: boolean;
  seriesId?: string;
};

export type PositionedPhoto = PersonalPhoto & {
  xPx: number;
  laneIndex: number;
  isManual?: boolean;
};

type PersonalLayerProps = {
  photos: PositionedPhoto[];
  axisY: number;
  cardRefsMap: React.MutableRefObject<Map<string, HTMLDivElement>>;
  cardDragging: string | null;
  pendingOffsets: Record<string, Offsets>;
  getActiveOffsets: (id: string) => Offsets;
  isDirty: (id: string) => boolean;
  altHeld: boolean;
  /** When false, hide ✅/↺ commit UI (read-only / no offset writes). */
  showOffsetCommitControls?: boolean;
  onConfirmOffsets: (id: string) => void;
  onCancelOffsets: (id: string) => void;
  onOverlayOpen: (id: string) => void;
  onPhotoHover?: (photoId: string | null) => void;
  isPhotoDimmed?: (photoId: string) => boolean;
};

const PERSONAL_BASE_Y_OFFSET = 120;
/** Match card height: image(4:3) + title + padding ~144px */
const LANE_HEIGHT = 160;

export function PersonalLayer({
  photos,
  axisY,
  cardRefsMap,
  cardDragging,
  pendingOffsets,
  getActiveOffsets,
  isDirty,
  altHeld,
  showOffsetCommitControls = true,
  onConfirmOffsets,
  onCancelOffsets,
  onOverlayOpen,
  onPhotoHover,
  isPhotoDimmed,
}: PersonalLayerProps) {
  const baseY = axisY - PERSONAL_BASE_Y_OFFSET;

  return (
    <>
      {photos.map((photo) => {
        const dirty = isDirty(photo.id);
        const inEditMode = (cardDragging === photo.id && altHeld) || dirty;
        const active = getActiveOffsets(photo.id);
        const y =
          baseY -
          (photo.laneIndex ?? 0) * LANE_HEIGHT +
          active.offsetY;

        const dimmed = isPhotoDimmed?.(photo.id) ?? false;
        return (
          <article
            key={photo.id}
            data-event-id={photo.id}
            className={`event event-personal event-photo ${cardDragging === photo.id ? "event-photo-dragging" : ""} ${altHeld ? "event-photo-grab" : ""} ${dimmed ? "event-photo-dimmed" : ""}`}
            style={{
              left: `${photo.xPx}px`,
              top: `${y}px`,
              transform: "translate(-50%, -100%)",
            }}
          >
            <div
              className="card"
              ref={(el) => {
                if (el) cardRefsMap.current.set(photo.id, el);
                else cardRefsMap.current.delete(photo.id);
              }}
              onMouseEnter={() => onPhotoHover?.(photo.id)}
              onMouseLeave={() => onPhotoHover?.(null)}
            >
              {showOffsetCommitControls && inEditMode && dirty && (
                <>
                  <button
                    type="button"
                    className="card-confirm"
                        onClick={(e) => {
                          e.stopPropagation();
                          onConfirmOffsets(photo.id);
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
                          onCancelOffsets(photo.id);
                        }}
                        title="Отменить"
                        aria-label="Отменить"
                      >
                        ↺
                      </button>
                </>
              )}
              <div className="cardImage">
                <img
                  src={photo.image}
                  alt={photo.title}
                  className={inEditMode ? "" : "card-image-clickable"}
                  draggable={false}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!inEditMode) onOverlayOpen(photo.id);
                  }}
                />
              </div>
              <div className="cardTitle titlePersonal">{photo.title}</div>
            </div>
          </article>
        );
      })}
    </>
  );
}
