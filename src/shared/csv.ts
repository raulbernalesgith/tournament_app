import type { Grid } from './types';

/**
 * RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). Runs of plain
 * text are copied in one slice rather than character by character, since the
 * app parses every tab in the browser each time the sheet changes. Trailing
 * empty cells are dropped from each row, and trailing empty rows at the end.
 */
export function parseCsv(input: string): Grid {
  const s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const n = s.length;
  const rows: Grid = [];
  let row: (string | null)[] = [];
  let field = '';
  let i = 0;

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

  while (i < n) {
    let j = i;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 44 || c === 10 || c === 13 || c === 34) break; // , \n \r "
      j += 1;
    }
    if (j > i) field += s.slice(i, j);
    if (j >= n) break;
    const c = s.charCodeAt(j);
    if (c === 34) {
      // Quoted run up to the closing quote; "" is a literal quote.
      let k = j + 1;
      for (;;) {
        const q = s.indexOf('"', k);
        if (q < 0) {
          field += s.slice(k);
          k = n;
          break;
        }
        field += s.slice(k, q);
        if (s.charCodeAt(q + 1) === 34) {
          field += '"';
          k = q + 2;
          continue;
        }
        k = q + 1;
        break;
      }
      i = k;
    } else if (c === 44) {
      endField();
      i = j + 1;
    } else {
      endRow();
      i = c === 13 && s.charCodeAt(j + 1) === 10 ? j + 2 : j + 1;
    }
  }
  if (field !== '' || row.length) endRow();
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}
