/**
 * The once-a-minute sync. It only downloads: each tab's CSV export is fetched
 * as raw bytes and hashed, and the tabs are saved to KV when the hash changes.
 * Building groups and brackets happens in the browser (see shared/bundle.ts),
 * so a run costs about 3 ms of CPU (measured in workerd with 7 tabs), inside
 * the Workers Free plan's 10 ms per Cron Trigger.
 *
 * KV writes stay under the free plan's 1,000 a day by the clock, whatever the
 * sheet does: the tabs are saved only on even minutes (at most 720 a day), the
 * sync status only on minutes divisible by 10 (at most 144), and the tab list
 * only when it changes.
 */
import type { SheetBundle, SheetTab, SourceKind } from '../shared/types';
import { discoverTabs, downloadTab, fetchViaApi, parseTabs, sheetMode, type SheetEnv, type TabDownload, type TabRef } from './sheets';

export interface SyncEnv extends SheetEnv {
  CACHE?: KVNamespace;
}

export const SHEET_KEY = 'sheet:v1';
export const TABS_KEY = 'tabs:v1';
export const STATUS_KEY = 'status:v1';

/** Tabs are saved on minutes divisible by this (so a change shows within about 2 minutes). */
export const SAVE_EVERY_MIN = 2;
/** The sync status is written on minutes divisible by this, when it changed or the heartbeat is due. */
export const STATUS_EVERY_MIN = 10;
/** A healthy sync reports at least this often, so /api/health can tell when runs stop happening. */
export const HEARTBEAT_MS = 30 * 60_000;

/** Stored with the tabs (KV metadata), so a run can compare without reading them. */
export interface SheetMeta {
  hash: string;
  changedAt: string;
  /** When this copy was written (ms). */
  writtenAt: number;
  bytes: number;
}

export interface SyncStatus {
  state: 'ok' | 'error';
  /** When the sync was first seen in this state (to within STATUS_EVERY_MIN). */
  since: string;
  /** The last run that wrote this status. */
  checkedAt: string;
  message?: string;
  /** ms */
  writtenAt: number;
}

