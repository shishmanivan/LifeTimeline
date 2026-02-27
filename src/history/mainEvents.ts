/**
 * Loads Main.tsv and returns the set of event ids (sha1(date|url)) for axial/main events.
 * Used only at 10y scale for visual emphasis.
 */
import { parseTsv } from "./ingestHistory";

async function sha1(str: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(str);
  const hash = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let cachedIds: Set<string> | null = null;

const mainTsvModules = import.meta.glob<string>("./sources/Main.tsv", {
  query: "?raw",
  import: "default",
});

export async function getMainEventIds(): Promise<Set<string>> {
  if (cachedIds) return cachedIds;
  try {
    const loader = Object.values(mainTsvModules)[0];
    if (!loader) return new Set();
    const raw = await loader();
    const { rows } = parseTsv(raw, "Main.tsv");
    const ids = new Set<string>();
    for (const row of rows) {
      const id = await sha1(`${row.date}|${row.url}`);
      ids.add(id);
    }
    cachedIds = ids;
    return ids;
  } catch {
    return new Set();
  }
}
