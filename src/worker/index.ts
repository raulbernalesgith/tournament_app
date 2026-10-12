import snapshot from '../data/snapshot.grids.json';
import { isBundle, tournamentOf } from '../shared/bundle';
import type { EventData, Grid, SheetBundle, Tournament } from '../shared/types';
import { sheetMode, type TabRef } from './sheets';
import { HEARTBEAT_MS, SHEET_KEY, STATUS_KEY, readTabs, refreshTabs, runSync, type SheetMeta, type SyncEnv, type SyncStatus } from './sync';

export interface Env extends SyncEnv {
  ASSETS: Fetcher;
}

/** Must match the second cron in wrangler.jsonc: re-reads the tab list so new event tabs show up. */
const DISCOVER_CRON = '*/10 * * * *';
/** The previous version's data (already built), served only until the first sync after this deploy has saved the tabs. */
const LEGACY_KEY = 'tournament:v4';
const MEMO_MS = 15_000;

/** What the old endpoint returns: an "event" the previous version of the app can show, asking to reload. */
const reload = (): Tournament => ({
  version: 1,
  generatedAt: new Date().toISOString(),
  source: { kind: 'sheets-csv', label: 'Google Sheets (CSV)' },
  rankCount: 0,
  players: {},
  events: [
    {
      id: 'reload',
      name: 'Reload this page for live results',
      tab: 'reload',
      roster: [],
      knockoutOnly: false,
      teams: false,
      byes: [],
      draw: 1,
      drawName: null,
      drawBy: 'single',
      groups: [],
      brackets: [],
    },
  ],
  warnings: [],
});
/** The old app polls with If-None-Match: answer 304 after the first time, so it doesn't flash "Results updated". */
const RELOAD_ETAG = '"reload-1"';

const DRAW_REASON: Record<EventData['drawBy'], string> = {
  single: 'the only draw on the tab',
  results: 'the one with results entered',
  brackets: 'matches the bracket labels',
  default: 'default',
};

/** How /api/health describes an event's group draw. */
function describeDraw(e: EventData): string {
  if (e.knockoutOnly) return 'no group stage, straight to the knockout';
  if (!e.groups.length) return 'not drawn yet';
  const name = e.drawName ? `${e.drawName} draw` : 'group draw (type not written on the sheet)';
  return `${name}, ${DRAW_REASON[e.drawBy] ?? 'previous version'}`;
}

interface Stored {
  body: string;
  etag: string;
  meta: SheetMeta | null;
  served: 'sheet' | 'legacy' | 'snapshot';
}

// Per-isolate memo so busy pages don't read KV on every poll.
let memo: { at: number; data: Stored } | null = null;
let snapshotMemo: Stored | null = null;
/** A sync started by a request, shared by requests that arrive while it runs. */
let pending: Promise<Stored | null> | null = null;

/** A short content hash for ETags. */
function quickHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 16777619);
    h2 = Math.imul(h2 ^ ch, 2246822519);
  }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
}

function snapshotData(): Stored {
  if (!snapshotMemo) {
    const s = snapshot as unknown as { capturedAt?: string; sheets: Record<string, Grid> };
    const bundle: SheetBundle = {
      version: 1,
      source: { kind: 'snapshot', label: 'Uploaded workbook' },
      changedAt: s.capturedAt ?? new Date(0).toISOString(),
      tabs: Object.entries(s.sheets).map(([title, grid]) => ({ title, grid })),
    };
    const body = JSON.stringify(bundle);
    snapshotMemo = { body, etag: `"snapshot-${quickHash(body)}"`, meta: null, served: 'snapshot' };
  }
  return snapshotMemo;
}

