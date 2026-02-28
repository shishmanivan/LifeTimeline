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
  /** Russian Wikipedia URL (from langlinks en→ru) */
  ruUrl?: string;
  /** Lane index (0..2), assigned at ingest, never recalculated */
  laneIndex?: number;
};
