import { useState } from 'react';
import { useAula } from '../context.js';
import { DocRow } from '../components/Rows.jsx';
import { DOC_STATUS, KINDS, byCode, colorOf } from '../lib/model.js';

export default function LibraryView() {
  const { data, openDrawer } = useAula();
  const [f, setF] = useState({ course: 'all', kind: 'all', status: 'all', q: '' });
  const q = f.q.trim().toLowerCase();
  const all = data.documents.slice().sort(byCode);
  const list = all.filter(d =>
    (f.course === 'all' || (f.course === 'none' ? !d.courseId : d.courseId === f.course || (d.alsoIn || []).includes(f.course))) &&
    (f.kind === 'all' || d.kind === f.kind) &&
    (f.status === 'all' || d.status === f.status) &&
    (!q || [d.title, d.author, d.code, d.notes, d.kind].some(v => String(v || '').toLowerCase().includes(q))));
  const reading = all.filter(d => d.status === 'Reading').length, done = all.filter(d => d.status === 'Done').length;
  const chip = (val, label, c) => (
    <button key={val} className="chip" aria-pressed={f.course === val} style={c ? { '--c': colorOf(c) } : undefined} onClick={() => setF({ ...f, course: val })}>
      {c && <span className="sw" />}{label}
    </button>
  );
  return (
    <>
      <header className="page-head">
        <div className="eyebrow">Library</div>
        <h1 className="display">Library</h1>
        <p className="lede">{all.length} documents and artifacts across {data.courses.length} courses · {reading} reading · {done} done</p>
      </header>
      <div className="filters">
        <label className="field grow"><span>Search</span>
          <input type="search" value={f.q} placeholder="Title, author, code or notes" onChange={e => setF({ ...f, q: e.target.value })} /></label>
        <div className="field"><span>Course</span>
          <div className="chips">{chip('all', 'All')}{data.courses.map(c => chip(c.id, c.number, c))}{chip('none', 'Unfiled')}</div></div>
        <label className="field"><span>Kind</span>
          <select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })}>
            <option value="all">All kinds</option>{KINDS.map(([k]) => <option key={k}>{k}</option>)}
          </select></label>
        <label className="field"><span>Status</span>
          <select value={f.status} onChange={e => setF({ ...f, status: e.target.value })}>
            <option value="all">Any status</option>{DOC_STATUS.map(s => <option key={s}>{s}</option>)}
          </select></label>
      </div>
      <div className="legend">
        <span><b>410-B-001</b> = course 410, book, first registered</span>
        {KINDS.map(([k, l]) => <span key={k}><b>{l}</b> {k.toLowerCase()}</span>)}
        <span><b>GEN</b> unfiled</span>
      </div>
      {list.length ? list.map(d => <DocRow key={d.id} d={d} lib />) : <p className="empty-note">Nothing matches these filters.</p>}
      <div className="toolbar"><span />
        <div className="btn-row">
          <button className="btn" onClick={e => openDrawer({ type: 'new-doc', course: null, kind: 'Book' }, e.currentTarget)}>Add document</button>
          <button className="btn btn-quiet" onClick={e => openDrawer({ type: 'new-doc', course: null, kind: 'Artifact' }, e.currentTarget)}>Add artifact or link</button>
        </div>
      </div>
    </>
  );
}
