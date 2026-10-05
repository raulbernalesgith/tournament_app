import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Bracket, EventData, Match, Tournament } from '../shared/types';
import { Icon } from './icons';
import {
  STAGE_LABEL,
  ago,
  eventModel,
  feederLabel,
  finishOf,
  formatDate,
  initials,
  isBye,
  isPlayed,
  nextUp,
  ord,
  origin,
  pathOf,
  rating,
  sortedPeople,
  type EventModel,
} from './model';

type View = 'overview' | 'groups' | 'knockout' | 'players';

interface Ui {
  e: string;
  v: View | '';
  b: string;
  r: number;
  p: string;
  o: boolean;
  q: string;
  g: string;
}

const POLL_MS = 30_000;

/* ------------------------------------------------------------------ */
/* Small hooks                                                         */
/* ------------------------------------------------------------------ */

function useMedia(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

function store(key: string, value?: string) {
  try {
    if (value === undefined) return window.localStorage.getItem(key);
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
  return null;
}

function readUrl(): Ui {
  const q = new URLSearchParams(window.location.search);
  const v = q.get('v') ?? '';
  return {
    e: q.get('e') ?? '',
    v: (['overview', 'groups', 'knockout', 'players'].includes(v) ? v : '') as Ui['v'],
    b: q.get('b') ?? '',
    r: Number(q.get('r') ?? 0) || 0,
    p: q.get('p') ?? '',
    o: q.get('o') === '1',
    q: q.get('q') ?? '',
    g: q.get('g') ?? '',
  };
}

function writeUrl(ui: Ui) {
  const q = new URLSearchParams();
  if (ui.e) q.set('e', ui.e);
  if (ui.v) q.set('v', ui.v);
  if (ui.b) q.set('b', ui.b);
  if (ui.r) q.set('r', String(ui.r));
  if (ui.p) q.set('p', ui.p);
  if (ui.o) q.set('o', '1');
  if (ui.q) q.set('q', ui.q);
  if (ui.g) q.set('g', ui.g);
  const s = q.toString();
  window.history.replaceState(null, '', s ? `?${s}` : window.location.pathname);
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export function App() {
  const [data, setData] = useState<Tournament | null>(null);
  const [failed, setFailed] = useState(false);
  const [ui, setUiState] = useState<Ui>(readUrl);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = store('rally-theme');
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });
  const [now, setNow] = useState(Date.now());
  const [toast, setToast] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const desk = useMedia('(min-width: 900px)');
  const etag = useRef('');

  const setUi = (patch: Partial<Ui>) =>
    setUiState((prev) => {
      const next = { ...prev, ...patch };
      writeUrl(next);
      return next;
    });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#04060f' : '#e7ecf6');
    store('rally-theme', theme);
  }, [theme]);

  useEffect(() => {
    let alive = true;
    let first = true;
    const load = async () => {
      try {
        const res = await fetch('/api/tournament', { headers: etag.current ? { 'if-none-match': etag.current } : {} });
        if (res.status === 304) return;
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as Tournament;
        if (!alive) return;
        etag.current = res.headers.get('etag') ?? '';
        setData(json);
        setFailed(false);
        if (!first) {
          setToast('Results updated');
          window.setTimeout(() => setToast(''), 2600);
        }
        first = false;
      } catch {
        if (alive && first) setFailed(true);
      }
    };
    load();
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, POLL_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 15_000);
    const onVis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      window.clearInterval(poll);
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  if (!data) {
    return (
      <div class="app">
        <Backdrop />
        <div class="shell">
          <div class="empty glass" style={{ borderRadius: 30, marginTop: '30vh' }}>
            {failed ? 'Could not load the tournament. Check your connection and refresh.' : 'Loading the draw…'}
          </div>
        </div>
      </div>
    );
  }

  const ev = data.events.find((e) => e.id === ui.e) ?? data.events[0];
  if (!ev) {
    return (
      <div class="app">
        <Backdrop />
        <div class="shell">
          <div class="empty glass" style={{ borderRadius: 30, marginTop: '30vh' }}>
            No event tabs were found in the sheet yet.
          </div>
        </div>
      </div>
    );
  }

  return (
    <Main
      t={data}
      ev={ev}
      ui={ui}
      setUi={setUi}
      desk={desk}
      theme={theme}
      setTheme={setTheme}
      now={now}
      toast={toast}
      menuOpen={menuOpen}
      setMenuOpen={setMenuOpen}
    />
  );
}

interface MainProps {
  t: Tournament;
  ev: EventData;
  ui: Ui;
  setUi: (p: Partial<Ui>) => void;
  desk: boolean;
  theme: 'dark' | 'light';
  setTheme: (t: 'dark' | 'light') => void;
  now: number;
  toast: string;
  menuOpen: boolean;
  setMenuOpen: (o: boolean) => void;
}

