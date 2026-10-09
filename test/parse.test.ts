import { describe, expect, it } from 'vitest';
import wb1005 from './fixtures/workbook-2026-10-05.grids.json';
import wb1007 from './fixtures/workbook-2026-10-07.grids.json';
import wb1009 from './fixtures/workbook-2026-10-09.grids.json';
import snapshot from '../src/data/snapshot.grids.json';
import { buildTournament, fingerprint, ittfOrder, parseSets } from '../src/shared/parse';
import type { Cell, Grid, GroupMatch, GroupPlayer, Workbook } from '../src/shared/types';
import { parseCsv } from '../src/worker/csv';
import { parseTabs, tabsFromHtml } from '../src/worker/sheets';

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

  it('reads an event played best of three', () => {
    const wb = clone(wb1009);
    const g = wb.sheets['Active-4-Life'];
    // Every result in the event becomes best of three: 3-0 -> 2-0, 3-1 / 3-2 -> 2-1, and so on.
    const bo3 = (v: Cell) => {
      const m = typeof v === 'string' ? /^(\d)-(\d)$/.exec(v) : null;
      if (!m) return v;
      const [a, b] = [Number(m[1]), Number(m[2])];
      return a > b ? `2-${Math.min(b, 1)}` : `${Math.min(a, 1)}-2`;
    };
    g.forEach((row) => row.forEach((v, c) => (row[c] = bo3(v))));
    const before = build(wb1009 as unknown as Workbook).events[1];
    const after = build(wb).events[1];
    expect(after.groups[0].matches.map((m) => [m.aSets, m.bSets, m.winner])).toEqual([
      [2, 0, 'Sepulveda Dino'],
      [2, 1, 'Raymundo Irwin'],
      [2, 1, 'Sepulveda Dino'],
    ]);
    expect(after.groups.flatMap((gr) => gr.matches.map((m) => m.winner))).toEqual(before.groups.flatMap((gr) => gr.matches.map((m) => m.winner)));
    expect(after.brackets[1].champion).toBe('Zahedi Hamid');
  });

  it('does not take a half-entered best-of-five match for a result', () => {
    const wb = clone(wb1009);
    put(wb.sheets['Open_Singles'], 'T2', '2-0');
    const g1 = build(wb).events[0].groups[0];
    expect(g1.matches[0]).toMatchObject({ aSets: 2, bSets: 0, winner: null });

    const fresh = clone(wb1009);
    clearSerpentineResults(fresh.sheets['Open_Singles']);
    put(fresh.sheets['Open_Singles'], 'T2', '2-0');
    expect(build(fresh).events[0].groups[0].matches[0].winner).toBeNull();
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
    const doubles: Grid = [
      ['Name', 'Partner', 'Province', 'Gender', 'Rating', 'Group_Stage_Bye'],
      ['Lehmann Matthew', 'ZHANG Tian-Terry', 'MB', 'M', 5369, false],
      ['Bernales Raul', 'Somebody New', 'MB', 'M', 1500, false],
      [null, null, null, null, null, false],
    ];
    const oneCell: Grid = [
      ['Name', 'Province', 'Gender', 'Rating', 'Group_Stage_Bye'],
      ['Oyewo BJ / Palad Dilbert', 'MB', 'M', 2501, false],
    ];
    const t = build({ title: 'x', sheets: { Canada_Rankings: rankings, Open_Doubles: doubles, Mixed_Doubles: oneCell } });
    expect(t.events.map((e) => [e.id, e.roster.map((r) => r.name), e.groups.length, e.brackets.length])).toEqual([
      ['open-doubles', ['Lehmann Matthew / ZHANG Tian-Terry', 'Bernales Raul / Somebody New'], 0, 0],
      ['mixed-doubles', ['Oyewo BJ / Palad Dilbert'], 0, 0],
    ]);
    expect(t.players['Lehmann Matthew / ZHANG Tian-Terry']).toMatchObject({ rating: 5369, listRank: null });
    expect(t.warnings).toEqual(['Open Doubles: "Somebody New" is not on the ranking list']);
  });

  it('keeps "&" as part of a single name', () => {
    const singles: Grid = [
      ['Name', 'Province', 'Gender', 'Rating', 'Group_Stage_Bye'],
      ['Doe & Sons', 'MB', 'M', 900, false],
    ];
    const t = build({ title: 'x', sheets: { Canada_Rankings: rankings, Novice: singles } });
    expect(t.warnings).toEqual(['Novice: "Doe & Sons" is not on the ranking list']);
  });

  it('does not take other tabs that list names for events', () => {
    const notes: Grid = [['Name', 'Phone'], ['Someone', '555-0100']];
    const t = build({ title: 'x', sheets: { Canada_Rankings: rankings, Volunteers: notes } });
    expect(t.events).toEqual([]);
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
