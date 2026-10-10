import type { Bracket, EventData, Group, GroupPlayer, Match, PlayerInfo, Round, Tournament } from '../shared/types';

export interface GroupSpot {
  group: Group;
  player: GroupPlayer;
}

export interface EventModel {
  ev: EventData;
  spot: Map<string, GroupSpot>;
  /** Group finishing place -> bracket id. */
  dest: Map<number, string>;
  people: string[];
  gPlayed: number;
  gTotal: number;
  kPlayed: number;
  kTotal: number;
  stage: Stage;
}

export type Stage = 'done' | 'pre' | 'live' | 'next' | 'groups' | 'draw';

export const isBye = (m: Match) => m.a.bye || m.b.bye;
/** A knockout match counts as played once someone advanced, or the scores are in and not level. */
export const isPlayed = (m: Match) =>
  !isBye(m) && (!!m.winner || (m.a.score != null && m.b.score != null && m.a.score !== m.b.score));

/** Group matches with a result. Older sheets without match rows count the wins instead. */
export function groupPlayed(g: Group): number {
  if (g.matches.length) return g.matches.filter((m) => m.winner).length;
  return g.players.reduce((a, p) => a + p.wins, 0);
}

/** Matches a group plays: everyone meets everyone once. */
export function groupTotal(g: Group): number {
  const n = g.players.length;
  return Math.max(g.matches.length, (n * (n - 1)) / 2);
}

/** Whether the sheet gives match points (the Pts column) for this event's tables. */
export function hasPoints(ev: EventData): boolean {
  const tables = [...ev.groups, ...ev.brackets.flatMap((b) => (b.table ? [b.table] : []))];
  return tables.some((g) => g.players.some((p) => p.points != null));
}

/** "Serpentine draw" / "Seeded pot draw", or null when the sheet doesn't say which draw was run. */
export function drawLabel(ev: EventData): string | null {
  if (ev.drawName === 'serpentine') return 'Serpentine draw';
  if (ev.drawName === 'seeded pot') return 'Seeded pot draw';
  return null;
}

/** The play-off 3/4 is a real match once a bracket has four or more players (otherwise a semifinal loser is a bye). */
const playoffCounts = (b: Bracket) => !!b.thirdPlace && b.players >= 4;

export function bracketTotal(b: Bracket): number {
  if (b.format === 'roundrobin') {
    const n = b.table?.players.length ?? 0;
    return (n * (n - 1)) / 2;
  }
  return Math.max(0, b.players - 1) + (playoffCounts(b) ? 1 : 0);
}

export function bracketPlayed(b: Bracket): number {
  if (b.format === 'roundrobin') return (b.table?.matches ?? []).filter((m) => m.winner).length;
  const rounds = b.rounds.reduce((s, r) => s + r.matches.filter(isPlayed).length, 0);
  return rounds + (b.thirdPlace && playoffCounts(b) && isPlayed(b.thirdPlace) ? 1 : 0);
}

/** A bracket is finished when it has a champion and its play-off 3/4 (if any) is settled. */
export function bracketDone(b: Bracket): boolean {
  if (!b.champion) return false;
  const po = b.thirdPlace;
  return !po || !playoffCounts(b) || !!po.winner || isBye(po);
}

/** Group matches being played right now (games entered, nobody has 3 yet). */
export function groupLive(g: Group): number {
  return g.matches.filter((m) => m.live).length;
}

export function eventModel(ev: EventData): EventModel {
  const spot = new Map<string, GroupSpot>();
  ev.groups.forEach((group) => group.players.forEach((player) => spot.set(player.name, { group, player })));
  const dest = new Map<number, string>();
  ev.brackets.forEach((b) => {
    const names =
      b.format === 'roundrobin'
        ? (b.table?.players ?? []).map((p) => p.name)
        : (b.rounds[0]?.matches ?? []).flatMap((m) => [m.a.name, m.b.name]);
    names.forEach((n) => {
      const s = n ? spot.get(n) : undefined;
      if (s && !dest.has(s.player.rank)) dest.set(s.player.rank, b.id);
    });
  });
  const seen = new Set<string>();
  const people = [...ev.byes, ...ev.groups.flatMap((g) => g.players.map((p) => p.name)), ...ev.roster.map((p) => p.name)].filter((n) => {
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });
  const gTotal = ev.groups.reduce((a, g) => a + groupTotal(g), 0);
  const gPlayed = ev.groups.reduce((a, g) => a + groupPlayed(g), 0);
  const kTotal = ev.brackets.reduce((a, b) => a + bracketTotal(b), 0);
  const kPlayed = ev.brackets.reduce((a, b) => a + bracketPlayed(b), 0);
  let stage: Stage = ev.groups.length || ev.brackets.length ? 'groups' : 'draw';
  if (ev.brackets.length && ev.brackets.every(bracketDone)) stage = 'done';
  else if (ev.brackets.some((b) => b.preliminary)) stage = 'pre';
  else if (kPlayed > 0) stage = 'live';
  else if (gTotal > 0 && gPlayed >= gTotal) stage = 'next';
  return { ev, spot, dest, people, gPlayed, gTotal, kPlayed, kTotal, stage };
}

