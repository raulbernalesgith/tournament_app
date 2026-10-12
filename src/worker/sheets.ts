import type { Cell, Grid, Workbook } from '../shared/types';

export interface SheetEnv {
  SHEET_ID?: string;
  GOOGLE_API_KEY?: string;
  SHEET_TABS?: string;
}

export type SheetMode = 'sheets-api' | 'sheets-csv' | 'none';

export function sheetMode(env: SheetEnv): SheetMode {
  if (!env.SHEET_ID) return 'none';
  if (env.GOOGLE_API_KEY) return 'sheets-api';
  return 'sheets-csv';
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Sheets API ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

const colIndex = (letters: string) =>
  letters.split('').reduce((n, ch) => n * 26 + (ch.toUpperCase().charCodeAt(0) - 64), 0) - 1;

/** "'Open_Singles'!A1:AT142" -> {row: 0, col: 0} */
function rangeStart(range: string): { row: number; col: number } {
  const m = /!\$?([A-Z]+)\$?(\d+)/i.exec(range);
  if (!m) return { row: 0, col: 0 };
  return { row: Number(m[2]) - 1, col: colIndex(m[1]) };
}

/** Reads every visible tab through the Sheets API v4 (needs an API key and a link-shared sheet). */
export async function fetchViaApi(sheetId: string, apiKey: string): Promise<Workbook> {
  const id = encodeURIComponent(sheetId);
  const key = encodeURIComponent(apiKey);
  const meta = await getJson<{
    properties?: { title?: string };
    sheets?: { properties: { title: string; hidden?: boolean } }[];
  }>(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=properties.title,sheets.properties(title,hidden)&key=${key}`);
  const titles = (meta.sheets ?? []).filter((s) => !s.properties.hidden).map((s) => s.properties.title);
  const params = new URLSearchParams({
    majorDimension: 'ROWS',
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
    key: apiKey,
  });
  titles.forEach((t) => params.append('ranges', `'${t.replace(/'/g, "''")}'`));
  const data = await getJson<{ valueRanges?: { range: string; values?: Cell[][] }[] }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${params.toString()}`,
  );
  const sheets: Record<string, Grid> = {};
  (data.valueRanges ?? []).forEach((vr, i) => {
    const start = rangeStart(vr.range);
    const grid: Grid = [];
    for (let r = 0; r < start.row; r += 1) grid.push([]);
    for (const row of vr.values ?? []) {
      const padded: Cell[] = start.col ? new Array(start.col).fill(null) : [];
      grid.push(padded.concat(row.map((v) => (v === '' ? null : v))));
    }
    sheets[titles[i]] = grid;
  });
  return { title: meta.properties?.title ?? 'Google Sheet', sheets };
}

/** "Canada_Rankings=0, Open_Singles=123" -> [{title, gid}] */
export function parseTabs(spec: string): { title: string; gid: string }[] {
  return spec
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.lastIndexOf('=');
      return { title: pair.slice(0, i).trim(), gid: pair.slice(i + 1).trim() };
    })
    .filter((t) => t.title && /^\d+$/.test(t.gid));
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .trim();

/** Pulls tab names and gids out of the sheet's public HTML view. */
export function tabsFromHtml(html: string): { title: string; gid: string }[] {
  const found = new Map<string, string>();
  const patterns = [
    /<li[^>]*id="sheet-button-(\d+)"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/g,
    /name:\s*"((?:[^"\\]|\\.)+)"[^}]*?gid:\s*"(\d+)"/g,
  ];
  for (const re of patterns) {
    for (const m of html.matchAll(re)) {
      const [gid, title] = re === patterns[0] ? [m[1], m[2]] : [m[2], m[1].replace(/\\(.)/g, '$1')];
      const t = decode(title);
      if (t && !found.has(t)) found.set(t, gid);
    }
    if (found.size) break;
  }
  return [...found.entries()].map(([title, gid]) => ({ title, gid }));
}

export interface TabRef {
  title: string;
  gid: string;
}

const TAB_BUTTON = /<li[^>]*id="sheet-button-(\d+)"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/g;
/** Text kept from one piece of the page to the next, so a match split between pieces is still found. */
const CARRY = 4096;
/** How much of the page to scan piece by piece for the tab menu before reading the rest in one go. */
const HEAD_BYTES = 64 * 1024;

/**
 * Lists every tab of a link-shared sheet, so new event tabs are picked up
 * without config changes. The HTML view renders every tab's cells, so it can
 * be megabytes. Its start is scanned as it arrives, and the page is dropped as
 * soon as the tab menu has closed (a </ul> after the last tab button). If the
 * menu isn't in the first 64 KB, the rest is read in one go (piece-by-piece
 * reading costs more CPU in Workers than one native read).
 */
export async function discoverTabs(sheetId: string): Promise<TabRef[]> {
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/htmlview`, { redirect: 'follow' });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Sheet tab list failed: ${res.status}`);
  }
  if (!res.body) return tabsFromHtml(await res.text());
  const [head, whole] = res.body.tee();
  const reader = head.getReader();
  const decoder = new TextDecoder();
  const menu = new Map<string, string>();
  let carry = '';
  let seen = 0;
  while (seen < HEAD_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.length;
    const text = carry + decoder.decode(value, { stream: true });
    if (text.includes('sheet-button-')) {
      for (const m of text.matchAll(TAB_BUTTON)) {
        const t = decode(m[2]);
        if (t && !menu.has(t)) menu.set(t, m[1]);
      }
    }
    if (menu.size && text.lastIndexOf('</ul>') > text.lastIndexOf('sheet-button-')) {
      await Promise.all([reader.cancel(), whole.cancel()]);
      return [...menu.entries()].map(([title, gid]) => ({ title, gid }));
    }
    carry = text.slice(-CARRY);
  }
  // Cancelling one branch of a tee settles only once the other is done too, so don't wait for it here.
  void reader.cancel().catch(() => {});
  return tabsFromHtml(await new Response(whole).text());
}

export type TabDownload = { ok: true; bytes: Uint8Array } | { ok: false; status: number; message: string };

/** One tab through the public CSV export, as raw bytes (decoded only if the sheet changed). */
export async function downloadTab(sheetId: string, tab: TabRef): Promise<TabDownload> {
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=csv&gid=${encodeURIComponent(tab.gid)}`;
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    return { ok: false, status: 0, message: `CSV export for "${tab.title}" failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    await res.body?.cancel();
    return { ok: false, status: res.status, message: `CSV export for "${tab.title}" failed: ${res.status}` };
  }
  if ((res.headers.get('content-type') ?? '').includes('text/html')) {
    await res.body?.cancel();
    return { ok: false, status: res.status, message: `CSV export for "${tab.title}" returned a sign-in page; share the sheet with "anyone with the link"` };
  }
  try {
    return { ok: true, bytes: new Uint8Array(await res.arrayBuffer()) };
  } catch (err) {
    return { ok: false, status: 0, message: `CSV export for "${tab.title}" was cut off: ${err instanceof Error ? err.message : String(err)}` };
  }
}
