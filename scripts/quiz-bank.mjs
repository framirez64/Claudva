// Builds study quizzes from a PDF of textbook chapters, and grades your answers.
// Runs on your machine only: the API key can't live in the browser, and the book never enters the repo.
//
//   npm run quiz -- make <chapters.pdf> --chapters 1-3 [--pass concepts|visuals] [--out dir] [--book "..."] [--parallel 3] [--yes]
//   npm run quiz -- grade [dir] [--yes]    mark answers.md against the key, write graded.md
//   npm run quiz -- render [dir] [--pdf chapters.pdf]   rebuild the quiz and key from bank.json, no API call
//   npm run quiz -- balance [dir] [--yes]  rewrite multiple-choice options whose correct answer is clearly the longest
//
// Output per module: quiz.pdf and key.pdf to print (figures cut from your PDF, code, ruled answer space;
// long answers go on a separate sheet), the same as Markdown, and answers.md for typing answers instead.
//
// make runs two passes per chapter, all sharing one cached copy of the PDF:
//   concepts  maps the chapter's concepts, then writes multiple-choice and explanatory questions until every one is covered
//   visuals   lists every numbered figure and every code block, then writes at least one question about each
// Running make again with --chapters 2 (and optionally --pass) replaces just that part of the bank.
//
// Needs ANTHROPIC_API_KEY (or CLAUDE_KEY) in the environment, or in .env or .env.local (both gitignored).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
const EFFORT = 'high'; // identical on every request, or the cached PDF is missed
const PRICE = { input: 4, cacheWrite: 8, cacheRead: 0.2, output: 20 }; // USD per million tokens, Claude Opus 5.5, 1-hour cache
const MAX_REQUEST_BYTES = 32 * 1024 * 1024; // API request limit; base64 adds a third to the PDF's size
const DEFAULTS = { book: 'Hands-On Large Language Models, by Jay Alammar and Maarten Grootendorst', out: 'private/quizzes/ai-430-m1', parallel: 3 };

const SECTIONS = [
  { id: 'multiple_choice', title: 'Part 1 · Multiple choice' },
  { id: 'explanatory', title: 'Part 2 · Explanatory' },
  { id: 'code_and_diagrams', title: 'Part 3 · Code and diagrams' },
];
const PASSES = {
  concepts: { label: 'concepts', sections: ['multiple_choice', 'explanatory'], estOutput: 25000 },
  visuals: { label: 'figures and code', sections: ['code_and_diagrams'], estOutput: 40000 },
};
const KINDS = {
  single_answer: 'Multiple choice', explain: 'Explain', why: 'Why', what_if: 'What if', compare: 'Compare',
  predict_output: 'Predict the output', explain_code: 'Explain the code', find_bug: 'Find the bug', modify_code: 'Modify the code', explain_figure: 'Walk through the figure',
};
const LETTERS = ['A', 'B', 'C', 'D'];

/* ---------- arguments ---------- */
function parseArgs(argv) {
  const o = { ...DEFAULTS, yes: false, chapters: null, pass: null, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') o.yes = true;
    else if (['--out', '--book', '--chapters', '--pass', '--pdf'].includes(a)) o[a.slice(2)] = argv[++i];
    else if (a === '--parallel') o.parallel = Math.max(1, Number(argv[++i]) || 1);
    else if (a.startsWith('--')) throw new Error('Unknown option ' + a);
    else o.positional.push(a);
  }
  if (o.pass && !PASSES[o.pass]) throw new Error('--pass is concepts or visuals');
  [o.command, o.target] = o.positional;
  return o;
}

function parseChapters(spec) {
  const out = [];
  for (const part of String(spec || '').split(',').filter(Boolean)) {
    const [a, b] = part.split('-').map(Number);
    if (!Number.isInteger(a) || (b !== undefined && !Number.isInteger(b))) throw new Error('--chapters takes a list like 1-3 or 4,6');
    for (let n = a; n <= (b ?? a); n++) out.push(n);
  }
  if (!out.length) throw new Error('Say which chapters the PDF holds, for example --chapters 1-3');
  return out;
}

/* ---------- schemas ---------- */
// One schema for both passes, so every request shares the same cached prefix.
const strictObject = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const str = description => (description ? { type: 'string', description } : { type: 'string' });
const RUBRIC = { type: 'array', items: strictObject({ criterion: str(), points: { type: 'integer' } }) };

const CHAPTER_SCHEMA = strictObject({
  chapter: strictObject({ number: { type: 'integer' }, title: str(), pages: str() }),
  concepts: {
    type: 'array', description: 'Concepts pass only; empty in the figures and code pass.',
    items: strictObject({
      id: str('The chapter number, a dot, and a sequence number: "2.1", "2.2", ...'),
      name: str(), summary: str('One sentence on what a reader should take away.'),
      weight: { type: 'string', enum: ['core', 'supporting'] }, pages: str(),
    }),
  },
  figures: {
    type: 'array', description: 'Figures and code pass only: every numbered figure in the chapter, in order. Empty in the concepts pass.',
    items: strictObject({ id: str('The figure number printed in its caption, such as "2-5".'), pages: str(), caption: str('A short paraphrase of what the figure shows.') }),
  },
  listings: {
    type: 'array', description: 'Figures and code pass only: every code block in the chapter, in order. Empty in the concepts pass.',
    items: strictObject({ id: str('The chapter number, ".L", and a sequence number: "2.L1", "2.L2", ...'), pages: str(), summary: str('What the code does, in one sentence.') }),
  },
  questions: {
    type: 'array',
    items: strictObject({
      section: { type: 'string', enum: SECTIONS.map(s => s.id) },
      kind: { type: 'string', enum: Object.keys(KINDS) },
      concepts: { type: 'array', items: str(), description: 'Concepts pass: ids of the concepts this question tests. Empty otherwise.' },
      targets: { type: 'array', items: str(), description: 'Figures and code pass: ids of the figures and code blocks this question covers. Empty otherwise.' },
      level: { type: 'string', enum: ['recall', 'understand', 'apply', 'analyze'] },
      pages: str('Page numbers printed on the book pages, such as "34" or "34-36".'),
      prompt: str(),
      code: str('For code questions, the snippet the question is about, trimmed to the lines needed. Empty otherwise.'),
      figure: str('For figure questions, the figure number and printed page, such as "Figure 2-5, p. 41". Empty otherwise.'),
      choices: { type: 'array', items: str(), description: 'multiple_choice: four options, without letters. Empty otherwise.' },
      answer: str('multiple_choice: the correct letter, A to D. Otherwise a model answer.'),
      explanation: str('Why the answer is right; for multiple_choice, also why each tempting wrong option is wrong.'),
      rubric: { ...RUBRIC, description: 'explanatory and code_and_diagrams: three to five criteria totalling 10 points. Empty for multiple_choice.' },
    }),
  },
});

