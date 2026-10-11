import { buildTournament, fingerprint } from '../shared/parse';
import type { EventData, Tournament, Workbook } from '../shared/types';
import snapshot from '../data/snapshot.grids.json';
import { fetchWorkbook, sheetMode, type SheetEnv } from './sheets';

export interface Env extends SheetEnv {
  ASSETS: Fetcher;
  CACHE?: KVNamespace;
}

// Bump when the JSON shape changes, so a new deploy never serves data cached by the old one.
const KEY = 'tournament:v4';
// The previous version's data, served only if the first sync after a deploy fails.
const PREVIOUS_KEY = 'tournament:v3';
const MEMO_MS = 15_000;

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
  hash: string;
}

// Per-isolate memo so busy pages don't read KV on every poll.
let memo: { at: number; data: Stored } | null = null;
let snapshotMemo: Stored | null = null;
let lastError: { at: string; message: string } | null = null;

function snapshotData(): Stored {
  if (!snapshotMemo) {
    const t = buildTournament(snapshot as unknown as Workbook, {
      kind: 'snapshot',
      label: 'Uploaded workbook',
    });
    t.generatedAt = (snapshot as { capturedAt?: string }).capturedAt ?? t.generatedAt;
    snapshotMemo = { body: JSON.stringify(t), hash: fingerprint(t) };
  }
  return snapshotMemo;
}

/** Pulls the sheet, and writes KV only if the content changed. */
async function refresh(env: Env): Promise<Stored | null> {
  if (sheetMode(env) === 'none') return null;
  try {
    const { wb, mode } = await fetchWorkbook(env);
    const t: Tournament = buildTournament(wb, {
      kind: mode,
      label: mode === 'sheets-api' ? 'Google Sheets' : 'Google Sheets (CSV)',
    });
    if (!t.events.length) throw new Error('No event tabs found in the sheet');
    const hash = fingerprint(t);
    const prev = env.CACHE ? await env.CACHE.getWithMetadata<{ hash: string }>(KEY, 'text') : null;
    if (prev?.value && prev.metadata?.hash === hash) {
      const data = { body: prev.value, hash };
      memo = { at: Date.now(), data };
      lastError = null;
      return data;
    }
    const body = JSON.stringify(t);
    if (env.CACHE) {
      try {
        await env.CACHE.put(KEY, body, { metadata: { hash } });
      } catch (err) {
        // Still serve the fresh data; the next sync writes it again.
        console.warn('cache write failed', err instanceof Error ? err.message : String(err));
      }
    }
    const data = { body, hash };
    memo = { at: Date.now(), data };
    lastError = null;
    return data;
  } catch (err) {
    lastError = { at: new Date().toISOString(), message: err instanceof Error ? err.message : String(err) };
    console.error('refresh failed', lastError.message);
    return null;
  }
}

async function current(env: Env): Promise<Stored> {
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.data;
  if (sheetMode(env) !== 'none') {
    if (env.CACHE) {
      const kv = await env.CACHE.getWithMetadata<{ hash: string }>(KEY, { type: 'text', cacheTtl: 30 });
      if (kv.value) {
        const data = { body: kv.value, hash: kv.metadata?.hash ?? '' };
        memo = { at: Date.now(), data };
        return data;
      }
    }
    const fresh = await refresh(env);
    if (fresh) return fresh;
    if (env.CACHE) {
      const old = await env.CACHE.getWithMetadata<{ hash: string }>(PREVIOUS_KEY, { type: 'text', cacheTtl: 30 });
      if (old.value) return { body: old.value, hash: old.metadata?.hash ?? 'previous' };
    }
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/tournament') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405);
      const data = await current(env);
      const etag = `"${data.hash}"`;
      const headers = {
        ...baseHeaders,
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=10',
        etag,
      };
      if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
      return new Response(request.method === 'HEAD' ? null : data.body, { headers });
    }

    if (url.pathname === '/api/health') {
      const mode = sheetMode(env);
      const data = await current(env);
      const t = JSON.parse(data.body) as Tournament;
      return json({
        ok: true,
        source: t.source,
        sheetConfigured: mode !== 'none',
        mode,
        storage: env.CACHE ? 'kv' : 'memory',
        generatedAt: t.generatedAt,
        events: t.events.map((e) => ({
          id: e.id,
          name: e.name,
          players: e.roster.length,
          groupDraw: describeDraw(e),
          groups: e.groups.length,
          brackets: e.brackets.map((b) => `${b.id} ${b.format}${b.fromBracket ? `, losers from ${b.fromBracket}` : ''}`),
        })),
        warnings: t.warnings,
        lastError,
      });
    }

    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refresh(env));
  },
} satisfies ExportedHandler<Env>;
