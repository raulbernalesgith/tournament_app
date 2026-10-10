import type {
  Bracket,
  Cell,
  EventData,
  Grid,
  Group,
  GroupMatch,
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

/** Text where a number belongs, e.g. "Loading…" or "#ERROR!" from a formula. */
const notNumber = (v: Cell): v is string => typeof v === 'string' && v.trim() !== '' && num(v) == null;

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

/**
 * Reads a score cell such as "3-1" (sets) or "11-7" (a game) the way the
 * sheet's ITTF_STANDINGS does: the first "3-1", "3:1" or "11 - 7" in the cell,
 * so "3-0 WO" reads as 3-0. Spreadsheets often turn scores into dates (March 1,
 * November 7), so dates are read back as month-day.
 */
export function parseSets(v: Cell): [number, number] | null {
  if (v == null || typeof v === 'boolean') return null;
  if (typeof v === 'number') {
    if (v > 20000 && v < 100000) {
      const d = new Date(Math.round((v - 25569) * 86400000));
      return [d.getUTCMonth() + 1, d.getUTCDate()];
    }
    return null;
  }
  const s = v.trim();
  // A date Sheets made out of a score comes through the export as "3/1/2026" or "2026-03-01".
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/.exec(s);
  if (m) return [Number(m[2]), Number(m[3])];
  m = /^(\d{1,2})\/(\d{1,2})\/\d{2,4}(?:$|\s)/.exec(s);
  if (m) return [Number(m[1]), Number(m[2])];
  m = /(\d+)\s*[-:–]\s*(\d+)/.exec(s);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** "WO" / "W/O" in a Sets cell marks a walkover: the loser gets no match point. */
const WO_RE = /\bw\s*\/?\s*o\b/i;

/** Sets won by each player, counted from the game scores. */
function countGames(games: [number, number][]): [number, number] {
  return games.reduce<[number, number]>((s, [a, b]) => (a > b ? [s[0] + 1, s[1]] : b > a ? [s[0], s[1] + 1] : s), [0, 0]);
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-]+/g, '');

function headerIndex(row: Cell[] | undefined, name: string, from = 0, to = Infinity): number {
  if (!row) return -1;
  const want = norm(name);
  const end = Math.min(row.length, to);
  for (let c = Math.max(0, from); c < end; c += 1) {
    if (norm(text(row[c] ?? null)) === want) return c;
  }
  return -1;
}

/** The first of several accepted header names found in `row[from, to)`. */
function firstHeader(row: Cell[] | undefined, names: string[], from = 0, to = Infinity): number {
  for (const n of names) {
    const i = headerIndex(row, n, from, to);
    if (i >= 0) return i;
  }
  return -1;
}

// Column names in the group tables, old and new. The sheet has used both
// "Wins" and "W", "Match Order" and "Match", "Sets (P1-P2)" and "Sets".
const WINS = ['Wins', 'W'];
const LOSSES = ['Losses', 'L'];
const POINTS = ['Pts', 'Points'];
const ORDER = ['Match Order', 'Match'];
const SETS = ['Sets (P1-P2)', 'Sets'];
const GAME_RE = /^g(?:ame)?\s*(\d+)$/i;

/** Game columns (G1, G2, … or Game 1, …) in `row[from, to)`, in game order. */
function gameCols(row: Cell[] | undefined, from: number, to: number): number[] {
  const found: [number, number][] = [];
  const end = Math.min(row?.length ?? 0, to);
  for (let c = from; c < end; c += 1) {
    const m = GAME_RE.exec(text(row![c] ?? null));
    if (m) found.push([Number(m[1]), c]);
  }
  return found.sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/* ------------------------------------------------------------------ */
/* Group matches and standings                                         */
/* ------------------------------------------------------------------ */

const ORDER_RE = /seed\s*(\d+)\s*(?:vs\.?|v)\s*seed\s*(\d+)/i;

interface MatchCols {
  order: number;
  sets: number;
  games: number[];
}

/** Every match is best of five (Tournament Tools' BEST_OF), so 3 games win it. */
const TO_WIN = 3;

/**
 * Reads "Seed 1 vs Seed 3" rows downward from `start` until the column runs
 * out, the next header row starts, or the group's `max` matches are read.
 *
 * Results are read the way the sheet's ITTF_STANDINGS reads them: Sets left
 * blank are counted from the game scores, and "WO" marks a walkover. A match
 * has a winner once someone has 3 games (or it's a walkover); before that, a
 * match with games entered is live.
 */
function readMatches(g: Grid, start: number, cols: MatchCols, bySeed: Map<number, string>, max: number): GroupMatch[] {
  if (cols.order < 0) return [];
  const out: GroupMatch[] = [];
  for (let r = start; r < g.length && out.length < max; r += 1) {
    const m = ORDER_RE.exec(text(at(g, r, cols.order)));
    if (!m) break;
    const a = bySeed.get(Number(m[1]));
    const b = bySeed.get(Number(m[2]));
    if (!a || !b) continue;
    const raw = cols.sets >= 0 ? at(g, r, cols.sets) : null;
    const games = cols.games.map((c) => parseSets(at(g, r, c))).filter((x): x is [number, number] => x != null);
    let sets = parseSets(raw);
    if (!sets && games.length) sets = countGames(games);
    const decided = !!sets && sets[0] !== sets[1];
    const wo = decided && typeof raw === 'string' && WO_RE.test(raw);
    const done = decided && (wo || Math.max(sets![0], sets![1]) >= TO_WIN);
    const match: GroupMatch = {
      order: out.length + 1,
      a,
      b,
      aSets: sets ? sets[0] : null,
      bSets: sets ? sets[1] : null,
      games,
      winner: done ? (sets![0] > sets![1] ? a : b) : null,
    };
    if (wo) match.wo = true;
    if (!done && (games.length > 0 || (!!sets && sets[0] + sets[1] > 0))) match.live = true;
    out.push(match);
  }
  return out;
}

/**
 * The winner as the sheet's ITTF_STANDINGS counts it: any unequal set score,
 * even while games are still being entered.
 */
function sheetResult(m: GroupMatch): { winner: string; loser: string } | null {
  if (m.aSets == null || m.bSets == null || m.aSets === m.bSets) return null;
  return m.aSets > m.bSets ? { winner: m.a, loser: m.b } : { winner: m.b, loser: m.a };
}

/** Wins, losses and match points (2 per win, 1 per loss, 0 for a walkover loss), as the sheet counts them. */
function tally(names: string[], matches: GroupMatch[]): Map<string, { w: number; l: number; pts: number }> {
  const t = new Map(names.map((n) => [n, { w: 0, l: 0, pts: 0 }]));
  for (const m of matches) {
    const res = sheetResult(m);
    if (!res) continue;
    const win = t.get(res.winner);
    const lose = t.get(res.loser);
    if (win) {
      win.w += 1;
      win.pts += 2;
    }
    if (lose) {
      lose.l += 1;
      lose.pts += m.wo ? 0 : 1;
    }
  }
  return t;
}

const ratio = (won: number, lost: number) => (lost === 0 ? (won === 0 ? 0 : Infinity) : won / lost);

/** Splits names into runs of equal score, best first. */
function splitBy(names: string[], score: (n: string) => number): string[][] {
  const sorted = names.slice().sort((a, b) => (score(a) === score(b) ? 0 : score(b) > score(a) ? 1 : -1));
  const out: string[][] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && score(last[0]) === score(n)) last.push(n);
    else out.push([n]);
  }
  return out;
}

