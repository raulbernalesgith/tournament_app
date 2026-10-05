"""Convert an exported workbook (.xlsx) into the grid JSON the app understands.

The Worker normally reads the live Google Sheet. This script builds the
bundled fallback snapshot (src/data/snapshot.grids.json) and the test fixture
from a downloaded copy of the sheet, using the same shape the Google Sheets
API returns: one array of row arrays per tab, cached formula results only,
dates as spreadsheet serial numbers.

Usage:
    python3 scripts/xlsx_to_grids.py path/to/workbook.xlsx [src/data/snapshot.grids.json]

Requires: pip install openpyxl
"""
import datetime as dt
import json
import sys

import openpyxl

EPOCH = dt.datetime(1899, 12, 30)


def cell_value(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return int(v) if float(v).is_integer() else v
    if isinstance(v, dt.datetime):
        return round((v - EPOCH).total_seconds() / 86400, 6)
    if isinstance(v, dt.date):
        return (dt.datetime(v.year, v.month, v.day) - EPOCH).days
    s = str(v)
    return s if s != "" else None


def sheet_grid(ws):
    rows = []
    for row in ws.iter_rows(values_only=True):
        vals = [cell_value(v) for v in row]
        while vals and vals[-1] is None:
            vals.pop()
        rows.append(vals)
    while rows and not rows[-1]:
        rows.pop()
    return rows


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else "src/data/snapshot.grids.json"
    wb = openpyxl.load_workbook(src, data_only=True)
    payload = {
        "title": src.rsplit("/", 1)[-1].rsplit(".", 1)[0],
        "capturedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sheets": {ws.title: sheet_grid(ws) for ws in wb.worksheets if ws.sheet_state == "visible"},
    }
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    sizes = {k: len(v) for k, v in payload["sheets"].items()}
    print(f"wrote {out}: {sizes}")


if __name__ == "__main__":
    main()
