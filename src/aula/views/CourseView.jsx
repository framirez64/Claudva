import { useState } from 'react';
import { useAula } from '../context.js';
import { AsgRow, DocRow, Glyph, Rel } from '../components/Rows.jsx';
import { Confirm } from '../drawers/Drawer.jsx';
import { fmt, wkLabel } from '../lib/dates.js';
import { A_STATUS, DONE, LINKED, asgFill, byCode, byDue, colorOf, courseRemoval, dueText, progress, safeUrl, stamp, titleFromFile, weightText } from '../lib/model.js';
import * as store from '../lib/store.js';

export default function CourseView({ course: c }) {
  const { data, cal, idx, tab, setTab } = useAula();
  const p = progress(c, data.assignments);
  const next = idx.asgOf(c.id).filter(a => a.due && !DONE.has(a.status)).sort(byDue)[0];
  const tabs = [['modules', 'Modules', idx.modulesOf(c.id).length], ['assignments', 'Assignments', idx.asgOf(c.id).length], ['documents', 'Documents', idx.docsOf(c.id).length]];
  const current = tabs.some(t => t[0] === tab) ? tab : 'modules';
  return (
    <>
      <header className="course-head" style={{ '--c': colorOf(c) }}>
        <div className="course-id">
          <span className="course-num">{c.number}</span>
          <div className="course-names">
            <span className="eyebrow">{c.code} · {c.hours} h/week · {c.grading === 'completion' ? 'completion' : 'weighted'}</span>
            <h1 className="h1">{c.title}</h1>
            <span className="muted">{c.tagline}</span>
          </div>
        </div>
        <p className="course-summary">{c.summary}</p>
        <div className="course-stats">
          <div className="stat"><span className="label">Progress</span><span className="meter"><span style={{ width: (p.pct * 100).toFixed(1) + '%' }} /></span><span className="v">{p.label}</span></div>
          <div className="stat"><span className="label">Next due</span><span className="v">
            {next ? <>{next.title}<br /><span className="mono muted">{fmt(next.due)} · {dueText(next, cal).rel}</span></> : 'Nothing left to submit'}
          </span></div>
          <div className="stat"><span className="label">Final</span><span className="v">{c.final}</span></div>
        </div>
      </header>
      <div className="tabs" role="tablist" aria-label={c.code + ' sections'}>
        {tabs.map(([k, label, n]) => (
          <button key={k} className="tab" role="tab" id={'tab-' + k} aria-selected={current === k} onClick={() => setTab(k)}>
            {label}<span className="mono muted">{n}</span>
          </button>
        ))}
      </div>
      <div className="tabpanel" role="tabpanel" aria-labelledby={'tab-' + current}>
        {current === 'assignments' ? <AssignmentsTab c={c} /> : current === 'documents' ? <DocumentsTab c={c} /> : <ModulesTab c={c} />}
      </div>
      <RemoveCourse key={c.id} c={c} />
    </>
  );
}

function RemoveCourse({ c }) {
  const { data, save, go } = useAula();
  const plan = courseRemoval(data, c.id);
  const n = (k, one, many) => k + ' ' + (k === 1 ? one : many);
  const question = `Remove ${c.code} from Aula for good? Its ${n(plan.modules.length, 'module', 'modules')} and ${n(plan.assignments.length, 'assignment', 'assignments')} are deleted.` +
    (plan.homed ? ` Its ${n(plan.homed, 'document stays', 'documents stay')} in the Library.` : '');
  async function removeCourse() {
    const ok = await save(async () => {
      for (const d of plan.documents) await store.update('documents', d.id, { ...d.patch, updatedAt: stamp() });
      for (const id of plan.assignments) await store.remove('assignments', id);
      for (const id of plan.modules) await store.remove('modules', id);
      await store.remove('courses', c.id);
    }, 'Removed ' + c.code);
    if (ok) go({ view: 'semester' });
  }
  return <div className="course-foot"><Confirm label="Remove course" question={question} onConfirm={removeCourse} /></div>;
}

