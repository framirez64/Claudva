import { parseISO, today, diffDays, fmt } from './dates.js';

export const COLORS = ['caracol', 'sky', 'brick', 'ochre'];
export const KINDS = [['Book', 'B'], ['Paper', 'P'], ['Article', 'A'], ['Notes', 'N'], ['Dataset', 'D'], ['Video', 'V'], ['Repo', 'R'], ['Artifact', 'C']];
export const KIND_NAMES = KINDS.map(k => k[0]);
export const KIND_LETTER = Object.fromEntries(KINDS);
export const LINKED = new Set(['Repo', 'Artifact']);
export const DOC_STATUS = ['Queued', 'Reading', 'Done', 'Reference'];
export const ROLES = ['Required', 'Optional', 'Reference'];
export const A_STATUS = ['Not started', 'In progress', 'Submitted', 'Assessed'];
export const DONE = new Set(['Submitted', 'Assessed']);

export const safeUrl = u => (typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : '');
export const colorOf = c => (c && COLORS.includes(c.color) ? 'var(--' + c.color + ')' : 'var(--muted)');
export const byDue = (a, b) => { const x = a.due || '9999', y = b.due || '9999'; return x < y ? -1 : x > y ? 1 : 0; };
export const byCode = (a, b) => String(a.code || '').localeCompare(String(b.code || ''));
export const stamp = () => new Date().toISOString();
export const fmtSize = b => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

export const asgFill = a => (DONE.has(a.status) ? 2 : a.status === 'In progress' ? 1 : 0);
export const docFill = d => (d.status === 'Done' ? 2 : d.status === 'Reading' ? 1 : d.status === 'Reference' ? 3 : 0);
export const docShape = d => (LINKED.has(d.kind) ? 'circ' : 'sq');

// Lookups over the loaded collections.
export function makeIndex(data) {
  const course = id => data.courses.find(c => c.id === id) || null;
  return {
    course,
    moduleOf: id => data.modules.find(m => m.id === id) || null,
    modulesOf: cid => data.modules.filter(m => m.courseId === cid).sort((a, b) => (a.weekStart || 0) - (b.weekStart || 0)),
    asgOf: cid => data.assignments.filter(a => a.courseId === cid),
    docsOf: cid => data.documents.filter(d => d.courseId === cid || (Array.isArray(d.alsoIn) && d.alsoIn.includes(cid))),
  };
}

export function progress(course, assignments) {
  const as = assignments.filter(a => a.courseId === course.id && a.cadence !== 'weekly');
  if (course.grading === 'completion') {
    const n = as.filter(a => DONE.has(a.status)).length;
    return { pct: as.length ? n / as.length : 0, label: n + ' of ' + as.length + ' complete' };
  }
  let tot = 0, sub = 0, aw = 0, sc = 0;
  for (const a of as) {
    const w = +a.weight || 0;
    tot += w;
    if (DONE.has(a.status)) sub += w;
    if (a.status === 'Assessed' && a.score !== null && a.score !== undefined && a.score !== '' && w) { aw += w; sc += w * +a.score; }
  }
  const pct = tot ? sub / tot : 0;
  let label = Math.round(pct * 100) + '% of the grade submitted';
  if (aw) label += ' · self-score ' + Math.round(sc / aw) + ' on ' + Math.round((aw / tot) * 100) + '% assessed';
  return { pct, label };
}

export function dueText(a, cal) {
  if (a.cadence === 'weekly') {
    const n = (a.log || []).length;
    return { date: 'Weekly', rel: n + ' of ' + (a.target || cal.weeks) + ' logged', late: false };
  }
  if (!a.due) return { date: 'No date', rel: '', late: false };
  if (DONE.has(a.status)) return { date: fmt(a.due), rel: a.status.toLowerCase(), late: false };
  const n = diffDays(today(), parseISO(a.due));
  const rel = n < 0 ? -n + (n === -1 ? ' day late' : ' days late') : n === 0 ? 'due today' : n === 1 ? 'due tomorrow' : 'in ' + n + ' days';
  return { date: fmt(a.due), rel, late: n < 0 };
}

export function weightText(a, course) {
  if (a.cadence === 'weekly') return 'Tally';
  if (course && course.grading === 'completion') return 'Complete';
  const w = +a.weight || 0;
  return w ? w + '%' : 'Ungraded';
}

export function nextCode(courses, documents, courseId, kind) {
  const c = courses.find(x => x.id === courseId);
  const pre = (c ? c.number : 'GEN') + '-' + (KIND_LETTER[kind] || 'N') + '-';
  let max = 0;
  for (const d of documents) {
    if (typeof d.code === 'string' && d.code.startsWith(pre)) {
      const n = parseInt(d.code.slice(pre.length), 10);
      if (n > max) max = n;
    }
  }
  return pre + String(max + 1).padStart(3, '0');
}

export const titleFromFile = name => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
