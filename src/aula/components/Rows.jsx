import { useAula } from '../context.js';
import { colorOf, docFill, docShape, asgFill, dueText, weightText, safeUrl } from '../lib/model.js';
import { wkLabel } from '../lib/dates.js';

export function Glyph({ shape = 'sq', fill = 0 }) {
  const stroke = { stroke: 'currentColor', strokeWidth: 1.25, fill: 'none' };
  let out, half, full;
  if (shape === 'tri') {
    out = <path d="M6 1.4L10.9 10.6H1.1Z" {...stroke} />;
    half = <path d="M3.55 6H8.45L10.9 10.6H1.1Z" fill="currentColor" />;
    full = <path d="M6 1.4L10.9 10.6H1.1Z" fill="currentColor" />;
  } else if (shape === 'circ') {
    out = <circle cx="6" cy="6" r="4.9" {...stroke} />;
    half = <path d="M1.1 6A4.9 4.9 0 0 0 10.9 6Z" fill="currentColor" />;
    full = <circle cx="6" cy="6" r="4.9" fill="currentColor" />;
  } else {
    out = <rect x="1.1" y="1.1" width="9.8" height="9.8" {...stroke} />;
    half = <rect x="1.1" y="6" width="9.8" height="4.9" fill="currentColor" />;
    full = <rect x="1.1" y="1.1" width="9.8" height="9.8" fill="currentColor" />;
  }
  return (
    <svg className="g" viewBox="0 0 12 12" aria-hidden="true">
      {out}
      {fill === 1 && half}
      {fill === 2 && full}
      {fill === 3 && <circle cx="6" cy="6" r="1.7" fill="currentColor" />}
    </svg>
  );
}

export function Rel({ dt }) {
  if (!dt.rel) return null;
  return dt.late ? <span className="late">{dt.rel}</span> : <span className="muted">{dt.rel}</span>;
}

export function AsgRow({ a, course }) {
  const { cal, openDrawer } = useAula();
  const dt = dueText(a, cal);
  return (
    <button className="row" onClick={e => openDrawer({ type: 'asg', id: a.id }, e.currentTarget)}>
      <Glyph shape="tri" fill={asgFill(a)} />
      <span className="row-main">
        <span className="row-title">{a.title}</span>
        <span className="row-sub">{a.status}<span className="narrow-only mono">{dt.date}</span></span>
      </span>
      <span className="row-code">{weightText(a, course)}</span>
      <span className="row-end"><span className="mono">{dt.date}</span><Rel dt={dt} /></span>
    </button>
  );
}

function DocEnd({ d }) {
  if (d.kind === 'Repo' || d.kind === 'Artifact' || d.status === 'Reference') return <span className="muted">{d.status}</span>;
  if (d.pagesTotal) {
    const pct = Math.min(100, Math.round(((+d.pagesRead || 0) / d.pagesTotal) * 100));
    return <><span className="mini-meter"><span style={{ width: pct + '%' }} /></span><span className="mono">{d.pagesRead || 0}/{d.pagesTotal}</span></>;
  }
  return <span className="muted">{d.status}</span>;
}

export function DocRow({ d, lib }) {
  const { idx, openDrawer } = useAula();
  const c = idx.course(d.courseId);
  const sub = [d.author, d.role && d.role !== 'Required' ? d.role : '', wkLabel(d.weekStart, d.weekEnd)].filter(Boolean).join(' · ');
  return (
    <button className={'row' + (lib ? ' lib' : '')} onClick={e => openDrawer({ type: 'doc', id: d.id }, e.currentTarget)}>
      <Glyph shape={docShape(d)} fill={docFill(d)} />
      <span className="row-main">
        <span className="row-title">{d.title}</span>
        <span className="row-sub">
          <span>{sub}</span>
          {d.assetId && <span className="tagword">File</span>}
          {safeUrl(d.url) && <span className="tagword">Link</span>}
          <span className="narrow-only mono">{d.code}</span>
        </span>
      </span>
      {lib && <span className="row-course wide" style={{ '--c': colorOf(c) }}><span className="sw" />{c ? c.number : '—'}</span>}
      <span className="row-code">{d.code}</span>
      <span className="row-end"><DocEnd d={d} /></span>
    </button>
  );
}

export function MiniAsg({ a }) {
  const { idx, cal, openDrawer } = useAula();
  const c = idx.course(a.courseId);
  const dt = dueText(a, cal);
  return (
    <button className="mini" style={{ '--c': colorOf(c) }} onClick={e => openDrawer({ type: 'asg', id: a.id }, e.currentTarget)}>
      <span className="sw" /><Glyph shape="tri" fill={asgFill(a)} />
      <span>
        <span className="mini-t">{a.title}</span>
        <span className="mini-m">{c ? c.number : ''} · {dt.date} · {dt.late ? <span className="late">{dt.rel}</span> : dt.rel}</span>
      </span>
    </button>
  );
}

export function MiniDoc({ d, meta }) {
  const { idx, openDrawer } = useAula();
  const c = idx.course(d.courseId);
  return (
    <button className="mini" style={{ '--c': colorOf(c) }} onClick={e => openDrawer({ type: 'doc', id: d.id }, e.currentTarget)}>
      <span className="sw" /><Glyph shape={docShape(d)} fill={docFill(d)} />
      <span><span className="mini-t">{d.title}</span><span className="mini-m">{d.code} · {meta}</span></span>
    </button>
  );
}