async function current(env: Env, ctx?: ExecutionContext): Promise<Stored> {
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.data;
  if (sheetMode(env) === 'none') return snapshotData();
  if (env.CACHE) {
    const kv = await env.CACHE.getWithMetadata<SheetMeta>(SHEET_KEY, { type: 'text', cacheTtl: 30 });
    if (kv.value) {
      const data: Stored = { body: kv.value, etag: `"${kv.metadata?.hash ?? kv.value.length}"`, meta: kv.metadata ?? null, served: 'sheet' };
      memo = { at: Date.now(), data };
      return data;
    }
  }
  // Nothing saved yet (just deployed): sync now (it only downloads), once per isolate however many requests wait.
  pending ??= (async () => {
    const outcome = await runSync(env, Date.now(), { wantBundle: true });
    if (!outcome?.bundle) return null;
    return { body: JSON.stringify(outcome.bundle), etag: `"${outcome.hash}"`, meta: outcome.meta ?? null, served: 'sheet' as const };
  })().finally(() => {
    pending = null;
  });
  // Keep the shared sync going even if the request that started it goes away.
  ctx?.waitUntil(pending.catch(() => null));
  const synced = await pending;
  if (synced) {
    memo = { at: Date.now(), data: synced };
    return synced;
  }
  if (env.CACHE) {
    const old = await env.CACHE.get(LEGACY_KEY, { type: 'text', cacheTtl: 30 });
    if (old) return { body: old, etag: '"legacy"', meta: null, served: 'legacy' };
  }
  return snapshotData();
}

const baseHeaders = {
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...baseHeaders, ...extra },
  });
}

const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : null);

async function health(env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const mode = sheetMode(env);
  const data = await current(env, ctx);
  const [status, tabs] = env.CACHE
    ? await Promise.all([env.CACHE.get<SyncStatus>(STATUS_KEY, 'json'), readTabs(env)])
    : [null, null as TabRef[] | null];
  const now = Date.now();
  const out: Record<string, unknown> = {
    ok: true,
    mode,
    storage: env.CACHE ? 'kv' : 'memory',
    serving: data.served,
    sheet: data.meta
      ? { changedAt: data.meta.changedAt, savedAt: iso(data.meta.writtenAt), bytes: data.meta.bytes, tabs: (tabs ?? []).map((t) => `${t.title} (gid ${t.gid})`) }
      : null,
    sync: status
      ? {
          state: status.state,
          since: status.since,
          checkedAt: status.checkedAt,
          ...(status.message ? { message: status.message } : {}),
          // A healthy sync reports every 30–40 minutes; over an hour means runs aren't happening.
          stale: now - Date.parse(status.checkedAt) > HEARTBEAT_MS + 30 * 60_000,
        }
      : { state: 'unknown' },
  };
  // Building the events is the heavy part, so it only happens when asked for.
  if (url.searchParams.has('events')) {
    const parsed = JSON.parse(data.body) as unknown;
    const t: Tournament = isBundle(parsed) ? tournamentOf(parsed) : (parsed as Tournament);
    out.events = t.events.map((e) => ({
      id: e.id,
      name: e.name,
      players: e.roster.length,
      groupDraw: describeDraw(e),
      groups: e.groups.length,
      brackets: e.brackets.map((b) => `${b.id} ${b.format}${b.fromBracket ? `, losers from ${b.fromBracket}` : ''}`),
    }));
    out.warnings = t.warnings;
  }
  return json(out);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/sheet') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405);
      const data = await current(env, ctx);
      const headers = {
        ...baseHeaders,
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=10',
        etag: data.etag,
      };
      if (request.headers.get('if-none-match') === data.etag) return new Response(null, { status: 304, headers });
      return new Response(request.method === 'HEAD' ? null : data.body, { headers });
    }

    // Pages opened before this version poll the old endpoint: show them a note to reload instead of freezing.
    if (url.pathname === '/api/tournament') {
      if (request.headers.get('if-none-match') === RELOAD_ETAG) return new Response(null, { status: 304, headers: { ...baseHeaders, etag: RELOAD_ETAG } });
      return json(reload(), 200, { etag: RELOAD_ETAG });
    }

    if (url.pathname === '/api/health') return health(env, url, ctx);

    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (sheetMode(env) === 'none') return;
    if (controller.cron === DISCOVER_CRON) {
      ctx.waitUntil(
        (async () => {
          if (sheetMode(env) !== 'sheets-csv') return;
          try {
            await refreshTabs(env, await readTabs(env));
          } catch (err) {
            console.warn('tab list refresh failed', err instanceof Error ? err.message : String(err));
          }
        })(),
      );
      return;
    }
    ctx.waitUntil(runSync(env, Date.now()));
  },
} satisfies ExportedHandler<Env>;
