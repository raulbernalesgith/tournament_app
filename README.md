# Rally · Tournament app

Live groups and knockout brackets for the table tennis tournament, synced from a Google Sheet and served by a Cloudflare Worker.

- **Phone:** overview, groups, knockout rounds (A/B/C/D brackets appear automatically from the sheet), players and player profiles.
- **Desktop:** full bracket tree. Click any name to trace that player's path.
- **Updates:** results refresh every minute from the sheet. Links are shareable (event, view, bracket and player are kept in the URL). Light and dark modes are both included.

## How it works

```
Google Sheet ──(every minute, cron)──▶ Worker downloads each tab's CSV ──▶ KV (only when it changed,
                                                                             at most every 2 minutes)
Browser ◀── static app (dist/client) ◀── /api/sheet ◀───────────────────────┘
   └─ builds groups, brackets and profiles from the tabs (src/shared/parse.ts)
```

- **The Worker only downloads.** Each minute it fetches every tab's CSV export, hashes it, and saves the tabs to KV when the hash changes. A run takes about 3 ms of CPU, inside the Workers Free plan's 10 ms per cron run. (Building the tournament in the Worker took 10–50 ms once the sheet grew, and Cloudflare stopped the runs.) Saves happen only on even minutes, and the sync status only every 10 minutes, so KV writes stay under the free plan's 1,000 a day whatever the sheet does.
- **The browser builds the tournament.** `src/shared/parse.ts` turns the tabs into groups and brackets in the app, only when the sheet changed. It reads:
  - the ranking list tab (Serial, Name, Prov, Gender, Rating, Period, Last Played, Temp);
  - every event tab: the player list (A:F), the group draw (the `Group` columns), and the `GROUP X - …` / `BRACKET X (…)` bracket blocks.
  - A tab it can't read is left out with a warning; the other events still show.
