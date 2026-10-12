import { parseCsv } from './csv';
import { buildTournament } from './parse';
import type { SheetBundle, Tournament, Workbook } from './types';

export const isBundle = (x: unknown): x is SheetBundle =>
  !!x && typeof x === 'object' && (x as SheetBundle).version === 1 && Array.isArray((x as SheetBundle).tabs);

/** The downloaded tabs as cell grids, in sheet order. */
export function workbookOf(b: SheetBundle): Workbook {
  const sheets: Workbook['sheets'] = {};
  for (const t of b.tabs) sheets[t.title] = t.grid ?? parseCsv(t.csv ?? '');
  return { title: 'Google Sheet', sheets };
}

/** Builds the groups, brackets and profiles from the downloaded tabs (the app does this in the browser). */
export function tournamentOf(b: SheetBundle): Tournament {
  return buildTournament(workbookOf(b), b.source, new Date(b.changedAt));
}
