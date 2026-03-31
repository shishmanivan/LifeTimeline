/** File System Access API (Chrome, Edge, Opera; Safari partial) */
interface Window {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?:
      | FileSystemHandle
      | "desktop"
      | "documents"
      | "downloads"
      | "music"
      | "pictures"
      | "videos";
  }) => Promise<FileSystemDirectoryHandle>;
}
