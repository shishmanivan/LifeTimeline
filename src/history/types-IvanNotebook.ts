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
};