export const STAGE_LABEL: Record<Stage, string> = {
  done: 'Final results',
  pre: 'Projected draw',
  live: 'Knockout live',
  next: 'Knockout up next',
  groups: 'Group stage',
  draw: 'Draw pending',
};

export const ord = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

export function initials(name: string) {
  return name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

export function rating(t: Tournament, name: string): string {
  const r = t.players[name]?.rating;
  return r == null ? '—' : String(r);
}

export function origin(M: EventModel, name: string): string {
  const s = M.spot.get(name);
  if (s) return `Group ${s.group.label} · ${ord(s.player.rank)}`;
  return M.ev.byes.includes(name) ? 'Group-stage bye' : '';
}

export type StepResult = 'won' | 'lost' | 'bye' | 'pending';

export interface Step {
  round: Round;
  ri: number;
  mi: number;
  match: Match;
  opp: string | null;
  oppLabel: string;
  my: number | null;
  os: number | null;
  res: StepResult;
}

export interface PlayerPath {
  bracket: Bracket;
  steps: Step[];
}

export function feederLabel(b: Bracket, ri: number, mi: number, side: 'a' | 'b'): string {
  if (ri === 0) return 'To be decided';
  if (ri >= b.rounds.length) return `Loser of SF · M${side === 'a' ? 1 : 2}`;
  return `Winner of ${b.rounds[ri - 1].short} · M${2 * mi + (side === 'a' ? 1 : 2)}`;
}

/** The play-off 3/4 shown as one more round after the final. */
export function playoffRound(b: Bracket): Round | null {
  return b.thirdPlace ? { name: 'Play-off 3/4', short: '3rd', matches: [b.thirdPlace] } : null;
}

export function pathOf(ev: EventData, name: string): PlayerPath | null {
  for (const bracket of ev.brackets) {
    const steps: Step[] = [];
    const po = playoffRound(bracket);
    [...bracket.rounds, ...(po ? [po] : [])].forEach((round, ri) =>
      round.matches.forEach((match, mi) => {
        const mine = match.a.name === name ? 'a' : match.b.name === name ? 'b' : null;
        if (!mine) return;
        const me = match[mine];
        const other = match[mine === 'a' ? 'b' : 'a'];
        let res: StepResult = 'pending';
        if (other.bye) res = 'bye';
        else if (match.winner === name) res = 'won';
        else if (match.winner) res = 'lost';
        const oppLabel = other.bye ? 'Bye' : other.name ?? feederLabel(bracket, ri, mi, mine === 'a' ? 'b' : 'a');
        steps.push({ round, ri, mi, match, opp: other.name, oppLabel, my: me.score, os: other.score, res });
      }),
    );
    if (steps.length) return { bracket, steps };
  }
  return null;
}

export type FinishKind = 'champ' | 'runner' | 'third' | 'out' | 'alive' | 'none';

export interface Finish {
  kind: FinishKind;
  short: string;
  long: string;
  sub: string;
  bracket: Bracket | null;
}

const IN_ROUND: Record<string, string> = {
  R1: 'Round 1',
  R2: 'Round 2',
  R3: 'Round 3',
  R64: 'the round of 64',
  R32: 'the round of 32',
  R16: 'the round of 16',
  QF: 'the quarterfinals',
  SF: 'the semifinals',
  Final: 'the final',
};
const NEXT_ROUND: Record<string, string> = {
  R1: 'Round 1',
  R2: 'Round 2',
  R3: 'Round 3',
  R64: 'Round of 64',
  R32: 'Round of 32',
  R16: 'Round of 16',
  QF: 'Quarterfinal',
  SF: 'Semifinal',
  Final: 'Final',
};

export function finishOf(ev: EventData, name: string): Finish {
  const rr = ev.brackets.find((b) => b.format === 'roundrobin' && b.table?.players.some((p) => p.name === name));
  if (rr && rr.table) {
    const me = rr.table.players.find((p) => p.name === name)!;
    const left = bracketTotal(rr) - bracketPlayed(rr);
    if (rr.champion === name) return { kind: 'champ', short: 'Champion', long: `${rr.label} champion`, sub: `Won the round-robin ${me.wins}–${me.losses}`, bracket: rr };
    if (left === 0) return { kind: 'out', short: ord(me.rank), long: `${ord(me.rank)} in ${rr.label}`, sub: `Round-robin record ${me.wins}–${me.losses}`, bracket: rr };
    return { kind: 'alive', short: 'Playing', long: `Playing the ${rr.label} round-robin`, sub: `${me.wins}–${me.losses} so far · currently ${ord(me.rank)}`, bracket: rr };
  }
  const p = pathOf(ev, name);
  if (!p) return { kind: 'none', short: 'Groups', long: 'Not in a knockout draw yet', sub: 'Waiting on the group stage', bracket: null };
  const last = p.steps[p.steps.length - 1];
  const wins = p.steps.filter((s) => s.res === 'won').length;
  const b = p.bracket;
  if (last.round.short === '3rd') {
    if (last.res === 'won') return { kind: 'third', short: '3rd place', long: '3rd place', sub: `Won the play-off 3/4 ${last.my}–${last.os}`, bracket: b };
    if (last.res === 'bye') return { kind: 'third', short: '3rd place', long: '3rd place', sub: 'No play-off opponent', bracket: b };
    if (last.res === 'lost') return { kind: 'out', short: '4th', long: '4th place', sub: `Lost the play-off 3/4 to ${last.opp} ${last.my}–${last.os}`, bracket: b };
    return { kind: 'alive', short: 'Play-off', long: 'Playing for 3rd place', sub: `Play-off 3/4 vs ${last.oppLabel}`, bracket: b };
  }
  if (b.champion === name) {
    return { kind: 'champ', short: 'Champion', long: `${b.label} champion`, sub: `${wins} knockout ${wins === 1 ? 'win' : 'wins'} without a loss`, bracket: b };
  }
  if (last.res === 'lost') {
    if (last.round.short === 'Final') {
      return { kind: 'runner', short: 'Runner-up', long: 'Runner-up', sub: `Lost the ${b.label} final ${last.my}–${last.os}`, bracket: b };
    }
    return { kind: 'out', short: last.round.short, long: `Out in ${IN_ROUND[last.round.short] ?? last.round.name}`, sub: `Lost to ${last.opp} ${last.my}–${last.os}`, bracket: b };
  }
  if (last.res === 'pending') {
    return { kind: 'alive', short: 'Alive', long: `Still alive in ${b.label}`, sub: `Next: ${NEXT_ROUND[last.round.short] ?? last.round.name} vs ${last.oppLabel}`, bracket: b };
  }
  return { kind: 'alive', short: 'Alive', long: `Still alive in ${b.label}`, sub: 'Through to the next round', bracket: b };
}

export function nextUp(b: Bracket): { round: Round; ri: number; match: Match; ready: number } | null {
  for (let ri = 0; ri < b.rounds.length; ri += 1) {
    const ready = b.rounds[ri].matches.filter((m) => m.a.name && m.b.name && !m.winner);
    if (ready.length) return { round: b.rounds[ri], ri, match: ready[0], ready: ready.length };
  }
  return null;
}

export function sortedPeople(t: Tournament, M: EventModel): string[] {
  const r = (n: string) => t.players[n]?.rating ?? 0;
  return M.people.slice().sort((a, b) => r(b) - r(a) || a.localeCompare(b));
}

export function formatDate(iso: string | null): { main: string; year: string } {
  if (!iso) return { main: '—', year: 'No record' };
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return { main: `${months[m - 1]} ${d}`, year: String(y) };
}

export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export type { PlayerInfo };
