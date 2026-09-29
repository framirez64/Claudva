import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAula } from '../context.js';
import { fmt, iso, parseISO, today, wkLabel } from '../lib/dates.js';
import {
  A_STATUS, DOC_STATUS, KIND_NAMES, LINKED, ROLES, colorOf, dueText, fmtSize, nextCode, safeUrl, stamp, titleFromFile, weightText,
} from '../lib/model.js';
import * as store from '../lib/store.js';

/* ---------- shell ---------- */
export default function Drawer() {
  const { drawer, closeDrawer, data } = useAula();
  const ref = useRef(null);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeDrawer]);

  useEffect(() => {
    const el = ref.current;
    const f = el && (el.querySelector('[data-autofocus]') || el.querySelector('.dr-close'));
    if (f) f.focus({ preventScroll: true });
  }, [drawer.type, drawer.id]);

  let body = null;
  if (drawer.type === 'doc') { const d = data.documents.find(x => x.id === drawer.id); if (d) body = <DocDrawer key={d.id} d={d} />; }
  else if (drawer.type === 'asg') { const a = data.assignments.find(x => x.id === drawer.id); if (a) body = <AsgDrawer key={a.id} a={a} />; }
  else if (drawer.type === 'new-doc') body = <NewDocDrawer key={'nd' + (drawer.file ? drawer.file.name : '')} dr={drawer} />;
  else if (drawer.type === 'new-asg') body = <NewAsgDrawer dr={drawer} />;

  return (
    <>
      <div className="scrim" onClick={closeDrawer} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="dr-label" ref={ref}>{body}</aside>
    </>
  );
}

function Head({ color, code, closeLabel = 'Close', eyebrow, children }) {
  const { closeDrawer } = useAula();
  return (
    <div className="dr-head" style={{ '--c': color }}>
      <div className="dr-top"><span className="dr-code" id="dr-label">{code}</span><button className="btn btn-quiet dr-close" onClick={closeDrawer}>{closeLabel}</button></div>
      <div className="eyebrow">{eyebrow}</div>
      {children}
    </div>
  );
}

/* ---------- inputs that save when you leave them ---------- */
function Commit({ value, onCommit, multiline, autosize, ...rest }) {
  const [v, setV] = useState(value ?? '');
  const focused = useRef(false);
  const ref = useRef(null);
  useEffect(() => { if (!focused.current) setV(value ?? ''); }, [value]);
  useLayoutEffect(() => { if (autosize && ref.current) { ref.current.style.height = 'auto'; ref.current.style.height = ref.current.scrollHeight + 'px'; } }, [v, autosize]);
  const commit = async () => {
    focused.current = false;
    if (String(v) === String(value ?? '')) return;
    const ok = await onCommit(v);
    if (ok === false) setV(value ?? '');
  };
  const props = {
    ...rest, ref, value: v,
    onChange: e => setV(e.target.value),
    onFocus: () => { focused.current = true; },
    onBlur: commit,
    onKeyDown: e => { if (autosize && e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } },
  };
  return multiline ? <textarea {...props} /> : <input {...props} />;
}

function Notes({ value, onCommit, id }) {
  const [v, setV] = useState(value ?? '');
  const focused = useRef(false);
  const timer = useRef(null);
  useEffect(() => { if (!focused.current) setV(value ?? ''); }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flush = next => { clearTimeout(timer.current); if (next !== (value ?? '')) onCommit(next); };
  return (
    <textarea id={id} rows={8} value={v} aria-label="Notes"
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; flush(v); }}
      onChange={e => { const next = e.target.value; setV(next); clearTimeout(timer.current); timer.current = setTimeout(() => flush(next), 900); }} />
  );
}

