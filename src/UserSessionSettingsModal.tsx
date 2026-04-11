type UserSessionSettingsModalProps = {
  onClose: () => void;
  /** Clears active browser session (and should close this surface). */
  onSignOut: () => void;
  /** Clears active + remembered browser identity for this device. */
  onForgetDevice: () => void;
};

/**
 * Minimal user-level settings shell (session controls, not admin).
 */
export function UserSessionSettingsModal({
  onClose,
  onSignOut,
  onForgetDevice,
}: UserSessionSettingsModalProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal user-session-settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-session-settings-title"
      >
        <div className="user-session-settings-header">
          <h2 id="user-session-settings-title" className="modal-title">
            Настройки
          </h2>
          <button type="button" className="user-session-settings-close" onClick={onClose}>
            Закрыть
          </button>
        </div>

        <section className="user-settings-section" aria-label="Сессия">
          <div className="user-settings-section-label">Сессия в этом браузере</div>
          <ul className="user-settings-actions">
            <li>
              <button
                type="button"
                className="user-settings-action"
                onClick={() => {
                  onSignOut();
                }}
              >
                Выйти
              </button>
            </li>
            <li>
              <button
                type="button"
                className="user-settings-action user-settings-action-destructive"
                onClick={() => {
                  onForgetDevice();
                }}
              >
                Забыть это устройство
              </button>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
