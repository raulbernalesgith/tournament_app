import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import wb1009 from './fixtures/workbook-2026-10-09.grids.json';
import { isBundle, tournamentOf } from '../src/shared/bundle';
import { buildTournament } from '../src/shared/parse';
import type { Cell, Grid, SheetBundle, Tournament, Workbook } from '../src/shared/types';
import { discoverTabs } from '../src/worker/sheets';
import { SHEET_KEY, STATUS_KEY, TABS_KEY, refreshTabs, runSync, syncSheet, type SheetMeta, type SyncStatus } from '../src/worker/sync';
import { v5Tab } from './v5';
import { higherRatedWins, teams, v7DoublesTab } from './v7';

const ID = '1cqvNfhwlMaAvOO6696o08gObT_MgPyOseBG6XjAtUcQ';
const rankings = (wb1009 as unknown as Workbook).sheets['Canada_Rankings'];

/** What the CSV export gives back. */
const toCsv = (g: Grid) =>
  g
    .map((row) =>
      row
        .map((v: Cell) => {
          if (v == null) return '';
          const s = typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    )
    .join('\r\n');

/** In-memory KV with the calls the Worker makes. */
class FakeKV {
  store = new Map<string, { value: string; metadata: unknown }>();
  writes: string[] = [];
  async get(key: string, opts?: string | { type?: string }) {
    const e = this.store.get(key);
    if (!e) return null;
    const type = typeof opts === 'string' ? opts : opts?.type ?? 'text';
    return type === 'json' ? JSON.parse(e.value) : e.value;
  }
  async getWithMetadata(key: string, opts?: string | { type?: string }) {
    const e = this.store.get(key);
    if (!e) return { value: null, metadata: null };
    const type = typeof opts === 'string' ? opts : opts?.type ?? 'text';
    const value = type === 'json' ? JSON.parse(e.value) : type === 'arrayBuffer' ? new TextEncoder().encode(e.value).buffer : e.value;
    return { value, metadata: e.metadata ?? null };
  }
  async put(key: string, value: string, opts?: { metadata?: unknown }) {
    this.writes.push(key);
    this.store.set(key, { value, metadata: opts?.metadata ?? null });
  }
}

interface FakeTab {
  title: string;
  gid: string;
  csv: string;
  status?: number;
  html?: boolean;
  cutOff?: boolean;
  hidden?: boolean;
}

/** A link-shared sheet as Google serves it: the HTML view (tab menu, then every tab's cells) and the CSV export. */
function fakeGoogle(tabs: FakeTab[], opts: { menuLast?: boolean } = {}) {
  const calls = { htmlview: 0, csv: 0, chunksRead: 0 };
  const enc = new TextEncoder();
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/htmlview')) {
      calls.htmlview += 1;
      const menu = `<div id="top-bar"><ul id="sheet-menu">${tabs
        .filter((t) => t.status !== 404 && !t.hidden)
        .map((t) => `<li id="sheet-button-${t.gid}"><a href="#">${t.title}</a></li>`)
        .join('')}</ul></div>`;
      const filler = '<table>' + '<tr><td class="s0">cell</td></tr>'.repeat(20000) + '</table>';
      const cells = Array.from({ length: 50 }, () => filler);
      const chunks = opts.menuLast ? ['<html><body>', ...cells, menu + '</body></html>'] : ['<html><body>' + menu, ...cells, '</body></html>'];
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (i < chunks.length) {
            calls.chunksRead += 1;
            c.enqueue(enc.encode(chunks[i++]));
          } else c.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    const m = /\/d\/([^/]+)\/export\?format=csv&gid=(\d+)$/.exec(url);
    if (m) {
      calls.csv += 1;
      const t = tabs.find((x) => x.gid === m[2]);
      if (!t || t.status === 404) return new Response('Not found', { status: 404 });
      if (t.status) return new Response('Too many requests', { status: t.status });
      if (t.html) return new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      if (t.cutOff) {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(t.csv.slice(0, 20)));
            c.error(new Error('connection reset'));
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/csv' } });
      }
      return new Response(t.csv, { status: 200, headers: { 'content-type': 'text/csv' } });
    }
    return new Response('?', { status: 500 });
  });
  return { fetch, calls };
}

