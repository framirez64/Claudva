import { useAula } from '../context.js';
import { Glyph, MiniAsg, MiniDoc } from '../components/Rows.jsx';
import { parseISO, today, diffDays, fmt, addDays, wkLabel, MON } from '../lib/dates.js';
import { colorOf, asgFill, byDue, byCode, dueText, progress, DONE, LINKED } from '../lib/model.js';

export default function SemesterView() {
  const { data, cal } = useAula();
  const w = cal.nowWeek();
  let big, lede;
  if (w < 1) { big = 'Starts ' + fmt(cal.start, false); lede = diffDays(today(), cal.startDate) + ' days until week 1.'; }
  else if (w > cal.weeks) { big = 'Term complete'; lede = cal.name + ' ended ' + fmt(cal.end) + '.'; }
  else {
    const [s, e] = cal.weekSpan(w);
    const left = cal.weeks - w;
    big = 'Week ' + w;
    lede = fmt(s, false) + ' – ' + fmt(e, false) + ' · ' + (left ? left + (left === 1 ? ' week' : ' weeks') + ' after this one' : 'final week') +
      (w === cal.lightWeek ? ' · light week (' + (cal.lightLabel || 'break') + '), nothing due' : '');
  }
  return (
    <>
      <header className="page-head">
        <div className="eyebrow">{cal.name} · {fmt(cal.start, false)} – {fmt(cal.end, false)}</div>
        <div className="head-row"><h1 className="display">{big}</h1>{w >= 1 && w <= cal.weeks && <span className="slant">Now</span>}</div>
        <p className="lede">{lede}</p>
      </header>
      <Ruler />
      <div className="sem-grid">
        <section className="plates" aria-label="Courses">{data.courses.map(c => <Plate key={c.id} c={c} />)}</section>
        <ThisWeek />
      </div>
    </>
  );
}

