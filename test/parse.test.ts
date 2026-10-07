import { describe, expect, it } from 'vitest';
import snapshot from './fixtures/workbook-2026-10-05.grids.json';
import latest from '../src/data/snapshot.grids.json';
import { buildTournament, fingerprint } from '../src/shared/parse';
import type { Cell, Workbook } from '../src/shared/types';
import { parseCsv } from '../src/worker/csv';
import { parseTabs, tabsFromHtml } from '../src/worker/sheets';
import { parseSets } from '../src/shared/parse';

const wb = snapshot as unknown as Workbook;
const t = buildTournament(wb, { kind: 'snapshot', label: 'test' }, new Date('2026-10-05T00:00:00Z'));
const ev = (id: string) => t.events.find((e) => e.id === id)!;

describe('workbook parsing', () => {
  it('finds the three events and the ranking list', () => {
    expect(t.events.map((e) => e.id)).toEqual(['open-singles', 'active-4-life', 'beginners']);
    expect(t.rankCount).toBe(200);
    expect(t.players['Lehmann Matthew']).toMatchObject({ rating: 2846, listRank: 1, lastPlayed: '2026-04-30', temp: false });
  });

  it('picks the group draw that feeds the brackets', () => {
    expect(ev('open-singles').draw).toBe(2);
    expect(ev('active-4-life').draw).toBe(1);
    expect(ev('beginners').draw).toBe(2);
  });

  it('reads groups, ranks and byes', () => {
    const open = ev('open-singles');
    expect(open.groups).toHaveLength(12);
    expect(open.groups.every((g) => g.players.length === 4)).toBe(true);
    expect(open.byes).toEqual(['Lehmann Matthew', 'ZHANG Tian-Terry', 'YAN Steven']);
    expect(open.groups[0].players.map((p) => [p.name, p.wins, p.losses, p.rank])).toEqual([
      ['Oyewo BJ', 3, 0, 1],
      ['Palad Dilbert', 2, 1, 2],
      ['Sirotina Polina', 1, 2, 3],
      ['Bernales Raul', 0, 3, 4],
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
    const a4l = ev('active-4-life');
    const A = a4l.brackets[0];
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
    const again = buildTournament(wb, { kind: 'snapshot', label: 'test' }, new Date('2030-01-01T00:00:00Z'));
    expect(fingerprint(again)).toBe(fingerprint(t));
  });
});

describe('CSV source', () => {
  const toCsv = (v: Cell) => {
    if (v === null) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  it('produces the same tournament as the API path', () => {
    const sheets: Workbook['sheets'] = {};
    for (const [name, grid] of Object.entries(wb.sheets)) {
      const csv = grid.map((row) => row.map(toCsv).join(',')).join('\r\n');
      sheets[name] = parseCsv(csv);
    }
    // CSV exports show dates as text; mimic that for the ranking list.
    const rank = sheets['Canada_Rankings'];
    const col = rank[0].indexOf('Last Played');
    for (let r = 1; r < rank.length; r += 1) {
      const v = Number(rank[r][col]);
      if (v) {
        const d = new Date(Math.round((v - 25569) * 86400000));
        rank[r][col] = `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
      }
    }
    const viaCsv = buildTournament({ title: 'csv', sheets }, { kind: 'snapshot', label: 'test' }, new Date('2026-10-05T00:00:00Z'));
    expect(viaCsv.events).toEqual(t.events);
    expect(viaCsv.players).toEqual(t.players);
  });

  it('parses quoted fields and tab specs', () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n1,,3\n')).toEqual([['a', 'b, c', 'say "hi"'], ['1', null, '3']]);
    expect(parseTabs('Canada_Rankings=0, Open_Singles=123\nBad, Beginners=9')).toEqual([
      { title: 'Canada_Rankings', gid: '0' },
      { title: 'Open_Singles', gid: '123' },
      { title: 'Beginners', gid: '9' },
    ]);
  });
});

describe('2026-10-07 workbook (match results, round-robin, empty tabs)', () => {
  const t2 = buildTournament(latest as unknown as Workbook, { kind: 'snapshot', label: 'test' });
  const e2 = (id: string) => t2.events.find((e) => e.id === id)!;

  it('skips event tabs with no registered players', () => {
    expect(t2.events.map((e) => e.id)).toEqual(['open-singles', 'active-4-life', 'beginners']);
  });

  it('reads group match results, including sets the sheet turned into dates', () => {
    const g1 = e2('open-singles').groups[0];
    expect(g1.matches).toHaveLength(6);
    expect(g1.matches[0]).toEqual({ order: 1, a: 'Bekele Biruk', b: 'Palad Dilbert', aSets: 3, bSets: 2, winner: 'Bekele Biruk' });
    expect(g1.matches[3]).toMatchObject({ a: 'Saindon Laurie', b: 'Palad Dilbert', aSets: 3, bSets: 0 });
  });

  it('reads round-robin brackets', () => {
    const B = e2('active-4-life').brackets[1];
    expect(B).toMatchObject({ id: 'B', label: 'Consolation', format: 'roundrobin', players: 5, champion: 'Caguioa Czar' });
    expect(B.table!.matches).toHaveLength(10);
    const pending = e2('beginners').brackets[1];
    expect(pending.champion).toBeNull();
    expect(pending.table!.matches.every((m) => m.aSets === null)).toBe(true);
  });

  it('strips "Bracket" from labels and keeps knockout brackets intact', () => {
    expect(e2('open-singles').brackets.map((b) => [b.id, b.label, b.format, b.champion])).toEqual([
      ['A', 'Championship', 'knockout', 'Lehmann Matthew'],
      ['B', 'Consolation', 'knockout', 'Liu Rhea'],
      ['C', 'Division C', 'knockout', null],
    ]);
  });

  it('parses set scores in every form', () => {
    expect(parseSets('3-1')).toEqual([3, 1]);
    expect(parseSets('2/3/2026')).toEqual([2, 3]);
    expect(parseSets('2026-03-01')).toEqual([3, 1]);
    expect(parseSets(46082)).toEqual([3, 1]);
    expect(parseSets(null)).toBeNull();
  });

  it('finds tabs in the sheet HTML view', () => {
    const html = '<ul id="sheet-menu"><li id="sheet-button-0"><a href="#">Canada_Rankings</a></li><li id="sheet-button-1769566559"><a href="#">Active-4-Life</a></li></ul>';
    expect(tabsFromHtml(html)).toEqual([{ title: 'Canada_Rankings', gid: '0' }, { title: 'Active-4-Life', gid: '1769566559' }]);
    expect(tabsFromHtml('items.push({name: "Open_Singles", pageUrl: "x", gid: "1255341360",});')).toEqual([{ title: 'Open_Singles', gid: '1255341360' }]);
  });
});
