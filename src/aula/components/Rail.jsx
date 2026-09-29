import { useRef, useState } from 'react';
import { useAula } from '../context.js';
import { colorOf } from '../lib/model.js';
import { fmt } from '../lib/dates.js';
import * as store from '../lib/store.js';

export default function Rail() {
  const { data, cal, route, go, toast } = useAula();
  const [pending, setPending] = useState(null); // a parsed backup waiting for confirmation
  const fileRef = useRef(null);
  const w = cal.nowWeek();
  const line = w < 1 ? 'Starts ' + fmt(cal.start, false) : w > cal.weeks ? 'Term complete' : 'Week ' + w + ' of ' + cal.weeks;

  async function backup() {
    const out = await store.exportData();
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'aula-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Backup saved. Stored files are not included.');
  }

  async function pick(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const json = JSON.parse(await f.text());
      if (json.app !== 'aula') throw new Error('not aula');
      setPending(json);
    } catch (_) { toast('That file is not an Aula backup.', true); }
  }

  async function restore() {
    try { await store.importData(pending, { replace: true }); toast('Restored backup from ' + fmt(new Date(pending.exportedAt)) + '.'); }
    catch (err) { toast(err.message, true); }
    setPending(null);
  }

  const item = (r, label, extra) => {
    const on = route.view === r.view && (r.view !== 'course' || route.id === r.id);
    return (
      <button key={r.id || r.view} className={'nav-item' + (r.view === 'course' ? ' nav-course' : '') + (on ? ' is-on' : '')}
        aria-current={on ? 'page' : undefined} onClick={() => go(r)} style={extra}>
        {label}
      </button>
    );
  };

  return (
    <nav className="rail" aria-label="Aula">
      <div className="brand"><span className="wordmark">Aula</span><span className="brand-sub mono">{cal.name} · {line}</span></div>
      <div className="nav-group">
        {item({ view: 'semester' }, 'Semester')}
        {item({ view: 'library' }, 'Library')}
      </div>
      <div className="nav-label label">Courses</div>
      <div className="nav-group">
        {data.courses.map(c => item({ view: 'course', id: c.id },
          <><span className="sw" /><span className="mono">{c.number}</span><span className="nav-course-t">{c.title}</span></>,
          { '--c': colorOf(c) }))}
      </div>
      <div className="rail-foot">
        {pending ? (
          <div className="confirm">
            <p>Replace every course, assignment and document with the backup from {fmt(new Date(pending.exportedAt))}?</p>
            <div className="btn-row"><button className="btn btn-solid" onClick={restore}>Replace</button><button className="btn btn-quiet" onClick={() => setPending(null)}>Cancel</button></div>
          </div>
        ) : (
          <div className="btn-row">
            <button className="btn btn-quiet" onClick={backup}>Back up</button>
            <button className="btn btn-quiet" onClick={() => fileRef.current && fileRef.current.click()}>Restore</button>
          </div>
        )}
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={pick} />
      </div>
    </nav>
  );
}
