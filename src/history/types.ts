export type HistoricalEvent = {
  id: string;
  date: string; // YYYY-MM-DD
  url: string;
  title: string;
  lang: string;
  tags?: string[];
  sourceFile: string;
  sourceLine: number;
  updatedAt: string; // ISO
  importance?: number; // 1..5, default 3
  /** Optional Russian article URL from TSV */
  ruUrl?: string;
  /** English Wikipedia URL from TSV when `url` is RU; matches HistoryPics manifest keys */
  enWikiUrl?: string;
  /** Lane index (0..2), assigned at ingest, never recalculated */
  laneIndex?: number;
};