/**
 * Group order under the ITTF rules (Handbook 3.7.5): match points first. Tied
 * players are then compared on the matches between them only, by match points,
 * then the ratio of games won to lost, then the ratio of points won to lost.
 * Once a player is separated, their matches drop out of the remaining
 * comparison. Anything still tied keeps the group seed order.
 */
export function ittfOrder(players: GroupPlayer[], matches: GroupMatch[]): string[] {
  const seed = new Map(players.map((p) => [p.name, p.groupSeed ?? p.seed ?? 999]));
  const played = matches.filter((m) => sheetResult(m));
  const resolve = (tied: string[]): string[] => {
    if (tied.length < 2) return tied;
    const s = new Map(tied.map((n) => [n, { mp: 0, gw: 0, gl: 0, pw: 0, pl: 0 }]));
    for (const m of played) {
      const a = s.get(m.a);
      const b = s.get(m.b);
      if (!a || !b) continue;
      const res = sheetResult(m)!;
      s.get(res.winner)!.mp += 2;
      s.get(res.loser)!.mp += m.wo ? 0 : 1;
      a.gw += m.aSets ?? 0;
      a.gl += m.bSets ?? 0;
      b.gw += m.bSets ?? 0;
      b.gl += m.aSets ?? 0;
      for (const [x, y] of m.games) {
        a.pw += x;
        a.pl += y;
        b.pw += y;
        b.pl += x;
      }
    }
    const steps: ((n: string) => number)[] = [
      (n) => s.get(n)!.mp,
      (n) => ratio(s.get(n)!.gw, s.get(n)!.gl),
      (n) => ratio(s.get(n)!.pw, s.get(n)!.pl),
    ];
    for (const step of steps) {
      const parts = splitBy(tied, step);
      if (parts.length > 1) return parts.flatMap(resolve);
    }
    return tied.slice().sort((x, y) => seed.get(x)! - seed.get(y)!);
  };
  const overall = tally([...seed.keys()], played);
  return splitBy([...seed.keys()], (n) => overall.get(n)!.pts).flatMap(resolve);
}

