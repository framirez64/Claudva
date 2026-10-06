// Builds study quizzes from a PDF of textbook chapters, and grades your answers.
// Runs on your machine only: the API key can't live in the browser, and the book never enters the repo.
//
//   npm run quiz -- make <chapters.pdf> --chapters 1-3 [--pass concepts|visuals] [--out dir] [--book "..."] [--parallel 3] [--yes]
//   npm run quiz -- grade [dir] [--yes]    mark answers.md against the key, write graded.md
//   npm run quiz -- render [dir]           rewrite quiz.md and key.md from bank.json, no API call
//
// make runs two passes per chapter, all sharing one cached copy of the PDF:
//   concepts  maps the chapter's concepts, then writes multiple-choice and explanatory questions until every one is covered
//   visuals   lists every numbered figure and every code block, then writes at least one question about each
// Running make again with --chapters 2 (and optionally --pass) replaces just that part of the bank.
//
// Needs ANTHROPIC_API_KEY in the environment, or in .env or .env.local (both gitignored).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
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
    else if (['--out', '--book', '--chapters', '--pass'].includes(a)) o[a.slice(2)] = argv[++i];
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
- multiple_choice: at least one question per concept, and two or more for each core concept, testing different aspects. Four options, exactly one correct, with wrong options drawn from realistic misconceptions. Vary the position of the correct answer.
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
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY, or put ANTHROPIC_API_KEY=... in .env at the repo root.');
  return new Anthropic({ maxRetries: 4 });
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
function checkBank(bank) {
  const problems = [];
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

function renderQuiz(bank) {
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
      if (q.figure) lines.push(`*Look at ${q.figure}.*`, '');
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

function writeQuizFiles(bank, dir) {
  fs.writeFileSync(path.join(dir, 'quiz.md'), renderQuiz(bank));
  fs.writeFileSync(path.join(dir, 'key.md'), renderKey(bank));
  const sheet = path.join(dir, 'answers.md');
  if (fs.existsSync(sheet)) console.log('kept your answers.md; delete it for a fresh sheet if the questions changed');
  else fs.writeFileSync(sheet, renderAnswerSheet(bank));
  console.log('wrote quiz.md, key.md and answers.md in', dir);
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
  if (!bank.chapters.length) throw new Error('Nothing came back; nothing written.');
  fs.writeFileSync(bankPath(o.out), JSON.stringify(bank, null, 2) + '\n');
  writeQuizFiles(bank, o.out);

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
  if (o.command === 'render') {
    const dir = o.target || o.out, bank = loadBank(dir);
    writeQuizFiles(bank, dir);
    for (const p of checkBank(bank)) console.warn('check:', p);
    return;
  }
  throw new Error('Usage: npm run quiz -- make <chapters.pdf> --chapters 1-3 | grade [dir] | render [dir]');
}

main().catch(err => {
  if (err instanceof Anthropic.AuthenticationError) console.error('The API key was rejected. Check ANTHROPIC_API_KEY.');
  else if (err instanceof Anthropic.RateLimitError) console.error('Rate limited. Wait a minute and run it again.');
  else if (err instanceof Anthropic.APIError) console.error(`API error ${err.status}: ${err.message}`);
  else console.error(err.message);
  process.exitCode = 1;
});
