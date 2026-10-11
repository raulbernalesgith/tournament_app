/**
 * Builds an Open Doubles tab exactly as Tournament Tools v7's "Run Doubles
 * Brackets" writes it, with the values its formulas would show:
 *
 * - Player list: Player 1 | Player 2 | Name (the team, "P1 / P2") | Province |
 *   Rating (the pair's sum) | Group_Stage_Bye (ignored for doubles).
 * - No group stage. Bracket A from AB2 with every team in it, seeded by rating
 *   with BYEs for the top seeds (getSeedTiers / filledSlots / placeInBracket).
 * - Mode 2: teams that lose their first match in A drop to Bracket B (a team
 *   with a round-1 BYE drops only if it loses round 2; otherwise its B slot
 *   shows "BYE"). Mode 3: round-1 losers drop to C, round-2 losers to B.
 * - A feeder bracket's round-1 slots are formulas: empty until the A result is
 *   in, then the team's label (or "BYE").
 * - Each bracket has its "Bracket X - Play-off 3/4" block underneath.
 *
 * The bracket functions below are ported line for line from the script.
 */
import type { Grid } from '../src/shared/types';
import { put } from './v5';

/* ---------- Ported from Tournament Tools v7 ---------- */

export function getSeedTiers(N: number): number[][] {
  const tiers = [[0], [N - 1]];
  const used = new Set([0, N - 1]);
  for (let L = N / 2; L >= 2; L /= 2) {
    const tier: number[] = [];
    for (let start = 0; start < N; start += L) {
      [start, start + L - 1].forEach((s) => {
        if (!used.has(s)) {
          used.add(s);
          tier.push(s);
        }
      });
    }
    tier.sort((a, b) => a - b);
    if (tier.length) tiers.push(tier);
  }
  return tiers;
}

function meetBlock(a: number, b: number) {
  const x = a ^ b;
  let blk = 1;
  while (blk <= x) blk <<= 1;
  return blk;
}

export function bitReverse(x: number, N: number) {
  let r = 0;
  for (let bit = 1; bit < N; bit <<= 1) {
    r = (r << 1) | (x & 1);
    x >>= 1;
  }
  return r;
}

export function filledSlots(N: number, n: number): Set<number> {
  const tiers = getSeedTiers(N);
  const tierOf: Record<number, number> = {};
  tiers.forEach((t, i) => t.forEach((s) => (tierOf[s] = i)));
  const filled = new Set<number>();
  let count = 0;
  for (const tier of tiers) {
    if (count >= n) break;
    const need = Math.min(tier.length, n - count);
    const ordered = tier.slice().sort((a, b) => tierOf[b ^ 1] - tierOf[a ^ 1] || bitReverse(a, N) - bitReverse(b, N));
    ordered.slice(0, need).forEach((s) => filled.add(s));
    count += need;
  }
  return filled;
}

interface Entry {
  name: string;
  group: string;
  province: string;
  rating: number;
  groupRank: number;
  eventSeed: number;
  isBye?: boolean;
}

const provinceSet = (p: Entry) =>
  String(p.province || '')
    .toLowerCase()
    .split(/[/,&+]/)
    .map((x) => x.trim())
    .filter(Boolean);
const sameProvince = (a: Entry, b: Entry) => {
  const pb = provinceSet(b);
  return provinceSet(a).some((x) => pb.indexOf(x) >= 0);
};
function knockoutPenalty(a: Entry, b: Entry) {
  let s = 0;
  if (a.group && a.group === b.group && a.group !== 'Stage 1 Bye') s += 1000;
  if (sameProvince(a, b)) s += 10;
  return s;
}