function ModulesTab({ c }) {
  const { cal, idx } = useAula();
  const w = cal.nowWeek();
  const mods = idx.modulesOf(c.id), docs = idx.docsOf(c.id), as = idx.asgOf(c.id);
  if (!mods.length) return <p className="empty-note">No modules yet for {c.code}.</p>;
  const out = [];
  let cursor = 1;
  const gap = (a, b) => {
    const light = a === b && a === cal.lightWeek;
    return (
      <li className="module gap" key={'gap-' + a}>
        <div className="mod-wk"><span className="mono">{wkLabel(a, b).toUpperCase()}</span></div>
        <div className="mod-body">{light ? `Light week · ${cal.lightLabel || 'break'}. Nothing due.` : 'Open weeks. Nothing scheduled.'}</div>
      </li>
    );
  };
  for (const m of mods) {
    if (m.weekStart > cursor) out.push(gap(cursor, m.weekStart - 1));
    cursor = Math.max(cursor, (m.weekEnd || m.weekStart) + 1);
    const isNow = w >= m.weekStart && w <= m.weekEnd, past = w > m.weekEnd;
    const [s] = cal.weekSpan(m.weekStart), [, e] = cal.weekSpan(m.weekEnd);
    const mas = as.filter(a => a.moduleId === m.id).sort(byDue);
    const mds = docs.filter(d => d.weekStart != null && d.weekStart >= m.weekStart && d.weekStart <= m.weekEnd).sort(byCode);
    out.push(
      <li key={m.id} className={'module' + (isNow ? ' is-now' : '') + (past ? ' is-past' : '')}>
        <div className="mod-wk">
          <span className="mono">{wkLabel(m.weekStart, m.weekEnd).toUpperCase()}</span>
          <span className="mod-dates">{fmt(s, false)} – {fmt(e, false)}</span>
          {isNow && <span className="slant">Now</span>}
        </div>
        <div className="mod-body">
          <h2 className="h3">{m.title}</h2>
          <p className="muted">{m.summary}</p>
          {(mas.length > 0 || mds.length > 0) && (
            <div className="items">
              {mas.map(a => <AsgRow key={a.id} a={a} course={c} />)}
              {mds.map(d => <DocRow key={d.id} d={d} />)}
            </div>
          )}
        </div>
      </li>,
    );
  }
  if (cursor <= cal.weeks) out.push(gap(cursor, cal.weeks));
  return <ol className="modules">{out}</ol>;
}

function AssignmentsTab({ c }) {
  const { cal, idx, save, openDrawer } = useAula();
  const as = idx.asgOf(c.id).slice().sort(byDue);
  const graded = c.grading !== 'completion';
  const tot = as.reduce((n, a) => n + (a.cadence === 'weekly' ? 0 : +a.weight || 0), 0);
  return (
    <>
      <div className="toolbar">
        <p className="muted">{as.length} assignments{graded ? ' · weights total ' + tot + '%' : ' · graded on completion'}</p>
        <button className="btn" onClick={e => openDrawer({ type: 'new-asg', course: c.id }, e.currentTarget)}>Add assignment</button>
      </div>
      <div className="thead"><span /><span>Assignment</span><span>Due</span><span>Weight</span><span>Status</span></div>
      {as.length === 0 && <p className="empty-note">No assignments yet.</p>}
      {as.map(a => {
        const dt = dueText(a, cal), m = idx.moduleOf(a.moduleId);
        return (
          <div className="trow" key={a.id}>
            <Glyph shape="tri" fill={asgFill(a)} />
            <div className="t-main">
              <button className="textlink" onClick={e => openDrawer({ type: 'asg', id: a.id }, e.currentTarget)}>{a.title}</button>
              <span className="t-sub">{m ? wkLabel(m.weekStart, m.weekEnd) + ' · ' + m.title : 'No module'}{safeUrl(a.deliverableUrl) && <> · <span className="tagword">Deliverable</span></>}</span>
            </div>
            <div className="t-due"><span className="mono">{dt.date}</span>{dt.rel && (dt.late ? <span><Rel dt={dt} /></span> : <span className="rel">{dt.rel}</span>)}</div>
            <div className="t-w">{weightText(a, c)}</div>
            <div className="t-s">
              <select className="compact" aria-label={'Status of ' + a.title} value={a.status}
                onChange={e => { const v = e.target.value; save(() => store.update('assignments', a.id, { status: v, updatedAt: stamp() }), 'Marked ' + v.toLowerCase()); }}>
                {A_STATUS.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>
        );
      })}
    </>
  );
}

function DocumentsTab({ c }) {
  const { idx, openDrawer } = useAula();
  const [over, setOver] = useState(false);
  const docs = idx.docsOf(c.id).sort(byCode);
  const reads = docs.filter(d => !LINKED.has(d.kind)), links = docs.filter(d => LINKED.has(d.kind));
  const hasFiles = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  return (
    <div className={'drop-target' + (over ? ' is-over' : '')}
      onDragOver={e => { if (hasFiles(e)) { e.preventDefault(); setOver(true); } }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
      onDrop={e => {
        e.preventDefault(); setOver(false);
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) openDrawer({ type: 'new-doc', course: c.id, kind: /\.pdf$/i.test(f.name) ? 'Paper' : 'Notes', file: f, prefill: { title: titleFromFile(f.name) } });
      }}>
      <div className="toolbar">
        <p className="drop-hint">Drop a PDF or other file anywhere here to register it in {c.code}.</p>
        <div className="btn-row">
          <button className="btn" onClick={e => openDrawer({ type: 'new-doc', course: c.id, kind: 'Book' }, e.currentTarget)}>Add document</button>
          <button className="btn btn-quiet" onClick={e => openDrawer({ type: 'new-doc', course: c.id, kind: 'Artifact' }, e.currentTarget)}>Add artifact or link</button>
        </div>
      </div>
      <h2 className="label group-label">Readings and data · {reads.length}</h2>
      {reads.length ? reads.map(d => <DocRow key={d.id} d={d} />) : <p className="empty-note">No readings filed yet.</p>}
      <h2 className="label group-label">Artifacts and repositories · {links.length}</h2>
      {links.length ? links.map(d => <DocRow key={d.id} d={d} />) : <p className="empty-note">No artifacts yet. Use Add artifact or link to file a Claude artifact, a repo or a web page here.</p>}
    </div>
  );
}