// Validates and saves one field, mirroring the rules of the claude.ai version.
function useSaveField(coll, rec) {
  const { cal, save, toast } = useAula();
  return async (field, raw, { number = false } = {}) => {
    let v = raw;
    if (number) { v = raw === '' || raw == null ? null : Number(raw); if (v !== null && !Number.isFinite(v)) return false; }
    if (typeof v === 'string' && field !== 'notes') v = v.trim();
    if ((field === 'courseId' || field === 'moduleId') && v === '') v = null;
    if (field === 'title' && !v) { toast('A title is required.', true); return false; }
    if ((field === 'url' || field === 'deliverableUrl') && v && !safeUrl(v)) { toast('Links need to start with https:// or http://', true); return false; }
    if (field === 'due' && v && !parseISO(v)) { toast('Pick a full date.', true); return false; }
    const patch = { [field]: v, updatedAt: stamp() };
    if (field === 'weekStart' || field === 'weekEnd') {
      if (v !== null) patch[field] = Math.min(cal.weeks, Math.max(1, Math.round(v)));
      const ws = field === 'weekStart' ? patch.weekStart : rec.weekStart;
      const we = field === 'weekEnd' ? patch.weekEnd : rec.weekEnd;
      if (ws != null && (we == null || we < ws)) patch.weekEnd = ws;
    }
    if (field === 'pagesTotal' && v !== null) {
      patch.pagesTotal = Math.max(1, Math.round(v));
      if ((+rec.pagesRead || 0) >= patch.pagesTotal && rec.status === 'Reading') patch.status = 'Done';
    }
    if ((field === 'score' || field === 'weight') && v !== null) patch[field] = Math.min(100, Math.max(0, v));
    if (rec[field] === patch[field] && Object.keys(patch).length === 2) return true;
    return save(() => store.update(coll, rec.id, patch), field === 'notes' ? '' : 'Saved');
  };
}

export function Confirm({ label, question, onConfirm }) {
  const [asking, setAsking] = useState(false);
  return (
    <section className="dr-sec danger">
      {asking ? (
        <div className="confirm"><p>{question}</p>
          <div className="btn-row"><button className="btn btn-solid" onClick={onConfirm}>{label}</button><button className="btn btn-quiet" onClick={() => setAsking(false)}>Keep it</button></div>
        </div>
      ) : <button className="btn btn-quiet" onClick={() => setAsking(true)}>{label}…</button>}
    </section>
  );
}

function FileLink({ d }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    store.files.url(d.assetId).then(u => { if (alive) setUrl(u || ''); });
    return () => { alive = false; };
  }, [d.assetId]);
  if (url === null) return <span className="muted">{d.fileName}</span>;
  if (!url) return <span className="muted">{d.fileName} is missing from this browser's storage.</span>;
  return <a href={url} target="_blank" rel="noopener">{d.fileName || 'Stored file'}</a>;
}

const Select = ({ id, value, options, onChange, labels }) => (
  <select id={id} value={value ?? ''} onChange={e => onChange(e.target.value)}>
    {options.map((o, i) => <option key={o} value={o}>{labels ? labels[i] : o}</option>)}
  </select>
);

