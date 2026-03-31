import {
  BACKUP_DIR_NAME,
  exportBackupAsJsonDownload,
  exportBackupToPickedFolder,
  importBackupFromJsonFile,
  importBackupFromPickedFolder,
  supportsDirectoryBackup,
} from "./personalBackup";

type DataBackupModalProps = {
  onClose: () => void;
  onImportDone: () => void;
};

export function DataBackupModal({ onClose, onImportDone }: DataBackupModalProps) {
  const dirOk = supportsDirectoryBackup();

  const handleExportFolder = async () => {
    const r = await exportBackupToPickedFolder();
    if (r.ok) {
      alert(
        `Готово. В выбранной папке создан каталог «${BACKUP_DIR_NAME}» с manifest.json, images/ и previews/. Сохраните эту папку в надёжное место (облако, другой диск).`
      );
    } else {
      alert(r.error);
    }
  };

  const handleExportJson = async () => {
    const r = await exportBackupAsJsonDownload();
    if (r.ok) {
      alert(
        "Файл JSON скачан. В нём все подписи, заметки и фото (как base64). Подходит для переноса и резервной копии."
      );
    } else {
      alert(r.error);
    }
  };

  const handleImportFolder = async () => {
    if (!confirm("Импорт добавит и обновит фото и серии по id из резервной копии. Продолжить?")) {
      return;
    }
    const r = await importBackupFromPickedFolder();
    if (r.ok) {
      alert(`Импортировано: ${r.importedPhotos} фото, серий: ${r.importedSeries}.`);
      onImportDone();
      onClose();
    } else {
      alert(r.error);
    }
  };

  const handlePickJson = () => {
    document.getElementById("personal-backup-json-input")?.click();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <h2 className="modal-title">Резервная копия личных данных</h2>
        <p style={{ fontSize: 14, lineHeight: 1.5, margin: "0 0 16px", color: "#333" }}>
          Подписи к карточкам, длинные описания, даты, смещения, серии и сами изображения хранятся только в
          браузере (IndexedDB). Чтобы не потерять их при смене компьютера или профиля браузера, периодически
          сохраняйте копию. Рекомендуется выбрать папку внутри вашего проекта или облака (например,{" "}
          <code>…/Life Cursor 0.001/{BACKUP_DIR_NAME}</code>).
        </p>
        <div className="modal-field" style={{ flexDirection: "column", gap: 10 }}>
          <button type="button" className="top-bar-btn" style={{ width: "100%" }} onClick={handleExportFolder}>
            Сохранить в папку… (manifest + файлы)
          </button>
          {!dirOk && (
            <p style={{ fontSize: 12, margin: 0, color: "#666" }}>
              Запись в папку доступна в Chrome и Edge на HTTPS или localhost. Иначе используйте кнопку ниже.
            </p>
          )}
          <button type="button" className="top-bar-btn" style={{ width: "100%" }} onClick={handleExportJson}>
            Скачать один JSON (все фото внутри файла)
          </button>
          <hr style={{ width: "100%", border: "none", borderTop: "1px solid #ddd", margin: "8px 0" }} />
          <button
            type="button"
            className="top-bar-btn"
            style={{ width: "100%" }}
            onClick={handleImportFolder}
            disabled={!dirOk}
          >
            Загрузить из папки…
          </button>
          <button type="button" className="top-bar-btn" style={{ width: "100%" }} onClick={handlePickJson}>
            Загрузить из JSON-файла…
          </button>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>
        <input
          id="personal-backup-json-input"
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={async (ev) => {
            const file = ev.target.files?.[0];
            ev.target.value = "";
            if (!file) return;
            if (!confirm("Импорт добавит и обновит фото и серии по id из файла. Продолжить?")) return;
            const r = await importBackupFromJsonFile(file);
            if (r.ok) {
              alert(`Импортировано: ${r.importedPhotos} фото, серий: ${r.importedSeries}.`);
              onImportDone();
              onClose();
            } else {
              alert(r.error);
            }
          }}
        />
      </div>
    </div>
  );
}
