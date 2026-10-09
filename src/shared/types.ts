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
  /** Players who skip the group stage (Group_Stage_Bye = TRUE). */
  byes: string[];
  /**
   * Which of the two group draws on the tab is in use: 1 is the serpentine
   * draw, 2 the seeded pot draw.
   */
  draw: 1 | 2;
  /**
   * Why that draw was chosen: it is the only one with entered results, the
   * bracket "(Group N)" labels match it, or neither told them apart.
   */
  drawBy: 'results' | 'brackets' | 'default';
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
  winner: string | null;
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