function Main({ t, ev, ui, setUi, desk, theme, setTheme, now, toast, menuOpen, setMenuOpen }: MainProps) {
  const M = useMemo(() => eventModel(ev), [ev]);
  const A = ev.brackets[0] as Bracket | undefined;
  const view: View = ui.v || (desk ? 'knockout' : 'overview');
  const shownView: View = desk && view === 'overview' ? 'knockout' : view;
  const bracket = ev.brackets.find((b) => b.id === ui.b) ?? A;
  const sel = ui.p || A?.champion || ev.byes[0] || M.people[0] || '';

  const pick = (name: string, open = !desk) => setUi({ p: name, o: open });
  const openProfile = (name: string) => setUi({ p: name, o: true });
  const switchEvent = (id: string) => {
    setMenuOpen(false);
    setUi({ e: id, b: '', r: 0, p: '', o: false, g: '', q: '' });
  };
  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');
  const live = t.source.kind !== 'snapshot';
  const syncLabel = live ? `Live · changed ${ago(t.generatedAt, now)}` : 'Snapshot · sheet not connected';

  return (
    <div class="app">
      <Backdrop />
      <div class="shell">
        {desk ? (
          <DeskHeader t={t} ev={ev} M={M} ui={ui} setUi={setUi} theme={theme} toggleTheme={toggleTheme} switchEvent={switchEvent} syncLabel={syncLabel} live={live} openProfile={openProfile} pick={pick} />
        ) : (
          <PhoneHeader t={t} ev={ev} M={M} theme={theme} toggleTheme={toggleTheme} menuOpen={menuOpen} setMenuOpen={setMenuOpen} goPlayers={() => setUi({ v: 'players' })} />
        )}

        {desk && <DeskTabs view={shownView} setUi={setUi} ev={ev} bracket={bracket} />}

        {shownView === 'overview' && <Overview t={t} ev={ev} M={M} setUi={setUi} openProfile={openProfile} syncLabel={syncLabel} live={live} />}
        {shownView === 'groups' && <GroupsView t={t} ev={ev} M={M} ui={ui} setUi={setUi} sel={desk ? sel : ''} openProfile={openProfile} desk={desk} />}
        {shownView === 'knockout' && bracket && (desk ? (
          <div class="panel glass streak">
            <BracketHead b={bracket} sel={sel} />
            <BracketTree t={t} M={M} b={bracket} sel={sel} pick={(n) => pick(n, false)} />
          </div>
        ) : (
          <KnockoutPhone t={t} M={M} ev={ev} b={bracket} ui={ui} setUi={setUi} openProfile={openProfile} />
        ))}
        {shownView === 'knockout' && !bracket && <div class="empty glass" style={{ borderRadius: 28, marginTop: 18 }}>No knockout brackets on this tab yet.</div>}
        {shownView === 'players' && <PlayersView t={t} M={M} ui={ui} setUi={setUi} desk={desk} sel={desk ? sel : ''} openProfile={openProfile} />}

        {desk && (
          <footer class="footer">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Icon name="sync" size={15} stroke={2} />
              {live ? 'Synced from Google Sheets every minute' : 'Showing the uploaded workbook until the Google Sheet is connected'}
            </span>
            <span>{t.events.length} events · {t.rankCount} players on the ranking list</span>
          </footer>
        )}
      </div>

      {!desk && (
        <>
          <button class={`scrim menu-scrim ${menuOpen ? 'open' : ''}`} aria-label="Close event list" onClick={() => setMenuOpen(false)} />
          <div class={`menu glass-strong ${menuOpen ? 'open' : ''}`} role="menu" aria-label="Events" aria-hidden={!menuOpen}>
            {t.events.map((e) => {
              const m = eventModel(e);
              const on = e.id === ev.id;
              return (
                <button key={e.id} class="row-btn" role="menuitemradio" aria-checked={on} onClick={() => switchEvent(e.id)} style={{ background: on ? 'var(--chip)' : undefined }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 17, fontWeight: 650 }}>{e.name}</span>
                    <span class="faint" style={{ display: 'block', fontSize: 13 }}>{m.people.length} players · {e.groups.length} groups</span>
                  </span>
                  <span class="pill" style={{ color: m.stage === 'done' || m.stage === 'live' ? 'var(--accent-text)' : 'var(--blue-text)' }}>{STAGE_LABEL[m.stage]}</span>
                  <span style={{ width: 22, opacity: on ? 1 : 0, color: 'var(--accent-text)' }}><Icon name="check" size={20} stroke={2.4} /></span>
                </button>
              );
            })}
          </div>
          <TabBar view={shownView} setUi={setUi} />
        </>
      )}

      {desk && sel && <Dock t={t} ev={ev} sel={sel} open={() => openProfile(sel)} clear={() => setUi({ p: '', o: false })} />}

      <Profile t={t} M={M} ev={ev} name={sel} open={ui.o && !!sel} close={() => setUi({ o: false })} />

      <div class={`toast glass-strong ${toast ? 'show' : ''}`} role="status" aria-live="polite">
        <span class="sync-dot live" />
        {toast || 'Results updated'}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared pieces                                                       */
/* ------------------------------------------------------------------ */

function Backdrop() {
  return (
    <div class="backdrop" aria-hidden="true">
      <div class="bd-table"><div class="bd-net" /></div>
      <div class="bd-ball big" />
      <div class="bd-ball small" />
    </div>
  );
}

function Seg<T extends string>({ items, value, onPick, width, height = 52, label, class: cls = '' }: {
  items: { id: T; node: preact.ComponentChildren }[];
  value: T;
  onPick: (id: T) => void;
  width: number;
  height?: number;
  label: string;
  class?: string;
}) {
  const idx = Math.max(0, items.findIndex((i) => i.id === value));
  return (
    <div class={`seg glass-strong soft ${cls}`} role="tablist" aria-label={label} style={{ gridTemplateColumns: `repeat(${items.length}, ${width}px)`, height }}>
      <span class="seg-lens" style={{ width, transform: `translateX(${idx * width}px)` }} />
      {items.map((i) => (
        <button key={i.id} role="tab" aria-selected={i.id === value} onClick={() => onPick(i.id)} style={{ height: height - 8 }}>
          {i.node}
        </button>
      ))}
    </div>
  );
}

function Hero({ t, ev, M, desk, setUi, openProfile }: { t: Tournament; ev: EventData; M: EventModel; desk: boolean; setUi: (p: Partial<Ui>) => void; openProfile: (n: string) => void }) {
  const A = ev.brackets[0];
  let icon: 'trophy' | 'clock' = 'clock';
  let over = '';
  let sub = '';
  let title = 'Brackets coming soon';
  let line = 'They fill in as group results arrive';
  let chips: { round: string; score: string }[] = [];
  let cta = 'See the groups';
  let go = () => setUi({ v: 'groups' });
  if (A?.champion) {
    const fm = A.rounds[A.rounds.length - 1].matches[0];
    const ca = fm.a.name === A.champion;
    const ru = ca ? fm.b : fm.a;
    const me = ca ? fm.a : fm.b;
    icon = 'trophy';
    over = `${A.id} · ${A.label}`;
    sub = 'Champion';
    title = A.champion;
    line = `Beat ${ru.name} ${me.score}–${ru.score} in the final`;
    chips = (pathOf(ev, A.champion)?.steps ?? []).filter((s) => s.res !== 'bye').map((s) => ({ round: s.round.short, score: `${s.my}–${s.os}` }));
    cta = desk ? 'Open profile' : 'View the bracket';
    go = desk ? () => openProfile(A.champion!) : () => setUi({ v: 'knockout', b: A.id, r: A.rounds.length - 1 });
  } else if (A) {
    const nx = nextUp(A);
    over = `${A.id} · ${A.label}`;
    if (nx) {
      sub = A.preliminary ? 'Projected · up next' : 'Up next';
      over += ` · ${nx.round.name}`;
      title = `${nx.match.a.name} vs ${nx.match.b.name}`;
      line = `${origin(M, nx.match.a.name!)} (${rating(t, nx.match.a.name!)}) vs ${origin(M, nx.match.b.name!)} (${rating(t, nx.match.b.name!)})`;
      chips = [{ round: nx.round.short, score: `${nx.ready} ready` }];
      cta = desk ? 'Trace in bracket' : 'Open the bracket';
      go = () => setUi({ v: 'knockout', b: A.id, r: nx.ri, p: nx.match.a.name!, o: false });
    } else {
      sub = 'Draw pending';
    }
  }
  const champ = icon === 'trophy';
  return (
    <div class={`${desk ? 'hero-desk' : 'hero'} glass streak`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span class="hero-icon" style={{ background: champ ? 'var(--accent)' : 'var(--blue)', color: champ ? 'var(--accent-ink)' : 'var(--blue-ink)', ['--glow' as string]: champ ? 'var(--accent-glow)' : 'var(--blue-glow)' }}>
          <Icon name={icon} size={24} />
        </span>
        <span style={{ minWidth: 0 }}>
          <span class="muted" style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{over || ev.name}</span>
          <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: champ ? 'var(--accent-text)' : 'var(--blue-text)' }}>{sub}</span>
        </span>
      </div>
      <div class="hero-title">{title}</div>
      <div class="muted" style={{ marginTop: 6 }}>{line}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {chips.map((c) => (
            <span class="chip" key={c.round}>
              {c.round} <span class="mono" style={{ color: 'var(--text)' }}>{c.score}</span>
            </span>
          ))}
        </div>
        <button class="btn btn-accent" onClick={go} style={desk ? {} : { width: '100%' }}>
          {cta} <Icon name="chevRight" size={16} stroke={2.4} />
        </button>
      </div>
    </div>
  );
}

