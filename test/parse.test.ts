import { describe, expect, it } from 'vitest';
import wb1005 from './fixtures/workbook-2026-10-05.grids.json';
import wb1007 from './fixtures/workbook-2026-10-07.grids.json';
import wb1009 from './fixtures/workbook-2026-10-09.grids.json';
import snapshot from '../src/data/snapshot.grids.json';
import { buildTournament, fingerprint, ittfOrder, parseSets } from '../src/shared/parse';
import type { Bracket, Cell, Grid, GroupMatch, GroupPlayer, Workbook } from '../src/shared/types';
import { parseCsv } from '../src/shared/csv';
import { parseTabs, tabsFromHtml } from '../src/worker/sheets';
import { put as putAt, v5Tab } from './v5';
import { higherRatedWins, teams, v7DoublesTab } from './v7';

const SRC = { kind: 'snapshot', label: 'test' } as const;
const build = (wb: Workbook) => buildTournament(wb, SRC, new Date('2026-10-05T00:00:00Z'));
const clone = (wb: unknown) => structuredClone(wb) as Workbook;

/** Column letters to a 0-based index ("A" = 0, "AW" = 48). */
const col = (letters: string) => letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** Sets a cell by A1-style address, growing the row if needed. */
function put(g: Grid, addr: string, v: Cell) {
  const m = /^([A-Z]+)(\d+)$/.exec(addr)!;
  const r = Number(m[2]) - 1;
  const c = col(m[1]);
  const row = (g[r] ??= []);
  while (row.length <= c) row.push(null);
  row[c] = v;
}