function Ruler() {
  const { data, cal, idx, go, openDrawer } = useAula();
  const N = cal.weeks, total = N * 7, s = cal.startDate, w = cal.nowWeek();
  const pos = d => ((diffDays(s, d) + 0.5) / total) * 100;
  const tp = pos(today());
  const weeks = Array.from({ length: N }, (_, i) => i + 1);
  const months = [];
  const end = addDays(s, total);
  for (let m = new Date(s.getFullYear(), s.getMonth() + 1, 1); m < end; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
    months.push({ key: m.getTime(), left: (diffDays(s, m) / total) * 100, label: MON[m.getMonth()] + ' 1' });
  }
  const cols = weeks.map(n => <span key={n} className={'col' + (n === w ? ' is-now' : '') + (n === cal.lightWeek ? ' is-light' : '')} />);
  return (
    <section className="ruler" aria-label="Due dates across the term">
      <div className="r-line r-head"><span />
        <div className="r-track">{weeks.map(n => <span key={n} className={'col' + (n === w ? ' is-now' : '')}>{n}</span>)}</div>
      </div>
      <div className="r-body">
        {data.courses.map(c => (
          <div className="r-line" key={c.id} style={{ '--c': colorOf(c) }}>
            <button className="r-lab" onClick={() => go({ view: 'course', id: c.id })}><span className="sw rl-sw" />{c.number}</button>
            <div className="r-track">
              {cols}
              {tp >= 0 && tp <= 100 && <span className="today" style={{ left: tp.toFixed(2) + '%' }} />}
              {idx.asgOf(c.id).filter(a => parseISO(a.due)).map(a => {
                const p = Math.max(0.6, Math.min(99.4, pos(parseISO(a.due))));
                const label = c.code + ' · ' + a.title + ' · ' + fmt(a.due) + ' · ' + a.status;
                return (
                  <button key={a.id} className="mark" style={{ left: p.toFixed(2) + '%' }} title={label} aria-label={label}
                    onClick={e => openDrawer({ type: 'asg', id: a.id }, e.currentTarget)}>
                    <Glyph shape="tri" fill={asgFill(a)} />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="r-line r-foot"><span />
        <div className="r-track">{months.map(m => <span key={m.key} className="month" style={{ left: m.left.toFixed(2) + '%' }}>{m.label}</span>)}</div>
      </div>
      <div className="r-key">
        <span><Glyph shape="tri" fill={0} /> Assignment due, filled once submitted</span>
        <span><i className="key-sw key-now" /> This week</span>
        <span><i className="key-today" /> Today</span>
        <span><i className="key-sw key-light" /> Week {cal.lightWeek}, {cal.lightLabel || 'light week'}</span>
      </div>
    </section>
  );
}

function Plate({ c }) {
  const { data, cal, idx, go } = useAula();
  const w = cal.nowWeek();
  const mods = idx.modulesOf(c.id);
  const cur = mods.find(m => w >= m.weekStart && w <= m.weekEnd);
  const nxt = cur ? null : mods.find(m => m.weekStart > w);
  const next = idx.asgOf(c.id).filter(a => a.due && !DONE.has(a.status)).sort(byDue)[0];
  const docs = idx.docsOf(c.id);
  const reading = docs.filter(d => d.status === 'Reading').length;
  const arts = docs.filter(d => LINKED.has(d.kind)).length;
  const reads = docs.length - arts;
  const p = progress(c, data.assignments);
  const dt = next && dueText(next, cal);
  return (
    <button className="plate" style={{ '--c': colorOf(c) }} onClick={() => go({ view: 'course', id: c.id })}>
      <span className="plate-top"><span className="plate-num">{c.number}</span><span className="plate-code">{c.code}<br />{c.hours} h/week</span></span>
      <span><span className="plate-title">{c.title}</span><span className="plate-tag">{c.tagline}</span></span>
      <span className="kvs">
        <span className="kv"><span className="k">Now</span><span className="v">
          {cur ? wkLabel(cur.weekStart, cur.weekEnd) + ' · ' + cur.title : nxt ? 'No module this week · next ' + nxt.title + ', wk ' + nxt.weekStart : 'No module scheduled'}
        </span></span>
        <span className="kv"><span className="k">Next due</span><span className="v">
          {next ? <>{next.title}<br /><span className="mono muted">{dt.date} · {dt.late ? <span className="late">{dt.rel}</span> : dt.rel}</span></> : 'Nothing left to submit'}
        </span></span>
        <span className="kv"><span className="k">Shelf</span><span className="v">
          {docs.length ? `${reads} ${reads === 1 ? 'document' : 'documents'} · ${arts} ${arts === 1 ? 'artifact or repo' : 'artifacts or repos'}${reading ? ' · ' + reading + ' reading' : ''}` : 'Nothing filed yet'}
        </span></span>
      </span>
      <span className="plate-foot"><span className="meter"><span style={{ width: (p.pct * 100).toFixed(1) + '%' }} /></span><span className="muted">{p.label}</span></span>
    </button>
  );
}

function ThisWeek() {
  const { data, cal, idx, openDrawer } = useAula();
  const t = today(), w = cal.nowWeek();
  const open = data.assignments.filter(a => parseISO(a.due) && !DONE.has(a.status));
  const late = open.filter(a => parseISO(a.due) < t).sort(byDue);
  const soon = open.filter(a => { const n = diffDays(t, parseISO(a.due)); return n >= 0 && n <= 7; }).sort(byDue);
  const later = open.filter(a => diffDays(t, parseISO(a.due)) > 7).sort(byDue)[0];
  const reading = data.documents.filter(d => d.status === 'Reading').sort(byCode);
  const starting = data.documents.filter(d => d.weekStart === w && d.status === 'Queued').sort(byCode);
  const tallies = data.assignments.filter(a => a.cadence === 'weekly');
  const docMeta = d => (d.pagesTotal ? 'p. ' + (d.pagesRead || 0) + ' of ' + d.pagesTotal : (d.role || '') + ' · ' + wkLabel(d.weekStart, d.weekEnd));
  const laterCourse = later && idx.course(later.courseId);
  return (
    <aside className="week" aria-label="This week">
      <h2 className="week-h">This week</h2>
      {late.length > 0 && <section className="wk-sec"><h3 className="label">Late</h3>{late.map(a => <MiniAsg key={a.id} a={a} />)}</section>}
      <section className="wk-sec"><h3 className="label">Due in the next 7 days</h3>
        {soon.length ? soon.map(a => <MiniAsg key={a.id} a={a} />) :
          <p className="empty-note">Nothing due in the next 7 days.{later ? ` Next: ${later.title} (${laterCourse ? laterCourse.code : ''}), ${fmt(later.due)}.` : ''}</p>}
      </section>
      <section className="wk-sec"><h3 className="label">Reading now</h3>
        {reading.length ? reading.map(d => <MiniDoc key={d.id} d={d} meta={docMeta(d)} />) :
          <p className="empty-note">Nothing open. Log a reading session on any document to track it here.</p>}
      </section>
      {starting.length > 0 && <section className="wk-sec"><h3 className="label">Starts this week</h3>
        {starting.map(d => <MiniDoc key={d.id} d={d} meta={(d.role || '') + ' · ' + wkLabel(d.weekStart, d.weekEnd)} />)}</section>}
      {tallies.length > 0 && <section className="wk-sec"><h3 className="label">Weekly</h3>
        {tallies.map(a => {
          const c = idx.course(a.courseId), log = a.log || [];
          const done = log.some(e => cal.weekOf(parseISO(e.date) || t) === w);
          return (
            <button key={a.id} className="mini" style={{ '--c': colorOf(c) }} onClick={e => openDrawer({ type: 'asg', id: a.id }, e.currentTarget)}>
              <span className="sw" /><Glyph shape="tri" fill={done ? 2 : 0} />
              <span><span className="mini-t">{a.title}</span><span className="mini-m">{log.length} of {a.target || cal.weeks} logged · this week {done ? 'done' : 'not yet'}</span></span>
            </button>
          );
        })}</section>}
    </aside>
  );
}
