/**
 * Builds an event tab laid out exactly like Tournament Tools v5 (the sheet's
 * Apps Script) writes it, with the values its formulas would show:
 *
 * - Player list in A:E.
 * - One group draw in G:Y. The header row repeats above every group; W/L/Pts/Rank
 *   are what ITTF_STANDINGS returns (it counts any unequal score, live or not).
 * - Knockout and division round-robins from AB, with the Play-off 3/4 under
 *   each knockout bracket.
 *
 * The event: 8 players, two groups of 4.
 * - Group 1 is complete. It has a walkover ("3-0 WO") and one match whose Sets
 *   cell is blank but whose games are entered.
 * - Group 2 has a live match ("2-0", two games in) and one match not played.
 * - Division A is a 4-player knockout with a play-off 3/4.
 * - Division B is a 4-player round-robin with one result in.
 */
import type { Cell, Grid } from '../src/shared/types';

const col = (letters: string) => letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export function put(g: Grid, row: number, c: number, v: Cell) {
  const r = (g[row] ??= []);
  while (r.length <= c) r.push(null);
  r[c] = v;
}

type P = [name: string, rating: number];
const ROSTER: P[] = [
  ['Bekele Biruk', 2020],
  ['Lu Yi Fan', 2020],
  ['Tran Jeremy', 1851],
  ['Xie Tianyu', 1845],
  ['Lee Alexus', 1820],
  ['Lee Victoria', 1810],
  ['Sepulveda Dino', 1710],
  ['Oyewo BJ', 1526],
];

interface GroupSpec {
  name: string;
  /** [name, event seed, rating, W, L, Pts, Rank] in group-seed order. */
  players: [string, number, number, number, number, number, number][];
  /** Sets cell and game cells for each match, in Tournament Tools' order for 4 players. */
  results: [Cell, string[]][];
}

const SCHEDULE_4 = [[1, 3], [2, 4], [1, 4], [2, 3], [1, 2], [3, 4]];

const GROUPS: GroupSpec[] = [
  {
    name: 'Group 1',
    players: [
      ['Bekele Biruk', 1, 2020, 3, 0, 6, 1],
      ['Xie Tianyu', 4, 1845, 2, 1, 5, 2],
      ['Lee Alexus', 5, 1820, 1, 2, 4, 3],
      ['Oyewo BJ', 8, 1526, 0, 3, 2, 4],
    ],
    results: [
      ['3-1', ['11-7', '9-11', '11-5', '11-8']], // Bekele beats Lee A
      ['3-0 WO', []], // Xie beats Oyewo by walkover: Oyewo gets 0 points
      ['3-0', ['11-3', '11-4', '11-6']], // Bekele beats Oyewo
      [null, ['11-9', '8-11', '11-7', '11-9']], // Xie beats Lee A, Sets left blank
      ['3-2', ['11-9', '9-11', '11-8', '7-11', '11-6']], // Bekele beats Xie
      ['3-1', ['11-5', '11-7', '9-11', '11-4']], // Lee A beats Oyewo
    ],
  },
  {
    name: 'Group 2',
    // The sheet counts Tran's live 2-0 as a win: Tran, Lu and Sepulveda tie on 4 points,
    // and games ratio between them puts Tran (2-0) ahead of Lu (3-1) and Sepulveda.
    players: [
      ['Lu Yi Fan', 2, 2020, 2, 0, 4, 2],
      ['Tran Jeremy', 3, 1851, 2, 0, 4, 1],
      ['Lee Victoria', 6, 1810, 0, 3, 3, 4],
      ['Sepulveda Dino', 7, 1710, 1, 2, 4, 3],
    ],
    results: [
      ['3-0', ['11-6', '11-8', '11-9']], // Lu beats Lee V
      ['2-0', ['11-8', '11-6']], // Tran leads Sepulveda: live
      ['3-1', ['11-9', '9-11', '11-5', '11-7']], // Lu beats Sepulveda
      ['3-2', ['11-9', '7-11', '11-8', '9-11', '11-9']], // Tran beats Lee V
      [null, []], // Lu v Tran not played
      ['1-3', ['9-11', '11-8', '7-11', '6-11']], // Sepulveda beats Lee V
    ],
  },
];

const entry = (name: string, rating: number, group: string) => `${name} (${rating}) (${group})`;

