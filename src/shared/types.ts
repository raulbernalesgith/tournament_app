/** A single spreadsheet cell as returned by the Sheets API (or a CSV export). */
export type Cell = string | number | boolean | null;

/** Rows of cells for one tab, starting at A1. Rows may be ragged. */
export type Grid = Cell[][];

export interface Workbook {
  title: string;
  sheets: Record<string, Grid>;
}

export type SourceKind = 'sheets-api' | 'sheets-csv' | 'snapshot';

export interface Tournament {
  version: 1;
  /** When this JSON was produced from the sheet. */
  generatedAt: string;
  source: { kind: SourceKind; label: string };
  /** Number of players on the ranking list tab. */
  rankCount: number;
  players: Record<string, PlayerInfo>;
  events: EventData[];
  warnings: string[];
}

export interface PlayerInfo {
  rating: number | null;
  gender: string;
  province: string;
  /** Position on the ranking list (the "Serial" column). */
  listRank: number | null;
  period: number | null;
  /** ISO date (YYYY-MM-DD). */
  lastPlayed: string | null;
  /** The ranking list's "Temp" flag. */
  temp: boolean;
}

export interface EventData {
  /** URL-safe id derived from the tab name, e.g. "open-singles". */
  id: string;
  name: string;
  tab: string;
  roster: RosterEntry[];
  /** No group stage: everyone starts in the knockout (doubles). */
  knockoutOnly: boolean;
  /** Entries are doubles teams ("Name / Name"). */
  teams: boolean;
  /** Players who skip the group stage (Group_Stage_Bye = TRUE). */
  byes: string[];
  /** Which group draw block on the tab is in use (1 = the first "Group" column). */
  draw: 1 | 2;
  /**
   * The draw's name, when the sheet tells: written in the draw's header row,
   * or by position on tabs that still carry two draws side by side.
   */
  drawName: 'serpentine' | 'seeded pot' | null;
  /**
   * Why that draw was chosen: it is the only draw on the tab, the only one
   * with results entered, the one the bracket "(Group N)" labels match, or
   * neither told two draws apart.
   */
  drawBy: 'single' | 'results' | 'brackets' | 'default';
  groups: Group[];
  brackets: Bracket[];
}

export interface RosterEntry {
  name: string;
  province: string;
  gender: string;
  rating: number | null;
  bye: boolean;
}

export interface Group {
  /** As written on the sheet, e.g. "Group 6". */
  name: string;
  /** Short label, e.g. "6". */
  label: string;
  players: GroupPlayer[];
  /** Round-robin results from the "Match" / "Sets" / "G1"–"G5" columns. */
  matches: GroupMatch[];
  /**
   * True when W, L, Pts and Rank were worked out from the match results
   * because the sheet's standings formula showed "Loading…" or an error.
   */
  computed?: boolean;
}

export interface GroupMatch {
  /** 1-based order of play. */
  order: number;
  a: string;
  b: string;
  aSets: number | null;
  bSets: number | null;
  /** Game scores from the G1–G5 columns, as [a, b] points. */
  games: [number, number][];
  /** Set once a player has 3 games (best of 5), or the match is a walkover. */
  winner: string | null;
  /** A walkover ("3-0 WO"): the loser gets no match point. */
  wo?: boolean;
  /** Games entered but nobody has 3 yet. The sheet's standings already count the leader. */
  live?: boolean;
}

export interface GroupPlayer {
  name: string;
  seed: number | null;
  groupSeed: number | null;
  province: string;
  gender: string;
  rating: number | null;
  wins: number;
  losses: number;
  /** Match points (2 per win, 1 per loss) when the sheet has a Pts column. */
  points: number | null;
  rank: number;
}

export interface Bracket {
  /** "A", "B", "C", "D"... */
  id: string;
  label: string;
  /** Single elimination, or one round-robin group (e.g. "Consolation (Round-Robin)"). */
  format: 'knockout' | 'roundrobin';
  /** Round-robin standings and results (format "roundrobin" only). */
  table?: Group;
  /** Draw size, e.g. 32. */
  size: number;
  /** Number of real entrants (excluding byes). */
  players: number;
  preliminary: boolean;
  champion: string | null;
  rounds: Round[];
  /** Play-off 3/4 between the semifinal losers (knockout brackets from Tournament Tools). */
  thirdPlace?: Match;
  /** Doubles: this bracket's entries are teams dropping from another bracket (e.g. "A"). */
  fromBracket?: string;
  /** Doubles: how many teams can drop into this bracket (the title's "up to 6 Teams"). */
  upTo?: number;
}

export interface Round {
  name: string;
  /** R1, R2, QF, SF, Final */
  short: string;
  matches: Match[];
}

export interface Match {
  a: Slot;
  b: Slot;
  /** Name of the player who advanced, when known. */
  winner: string | null;
}

export interface Slot {
  /** Player name; null when the slot is still to be decided. */
  name: string | null;
  bye: boolean;
  score: number | null;
}
