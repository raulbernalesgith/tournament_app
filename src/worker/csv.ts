import type { Grid } from '../shared/types';

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(input: string): Grid {
  const rows: Grid = [];
  let row: (string | null)[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const endField = () => {
    row.push(field === '' ? null : field);
    field = '';
  };
  const endRow = () => {
    endField();
    while (row.length && row[row.length - 1] === null) row.pop();
    rows.push(row);
    row = [];
  };

  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
    } else if (ch === ',') {
      endField();
      i += 1;
    } else if (ch === '\r') {
      endRow();
      i += s[i + 1] === '\n' ? 2 : 1;
    } else if (ch === '\n') {
      endRow();
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field !== '' || row.length) endRow();
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}