function placeInBracket(players: Entry[], N: number): Entry[] {
  const tiers = getSeedTiers(N);
  const filled = filledSlots(N, players.length);
  const classes: { slots: number[]; players: Entry[] }[] = [];
  let idx = 0;
  tiers.forEach((tier) => {
    const slots = tier.filter((s) => filled.has(s));
    if (!slots.length) return;
    const chunk = players.slice(idx, idx + slots.length);
    idx += slots.length;
    const byeSlots = slots.filter((s) => !filled.has(s ^ 1));
    const normalSlots = slots.filter((s) => filled.has(s ^ 1));
    if (byeSlots.length) classes.push({ slots: byeSlots, players: chunk.slice(0, byeSlots.length) });
    if (normalSlots.length) classes.push({ slots: normalSlots, players: chunk.slice(byeSlots.length) });
  });
  const slotOf = new Map<Entry, number>();
  const placed: Entry[] = [];
  const costAt = (p: Entry, slot: number, exclude: Entry | null) =>
    placed.reduce((s, q) => {
      if (q === p || q === exclude) return s;
      const pen = knockoutPenalty(p, q);
      return pen ? s + pen * (N / meetBlock(slot, slotOf.get(q)!)) : s;
    }, 0);
  classes.forEach((cls) => {
    const free = cls.slots.slice();
    cls.players.forEach((p) => {
      let best = 0;
      let bestCost = Infinity;
      free.forEach((s, i) => {
        const c = costAt(p, s, null);
        if (c < bestCost) {
          bestCost = c;
          best = i;
        }
      });
      slotOf.set(p, free.splice(best, 1)[0]);
      placed.push(p);
    });
  });
  for (let pass = 0; pass < 30; pass++) {
    let improved = false;
    classes.forEach((cls) => {
      for (let i = 0; i < cls.players.length; i++) {
        for (let j = i + 1; j < cls.players.length; j++) {
          const p = cls.players[i];
          const q = cls.players[j];
          const sp = slotOf.get(p)!;
          const sq = slotOf.get(q)!;
          const before = costAt(p, sp, q) + costAt(q, sq, p);
          const after = costAt(p, sq, q) + costAt(q, sp, p);
          if (after < before) {
            slotOf.set(p, sq);
            slotOf.set(q, sp);
            improved = true;
          }
        }
      }
    });
    if (!improved) break;
  }
  const slots: (Entry | null)[] = new Array(N).fill(null);
  players.forEach((p) => (slots[slotOf.get(p)!] = p));
  return slots.map((s) => s ?? { name: 'BYE', group: '', province: '', rating: 0, groupRank: 0, eventSeed: 0, isBye: true });
}

function roundTitle(playersInRound: number) {
  if (playersInRound === 2) return 'Finals';
  if (playersInRound === 4) return 'Semifinals';
  if (playersInRound === 8) return 'Quarterfinals';
  return `Round of ${playersInRound}`;
}

type RC = [row: number, col: number];
interface GeoMatch {
  p1: RC;
  s1: RC;
  p2: RC;
  s2: RC;
  target: number;
}

/** 1-based cell positions, as the script's bracketGeometry. */
function bracketGeometry(firstRow: number, startCol: number, N: number) {
  const rounds: GeoMatch[][] = [];
  const r1: GeoMatch[] = [];
  for (let k = 0; k < N / 2; k++) {
    const row = firstRow + 4 * k;
    r1.push({ p1: [row, startCol], s1: [row, startCol + 1], p2: [row + 2, startCol], s2: [row + 2, startCol + 1], target: row + 1 });
  }
  rounds.push(r1);
  let prev = r1;
  let col = startCol + 3;
  while (prev.length > 1) {
    const next: GeoMatch[] = [];
    for (let m = 0; m < prev.length; m += 2) {
      const A = prev[m];
      const B = prev[m + 1];
      next.push({ p1: [A.target, col], s1: [A.target, col + 1], p2: [B.target, col], s2: [B.target, col + 1], target: Math.floor((A.target + B.target) / 2) });
    }
    rounds.push(next);
    prev = next;
    col += 3;
  }
  const top = firstRow + 2 * N + 1;
  const playoff = { titleRow: top, headerRow: top + 1, p1: [top + 2, startCol] as RC, s1: [top + 2, startCol + 1] as RC, p2: [top + 4, startCol] as RC, s2: [top + 4, startCol + 1] as RC, winner: [top + 3, startCol + 3] as RC };
  return { rounds, champion: [prev[0].target, col] as RC, playoff };
}

/* ---------- The formulas, evaluated ---------- */

type V = string | number; // what a cell shows ("" = empty)

/** advanceFormula: who moves on from a match. */
function advance(p1: V, p2: V, s1: V, s2: V): V {
  if (p1 === 'BYE' && p2 === 'BYE') return 'BYE';
  if (p1 === 'BYE') return p2;
  if (p2 === 'BYE') return p1;
  if (p1 === '' || p2 === '') return '';
  if (s1 === '' || s2 === '' || s1 === s2) return '';
  return Number(s1) > Number(s2) ? p1 : p2;
}

/** loserFormula: the loser of a match, once the next round shows its winner. */
function loser(p1: V, p2: V, w: V): V {
  if (w === '' || w === 'BYE') return '';
  return w === p1 ? p2 : p1;
}

/* ---------- The generator ---------- */

export interface Team {
  p1: string;
  p2: string;
  province: string;
  rating: number;
}

/** Score for a match (the games each side won), or null when it hasn't been played. */
export type ScoreFn = (bracket: string, round: number, match: number, p1: string, p2: string) => [number, number] | null;