/** The live sheet's tabs (gids from the sheet), with test contents. */
function sheetTabs(): FakeTab[] {
  return [
    { title: 'Canada_Rankings', gid: '0', csv: toCsv(rankings) },
    { title: 'Open_Singles', gid: '1255341360', csv: toCsv(v5Tab({ drawLabel: 'Serpentine' })) },
    { title: 'Open_Doubles', gid: '1273910901', csv: toCsv(v7DoublesTab({ teams: teams(9), mode: 2, score: higherRatedWins({ A: 1 }) })) },
  ];
}

/** 15:00 UTC: an even minute, and one divisible by 10. */
const T0 = Date.parse('2026-10-12T15:00:00Z');
const MIN = 60_000;

let kv: FakeKV;
const env = () => ({ SHEET_ID: ID, CACHE: kv as unknown as KVNamespace });
const saved = () => JSON.parse(kv.store.get(SHEET_KEY)!.value) as SheetBundle;
const status = () => JSON.parse(kv.store.get(STATUS_KEY)!.value) as SyncStatus;

beforeEach(() => {
  kv = new FakeKV();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sync: download, compare, save on change', () => {
  it('finds the tabs, downloads them and saves them once; an unchanged sheet writes nothing', async () => {
    const tabs = sheetTabs();
    const g = fakeGoogle(tabs);
    vi.stubGlobal('fetch', g.fetch);

    const first = await runSync(env(), T0);
    expect(first).toMatchObject({ changed: true, saved: true, deferred: false, failed: [] });
    expect(kv.writes).toEqual([TABS_KEY, SHEET_KEY, STATUS_KEY]);
    expect(saved().source).toEqual({ kind: 'sheets-csv', label: 'Google Sheets (CSV)' });
    expect(saved().changedAt).toBe(new Date(T0).toISOString());
    expect(saved().tabs.map((t) => [t.title, t.gid])).toEqual(tabs.map((t) => [t.title, t.gid]));
    expect(saved().tabs.map((t) => t.csv)).toEqual(tabs.map((t) => t.csv));
    // The tab menu comes first in the HTML view, so the rest of the page isn't read.
    expect(g.calls.chunksRead).toBeLessThan(5);

    kv.writes = [];
    expect(await runSync(env(), T0 + MIN)).toMatchObject({ changed: false, saved: false });
    expect(await runSync(env(), T0 + 2 * MIN)).toMatchObject({ changed: false, saved: false });
    expect(kv.writes).toEqual([]);
    expect(g.calls.htmlview).toBe(1); // the tab list is re-read only by the 10-minute job
  });

  it('builds the same tournament in the browser as from the cells', async () => {
    vi.stubGlobal('fetch', fakeGoogle(sheetTabs()).fetch);
    await runSync(env(), T0);
    const bundle = saved();
    const t = tournamentOf(bundle);
    const direct = buildTournament(
      { title: 'x', sheets: { Canada_Rankings: rankings, Open_Singles: v5Tab({ drawLabel: 'Serpentine' }), Open_Doubles: v7DoublesTab({ teams: teams(9), mode: 2, score: higherRatedWins({ A: 1 }) }) } },
      bundle.source,
      new Date(bundle.changedAt),
    );
    expect(t).toEqual(direct);
    expect(t.events.map((e) => e.id)).toEqual(['open-singles', 'open-doubles']);
    expect(t.generatedAt).toBe(bundle.changedAt);
  });

  it('saves changes on even minutes only, which caps saves at 720 a day', async () => {
    const tabs = sheetTabs();
    vi.stubGlobal('fetch', fakeGoogle(tabs).fetch);
    await runSync(env(), T0);
    const edit = (n: number) => {
      tabs[1].csv += `\r\nedit ${n}`;
    };
    edit(1);
    expect(await syncSheet(env(), T0 + MIN)).toMatchObject({ changed: true, saved: false, deferred: true });
    expect(await syncSheet(env(), T0 + 2 * MIN)).toMatchObject({ changed: true, saved: true });
    expect(kv.store.get(SHEET_KEY)!.metadata as SheetMeta).toMatchObject({ changedAt: new Date(T0 + 2 * MIN).toISOString(), writtenAt: T0 + 2 * MIN });
    edit(2);
    expect(await syncSheet(env(), T0 + 3 * MIN)).toMatchObject({ deferred: true });
    expect(await syncSheet(env(), T0 + 4 * MIN)).toMatchObject({ saved: true });
    expect(saved().tabs[1].csv).toMatch(/edit 2$/);
  });

  it('keeps the last copy of a tab Google refuses for a moment, and reports it', async () => {
    const tabs = sheetTabs();
    vi.stubGlobal('fetch', fakeGoogle(tabs).fetch);
    await runSync(env(), T0);
    const before = saved();
    tabs[2].status = 429;
    tabs[1].csv += '\r\nnew result';
    const r = await runSync(env(), T0 + 20 * MIN);
    expect(r).toMatchObject({ saved: true, failed: ['CSV export for "Open_Doubles" failed: 429'] });
    expect(saved().tabs.map((t) => t.title)).toEqual(['Canada_Rankings', 'Open_Singles', 'Open_Doubles']);
    expect(saved().tabs[2].csv).toBe(before.tabs[2].csv);
    expect(saved().tabs[1].csv).toMatch(/new result$/);
    expect(status()).toMatchObject({ state: 'error', message: 'CSV export for "Open_Doubles" failed: 429' });
  });

  it('treats a download cut off midway as that tab failing, and still saves the others', async () => {
    const tabs = sheetTabs();
    vi.stubGlobal('fetch', fakeGoogle(tabs).fetch);
    await runSync(env(), T0);
    tabs[2].cutOff = true;
    tabs[1].csv += '\r\nnew result';
    const r = await syncSheet(env(), T0 + 2 * MIN);
    expect(r.saved).toBe(true);
    expect(r.failed).toEqual([expect.stringContaining('"Open_Doubles" was cut off')]);
    expect(saved().tabs[1].csv).toMatch(/new result$/);
  });

  it('re-reads the tab list when a tab is gone, and downloads only what is new', async () => {
    const tabs = sheetTabs();
    const g = fakeGoogle(tabs);
    vi.stubGlobal('fetch', g.fetch);
    await runSync(env(), T0);
    tabs[2].status = 404; // deleted
    const r = await runSync(env(), T0 + 6 * MIN);
    expect(r).toMatchObject({ saved: true, failed: [] });
    expect([g.calls.htmlview, g.calls.csv]).toEqual([2, 6]);
    expect(JSON.parse(kv.store.get(TABS_KEY)!.value)).toEqual([
      { title: 'Canada_Rankings', gid: '0' },
      { title: 'Open_Singles', gid: '1255341360' },
    ]);
    expect(saved().tabs.map((t) => t.title)).toEqual(['Canada_Rankings', 'Open_Singles']);
  });

  it('after a tab is gone, downloads only new tabs, not ones refused for another reason', async () => {
    const tabs = sheetTabs();
    const g = fakeGoogle(tabs);
    vi.stubGlobal('fetch', g.fetch);
    await runSync(env(), T0);
    tabs[2].status = 404;
    tabs[1].status = 429;
    tabs.push({ title: 'Mixed_Doubles', gid: '777', csv: toCsv(v5Tab()) });
    const r = await syncSheet(env(), T0 + 2 * MIN);
    // 3 downloads, the tab list, then only the new Mixed_Doubles tab.
    expect([g.calls.htmlview, g.calls.csv]).toEqual([2, 3 + 3 + 1]);
    expect(r.failed).toEqual(['CSV export for "Open_Singles" failed: 429']);
    expect(saved().tabs.map((t) => t.title)).toEqual(['Canada_Rankings', 'Open_Singles', 'Mixed_Doubles']);
  });

  it('drops a tab the tab list no longer shows (hidden or deleted)', async () => {
    const tabs = sheetTabs();
    vi.stubGlobal('fetch', fakeGoogle(tabs).fetch);
    await runSync(env(), T0);
    tabs[2].hidden = true;
    const list = await refreshTabs(env(), JSON.parse(kv.store.get(TABS_KEY)!.value));
    expect(list.map((t) => t.title)).toEqual(['Canada_Rankings', 'Open_Singles']);
    await runSync(env(), T0 + 2 * MIN);
    expect(saved().tabs.map((t) => t.title)).toEqual(['Canada_Rankings', 'Open_Singles']);
  });

  it('records a failing sync (sign-in page) without touching the saved tabs', async () => {
    const tabs = sheetTabs();
    vi.stubGlobal('fetch', fakeGoogle(tabs).fetch);
    await runSync(env(), T0);
    const before = kv.store.get(SHEET_KEY)!.value;
    tabs.forEach((t) => (t.html = true));
    expect(await runSync(env(), T0 + MIN)).toBeNull();
    // The status is written on minutes divisible by 10.
    expect(status()).toMatchObject({ state: 'ok' });
    expect(await runSync(env(), T0 + 10 * MIN)).toBeNull();
    expect(status()).toMatchObject({
      state: 'error',
      since: new Date(T0 + 10 * MIN).toISOString(),
      message: expect.stringContaining('share the sheet with "anyone with the link"'),
    });
    expect(kv.store.get(SHEET_KEY)!.value).toBe(before);
  });

  it('writes a heartbeat every 30 minutes while all is well', async () => {
    vi.stubGlobal('fetch', fakeGoogle(sheetTabs()).fetch);
    for (let m = 0; m <= 61; m += 1) await runSync(env(), T0 + m * MIN);
    expect(kv.writes.filter((k) => k === STATUS_KEY)).toHaveLength(3); // minutes 0, 30, 60
    expect(status()).toMatchObject({ state: 'ok', since: new Date(T0).toISOString(), checkedAt: new Date(T0 + 60 * MIN).toISOString() });
    expect(kv.writes.filter((k) => k === SHEET_KEY)).toHaveLength(1);
  });

  it('stays under the KV write limit when a cell changes every minute and an error comes and goes', async () => {
    const tabs = sheetTabs();
    vi.stubGlobal('fetch', fakeGoogle(tabs).fetch);
    for (let m = 0; m < 24 * 60; m += 1) {
      tabs[1].csv += `\r\ntick ${m}`;
      tabs[2].status = m % 2 ? 429 : undefined;
      await runSync(env(), T0 + m * MIN);
    }
    expect(kv.writes.length).toBeLessThanOrEqual(720 + 144 + 1);
  });

  it('stops reading the tab-list page once the menu has closed', async () => {
    const tabs = sheetTabs();
    const g = fakeGoogle(tabs);
    vi.stubGlobal('fetch', g.fetch);
    expect(await discoverTabs(ID)).toHaveLength(3);
    expect(g.calls.chunksRead).toBeLessThan(5);
    tabs.push({ title: 'Mixed_Doubles', gid: '777', csv: '' });
    expect((await discoverTabs(ID)).map((t) => t.title)).toContain('Mixed_Doubles');
  });

  it('reads the rest of the page in one go when the menu is not near the start', async () => {
    const g = fakeGoogle(sheetTabs(), { menuLast: true });
    vi.stubGlobal('fetch', g.fetch);
    expect((await discoverTabs(ID)).map((t) => t.title)).toEqual(['Canada_Rankings', 'Open_Singles', 'Open_Doubles']);
    expect(g.calls.chunksRead).toBe(52);
  });
});