/** The W / L / Pts / Rank cells exactly as the sheet shows them. */
interface SheetStanding {
  wins: Cell;
  losses: Cell;
  points: Cell;
  rank: Cell;
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

/**
 * The sheet's W, L, Pts and Rank are official. They're only worked out here
 * when the standings formula shows "Loading…" or an error, or is empty while
 * results are in. Returns the players in finishing order, plus notes about
 * anything that doesn't add up.
 */
function settleStandings(
  players: GroupPlayer[],
  sheet: SheetStanding[],
  matches: GroupMatch[],
  where: string,
): { players: GroupPlayer[]; computed: boolean; notes: string[] } {
  const notes: string[] = [];
  const results = matches.some((m) => sheetResult(m));
  const cells = sheet.flatMap((s) => [s.wins, s.losses, s.points, s.rank]);
  const broken = cells.find(notNumber);
  const empty = sheet.every((s) => s.wins == null && s.losses == null && s.rank == null);
  if (matches.length > 0 && (broken !== undefined || (empty && results))) {
    const t = tally(
      players.map((p) => p.name),
      matches,
    );
    const order = ittfOrder(players, matches);
    for (const p of players) {
      const x = t.get(p.name)!;
      p.wins = x.w;
      p.losses = x.l;
      p.points = x.pts;
      p.rank = order.indexOf(p.name) + 1;
    }
    if (results) {
      notes.push(
        broken !== undefined
          ? `${where}: the standings showed "${broken.trim()}", so W, L, Pts and Rank were worked out from the results`
          : `${where}: the standings were empty, so W, L, Pts and Rank were worked out from the results`,
      );
    }
    return { players: players.slice().sort((a, b) => a.rank - b.rank), computed: true, notes };
  }
  if (broken !== undefined) notes.push(`${where}: the standings show "${broken.trim()}"`);
  if (results) {
    const t = tally(
      players.map((p) => p.name),
      matches,
    );
    const off = players.filter((p) => {
      const x = t.get(p.name)!;
      return x.w !== p.wins || x.l !== p.losses;
    });
    if (off.length) {
      const p = off[0];
      const x = t.get(p.name)!;
      notes.push(
        `${where}: W–L on the sheet doesn't match the results entered (${p.name}: sheet ${p.wins}–${p.losses}, results ${x.w}–${x.l}${off.length > 1 ? `, and ${off.length - 1} more` : ''})`,
      );
    }
  }
  return { players: rankPlayers(players), computed: false, notes };
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

export type DrawName = EventData['drawName'];

/** On tabs that still carry two draws side by side, the first is the serpentine draw and the second the seeded pot draw. */
const BY_POSITION: Record<1 | 2, NonNullable<DrawName>> = { 1: 'serpentine', 2: 'seeded pot' };

/** "Serpentine" / "Seeded Pot" written in the draw's header row (Tournament Tools puts the name in R1). */
function drawLabel(v: Cell): DrawName {
  const s = text(v).toLowerCase();
  if (/serpentine/.test(s)) return 'serpentine';
  if (/seeded\s*pot|\bpot\b/.test(s)) return 'seeded pot';
  return null;
}

// Player list headers, matched the way Tournament Tools finds them in A:F.
const ROSTER = {
  bye: /bye|skip/,
  name: /^(?!.*bye).*name/,
  prov: /prov|assoc|club/,
  gender: /gender|sex/,
  rating: /rating/,
};

/**
 * An event tab has a player list in A:F (a name column) and either a group
 * draw (a "Group" column followed by "Event Seed" / "Group Seed") or a bye
 * column, so other tabs that happen to have a "Group" or "Skip" column are not
 * taken for events. Player list columns are found the way Tournament Tools
 * finds them ("Player Name", "Club", "Sex", "Skip"… all work), falling back to
 * B = Province, C = Gender, D = Rating, E = Bye.
 */
export function eventLayout(g: Grid): Layout | null {
  const h = g[0] ?? [];
  const head = (c: number) => norm(text(h[c] ?? null));
  const draws: number[] = [];
  for (let c = 0; c < h.length; c += 1) {
    if (head(c) === 'group' && [1, 2, 3].some((k) => head(c + k) === 'eventseed' || head(c + k) === 'groupseed')) draws.push(c);
  }
  const end = Math.min(6, draws[0] ?? 6);
  const find = (re: RegExp, fallback: number) => {
    for (let c = 0; c < end; c += 1) if (re.test(text(h[c] ?? null).toLowerCase())) return c;
    return fallback;
  };
  const nameCol = find(ROSTER.name, find(/^(?!.*bye).*(player|team)/, -1));
  const bye = find(ROSTER.bye, -1);
  // Before the draw, only a real bye column (Group_Stage_Bye) marks an event tab; "Skip…" alone is too common.
  if (nameCol < 0 || (draws.length === 0 && find(/bye/, -1) < 0)) return null;
  let bracketCol = -1;
  if (draws.length) {
    for (let r = 0; r < g.length; r += 1) {
      const row = g[r] ?? [];
      for (let c = draws[draws.length - 1] + 1; c < row.length; c += 1) {
        if (TITLE_RE.test(text(row[c] ?? null)) && (bracketCol < 0 || c < bracketCol)) bracketCol = c;
      }
    }
  }
  return {
    roster: {
      name: nameCol,
      prov: find(ROSTER.prov, 1),
      gender: find(ROSTER.gender, 2),
      rating: find(ROSTER.rating, 3),
      bye: bye >= 0 ? bye : 4,
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

interface DrawResult {
  groups: Group[];
  /** Matches with results entered, plus players with a win or loss on the sheet. */
  results: number;
  notes: string[];
  /** The draw's name when the sheet writes it in the header row. */
  label: DrawName;
}

/**
 * One group draw: the block of columns starting at the "Group" column `s` and
 * ending before `end` (the next draw or the brackets). The header row can
 * repeat above every group; those rows are skipped.
 */
function parseDraw(g: Grid, s: number, end: number, event: string): DrawResult {
  const h = g[0];
  const to = Math.min(end, s + 40);
  const opt = (names: string[]) => firstHeader(h, names, s + 1, to);
  // Offsets are the original layout's positions, used if a header is missing.
  const idx = (names: string[], offset: number) => {
    const i = opt(names);
    return i >= 0 ? i : s + offset;
  };
  const c = {
    seed: idx(['Event Seed', 'Seed'], 1),
    gseed: idx(['Group Seed'], 2),
    name: idx(['Name'], 3),
    prov: idx(['Province', 'Prov'], 4),
    gender: idx(['Gender'], 5),
    rating: idx(['Rating'], 6),
    wins: idx(WINS, 7),
    losses: idx(LOSSES, 8),
    points: opt(POINTS),
    rank: idx(['Rank'], 9),
  };
  const mcols: MatchCols = { order: opt(ORDER), sets: opt(SETS), games: gameCols(h, s + 1, to) };
  let label: DrawName = null;
  for (let k = s + 1; k < Math.min(to, h?.length ?? 0) && !label; k += 1) label = drawLabel(h[k] ?? null);

  const byGroup = new Map<string, { first: number; players: GroupPlayer[]; sheet: SheetStanding[] }>();
  for (let r = 1; r < g.length; r += 1) {
    const gname = text(at(g, r, s));
    const name = text(at(g, r, c.name));
    if (!gname || !name) continue;
    if (norm(gname) === 'group' || norm(name) === 'name') continue;
    let entry = byGroup.get(gname);
    if (!entry) {
      entry = { first: r, players: [], sheet: [] };
      byGroup.set(gname, entry);
    }
    const sheet: SheetStanding = {
      wins: at(g, r, c.wins),
      losses: at(g, r, c.losses),
      points: c.points >= 0 ? at(g, r, c.points) : null,
      rank: at(g, r, c.rank),
    };
    entry.sheet.push(sheet);
    entry.players.push({
      name,
      seed: num(at(g, r, c.seed)),
      groupSeed: num(at(g, r, c.gseed)),
      province: text(at(g, r, c.prov)),
      gender: text(at(g, r, c.gender)),
      rating: num(at(g, r, c.rating)),
      wins: num(sheet.wins) ?? 0,
      losses: num(sheet.losses) ?? 0,
      points: c.points >= 0 ? num(sheet.points) : null,
      rank: num(sheet.rank) ?? 0,
    });
  }

  let results = 0;
  const notes: string[] = [];
  const list: Group[] = [...byGroup.entries()].map(([name, e]) => {
    const bySeed = new Map<number, string>();
    e.players.forEach((p) => p.groupSeed != null && bySeed.set(p.groupSeed, p.name));
    const n = e.players.length;
    const matches = readMatches(g, e.first, mcols, bySeed, (n * (n - 1)) / 2);
    results += matches.filter((m) => m.winner || m.live || sheetResult(m)).length;
    results += e.players.filter((p) => p.wins > 0 || p.losses > 0).length;
    const settled = settleStandings(e.players, e.sheet, matches, `${event} ${name}`);
    notes.push(...settled.notes);
    const group: Group = {
      name,
      label: name.replace(/^group\s*/i, '') || name,
      players: settled.players,
      matches,
    };
    if (settled.computed) group.computed = true;
    return group;
  });
  const key = (gr: Group) => {
    const n = Number(gr.label);
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
  };
  return { groups: list.sort((a, b) => key(a) - key(b) || a.label.localeCompare(b.label)), results, notes, label };
}

/** "Name (1710) (Group 2)", the way bracket and round-robin entries are written. */
const ENTRY_RE = /^(.*?)\s*\(([\d.]+)\)\s*\((.*)\)\s*$/;

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
  roundof128: 'R128',
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

function parseBrackets(g: Grid, bc: number, warn: (m: string) => void, tab: string, event: string): ParsedBracket[] {
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
    const label = rest.replace(/\(.*$/, '').replace(/\s+bracket\s*$/i, '').trim() || `Bracket ${id}`;
    // Any bracket (A, B, C, D…) can be a knockout or a round-robin. Decide from the
    // title first, then from the layout: knockout blocks have round headers right
    // under the title, round-robin blocks have a Seed/W/L table.
    const saysRoundRobin = /round[\s-]*robin/i.test(rest);
    const hasRoundHeaders = /^(round|quarter|semi|final|r\d)/i.test(text(at(g, tr + 1, bc)));
    if (saysRoundRobin || !hasRoundHeaders) {
      const rr = parseRoundRobin(g, tr, bc, id, label, preliminary, `${event} ${id} ${label}`, warn);
      if (rr) {
        out.push(rr);
        continue;
      }
      warn(`${tab}: bracket ${id} has no players or round headers yet`);
      continue;
    }

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
    const bracket: Bracket = { id, label, format: 'knockout', size, players, preliminary, champion, rounds };
    // With fewer than 4 players the play-off is only byes, so it is left out.
    const thirdPlace = players >= 4 ? readPlayoff(g, fr + 2 * size - 1, bc) : null;
    if (thirdPlace) bracket.thirdPlace = thirdPlace;
    out.push({ bracket, firstRound });
  }
  return out;
}

const PLAYOFF_RE = /play-?\s*off\s*3\s*\/\s*4|3rd\s*place|third\s*place/i;

/**
 * Tournament Tools puts a "Division A - Play-off 3/4" block under each knockout
 * bracket: the two semifinal losers (2 and 4 rows below the title, scores
 * beside them) and the 3rd-place cell 3 rows down, three columns across.
 */
function readPlayoff(g: Grid, from: number, bc: number): Match | null {
  for (let r = from; r < Math.min(g.length, from + 8); r += 1) {
    const cell = text(at(g, r, bc));
    if (TITLE_RE.test(cell)) return null;
    if (!PLAYOFF_RE.test(cell)) continue;
    const a = readEntry(g, r + 2, bc);
    const b = readEntry(g, r + 4, bc);
    const third = readEntry(g, r + 3, bc + 3).name;
    const slot = (e: Entry): Slot => ({ name: e.name, bye: e.bye, score: e.bye ? null : e.score });
    const winner = third && (third === a.name || third === b.name) ? third : null;
    return { a: slot(a), b: slot(b), winner };
  }
  return null;
}

function parseRoundRobin(
  g: Grid,
  tr: number,
  bc: number,
  id: string,
  label: string,
  preliminary: boolean,
  where: string,
  warn: (m: string) => void,
): ParsedBracket | null {
  let hr = -1;
  for (let r = tr + 1; r <= tr + 4 && r < g.length; r += 1) {
    if (headerIndex(g[r], 'Seed', bc, bc + 3) >= 0) {
      hr = r;
      break;
    }
  }
  if (hr < 0) return null;
  const h = g[hr];
  const to = bc + 30;
  const col = (names: string[]) => firstHeader(h, names, bc + 1, to);
  const c = { seed: col(['Seed']), wins: col(WINS), losses: col(LOSSES), points: col(POINTS), rank: col(['Rank']) };
  const mcols: MatchCols = { order: col(ORDER), sets: col(SETS), games: gameCols(h, bc + 1, to) };
  const entries: Entry[] = [];
  const players: GroupPlayer[] = [];
  const sheet: SheetStanding[] = [];
  for (let r = hr + 1; r < g.length; r += 1) {
    const e = readEntry(g, r, bc);
    if (!e.name) break;
    entries.push(e);
    const s: SheetStanding = {
      wins: c.wins >= 0 ? at(g, r, c.wins) : null,
      losses: c.losses >= 0 ? at(g, r, c.losses) : null,
      points: c.points >= 0 ? at(g, r, c.points) : null,
      rank: c.rank >= 0 ? at(g, r, c.rank) : null,
    };
    sheet.push(s);
    players.push({
      name: e.name,
      seed: null,
      groupSeed: c.seed >= 0 ? num(at(g, r, c.seed)) : players.length + 1,
      province: '',
      gender: '',
      rating: null,
      wins: num(s.wins) ?? 0,
      losses: num(s.losses) ?? 0,
      points: c.points >= 0 ? num(s.points) : null,
      rank: num(s.rank) ?? 0,
    });
  }
  if (!players.length) return null;
  const bySeed = new Map<number, string>();
  players.forEach((p) => p.groupSeed != null && bySeed.set(p.groupSeed, p.name));
  const total = (players.length * (players.length - 1)) / 2;
  const matches = readMatches(g, hr + 1, mcols, bySeed, total);
  const settled = settleStandings(players, sheet, matches, where);
  settled.notes.forEach(warn);
  const ranked = settled.players;
  const done = matches.length >= total && matches.every((m) => m.winner);
  const table: Group = { name: label, label: id, players: ranked, matches };
  if (settled.computed) table.computed = true;
  return {
    bracket: {
      id,
      label,
      format: 'roundrobin',
      table,
      size: players.length,
      players: players.length,
      preliminary,
      champion: done ? ranked[0].name : null,
      rounds: [],
    },
    firstRound: entries,
  };
}

/**
 * Tournament Tools keeps one draw per tab in G:Y (whichever draw was run last),
 * so that draw is used, named only when the sheet says which it is.
 *
 * Tabs made with the earlier tools carry two draws side by side: the serpentine
 * draw and the seeded pot draw. The one with results entered is the one that
 * was played, so it feeds the knockout stage. When neither or both have
 * results, the bracket "(Group N)" labels decide, and the serpentine draw is
 * the last resort.
 */
function chooseDraw(
  draws: DrawResult[],
  firstRounds: Entry[][],
  warn: (m: string) => void,
  event: string,
): { draw: 1 | 2; by: EventData['drawBy']; name: DrawName } {
  if (draws.length < 2) return { draw: 1, by: 'single', name: draws[0]?.label ?? null };
  const pick = (draw: 1 | 2, by: EventData['drawBy']) => ({ draw, by, name: draws[draw - 1].label ?? BY_POSITION[draw] });
  const named = (draw: 1 | 2) => `${draws[draw - 1].label ?? BY_POSITION[draw]} draw`;
  if (draws[1].groups.length === 0) return pick(1, 'single');
  if (draws[0].groups.length === 0) return pick(2, 'single');
  const [r1, r2] = [draws[0].results, draws[1].results];
  if (r1 > 0 && r2 === 0) return pick(1, 'results');
  if (r2 > 0 && r1 === 0) return pick(2, 'results');
  const both = r1 > 0 && r2 > 0;

  const labels: { name: string; group: string }[] = [];
  firstRounds.forEach((entries) =>
    entries.forEach((e) => {
      if (e.name && e.origin && /^group\b/i.test(e.origin)) labels.push({ name: e.name, group: norm(e.origin) });
    }),
  );
  if (labels.length) {
    const scores = draws.slice(0, 2).map((d) => {
      const where = new Map<string, string>();
      d.groups.forEach((gr) => gr.players.forEach((p) => where.set(p.name, norm(gr.name))));
      return labels.filter((l) => where.get(l.name) === l.group).length;
    });
    if (scores[0] !== scores[1]) {
      const draw: 1 | 2 = scores[1] > scores[0] ? 2 : 1;
      if (both) warn(`${event}: both group draws have results entered; using the ${named(draw)} because the brackets match it`);
      return pick(draw, 'brackets');
    }
  }
  if (both) warn(`${event}: both group draws have results entered and the brackets don't tell them apart; using the ${named(1)}`);
  else if (labels.length) warn(`${event}: both group draws match the bracket labels equally; using the ${named(1)}`);
  return pick(1, 'default');
}

function parseEvent(tab: string, g: Grid, warn: (m: string) => void): EventData | null {
  const L = eventLayout(g);
  if (!L) return null;
  const roster = parseRoster(g, L.roster);
  if (roster.length === 0) return null;
  const name = tab.replace(/_/g, ' ').trim();
  const draws = L.draws
    .slice(0, 2)
    .map((s, i) => parseDraw(g, s, L.draws[i + 1] ?? (L.bracketCol >= 0 ? L.bracketCol : Infinity), name));
  const parsed = parseBrackets(g, L.bracketCol, warn, tab, name);
  const { draw, by, name: drawName } = chooseDraw(draws, parsed.map((p) => p.firstRound), warn, name);
  draws[draw - 1]?.notes.forEach(warn);
  return {
    id: slug(tab),
    name,
    tab,
    roster,
    byes: roster.filter((p) => p.bye).map((p) => p.name),
    draw,
    drawName,
    drawBy: by,
    groups: draws[draw - 1]?.groups ?? [],
    brackets: parsed.map((p) => p.bracket),
  };
}

/** The players in a doubles team written as "A / B"; one name for singles. */
export function teamMembers(name: string): string[] {
  const parts = name.split('/').map((s) => s.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [name];
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
  // A doubles team gets one too, rated as the sheet rates the team.
  const ranked = new Set(Object.keys(players));
  for (const ev of events) {
    for (const p of ev.roster) {
      if (players[p.name]) continue;
      const inGroup = ev.groups.flatMap((gr) => gr.players).find((gp) => gp.name === p.name);
      const members = teamMembers(p.name);
      const known = members.map((m) => (ranked.has(m) ? players[m] : undefined));
      const same = (vals: (string | undefined)[]) => {
        const set = [...new Set(vals.filter(Boolean))];
        return set.length === 1 ? set[0]! : set.join('/');
      };
      players[p.name] = {
        rating: p.rating ?? inGroup?.rating ?? null,
        gender: p.gender || inGroup?.gender || (members.length > 1 ? same(known.map((k) => k?.gender)) : ''),
        province: p.province || inGroup?.province || (members.length > 1 ? same(known.map((k) => k?.province)) : ''),
        listRank: null,
        period: null,
        lastPlayed: null,
        temp: false,
      };
      const missing = members.length > 1 ? members.filter((m) => !ranked.has(m)) : [p.name];
      if (missing.length) warn(`${ev.name}: ${missing.map((m) => `"${m}"`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not on the ranking list`);
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