const GRADE_SCHEMA = strictObject({
  grades: {
    type: 'array',
    items: strictObject({
      number: { type: 'integer' },
      awarded: { type: 'array', items: { type: 'integer' }, description: 'Points awarded for each rubric criterion, in the rubric order.' },
      feedback: str(),
    }),
  },
});

/* ---------- prompts ---------- */
const MAKE_SYSTEM = `You write study material for a graduate student working through a technical textbook on their own, who wants to understand every chapter fully, including every figure and every piece of code. Good questions test whether the student understood the material and can use it, not whether they memorized wording. Every question must be answerable from the attached pages and make sense without the book open, except figure questions, which name the figure to look at.`;

function makeInstructions(o, chapters) {
  return `The attached PDF holds chapters ${chapters.join(', ')} of ${o.book}. Each request asks for one chapter and one of two passes.

Concepts pass: map the chapter, then write its multiple_choice and explanatory questions.
1. List the chapter's concepts in the order it teaches them: every idea, technique, term, result, or design choice a reader should take away, granular enough that mastering all of them means mastering the chapter. Mark each one core (central to the chapter, or needed later in the book) or supporting.
2. Write questions until every concept is covered:
- multiple_choice: at least one question per concept, and two or more for each core concept, testing different aspects. Four options, exactly one correct, with wrong options drawn from realistic misconceptions. Vary the position of the correct answer. Write all four options at about the same length and level of detail, so the correct one can't be spotted by being the longest or the most qualified: keep it plain, and give wrong options the same specificity.
- explanatory: at least one per core concept, mixing explain (in your own words), why, what_if (what changes if an assumption or setting changes), and compare.
Leave figures and listings empty.

Figures and code pass: list the chapter's figures and code, then question every one of them.
1. Go through the chapter page by page. List every numbered figure by the number printed in its caption, and every code block, including short ones; setup blocks that only install packages or import modules may be listed together as one block. Miss none.
2. Write code_and_diagrams questions so that every figure and every code block is covered by at least one, naming what each question covers in targets. For code, ask the student to predict its output or tensor shapes, explain what it does and why, find a bug you plant in it, or modify it to do something new, and put the snippet in code, trimmed to the lines needed. For a figure, ask the student to walk through it (explain_figure), or, when it extends an earlier figure, what changed and why (compare), or what would change under a different setting (what_if), and name the figure and its printed page in figure. One question may cover a figure together with the code that produces it.
Leave concepts empty.

In both passes there is no length limit: write as many questions as full coverage needs, and no near-duplicates. Every explanatory and code_and_diagrams question gets a model answer and a rubric of three to five criteria totalling 10 points. Mix levels from recall to analyze, mostly understand and apply. Cite the page numbers printed on the book pages, not the PDF's own page count. Paraphrase the book's prose rather than quoting more than a short phrase.`;
}

const GRADE_SYSTEM = `You grade a student's written answers to study questions about a technical textbook, using each question's model answer and rubric. Award a criterion's points only for what the answer actually shows, give partial points where the answer earns some, and don't reward length. Accept correct answers that differ from the model answer. Feedback speaks to the student directly in two to four sentences: what they got right, what is missing or wrong, and what to reread.`;

/* ---------- helpers ---------- */
function loadKey() {
  for (const f of ['.env.local', '.env']) { try { process.loadEnvFile(f); } catch { /* the key can also come from the environment */ } }
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_KEY;
  if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY (or CLAUDE_KEY), or put it in .env at the repo root.');
  return new Anthropic({ apiKey, maxRetries: 4 });
}

async function confirm(o, question) {
  if (o.yes) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ok = /^y/i.test(await rl.question(question + ' [y/N] '));
  rl.close();
  return ok;
}