function statsOf(M: EventModel, ev: EventData) {
  const size = ev.groups[0]?.players.length ?? 0;
  return [
    { label: 'Players', value: String(M.people.length), sub: `${ev.byes.length} straight to knockout`, short: 'players' },
    { label: 'Groups', value: String(ev.groups.length), sub: `${size} players each`, short: `groups of ${size}` },
    { label: 'Group matches', value: `${M.gPlayed}/${M.gTotal}`, sub: M.gPlayed >= M.gTotal ? 'All played' : `${M.gTotal - M.gPlayed} to play`, short: 'group matches' },
    { label: 'Knockout', value: `${M.kPlayed}/${M.kTotal}`, sub: `${ev.brackets.length} brackets`, short: 'knockout matches' },
  ];
}

const stageColor = (s: EventModel['stage']) => (s === 'done' || s === 'live' ? 'var(--accent-text)' : 'var(--blue-text)');

function bracketStatus(b: Bracket) {
  if (b.champion) return { label: 'Complete', cls: 'st-complete' };
  if (b.preliminary) return { label: 'Projected', cls: 'st-soft' };
  if (b.rounds.some((r) => r.matches.some(isPlayed))) return { label: 'Live', cls: 'st-live' };
  return { label: 'Up next', cls: 'st-soft' };
}

/* ------------------------------------------------------------------ */
/* Headers and navigation                                              */
/* ------------------------------------------------------------------ */

function DeskHeader({ t, ev, M, ui, setUi, theme, toggleTheme, switchEvent, syncLabel, live, openProfile }: {
  t: Tournament; ev: EventData; M: EventModel; ui: Ui; setUi: (p: Partial<Ui>) => void; theme: string; toggleTheme: () => void;
  switchEvent: (id: string) => void; syncLabel: string; live: boolean; openProfile: (n: string) => void; pick: (n: string) => void;
}) {
  return (
    <>
      <header class="nav glass-strong streak">
        <div class="brand">
          <span class="brand-mark"><Icon name="paddle" size={24} /></span>
          Rally
        </div>
        <Seg
          label="Events"
          items={t.events.map((e) => {
            const m = eventModel(e);
            return { id: e.id, node: <><span class="ell">{e.name}</span><span class="sync-dot" style={{ width: 7, height: 7, boxShadow: 'none', background: m.stage === 'done' ? 'var(--text-3)' : stageColor(m.stage) }} /></> };
          })}
          value={ev.id}
          onPick={switchEvent}
          width={168}
          height={52}
          class="thin"
        />
        <div style={{ flex: 1 }} />
        <span class="sync" title={live ? 'The app pulls the Google Sheet every minute' : 'Connect the Google Sheet to go live'}>
          <span class={`sync-dot ${live ? 'live' : ''}`} />
          {syncLabel}
        </span>
        <label class="search" style={{ width: 260 }}>
          <Icon name="search" size={18} stroke={2} class="faint" />
          <span class="sr-only">Search players</span>
          <input type="search" placeholder="Search players" value={ui.q} onInput={(e) => setUi({ q: (e.target as HTMLInputElement).value, v: 'players' })} />
        </label>
        <button class="btn btn-round" style={{ width: 48, height: 48, borderRadius: 24, background: 'var(--chip)', border: '1px solid var(--chip-border)' }} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={toggleTheme}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
      </header>

      <section class="hero-row">
        <div class="hero-left">
          <div class="overline" style={{ color: stageColor(M.stage) }}>{STAGE_LABEL[M.stage]}</div>
          <h1>{ev.name}</h1>
          <div class="muted" style={{ marginTop: 12, fontSize: 17 }}>
            {ev.byes.length} top {ev.byes.length === 1 ? 'seed skips' : 'seeds skip'} the groups · {ev.brackets.length} knockout brackets · draw {ev.draw} of the sheet
          </div>
          <div class="stat-chips">
            {statsOf(M, ev).map((s) => (
              <div class="stat-chip glass soft" key={s.label}>
                <span class="mono">{s.value}</span>
                <span class="muted" style={{ fontSize: 13 }}>{s.short}</span>
              </div>
            ))}
          </div>
        </div>
        <Hero t={t} ev={ev} M={M} desk setUi={setUi} openProfile={openProfile} />
      </section>
    </>
  );
}

function DeskTabs({ view, setUi, ev, bracket }: { view: View; setUi: (p: Partial<Ui>) => void; ev: EventData; bracket?: Bracket }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginTop: 34 }}>
      <Seg
        label="Views"
        items={([['knockout', 'Knockout', 'bracket'], ['groups', 'Groups', 'groups'], ['players', 'Players', 'players']] as const).map(([id, l, ic]) => ({
          id,
          node: <><Icon name={ic} size={18} />{l}</>,
        }))}
        value={view as 'knockout' | 'groups' | 'players'}
        onPick={(v) => setUi({ v })}
        width={132}
        height={58}
      />
      {view === 'knockout' && bracket && ev.brackets.length > 0 && (
        <Seg
          label="Brackets"
          items={ev.brackets.map((b) => ({
            id: b.id,
            node: <><span class={`badge b-${b.id}`} style={{ width: 26, height: 26, borderRadius: 9, fontSize: 13 }}>{b.id}</span>{b.label}</>,
          }))}
          value={bracket.id}
          onPick={(b) => setUi({ b, r: 0 })}
          width={184}
          height={58}
        />
      )}
    </div>
  );
}

