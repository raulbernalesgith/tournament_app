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
  - every event tab: the roster (A:E), both group draws (the `Group` columns), and the `GROUP X - …` bracket blocks.
- **Which group draw is official** is detected automatically. It's the draw whose groups match the `(Group N)` labels in the bracket.
- **Bracket slots** are found from the bracket layout, so pending rounds still show "Winner of …" placeholders.
- **Before the sheet is connected**, the app serves `src/data/snapshot.grids.json` (built from an uploaded workbook).

## Connect the Google Sheet

The sheet must be shared as **Anyone with the link → Viewer**. Then add these as **secrets** on the Worker (Cloudflare dashboard → Workers & Pages → tournament-app → Settings → Variables and Secrets, or `npx wrangler secret put NAME`):

| Secret | Value |
| --- | --- |
| `SHEET_ID` | The id in the sheet URL: `docs.google.com/spreadsheets/d/<SHEET_ID>/edit` |
| `GOOGLE_API_KEY` | A Google Cloud API key restricted to the **Google Sheets API** (recommended; new tabs are picked up automatically) |
| `SHEET_TABS` | *Alternative to the API key:* `Canada_Rankings=0,Open_Singles=123,...` (tab name = `gid` from each tab's URL) |

To create the API key:
1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project.
2. Go to **APIs & Services → Library**, open **Google Sheets API** and click **Enable**.
3. Go to **Credentials → Create credentials → API key**.
4. Edit the key and set **API restrictions** to Google Sheets API.

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