const dollars = n => '$' + n.toFixed(2);
const costOf = u => ((u.input_tokens || 0) * PRICE.input + (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite
  + (u.cache_read_input_tokens || 0) * PRICE.cacheRead + (u.output_tokens || 0) * PRICE.output) / 1e6;
const addUsage = (sum, u) => { for (const k of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) sum[k] = (sum[k] || 0) + (u[k] || 0); return sum; };

function readJsonReply(message, what) {
  if (message.stop_reason === 'refusal') throw new Error(`${what} was declined: ${JSON.stringify(message.stop_details)}`);
  if (message.stop_reason === 'max_tokens') throw new Error(`${what} was cut off at max_tokens.`);
  return JSON.parse(message.content.filter(b => b.type === 'text').map(b => b.text).join(''));
}

const bankPath = dir => path.join(dir, 'bank.json');
function loadBank(dir) {
  if (!fs.existsSync(bankPath(dir))) throw new Error('No bank.json in ' + dir + '. Run make first.');
  return JSON.parse(fs.readFileSync(bankPath(dir), 'utf8'));
}

// The order questions appear in, which numbers them: by part, then chapter, then as written.
function layout(bank) {
  const out = [];
  for (const s of SECTIONS) for (const ch of bank.chapters) for (const q of ch.questions) if (q.section === s.id) out.push({ ...q, chapter: ch.chapter.number });
  return out.map((q, i) => ({ ...q, number: i + 1 }));
}

const figureId = id => String(id).replace(/^fig(ure)?\.?\s*/i, '');
function itemIndex(bank) {
  const map = new Map();
  for (const ch of bank.chapters) {
    for (const c of ch.concepts) map.set(c.id, { kind: 'concept', id: c.id, label: `${c.id} ${c.name}`, weight: c.weight, pages: c.pages, chapter: ch.chapter.number });
    for (const f of ch.figures) map.set(figureId(f.id), { kind: 'figure', id: figureId(f.id), label: `Figure ${figureId(f.id)}: ${f.caption}`, pages: f.pages, chapter: ch.chapter.number });
    for (const l of ch.listings) map.set(l.id, { kind: 'code', id: l.id, label: `Code ${l.id}: ${l.summary}`, pages: l.pages, chapter: ch.chapter.number });
  }
  return map;
}
const covers = q => [...q.concepts, ...q.targets.map(figureId)];

const chapterRange = bank => {
  const ns = bank.chapters.map(c => c.chapter.number);
  return ns.length === 1 ? `Ch. ${ns[0]}` : `Ch. ${ns[0]}–${ns[ns.length - 1]}`;
};
const heading = bank => `${String(bank.book || '').split(',')[0]} · ${chapterRange(bank)}`;
const points = q => q.rubric.reduce((s, r) => s + r.points, 0);

/* ---------- checks ---------- */
// A multiple-choice question gives itself away when its correct option is clearly the longest.
const LENGTH_TELL = 1.15;
function givesAway(q) {
  const lens = q.choices.map(c => c.length), i = LETTERS.indexOf(q.answer);
  return i >= 0 && lens[i] >= LENGTH_TELL * Math.max(...lens.filter((_, j) => j !== i));
}

function checkBank(bank) {
  const problems = [];
  const mc = bank.chapters.flatMap(c => c.questions).filter(q => q.section === 'multiple_choice' && q.choices.length === 4);
  const tells = mc.filter(givesAway).length;
  if (mc.length && tells / mc.length > 0.3) problems.push(`in ${tells} of ${mc.length} multiple-choice questions the correct option is clearly the longest; run balance to even them out`);
  for (const ch of bank.chapters) {
    const n = ch.chapter.number, passes = ch.passes || {};
    const tested = section => new Set(ch.questions.filter(q => q.section === section).flatMap(q => q.concepts));
    if (passes.concepts) {
      const mc = tested('multiple_choice'), ex = tested('explanatory');
      for (const c of ch.concepts) {
        if (!mc.has(c.id)) problems.push(`Ch. ${n}: concept ${c.id} "${c.name}" has no multiple-choice question`);
        if (c.weight === 'core' && !ex.has(c.id)) problems.push(`Ch. ${n}: core concept ${c.id} "${c.name}" has no explanatory question`);
      }
    } else problems.push(`Ch. ${n}: the concepts pass hasn't run`);
    if (passes.visuals) {
      const covered = new Set(ch.questions.filter(q => q.section === 'code_and_diagrams').flatMap(q => q.targets.map(figureId)));
      for (const f of ch.figures) if (!covered.has(figureId(f.id))) problems.push(`Ch. ${n}: Figure ${figureId(f.id)} (p. ${f.pages}) has no question`);
      for (const l of ch.listings) if (!covered.has(l.id)) problems.push(`Ch. ${n}: code block ${l.id} (p. ${l.pages}) has no question`);
      // Figures are numbered in sequence, so a gap means the inventory probably missed one.
      const nums = ch.figures.map(f => { const m = /^(\d+)-(\d+)$/.exec(figureId(f.id)); return m && Number(m[1]) === n ? Number(m[2]) : null; });
      if (nums.includes(null)) problems.push(`Ch. ${n}: some figure ids aren't numbered ${n}-1, ${n}-2, ...`);
      const have = new Set(nums), missing = [];
      for (let i = 1; i <= Math.max(0, ...nums.filter(Boolean)); i++) if (!have.has(i)) missing.push(`${n}-${i}`);
      if (missing.length) problems.push(`Ch. ${n}: the figure list skips ${missing.join(', ')}; check the book and run --pass visuals again if they exist`);
    } else problems.push(`Ch. ${n}: the figures and code pass hasn't run`);
    const known = new Set([...ch.concepts.map(c => c.id), ...ch.figures.map(f => figureId(f.id)), ...ch.listings.map(l => l.id)]);
    ch.questions.forEach((q, i) => {
      const where = `Ch. ${n}, question ${i + 1}`;
      for (const id of covers(q)) if (!known.has(id)) problems.push(`${where}: unknown concept, figure or code block ${id}`);
      if (q.section === 'multiple_choice' && (q.choices.length !== 4 || !LETTERS.includes(q.answer))) problems.push(`${where}: multiple choice needs four options and an answer A-D`);
      if (q.section !== 'multiple_choice' && points(q) !== 10) problems.push(`${where}: rubric totals ${points(q)} points, not 10`);
    });
  }
  return problems;
}

/* ---------- Markdown ---------- */
const fence = code => ['```python', code.replace(/\s+$/, ''), '```'];
const cell = s => String(s).replace(/\|/g, '\\|').replace(/\n+/g, ' ');

// Figures a question shows: the ones it covers, plus any named in its figure field.
const figuresOf = q => [...new Set([...q.targets.map(figureId), ...[...String(q.figure).matchAll(/(\d+)[-.](\d+)/g)].map(m => `${m[1]}-${m[2]}`)])];

function renderQuiz(bank, figs = new Map()) {
  const qs = layout(bank), titles = new Map(bank.chapters.map(c => [c.chapter.number, c.chapter.title]));
  const lines = [`# ${heading(bank)} · Quiz`, '',
    `${qs.length} questions in three parts. Write your answers under the matching numbers in answers.md, then run \`npm run quiz -- grade\` with this folder. The key is in key.md.`, ''];
  for (const s of SECTIONS) {
    const part = qs.filter(q => q.section === s.id);
    if (!part.length) continue;
    lines.push(`## ${s.title}`, '');
    let last = null;
    for (const q of part) {
      if (q.chapter !== last) { lines.push(`### Chapter ${q.chapter}: ${titles.get(q.chapter)}`, ''); last = q.chapter; }
      const meta = [KINDS[q.kind], q.level, q.section === 'multiple_choice' ? '' : `${points(q)} points`].filter(Boolean).join(' · ');
      lines.push(`**${q.number}.** ${q.prompt}  `, `*${meta}*`, '');
      const shown = figuresOf(q).filter(id => figs.has(id));
      for (const id of shown) lines.push(...figs.get(id).map(src => `![Figure ${id}](${src})`), '');
      if (q.figure && !shown.length) lines.push(`*Look at ${q.figure}.*`, '');
      if (q.code) lines.push(...fence(q.code), '');
      if (q.section === 'multiple_choice') { q.choices.forEach((c, i) => lines.push(`- ${LETTERS[i]}. ${c}`)); lines.push(''); }
    }
  }
  return lines.join('\n');
}

function renderAnswerSheet(bank) {
  const lines = [`# Answers · ${heading(bank)}`, '', 'Write each answer under its number. For multiple choice, just the letter. Leave a number empty to skip it.', ''];
  for (const q of layout(bank)) lines.push(`## ${q.number}`, '', '');
  return lines.join('\n');
}

function renderKey(bank) {
  const qs = layout(bank), items = itemIndex(bank);
  const lines = [`# Key · ${heading(bank)}`, ''];
  for (const s of SECTIONS) {
    const part = qs.filter(q => q.section === s.id);
    if (!part.length) continue;
    lines.push(`## ${s.title}`, '');
    for (const q of part) {
      const tests = covers(q).map(id => (items.get(id) || { label: id }).label).join('; ');
      lines.push(q.section === 'multiple_choice'
        ? `**${q.number}.** **${q.answer}.** ${q.choices[LETTERS.indexOf(q.answer)] || ''}  `
        : `**${q.number}.** ${q.answer}  `);
      lines.push(`${q.explanation} *(Ch. ${q.chapter}, p. ${q.pages} · ${tests})*`, '');
      if (q.rubric.length) lines.push('| Criterion | Points |', '|---|---|', ...q.rubric.map(r => `| ${cell(r.criterion)} | ${r.points} |`), '');
    }
  }
  return lines.join('\n');
}

/* ---------- figures cut from the source PDF ---------- */
// Finds each "Figure N-M" caption and saves the embedded images drawn between it and the caption above it.
// A figure drawn as vector graphics has no embedded image; the quiz then points to its page in the book.
async function extractFigures(pdfPath, dir) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { PNG } = (await import('pngjs')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.mjs', import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href;
  const OPS = pdfjs.OPS;
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const toPng = ({ width, height, kind, data }) => {
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (kind === 3) png.data.set(data.subarray(o, o + 4), o);
      else if (kind === 2) { const i = (y * width + x) * 3; png.data.set([data[i], data[i + 1], data[i + 2], 255], o); }
      else { const v = data[y * ((width + 7) >> 3) + (x >> 3)] & (128 >> (x & 7)) ? 255 : 0; png.data.set([v, v, v, 255], o); }
    }
    return PNG.sync.write(png);
  };

  const figDir = path.join(dir, 'figures');
  fs.rmSync(figDir, { recursive: true, force: true });
  fs.mkdirSync(figDir, { recursive: true });
  const found = new Map();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;

  // Lines that start "Figure N-M." are captions, or body text that happens to mention a figure at the start of a line.
  // Captions are set in their own font: the one most "Figure N-M. Some text" lines use.
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p), rows = new Map();
    for (const it of (await page.getTextContent()).items) if (it.str) { const y = Math.round(it.transform[5]); rows.set(y, [...(rows.get(y) || []), it]); }
    for (const [y, items] of rows) {
      items.sort((a, b) => a.transform[4] - b.transform[4]);
      const m = /^\s*Figure\s+(\d+)[-.](\d+)\.(\s+\S)?/.exec(items.map(i => i.str).join(''));
      if (m) lines.push({ p, y, id: `${m[1]}-${m[2]}`, font: items[0].fontName, text: !!m[3] });
    }
    page.cleanup();
  }
  const tally = {};
  for (const l of lines) if (l.text) tally[l.font] = (tally[l.font] || 0) + 1;
  const captionFont = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0];
  const captionLines = lines.filter(l => (captionFont ? l.font === captionFont : l.text));

  for (const p of [...new Set(captionLines.map(l => l.p))]) {
    const page = await doc.getPage(p);
    const captions = captionLines.filter(l => l.p === p).sort((a, b) => b.y - a.y);
    const ops = await page.getOperatorList();
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [], images = [];
    ops.fnArray.forEach((fn, i) => {
      const args = ops.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() || ctm;
      else if (fn === OPS.transform) ctm = mul(ctm, args);
      else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args[0]) ctm = mul(ctm, args[0]); }
      else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        const xs = [0, ctm[0], ctm[2], ctm[0] + ctm[2]], ys = [0, ctm[1], ctm[3], ctm[1] + ctm[3]];
        const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
        if (w >= 60 && h >= 30) images.push({ ref: args[0], top: ctm[5] + Math.max(...ys), bottom: ctm[5] + Math.min(...ys) }); // skips icons
      }
    });
    const resolve = ref => (typeof ref === 'string' ? new Promise(res => (ref.startsWith('g_') ? page.commonObjs : page.objs).get(ref, res)) : Promise.resolve(ref));
    for (const [k, c] of captions.entries()) {
      const ceiling = k === 0 ? Infinity : captions[k - 1].y;
      const mine = images.filter(m => m.bottom >= c.y - 2 && m.top <= ceiling + 2).sort((a, b) => b.top - a.top);
      const files = [];
      for (const [j, m] of mine.entries()) {
        const img = await resolve(m.ref);
        if (!img || !img.data) continue;
        const name = `${c.id}${mine.length > 1 ? '-' + (j + 1) : ''}.png`;
        fs.writeFileSync(path.join(figDir, name), toPng(img));
        files.push(`figures/${name}`);
      }
      if (files.length) found.set(c.id, files);
    }
    page.cleanup();
  }
  await doc.destroy();
  return found;
}