- **Tabs are found automatically.** A second cron re-reads the sheet's tab list every 10 minutes, so a new, renamed, hidden or deleted event tab shows within 10 minutes (edits to existing tabs show within a couple of minutes). A tab that can't be downloaded keeps its last copy, and a deleted tab triggers a fresh tab list right away. `SHEET_TABS` (below) is only used if the tab list can't be read at all.
- **The sheet is built by Tournament Tools** (the sheet's Apps Script): Clear Generated Outputs → Serpentine or Seeded Pot draw (written to G:Y, so one draw per tab) → Knockout / Tiered Brackets (written from AB). Doubles skip the draw: Run Doubles Brackets writes Brackets A, B (and C) from AB. The app finds the draw and the brackets by their headers and titles, wherever they sit.
- **Which group draw is used.** With one draw per tab, that draw. Its name ("Serpentine draw" / "Seeded pot draw") is shown only when the sheet says which it is: Tournament Tools keeps the draw type in a cell note, which the export doesn't include, so add the R1 line below. Older tabs with two draws side by side (serpentine first, seeded pot second) use the one with results entered; if neither or both have results, the draw the bracket `(Group N)` labels match, and the serpentine draw as a last resort.
- **Bracket slots** are found from the bracket layout, so pending rounds still show "Winner of …" placeholders.
- **Before the sheet is connected**, the app shows `src/data/snapshot.grids.json` (built from an uploaded workbook).

## Connect the Google Sheet

The sheet must be shared as **Anyone with the link → Viewer**. Then add these as **secrets** on the Worker (Cloudflare dashboard → Workers & Pages → tournament-app → Settings → Variables and Secrets, or `npx wrangler secret put NAME`):

| Secret | Value |
| --- | --- |
| `SHEET_ID` | The id in the sheet URL: `docs.google.com/spreadsheets/d/<SHEET_ID>/edit` |
| `SHEET_TABS` | *Optional backup:* `Canada_Rankings=0,Open_Singles=123,...` (tab name = `gid` from each tab's URL). Tabs are normally discovered automatically; this list is used only if the sheet's tab list can't be read. |
| `GOOGLE_API_KEY` | *Optional:* a Google Cloud API key for the Sheets API. Not needed; without it the app reads the sheet's free public CSV export. |

### Sheet rules the app follows

- Tab 1 is the ranking list. Every other tab is an event; tabs with no registered players are not published. A tab with players but no draw yet (for example right after Clear Generated Outputs) is shown as "Draw pending".
- Player list columns are found the way Tournament Tools finds them in A:F: a header containing "name", "prov"/"assoc"/"club", "gender"/"sex", "rating" and "bye"/"skip", falling back to A–E.
- Group tables: `Group`, `Event Seed`, `Group Seed`, `Name`, `Province`, `Gender`, `Rating`, `W`, `L`, `Pts`, `Rank`, then `Match` ("Seed 1 vs Seed 3"), `Sets` ("3-1") and `G1`–`G5` ("11-7", first player's points first). The header row can repeat above every group. Older names (`Wins`, `Losses`, `Match Order`, `Sets (P1-P2)`) still work.
- Results are read the way the sheet's `ITTF_STANDINGS` reads them: the first score in the Sets cell ("3-1", "3:1"); Sets left blank are counted from the game scores; "3-0 WO" is a walkover (the loser gets 0 points, shown as W/O). Every match is best of 5, so a match is shown as **Live** until someone has 3 games.
- The sheet's W / L / Pts / Rank are official. Note that `ITTF_STANDINGS` already counts a live match for the player ahead. If the formula shows "Loading…" or an error, the app works the standings out the same way the formula does, and `/api/health?events=1` says so. It also warns when the sheet's W–L don't match the results entered.
- Tip: keep the Sets and G1–G5 columns as **Plain text** (Tournament Tools does this) so Sheets doesn't turn "3-1" into a date. Dates are read back as month-day, so they still work.
- Brackets are `GROUP X - Name (...)` blocks, and any of them (A, B, C, D…) can be a knockout or a round-robin. A block is a round-robin when its title says `(Round-Robin)` or when it has a Seed / W / L table instead of round headers; it is then shown as standings plus results. A round-robin division should be one group (Tournament Tools can split big ones into several; the app reads the first).
- The "Play-off 3/4" under a knockout bracket (the semifinal losers) is shown as the 3rd-place match.
- **Doubles** (Tournament Tools → Run Doubles Brackets). The tab lists Player 1, Player 2, Name (the team, "Player 1 / Player 2"), Province and Rating (the pair's total). There's no group stage, so Group_Stage_Bye is ignored. Every team starts in Bracket A, shown as **Championship**:
  - with two brackets, a team that loses its first match in A drops to Bracket B, **Consolation** (a team with a first-round bye drops only if it loses its next match);
  - with three, round-1 losers drop to Bracket C, **Division C**, and round-2 losers to B.

  B and C fill in as A is played; until then their slots say "Drops from Bracket A". A team's profile shows both partners from the ranking list and every bracket the team played in. In the desktop bracket, teams show as surnames ("Lehmann / ZHANG"); hover for the full names.

### Optional Tournament Tools tweaks

- **Show the draw name in the app.** In `writeGroupStage`, after the `setNote(...)` line, add `sheet.getRange(1, startCol + 11).setValue(drawLabel);`. It writes "Serpentine" or "Seeded Pot" into R1 (the narrow gap column), which the app reads.
- **Point the QR code at the app.** In `showPublicShareQRCode`, set `const htmlViewUrl = "https://tournament-app.raulbernales.workers.dev/";`.

`/api/health` shows when the sheet last changed and how the sync is doing (`sync.state`, any error, and `stale: true` if the sync hasn't reported for over an hour, which means Cloudflare isn't running it). Add `?events=1` for each event's draw and brackets, and the warnings.

## Develop

```bash
npm install
npm test            # parser tests against the snapshot
npm run dev         # builds the app and runs the Worker at http://localhost:8787
npm run typecheck
```

To refresh the bundled snapshot from a downloaded copy of the sheet:

```bash
pip install openpyxl
python3 scripts/xlsx_to_grids.py path/to/workbook.xlsx
```

## Deploy

Pushes to `main` deploy automatically once the repo is connected in Cloudflare (**Workers & Pages → Create → Import a repository**). The Worker name must stay `tournament-app` to match `wrangler.jsonc`. Manual deploy: `npx wrangler deploy`.