export interface V7Options {
  teams: Team[];
  mode: 2 | 3;
  score?: ScoreFn;
}

/** Plays every match it can: the higher-rated team wins 3–1 (rating read from the label). */
export const higherRatedWins = (played: Record<string, number> = {}, upsets: string[] = []): ScoreFn => (bracket, round, match, p1, p2) => {
  if (round >= (played[bracket] ?? 99)) return null;
  const r = (label: string) => Number(/\((\d+)\)$/.exec(label)?.[1] ?? 0);
  let firstWins = r(p1) >= r(p2);
  if (upsets.includes(`${bracket}:${round}:${match}`)) firstWins = !firstWins;
  return firstWins ? [3, 1] : [1, 3];
};

interface Built {
  /** Round-by-round cell values: entries, scores, winners. */
  rounds: { p1: V; p2: V; s1: V; s2: V }[][];
  champion: V;
  nextRow: number;
}

const label = (e: Entry) => `${e.name} (${e.rating})`;

export function v7DoublesTab(opts: V7Options): Grid {
  const g: Grid = [];
  const score = opts.score ?? (() => null);
  const set = (r1: number, c1: number, v: V | null) => put(g, r1 - 1, c1 - 1, v === '' ? null : v);

  ['Player 1', 'Player 2', 'Name', 'Province', 'Rating', 'Group_Stage_Bye'].forEach((h, c) => put(g, 0, c, h));
  opts.teams.forEach((t, i) => {
    [t.p1, t.p2, `${t.p1} / ${t.p2}`, t.province, t.rating, false].forEach((v, c) => put(g, i + 1, c, v));
  });

  /** Draws one bracket the way drawBracket does and evaluates its formulas. Returns the cell values. */
  const drawBracket = (id: string, title: string, slots: V[], N: number, startRow: number, startCol: number): Built => {
    const R = Math.log2(N);
    set(startRow, startCol, title);
    const firstRow = startRow + 2;
    for (let r = 0; r <= R; r++) {
      set(firstRow - 1, startCol + r * 3, r < R ? roundTitle(N / 2 ** r) : 'Champion');
      if (r < R) set(firstRow - 1, startCol + r * 3 + 1, 'Score');
    }
    const geo = bracketGeometry(firstRow, startCol, N);
    const rounds: Built['rounds'] = [];
    let entries: V[] = slots;
    geo.rounds.forEach((ms, r) => {
      const out: Built['rounds'][number] = [];
      const winners: V[] = [];
      ms.forEach((m, k) => {
        const p1 = entries[2 * k];
        const p2 = entries[2 * k + 1];
        const real = (v: V) => v !== '' && v !== 'BYE';
        const sc = real(p1) && real(p2) ? score(id, r, k, String(p1), String(p2)) : null;
        const [s1, s2]: V[] = sc ?? ['', ''];
        set(m.p1[0], m.p1[1], p1);
        set(m.p2[0], m.p2[1], p2);
        set(m.s1[0], m.s1[1], s1);
        set(m.s2[0], m.s2[1], s2);
        out.push({ p1, p2, s1, s2 });
        winners.push(advance(p1, p2, s1, s2));
      });
      rounds.push(out);
      entries = winners;
    });
    const champion = entries[0];
    set(geo.champion[0], geo.champion[1], champion);
    // Play-off 3/4: the semifinal losers (their winners are the two Finals cells)
    const semis = rounds[R - 2];
    const F = rounds[R - 1][0];
    const po = geo.playoff;
    set(po.titleRow, startCol, `Bracket ${id} - Play-off 3/4`);
    set(po.headerRow, startCol, 'Semifinal Losers');
    set(po.headerRow, startCol + 1, 'Score');
    set(po.headerRow, startCol + 3, '3rd Place');
    const q1 = loser(semis[0].p1, semis[0].p2, F.p1);
    const q2 = loser(semis[1].p1, semis[1].p2, F.p2);
    const real = (v: V) => v !== '' && v !== 'BYE';
    const sc = real(q1) && real(q2) ? score(id, R, 0, String(q1), String(q2)) : null;
    const [t1, t2]: V[] = sc ?? ['', ''];
    set(po.p1[0], po.p1[1], q1);
    set(po.p2[0], po.p2[1], q2);
    set(po.s1[0], po.s1[1], t1);
    set(po.s2[0], po.s2[1], t2);
    set(po.winner[0], po.winner[1], advance(q1, q2, t1, t2));
    return { rounds, champion, nextRow: po.winner[0] + 5 };
  };

  const startCol = 28; // AB
  let mode = opts.mode;
  const teams: Entry[] = opts.teams.map((t, i) => ({ name: `${t.p1} / ${t.p2}`, group: '', province: t.province, rating: t.rating > 0 ? t.rating : 100, groupRank: 1, eventSeed: i + 2 }));
  let N = 4;
  while (N < teams.length) N *= 2;
  if (mode === 3 && N < 8) mode = 2;
  teams.sort((a, b) => a.groupRank - b.groupRank || b.rating - a.rating || a.eventSeed - b.eventSeed);
  const placed = placeInBracket(teams, N).map((e) => (e.isBye ? 'BYE' : label(e)));
  const A = drawBracket('A', `BRACKET A (${teams.length} Teams / ${N}-Team Bracket)`, placed, N, 2, startCol);

  // Where Bracket A's losers come from
  const winnerOf = (ri: number, mi: number): V => (ri + 1 < A.rounds.length ? A.rounds[ri + 1][Math.floor(mi / 2)][mi % 2 === 0 ? 'p1' : 'p2'] : A.champion);
  const loserOf = (ri: number, mi: number) => loser(A.rounds[ri][mi].p1, A.rounds[ri][mi].p2, winnerOf(ri, mi));
  const byeSideLoserOf = (mi: number, side: 1 | 2): V => {
    const W = winnerOf(1, mi);
    const P = side === 1 ? A.rounds[1][mi].p1 : A.rounds[1][mi].p2;
    return W === '' ? '' : W === P ? 'BYE' : P;
  };
  const r1Bye = A.rounds[0].map((m) => m.p1 === 'BYE' || m.p2 === 'BYE');
  const feedersB: V[] = [];
  const feedersC: V[] = [];
  for (let j = 0; j < A.rounds[1].length; j++) {
    const k1 = 2 * j;
    const k2 = 2 * j + 1;
    if (mode === 2) {
      if (!r1Bye[k1]) feedersB.push(loserOf(0, k1));
      if (!r1Bye[k2]) feedersB.push(loserOf(0, k2));
      if (r1Bye[k1] && r1Bye[k2]) feedersB.push(loserOf(1, j));
      else if (r1Bye[k1]) feedersB.push(byeSideLoserOf(j, 1));
      else if (r1Bye[k2]) feedersB.push(byeSideLoserOf(j, 2));
    } else {
      if (!r1Bye[k1]) feedersC.push(loserOf(0, k1));
      if (!r1Bye[k2]) feedersC.push(loserOf(0, k2));
      feedersB.push(loserOf(1, j));
    }
  }

  const feederBracket = (id: string, feeders: V[], startRow: number) => {
    if (feeders.length < 2) return startRow;
    let M = 4;
    while (M < feeders.length) M *= 2;
    const filled = [...filledSlots(M, feeders.length)].sort((a, b) => a - b);
    const slots: V[] = new Array(M).fill('BYE');
    filled.forEach((slot, i) => (slots[slot] = feeders[i]));
    return drawBracket(id, `BRACKET ${id} (up to ${feeders.length} Teams / ${M}-Team Bracket)`, slots, M, startRow, startCol).nextRow;
  };
  let row = feederBracket('B', feedersB, A.nextRow);
  if (mode === 3) row = feederBracket('C', feedersC, row);
  return g;
}

