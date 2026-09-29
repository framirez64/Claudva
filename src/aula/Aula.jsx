import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ctx } from './context.js';
import './aula.css';
import * as store from './lib/store.js';
import { makeCalendar } from './lib/dates.js';
import { makeIndex } from './lib/model.js';
import Rail from './components/Rail.jsx';
import SemesterView from './views/SemesterView.jsx';
import CourseView from './views/CourseView.jsx';
import LibraryView from './views/LibraryView.jsx';
import Drawer from './drawers/Drawer.jsx';

const EMPTY = { term: [], courses: [], modules: [], assignments: [], documents: [] };

function parseHash() {
  const h = (window.location.hash || '').replace(/^#\/?/, '');
  if (h === 'library') return { view: 'library' };
  const m = /^course\/([\w-]+)$/.exec(h);
  return m ? { view: 'course', id: m[1] } : { view: 'semester' };
}

function readLocal(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; } }
function writeLocal(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* per-browser convenience only */ } }

export default function Aula() {
  const [data, setData] = useState(EMPTY);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [route, setRoute] = useState(parseHash);
  const [tab, setTabState] = useState(() => readLocal('aula.tab', 'modules'));
  const [drawer, setDrawer] = useState(null);
  const [toastState, setToastState] = useState(null);
  const toastTimer = useRef(null);
  const lastTrigger = useRef(null);

  // Load: seed on first run, then keep every collection subscribed.
  useEffect(() => {
    if (typeof indexedDB === 'undefined') { setStatus('error'); return undefined; }
    const unsubs = store.COLLECTIONS.map(coll =>
      store.subscribe(coll, rows => setData(prev => ({ ...prev, [coll]: rows }))));
    store.seedIfEmpty(import.meta.env.BASE_URL + 'aula-data.json')
      .catch(err => console.error(err))
      .finally(() => setStatus(s => (s === 'error' ? s : 'ready')));
    return () => unsubs.forEach(u => u());
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback(r => {
    const h = r.view === 'course' ? '#/course/' + r.id : r.view === 'library' ? '#/library' : '#/';
    if (window.location.hash !== h) window.location.hash = h;
    else setRoute(r);
    window.scrollTo(0, 0);
  }, []);

  const setTab = useCallback(t => { setTabState(t); writeLocal('aula.tab', t); }, []);

  const toast = useCallback((msg, isErr = false) => {
    setToastState({ msg, isErr, key: Date.now() });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastState(null), isErr ? 5200 : 2200);
  }, []);

  const save = useCallback(async (fn, ok) => {
    try { await fn(); if (ok) toast(ok); return true; }
    catch (e) {
      const quota = e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));
      toast(quota ? "This browser's storage for Aula is full. Remove stored files you no longer need." : "Couldn't save: " + ((e && e.message) || 'unknown error'), true);
      return false;
    }
  }, [toast]);

  const openDrawer = useCallback((d, trigger) => { if (trigger) lastTrigger.current = trigger; setDrawer(d); }, []);
  const closeDrawer = useCallback(() => {
    setDrawer(null);
    const t = lastTrigger.current;
    if (t && document.body.contains(t)) t.focus({ preventScroll: true });
  }, []);

  const sorted = useMemo(() => ({
    ...data,
    courses: [...data.courses].sort((a, b) => (a.order || 0) - (b.order || 0)),
  }), [data]);
  const cal = useMemo(() => makeCalendar(data.term.find(t => t.id === 'fall-2026') || data.term[0]), [data.term]);
  const idx = useMemo(() => makeIndex(sorted), [sorted]);

  const ctx = { data: sorted, cal, idx, route, go, tab, setTab, toast, save, openDrawer, closeDrawer, drawer, setDrawer };

  let view;
  if (status === 'error') view = <StateNote eyebrow="Storage unavailable" title="Aula can't reach its records" body="Aula keeps your semester in this browser's IndexedDB, which isn't available here. Private windows in some browsers turn it off." />;
  else if (status === 'loading') view = <StateNote eyebrow={cal.name} title="Opening your semester" body="Your courses, their weekly modules and assignments, and every document and artifact filed under them will appear here." skeleton />;
  else if (!sorted.courses.length) view = <StateNote eyebrow="No term yet" title="No courses filed" body="Aula is empty. Restore a backup from the rail, or add public/aula-data.json and clear this site's data to import it again." />;
  else if (route.view === 'course' && idx.course(route.id)) view = <CourseView course={idx.course(route.id)} />;
  else if (route.view === 'library') view = <LibraryView />;
  else view = <SemesterView />;

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <Rail />
        <main className="main" id="main" tabIndex={-1}>{view}</main>
      </div>
      {drawer && <Drawer />}
      <div className={'toast' + (toastState ? ' show' : '')} role="status" aria-live="polite">{toastState ? toastState.msg : ''}</div>
    </Ctx.Provider>
  );
}

function StateNote({ eyebrow, title, body, skeleton }) {
  return (
    <div className="state">
      <div className="eyebrow">{eyebrow}</div>
      <h1 className="h1">{title}</h1>
      <p className="lede">{body}</p>
      {skeleton && <div className="skeleton" aria-hidden="true"><span /><span /><span /><span /></div>}
    </div>
  );
}