export interface SyncOutcome {
  /** The content differs from the stored copy. */
  changed: boolean;
  /** Written to KV this run. */
  saved: boolean;
  /** Changed, but this isn't a saving minute: a later run saves it. */
  deferred: boolean;
  /** What was downloaded: always with `wantBundle` or without KV, otherwise when saved. */
  bundle: SheetBundle | null;
  /** Tabs that couldn't be downloaded this run (their previous copy was kept, if any). */
  failed: string[];
  /** Hash of what was downloaded (the ETag). */
  hash: string;
  /** What was stored with the tabs, when they were saved this run. */
  meta?: SheetMeta;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const minuteOf = (ms: number) => Math.floor(ms / 60_000);

async function sha1(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
  return Array.from(d.slice(0, 10), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** One buffer of every tab's identity and bytes, in order, for a single hash. */
function joined(parts: { title: string; gid?: string; bytes: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const heads = parts.map((p) => encoder.encode(`\u0000${p.title}\u0000${p.gid ?? ''}\u0000`));
  const size = parts.reduce((n, p, i) => n + heads[i].length + p.bytes.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  parts.forEach((p, i) => {
    out.set(heads[i], at);
    at += heads[i].length;
    out.set(p.bytes, at);
    at += p.bytes.length;
  });
  return out;
}

const sameTabs = (a: TabRef[] | null, b: TabRef[]) =>
  !!a && a.length === b.length && a.every((t, i) => t.title === b[i].title && t.gid === b[i].gid);

/** Re-reads the sheet's tab list (new, renamed, hidden and deleted tabs) and saves it if it changed. */
export async function refreshTabs(env: SyncEnv, known: TabRef[] | null): Promise<TabRef[]> {
  const found = await discoverTabs(env.SHEET_ID!);
  if (!found.length) throw new Error('Could not find the sheet tabs; set SHEET_TABS to "tab=gid" pairs');
  if (env.CACHE && !sameTabs(known, found)) await env.CACHE.put(TABS_KEY, JSON.stringify(found));
  return found;
}

export async function readTabs(env: SyncEnv): Promise<TabRef[] | null> {
  const tabs = env.CACHE ? await env.CACHE.get<TabRef[]>(TABS_KEY, 'json') : null;
  return tabs && tabs.length ? tabs : null;
}

async function storedSheet(env: SyncEnv): Promise<{ meta: SheetMeta | null; bytes: ArrayBuffer | null }> {
  if (!env.CACHE) return { meta: null, bytes: null };
  const r = await env.CACHE.getWithMetadata<SheetMeta>(SHEET_KEY, 'arrayBuffer');
  return { meta: r.value ? r.metadata ?? null : null, bytes: r.value };
}

const sourceOf = (kind: Exclude<SourceKind, 'snapshot'>) => ({
  kind,
  label: kind === 'sheets-api' ? 'Google Sheets' : 'Google Sheets (CSV)',
});

type Part = { title: string; gid?: string; bytes: Uint8Array; tab: SheetTab | null; failed?: boolean };

/** Downloads the tabs; a tab that's gone (400/404) makes it re-read the tab list once and fetch only what's new. */
async function downloadAll(env: SyncEnv, discover: boolean): Promise<{ parts: Part[]; failed: string[] }> {
  let tabs = await readTabs(env);
  let discovered = false;
  if (discover || !tabs) {
    try {
      tabs = await refreshTabs(env, tabs);
      discovered = true;
    } catch (err) {
      if (!tabs) {
        // SHEET_TABS is the backup when the tab list can't be read.
        const configured = parseTabs(env.SHEET_TABS ?? '');
        if (!configured.length) throw err;
        tabs = configured;
      }
    }
  }
  const results = new Map<string, TabDownload>();
  // Downloads tabs not tried yet this run (after a re-read of the list, only the new ones).
  const fetchNew = async (list: TabRef[]) => {
    const todo = list.filter((t) => !results.has(t.gid));
    const got = await Promise.all(todo.map((t) => downloadTab(env.SHEET_ID!, t)));
    todo.forEach((t, i) => results.set(t.gid, got[i]));
  };
  await fetchNew(tabs);
  const gone = tabs.some((t) => {
    const r = results.get(t.gid)!;
    return !r.ok && (r.status === 400 || r.status === 404);
  });
  if (gone && !discovered) {
    try {
      tabs = await refreshTabs(env, tabs);
      await fetchNew(tabs);
    } catch {
      /* keep the first attempt */
    }
  }
  const list = tabs;
  const failed = list.flatMap((t) => {
    const r = results.get(t.gid)!;
    return r.ok ? [] : [r.message];
  });
  if (failed.length === list.length) throw new Error(failed[0] ?? 'No tabs could be downloaded');
  const parts = list.map((t): Part => {
    const r = results.get(t.gid)!;
    return { title: t.title, gid: t.gid, bytes: r.ok ? r.bytes : new Uint8Array(0), tab: null, failed: !r.ok };
  });
  return { parts, failed };
}

/**
 * One sync run. `discover` re-reads the tab list first; otherwise the saved
 * list is used, and re-read only if there is none or a tab is gone.
 * `wantBundle` returns what was downloaded even when nothing is saved (for a
 * request that finds nothing stored yet).
 */
export async function syncSheet(env: SyncEnv, now: number, opts: { discover?: boolean; wantBundle?: boolean } = {}): Promise<SyncOutcome> {
  const mode = sheetMode(env);
  if (mode === 'none') throw new Error('Google Sheet is not configured (set SHEET_ID)');

  let parts: Part[];
  let failed: string[] = [];
  if (mode === 'sheets-api') {
    const wb = await fetchViaApi(env.SHEET_ID!, env.GOOGLE_API_KEY!);
    parts = Object.entries(wb.sheets).map(([title, grid]) => ({ title, bytes: encoder.encode(JSON.stringify(grid)), tab: { title, grid } }));
  } else {
    ({ parts, failed } = await downloadAll(env, !!opts.discover));
  }

  const stored = await storedSheet(env);
  if (failed.length) {
    // Keep the previous copy of a tab that failed this time, so a passing error doesn't blank an event.
    const old = stored.bytes ? (JSON.parse(decoder.decode(stored.bytes)) as SheetBundle) : null;
    parts = parts.flatMap((p) => {
      if (!p.failed) return [p];
      const keep = old?.tabs.find((t) => (p.gid && t.gid === p.gid) || t.title === p.title);
      return keep ? [{ ...p, bytes: encoder.encode(keep.csv ?? JSON.stringify(keep.grid ?? [])), tab: keep }] : [];
    });
  }

  const hash = await sha1(joined(parts));
  const meta = stored.meta;
  const changed = !meta || meta.hash !== hash;
  const build = (): SheetBundle => ({
    version: 1,
    source: sourceOf(mode),
    changedAt: changed ? new Date(now).toISOString() : meta!.changedAt,
    tabs: parts.map((p) => p.tab ?? { title: p.title, gid: p.gid, csv: decoder.decode(p.bytes) }),
  });
  const base = { changed, failed, hash };
  if (!env.CACHE) return { ...base, saved: false, deferred: false, bundle: build() };
  // Nothing stored yet: save now. Otherwise only on saving minutes, which caps KV writes by the clock.
  if (!changed || (meta && minuteOf(now) % SAVE_EVERY_MIN !== 0)) {
    return { ...base, saved: false, deferred: changed, bundle: opts.wantBundle ? build() : null };
  }
  const bundle = build();
  const body = JSON.stringify(bundle);
  const m: SheetMeta = { hash, changedAt: bundle.changedAt, writtenAt: now, bytes: body.length };
  await env.CACHE.put(SHEET_KEY, body, { metadata: m });
  return { ...base, saved: true, deferred: false, bundle, meta: m };
}

/**
 * Records how the sync is doing, for /api/health: the first time, then on
 * minutes divisible by STATUS_EVERY_MIN when the state changed or the
 * heartbeat is due.
 */
export async function recordStatus(env: SyncEnv, now: number, error: string | null): Promise<void> {
  if (!env.CACHE) return;
  const prev = await env.CACHE.get<SyncStatus>(STATUS_KEY, 'json');
  const state: SyncStatus['state'] = error ? 'error' : 'ok';
  const moved = !prev || prev.state !== state || (prev.message ?? null) !== error;
  if (prev && (minuteOf(now) % STATUS_EVERY_MIN !== 0 || !(moved || now - prev.writtenAt >= HEARTBEAT_MS))) return;
  const at = new Date(now).toISOString();
  const next: SyncStatus = { state, since: moved ? at : prev!.since, checkedAt: at, writtenAt: now };
  if (error) next.message = error;
  await env.CACHE.put(STATUS_KEY, JSON.stringify(next));
}

/** A sync run plus its status. Never throws. */
export async function runSync(env: SyncEnv, now: number, opts: { discover?: boolean; wantBundle?: boolean } = {}): Promise<SyncOutcome | null> {
  let outcome: SyncOutcome | null = null;
  let error: string | null = null;
  try {
    outcome = await syncSheet(env, now, opts);
    if (outcome.failed.length) error = outcome.failed.join('; ');
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error('sync failed', error);
  }
  try {
    await recordStatus(env, now, error);
  } catch (err) {
    console.warn('status write failed', err instanceof Error ? err.message : String(err));
  }
  return outcome;
}