export function v5Tab(opts: { drawLabel?: string } = {}): Grid {
  const g: Grid = [];
  // Player list
  ['Name', 'Province', 'Gender', 'Rating', 'Group_Stage_Bye'].forEach((h, c) => put(g, 0, c, h));
  ROSTER.forEach(([name, rating], i) => {
    put(g, i + 1, 0, name);
    put(g, i + 1, 1, 'MB');
    put(g, i + 1, 2, 'M');
    put(g, i + 1, 3, rating);
    put(g, i + 1, 4, false);
  });

  // Group stage in G:Y
  const G = col('G');
  const playerHeaders = ['Group', 'Event Seed', 'Group Seed', 'Name', 'Province', 'Gender', 'Rating', 'W', 'L', 'Pts', 'Rank'];
  const matchHeaders = ['Match', 'Sets', 'G1', 'G2', 'G3', 'G4', 'G5'];
  let first = 1; // 0-based row of a group's first player
  for (const grp of GROUPS) {
    const header = first - 1;
    playerHeaders.forEach((h, k) => put(g, header, G + k, h));
    matchHeaders.forEach((h, k) => put(g, header, G + 12 + k, h));
    grp.players.forEach(([name, seed, rating, w, l, pts, rank], i) => {
      [grp.name, seed, i + 1, name, 'MB', 'M', rating, w, l, pts, rank].forEach((v, k) => put(g, first + i, G + k, v));
    });
    SCHEDULE_4.forEach(([a, b], i) => {
      put(g, first + i, G + 12, `Seed ${a} vs Seed ${b}`);
      const [sets, games] = grp.results[i];
      put(g, first + i, G + 13, sets);
      games.forEach((x, k) => put(g, first + i, G + 14 + k, x));
    });
    // Next group's players start 3 rows after the last match row (Tournament Tools' spacing).
    first = first + Math.max(grp.players.length, SCHEDULE_4.length) - 1 + 3;
  }
  if (opts.drawLabel) put(g, 0, G + 11, opts.drawLabel);

  // Division A: 4-player knockout from AB
  const AB = col('AB');
  let t = 1; // title row (Tournament Tools starts at row 2)
  put(g, t, AB, 'GROUP A - Championship Bracket (4 Players / 4-Player Bracket)');
  ['Semifinals', 'Score', null, 'Finals', 'Score', null, 'Champion'].forEach((h, k) => put(g, t + 1, AB + k, h));
  const fr = t + 2;
  const sf: [string, number, string, number][] = [
    ['Bekele Biruk', 2020, 'Group 1', 3],
    ['Lu Yi Fan', 2020, 'Group 2', 1],
    ['Xie Tianyu', 1845, 'Group 1', 2],
    ['Tran Jeremy', 1851, 'Group 2', 3],
  ];
  sf.forEach(([n, r, grp, score], j) => {
    put(g, fr + 2 * j, AB, entry(n, r, grp));
    put(g, fr + 2 * j, AB + 1, score);
  });
  put(g, fr + 1, AB + 3, entry('Bekele Biruk', 2020, 'Group 1'));
  put(g, fr + 1, AB + 4, 3);
  put(g, fr + 5, AB + 3, entry('Tran Jeremy', 1851, 'Group 2'));
  put(g, fr + 5, AB + 4, 1);
  put(g, fr + 3, AB + 6, entry('Bekele Biruk', 2020, 'Group 1'));
  // Play-off 3/4: title 2N + 1 rows below the first player row
  const po = fr + 2 * 4 + 1;
  put(g, po, AB, 'Division A - Play-off 3/4');
  put(g, po + 1, AB, 'Semifinal Losers');
  put(g, po + 1, AB + 1, 'Score');
  put(g, po + 1, AB + 3, '3rd Place');
  put(g, po + 2, AB, entry('Lu Yi Fan', 2020, 'Group 2'));
  put(g, po + 2, AB + 1, 3);
  put(g, po + 4, AB, entry('Xie Tianyu', 1845, 'Group 1'));
  put(g, po + 4, AB + 1, 1);
  put(g, po + 3, AB + 3, entry('Lu Yi Fan', 2020, 'Group 2'));

  // Division B: 4-player round-robin, next title 5 rows below the 3rd-place cell
  t = po + 3 + 5;
  put(g, t, AB, 'GROUP B - Consolation (Round-Robin) (4 Players / 1 Group)');
  const hr = t + 2;
  ['Div B - Round-Robin', 'Seed', 'W', 'L', 'Pts', 'Rank', null, 'Match', 'Sets', 'G1', 'G2', 'G3', 'G4', 'G5'].forEach((h, k) => put(g, hr, AB + k, h));
  const rr: [string, number, string, number, number, number, number][] = [
    ['Lee Alexus', 1820, 'Group 1', 1, 0, 2, 1],
    ['Sepulveda Dino', 1710, 'Group 2', 0, 0, 0, 3],
    ['Lee Victoria', 1810, 'Group 2', 0, 1, 1, 2],
    ['Oyewo BJ', 1526, 'Group 1', 0, 0, 0, 4],
  ];
  rr.forEach(([n, r, grp, w, l, pts, rank], i) => {
    [entry(n, r, grp), i + 1, w, l, pts, rank].forEach((v, k) => put(g, hr + 1 + i, AB + k, v));
  });
  SCHEDULE_4.forEach(([a, b], i) => put(g, hr + 1 + i, AB + 7, `Seed ${a} vs Seed ${b}`));
  put(g, hr + 1, AB + 8, '3-0');
  ['11-2', '11-3', '11-4'].forEach((x, k) => put(g, hr + 1, AB + 9 + k, x));
  return g;
}