/* ---------- printable HTML and PDF ---------- */
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ON_PAGE_LINES = { why: 6, what_if: 6, predict_output: 4, find_bug: 5 }; // the other written kinds go on a separate sheet
const POIRET = new URL('../src/aula/fonts/Poiret_One/PoiretOne-Regular.ttf', import.meta.url).href;

function printPage(title, footer, body) {
  const css = `@font-face{font-family:"Poiret One";src:url("${POIRET}") format("truetype")}
@page{size:Letter;margin:0.7in 0.75in 0.8in;
  @bottom-left{content:${JSON.stringify(footer)};font:8pt "Segoe UI",Arial,sans-serif;color:#666}
  @bottom-right{content:"Page " counter(page) " of " counter(pages);font:8pt "Segoe UI",Arial,sans-serif;color:#666}}
*{box-sizing:border-box}
body{font:10.5pt/1.45 "Segoe UI",Inter,Arial,sans-serif;color:#111;margin:0}
h1{font:400 26pt/1.1 "Poiret One","Segoe UI",sans-serif;margin:0 0 4pt}
h2{font:400 18pt/1.2 "Poiret One","Segoe UI",sans-serif;border-bottom:2px solid #111;padding-bottom:4pt;margin:0 0 10pt}
h2.new{break-before:page}
h3{font:600 8.5pt "Segoe UI",Arial,sans-serif;text-transform:uppercase;letter-spacing:.08em;color:#444;margin:14pt 0 8pt}
p{margin:0}
.sub{color:#555;margin:0 0 14pt}
.fill{display:flex;gap:24pt;margin:0 0 12pt}.fill span{flex:1;border-bottom:1px solid #111;padding-bottom:2pt;color:#555;font-size:9pt}
.note{border:1px solid #111;padding:8pt 10pt;margin:0 0 18pt;font-size:9.5pt}
.q{break-inside:avoid;margin:0 0 16pt}
.n{font-weight:700}
.meta{font-size:8.5pt;color:#555;margin:2pt 0 5pt}
.choices{list-style:none;margin:4pt 0 0;padding:0}.choices li{display:flex;gap:7pt;margin:3pt 0}
.box{flex:none;width:9pt;height:9pt;border:1px solid #111;margin-top:3pt}
pre{font:8.8pt/1.4 Consolas,"IBM Plex Mono",monospace;border:1px solid #999;padding:6pt 8pt;margin:6pt 0;white-space:pre-wrap}
figure{margin:6pt 0}figure img{display:block;max-width:100%;max-height:3.4in;margin:0 0 3pt}figcaption,.lookup{font-size:8.5pt;color:#555}
.lookup{font-style:italic;margin:4pt 0}
.lines div{height:0.3in;border-bottom:1px solid #aaa}
.sheet{display:inline-block;border:1px solid #111;padding:2pt 6pt;font-size:8.5pt;margin-top:5pt}
.answer{white-space:pre-wrap;margin:2pt 0 4pt}
table{border-collapse:collapse;width:100%;font-size:9pt;margin:4pt 0}td{border-bottom:1px solid #ccc;padding:3pt 4pt;vertical-align:top}td:last-child{text-align:right;width:50pt}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head><body>${body}</body></html>`;
}

