import type {
  Bracket,
  Cell,
  EventData,
  Grid,
  Group,
  GroupPlayer,
  Match,
  PlayerInfo,
  Round,
  RosterEntry,
  Slot,
  SourceKind,
  Tournament,
  Workbook,
} from './types';

/* ------------------------------------------------------------------ */
/* Cell helpers                                                        */
/* ------------------------------------------------------------------ */

export function at(g: Grid, r: number, c: number): Cell {
  const row = g[r];
  if (!row) return null;
  const v = row[c];
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  return v;
}

export const text = (v: Cell): string => (v == null ? '' : String(v).trim());

export function num(v: Cell): number | null {
  if (v == null || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = v.replace(/,/g, '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function flag(v: Cell): boolean {
  if (v === true) return true;
  if (v == null || v === false) return false;
  if (typeof v === 'number') return v !== 0;
  return !/^(false|no|n|0|-)$/i.test(v.trim()) && v.trim() !== '';
}

const pad = (n: number | string) => String(n).padStart(2, '0');

/** Accepts spreadsheet serial numbers, ISO dates and M/D/YYYY strings. */
export function isoDate(v: Cell): string | null {
  if (v == null || typeof v === 'boolean') return null;
  if (typeof v === 'number') {
    if (v < 1 || v > 200000) return null;
    const d = new Date(Math.round((v - 25569) * 86400000));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-]+/g, '');

function headerIndex(row: Cell[] | undefined, name: string, from = 0, to = Infinity): number {
  if (!row) return -1;
  const want = norm(name);
  const end = Math.min(row.length, to);
  for (let c = from; c < end; c += 1) {
    if (norm(text(row[c] ?? null)) === want) return c;
  }
  return -1;
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/* ------------------------------------------------------------------ */
/* Ranking list                                                        */
/* ------------------------------------------------------------------ */

export function isRankingsTab(g: Grid): boolean {
  const h = g[0];
  return headerIndex(h, 'Name') >= 0 && headerIndex(h, 'Rating') >= 0 && headerIndex(h, 'Serial') >= 0;
}

function parseRankings(g: Grid): { players: Record<string, PlayerInfo>; count: number } {
  const h = g[0];
  const ix = {
    serial: headerIndex(h, 'Serial'),
    name: headerIndex(h, 'Name'),
    prov: headerIndex(h, 'Prov') >= 0 ? headerIndex(h, 'Prov') : headerIndex(h, 'Province'),
    gender: headerIndex(h, 'Gender'),
    rating: headerIndex(h, 'Rating'),
    period: headerIndex(h, 'Period'),
    last: headerIndex(h, 'Last Played'),
    temp: headerIndex(h, 'Temp'),
  };
  const players: Record<string, PlayerInfo> = {};
  let count = 0;
  for (let r = 1; r < g.length; r += 1) {
    const name = text(at(g, r, ix.name));
    if (!name) continue;
    count += 1;
    players[name] = {
      rating: num(at(g, r, ix.rating)),
      gender: ix.gender >= 0 ? text(at(g, r, ix.gender)) : '',
      province: ix.prov >= 0 ? text(at(g, r, ix.prov)) : '',
      listRank: (ix.serial >= 0 ? num(at(g, r, ix.serial)) : null) ?? count,
      period: ix.period >= 0 ? num(at(g, r, ix.period)) : null,
      lastPlayed: ix.last >= 0 ? isoDate(at(g, r, ix.last)) : null,
      temp: ix.temp >= 0 ? flag(at(g, r, ix.temp)) : false,
    };
  }
  return { players, count };
}

/* ------------------------------------------------------------------ */
/* Event tabs                                                          */
/* ------------------------------------------------------------------ */

interface Layout {
  roster: { name: number; prov: number; gender: number; rating: number; bye: number };
  draws: number[];
  bracketCol: number;
}

const TITLE_RE = /^GROUP\s+([A-Z0-9]+)\s*[-–—:]\s*(.*)$/i;

export function eventLayout(g: Grid): Layout | null {
  const h = g[0] ?? [];
  const draws: number[] = [];
  for (let c = 0; c < h.length; c += 1) if (norm(text(h[c] ?? null)) === 'group') draws.push(c);
  const nameCol = headerIndex(h, 'Name', 0, draws[0] ?? Infinity);
  if (nameCol < 0 || draws.length === 0) return null;
  const end = draws[0];
  let bracketCol = -1;
  for (let r = 0; r < g.length; r += 1) {
    const row = g[r] ?? [];
    for (let c = draws[draws.length - 1] + 1; c < row.length; c += 1) {
      if (TITLE_RE.test(text(row[c] ?? null)) && (bracketCol < 0 || c < bracketCol)) bracketCol = c;
    }
  }
  return {
    roster: {
      name: nameCol,
      prov: headerIndex(h, 'Province', 0, end),
      gender: headerIndex(h, 'Gender', 0, end),
      rating: headerIndex(h, 'Rating', 0, end),
      bye: headerIndex(h, 'Group_Stage_Bye', 0, end),
    },
    draws,
    bracketCol,
  };
}

function parseRoster(g: Grid, L: Layout['roster']): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (let r = 1; r < g.length; r += 1) {
    const name = text(at(g, r, L.name));
    if (!name) continue;
    out.push({
      name,
      province: L.prov >= 0 ? text(at(g, r, L.prov)) : '',
      gender: L.gender >= 0 ? text(at(g, r, L.gender)) : '',
      rating: L.rating >= 0 ? num(at(g, r, L.rating)) : null,
      bye: L.bye >= 0 ? flag(at(g, r, L.bye)) : false,
    });
  }
  return out;
}

function rankPlayers(players: GroupPlayer[]): GroupPlayer[] {
  const hasRanks = players.every((p) => p.rank > 0);
  if (!hasRanks) {
    const sorted = players
      .slice()
      .sort((a, b) => b.wins - a.wins || a.losses - b.losses || (a.seed ?? 999) - (b.seed ?? 999));
    sorted.forEach((p, i) => {
      p.rank = i + 1;
    });
  }
  return players.slice().sort((a, b) => a.rank - b.rank);
}

function parseDraw(g: Grid, s: number): Group[] {
  const h = g[0];
  const idx = (name: string, offset: number) => {
    const i = headerIndex(h, name, s + 1, s + 12);
    return i >= 0 ? i : s + offset;
  };
  const c = {
    seed: idx('Event Seed', 1),
    gseed: idx('Group Seed', 2),
    name: idx('Name', 3),
    prov: idx('Province', 4),
    gender: idx('Gender', 5),
    rating: idx('Rating', 6),
    wins: idx('Wins', 7),
    losses: idx('Losses', 8),
    rank: idx('Rank', 9),
  };
  const groups = new Map<string, GroupPlayer[]>();
  for (let r = 1; r < g.length; r += 1) {
    const gname = text(at(g, r, s));
    const name = text(at(g, r, c.name));
    if (!gname || !name) continue;
    if (!groups.has(gname)) groups.set(gname, []);
    groups.get(gname)!.push({
      name,
      seed: num(at(g, r, c.seed)),
      groupSeed: num(at(g, r, c.gseed)),
      province: text(at(g, r, c.prov)),
      gender: text(at(g, r, c.gender)),
      rating: num(at(g, r, c.rating)),
      wins: num(at(g, r, c.wins)) ?? 0,
      losses: num(at(g, r, c.losses)) ?? 0,
      rank: num(at(g, r, c.rank)) ?? 0,
    });
  }
  const list: Group[] = [...groups.entries()].map(([name, players]) => ({
    name,
    label: name.replace(/^group\s*/i, '') || name,
    players: rankPlayers(players),
  }));
  const key = (gr: Group) => {
    const n = Number(gr.label);
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
  };
  return list.sort((a, b) => key(a) - key(b) || a.label.localeCompare(b.label));
}

const ENTRY_RE = /^(.*?)\s*\((\d+)\)\s*\((.*)\)\s*$/;

interface Entry {
  name: string | null;
  bye: boolean;
  origin: string | null;
  score: number | null;
}

function readEntry(g: Grid, row: number, col: number): Entry {
  const raw = text(at(g, row, col));
  const score = num(at(g, row, col + 1));
  if (!raw) return { name: null, bye: false, origin: null, score };
  if (/^bye$/i.test(raw)) return { name: null, bye: true, origin: null, score: null };
  const m = ENTRY_RE.exec(raw);
  if (m) return { name: m[1].trim(), bye: false, origin: m[3].trim(), score };
  return { name: raw, bye: false, origin: null, score };
}

const SHORT: Record<string, string> = {
  round1: 'R1',
  round2: 'R2',
  round3: 'R3',
  round4: 'R4',
  roundof64: 'R64',
  roundof32: 'R32',
  roundof16: 'R16',
  quarterfinals: 'QF',
  quarterfinal: 'QF',
  semifinals: 'SF',
  semifinal: 'SF',
  finals: 'Final',
  final: 'Final',
};

function roundName(raw: string): { name: string; short: string } {
  const key = norm(raw);
  const short = SHORT[key] ?? raw;
  const name = key === 'finals' ? 'Final' : raw;
  return { name, short };
}

interface ParsedBracket {
  bracket: Bracket;
  firstRound: Entry[];
}

function parseBrackets(g: Grid, bc: number, warn: (m: string) => void, tab: string): ParsedBracket[] {
  if (bc < 0) return [];
  const titles: number[] = [];
  for (let r = 0; r < g.length; r += 1) if (TITLE_RE.test(text(at(g, r, bc)))) titles.push(r);
  const out: ParsedBracket[] = [];
  for (const tr of titles) {
    const title = text(at(g, tr, bc));
    const m = TITLE_RE.exec(title)!;
    const id = m[1].toUpperCase();
    const rest = m[2];
    const preliminary = /preliminary\s+projection/i.test(rest);
    const sizeMatch = /\((\d+)\s*players?\s*\/\s*(\d+)\s*-?\s*player\s*bracket\)/i.exec(rest);
    const label = rest.replace(/\(.*$/, '').trim() || `Bracket ${id}`;

    const hr = tr + 1;
    const headers: string[] = [];
    for (let c = bc; text(at(g, hr, c)); c += 3) headers.push(text(at(g, hr, c)));
    const roundHeaders = headers.filter((h) => !/^champion/i.test(h));
    const hasChampion = headers.length > roundHeaders.length;
    const R = roundHeaders.length;
    if (R === 0) {
      warn(`${tab}: bracket ${id} has no round headers under its title`);
      continue;
    }
    const size = 2 ** R;
    if (sizeMatch && Number(sizeMatch[2]) !== size) {
      warn(`${tab}: bracket ${id} title says ${sizeMatch[2]}-player bracket but has ${R} rounds`);
    }
    const fr = hr + 1;
    const entry = (k: number, j: number) => readEntry(g, fr + (2 ** k - 1) + j * 2 ** (k + 1), bc + 3 * k);

    const rounds: Round[] = [];
    let firstRound: Entry[] = [];
    for (let k = 0; k < R; k += 1) {
      const n = size / 2 ** k;
      const entries = Array.from({ length: n }, (_, j) => entry(k, j));
      if (k === 0) firstRound = entries;
      const matches: Match[] = [];
      for (let mi = 0; mi < n / 2; mi += 1) {
        const a = entries[2 * mi];
        const b = entries[2 * mi + 1];
        const next = k + 1 < R || hasChampion ? entry(k + 1, mi) : null;
        const nextName = next?.name ?? null;
        const winner = nextName && (nextName === a.name || nextName === b.name) ? nextName : null;
        const slot = (e: Entry): Slot => ({ name: e.name, bye: e.bye, score: e.bye ? null : e.score });
        matches.push({ a: slot(a), b: slot(b), winner });
      }
      rounds.push({ ...roundName(roundHeaders[k]), matches });
    }
    const champion = hasChampion ? entry(R, 0).name : null;
    const players = sizeMatch ? Number(sizeMatch[1]) : firstRound.filter((e) => e.name).length;
    out.push({
      bracket: { id, label, size, players, preliminary, champion, rounds },
      firstRound,
    });
  }
  return out;
}

function chooseDraw(draws: Group[][], firstRounds: Entry[][], warn: (m: string) => void, tab: string): 1 | 2 {
  if (draws.length < 2 || draws[1].length === 0) return 1;
  const labels: { name: string; group: string }[] = [];
  firstRounds.forEach((entries) =>
    entries.forEach((e) => {
      if (e.name && e.origin && /^group\b/i.test(e.origin)) labels.push({ name: e.name, group: norm(e.origin) });
    }),
  );
  if (labels.length === 0) return 1;
  const scores = draws.map((d) => {
    const where = new Map<string, string>();
    d.forEach((gr) => gr.players.forEach((p) => where.set(p.name, norm(gr.name))));
    return labels.filter((l) => where.get(l.name) === l.group).length;
  });
  if (scores[0] === scores[1]) {
    warn(`${tab}: both group draws match the bracket labels equally; using draw 1`);
    return 1;
  }
  return scores[1] > scores[0] ? 2 : 1;
}

function parseEvent(tab: string, g: Grid, warn: (m: string) => void): EventData | null {
  const L = eventLayout(g);
  if (!L) return null;
  const roster = parseRoster(g, L.roster);
  const draws = L.draws.slice(0, 2).map((s) => parseDraw(g, s));
  const parsed = parseBrackets(g, L.bracketCol, warn, tab);
  const draw = chooseDraw(draws, parsed.map((p) => p.firstRound), warn, tab);
  return {
    id: slug(tab),
    name: tab.replace(/_/g, ' ').trim(),
    tab,
    roster,
    byes: roster.filter((p) => p.bye).map((p) => p.name),
    draw,
    groups: draws[draw - 1] ?? [],
    brackets: parsed.map((p) => p.bracket),
  };
}

/* ------------------------------------------------------------------ */
/* Workbook                                                            */
/* ------------------------------------------------------------------ */

export function buildTournament(
  wb: Workbook,
  source: { kind: SourceKind; label: string },
  now: Date = new Date(),
): Tournament {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  let players: Record<string, PlayerInfo> = {};
  let rankCount = 0;
  const events: EventData[] = [];

  for (const [tab, grid] of Object.entries(wb.sheets)) {
    if (!grid || grid.length === 0) continue;
    if (isRankingsTab(grid)) {
      if (rankCount === 0) {
        const r = parseRankings(grid);
        players = r.players;
        rankCount = r.count;
      }
      continue;
    }
    const ev = parseEvent(tab, grid, warn);
    if (ev) events.push(ev);
  }

  // Players that are in an event but not on the ranking list still get a profile.
  for (const ev of events) {
    for (const p of ev.roster) {
      if (players[p.name]) continue;
      const inGroup = ev.groups.flatMap((gr) => gr.players).find((gp) => gp.name === p.name);
      players[p.name] = {
        rating: p.rating ?? inGroup?.rating ?? null,
        gender: p.gender || inGroup?.gender || '',
        province: p.province || inGroup?.province || '',
        listRank: null,
        period: null,
        lastPlayed: null,
        temp: false,
      };
      warn(`${ev.name}: "${p.name}" is not on the ranking list`);
    }
  }

  return {
    version: 1,
    generatedAt: now.toISOString(),
    source,
    rankCount,
    players,
    events,
    warnings,
  };
}

/** Content fingerprint that ignores timestamps, used to skip unchanged writes. */
export function fingerprint(t: Tournament): string {
  const s = JSON.stringify([t.players, t.events, t.warnings, t.rankCount]);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 16777619);
    h2 = Math.imul(h2 ^ ch, 2246822519);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0') + s.length.toString(16);
}