function PhoneHeader({ t, ev, M, theme, toggleTheme, menuOpen, setMenuOpen, goPlayers }: {
  t: Tournament; ev: EventData; M: EventModel; theme: string; toggleTheme: () => void; menuOpen: boolean; setMenuOpen: (o: boolean) => void; goPlayers: () => void;
}) {
  const live = t.source.kind !== 'snapshot';
  return (
    <>
      <div class="phone-top">
        <div class="brand" style={{ fontSize: 18 }}>
          <span class="brand-mark glass" style={{ width: 40, height: 40, borderRadius: 14 }}><Icon name="paddle" size={24} /></span>
          Rally
          <span class={`sync-dot ${live ? 'live' : ''}`} title={live ? 'Live from Google Sheets' : 'Snapshot'} style={{ marginLeft: 4 }} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button class="btn btn-round glass" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={toggleTheme}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
          <button class="btn btn-round glass" aria-label="Search players" onClick={goPlayers}><Icon name="search" /></button>
        </div>
      </div>
      <div class="phone-title">
        <div class="overline" style={{ color: stageColor(M.stage) }}>{STAGE_LABEL[M.stage]}</div>
        <button class="title-btn" aria-expanded={menuOpen} aria-label={`Change event. Current: ${ev.name}`} onClick={() => setMenuOpen(!menuOpen)}>
          <span>{ev.name}</span>
          <span class={`title-chev ${menuOpen ? 'open' : ''}`}><Icon name="chevDown" size={16} stroke={2.2} /></span>
        </button>
        <div class="muted">{M.people.length} players · {ev.groups.length} groups · {ev.brackets.length} brackets</div>
      </div>
    </>
  );
}

