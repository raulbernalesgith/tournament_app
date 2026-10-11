/**
 * Names as the sheet writes them: "Surname Given" for a player, and
 * "Surname Given / Surname Given" for a doubles team (Tournament Tools builds
 * the team name from the Player 1 and Player 2 columns).
 */

/** The players in a doubles team written "A / B"; just the one name for singles. */
export function teamMembers(name: string): string[] {
  const parts = name
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts : [name];
}

export const isTeam = (name: string) => teamMembers(name).length > 1;

/** A team as its partners' surnames ("Lehmann / ZHANG"); a player's name as is. */
export function shortName(name: string): string {
  const members = teamMembers(name);
  return members.length > 1 ? members.map((m) => m.split(/\s+/)[0]).join(' / ') : name;
}