function quizHtml(bank, figs) {
  const qs = layout(bank), titles = new Map(bank.chapters.map(c => [c.chapter.number, c.chapter.title]));
  const out = [`<h1>${esc(heading(bank))}</h1>`, `<p class="sub">Quiz · ${qs.length} questions in three parts</p>`,
    '<div class="fill"><span>Name</span><span>Date</span><span>Score</span></div>',
    '<div class="note">Part 1: tick one box for each question. Parts 2 and 3: write on the lines. Questions marked <b>Separate sheet</b> need more room: answer them on your own paper and start each answer with its number, such as Q42.</div>'];
  SECTIONS.forEach((s, si) => {
    const part = qs.filter(q => q.section === s.id);
    if (!part.length) return;
    out.push(`<h2${si ? ' class="new"' : ''}>${esc(s.title)}</h2>`);
    let last = null;
    for (const q of part) {
      if (q.chapter !== last) { out.push(`<h3>Chapter ${q.chapter}: ${esc(titles.get(q.chapter))}</h3>`); last = q.chapter; }
      const written = q.section !== 'multiple_choice';
      out.push('<div class="q">', `<p><span class="n">Q${q.number}.</span> ${esc(q.prompt)}</p>`,
        `<p class="meta">${esc([KINDS[q.kind], q.level, written ? `${points(q)} points` : ''].filter(Boolean).join(' · '))}</p>`);
      const shown = figuresOf(q).filter(id => figs.has(id));
      for (const id of shown) out.push(`<figure>${figs.get(id).map(src => `<img src="${esc(src)}" alt="Figure ${esc(id)}">`).join('')}<figcaption>Figure ${esc(id)}</figcaption></figure>`);
      if (q.figure && !shown.length) out.push(`<p class="lookup">Look at ${esc(q.figure)} in the book.</p>`);
      if (q.code) out.push(`<pre>${esc(q.code.replace(/\s+$/, ''))}</pre>`);
      if (!written) out.push(`<ul class="choices">${q.choices.map((c, i) => `<li><span class="box"></span><span>${LETTERS[i]}. ${esc(c)}</span></li>`).join('')}</ul>`);
      else if (ON_PAGE_LINES[q.kind]) out.push(`<div class="lines">${'<div></div>'.repeat(ON_PAGE_LINES[q.kind])}</div>`);
      else out.push(`<span class="sheet">Separate sheet · Q${q.number}</span>`);
      out.push('</div>');
    }
  });
  return printPage(`${heading(bank)} · Quiz`, `${heading(bank)} · Quiz`, out.join('\n'));
}

function keyHtml(bank) {
  const qs = layout(bank), items = itemIndex(bank);
  const out = [`<h1>${esc(heading(bank))}</h1>`, '<p class="sub">Key</p>'];
  SECTIONS.forEach((s, si) => {
    const part = qs.filter(q => q.section === s.id);
    if (!part.length) return;
    out.push(`<h2${si ? ' class="new"' : ''}>${esc(s.title)}</h2>`);
    for (const q of part) {
      const tests = covers(q).map(id => (items.get(id) || { label: id }).label).join('; ');
      out.push('<div class="q">', q.section === 'multiple_choice'
        ? `<p><span class="n">Q${q.number}.</span> <b>${esc(q.answer)}.</b> ${esc(q.choices[LETTERS.indexOf(q.answer)] || '')}</p>`
        : `<p><span class="n">Q${q.number}.</span></p><p class="answer">${esc(q.answer)}</p>`,
      `<p>${esc(q.explanation)}</p>`, `<p class="meta">Ch. ${q.chapter}, p. ${esc(q.pages)} · ${esc(tests)}</p>`);
      if (q.rubric.length) out.push(`<table>${q.rubric.map(r => `<tr><td>${esc(r.criterion)}</td><td>${r.points} pts</td></tr>`).join('')}</table>`);
      out.push('</div>');
    }
  });
  return printPage(`${heading(bank)} · Key`, `${heading(bank)} · Key`, out.join('\n'));
}

function findBrowser() {
  return [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && fs.existsSync(p));
}