function TabBar({ view, setUi }: { view: View; setUi: (p: Partial<Ui>) => void }) {
  const tabs = [
    ['overview', 'Overview', 'home'],
    ['groups', 'Groups', 'groups'],
    ['knockout', 'Knockout', 'bracket'],
    ['players', 'Players', 'players'],
  ] as const;
  const idx = Math.max(0, tabs.findIndex((x) => x[0] === view));
  return (
    <nav class="tabbar seg glass-strong streak" aria-label="Sections" style={{ display: undefined }}>
      <span class="seg-lens" style={{ width: 'calc((100% - 10px) / 4)', top: 5, bottom: 5, left: 5, transform: `translateX(${idx * 100}%)` }} />
      {tabs.map(([id, label, icon]) => (
        <button key={id} aria-selected={id === view} aria-current={id === view ? 'page' : undefined} onClick={() => setUi({ v: id })}>
          <Icon name={icon} size={22} />
          {label}
        </button>
      ))}
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* Overview (phone)                                                    */
/* ------------------------------------------------------------------ */

function Overview({ t, ev, M, setUi, openProfile, syncLabel, live }: { t: Tournament; ev: EventData; M: EventModel; setUi: (p: Partial<Ui>) => void; openProfile: (n: string) => void; syncLabel: string; live: boolean }) {
  return (
    <div class="view">
      <Hero t={t} ev={ev} M={M} desk={false} setUi={setUi} openProfile={openProfile} />
      <div class="stats-grid">
        {statsOf(M, ev).map((s) => (
          <div class="stat glass" key={s.label}>
            <div class="faint" style={{ fontSize: 12, fontWeight: 600 }}>{s.label}</div>
            <span class="mono">{s.value}</span>
            <div class="muted" style={{ fontSize: 12, marginTop: 3 }}>{s.sub}</div>
          </div>
        ))}
      </div>
      {ev.brackets.length > 0 && (
        <>
          <div class="section-head"><h2>Knockout brackets</h2><span class="faint" style={{ fontSize: 13 }}>{ev.brackets.length} drawn</span></div>
          <div class="list-card glass">
            {ev.brackets.map((b) => {
              const st = bracketStatus(b);
              const played = b.rounds.reduce((a, r) => a + r.matches.filter(isPlayed).length, 0);
              return (
                <button key={b.id} class="row-btn" onClick={() => setUi({ v: 'knockout', b: b.id, r: 0 })}>
                  <span class={`badge b-${b.id}`} style={{ width: 42, height: 42, borderRadius: 14, fontSize: 18 }}>{b.id}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 16, fontWeight: 650 }}>{b.label}</span>
                    <span class="faint" style={{ display: 'block', fontSize: 13 }}>{b.players} players · {b.size}-draw</span>
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, maxWidth: 132, minWidth: 0 }}>
                    <span class={`pill ${st.cls}`}>{st.label}</span>
                    <span class="ell" style={{ maxWidth: 132, fontSize: 13, fontWeight: 600, color: b.champion ? 'var(--text)' : 'var(--text-2)' }}>
                      {b.champion ?? `${played} of ${Math.max(0, b.players - 1)} played`}
                    </span>
                  </span>
                  <Icon name="chevRight" size={18} stroke={2} class="faint" />
                </button>
              );
            })}
          </div>
        </>
      )}
      {ev.byes.length > 0 && (
        <>
          <div class="section-head"><h2>Straight to knockout</h2><span class="faint" style={{ fontSize: 13 }}>Group-stage byes</span></div>
          <div class="byes">
            {ev.byes.map((n) => (
              <button key={n} class="bye-chip btn glass" onClick={() => openProfile(n)}>
                <span class="avatar" style={{ width: 34, height: 34, fontSize: 12 }}>{initials(n)}</span>
                <span style={{ fontSize: 14, fontWeight: 650 }}>{n}</span>
                <span class="mono faint" style={{ fontSize: 12 }}>{rating(t, n)}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <div class="faint" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 8, fontSize: 12 }}>
        <span class={`sync-dot ${live ? 'live' : ''}`} style={{ width: 7, height: 7 }} />
        {syncLabel}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Groups                                                              */
/* ------------------------------------------------------------------ */

function GroupsView({ t, ev, M, ui, setUi, sel, openProfile, desk }: { t: Tournament; ev: EventData; M: EventModel; ui: Ui; setUi: (p: Partial<Ui>) => void; sel: string; openProfile: (n: string) => void; desk: boolean }) {
  const byBracket = new Map<string, number[]>();
  M.dest.forEach((id, rank) => byBracket.set(id, [...(byBracket.get(id) ?? []), rank].sort((a, b) => a - b)));
  const groups = desk || !ui.g ? ev.groups : ev.groups.filter((g) => g.label === ui.g);
  const body = (
    <>
      <div class={`legend ${desk ? 'inner' : 'glass'}`}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Where each finish goes</div>
          <div class="mono faint" style={{ fontSize: 12 }}>{M.gPlayed}/{M.gTotal} played</div>
        </div>
        <div class="legend-items">
          {ev.brackets.map((b) => (
            <div class="legend-item" key={b.id}>
              <span class={`badge b-${b.id}`} style={{ width: 28, height: 28, borderRadius: 9, fontSize: 13 }}>{b.id}</span>
              <b style={{ fontWeight: 650 }}>{(byBracket.get(b.id) ?? []).map(ord).join(' & ') || '—'}</b>
              <span class="muted">→ {b.label}</span>
            </div>
          ))}
        </div>
      </div>
      {!desk && (
        <div class="chips-row" role="toolbar" aria-label="Filter groups">
          {[{ id: '', label: 'All' }, ...ev.groups.map((g) => ({ id: g.label, label: `G${g.label}` }))].map((c) => (
            <button key={c.id || 'all'} class="filter-chip glass thin" aria-pressed={(ui.g || '') === c.id} onClick={() => setUi({ g: c.id })}>{c.label}</button>
          ))}
        </div>
      )}
      <div class="groups-grid" style={desk ? { marginTop: 18 } : {}}>
        {groups.map((g) => {
          const total = (g.players.length * (g.players.length - 1)) / 2;
          const played = g.players.reduce((a, p) => a + p.wins, 0);
          return (
            <div class={`group-card ${desk ? 'inner' : 'glass'}`} key={g.name}>
              <div class="group-head">
                <div style={{ fontSize: 17, fontWeight: 700 }}>{g.name}</div>
                <div class="mono faint" style={{ fontSize: 12 }}>{played}/{total} played</div>
              </div>
              {g.players.map((p) => {
                const d = M.dest.get(p.rank);
                return (
                  <button key={p.name} class={`group-row ${sel === p.name ? 'sel' : ''}`} onClick={() => openProfile(p.name)}>
                    <span class={`rank-dot mono ${p.rank === 1 && played > 0 ? 'lead' : ''}`}>{p.rank}</span>
                    <span style={{ minWidth: 0 }}>
                      <span class="ell" style={{ display: 'block', fontSize: 15, fontWeight: 600 }}>{p.name}</span>
                      <span class="faint" style={{ display: 'block', fontSize: 12 }}>Seed {p.seed ?? '—'}</span>
                    </span>
                    <span class="mono muted" style={{ fontSize: 13, textAlign: 'right' }}>{rating(t, p.name)}</span>
                    <span class="mono" style={{ fontSize: 14, fontWeight: 600, textAlign: 'right' }}>{p.wins}–{p.losses}</span>
                    <span class={`badge b-${d ?? 'none'}`} style={{ width: 28, height: 28, borderRadius: 9, fontSize: 12 }}>{d ?? '–'}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
  return desk ? <div class="panel glass streak">{body}</div> : <div class="view">{body}</div>;
}

/* ------------------------------------------------------------------ */
/* Knockout                                                            */
/* ------------------------------------------------------------------ */

function BracketHead({ b, sel }: { b: Bracket; sel: string }) {
  const st = bracketStatus(b);
  const played = b.rounds.reduce((a, r) => a + r.matches.filter(isPlayed).length, 0);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span class={`badge b-${b.id}`} style={{ width: 46, height: 46, borderRadius: 15, fontSize: 20 }}>{b.id}</span>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2 style={{ fontSize: 24, fontWeight: 700 }}>{b.label}</h2>
            <span class={`pill ${st.cls}`}>{st.label}</span>
          </div>
          <div class="muted" style={{ fontSize: 14 }}>{b.players} players · {b.size}-player draw · {played}/{Math.max(0, b.players - 1)} matches played</div>
        </div>
      </div>
      <div class="muted" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
        <span style={{ width: 26, height: 3, borderRadius: 2, background: 'var(--accent)' }} />
        {sel ? `Tracing ${sel} · click any name to follow their run` : 'Click any name to trace a run'}
      </div>
    </div>
  );
}

function BracketTree({ t, M, b, sel, pick }: { t: Tournament; M: EventModel; b: Bracket; sel: string; pick: (n: string) => void }) {
  const n1 = b.rounds[0]?.matches.length ?? 0;
  const slot = n1 >= 16 ? 78 : n1 >= 8 ? 96 : 124;
  const H = Math.max(1, n1) * slot;
  const champHot = !!b.champion && b.champion === sel;
  return (
    <div class="tree-scroll">
      <div class="tree">
        {b.rounds.map((r, ri) => {
          const n = r.matches.length;
          const half = H / (4 * n);
          return (
            <div class="tree-col" key={r.name}>
              <div class="tree-head"><span>{r.name}</span><span class="mono faint" style={{ letterSpacing: 0 }}>{n}</span></div>
              <div class="tree-body" style={{ height: H }}>
                {r.matches.map((m, mi) => {
                  const hot = !!sel && (m.a.name === sel || m.b.name === sel);
                  return (
                    <div class="tree-match" key={mi}>
                      {ri > 0 && (
                        <>
                          <span class={`conn up ${hot && m.a.name === sel ? 'hot' : ''}`} style={{ height: half }} />
                          <span class={`conn down ${hot && m.b.name === sel ? 'hot' : ''}`} style={{ height: half }} />
                          <span class={`conn stub ${hot ? 'hot' : ''}`} />
                        </>
                      )}
                      <div class={`tm-card glass soft ${hot ? 'hot' : ''} ${isBye(m) ? 'byecard' : ''}`}>
                        <TreeRow t={t} M={M} b={b} m={m} side="a" ri={ri} mi={mi} sel={sel} pick={pick} />
                        <TreeRow t={t} M={M} b={b} m={m} side="b" ri={ri} mi={mi} sel={sel} pick={pick} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        <div class="tree-col champ">
          <div class="tree-head" style={{ color: 'var(--accent-text)' }}><span>Champion</span></div>
          <div class="tree-body" style={{ height: H, justifyContent: 'center' }}>
            <div style={{ position: 'relative' }}>
              <span class={`conn stub long ${champHot ? 'hot' : ''}`} />
              <button class={`champ-tile glass btn ${b.champion ? 'won' : 'thin'}`} disabled={!b.champion} onClick={() => b.champion && pick(b.champion)}>
                <span class="trophy" style={b.champion ? {} : { background: 'var(--chip)', color: 'var(--text-3)', boxShadow: 'none' }}><Icon name="trophy" size={28} stroke={1.7} /></span>
                <span class="overline" style={{ fontSize: 11, color: b.champion ? 'var(--accent-text)' : 'var(--text-3)' }}>{b.id} · {b.label}</span>
                <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.2 }}>{b.champion ?? 'To be decided'}</span>
                <span class="muted" style={{ fontSize: 12 }}>{b.champion ? `Rating ${rating(t, b.champion)} · ${origin(M, b.champion)}` : b.preliminary ? 'Projected draw' : 'Final not played yet'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TreeRow({ t, M, b, m, side, ri, mi, sel, pick }: { t: Tournament; M: EventModel; b: Bracket; m: Match; side: 'a' | 'b'; ri: number; mi: number; sel: string; pick: (n: string) => void }) {
  const s = m[side];
  if (s.bye) {
    return <button class="tm-row" disabled><span class="n faint" style={{ fontStyle: 'italic' }}>Bye</span><span class="tm-score" /></button>;
  }
  if (!s.name) {
    const lab = feederLabel(b, ri, mi, side).replace('Winner of ', 'Winner ');
    return <button class="tm-row" disabled title={lab}><span class="n faint ell">{lab}</span><span class="tm-score" /></button>;
  }
  const win = !isBye(m) && m.winner === s.name;
  const lose = !!m.winner && m.winner !== s.name;
  const me = s.name === sel;
  return (
    <button class={`tm-row ${me ? 'me' : ''}`} onClick={() => pick(s.name!)} title={`${s.name} · ${origin(M, s.name)} · rating ${rating(t, s.name)}`}>
      <span class="n ell" style={{ fontWeight: win || isBye(m) ? 700 : 520, color: me ? 'var(--accent-text)' : lose ? 'var(--text-2)' : 'var(--text)' }}>{s.name}</span>
      <span class={`tm-score ${win ? 'win' : s.score != null ? 'has' : ''}`}>{s.score ?? ''}</span>
    </button>
  );
}

function KnockoutPhone({ t, M, ev, b, ui, setUi, openProfile }: { t: Tournament; M: EventModel; ev: EventData; b: Bracket; ui: Ui; setUi: (p: Partial<Ui>) => void; openProfile: (n: string) => void }) {
  const ri = Math.min(Math.max(0, ui.r), b.rounds.length - 1);
  const R = b.rounds[ri];
  const real = R.matches.filter((m) => !isBye(m));
  const byes = R.matches.length - real.length;
  const st = bracketStatus(b);
  const width = (Math.min(window.innerWidth, 900) - 32 - 8) / ev.brackets.length;
  const fm = b.rounds[b.rounds.length - 1].matches[0];
  return (
    <div class="view">
      <Seg
        label="Knockout brackets"
        class="br-seg"
        items={ev.brackets.map((x) => ({ id: x.id, node: <><span class="l">{x.id}</span><span class="s">{x.label}</span></> }))}
        value={b.id}
        onPick={(id) => setUi({ b: id, r: 0 })}
        width={width}
        height={62}
      />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '0 4px' }}>
        <span class="muted" style={{ fontSize: 14 }}>{b.players} players · {b.size}-player draw</span>
        <span class={`pill ${st.cls}`}>{st.label}</span>
      </div>
      <div class="chips-row" role="toolbar" aria-label="Rounds">
        {b.rounds.map((r, i) => (
          <button key={r.name} class="round-chip glass thin" aria-pressed={i === ri} onClick={() => setUi({ r: i })}>
            <b style={{ fontSize: 14 }}>{r.short}</b>
            <span class="mono" style={{ fontSize: 12, opacity: 0.72 }}>{r.matches.length}</span>
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, padding: '4px 4px 0' }}>
        <h2 style={{ fontSize: 22, fontWeight: 700 }}>{R.name}</h2>
        <span class="mono faint" style={{ fontSize: 12 }}>{real.filter(isPlayed).length}/{real.length} played{byes ? ` · ${byes} ${byes === 1 ? 'bye' : 'byes'}` : ''}</span>
      </div>
      {ri === b.rounds.length - 1 && b.champion && (
        <button class="champ-card glass streak btn" onClick={() => openProfile(b.champion!)}>
          <span class="trophy"><Icon name="trophy" size={28} stroke={1.7} /></span>
          <span style={{ minWidth: 0 }}>
            <span class="overline" style={{ display: 'block', fontSize: 11, color: 'var(--accent-text)' }}>{b.id} · {b.label} champion</span>
            <span style={{ display: 'block', marginTop: 2, fontSize: 24, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1.15 }}>{b.champion}</span>
            <span class="muted" style={{ display: 'block', marginTop: 2, fontSize: 14 }}>
              Beat {fm.a.name === b.champion ? fm.b.name : fm.a.name} {fm.a.name === b.champion ? fm.a.score : fm.b.score}–{fm.a.name === b.champion ? fm.b.score : fm.a.score} · rating {rating(t, b.champion)}
            </span>
          </span>
        </button>
      )}
      {R.matches.map((m, k) => {
        const bye = isBye(m);
        const played = isPlayed(m);
        const ready = !bye && !!m.a.name && !!m.b.name;
        const status = bye ? ['Bye', 'var(--text-3)'] : played ? ['Played', 'var(--accent)'] : ready ? ['Ready', 'var(--blue-text)'] : ['Awaiting', 'var(--text-3)'];
        return (
          <div class="match-card glass" key={k}>
            <div class="match-top">
              <span class="overline faint" style={{ fontSize: 11 }}>{R.short} · Match {k + 1}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 650, color: status[0] === 'Played' ? 'var(--text-2)' : status[1] }}>
                <span style={{ width: 6, height: 6, borderRadius: 3, background: status[1] }} />
                {status[0]}
              </span>
            </div>
            {(['a', 'b'] as const).map((side) => {
              const s = m[side];
              if (s.bye) {
                return (
                  <button key={side} class="match-row" disabled>
                    <span><span class="faint" style={{ display: 'block', fontSize: 16, fontStyle: 'italic' }}>Bye</span><span class="faint" style={{ display: 'block', fontSize: 12 }}>Opponent advances automatically</span></span>
                    <span />
                    <span class="score none" />
                  </button>
                );
              }
              if (!s.name) {
                return (
                  <button key={side} class="match-row" disabled>
                    <span><span class="faint ell" style={{ display: 'block', fontSize: 16 }}>{feederLabel(b, ri, k, side)}</span><span class="faint" style={{ display: 'block', fontSize: 12 }}>Awaiting result</span></span>
                    <span />
                    <span class="score">–</span>
                  </button>
                );
              }
              const win = !bye && m.winner === s.name;
              const lose = !!m.winner && m.winner !== s.name;
              return (
                <button key={side} class="match-row" onClick={() => openProfile(s.name!)}>
                  <span style={{ minWidth: 0 }}>
                    <span class="ell" style={{ display: 'block', fontSize: 16, fontWeight: win || bye ? 700 : 560, color: lose ? 'var(--text-2)' : 'var(--text)' }}>{s.name}</span>
                    <span class="faint ell" style={{ display: 'block', fontSize: 12 }}>{origin(M, s.name)}</span>
                  </span>
                  <span class="mono faint" style={{ fontSize: 13 }}>{rating(t, s.name)}</span>
                  <span class={`score ${win ? 'win' : bye ? 'none' : ''}`}>{s.score ?? (bye ? '' : '–')}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Players                                                             */
/* ------------------------------------------------------------------ */

function PlayersView({ t, M, ui, setUi, desk, sel, openProfile }: { t: Tournament; M: EventModel; ui: Ui; setUi: (p: Partial<Ui>) => void; desk: boolean; sel: string; openProfile: (n: string) => void }) {
  const all = sortedPeople(t, M);
  const q = ui.q.trim().toLowerCase();
  const rows = all.map((name, i) => ({ name, pos: i + 1 })).filter((r) => !q || r.name.toLowerCase().includes(q));
  const meta = rows.length === all.length ? `${all.length} players · sorted by rating` : `${rows.length} of ${all.length} players match “${ui.q}”`;
  const groupText = (name: string) => {
    const s = M.spot.get(name);
    const f = finishOf(M.ev, name);
    if (s) return `Group ${s.group.label} · ${ord(s.player.rank)}${M.dest.get(s.player.rank) ? ` → ${M.dest.get(s.player.rank)}` : ''}`;
    return `Group-stage bye${f.bracket ? ` → ${f.bracket.id}` : ''}`;
  };
  if (desk) {
    return (
      <div class="panel glass streak">
        <h2 style={{ fontSize: 24, fontWeight: 700 }}>Players</h2>
        <div class="muted" style={{ fontSize: 14 }}>{meta}</div>
        <div style={{ marginTop: 18, overflowX: 'auto' }}>
          <div class="ptable">
            <div class="prow head"><span>#</span><span>Player</span><span style={{ textAlign: 'right' }}>Rating</span><span style={{ textAlign: 'right' }}>Seed</span><span>Group</span><span style={{ textAlign: 'right' }}>W–L</span><span>Finish</span></div>
            {rows.map(({ name, pos }) => {
              const s = M.spot.get(name);
              const f = finishOf(M.ev, name);
              return (
                <button key={name} class={`prow body ${sel === name ? 'sel' : ''}`} onClick={() => openProfile(name)}>
                  <span class="mono faint" style={{ fontSize: 13 }}>{pos}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <span class="avatar" style={{ width: 34, height: 34, fontSize: 12 }}>{initials(name)}</span>
                    <span class="ell" style={{ fontSize: 15, fontWeight: 650 }}>{name}</span>
                  </span>
                  <span class="mono" style={{ fontSize: 14, fontWeight: 600, textAlign: 'right' }}>{rating(t, name)}</span>
                  <span class="mono muted" style={{ fontSize: 13, textAlign: 'right' }}>{s?.player.seed ?? 'Bye'}</span>
                  <span class="muted ell" style={{ fontSize: 13 }}>{groupText(name)}</span>
                  <span class="mono" style={{ fontSize: 13, textAlign: 'right' }}>{s ? `${s.player.wins}–${s.player.losses}` : '—'}</span>
                  <span><span class={`pill fin-${f.kind}`} style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>{f.short}</span></span>
                </button>
              );
            })}
            {rows.length === 0 && <div class="empty">No players match that search.</div>}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div class="view">
      <label class="search glass" style={{ height: 52, borderRadius: 26 }}>
        <Icon name="search" size={20} stroke={2} class="faint" />
        <span class="sr-only">Search players</span>
        <input type="search" placeholder="Search players" value={ui.q} onInput={(e) => setUi({ q: (e.target as HTMLInputElement).value })} style={{ fontSize: 16 }} />
      </label>
      <div class="faint" style={{ fontSize: 13, padding: '0 4px' }}>{meta}</div>
      <div class="plist glass">
        {rows.map(({ name, pos }) => {
          const f = finishOf(M.ev, name);
          return (
            <button key={name} class="plist-row" onClick={() => openProfile(name)}>
              <span class="mono" style={{ width: 36, height: 36, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, background: 'var(--chip)', color: 'var(--text-2)' }}>{pos}</span>
              <span style={{ minWidth: 0 }}>
                <span class="ell" style={{ display: 'block', fontSize: 15, fontWeight: 650 }}>{name}</span>
                <span class="faint ell" style={{ display: 'block', fontSize: 12 }}>{M.spot.get(name) ? `Seed ${M.spot.get(name)!.player.seed} · ` : ''}{groupText(name)}</span>
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                <span class="mono" style={{ fontSize: 14, fontWeight: 600 }}>{rating(t, name)}</span>
                <span class={`pill fin-${f.kind}`} style={{ textTransform: 'none', letterSpacing: 0, height: 20, lineHeight: '20px', fontSize: 11 }}>{f.short}</span>
              </span>
            </button>
          );
        })}
        {rows.length === 0 && <div class="empty">No players match that search.</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dock and profile                                                    */
/* ------------------------------------------------------------------ */

function Dock({ t, ev, sel, open, clear }: { t: Tournament; ev: EventData; sel: string; open: () => void; clear: () => void }) {
  const f = finishOf(ev, sel);
  const p = pathOf(ev, sel);
  const champ = f.kind === 'champ';
  return (
    <div class="dock glass-strong streak" role="region" aria-label="Selected player">
      <span class="avatar" style={{ width: 48, height: 48, fontSize: 15, background: champ ? 'var(--accent)' : 'var(--lens)', color: champ ? 'var(--accent-ink)' : 'var(--text)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.5)' }}>{initials(sel)}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span class="ell" style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{sel} <span class="mono faint" style={{ fontWeight: 500, fontSize: 13 }}>{rating(t, sel)}</span></span>
        <span class="muted ell" style={{ display: 'block', fontSize: 13 }}>{f.long} · {f.sub}</span>
      </span>
      <span style={{ display: 'flex', gap: 6, flex: 'none' }}>
        {(p?.steps ?? []).filter((s) => s.res !== 'bye').slice(-4).map((s) => (
          <span key={s.round.name} class="chip" style={{ height: 30, borderRadius: 15, background: s.res === 'won' ? 'var(--accent-soft)' : s.res === 'lost' ? 'var(--chip-strong)' : 'var(--blue-soft)', color: s.res === 'won' ? 'var(--accent-text)' : s.res === 'lost' ? 'var(--text-2)' : 'var(--blue-text)', border: 0 }}>
            {s.round.short} <span class="mono">{s.res === 'pending' ? 'next' : `${s.my}–${s.os}`}</span>
          </span>
        ))}
      </span>
      <button class="btn btn-accent" onClick={open}>Profile</button>
      <button class="btn btn-round" aria-label="Clear selection" onClick={clear} style={{ background: 'var(--chip)', border: '1px solid var(--chip-border)' }}><Icon name="close" size={18} stroke={2.2} /></button>
    </div>
  );
}

function Profile({ t, M, ev, name, open, close }: { t: Tournament; M: EventModel; ev: EventData; name: string; open: boolean; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current?.scrollTo({ top: 0 });
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, name]);
  if (!name) return null;
  const info = t.players[name];
  const s = M.spot.get(name);
  const f = finishOf(ev, name);
  const p = pathOf(ev, name);
  const champ = f.kind === 'champ';
  const lp = formatDate(info?.lastPlayed ?? null);
  const tags = [info?.province, info?.gender ? `Gender ${info.gender}` : '', s ? `Seed ${s.player.seed ?? '—'}` : ev.byes.includes(name) ? 'Group-stage bye' : '', info?.temp ? 'Temp' : ''].filter(Boolean);
  const groupPlayed = s ? s.group.players.reduce((a, x) => a + x.wins, 0) : 0;
  const groupTotal = s ? (s.group.players.length * (s.group.players.length - 1)) / 2 : 0;
  return (
    <>
      <button class={`scrim ${open ? 'open' : ''}`} aria-label="Close player profile" tabIndex={open ? 0 : -1} onClick={close} />
      <aside class={`sheet glass-strong streak ${open ? 'open' : ''}`} aria-label="Player profile" aria-hidden={!open}>
        <div class="sheet-scroll" ref={ref}>
          <div class="grabber" />
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
              <span class="avatar" style={{ width: 62, height: 62, fontSize: 20, background: champ ? 'var(--accent)' : 'var(--lens)', color: champ ? 'var(--accent-ink)' : 'var(--text)', boxShadow: `inset 0 1px 0 rgba(255,255,255,0.55), 0 10px 26px ${champ ? 'var(--accent-glow)' : 'rgba(0,0,0,0.25)'}` }}>{initials(name)}</span>
              <div style={{ minWidth: 0 }}>
                <div class="faint" style={{ fontSize: 12, fontWeight: 650 }}>{ev.name}{f.bracket ? ` · ${f.bracket.id} ${f.bracket.label}` : ''}</div>
                <h2 style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1.12 }}>{name}</h2>
              </div>
            </div>
            <button class="btn btn-round" aria-label="Close" onClick={close} tabIndex={open ? 0 : -1} style={{ background: 'var(--chip)', border: '1px solid var(--chip-border)' }}><Icon name="close" size={18} stroke={2.2} /></button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 14 }}>
            {tags.map((x) => <span class="chip" key={x}>{x}</span>)}
          </div>
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderRadius: 22, background: champ ? 'var(--accent-soft)' : 'var(--chip)', border: `1px solid ${champ ? 'var(--accent-line)' : 'var(--hair)'}` }}>
            <span style={{ width: 38, height: 38, borderRadius: 19, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: champ ? 'var(--accent)' : 'var(--chip-strong)', color: champ ? 'var(--accent-ink)' : 'var(--text)' }}>
              <Icon name={champ ? 'trophy' : f.kind === 'alive' ? 'clock' : f.kind === 'none' ? 'groups' : 'bracket'} />
            </span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 16, fontWeight: 700 }}>{f.long}</span>
              <span class="muted" style={{ display: 'block', fontSize: 13 }}>{f.sub}</span>
            </span>
          </div>
          <div class="tiles">
            <div class="tile"><div class="faint" style={{ fontSize: 12, fontWeight: 600 }}>Rating</div><span class="mono">{info?.rating ?? '—'}</span><div class="faint" style={{ fontSize: 12 }}>{info?.temp ? 'Temp flag on' : 'From the ranking list'}</div></div>
            <div class="tile"><div class="faint" style={{ fontSize: 12, fontWeight: 600 }}>List rank</div><span class="mono">{info?.listRank ? `#${info.listRank}` : '—'}</span><div class="faint" style={{ fontSize: 12 }}>{info?.listRank ? `of ${t.rankCount} players` : 'Not on the list'}</div></div>
            <div class="tile"><div class="faint" style={{ fontSize: 12, fontWeight: 600 }}>Last played</div><span class="mono">{lp.main}</span><div class="faint" style={{ fontSize: 12 }}>{lp.year}</div></div>
            <div class="tile"><div class="faint" style={{ fontSize: 12, fontWeight: 600 }}>{s ? s.group.name : 'Group stage'}</div><span class="mono">{s ? `${ord(s.player.rank)} · ${s.player.wins}–${s.player.losses}` : 'Bye'}</span><div class="faint" style={{ fontSize: 12 }}>{s ? (M.dest.get(s.player.rank) ? `Into bracket ${M.dest.get(s.player.rank)}` : 'Group stage') : 'Skipped the groups'}</div></div>
          </div>
          {p && (
            <>
              <div class="section-head" style={{ padding: 0, marginTop: 22 }}><h3 style={{ fontSize: 17 }}>Knockout · {p.bracket.id} {p.bracket.label}</h3><span class="faint" style={{ fontSize: 12 }}>{p.bracket.players} players</span></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                {p.steps.map((st) => (
                  <div class="path-row" key={st.round.name}>
                    <span style={{ height: 28, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 750, background: 'var(--chip-strong)' }}>{st.round.short}</span>
                    <span style={{ minWidth: 0 }}>
                      <span class="ell" style={{ display: 'block', fontSize: 14, fontWeight: 650 }}>{st.oppLabel}</span>
                      <span class="faint ell" style={{ display: 'block', fontSize: 12 }}>{st.opp ? `${origin(M, st.opp)} · ${rating(t, st.opp)}` : st.res === 'bye' ? 'Advanced automatically' : 'Awaiting result'}</span>
                    </span>
                    <span class="mono" style={{ fontSize: 15, fontWeight: 700 }}>{st.res === 'bye' ? '' : st.my != null && st.os != null ? `${st.my}–${st.os}` : '–'}</span>
                    <span class={`res ${st.res}`}>{st.res === 'won' ? 'W' : st.res === 'lost' ? 'L' : st.res === 'bye' ? 'Bye' : 'Next'}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {s && (
            <>
              <div class="section-head" style={{ padding: 0, marginTop: 22 }}><h3 style={{ fontSize: 17 }}>{s.group.name}</h3><span class="mono faint" style={{ fontSize: 12 }}>{groupPlayed}/{groupTotal} played</span></div>
              <div style={{ marginTop: 10, borderRadius: 20, padding: '2px 12px', background: 'var(--chip)', border: '1px solid var(--chip-border)' }}>
                {s.group.players.map((gp, i) => (
                  <div key={gp.name} style={{ display: 'grid', gridTemplateColumns: '22px minmax(0,1fr) 46px 36px', alignItems: 'center', gap: 10, minHeight: 46, borderTop: i ? '1px solid var(--hair)' : '1px solid transparent' }}>
                    <span class="mono faint" style={{ fontSize: 13 }}>{gp.rank}</span>
                    <span class="ell" style={{ fontSize: 14, fontWeight: gp.name === name ? 700 : 500, color: gp.name === name ? 'var(--accent-text)' : 'var(--text)' }}>{gp.name}</span>
                    <span class="mono faint" style={{ fontSize: 12, textAlign: 'right' }}>{rating(t, gp.name)}</span>
                    <span class="mono" style={{ fontSize: 13, fontWeight: 600, textAlign: 'right' }}>{gp.wins}–{gp.losses}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