describe('Worker routes', () => {
  let worker: (typeof import('../src/worker/index'))['default'];
  // A fresh Worker module per test: it keeps a short per-isolate cache.
  beforeEach(async () => {
    vi.resetModules();
    worker = (await import('../src/worker/index')).default;
  });
  const assets = { fetch: async () => new Response('app') } as unknown as Fetcher;
  const reqCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const call = (path: string, headers: Record<string, string> = {}) =>
    worker.fetch(new Request(`https://tournament-app.example${path}`, { headers }), { ...env(), ASSETS: assets }, reqCtx);

  it('serves the saved tabs with an ETag, syncing first if nothing is saved yet', async () => {
    vi.stubGlobal('fetch', fakeGoogle(sheetTabs()).fetch);
    const res = await call('/api/sheet');
    expect(res.status).toBe(200);
    const etag = res.headers.get('etag')!;
    const bundle = (await res.json()) as SheetBundle;
    expect(bundle.tabs).toHaveLength(3);
    expect(kv.store.has(SHEET_KEY)).toBe(true);
    const again = await call('/api/sheet', { 'if-none-match': etag });
    expect(again.status).toBe(304);
  });

  it('gives requests arriving together right after a deploy one shared sync, never the old data', async () => {
    const g = fakeGoogle(sheetTabs());
    vi.stubGlobal('fetch', g.fetch);
    kv.store.set('tournament:v4', { value: JSON.stringify({ version: 1, events: [] }), metadata: null });
    const all = await Promise.all([1, 2, 3, 4].map(() => call('/api/sheet')));
    const bodies = await Promise.all(all.map((r) => r.json()));
    expect(bodies.every(isBundle)).toBe(true);
    expect(new Set(all.map((r) => r.headers.get('etag'))).size).toBe(1);
    expect(g.calls.csv).toBe(3);
  });

  it('asks pages from before this version to reload, once (no toast every poll)', async () => {
    const res = await call('/api/tournament');
    const t = (await res.json()) as Tournament;
    expect(t.events.map((e) => e.name)).toEqual(['Reload this page for live results']);
    expect(t.source.kind).toBe('sheets-csv');
    expect((await call('/api/tournament', { 'if-none-match': res.headers.get('etag')! })).status).toBe(304);
  });

  it('reports the sync in /api/health, and the events only when asked', async () => {
    vi.stubGlobal('fetch', fakeGoogle(sheetTabs()).fetch);
    await runSync(env(), Date.now());
    const h = (await (await call('/api/health')).json()) as Record<string, any>;
    expect(h).toMatchObject({ ok: true, mode: 'sheets-csv', serving: 'sheet', sync: { state: 'ok', stale: false } });
    expect(h.sheet.tabs).toEqual(['Canada_Rankings (gid 0)', 'Open_Singles (gid 1255341360)', 'Open_Doubles (gid 1273910901)']);
    expect(h.events).toBeUndefined();
    const full = (await (await call('/api/health?events=1')).json()) as Record<string, any>;
    expect(full.events.map((e: { id: string; groupDraw: string }) => [e.id, e.groupDraw])).toEqual([
      ['open-singles', 'serpentine draw, the only draw on the tab'],
      ['open-doubles', 'no group stage, straight to the knockout'],
    ]);
  });

  it('runs the sync every minute and the tab list every 10 minutes', async () => {
    const g = fakeGoogle(sheetTabs());
    vi.stubGlobal('fetch', g.fetch);
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const fire = async (cron: string) => {
      await worker.scheduled({ cron, scheduledTime: Date.now(), noRetry() {} } as ScheduledController, { ...env(), ASSETS: assets }, ctx);
      await Promise.all(waits.splice(0));
    };
    await fire('* * * * *');
    expect([g.calls.htmlview, g.calls.csv]).toEqual([1, 3]); // first run: no tab list saved yet
    await fire('* * * * *');
    expect([g.calls.htmlview, g.calls.csv]).toEqual([1, 6]);
    await fire('*/10 * * * *');
    expect([g.calls.htmlview, g.calls.csv]).toEqual([2, 6]);
  });
});