/* ---------- document ---------- */
function DocDrawer({ d }) {
  const { data, cal, idx, save, toast, closeDrawer } = useAula();
  const saveField = useSaveField('documents', d);
  const c = idx.course(d.courseId);
  const linked = LINKED.has(d.kind);
  const url = safeUrl(d.url);
  const pct = d.pagesTotal ? Math.min(100, Math.round(((+d.pagesRead || 0) / d.pagesTotal) * 100)) : 0;
  const log = (d.log || []).slice().reverse();
  const [lg, setLg] = useState({ date: iso(today()), page: '', note: '' });
  const courseIds = ['', ...data.courses.map(x => x.id)];
  const courseLabels = ['Unfiled', ...data.courses.map(x => x.code + ' · ' + x.title)];

  async function attach(file) {
    if (!file) return;
    const old = d.assetId;
    const ok = await save(async () => {
      const up = await store.files.put(file);
      await store.update('documents', d.id, { ...up, updatedAt: stamp() });
    }, (old ? 'Replaced file on ' : 'Attached file to ') + d.code);
    if (ok && old) store.files.remove(old);
  }

  async function logSession(e) {
    e.preventDefault();
    if (!parseISO(lg.date)) { toast('Pick a date for the session.', true); return; }
    if (lg.page === '' && !lg.note.trim()) { toast('Add the page you reached, a note, or both.', true); return; }
    const from = +d.pagesRead || 0;
    let to = lg.page === '' ? null : Math.max(0, Math.round(+lg.page));
    if (to !== null && d.pagesTotal) to = Math.min(to, d.pagesTotal);
    const patch = { log: [...(d.log || []), { date: lg.date, from, to, note: lg.note.trim() }].slice(-400), updatedAt: stamp() };
    if (to !== null) patch.pagesRead = Math.max(from, to);
    const reached = patch.pagesRead ?? from;
    if (d.status === 'Queued') patch.status = 'Reading';
    if (d.pagesTotal && reached >= d.pagesTotal && d.status !== 'Reference') patch.status = 'Done';
    const ok = await save(() => store.update('documents', d.id, patch), 'Session logged' + (patch.status === 'Done' ? ' · marked done' : ''));
    if (ok) setLg({ date: lg.date, page: '', note: '' });
  }

  async function removeDoc() {
    const ok = await save(() => store.remove('documents', d.id), 'Removed ' + d.code);
    if (ok) { if (d.assetId) store.files.remove(d.assetId); closeDrawer(); }
  }

  return (
    <>
      <Head color={colorOf(c)} code={d.code} eyebrow={[d.kind, c ? c.code : 'Unfiled', d.weekStart ? wkLabel(d.weekStart, d.weekEnd) : '', d.role].filter(Boolean).join(' · ')}>
        <Commit multiline autosize rows={1} className="dr-title" aria-label="Title" value={d.title} onCommit={v => saveField('title', v)} />
      </Head>
      <div className="dr-body">
        <div className="fields">
          <label className="field span2"><span>Author or source</span><Commit type="text" value={d.author} onCommit={v => saveField('author', v)} /></label>
          <label className="field"><span>Kind</span><Select value={d.kind} options={KIND_NAMES} onChange={v => saveField('kind', v)} /></label>
          <label className="field"><span>Status</span><Select value={d.status} options={DOC_STATUS} onChange={v => saveField('status', v)} /></label>
          <label className="field"><span>Course</span><Select value={d.courseId || ''} options={courseIds} labels={courseLabels} onChange={v => saveField('courseId', v)} /></label>
          <label className="field"><span>Role</span><Select value={d.role} options={ROLES} onChange={v => saveField('role', v)} /></label>
          <label className="field"><span>From week</span><Commit type="number" min="1" max={cal.weeks} value={d.weekStart} onCommit={v => saveField('weekStart', v, { number: true })} /></label>
          <label className="field"><span>To week</span><Commit type="number" min="1" max={cal.weeks} value={d.weekEnd} onCommit={v => saveField('weekEnd', v, { number: true })} /></label>
        </div>

        <section className="dr-sec"><h3 className="label">Source</h3>
          <label className="field"><span>Link</span><Commit type="url" placeholder="https://" value={d.url} onCommit={v => saveField('url', v)} /></label>
          {url && <div className="src-line"><a className="btn" href={url} target="_blank" rel="noopener">Open link ↗</a><span className="mono muted">{url.replace(/^https?:\/\//, '').slice(0, 48)}</span></div>}
          {d.assetId ? (
            <div className="src-line"><FileLink d={d} /><span className="mono muted">{d.fileSize ? fmtSize(d.fileSize) : ''}</span>
              <label className="btn btn-quiet">Replace file<input type="file" hidden onChange={e => { attach(e.target.files[0]); e.target.value = ''; }} /></label></div>
          ) : (
            <label className="dropzone"><b>Attach a file</b> Stored in this browser; PDFs open in a new tab.
              <input type="file" hidden onChange={e => { attach(e.target.files[0]); e.target.value = ''; }} /></label>
          )}
        </section>

        {!linked && (
          <section className="dr-sec"><h3 className="label">Progress</h3>
            <div className="progress-line"><span className="meter"><span style={{ width: pct + '%' }} /></span>
              <span className="mono">{d.pagesTotal ? `p. ${d.pagesRead || 0} of ${d.pagesTotal} · ${pct}%` : `p. ${d.pagesRead || 0}`}</span></div>
            <div className="fields"><label className="field"><span>Total pages</span>
              <Commit type="number" min="1" placeholder="Add to track percent" value={d.pagesTotal} onCommit={v => saveField('pagesTotal', v, { number: true })} /></label></div>
            <form className="log-form" onSubmit={logSession}>
              <label className="field"><span>Date</span><input type="date" required value={lg.date} onChange={e => setLg({ ...lg, date: e.target.value })} /></label>
              <label className="field"><span>Reached page</span><input type="number" min="0" placeholder={String((+d.pagesRead || 0) + 20)} value={lg.page} onChange={e => setLg({ ...lg, page: e.target.value })} /></label>
              <label className="field lf-note"><span>Note</span><input type="text" placeholder="What stuck" value={lg.note} onChange={e => setLg({ ...lg, note: e.target.value })} /></label>
              <button className="btn btn-solid" type="submit">Log session</button>
            </form>
            {log.length ? (
              <ul className="log">{log.map((e, i) => (
                <li key={i}><span className="mono">{fmt(e.date)}</span>
                  <span className="mono">{e.to != null ? (e.from != null && e.from !== e.to ? `pp. ${e.from}–${e.to}` : `p. ${e.to}`) : ''}</span>
                  <span className="lg-note">{e.note}</span></li>
              ))}</ul>
            ) : <p className="hint">No sessions logged yet. The first one moves this document to Reading.</p>}
          </section>
        )}

        <section className="dr-sec"><h3 className="label">Notes</h3>
          <Notes id="dd-notes" value={d.notes} onCommit={v => saveField('notes', v)} />
          <p className="hint">Saved as you type. Markdown is fine.</p></section>

        <Confirm label="Remove document" question={`Remove ${d.code} from Aula for good?${d.assetId ? ' Its stored file is deleted too.' : ''}`} onConfirm={removeDoc} />
      </div>
    </>
  );
}

/* ---------- assignment ---------- */
function AsgDrawer({ a }) {
  const { cal, idx, save, toast, closeDrawer } = useAula();
  const saveField = useSaveField('assignments', a);
  const c = idx.course(a.courseId), mods = idx.modulesOf(a.courseId);
  const graded = c && c.grading !== 'completion', tally = a.cadence === 'weekly';
  const dt = dueText(a, cal), url = safeUrl(a.deliverableUrl);
  const log = (a.log || []).slice().reverse();
  const [tl, setTl] = useState({ date: iso(today()), note: '' });

  async function logContact(e) {
    e.preventDefault();
    if (!parseISO(tl.date) || !tl.note.trim()) { toast('Add a date and who you contacted.', true); return; }
    const next = [...(a.log || []), { date: tl.date, note: tl.note.trim() }].slice(-400);
    const patch = { log: next, updatedAt: stamp() };
    if (a.target && next.length >= a.target) patch.status = 'Submitted';
    const ok = await save(() => store.update('assignments', a.id, patch), 'Contact logged');
    if (ok) setTl({ date: tl.date, note: '' });
  }

  async function removeAsg() {
    const ok = await save(() => store.remove('assignments', a.id), 'Removed assignment');
    if (ok) closeDrawer();
  }

  return (
    <>
      <Head color={colorOf(c)} code={(c ? c.code : '') + ' · Assignment'} eyebrow={[dt.date, dt.rel, weightText(a, c)].filter(Boolean).join(' · ')}>
        <Commit multiline autosize rows={1} className="dr-title" aria-label="Title" value={a.title} onCommit={v => saveField('title', v)} />
      </Head>
      <div className="dr-body">
        <section className="dr-sec"><h3 className="label">Status</h3>
          <div className="seg" role="group" aria-label="Status">
            {A_STATUS.map(s => (
              <button key={s} aria-pressed={s === a.status} onClick={() => s !== a.status && save(() => store.update('assignments', a.id, { status: s, updatedAt: stamp() }), 'Marked ' + s.toLowerCase())}>{s}</button>
            ))}
          </div>
        </section>
        <div className="fields">
          <label className="field span2"><span>Module</span>
            <Select value={a.moduleId || ''} options={['', ...mods.map(m => m.id)]} labels={['No module', ...mods.map(m => wkLabel(m.weekStart, m.weekEnd) + ' · ' + m.title)]} onChange={v => saveField('moduleId', v)} /></label>
          {!tally && <label className="field"><span>Due</span><Commit type="date" value={a.due} onCommit={v => saveField('due', v)} /></label>}
          {graded && !tally && <label className="field"><span>Weight, % of grade</span><Commit type="number" min="0" max="100" value={a.weight} onCommit={v => saveField('weight', v, { number: true })} /></label>}
          {graded && !tally && <label className="field"><span>Self-score, 0–100</span><Commit type="number" min="0" max="100" placeholder="Once assessed" value={a.score} onCommit={v => saveField('score', v, { number: true })} /></label>}
        </div>
        {tally ? (
          <section className="dr-sec"><h3 className="label">Log · {log.length} of {a.target || cal.weeks}</h3>
            <form className="log-form" onSubmit={logContact}>
              <label className="field"><span>Date</span><input type="date" required value={tl.date} onChange={e => setTl({ ...tl, date: e.target.value })} /></label>
              <label className="field lf-note" style={{ gridColumn: 'span 2' }}><span>Who, and how</span><input type="text" required placeholder="Emailed the operations lead" value={tl.note} onChange={e => setTl({ ...tl, note: e.target.value })} /></label>
              <button className="btn btn-solid" type="submit">Log contact</button>
            </form>
            {log.length ? <ul className="log">{log.map((e, i) => <li key={i}><span className="mono">{fmt(e.date)}</span><span className="mono">Wk {cal.weekOf(parseISO(e.date) || today())}</span><span className="lg-note">{e.note}</span></li>)}</ul>
              : <p className="hint">No contacts logged yet.</p>}
          </section>
        ) : (
          <section className="dr-sec"><h3 className="label">Deliverable</h3>
            <label className="field"><span>Repo, report or recording link</span><Commit type="url" placeholder="https://" value={a.deliverableUrl} onCommit={v => saveField('deliverableUrl', v)} /></label>
            {url && <div className="src-line"><a className="btn" href={url} target="_blank" rel="noopener">Open deliverable ↗</a></div>}
          </section>
        )}
        <section className="dr-sec"><h3 className="label">Notes</h3>
          <Notes id="da-notes" value={a.notes} onCommit={v => saveField('notes', v)} />
          <p className="hint">Saved as you type.</p></section>
        <Confirm label="Remove assignment" question={`Remove this assignment from ${c ? c.code : 'Aula'} for good?`} onConfirm={removeAsg} />
      </div>
    </>
  );
}

/* ---------- new document ---------- */
function NewDocDrawer({ dr }) {
  const { data, cal, idx, save, setDrawer } = useAula();
  const c = idx.course(dr.course);
  const isArt = dr.kind === 'Artifact';
  const w = Math.min(Math.max(cal.nowWeek(), 1), cal.weeks);
  const [f, setF] = useState({
    title: (dr.prefill && dr.prefill.title) || '', author: '', kind: dr.kind || 'Book', courseId: dr.course || '',
    ws: String(w), we: String(w), role: isArt ? 'Reference' : 'Required', total: '', url: '',
  });
  const [file, setFile] = useState(dr.file || null);
  const [over, setOver] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const takeFile = x => { if (!x) return; setFile(x); if (!f.title) setF(prev => ({ ...prev, title: titleFromFile(x.name) })); };

  async function submit(e) {
    e.preventDefault();
    const title = f.title.trim(), url = f.url.trim();
    if (!title) { setErr('Give the document a title.'); return; }
    if (url && !safeUrl(url)) { setErr('Links need to start with https:// or http://'); return; }
    const clamp = v => (v === '' ? null : Math.min(cal.weeks, Math.max(1, Math.round(+v))));
    const ws = clamp(f.ws); let we = clamp(f.we) ?? ws;
    if (ws != null && (we == null || we < ws)) we = ws;
    const courseId = f.courseId || null;
    const code = nextCode(data.courses, data.documents, courseId, f.kind);
    const id = store.newId();
    setBusy(true);
    const ok = await save(async () => {
      const up = file ? await store.files.put(file) : {};
      await store.set('documents', id, {
        code, courseId, kind: f.kind, title, author: f.author.trim(), weekStart: ws, weekEnd: we, role: f.role,
        status: LINKED.has(f.kind) || f.role === 'Reference' ? 'Reference' : 'Queued', pagesRead: 0,
        pagesTotal: f.total ? Math.max(1, Math.round(+f.total)) : null, url, notes: '', log: [],
        createdAt: stamp(), updatedAt: stamp(), ...up,
      });
    }, 'Registered ' + code);
    setBusy(false);
    if (ok) setDrawer({ type: 'doc', id });
  }

  return (
    <>
      <Head color={colorOf(c)} code={isArt ? 'New artifact or link' : 'New document'} closeLabel="Cancel" eyebrow={c ? c.code + ' · ' + c.title : 'Library'} />
      <div className="dr-body">
        <form className="fields" onSubmit={submit}>
          <label className="field span2"><span>Title</span><input type="text" required data-autofocus value={f.title} onChange={set('title')} placeholder={isArt ? 'Aula — Design Document' : 'Build a Large Language Model (From Scratch)'} /></label>
          <label className="field span2"><span>Author or source</span><input type="text" value={f.author} onChange={set('author')} placeholder={isArt ? 'Claude, GitHub, a website' : 'Sebastian Raschka'} /></label>
          <label className="field"><span>Kind</span><select value={f.kind} onChange={set('kind')}>{KIND_NAMES.map(k => <option key={k}>{k}</option>)}</select></label>
          <label className="field"><span>Course</span><select value={f.courseId} onChange={set('courseId')}>
            <option value="">Unfiled</option>{data.courses.map(x => <option key={x.id} value={x.id}>{x.code} · {x.title}</option>)}</select></label>
          <label className="field"><span>From week</span><input type="number" min="1" max={cal.weeks} value={f.ws} onChange={set('ws')} /></label>
          <label className="field"><span>To week</span><input type="number" min="1" max={cal.weeks} value={f.we} onChange={set('we')} /></label>
          <label className="field"><span>Role</span><select value={f.role} onChange={set('role')}>{ROLES.map(r => <option key={r}>{r}</option>)}</select></label>
          <label className="field"><span>Total pages</span><input type="number" min="1" placeholder="Optional" value={f.total} onChange={set('total')} /></label>
          <label className="field span2"><span>Link</span><input type="url" placeholder="https://" value={f.url} onChange={set('url')} /></label>
          <div className="field span2"><span>File</span>
            <label className={'dropzone' + (over ? ' is-over' : '')}
              onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={e => { e.preventDefault(); setOver(false); takeFile(e.dataTransfer.files && e.dataTransfer.files[0]); }}>
              {file ? <><b>{file.name}</b> {fmtSize(file.size)} · choose another to replace it</> : <><b>Choose a file</b> or drop it here. Stored in this browser.</>}
              <input type="file" hidden onChange={e => { takeFile(e.target.files[0]); e.target.value = ''; }} />
            </label>
          </div>
          {err && <p className="err span2" role="alert">{err}</p>}
          <div className="btn-row span2"><button className="btn btn-solid" type="submit" disabled={busy}>{busy ? 'Saving…' : isArt ? 'Register artifact' : 'Register document'}</button></div>
          <p className="hint span2">Aula assigns the accession code when you register it: course number, kind letter, sequence.</p>
        </form>
      </div>
    </>
  );
}

/* ---------- new assignment ---------- */
function NewAsgDrawer({ dr }) {
  const { cal, idx, save, setDrawer } = useAula();
  const c = idx.course(dr.course), mods = idx.modulesOf(dr.course), w = cal.nowWeek();
  const cur = mods.find(m => w >= m.weekStart && w <= m.weekEnd) || mods[0];
  const graded = c && c.grading !== 'completion';
  const [f, setF] = useState({ title: '', moduleId: cur ? cur.id : '', due: '', weight: '0' });
  const [err, setErr] = useState('');
  const set = k => e => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    const title = f.title.trim();
    if (!title || !parseISO(f.due)) { setErr('An assignment needs a title and a due date.'); return; }
    const id = store.newId();
    const body = { courseId: dr.course, moduleId: f.moduleId || null, title, due: f.due, status: 'Not started', createdAt: stamp(), updatedAt: stamp() };
    if (graded) body.weight = Math.min(100, Math.max(0, +f.weight || 0));
    const ok = await save(() => store.set('assignments', id, body), 'Added ' + title);
    if (ok) setDrawer({ type: 'asg', id });
  }

  return (
    <>
      <Head color={colorOf(c)} code="New assignment" closeLabel="Cancel" eyebrow={c ? c.code + ' · ' + c.title : ''} />
      <div className="dr-body">
        <form className="fields" onSubmit={submit}>
          <label className="field span2"><span>Title</span><input type="text" required data-autofocus placeholder="Lab 6: speculative decoding" value={f.title} onChange={set('title')} /></label>
          <label className="field span2"><span>Module</span><select value={f.moduleId} onChange={set('moduleId')}>
            <option value="">No module</option>{mods.map(m => <option key={m.id} value={m.id}>{wkLabel(m.weekStart, m.weekEnd)} · {m.title}</option>)}</select></label>
          <label className="field"><span>Due</span><input type="date" required min={cal.start} value={f.due} onChange={set('due')} /></label>
          {graded && <label className="field"><span>Weight, % of grade</span><input type="number" min="0" max="100" value={f.weight} onChange={set('weight')} /></label>}
          {err && <p className="err span2" role="alert">{err}</p>}
          <div className="btn-row span2"><button className="btn btn-solid" type="submit">Add assignment</button></div>
          {graded && <p className="hint span2">Weights across a course should total 100%. Adjust the others after adding this one.</p>}
        </form>
      </div>
    </>
  );
}