/** What the free CSV export gives back: every value as text. */
function viaCsv(wb: Workbook): Workbook {
  const toCsv = (v: Cell) => {
    if (v === null) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const sheets: Workbook['sheets'] = {};
  for (const [name, grid] of Object.entries(wb.sheets)) {
    const csv = grid.map((row) => row.map(toCsv).join(',')).join('\r\n');
    sheets[name] = parseCsv(csv);
  }
  // CSV exports show dates as text; mimic that for the ranking list.
  const rank = sheets['Canada_Rankings'];
  const c = rank[0].indexOf('Last Played');
  for (let r = 1; r < rank.length; r += 1) {
    const v = Number(rank[r][c]);
    if (v) {
      const d = new Date(Math.round((v - 25569) * 86400000));
      rank[r][c] = `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
    }
  }
  return { title: 'csv', sheets };
}

/* ------------------------------------------------------------------ */

describe('2026-10-05 workbook (no match rows)', () => {
  const t = build(wb1005 as unknown as Workbook);
  const ev = (id: string) => t.events.find((e) => e.id === id)!;

  it('finds the three events and the ranking list', () => {
    expect(t.events.map((e) => e.id)).toEqual(['open-singles', 'active-4-life', 'beginners']);
    expect(t.rankCount).toBe(200);
    expect(t.players['Lehmann Matthew']).toMatchObject({ rating: 2846, listRank: 1, lastPlayed: '2026-04-30', temp: false });
  });

  it('picks the group draw that feeds the brackets when results do not tell them apart', () => {
    expect([ev('open-singles').draw, ev('open-singles').drawBy]).toEqual([2, 'brackets']);
    expect([ev('active-4-life').draw, ev('active-4-life').drawBy]).toEqual([1, 'brackets']);
    expect([ev('beginners').draw, ev('beginners').drawBy]).toEqual([2, 'brackets']);
  });

  it('reads groups, ranks and byes', () => {
    const open = ev('open-singles');
    expect(open.groups).toHaveLength(12);
    expect(open.groups.every((g) => g.players.length === 4)).toBe(true);
    expect(open.byes).toEqual(['Lehmann Matthew', 'ZHANG Tian-Terry', 'YAN Steven']);
    expect(open.groups[0].players.map((p) => [p.name, p.wins, p.losses, p.rank, p.points])).toEqual([
      ['Oyewo BJ', 3, 0, 1, null],
      ['Palad Dilbert', 2, 1, 2, null],
      ['Sirotina Polina', 1, 2, 3, null],
      ['Bernales Raul', 0, 3, 4, null],
    ]);
  });

  it('builds complete brackets with winners', () => {
    const open = ev('open-singles');
    expect(open.brackets.map((b) => [b.id, b.label, b.size, b.players, b.champion])).toEqual([
      ['A', 'Championship', 32, 27, 'Lehmann Matthew'],
      ['B', 'Consolation', 16, 12, 'Catalan Pablo'],
      ['C', 'Division C', 16, 12, 'Wang Lee Ryson'],
    ]);
    const A = open.brackets[0];
    expect(A.rounds.map((r) => [r.short, r.matches.length])).toEqual([
      ['R1', 16], ['R2', 8], ['QF', 4], ['SF', 2], ['Final', 1],
    ]);
    expect(A.rounds[0].matches[0]).toEqual({
      a: { name: 'Lehmann Matthew', bye: false, score: null },
      b: { name: null, bye: true, score: null },
      winner: 'Lehmann Matthew',
    });
    expect(A.rounds[4].matches[0]).toEqual({
      a: { name: 'Lehmann Matthew', bye: false, score: 3 },
      b: { name: 'ZHANG Tian-Terry', bye: false, score: 0 },
      winner: 'Lehmann Matthew',
    });
  });

  it('keeps pending matches open', () => {
    const A = ev('active-4-life').brackets[0];
    expect(A.champion).toBeNull();
    expect(A.rounds[0].matches[1]).toMatchObject({ a: { name: 'Saindon Allan' }, b: { name: 'Palad Dilbert' }, winner: null });
    expect(A.rounds[1].matches[0]).toMatchObject({ a: { name: 'Sepulveda Dino' }, b: { name: null, bye: false } });
    const beg = ev('beginners');
    expect(beg.brackets.every((b) => b.preliminary)).toBe(true);
    expect(beg.brackets[0].rounds[0].matches[1]).toMatchObject({ a: { score: 1 }, b: { score: 3 }, winner: 'Mendoza Maxwell' });
  });

  it('flags players missing from the ranking list', () => {
    expect(t.players['John Doe']).toMatchObject({ listRank: null, rating: 100 });
    expect(t.warnings.some((w) => w.includes('John Doe'))).toBe(true);
  });

  it('fingerprint ignores timestamps', () => {
    const again = buildTournament(wb1005 as unknown as Workbook, SRC, new Date('2030-01-01T00:00:00Z'));
    expect(fingerprint(again)).toBe(fingerprint(t));
  });

  it('gives the same tournament through the CSV export', () => {
    const csv = build(viaCsv(wb1005 as unknown as Workbook));
    expect(csv.events).toEqual(t.events);
    expect(csv.players).toEqual(t.players);
  });
});

describe('2026-10-07 workbook (match results, round-robin, empty tabs)', () => {
  const t = build(wb1007 as unknown as Workbook);
  const ev = (id: string) => t.events.find((e) => e.id === id)!;

  it('skips event tabs with no registered players', () => {
    expect(t.events.map((e) => e.id)).toEqual(['open-singles', 'active-4-life', 'beginners']);
  });

  it('reads group match results, including sets the sheet turned into dates', () => {
    const g1 = ev('open-singles').groups[0];
    expect(g1.matches).toHaveLength(6);
    expect(g1.matches[0]).toEqual({ order: 1, a: 'Bekele Biruk', b: 'Palad Dilbert', aSets: 3, bSets: 2, games: [], winner: 'Bekele Biruk' });
    expect(g1.matches[3]).toMatchObject({ a: 'Saindon Laurie', b: 'Palad Dilbert', aSets: 3, bSets: 0 });
  });

  it('reads round-robin brackets', () => {
    const B = ev('active-4-life').brackets[1];
    expect(B).toMatchObject({ id: 'B', label: 'Consolation', format: 'roundrobin', players: 5, champion: 'Caguioa Czar' });
    expect(B.table!.matches).toHaveLength(10);
    const pending = ev('beginners').brackets[1];
    expect(pending.champion).toBeNull();
    expect(pending.table!.matches.every((m) => m.aSets === null)).toBe(true);
  });

  it('strips "Bracket" from labels and keeps knockout brackets intact', () => {
    expect(ev('open-singles').brackets.map((b) => [b.id, b.label, b.format, b.champion])).toEqual([
      ['A', 'Championship', 'knockout', 'Lehmann Matthew'],
      ['B', 'Consolation', 'knockout', 'Liu Rhea'],
      ['C', 'Division C', 'knockout', null],
    ]);
  });
});

describe('2026-10-09 workbook (repeated headers, W/L/Pts, game scores)', () => {
  const t = build(wb1009 as unknown as Workbook);
  const ev = (id: string) => t.events.find((e) => e.id === id)!;

  it('publishes the three events with players and skips Youth and Open_Doubles', () => {
    expect(t.events.map((e) => e.id)).toEqual(['open-singles', 'active-4-life', 'beginners']);
    expect(Object.keys((wb1009 as unknown as Workbook).sheets)).toContain('Open_Doubles');
  });

  it('uses the serpentine draw, the one with results entered', () => {
    for (const e of t.events) expect([e.id, e.draw, e.drawBy]).toEqual([e.id, 1, 'results']);
  });

  it('skips the header row repeated above every group', () => {
    expect(ev('open-singles').groups.map((g) => g.name)).toEqual(Array.from({ length: 12 }, (_, i) => `Group ${i + 1}`));
    expect(ev('open-singles').groups.every((g) => g.players.length === 4)).toBe(true);
    expect(ev('active-4-life').groups.map((g) => g.players.length)).toEqual([3, 3, 3, 3, 3]);
    const names = t.events.flatMap((e) => e.groups.flatMap((g) => g.players.map((p) => p.name)));
    expect(names).not.toContain('Name');
  });

  it('reads W, L, Pts, Rank and the matches with game scores', () => {
    const g1 = ev('open-singles').groups[0];
    expect(g1.computed).toBeUndefined();
    expect(g1.players.map((p) => [p.rank, p.name, p.wins, p.losses, p.points])).toEqual([
      [1, 'Bekele Biruk', 3, 0, 6],
      [2, 'Saindon Laurie', 2, 1, 5],
      [3, 'Palad Dilbert', 1, 2, 4],
      [4, 'Baseric Nevenko', 0, 3, 3],
    ]);
    expect(g1.matches).toHaveLength(6);
    expect(g1.matches[0]).toEqual({
      order: 1,
      a: 'Bekele Biruk',
      b: 'Palad Dilbert',
      aSets: 3,
      bSets: 1,
      games: [[11, 7], [8, 11], [11, 2], [11, 5]],
      winner: 'Bekele Biruk',
    });
    expect(g1.matches[3]).toMatchObject({ a: 'Saindon Laurie', b: 'Palad Dilbert', aSets: 3, bSets: 2, winner: 'Saindon Laurie' });
    expect(g1.matches[3].games).toHaveLength(5);
    const a4l = ev('active-4-life').groups[0];
    expect(a4l.matches.map((m) => [m.a, m.b, m.winner])).toEqual([
      ['Sepulveda Dino', 'Zahedi Hamid', 'Sepulveda Dino'],
      ['Raymundo Irwin', 'Zahedi Hamid', 'Raymundo Irwin'],
      ['Sepulveda Dino', 'Raymundo Irwin', 'Sepulveda Dino'],
    ]);
  });

  it('reads the new round headers and round-robin blocks', () => {
    expect(ev('open-singles').brackets[0].rounds.map((r) => r.short)).toEqual(['R32', 'R16', 'QF', 'SF', 'Final']);
    expect(ev('active-4-life').brackets[0].rounds.map((r) => r.short)).toEqual(['R16', 'QF', 'SF', 'Final']);
    const B = ev('active-4-life').brackets[1];
    expect(B).toMatchObject({ format: 'roundrobin', players: 5, champion: 'Zahedi Hamid' });
    expect(B.table!.players.map((p) => [p.rank, p.name, p.wins, p.losses, p.points])).toEqual([
      [1, 'Zahedi Hamid', 4, 0, 8],
      [2, 'Sioson Juanito', 3, 1, 7],
      [3, 'LEE Kin Pong', 2, 2, 6],
      [4, 'Cantada Noel', 1, 3, 5],
      [5, 'Bernales Raul', 0, 4, 4],
    ]);
    expect(B.table!.matches).toHaveLength(10);
    expect(B.table!.matches[0].games).toEqual([[5, 11], [11, 5], [11, 8], [11, 7]]);
  });

  it('agrees with the sheet on every tie-break', () => {
    // Beginners B: Feliciano and Medina both 3–1 (Feliciano won their match),
    // Wang and Nouri both 2–2 (Wang won theirs).
    const B = ev('beginners').brackets[1];
    expect(B.table!.players.map((p) => [p.name, p.points])).toEqual([
      ['Feliciano Emilio', 7],
      ['Medina Camilo', 7],
      ['Wang Nobuchika', 6],
      ['Nouri Elham', 6],
      ['Zhang Ge', 4],
    ]);
    for (const e of t.events) {
      for (const g of [...e.groups, ...e.brackets.flatMap((b) => (b.table ? [b.table] : []))]) {
        expect(ittfOrder(g.players, g.matches)).toEqual(g.players.map((p) => p.name));
      }
    }
  });

  it('has nothing to warn about besides the unlisted player', () => {
    expect(t.warnings).toEqual(['Beginners: "John Doe" is not on the ranking list']);
  });

  it('gives the same tournament through the CSV export', () => {
    const csv = build(viaCsv(wb1009 as unknown as Workbook));
    expect(csv.events).toEqual(t.events);
    expect(csv.players).toEqual(t.players);
    expect(csv.warnings).toEqual(t.warnings);
  });

  it('ships as the bundled snapshot', () => {
    expect((snapshot as unknown as Workbook).sheets).toEqual((wb1009 as unknown as Workbook).sheets);
  });
});

// 10-09 layout. Serpentine draw: W N, L O, Pts P, Sets T, games U–Y. Seeded pot draw: Sets AO.
function clearSerpentineResults(g: Grid) {
  for (let r = 2; r <= g.length; r += 1) {
    if (typeof g[r - 1]?.[col('J')] === 'string' && g[r - 1][col('J')] !== 'Name') {
      put(g, `N${r}`, 0);
      put(g, `O${r}`, 0);
      put(g, `P${r}`, 0);
    }
    if (g[r - 1]?.[col('T')] != null && g[r - 1][col('T')] !== 'Sets') {
      for (const c of ['T', 'U', 'V', 'W', 'X', 'Y']) put(g, `${c}${r}`, null);
    }
  }
}

describe('which group draw is used', () => {
  const OPEN = 'Open_Singles';
  const copyResultsToPot = (g: Grid) => {
    for (let r = 2; r <= g.length; r += 1) {
      const v = g[r - 1]?.[col('T')];
      if (v != null && v !== 'Sets') put(g, `AO${r}`, v);
    }
  };

  it('uses the seeded pot draw when only it has results, even if the brackets point elsewhere', () => {
    const wb = clone(wb1009);
    copyResultsToPot(wb.sheets[OPEN]);
    clearSerpentineResults(wb.sheets[OPEN]);
    const e = build(wb).events[0];
    expect([e.draw, e.drawBy]).toEqual([2, 'results']);
    expect(e.groups[0].players.map((p) => p.name)).toContain('Sepulveda Dino');
    expect(e.groups.every((g) => g.matches.some((m) => m.winner))).toBe(true);
  });

  it('falls back to the bracket labels when neither draw has results', () => {
    const wb = clone(wb1009);
    clearSerpentineResults(wb.sheets[OPEN]);
    const t = build(wb);
    expect([t.events[0].draw, t.events[0].drawBy]).toEqual([1, 'brackets']);
    expect(t.warnings).toEqual(['Beginners: "John Doe" is not on the ranking list']);
  });

  it('warns and follows the brackets when both draws have results', () => {
    const wb = clone(wb1009);
    copyResultsToPot(wb.sheets[OPEN]);
    const t = build(wb);
    expect([t.events[0].draw, t.events[0].drawBy]).toEqual([1, 'brackets']);
    expect(t.warnings).toContain('Open Singles: both group draws have results entered; using the serpentine draw because the brackets match it');
  });
});

describe('standings fallback', () => {
  it('works the standings out when the formula shows Loading…', () => {
    const wb = clone(wb1009);
    const g = wb.sheets['Beginners'];
    for (let r = 43; r <= 47; r += 1) for (const c of ['AY', 'AZ', 'BA', 'BB']) put(g, `${c}${r}`, null);
    put(g, 'AY43', 'Loading...');
    const t = build(wb);
    const B = t.events.find((e) => e.id === 'beginners')!.brackets[1];
    expect(B.table!.computed).toBe(true);
    expect(B.table!.players.map((p) => [p.rank, p.name, p.wins, p.losses, p.points])).toEqual([
      [1, 'Feliciano Emilio', 3, 1, 7],
      [2, 'Medina Camilo', 3, 1, 7],
      [3, 'Wang Nobuchika', 2, 2, 6],
      [4, 'Nouri Elham', 2, 2, 6],
      [5, 'Zhang Ge', 0, 4, 4],
    ]);
    expect(B.champion).toBe('Feliciano Emilio');
    expect(t.warnings.some((w) => w.includes('Beginners B Consolation') && w.includes('"Loading..."'))).toBe(true);
  });

  it('works the group standings out when the formula shows an error', () => {
    const wb = clone(wb1009);
    const g = wb.sheets['Open_Singles'];
    for (let r = 2; r <= 5; r += 1) for (const c of ['N', 'O', 'P', 'Q']) put(g, `${c}${r}`, null);
    put(g, 'N2', '#ERROR!');
    const t = build(wb);
    const g1 = t.events[0].groups[0];
    expect(g1.computed).toBe(true);
    expect(g1.players.map((p) => [p.rank, p.name, p.wins, p.losses, p.points])).toEqual([
      [1, 'Bekele Biruk', 3, 0, 6],
      [2, 'Saindon Laurie', 2, 1, 5],
      [3, 'Palad Dilbert', 1, 2, 4],
      [4, 'Baseric Nevenko', 0, 3, 3],
    ]);
    expect(t.warnings.some((w) => w.startsWith('Open Singles Group 1: the standings showed "#ERROR!"'))).toBe(true);
  });

  it('keeps the sheet official but flags W–L that do not match the results', () => {
    const wb = clone(wb1009);
    put(wb.sheets['Open_Singles'], 'O3', 2);
    const t = build(wb);
    expect(t.events[0].groups[0].players[1]).toMatchObject({ name: 'Saindon Laurie', wins: 2, losses: 2 });
    expect(t.warnings).toContain(
      "Open Singles Group 1: W–L on the sheet doesn't match the results entered (Saindon Laurie: sheet 2–2, results 2–1)",
    );
  });

  it('shows a match being entered as live until someone has 3 games (best of 5)', () => {
    const wb = clone(wb1009);
    const g = wb.sheets['Open_Singles'];
    put(g, 'T2', '2-1');
    put(g, 'X2', null); // games so far: 11-7, 8-11, 11-2
    const t = build(wb);
    const g1 = t.events[0].groups[0];
    expect(g1.matches[0]).toMatchObject({ aSets: 2, bSets: 1, winner: null, live: true });
    expect(g1.matches[0].games).toHaveLength(3);
    // The sheet's standings count the leader already, so W–L still agree: no warning.
    expect(t.warnings).toEqual(['Beginners: "John Doe" is not on the ranking list']);

    const fresh = clone(wb1009);
    clearSerpentineResults(fresh.sheets['Open_Singles']);
    put(fresh.sheets['Open_Singles'], 'T2', '2-0');
    expect(build(fresh).events[0].groups[0].matches[0]).toMatchObject({ winner: null, live: true });
  });
});

describe('ITTF order', () => {
  const p = (name: string, groupSeed: number): GroupPlayer => ({
    name, seed: null, groupSeed, province: '', gender: '', rating: null, wins: 0, losses: 0, points: null, rank: 0,
  });
  const m = (a: string, b: string, aSets: number, bSets: number): GroupMatch => ({
    order: 0, a, b, aSets, bSets, games: [], winner: aSets > bSets ? a : b,
  });
  const players = [p('A', 1), p('B', 2), p('C', 3), p('D', 4)];

  it('breaks a three-way tie on games between the tied players', () => {
    // A beat B, B beat C, C beat A; everyone beat D.
    const matches = [m('A', 'B', 3, 0), m('B', 'C', 3, 1), m('C', 'A', 3, 2), m('A', 'D', 3, 0), m('B', 'D', 3, 0), m('C', 'D', 3, 0)];
    // Games among A, B, C: A 5–3, C 4–5, B 3–4.
    expect(ittfOrder(players, matches)).toEqual(['A', 'C', 'B', 'D']);
  });

  it('breaks a two-way tie on the match between them, and keeps seed order with no results', () => {
    const matches = [m('A', 'B', 0, 3), m('C', 'D', 3, 0), m('A', 'C', 3, 0), m('B', 'D', 0, 3), m('A', 'D', 3, 0), m('B', 'C', 3, 0)];
    // A and B both 2–1 (B beat A); C and D both 1–2 (C beat D).
    expect(ittfOrder(players, matches)).toEqual(['B', 'A', 'C', 'D']);
    expect(ittfOrder(players, [])).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('event tabs', () => {
  const rankings = (wb1009 as unknown as Workbook).sheets['Canada_Rankings'];

  it('publishes a doubles tab with registered teams, before any draw', () => {
    // Tournament Tools reads one name column, so a team is written "Name / Name" in it.
    const doubles: Grid = [
      ['Name', 'Province', 'Gender', 'Rating', 'Group_Stage_Bye'],
      ['Lehmann Matthew / ZHANG Tian-Terry', 'MB', 'M', 5369, false],
      ['Bernales Raul / Somebody New', 'MB', 'M', 1500, false],
      [null, null, null, null, false],
    ];
    const t = build({ title: 'x', sheets: { Canada_Rankings: rankings, Open_Doubles: doubles } });
    expect(t.events.map((e) => [e.id, e.roster.map((r) => r.name), e.groups.length, e.brackets.length, e.drawBy])).toEqual([
      ['open-doubles', ['Lehmann Matthew / ZHANG Tian-Terry', 'Bernales Raul / Somebody New'], 0, 0, 'single'],
    ]);
    expect(t.players['Lehmann Matthew / ZHANG Tian-Terry']).toMatchObject({ rating: 5369, listRank: null });
    expect(t.warnings).toEqual(['Open Doubles: "Somebody New" is not on the ranking list']);
  });

  it('finds player list columns the way Tournament Tools does', () => {
    const wb = clone(wb1009);
    const b = wb.sheets['Beginners'];
    b[0][0] = 'Player Name';
    b[0][1] = 'Club';
    b[0][2] = 'Sex';
    b[0][4] = 'Skip Groups';
    const t = build(wb);
    const beg = t.events.find((e) => e.id === 'beginners')!;
    expect(beg.roster[0]).toEqual({ name: 'Dupuis Felix', province: 'MB', gender: 'M', rating: 126, bye: true });
    expect(beg.byes).toEqual(['Dupuis Felix']);
    expect(beg).toEqual(build(wb1009 as unknown as Workbook).events.find((e) => e.id === 'beginners'));
  });

  it('keeps "&" as part of a single name', () => {
    const singles: Grid = [
      ['Name', 'Province', 'Gender', 'Rating', 'Group_Stage_Bye'],
      ['Doe & Sons', 'MB', 'M', 900, false],
    ];
    const t = build({ title: 'x', sheets: { Canada_Rankings: rankings, Novice: singles } });
    expect(t.warnings).toEqual(['Novice: "Doe & Sons" is not on the ranking list']);
  });

  it('leaves out a tab it cannot read, with a warning, and still shows the others', () => {
    const boom = new Proxy([['Name', 'Province', 'Gender', 'Rating', 'Group_Stage_Bye'], ['X', 'MB', 'M', 1, false]] as Grid, {
      get(target, key) {
        if (key === '1') throw new Error('bad cell');
        return Reflect.get(target, key);
      },
    });
    const t = build({ title: 'x', sheets: { Canada_Rankings: rankings, Broken: boom, Club_Open: v5Tab() } });
    expect(t.events.map((e) => e.id)).toEqual(['club-open']);
    expect(t.warnings).toEqual(['Broken: couldn\'t be read (bad cell)']);
  });

  it('does not take other tabs that list names for events', () => {
    const notes: Grid = [['Name', 'Phone'], ['Someone', '555-0100']];
    const schedule: Grid = [['Time', 'Table', 'Group', 'Match'], ['9:00', 1, 'Group 1', 'Seed 1 vs Seed 3'], ['9:20', 2, 'Group 2', 'Seed 2 vs Seed 4']];
    const helpers: Grid = [['Name', 'Skip lunch?', 'Shift'], ['Someone', 'yes', 'AM']];
    const t = build({ title: 'x', sheets: { Canada_Rankings: rankings, Volunteers: notes, Schedule: schedule, Helpers: helpers } });
    expect(t.events).toEqual([]);
    expect(t.warnings).toEqual([]);
  });
});

describe('cells and tabs', () => {
  it('parses set and game scores in every form', () => {
    expect(parseSets('3-1')).toEqual([3, 1]);
    expect(parseSets('11-7')).toEqual([11, 7]);
    expect(parseSets('12-10')).toEqual([12, 10]);
    expect(parseSets('2/3/2026')).toEqual([2, 3]);
    expect(parseSets('2026-03-01')).toEqual([3, 1]);
    expect(parseSets(46082)).toEqual([3, 1]);
    expect(parseSets(46333)).toEqual([11, 7]);
    expect(parseSets(null)).toBeNull();
    // Read like the sheet's ITTF_STANDINGS: the first score in the cell
    expect(parseSets('3-0 WO')).toEqual([3, 0]);
    expect(parseSets('3:1')).toEqual([3, 1]);
    expect(parseSets(' 3 - 2 ')).toEqual([3, 2]);
    expect(parseSets('3/1/2026')).toEqual([3, 1]);
    expect(parseSets('W/O')).toBeNull();
    // Typed slashes are not scores for ITTF_STANDINGS; only a date Sheets made (with a year) is.
    expect(parseSets('3/1')).toBeNull();
    expect(parseSets('11/7')).toBeNull();
  });

  it('parses quoted CSV fields and tab specs', () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n1,,3\n')).toEqual([['a', 'b, c', 'say "hi"'], ['1', null, '3']]);
    expect(parseTabs('Canada_Rankings=0, Open_Singles=123\nBad, Beginners=9')).toEqual([
      { title: 'Canada_Rankings', gid: '0' },
      { title: 'Open_Singles', gid: '123' },
      { title: 'Beginners', gid: '9' },
    ]);
  });

  it('finds tabs in the sheet HTML view', () => {
    const html = '<ul id="sheet-menu"><li id="sheet-button-0"><a href="#">Canada_Rankings</a></li><li id="sheet-button-1769566559"><a href="#">Active-4-Life</a></li></ul>';
    expect(tabsFromHtml(html)).toEqual([{ title: 'Canada_Rankings', gid: '0' }, { title: 'Active-4-Life', gid: '1769566559' }]);
    expect(tabsFromHtml('items.push({name: "Open_Singles", pageUrl: "x", gid: "1255341360",});')).toEqual([{ title: 'Open_Singles', gid: '1255341360' }]);
  });
});

describe('bracket format is decided per block', () => {
  // Build a tab whose B is a knockout and C is a round-robin (C has no "(Round-Robin)" in its title).
  const src = wb1007 as unknown as Workbook;
  const open = src.sheets['Open_Singles'];
  const a4l = src.sheets['Active-4-Life'];
  const grid = open.map((r) => r.slice());
  const bc = 32; // AG in the 10-07 layout
  const cTitle = grid.findIndex((r) => typeof r[bc] === 'string' && (r[bc] as string).startsWith('GROUP C'));
  // wipe the knockout C block and paste the round-robin block from Active-4-Life in its place
  for (let r = cTitle; r < grid.length; r += 1) grid[r] = grid[r].slice(0, bc);
  const rrStart = a4l.findIndex((r) => typeof r[bc] === 'string' && (r[bc] as string).startsWith('GROUP B'));
  a4l.slice(rrStart, rrStart + 13).forEach((row, i) => {
    const target = (grid[cTitle + i] ??= []);
    while (target.length < bc) target.push(null);
    row.slice(bc).forEach((v, j) => (target[bc + j] = v));
  });
  grid[cTitle][bc] = 'GROUP C - Division C (5 Players / 1 Group)';
  const wb: Workbook = { title: 'mix', sheets: { Canada_Rankings: src.sheets['Canada_Rankings'], Mixed: grid } };
  const mixed = build(wb).events[0];

  it('keeps B as a knockout and reads C as a round-robin from its layout', () => {
    expect(mixed.brackets.map((b) => [b.id, b.format])).toEqual([
      ['A', 'knockout'],
      ['B', 'knockout'],
      ['C', 'roundrobin'],
    ]);
    expect(mixed.brackets[2].table!.players).toHaveLength(5);
    expect(mixed.brackets[2].table!.matches).toHaveLength(10);
  });
});

describe('Tournament Tools v5 layout (one draw in G:Y, divisions from AB)', () => {
  const rankings = (wb1009 as unknown as Workbook).sheets['Canada_Rankings'];
  const tab = (opts: { drawLabel?: string } = {}) => build({ title: 'v5', sheets: { Canada_Rankings: rankings, Club_Open: v5Tab(opts) } });
  const ev = tab().events[0];

  it('reads the single draw and leaves it unnamed unless the sheet names it', () => {
    expect([ev.id, ev.draw, ev.drawBy, ev.drawName]).toEqual(['club-open', 1, 'single', null]);
    expect(tab({ drawLabel: 'Seeded Pot' }).events[0].drawName).toBe('seeded pot');
    expect(tab({ drawLabel: 'Serpentine' }).events[0].drawName).toBe('serpentine');
    expect(ev.groups.map((g) => [g.name, g.players.map((p) => p.name)])).toEqual([
      ['Group 1', ['Bekele Biruk', 'Xie Tianyu', 'Lee Alexus', 'Oyewo BJ']],
      ['Group 2', ['Tran Jeremy', 'Lu Yi Fan', 'Sepulveda Dino', 'Lee Victoria']],
    ]);
  });

  it('reads walkovers and sets left blank the way ITTF_STANDINGS does', () => {
    const [m1, wo, , blank] = ev.groups[0].matches;
    expect(m1).toMatchObject({ a: 'Bekele Biruk', b: 'Lee Alexus', aSets: 3, bSets: 1, winner: 'Bekele Biruk' });
    expect(wo).toEqual({ order: 2, a: 'Xie Tianyu', b: 'Oyewo BJ', aSets: 3, bSets: 0, games: [], winner: 'Xie Tianyu', wo: true });
    expect(blank).toMatchObject({ a: 'Xie Tianyu', b: 'Lee Alexus', aSets: 3, bSets: 1, winner: 'Xie Tianyu' });
    expect(blank.live).toBeUndefined();
    expect(ev.groups[0].players.map((p) => [p.name, p.wins, p.losses, p.points])).toEqual([
      ['Bekele Biruk', 3, 0, 6],
      ['Xie Tianyu', 2, 1, 5],
      ['Lee Alexus', 1, 2, 4],
      ['Oyewo BJ', 0, 3, 2],
    ]);
  });

  it('marks the live match and the unplayed one', () => {
    const g2 = ev.groups[1].matches;
    expect(g2[1]).toMatchObject({ a: 'Tran Jeremy', b: 'Sepulveda Dino', aSets: 2, bSets: 0, winner: null, live: true });
    expect(g2[4]).toEqual({ order: 5, a: 'Lu Yi Fan', b: 'Tran Jeremy', aSets: null, bSets: null, games: [], winner: null });
    expect(g2.filter((m) => m.winner)).toHaveLength(4);
  });

  it('has nothing to warn about: the sheet counts live and walkover results the same way', () => {
    expect(tab().warnings).toEqual([]);
  });

  it('works standings out like ITTF_STANDINGS when the formula shows Loading…', () => {
    const g = v5Tab();
    for (let r = 9; r <= 12; r += 1) for (const c of [13, 14, 15, 16]) putAt(g, r, c, null);
    putAt(g, 9, 13, 'Loading...');
    for (let r = 1; r <= 4; r += 1) for (const c of [13, 14, 15, 16]) putAt(g, r, c, null);
    putAt(g, 1, 13, '#ERROR!');
    const t = build({ title: 'v5', sheets: { Canada_Rankings: rankings, Club_Open: g } });
    const [g1, g2] = t.events[0].groups;
    expect(g1.computed && g2.computed).toBe(true);
    // Oyewo's walkover loss is worth 0 points; Tran's live 2-0 counts, as on the sheet.
    expect(g1.players.map((p) => [p.rank, p.name, p.wins, p.losses, p.points])).toEqual([
      [1, 'Bekele Biruk', 3, 0, 6],
      [2, 'Xie Tianyu', 2, 1, 5],
      [3, 'Lee Alexus', 1, 2, 4],
      [4, 'Oyewo BJ', 0, 3, 2],
    ]);
    expect(g2.players.map((p) => [p.rank, p.name, p.wins, p.losses, p.points])).toEqual([
      [1, 'Tran Jeremy', 2, 0, 4],
      [2, 'Lu Yi Fan', 2, 0, 4],
      [3, 'Sepulveda Dino', 1, 2, 4],
      [4, 'Lee Victoria', 0, 3, 3],
    ]);
  });

  it('reads the knockout with its play-off 3/4, and the division round-robin', () => {
    const [A, B] = ev.brackets;
    expect([A.id, A.format, A.size, A.players, A.champion]).toEqual(['A', 'knockout', 4, 4, 'Bekele Biruk']);
    expect(A.rounds.map((r) => r.short)).toEqual(['SF', 'Final']);
    expect(A.thirdPlace).toEqual({
      a: { name: 'Lu Yi Fan', bye: false, score: 3 },
      b: { name: 'Xie Tianyu', bye: false, score: 1 },
      winner: 'Lu Yi Fan',
    });
    expect([B.id, B.format, B.players, B.champion]).toEqual(['B', 'roundrobin', 4, null]);
    expect(B.table!.players.map((p) => [p.rank, p.name, p.points])).toEqual([
      [1, 'Lee Alexus', 2],
      [2, 'Lee Victoria', 1],
      [3, 'Sepulveda Dino', 0],
      [4, 'Oyewo BJ', 0],
    ]);
    expect(B.table!.matches[0]).toMatchObject({ a: 'Lee Alexus', b: 'Lee Victoria', aSets: 3, bSets: 0, winner: 'Lee Alexus' });
  });

  it('leaves out the play-off when a bracket has fewer than 4 players (it is only byes then)', () => {
    const g = v5Tab();
    const row = g.findIndex((r) => typeof r[27] === 'string' && (r[27] as string).startsWith('GROUP A'));
    putAt(g, row, 27, 'GROUP A - Championship Bracket (3 Players / 4-Player Bracket)');
    const A = build({ title: 'v5', sheets: { Canada_Rankings: rankings, Club_Open: g } }).events[0].brackets[0];
    expect(A.players).toBe(3);
    expect(A.thirdPlace).toBeUndefined();
  });

  it('reads the current sheet once it is moved to the v5 layout', () => {
    // Same results, written the v5 way: the pot draw (AB:AV) is gone and the brackets start at AB.
    const v5 = clone(wb1009);
    const ab = 27;
    const aw = 48;
    for (const name of ['Open_Singles', 'Active-4-Life', 'Beginners']) {
      v5.sheets[name] = v5.sheets[name].map((row) => [...row.slice(0, ab), ...row.slice(aw)]);
    }
    const before = build(wb1009 as unknown as Workbook).events;
    const after = build(v5).events;
    expect(after.map((e) => [e.id, e.drawBy, e.drawName])).toEqual([
      ['open-singles', 'single', null],
      ['active-4-life', 'single', null],
      ['beginners', 'single', null],
    ]);
    after.forEach((e, i) => {
      expect(e.groups).toEqual(before[i].groups);
      expect(e.brackets).toEqual(before[i].brackets);
    });
  });

  it('gives the same tournament through the CSV export', () => {
    const wb: Workbook = { title: 'v5', sheets: { Canada_Rankings: rankings, Club_Open: v5Tab({ drawLabel: 'Serpentine' }) } };
    expect(build(viaCsv(wb)).events).toEqual(build(wb).events);
  });
});

describe('Tournament Tools v7 doubles (no group stage, brackets A / B / C)', () => {
  const rankings = (wb1009 as unknown as Workbook).sheets['Canada_Rankings'];
  const doubles = (tab: Grid) => build({ title: 'x', sheets: { Canada_Rankings: rankings, Open_Doubles: tab } });
  const names = (b: Bracket) => b.rounds[0].matches.flatMap((m) => [m.a, m.b]).filter((s) => s.name).map((s) => s.name!);
  /** Teams that lost their first real match in A (byes don't count), and teams that lost in a given A round. */
  const firstLosses = (a: Bracket) => {
    const seen = new Set<string>();
    const out: string[] = [];
    a.rounds.forEach((r) =>
      r.matches.forEach((m) => {
        if (m.a.bye || m.b.bye || !m.a.name || !m.b.name) return;
        for (const s of [m.a, m.b]) {
          if (seen.has(s.name!)) continue;
          seen.add(s.name!);
          if (m.winner && m.winner !== s.name) out.push(s.name!);
        }
      }),
    );
    return out.sort();
  };
  const lostIn = (a: Bracket, ri: number) =>
    a.rounds[ri].matches.filter((m) => m.winner && !m.a.bye && !m.b.bye).map((m) => (m.winner === m.a.name ? m.b.name! : m.a.name!)).sort();

  it('publishes the teams before the brackets are drawn: no group stage, no byes, gender from the partners', () => {
    const tab = v7DoublesTab({ teams: teams(5), mode: 2 }).map((r) => (r ?? []).slice(0, 6));
    tab.push([null, null, ' / ', null, null, false]); // the team formula with both players blank
    const t = doubles(tab);
    const ev = t.events[0];
    expect(ev).toMatchObject({ id: 'open-doubles', knockoutOnly: true, teams: true, byes: [], groups: [], brackets: [] });
    expect(ev.roster.map((r) => r.name)).toEqual(teams(5).map((x) => `${x.p1} / ${x.p2}`));
    // No Gender column on the doubles tab: column C is the team name, not a gender.
    expect(ev.roster[0]).toEqual({ name: 'Lehmann Matthew / ZHANG Tian-Terry', province: 'MB', gender: '', rating: 4000, bye: false });
    expect(t.players['Lehmann Matthew / ZHANG Tian-Terry']).toMatchObject({ rating: 4000, gender: 'M', province: 'MB', listRank: null });
    expect(t.warnings).toEqual([]);
  });

  it('reads Bracket A and the Bracket B that A losers drop into, before any result', () => {
    const t = doubles(v7DoublesTab({ teams: teams(9), mode: 2 }));
    const [A, B, ...rest] = t.events[0].brackets;
    expect(rest).toEqual([]);
    expect(A).toMatchObject({ id: 'A', label: 'Championship', format: 'knockout', size: 16, players: 9, champion: null });
    expect(A.fromBracket).toBeUndefined();
    expect(A.rounds.map((r) => [r.name, r.short])).toEqual([['Round of 16', 'R16'], ['Quarterfinals', 'QF'], ['Semifinals', 'SF'], ['Final', 'Final']]);
    expect(names(A).sort()).toEqual(teams(9).map((x) => `${x.p1} / ${x.p2}`).sort());
    // Byes go to the top seeds: the top team waits for the winner of the only real first-round match.
    expect(A.rounds[0].matches[0]).toMatchObject({ a: { name: 'Lehmann Matthew / ZHANG Tian-Terry' }, b: { bye: true } });
    expect(A.thirdPlace).toMatchObject({ a: { name: null, bye: false }, b: { name: null, bye: false }, winner: null });
    // "BRACKET B (up to 5 Teams / 8-Team Bracket)": five slots fill in from A, three are byes.
    expect(B).toMatchObject({ id: 'B', label: 'Consolation', fromBracket: 'A', size: 8, players: 5, champion: null });
    const slots = B.rounds[0].matches.flatMap((m) => [m.a, m.b]);
    expect(slots.filter((s) => s.bye).length).toBe(3);
    expect(slots.filter((s) => !s.bye && !s.name).length).toBe(5);
    expect(B.thirdPlace).toBeDefined();
    expect(t.warnings).toEqual([]);
  });

  it('fills Bracket B as A is played: first-match losers drop, a bye team that wins its first match leaves a BYE', () => {
    const t = doubles(v7DoublesTab({ teams: teams(9), mode: 2, score: higherRatedWins({ A: 2 }) }));
    const [A, B] = t.events[0].brackets;
    expect(names(B).sort()).toEqual(firstLosses(A));
    expect(names(B)).not.toContain('Lehmann Matthew / ZHANG Tian-Terry');
    // The top team won its first match after the bye, so its B slot turned into a BYE: four teams left.
    expect(B.players).toBe(4);
    expect(B.rounds[0].matches.every((m) => m.a.bye || m.b.bye)).toBe(true);

    // Same draw, but the top team loses its first match: it drops to B.
    const u = doubles(v7DoublesTab({ teams: teams(9), mode: 2, score: higherRatedWins({ A: 2 }, ['A:1:0']) }));
    const [A2, B2] = u.events[0].brackets;
    expect(names(B2).sort()).toEqual(firstLosses(A2));
    expect(names(B2)).toContain('Lehmann Matthew / ZHANG Tian-Terry');
    expect(B2.players).toBe(5);
  });

  it('reads three brackets: round-1 losers drop to C, round-2 losers to B', () => {
    const t = doubles(v7DoublesTab({ teams: teams(12), mode: 3, score: higherRatedWins({ A: 2 }) }));
    const [A, B, C] = t.events[0].brackets;
    expect([A, B, C].map((b) => [b.id, b.label, b.fromBracket ?? null, b.size, b.players])).toEqual([
      ['A', 'Championship', null, 16, 12],
      ['B', 'Consolation', 'A', 4, 4],
      ['C', 'Division C', 'A', 4, 4],
    ]);
    expect(names(C).sort()).toEqual(lostIn(A, 0));
    expect(names(B).sort()).toEqual(lostIn(A, 1));
    expect(t.warnings).toEqual([]);
  });

  it('reads the champions and the play-off 3/4 once the event is complete', () => {
    const t = doubles(v7DoublesTab({ teams: teams(6), mode: 2, score: higherRatedWins() }));
    const [A, B] = t.events[0].brackets;
    expect(A.champion).toBe('Lehmann Matthew / ZHANG Tian-Terry');
    expect(A.thirdPlace?.winner).toBe('Lu Yi Fan / Tran Jeremy');
    // Both bye teams won their first match, so only the two first-round losers dropped: a final, no play-off.
    expect(B.players).toBe(2);
    expect(B.thirdPlace).toBeUndefined();
    expect(B.champion).toBe(names(B).sort((x, y) => t.players[y].rating! - t.players[x].rating!)[0]);
  });

  it('reads a doubles tab with a team still half entered as doubles', () => {
    const tab = v7DoublesTab({ teams: teams(4), mode: 2 }).map((r) => (r ?? []).slice(0, 6));
    tab.push(['Joyal Didie', null, 'Joyal Didie', 'MB', 1200, false]);
    const ev = doubles(tab).events[0];
    expect(ev).toMatchObject({ knockoutOnly: true, teams: true });
  });

  it('reads the "up to" count of a feeder bracket, also when three brackets were asked for but C had too few teams', () => {
    // 9 teams, three brackets: only one first-round match, so no C; B takes the four round-2 losers.
    const [A, B, C] = doubles(v7DoublesTab({ teams: teams(9), mode: 3 })).events[0].brackets;
    expect(C).toBeUndefined();
    expect([A.size, B.upTo, B.players]).toEqual([16, 4, 4]);
    expect(doubles(v7DoublesTab({ teams: teams(9), mode: 2 })).events[0].brackets[1].upTo).toBe(5);
  });

  it('keeps group-stage byes for doubles played with a group stage, and reads a doubles tab with a half-entered team', () => {
    // The older way: teams written "Name / Name" in a singles-style tab, with a group draw and a bye.
    const g = v5Tab();
    g[1][0] = 'Bekele Biruk / Oyewo BJ';
    g[1][4] = true;
    const ev = build({ title: 'x', sheets: { Canada_Rankings: rankings, Club_Doubles: g } }).events[0];
    expect(ev.knockoutOnly).toBe(false);
    expect(ev.byes).toEqual(['Bekele Biruk / Oyewo BJ']);

    const tab: Grid = [
      ['Name', 'Province', 'Gender', 'Rating', 'Group_Stage_Bye'],
      ['Lehmann Matthew / ZHANG Tian-Terry', 'MB', null, 5369, false],
      ['Joyal Didie', 'MB', null, 1200, false],
    ];
    expect(doubles(tab).events[0]).toMatchObject({ knockoutOnly: true, teams: true });
    // On a tab not named for doubles, one team among single names isn't enough.
    expect(build({ title: 'x', sheets: { Canada_Rankings: rankings, Novice: tab } }).events[0]).toMatchObject({ knockoutOnly: false, teams: false });
  });

  it('still reads ratings from column D when its header is not "Rating", like Tournament Tools', () => {
    const wb = clone(wb1009);
    wb.sheets['Beginners'][0][3] = 'Rtg';
    const beg = build(wb).events.find((e) => e.id === 'beginners')!;
    expect(beg.roster[0]).toMatchObject({ name: 'Dupuis Felix', rating: 126 });
  });

  it('gives the same tournament through the CSV export', () => {
    const wb: Workbook = { title: 'x', sheets: { Canada_Rankings: rankings, Open_Doubles: v7DoublesTab({ teams: teams(12), mode: 3, score: higherRatedWins({ A: 3, B: 1, C: 2 }, ['A:0:1']) }) } };
    expect(build(viaCsv(wb)).events).toEqual(build(wb).events);
  });
});
