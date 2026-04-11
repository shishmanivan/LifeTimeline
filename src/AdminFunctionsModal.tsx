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

const ADMIN_VIEWS: { id: AdminViewId; label: string }[] = [
  { id: "profiles", label: "Все профили" },
];

export function AdminFunctionsModal({
  isOpen,
  onClose,
  profiles,
  isLoading,
  errorMessage,
}: AdminFunctionsModalProps) {
  const [activeView, setActiveView] = useState<AdminViewId>("profiles");

  const sortedProfiles = useMemo(
    () => [...profiles].sort((a, b) => a.slug.localeCompare(b.slug)),
    [profiles]
  );

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 860, width: "min(92vw, 860px)" }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            marginBottom: 16,
          }}
        >
          <h2 className="modal-title" style={{ margin: 0 }}>
            Админ функции
          </h2>
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "180px minmax(0, 1fr)",
            gap: 16,
            alignItems: "start",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {ADMIN_VIEWS.map((view) => (
              <button
                key={view.id}
                type="button"
                onClick={() => setActiveView(view.id)}
                style={{
                  textAlign: "left",
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: view.id === activeView ? "1px solid #111" : "1px solid #d5d5d5",
                  background: view.id === activeView ? "#f5f5f5" : "#fff",
                  cursor: "pointer",
                }}
              >
                {view.label}
              </button>
            ))}
          </div>

          <div style={{ minWidth: 0 }}>
            {activeView === "profiles" && (
              <>
                <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>Все профили</h3>
                <p style={{ margin: "0 0 16px", fontSize: 14, color: "#444" }}>
                  Служебный список профилей для админ-режима.
                </p>

                {isLoading ? (
                  <p style={{ margin: 0 }}>Загрузка профилей…</p>
                ) : errorMessage ? (
                  <p style={{ margin: 0, color: "#b00020" }}>{errorMessage}</p>
                ) : (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                    }}
                  >
                    {sortedProfiles.map((profile) => (
                      <div
                        key={profile.id}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1.2fr) 140px auto",
                          gap: 12,
                          alignItems: "center",
                          padding: "12px 14px",
                          border: "1px solid #e3e3e3",
                          borderRadius: 10,
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 12, color: "#666" }}>slug</div>
                          <div style={{ fontWeight: 600 }}>@{profile.slug}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 12, color: "#666" }}>displayName</div>
                          <div>{profile.displayName}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 12, color: "#666" }}>availability</div>
                          <div>{profile.availability}</div>
                        </div>
                        <div style={{ justifySelf: "end" }}>
                          <a href={`/${profile.slug}`}>Открыть профиль</a>
                        </div>
                      </div>
                    ))}
                    {sortedProfiles.length === 0 && (
                      <p style={{ margin: 0 }}>Профили пока не настроены.</p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
