export type HistoricalEvent = {
  id: string;
  date: string; // YYYY-MM-DD
  url: string;
  title: string;
  lang: string;
  thumbnailUrl?: string;
  previewBlob?: Blob;
  tags?: string[];
  sourceFile: string;
  sourceLine: number;
  updatedAt: string; // ISO
  enrichVersion: number;
  summary?: string;
  importance?: number; // 1..5, default 3
};
