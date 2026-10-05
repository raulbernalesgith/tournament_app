import type { Cell, Grid, Workbook } from '../shared/types';
import { parseCsv } from './csv';

export interface SheetEnv {
  SHEET_ID?: string;
  GOOGLE_API_KEY?: string;
  SHEET_TABS?: string;
}

export type SheetMode = 'sheets-api' | 'sheets-csv' | 'none';

export function sheetMode(env: SheetEnv): SheetMode {
  if (!env.SHEET_ID) return 'none';
  if (env.GOOGLE_API_KEY) return 'sheets-api';
  if (env.SHEET_TABS) return 'sheets-csv';
  return 'none';
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

/** Reads the listed tabs through the public CSV export (sheet must be shared "anyone with the link"). */
export async function fetchViaCsv(sheetId: string, tabsSpec: string): Promise<Workbook> {
  const tabs = parseTabs(tabsSpec);
  if (!tabs.length) throw new Error('SHEET_TABS has no valid "tab=gid" pairs');
  const id = encodeURIComponent(sheetId);
  const grids = await Promise.all(
    tabs.map(async (t) => {
      const res = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${t.gid}`, {
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`CSV export for "${t.title}" failed: ${res.status}`);
      const type = res.headers.get('content-type') ?? '';
      if (type.includes('text/html')) throw new Error(`CSV export for "${t.title}" returned a sign-in page; share the sheet with "anyone with the link"`);
      return parseCsv(await res.text());
    }),
  );
  const sheets: Record<string, Grid> = {};
  tabs.forEach((t, i) => {
    sheets[t.title] = grids[i];
  });
  return { title: 'Google Sheet', sheets };
}

export async function fetchWorkbook(env: SheetEnv): Promise<{ wb: Workbook; mode: Exclude<SheetMode, 'none'> }> {
  const mode = sheetMode(env);
  if (mode === 'sheets-api') return { wb: await fetchViaApi(env.SHEET_ID!, env.GOOGLE_API_KEY!), mode };
  if (mode === 'sheets-csv') return { wb: await fetchViaCsv(env.SHEET_ID!, env.SHEET_TABS!), mode };
  throw new Error('Google Sheet is not configured (set SHEET_ID plus GOOGLE_API_KEY or SHEET_TABS)');
}
