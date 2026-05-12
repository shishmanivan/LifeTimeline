import { useMemo, useState } from "react";
import type { ServerProfileDto } from "./serverPersonalPhotoStorage";

type AdminFunctionsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  profiles: ServerProfileDto[];
  isLoading: boolean;
  errorMessage?: string | null;
};

type AdminViewId = "profiles";
type AdminSortKey =
  | "slug"
  | "displayName"
  | "availability"
  | "accountCreatedAt"
  | "profileLastVisitedAt"
  | "profileVisitCount"
  | "photoCount";
type AdminSortDirection = "asc" | "desc";

const ADMIN_VIEWS: { id: AdminViewId; label: string }[] = [
  { id: "profiles", label: "Все профили" },
];

const ADMIN_SORT_OPTIONS: {
  key: AdminSortKey;
  label: string;
  defaultDirection: AdminSortDirection;
}[] = [
  { key: "slug", label: "slug", defaultDirection: "asc" },
  { key: "displayName", label: "имя", defaultDirection: "asc" },
  { key: "availability", label: "доступ", defaultDirection: "asc" },
  { key: "accountCreatedAt", label: "создан", defaultDirection: "desc" },
  { key: "profileLastVisitedAt", label: "последний заход", defaultDirection: "desc" },
  { key: "profileVisitCount", label: "заходы", defaultDirection: "desc" },
  { key: "photoCount", label: "фото", defaultDirection: "desc" },
];

function formatAdminDate(value?: string | null): string {
  if (!value) return "—";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPhotoCount(value?: number): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

function formatVisitCount(value?: number): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "0";
}

function getDateSortValue(value?: string | null): number {
  if (!value) return -Infinity;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : -Infinity;
}

function compareText(a: string | undefined, b: string | undefined): number {
  return (a ?? "").localeCompare(b ?? "", "ru-RU", {
    numeric: true,
    sensitivity: "base",
  });
}

function compareNumber(a: number | undefined, b: number | undefined): number {
  return (a ?? 0) - (b ?? 0);
}

function compareProfilesByKey(
  a: ServerProfileDto,
  b: ServerProfileDto,
  key: AdminSortKey
): number {
  switch (key) {
    case "slug":
      return compareText(a.slug, b.slug);
    case "displayName":
      return compareText(a.displayName, b.displayName);
    case "availability":
      return compareText(a.availability, b.availability);
    case "accountCreatedAt":
      return getDateSortValue(a.accountCreatedAt) - getDateSortValue(b.accountCreatedAt);
    case "profileLastVisitedAt":
      return getDateSortValue(a.profileLastVisitedAt) - getDateSortValue(b.profileLastVisitedAt);
    case "profileVisitCount":
      return compareNumber(a.profileVisitCount, b.profileVisitCount);
    case "photoCount":
      return compareNumber(a.photoCount, b.photoCount);
  }
}

export function AdminFunctionsModal({
  isOpen,
  onClose,
  profiles,
  isLoading,
  errorMessage,
}: AdminFunctionsModalProps) {
  const [activeView, setActiveView] = useState<AdminViewId>("profiles");
  const [sortKey, setSortKey] = useState<AdminSortKey>("slug");
  const [sortDirection, setSortDirection] = useState<AdminSortDirection>("asc");

  const sortedProfiles = useMemo(() => {
    return [...profiles].sort((a, b) => {
      const primary = compareProfilesByKey(a, b, sortKey);
      const directed = sortDirection === "asc" ? primary : -primary;
      return directed || compareText(a.slug, b.slug);
    });
  }, [profiles, sortDirection, sortKey]);

  const handleSortChange = (nextKey: AdminSortKey) => {
    if (nextKey === sortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    const option = ADMIN_SORT_OPTIONS.find((item) => item.key === nextKey);
    setSortKey(nextKey);
    setSortDirection(option?.defaultDirection ?? "asc");
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal admin-functions-modal"
        onClick={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="admin-functions-header">
          <h2 className="modal-title admin-functions-title">
            Админ функции
          </h2>
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>

        <div className="admin-functions-layout">
          <div className="admin-functions-sidebar">
            {ADMIN_VIEWS.map((view) => (
              <button
                key={view.id}
                type="button"
                onClick={() => setActiveView(view.id)}
                className={`admin-functions-nav-item ${
                  view.id === activeView ? "admin-functions-nav-item-active" : ""
                }`}
              >
                {view.label}
              </button>
            ))}
          </div>

          <div className="admin-functions-content">
            {activeView === "profiles" && (
              <>
                <h3 className="admin-functions-section-title">Все профили</h3>
                <p className="admin-functions-section-note">
                  Служебный список профилей для админ-режима.
                </p>

                {isLoading ? (
                  <p style={{ margin: 0 }}>Загрузка профилей…</p>
                ) : errorMessage ? (
                  <p style={{ margin: 0, color: "#b00020" }}>{errorMessage}</p>
                ) : (
                  <>
                    <div className="admin-sort-bar" aria-label="Сортировка профилей">
                      <span className="admin-sort-label">Сортировка</span>
                      {ADMIN_SORT_OPTIONS.map((option) => {
                        const isActive = option.key === sortKey;
                        return (
                          <button
                            key={option.key}
                            type="button"
                            className={`admin-sort-button ${
                              isActive ? "admin-sort-button-active" : ""
                            }`}
                            onClick={() => handleSortChange(option.key)}
                            aria-pressed={isActive}
                          >
                            {option.label}
                            {isActive ? (
                              <span className="admin-sort-direction">
                                {sortDirection === "asc" ? "↑" : "↓"}
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                    <div className="admin-profiles-list">
                      {sortedProfiles.map((profile) => (
                        <div
                          key={profile.id}
                          className="admin-profile-row"
                        >
                          <div className="admin-profile-cell">
                            <div className="admin-profile-label">slug</div>
                            <div className="admin-profile-value admin-profile-value-strong">
                              @{profile.slug}
                            </div>
                          </div>
                          <div className="admin-profile-cell">
                            <div className="admin-profile-label">displayName</div>
                            <div className="admin-profile-value">{profile.displayName}</div>
                          </div>
                          <div className="admin-profile-cell">
                            <div className="admin-profile-label">availability</div>
                            <div className="admin-profile-value">{profile.availability}</div>
                          </div>
                          <div className="admin-profile-cell">
                            <div className="admin-profile-label">
                              аккаунт добавлен
                            </div>
                            <div className="admin-profile-value">
                              {formatAdminDate(profile.accountCreatedAt)}
                            </div>
                          </div>
                          <div className="admin-profile-cell">
                            <div className="admin-profile-label">
                              последний заход
                            </div>
                            <div className="admin-profile-value">
                              {formatAdminDate(profile.profileLastVisitedAt)}
                            </div>
                          </div>
                          <div className="admin-profile-cell admin-profile-cell-compact">
                            <div className="admin-profile-label">заходов</div>
                            <div className="admin-profile-value">
                              {formatVisitCount(profile.profileVisitCount)}
                            </div>
                          </div>
                          <div className="admin-profile-cell admin-profile-cell-compact">
                            <div className="admin-profile-label">фото</div>
                            <div className="admin-profile-value">
                              {formatPhotoCount(profile.photoCount)}
                            </div>
                          </div>
                          <div className="admin-profile-link">
                            <a href={`/${profile.slug}`}>Открыть профиль</a>
                          </div>
                        </div>
                      ))}
                      {sortedProfiles.length === 0 && (
                        <p style={{ margin: 0 }}>Профили пока не настроены.</p>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
