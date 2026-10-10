# Rally · Tournament app

Live groups and knockout brackets for the table tennis tournament, synced from a Google Sheet and served by a Cloudflare Worker.

- **Phone:** overview, groups, knockout rounds (A/B/C/D brackets appear automatically from the sheet), players and player profiles.
- **Desktop:** full bracket tree. Click any name to trace that player's path.
- **Updates:** results refresh every minute from the sheet. Links are shareable (event, view, bracket and player are kept in the URL). Light and dark modes are both included.

## How it works

```
Google Sheet ──(every minute, cron)──▶ Worker parses tabs ──▶ KV (only when content changes)
                                                               │
Browser ◀── static app (dist/client) ◀── /api/tournament ◀─────┘
```

- `src/shared/parse.ts` turns the sheet tabs into JSON. It reads:
  - the ranking list tab (Serial, Name, Prov, Gender, Rating, Period, Last Played, Temp);
  - every event tab: the player list (A:F), the group draw (the `Group` columns), and the `GROUP X - …` bracket blocks.
- **The sheet is built by Tournament Tools** (the sheet's Apps Script): Clear Generated Outputs → Serpentine or Seeded Pot draw (written to G:Y, so one draw per tab) → Knockout / Tiered Brackets (written from AB). The app finds the draw and the brackets by their headers and titles, wherever they sit.
- **Which group draw is used.** With one draw per tab, that draw. Its name ("Serpentine draw" / "Seeded pot draw") is shown only when the sheet says which it is: Tournament Tools keeps the draw type in a cell note, which the export doesn't include, so add the R1 line below. Older tabs with two draws side by side (serpentine first, seeded pot second) use the one with results entered; if neither or both have results, the draw the bracket `(Group N)` labels match, and the serpentine draw as a last resort. `/api/health` shows the choice for each event.
- **Bracket slots** are found from the bracket layout, so pending rounds still show "Winner of …" placeholders.
- **Before the sheet is connected**, the app serves `src/data/snapshot.grids.json` (built from an uploaded workbook).

## Connect the Google Sheet

The sheet must be shared as **Anyone with the link → Viewer**. Then add these as **secrets** on the Worker (Cloudflare dashboard → Workers & Pages → tournament-app → Settings → Variables and Secrets, or `npx wrangler secret put NAME`):

| Secret | Value |
| --- | --- |
| `SHEET_ID` | The id in the sheet URL: `docs.google.com/spreadsheets/d/<SHEET_ID>/edit` |
| `SHEET_TABS` | *Optional backup:* `Canada_Rankings=0,Open_Singles=123,...` (tab name = `gid` from each tab's URL). Tabs are normally discovered automatically. |
| `GOOGLE_API_KEY` | *Optional:* a Google Cloud API key for the Sheets API. Not needed; without it the app reads the sheet's free public CSV export. |

### Sheet rules the app follows

- Tab 1 is the ranking list. Every other tab is an event; tabs with no registered players are not published. A tab with players but no draw yet (for example right after Clear Generated Outputs) is shown as "Draw pending".
- Player list columns are found the way Tournament Tools finds them in A:F: a header containing "name", "prov"/"assoc"/"club", "gender"/"sex", "rating" and "bye"/"skip", falling back to A–E.
- Group tables: `Group`, `Event Seed`, `Group Seed`, `Name`, `Province`, `Gender`, `Rating`, `W`, `L`, `Pts`, `Rank`, then `Match` ("Seed 1 vs Seed 3"), `Sets` ("3-1") and `G1`–`G5` ("11-7", first player's points first). The header row can repeat above every group. Older names (`Wins`, `Losses`, `Match Order`, `Sets (P1-P2)`) still work.
- Results are read the way the sheet's `ITTF_STANDINGS` reads them: the first score in the Sets cell ("3-1", "3:1"); Sets left blank are counted from the game scores; "3-0 WO" is a walkover (the loser gets 0 points, shown as W/O). Every match is best of 5, so a match is shown as **Live** until someone has 3 games.
- The sheet's W / L / Pts / Rank are official. Note that `ITTF_STANDINGS` already counts a live match for the player ahead. If the formula shows "Loading…" or an error, the app works the standings out the same way the formula does, and `/api/health` says so. It also warns when the sheet's W–L don't match the results entered.
- Tip: keep the Sets and G1–G5 columns as **Plain text** (Tournament Tools does this) so Sheets doesn't turn "3-1" into a date. Dates are read back as month-day, so they still work.
- Brackets are `GROUP X - Name (...)` blocks, and any of them (A, B, C, D…) can be a knockout or a round-robin. A block is a round-robin when its title says `(Round-Robin)` or when it has a Seed / W / L table instead of round headers; it is then shown as standings plus results. A round-robin division should be one group (Tournament Tools can split big ones into several; the app reads the first).
- The "Play-off 3/4" under a knockout bracket (the semifinal losers) is shown as the 3rd-place match.
- Doubles: write a team as `Name / Name` in the Name column (Tournament Tools reads one name column). The team's rating is the Rating on the sheet.

### Optional Tournament Tools tweaks

- **Show the draw name in the app.** In `writeGroupStage`, after the `setNote(...)` line, add `sheet.getRange(1, startCol + 11).setValue(drawLabel);`. It writes "Serpentine" or "Seeded Pot" into R1 (the narrow gap column), which the app reads.
- **Point the QR code at the app.** In `showPublicShareQRCode`, set `const htmlViewUrl = "https://tournament-app.raulbernales.workers.dev/";`.

`/api/health` shows which source is active and the last sync error, if any.

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