function printToPdf(browser, htmlFile, pdfFile) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-print-')); // a throwaway profile, so your open browser is untouched
  try {
    execFileSync(browser, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--user-data-dir=${profile}`,
      `--print-to-pdf=${path.resolve(pdfFile)}`, pathToFileURL(path.resolve(htmlFile)).href], { stdio: 'ignore', timeout: 180000 });
  } finally {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* a temp folder; the OS clears it */ }
  }
}

async function renderAll(bank, dir, pdfPath) {
  let figs = new Map();
  const ids = bank.chapters.flatMap(c => c.figures.map(f => figureId(f.id)));
  if (pdfPath && fs.existsSync(pdfPath)) {
    figs = await extractFigures(pdfPath, dir);
    const missing = ids.filter(id => !figs.has(id));
    console.log(`figures: ${ids.length - missing.length} of ${ids.length} cut from the PDF` +
      (missing.length ? `; the quiz points to the book for ${missing.join(', ')} (drawn as vector graphics, or captioned differently)` : ''));
  } else if (ids.length) {
    console.log('figures: the source PDF was not found, so the quiz points to book pages. Run render with --pdf <file> to include them.');
  }

  fs.writeFileSync(path.join(dir, 'quiz.md'), renderQuiz(bank, figs));
  fs.writeFileSync(path.join(dir, 'key.md'), renderKey(bank));
  const sheet = path.join(dir, 'answers.md');
  if (fs.existsSync(sheet)) console.log('kept your answers.md; delete it for a fresh sheet if the questions changed');
  else fs.writeFileSync(sheet, renderAnswerSheet(bank));
  fs.writeFileSync(path.join(dir, 'quiz.html'), quizHtml(bank, figs));
  fs.writeFileSync(path.join(dir, 'key.html'), keyHtml(bank));

  const browser = findBrowser();
  if (browser) {
    printToPdf(browser, path.join(dir, 'quiz.html'), path.join(dir, 'quiz.pdf'));
    printToPdf(browser, path.join(dir, 'key.html'), path.join(dir, 'key.pdf'));
    console.log('wrote quiz.pdf and key.pdf to print, plus quiz.md, key.md and answers.md, in', dir);
  } else {
    console.log('No Chrome or Edge found to make PDFs: open quiz.html and key.html in a browser and print them. Wrote them in', dir);
  }
}

/* ---------- make ---------- */
// Runs every task, at most `limit` at a time. The others wait until the first starts streaming,
// because that is when its cache entry becomes readable.
async function runAll(tasks, limit, start) {
  const settle = p => p.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
  const out = [];
  const first = start(tasks[0]);
  out[0] = settle(first.done);
  await Promise.race([first.stream.emitted('streamEvent').catch(() => {}), out[0]]);
  let next = 1;
  const worker = async () => { while (next < tasks.length) { const i = next++; out[i] = settle(start(tasks[i]).done); await out[i]; } };
  await Promise.all([out[0].then(worker), ...Array.from({ length: limit - 1 }, worker)]);
  return Promise.all(out);
}

function mergeChapter(bank, pass, ch, meta) {
  let entry = bank.chapters.find(c => c.chapter.number === ch.chapter.number);
  if (!entry) { entry = { chapter: ch.chapter, concepts: [], figures: [], listings: [], questions: [], passes: {} }; bank.chapters.push(entry); }
  if (pass === 'concepts') { entry.chapter = ch.chapter; entry.concepts = ch.concepts; }
  else { entry.figures = ch.figures; entry.listings = ch.listings; if (!entry.chapter.title) entry.chapter = ch.chapter; }
  const own = PASSES[pass].sections;
  entry.questions = entry.questions.filter(q => !own.includes(q.section)).concat(ch.questions.filter(q => own.includes(q.section)));
  entry.passes = { ...entry.passes, [pass]: meta };
}

async function make(o) {
  if (!o.target) throw new Error('Usage: npm run quiz -- make <chapters.pdf> --chapters 1-3 [--pass concepts|visuals] [--out dir] [--yes]');
  const chapters = parseChapters(o.chapters);
  const passes = o.pass ? [o.pass] : Object.keys(PASSES);
  const pdf = fs.readFileSync(o.target);
  const data = pdf.toString('base64');
  if (data.length > MAX_REQUEST_BYTES - 1024 * 1024) {
    throw new Error(`The PDF is ${(pdf.length / 1048576).toFixed(1)} MB, too large for one request once encoded (about 23 MB is the ceiling). Split it into smaller chapter ranges.`);
  }
  const client = loadKey();

  // Shared prefix: system, the PDF, and the instructions, cached for an hour after the first request.
  const shared = [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: o.book },
    { type: 'text', text: makeInstructions(o, chapters), cache_control: { type: 'ephemeral', ttl: '1h' } },
  ];
  const messagesFor = t => [{ role: 'user', content: [...shared, { type: 'text', text: `Chapter ${t.n}, ${PASSES[t.pass].label} pass.` }] }];
  const tasks = chapters.flatMap(n => passes.map(pass => ({ n, pass })));

  // Counting tokens is free; show the likely cost before spending anything.
  const { input_tokens } = await client.messages.countTokens({ model: MODEL, system: MAKE_SYSTEM, messages: messagesFor(tasks[0]) });
  const estOutput = tasks.reduce((s, t) => s + PASSES[t.pass].estOutput, 0);
  const est = (input_tokens * PRICE.cacheWrite + (tasks.length - 1) * input_tokens * PRICE.cacheRead + estOutput * PRICE.output) / 1e6;
  console.log(`${path.basename(o.target)}: ${(pdf.length / 1048576).toFixed(1)} MB, ${input_tokens.toLocaleString()} input tokens · chapters ${chapters.join(', ')} · ${tasks.length} requests sharing one cached PDF`);
  console.log(`Estimated cost: about ${dollars(est * 0.8)}–${dollars(est * 1.4)} (${MODEL}); the real figure prints at the end`);
  if (!(await confirm(o, 'Generate the questions?'))) return;

  const name = t => `Ch. ${t.n} ${PASSES[t.pass].label}`;
  const start = t => {
    console.log(`${name(t)}: started`);
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 128000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // if a safety classifier declines, the API retries on its recommended model
      system: MAKE_SYSTEM,
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema: CHAPTER_SCHEMA } },
      messages: messagesFor(t),
    });
    const done = stream.finalMessage();
    done.then(m => console.log(`${name(t)}: finished (${m.usage.output_tokens.toLocaleString()} output tokens)`), err => console.error(`${name(t)}: failed, ${err.message}`));
    return { stream, done };
  };
  console.log('Generating. Each request takes a few minutes...');
  const settled = await runAll(tasks, o.parallel, start);

  fs.mkdirSync(o.out, { recursive: true });
  const bank = fs.existsSync(bankPath(o.out)) ? loadBank(o.out) : { book: o.book, chapters: [] };
  const usage = {}, failed = [];
  settled.forEach((s, i) => {
    const t = tasks[i];
    try {
      if (s.status === 'rejected') throw s.reason;
      addUsage(usage, s.value.usage);
      const ch = readJsonReply(s.value, name(t));
      ch.chapter.number = t.n;
      mergeChapter(bank, t.pass, ch, { model: s.value.model, source: path.basename(o.target), createdAt: new Date().toISOString() });
    } catch (err) {
      failed.push(t);
      if (s.status === 'fulfilled') console.error(`${name(t)}: ${err.message}`);
    }
  });
  bank.chapters.sort((a, b) => a.chapter.number - b.chapter.number);
  bank.updatedAt = new Date().toISOString();
  bank.sourcePath = path.relative(process.cwd(), path.resolve(o.target)); // so render can cut figures again later
  if (!bank.chapters.length) throw new Error('Nothing came back; nothing written.');
  fs.writeFileSync(bankPath(o.out), JSON.stringify(bank, null, 2) + '\n');
  await renderAll(bank, o.out, o.target);

  for (const ch of bank.chapters) {
    const count = s => ch.questions.filter(q => q.section === s).length;
    console.log(`Ch. ${ch.chapter.number} ${ch.chapter.title}: ${ch.concepts.length} concepts, ${ch.figures.length} figures, ${ch.listings.length} code blocks · ` +
      `${count('multiple_choice')} multiple choice, ${count('explanatory')} explanatory, ${count('code_and_diagrams')} code and diagrams`);
  }
  console.log(`Tokens: ${(usage.input_tokens || 0).toLocaleString()} input, ${(usage.cache_creation_input_tokens || 0).toLocaleString()} cache write, ` +
    `${(usage.cache_read_input_tokens || 0).toLocaleString()} cache read, ${(usage.output_tokens || 0).toLocaleString()} output · about ${dollars(costOf(usage))}`);
  for (const p of checkBank(bank)) console.warn('check:', p);
  for (const t of failed) console.warn(`Rerun: npm run quiz -- make ${o.target} --chapters ${t.n} --pass ${t.pass} --out ${o.out}`);
}

/* ---------- balance ---------- */
const BALANCE_SCHEMA = strictObject({
  items: {
    type: 'array',
    items: strictObject({
      number: { type: 'integer' },
      choices: { type: 'array', items: str(), description: 'The four rewritten options, in the original order, without letters.' },
      explanation: str('The explanation, updated to match the rewritten options.'),
    }),
  },
});

const BALANCE_SYSTEM = `You edit multiple-choice study questions so the correct option can't be spotted by its length or its extra qualifications. Keep each question's meaning, its correct answer, and the position of the correct answer. Make all four options about the same length and level of detail: trim padding and hedges from the correct option, and give the wrong options the same specificity, so each stays tempting to someone who misread the material and clearly wrong to someone who understood it. Update the explanation to match the new wording.`;

async function balance(o) {
  const dir = o.target || o.out;
  const bank = loadBank(dir);
  const refs = layout(bank).filter(q => q.section === 'multiple_choice' && givesAway(q));
  const mcTotal = layout(bank).filter(q => q.section === 'multiple_choice').length;
  if (!refs.length) { console.log('No multiple-choice question gives its answer away by length.'); return; }

  // layout() numbers copies of the questions; this maps each number back to the question in the bank.
  const byNumber = new Map();
  let n = 0;
  for (const s of SECTIONS) for (const ch of bank.chapters) for (const q of ch.questions) if (q.section === s.id) { n++; byNumber.set(n, q); }

  const client = loadKey();
  const items = refs.map(q => ({ number: q.number, question: q.prompt, choices: q.choices, correct: q.answer, explanation: q.explanation }));
  const chunks = [];
  for (let i = 0; i < items.length; i += 40) chunks.push(items.slice(i, i + 40));
  const messagesFor = chunk => [{ role: 'user', content: `Rebalance the options of these questions. Return one entry per number.\n\n${JSON.stringify(chunk, null, 2)}` }];
  const { input_tokens } = await client.messages.countTokens({ model: MODEL, system: BALANCE_SYSTEM, messages: messagesFor(items) });
  const est = (input_tokens * PRICE.input + (items.length * 350 + chunks.length * 4000) * PRICE.output) / 1e6;
  console.log(`${refs.length} of ${mcTotal} multiple-choice questions give their answer away by length · about ${dollars(est)} to rebalance`);
  if (!(await confirm(o, 'Rebalance them?'))) return;

  const usage = {};
  let changed = 0;
  for (const [i, chunk] of chunks.entries()) {
    if (chunks.length > 1) console.log(`Rebalancing ${i + 1} of ${chunks.length}...`);
    const message = await client.beta.messages.stream({
      model: MODEL, max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      system: BALANCE_SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: BALANCE_SCHEMA } },
      messages: messagesFor(chunk),
    }).finalMessage();
    addUsage(usage, message.usage);
    for (const it of readJsonReply(message, 'Rebalancing').items) {
      const q = byNumber.get(it.number);
      if (!q || q.section !== 'multiple_choice' || it.choices.length !== 4) continue;
      q.choices = it.choices;
      q.explanation = it.explanation;
      changed++;
    }
  }
  const still = layout(bank).filter(q => q.section === 'multiple_choice' && givesAway(q)).length;
  fs.writeFileSync(bankPath(dir), JSON.stringify(bank, null, 2) + '\n');
  console.log(`Rebalanced ${changed} questions; ${still} of ${mcTotal} still have a clearly longest correct option · about ${dollars(costOf(usage))}`);
  await renderAll(bank, dir, o.pdf || bank.sourcePath);
}

/* ---------- grade ---------- */
function readAnswers(file) {
  const answers = new Map();
  let current = null, buf = [];
  const flush = () => { if (current !== null) { const t = buf.join('\n').replace(/<!--[\s\S]*?-->/g, '').trim(); if (t) answers.set(current, t); } buf = []; };
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^##\s+(\d+)\s*$/.exec(line);
    if (m) { flush(); current = Number(m[1]); }
    else if (/^#{1,6}\s/.test(line)) { flush(); current = null; }
    else if (current !== null) buf.push(line);
  }
  flush();
  return answers;
}

const GRADE_CHUNK = 40; // written answers per grading request

async function grade(o) {
  const dir = o.target || o.out;
  const bank = loadBank(dir), qs = layout(bank), items = itemIndex(bank);
  const answers = readAnswers(path.join(dir, 'answers.md'));
  if (!answers.size) throw new Error('answers.md has no answers yet.');

  const results = new Map(); // question number -> { score 0..1, ... }
  const written = [];
  for (const q of qs) {
    const a = answers.get(q.number);
    if (!a) continue;
    if (q.section === 'multiple_choice') {
      // A lone letter ("b", "B.", "(c)"), else the first capital A-D standing on its own ("I'd say C").
      const m = /^\(?([A-D])[).]?$/i.exec(a.split('\n')[0].trim()) || /(?:^|[\s(])([A-D])(?=$|[\s.,)])/.exec(a);
      const letter = m ? m[1].toUpperCase() : '';
      results.set(q.number, { score: letter === q.answer ? 1 : 0, given: letter || a });
    } else {
      written.push({ number: q.number, question: q.prompt, code: q.code, figure: q.figure, model_answer: q.answer, why: q.explanation, rubric: q.rubric, student_answer: a });
    }
  }

  const usage = {};
  if (written.length) {
    const client = loadKey();
    const chunks = [];
    for (let i = 0; i < written.length; i += GRADE_CHUNK) chunks.push(written.slice(i, i + GRADE_CHUNK));
    const messagesFor = chunk => [{ role: 'user', content: `Grade these answers. Return one entry per number, with points awarded for each rubric criterion in order.\n\n${JSON.stringify(chunk, null, 2)}` }];
    const { input_tokens } = await client.messages.countTokens({ model: MODEL, system: GRADE_SYSTEM, messages: messagesFor(written) });
    const est = (input_tokens * PRICE.input + (written.length * 600 + chunks.length * 6000) * PRICE.output) / 1e6;
    console.log(`${answers.size} answers: ${results.size} multiple choice marked here, ${written.length} written answers to grade · about ${dollars(est)}`);
    if (!(await confirm(o, 'Grade the written answers?'))) return;
    for (const [i, chunk] of chunks.entries()) {
      if (chunks.length > 1) console.log(`Grading ${i + 1} of ${chunks.length}...`);
      const message = await client.beta.messages.stream({
        model: MODEL,
        max_tokens: 64000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: GRADE_SYSTEM,
        output_config: { effort: EFFORT, format: { type: 'json_schema', schema: GRADE_SCHEMA } },
        messages: messagesFor(chunk),
      }).finalMessage();
      addUsage(usage, message.usage);
      for (const g of readJsonReply(message, 'Grading').grades) {
        const q = qs.find(x => x.number === g.number);
        if (!q || q.section === 'multiple_choice') continue;
        const got = q.rubric.reduce((s, r, j) => s + Math.max(0, Math.min(r.points, g.awarded[j] || 0)), 0);
        results.set(q.number, { score: got / points(q), points: got, feedback: g.feedback });
      }
    }
  }

  // Mastery of each concept, figure and code block: the average score of the answered questions that cover it.
  const scores = new Map();
  for (const q of qs) {
    const r = results.get(q.number);
    if (r) for (const id of covers(q)) scores.set(id, [...(scores.get(id) || []), r.score]);
  }
  const rows = [...items.values()].map(it => { const s = scores.get(it.id); return { ...it, score: s ? s.reduce((a, b) => a + b, 0) / s.length : null }; });
  const status = s => (s === null ? 'Not tested' : s >= 0.8 ? 'Mastered' : s >= 0.5 ? 'Shaky' : 'Not yet');
  const pct = x => (x === null ? '' : Math.round(x * 100) + '%');

  const mc = qs.filter(q => q.section === 'multiple_choice' && results.has(q.number));
  const wr = qs.filter(q => q.section !== 'multiple_choice' && results.has(q.number));
  const lines = [`# Results · ${heading(bank)}`, '',
    [`Answered ${results.size} of ${qs.length}.`,
      mc.length ? `Multiple choice: ${mc.filter(q => results.get(q.number).score === 1).length} of ${mc.length} correct.` : '',
      wr.length ? `Written: ${wr.reduce((s, q) => s + results.get(q.number).points, 0)} of ${wr.reduce((s, q) => s + points(q), 0)} points.` : '',
    ].filter(Boolean).join(' '), ''];

  const revisit = rows.filter(r => r.score !== null && r.score < 0.8).sort((a, b) => a.score - b.score);
  lines.push('## To revisit', '');
  if (revisit.length) lines.push('| Item | Status | Score | Reread |', '|---|---|---|---|', ...revisit.map(r => `| ${cell(r.label)} | ${status(r.score)} | ${pct(r.score)} | Ch. ${r.chapter}, p. ${r.pages} |`), '');
  else lines.push('Nothing among the questions you answered.', '');
  const untested = rows.filter(r => r.score === null);
  if (untested.length) lines.push(`Not tested yet, because no answered question covers them: ${untested.length} (marked "Not tested" below).`, '');

  const table = (title, kind, withWeight) => {
    const list = rows.filter(r => r.kind === kind);
    if (!list.length) return;
    lines.push(`## ${title}`, '', withWeight ? '| Concept | Weight | Status | Score |' : '| Item | Pages | Status | Score |', '|---|---|---|---|',
      ...list.map(r => `| ${cell(r.label)} | ${withWeight ? r.weight : r.pages} | ${status(r.score)} | ${pct(r.score)} |`), '');
  };
  table('Concepts', 'concept', true);
  table('Figures', 'figure', false);
  table('Code', 'code', false);

  lines.push('## Question by question', '');
  for (const q of qs) {
    const r = results.get(q.number);
    if (!r) continue;
    if (q.section === 'multiple_choice') {
      lines.push(r.score === 1 ? `**${q.number}.** Correct (${q.answer}).` : `**${q.number}.** You answered ${r.given}; the answer is ${q.answer}. ${q.explanation} *(p. ${q.pages})*`, '');
    } else {
      lines.push(`**${q.number}.** ${r.points}/${points(q)}. ${r.feedback} *(p. ${q.pages})*`, '');
    }
  }
  fs.writeFileSync(path.join(dir, 'graded.md'), lines.join('\n'));
  fs.writeFileSync(path.join(dir, 'graded.json'), JSON.stringify({ gradedAt: new Date().toISOString(), results: Object.fromEntries(results), items: rows.map(({ id, kind, score }) => ({ id, kind, score })) }, null, 2) + '\n');
  console.log('wrote graded.md and graded.json in', dir);
  if (usage.output_tokens) console.log(`Grading: ${(usage.input_tokens || 0).toLocaleString()} input, ${usage.output_tokens.toLocaleString()} output tokens · about ${dollars(costOf(usage))}`);
}

/* ---------- main ---------- */
async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.command === 'make') return make(o);
  if (o.command === 'grade') return grade(o);
  if (o.command === 'balance') return balance(o);
  if (o.command === 'render') {
    const dir = o.target || o.out, bank = loadBank(dir);
    await renderAll(bank, dir, o.pdf || bank.sourcePath);
    for (const p of checkBank(bank)) console.warn('check:', p);
    return;
  }
  throw new Error('Usage: npm run quiz -- make <chapters.pdf> --chapters 1-3 | grade [dir] | render [dir] | balance [dir]');
}

main().catch(err => {
  if (err instanceof Anthropic.AuthenticationError) console.error('The API key was rejected. Check ANTHROPIC_API_KEY.');
  else if (err instanceof Anthropic.RateLimitError) console.error('Rate limited. Wait a minute and run it again.');
  else if (err instanceof Anthropic.APIError) console.error(`API error ${err.status}: ${err.message}`);
  else console.error(err.message);
  process.exitCode = 1;
});
