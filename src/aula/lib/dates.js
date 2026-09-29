export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function parseISO(s) {
  const m = typeof s === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
export function today() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
export function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
export function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
export function diffDays(a, b) { return Math.round((b - a) / 864e5); }
export function fmt(d, day = true) {
  if (typeof d === 'string') d = parseISO(d);
  if (!d) return '';
  return (day ? WD[d.getDay()] + ' ' : '') + MON[d.getMonth()] + ' ' + d.getDate();
}
export const wkLabel = (a, b) => (a == null ? '' : b != null && b !== a ? 'Wk ' + a + '–' + b : 'Wk ' + a);

export const DEFAULT_TERM = { name: 'Fall 2026', start: '2026-09-28', end: '2026-12-18', weeks: 12, lightWeek: 9, lightLabel: 'Thanksgiving' };

// Everything that depends on the term's start date, in one object.
export function makeCalendar(term) {
  const t = term || DEFAULT_TERM;
  const start = parseISO(t.start) || parseISO(DEFAULT_TERM.start);
  const weeks = +t.weeks || 12;
  const weekOf = d => Math.floor(diffDays(start, d) / 7) + 1;
  return {
    ...t,
    startDate: start,
    weeks,
    lightWeek: +t.lightWeek,
    weekOf,
    nowWeek: () => weekOf(today()),
    weekSpan: w => { const s = addDays(start, (w - 1) * 7); return [s, addDays(s, 6)]; },
  };
}
