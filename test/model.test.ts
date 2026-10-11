import { describe, expect, it } from 'vitest';
import wb1009 from './fixtures/workbook-2026-10-09.grids.json';
import { buildTournament } from '../src/shared/parse';
import type { Grid, Workbook } from '../src/shared/types';
import { dropNote, dropRules, entrants, eventModel, feederLabel, finishOf, initials, knockoutRecord, pathOf, pathsOf, shortName } from '../src/app/model';
import { v5Tab } from './v5';
import { higherRatedWins, teams, v7DoublesTab, type ScoreFn } from './v7';

const rankings = (wb1009 as unknown as Workbook).sheets['Canada_Rankings'];
const event = (tab: Grid) =>
  buildTournament({ title: 'x', sheets: { Canada_Rankings: rankings, Tab: tab } }, { kind: 'snapshot', label: 'test' }, new Date('2026-10-11T00:00:00Z')).events[0];
const doubles = (n: number, mode: 2 | 3, score?: ScoreFn) => event(v7DoublesTab({ teams: teams(n), mode, score }));

const TOP = 'Lehmann Matthew / ZHANG Tian-Terry';

describe('doubles teams across brackets', () => {
  it('follows a team that drops from A into B: both runs, the finish from B', () => {
    // The top team has a bye, then loses its first match (the quarterfinal) and drops to B.
    const ev = doubles(9, 2, higherRatedWins({ A: 2, B: 1 }, ['A:1:0']));
    const runs = pathsOf(ev, TOP);
    expect(runs.map((r) => r.bracket.id)).toEqual(['A', 'B']);
    expect(runs[0].steps.map((s) => [s.round.short, s.res])).toEqual([['R16', 'bye'], ['QF', 'lost']]);
    expect(pathOf(ev, TOP)!.bracket.id).toBe('B');
    expect(knockoutRecord(runs)).toEqual({ w: 1, l: 1 });
    expect(dropNote(ev, TOP, runs[1].bracket)).toBe('Dropped from A · QF');
    const f = finishOf(ev, TOP);
    expect(f).toMatchObject({ kind: 'alive', long: 'Still alive in Consolation', bracket: { id: 'B' } });
    expect(f.sub).toMatch(/^Next: Semifinal vs /);
  });

  it('labels the slots still waiting on A results, and says so in the finish', () => {
    const ev = doubles(9, 2, higherRatedWins({ A: 1 }));
    const B = ev.brackets[1];
    const k = B.rounds[0].matches.findIndex((m) => (!m.a.name && !m.a.bye) || (!m.b.name && !m.b.bye));
    const side = !B.rounds[0].matches[k].a.name && !B.rounds[0].matches[k].a.bye ? 'a' : 'b';
    expect(feederLabel(B, 0, k, side)).toBe('Drops from Bracket A');
    expect(feederLabel(ev.brackets[0], 0, 0, 'a')).toBe('To be decided');
    expect(entrants(B, true)).toBe('Up to 5 teams');
    // The first-round loser is already in B, waiting for an opponent from A.
    const dropped = B.rounds[0].matches.flatMap((m) => [m.a.name, m.b.name]).find(Boolean)!;
    expect(finishOf(ev, dropped).sub).toBe('Next: Semifinal vs Winner of QF · M2');
  });

  it('keeps a team that never dropped in A, with its finish there', () => {
    const ev = doubles(6, 2, higherRatedWins());
    expect(pathsOf(ev, TOP).map((r) => r.bracket.id)).toEqual(['A']);
    expect(finishOf(ev, TOP)).toMatchObject({ kind: 'champ', long: 'Championship champion' });
    expect(finishOf(ev, 'YAN Steven / Bekele Biruk')).toMatchObject({ kind: 'runner', sub: 'Lost the Championship final 1–3' });
    expect(finishOf(ev, 'Xie Tianyu / Lee Alexus')).toMatchObject({ kind: 'out', short: '4th', sub: 'Lost the play-off 3/4 to Lu / Tran 1–3' });
  });

  it('moves the stage from draw pending to knockout up next, live and final results', () => {
    const before = event(v7DoublesTab({ teams: teams(5), mode: 2 }).map((r) => (r ?? []).slice(0, 6)));
    expect(eventModel(before).stage).toBe('draw');
    expect(finishOf(before, TOP)).toMatchObject({ kind: 'none', short: 'Draw', long: 'Not in a bracket yet' });
    expect(eventModel(doubles(9, 2)).stage).toBe('next');
    expect(eventModel(doubles(9, 2, higherRatedWins({ A: 1 }))).stage).toBe('live');
    expect(eventModel(doubles(6, 2, higherRatedWins())).stage).toBe('done');
  });

  it('explains how teams drop with two and with three brackets', () => {
    expect(dropRules(doubles(9, 2)).map((r) => [r.bracket.id, r.rule])).toEqual([
      ['A', 'Every team starts here'],
      ['B', 'Teams that lose their first match in A'],
    ]);
    expect(dropRules(doubles(12, 3)).map((r) => [r.bracket.id, r.rule])).toEqual([
      ['A', 'Every team starts here'],
      ['B', 'Teams that lose in round 2 of A'],
      ['C', 'Teams that lose in round 1 of A'],
    ]);
  });

  it('counts the Championship result first for a team that also dropped (small draws)', () => {
    // 3 teams: the top team has a bye, loses the A final, and drops to B, where it plays the other team.
    const live = doubles(3, 2, higherRatedWins({ B: 0 }, ['A:1:0']));
    expect(pathsOf(live, TOP).map((r) => r.bracket.id)).toEqual(['A', 'B']);
    expect(finishOf(live, TOP)).toMatchObject({ kind: 'alive', bracket: { id: 'B' }, sub: 'Next: Final vs Lu / Tran · Championship runner-up' });
    const done = doubles(3, 2, higherRatedWins({}, ['A:1:0']));
    expect(done.brackets[1].champion).toBe(TOP);
    expect(finishOf(done, TOP)).toMatchObject({ kind: 'runner', bracket: { id: 'A' }, sub: 'Lost the Championship final 1–3 · won Consolation' });

    // 8 teams, three brackets: B is A's two semifinal losers, who also play A's play-off 3/4.
    const ev = doubles(8, 3, higherRatedWins({ A: 2, B: 9, C: 9 }));
    const loser = ev.brackets[1].rounds[0].matches.flatMap((m) => [m.a.name, m.b.name]).find(Boolean)!;
    expect(pathsOf(ev, loser).map((r) => r.bracket.id)).toEqual(['A', 'B']);
    expect(finishOf(ev, loser)).toMatchObject({ kind: 'alive', short: 'Play-off', bracket: { id: 'A' } });
  });

  it('describes a B or C title without claiming an unbeaten run', () => {
    const ev = doubles(9, 2, higherRatedWins({}, ['A:1:0']));
    const B = ev.brackets[1];
    expect(B.champion).toBe(TOP);
    expect(finishOf(ev, TOP)).toMatchObject({ kind: 'champ', long: 'Consolation champion', sub: '3 wins in Consolation after dropping from A' });
  });

  it('says B takes round-2 losers when three brackets were asked for but C was not needed', () => {
    expect(dropRules(doubles(9, 3)).map((r) => r.rule)).toEqual(['Every team starts here', 'Teams that lose in round 2 of A']);
  });

  it('says players, not teams, when singles are run through the doubles brackets', () => {
    // Same brackets, but every entry is one player (the script still titles the brackets in teams).
    const solo = (v: unknown) => (typeof v === 'string' ? v.replace(/ \/ [^(]*?(?= \(|$)/, '') : v);
    const tab = v7DoublesTab({ teams: teams(9), mode: 2 }).map((r, i) => (i === 0 ? ['Name', 'Partner', 'Name', 'Province', 'Rating', 'Group_Stage_Bye'] : (r ?? []).map(solo)));
    tab[0][0] = 'Player';
    const ev = event(tab as Grid);
    expect(ev).toMatchObject({ knockoutOnly: true, teams: false });
    expect(ev.brackets[0].rounds[0].matches[0].a.name).toBe('Lehmann Matthew');
    expect(dropRules(ev).map((r) => r.rule)).toEqual(['Every player starts here', 'Players that lose their first match in A']);
  });

  it('shortens team names to surnames and keeps singles names whole', () => {
    expect(shortName(TOP)).toBe('Lehmann / ZHANG');
    expect(initials(TOP)).toBe('LZ');
    expect(shortName('Lu Yi Fan')).toBe('Lu Yi Fan');
    expect(initials('Lu Yi Fan')).toBe('LY');
  });
});

describe('singles are unchanged', () => {
  it('has one run per player and the group-stage stage before the knockout', () => {
    const ev = event(v5Tab());
    expect(pathsOf(ev, 'Bekele Biruk').map((r) => r.bracket.id)).toEqual(['A']);
    expect(finishOf(ev, 'Bekele Biruk')).toMatchObject({ kind: 'champ' });
    expect(dropNote(ev, 'Bekele Biruk', ev.brackets[0])).toBe('');
    expect(entrants(ev.brackets[0], false)).toBe('4 players');
  });
});