/** Players from the snapshot's ranking list, paired into teams (team rating = the pair's sum). */
export const PAIRS: [string, string, string][] = [
  ['Lehmann Matthew', 'ZHANG Tian-Terry', 'MB'],
  ['YAN Steven', 'Bekele Biruk', 'MB'],
  ['Lu Yi Fan', 'Tran Jeremy', 'MB'],
  ['Xie Tianyu', 'Lee Alexus', 'MB'],
  ['Lee Victoria', 'Sepulveda Dino', 'MB'],
  ['Kuo Che Hung', 'Oyewo BJ', 'MB'],
  ['Cuadra Carlos', 'Chow Gordon', 'MB'],
  ['Shevchuck Anton', 'Lu Sharon', 'MB'],
  ['RYBAK Michal', 'Buda Sergiu', 'MB'],
  ['Ingenfeld Andi', 'Catalan Pablo', 'MB'],
  ['Joyal Didie', 'NGUYEN Phuong', 'MB'],
  ['Galgamuwa Dewram', 'Dolzhanskyi Vitalii', 'MB'],
];

/** `n` teams with descending ratings (so the seeding is easy to follow in tests). */
export function teams(n: number, rating = (i: number) => 4000 - i * 150): Team[] {
  return PAIRS.slice(0, n).map(([p1, p2, province], i) => ({ p1, p2, province, rating: rating(i) }));
}
