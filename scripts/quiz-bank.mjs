// Builds study quizzes from a PDF of textbook chapters, and grades your answers.
// Runs on your machine only: the API key can't live in the browser, and the book never enters the repo.
//
//   npm run quiz -- make <chapters.pdf> --chapters 1-3 [--out private/quizzes/ai-430-m1] [--book "..."] [--yes]
//   npm run quiz -- grade [dir] [--yes]    mark answers.md against the key, write graded.md
//   npm run quiz -- render [dir]           rewrite quiz.md and key.md from bank.json, no API call
//
// make sends one request per chapter, all sharing the cached PDF. Each request maps the chapter's concepts,
// then writes questions until every concept is covered, in three parts: multiple choice, explanatory, and
// code and diagrams. Running make again with --chapters 2 replaces just that chapter in the bank.
//
// Needs ANTHROPIC_API_KEY in the environment, or in .env or .env.local (both gitignored).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
const EFFORT = 'high'; // identical on every request, or the cached PDF is missed
const PRICE = { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 }; // USD per million tokens, Claude Opus 5.5, 5-minute cache
const MAX_REQUEST_BYTES = 32 * 1024 * 1024; // API request limit; base64 adds a third to the PDF's size
const DEFAULTS = { book: 'Hands-On Large Language Models, by Jay Alammar and Maarten Grootendorst', out: 'private/quizzes/ai-430-m1' };

const SECTIONS = [
  { id: 'multiple_choice', title: 'Part 1 · Multiple choice' },
  { id: 'explanatory', title: 'Part 2 · Explanatory' },
  { id: 'code_and_diagrams', title: 'Part 3 · Code and diagrams' },
];
const KINDS = {
  single_answer: 'Multiple choice', explain: 'Explain', why: 'Why', what_if: 'What if', compare: 'Compare',
  predict_output: 'Predict the output', explain_code: 'Explain the code', find_bug: 'Find the bug', modify_code: 'Modify the code', explain_figure: 'Walk through the figure',
};
const LETTERS = ['A', 'B', 'C', 'D'];

/* ---------- arguments ---------- */
function parseArgs(argv) {
  const o = { ...DEFAULTS, yes: false, chapters: null, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') o.yes = true;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--book') o.book = argv[++i];
    else if (a === '--chapters') o.chapters = argv[++i];
    else if (a.startsWith('--')) throw new Error('Unknown option ' + a);
    else o.positional.push(a);
  }
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
const strictObject = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const RUBRIC = { type: 'array', items: strictObject({ criterion: { type: 'string' }, points: { type: 'integer' } }) };

const CHAPTER_SCHEMA = strictObject({
  chapter: strictObject({ number: { type: 'integer' }, title: { type: 'string' }, pages: { type: 'string' } }),
  concepts: {
    type: 'array',
    items: strictObject({
      id: { type: 'string', description: 'The chapter number, a dot, and a sequence number: "2.1", "2.2", ...' },
      name: { type: 'string' },
      summary: { type: 'string', description: 'One sentence on what a reader should take away.' },
      weight: { type: 'string', enum: ['core', 'supporting'] },
      pages: { type: 'string' },
    }),
  },
  questions: {
    type: 'array',
    items: strictObject({
      section: { type: 'string', enum: SECTIONS.map(s => s.id) },
      kind: { type: 'string', enum: Object.keys(KINDS) },
      concepts: { type: 'array', items: { type: 'string' }, description: 'Ids of the concepts this question tests.' },
      level: { type: 'string', enum: ['recall', 'understand', 'apply', 'analyze'] },
      pages: { type: 'string', description: 'Page numbers printed on the book pages, such as "34" or "34-36".' },
      prompt: { type: 'string' },
      code: { type: 'string', description: 'For code questions, the snippet the question is about, trimmed to the lines needed. Empty otherwise.' },
      figure: { type: 'string', description: 'For explain_figure, the figure number and printed page, such as "Figure 2-5, p. 41". Empty otherwise.' },
      choices: { type: 'array', items: { type: 'string' }, description: 'multiple_choice: four options, without letters. Empty otherwise.' },
      answer: { type: 'string', description: 'multiple_choice: the correct letter, A to D. Otherwise a model answer.' },
      explanation: { type: 'string', description: 'Why the answer is right; for multiple_choice, also why each tempting wrong option is wrong.' },
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
      feedback: { type: 'string' },
    }),
  },
});

/* ---------- prompts ---------- */
const MAKE_SYSTEM = `You write study material for a graduate student working through a technical textbook on their own, who wants to understand every chapter fully. Good questions test whether the student understood the material and can use it, not whether they memorized wording. Every question must be answerable from the attached pages and make sense without the book open, except figure questions, which name the figure to look at.`;

function makeInstructions(o, chapters) {
  return `The attached PDF holds chapters ${chapters.join(', ')} of ${o.book}. You will be asked for one chapter at a time.

For the chapter you are given:

1. Map it. List its concepts in the order the chapter teaches them: every idea, technique, term, result, or design choice a reader should take away, granular enough that mastering all of them means mastering the chapter. Mark each one core (central to the chapter, or needed later in the book) or supporting.

2. Write questions until every concept is covered, in three sections. There is no length limit: write as many as full coverage needs, and no near-duplicates.
- multiple_choice: at least one question per concept, and two or more for each core concept, testing different aspects. Four options, exactly one correct, with wrong options drawn from realistic misconceptions. Vary the position of the correct answer.
- explanatory: at least one per core concept, mixing explain (in your own words), why, what_if (what changes if an assumption or setting changes), and compare.
- code_and_diagrams: for each code listing that does something substantive, ask the student to predict its output or tensor shapes, explain what it does and why, find a bug you plant in it, or modify it to do something new; put the snippet in code, trimmed to the lines needed. For each figure that carries an idea, ask the student to walk through it (explain_figure), naming the figure and its printed page.

Every explanatory and code_and_diagrams question gets a model answer and a rubric of three to five criteria totalling 10 points. Mix levels from recall to analyze, mostly understand and apply. Cite the page numbers printed on the book pages, not the PDF's own page count. Paraphrase the book's prose rather than quoting more than a short phrase.`;
}

const GRADE_SYSTEM = `You grade a student's written answers to study questions about a technical textbook, using each question's model answer and rubric. Award a criterion's points only for what the answer actually shows, give partial points where the answer earns some, and don't reward length. Accept correct answers that differ from the model answer. Feedback speaks to the student directly in two to four sentences: what they got right, what is missing or wrong, and what to reread.`;

/* ---------- helpers ---------- */
function loadKey() {
  for (const f of ['.env.local', '.env']) { try { process.loadEnvFile(f); } catch { /* the key can also come from the environment */ } }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY, or put ANTHROPIC_API_KEY=... in .env at the repo root.');
  return new Anthropic();
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

function conceptIndex(bank) {
  const map = new Map();
  for (const ch of bank.chapters) for (const c of ch.concepts) map.set(c.id, { ...c, chapter: ch.chapter.number });
  return map;
}

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
    const n = ch.chapter.number, ids = new Set(ch.concepts.map(c => c.id));
    const tested = section => new Set(ch.questions.filter(q => q.section === section).flatMap(q => q.concepts));
    const mc = tested('multiple_choice'), ex = tested('explanatory');
    for (const c of ch.concepts) {
      if (!mc.has(c.id)) problems.push(`Ch. ${n}: concept ${c.id} "${c.name}" has no multiple-choice question`);
      if (c.weight === 'core' && !ex.has(c.id)) problems.push(`Ch. ${n}: core concept ${c.id} "${c.name}" has no explanatory question`);
    }
    ch.questions.forEach((q, i) => {
      const where = `Ch. ${n}, question ${i + 1}`;
      for (const id of q.concepts) if (!ids.has(id)) problems.push(`${where}: unknown concept ${id}`);
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
  const qs = layout(bank), concepts = conceptIndex(bank);
  const lines = [`# Key · ${heading(bank)}`, ''];
  for (const s of SECTIONS) {
    const part = qs.filter(q => q.section === s.id);
    if (!part.length) continue;
    lines.push(`## ${s.title}`, '');
    for (const q of part) {
      const tests = q.concepts.map(id => `${id} ${(concepts.get(id) || {}).name || ''}`.trim()).join('; ');
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
async function make(o) {
  if (!o.target) throw new Error('Usage: npm run quiz -- make <chapters.pdf> --chapters 1-3 [--out dir] [--yes]');
  const chapters = parseChapters(o.chapters);
  const pdf = fs.readFileSync(o.target);
  const data = pdf.toString('base64');
  if (data.length > MAX_REQUEST_BYTES - 1024 * 1024) {
    throw new Error(`The PDF is ${(pdf.length / 1048576).toFixed(1)} MB, too large for one request once encoded (about 23 MB is the ceiling). Split it into smaller chapter ranges.`);
  }
  const client = loadKey();

  // Shared prefix: system, the PDF, and the instructions, cached after the first request.
  const shared = [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: o.book },
    { type: 'text', text: makeInstructions(o, chapters), cache_control: { type: 'ephemeral' } },
  ];
  const messagesFor = n => [{ role: 'user', content: [...shared, { type: 'text', text: `Write the map and questions for Chapter ${n}.` }] }];

  // Counting tokens is free; show the likely cost before spending anything.
  const { input_tokens } = await client.messages.countTokens({ model: MODEL, system: MAKE_SYSTEM, messages: messagesFor(chapters[0]) });
  const estOutputPerChapter = 35000; // questions plus thinking; the real figure prints when it finishes
  const est = (input_tokens * PRICE.cacheWrite + (chapters.length - 1) * input_tokens * PRICE.cacheRead + chapters.length * estOutputPerChapter * PRICE.output) / 1e6;
  console.log(`${path.basename(o.target)}: ${(pdf.length / 1048576).toFixed(1)} MB, ${input_tokens.toLocaleString()} input tokens, chapters ${chapters.join(', ')}`);
  console.log(`Estimated cost: about ${dollars(est)} (${MODEL}, ${chapters.length} requests sharing one cached PDF)`);
  if (!(await confirm(o, 'Generate the questions?'))) return;

  const start = n => {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 128000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // if a safety classifier declines, the API retries on its recommended model
      system: MAKE_SYSTEM,
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema: CHAPTER_SCHEMA } },
      messages: messagesFor(n),
    });
    const done = stream.finalMessage();
    done.then(m => console.log(`Chapter ${n}: finished (${m.usage.output_tokens.toLocaleString()} output tokens)`), err => console.error(`Chapter ${n}: failed, ${err.message}`));
    return { n, stream, done };
  };

  // The cache is readable once the first response starts streaming, so the rest wait for that.
  console.log('Generating. Each chapter takes a few minutes...');
  const first = start(chapters[0]);
  await Promise.race([first.stream.emitted('streamEvent').catch(() => {}), first.done.catch(() => {})]);
  const runs = [first, ...chapters.slice(1).map(start)];
  const settled = await Promise.allSettled(runs.map(r => r.done));

  fs.mkdirSync(o.out, { recursive: true });
  const bank = fs.existsSync(bankPath(o.out)) ? loadBank(o.out) : { book: o.book, chapters: [] };
  const usage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  const failed = [];
  settled.forEach((s, i) => {
    const n = runs[i].n;
    try {
      if (s.status === 'rejected') throw s.reason;
      for (const k of Object.keys(usage)) usage[k] += s.value.usage[k] || 0;
      const ch = readJsonReply(s.value, `Chapter ${n}`);
      bank.chapters = bank.chapters.filter(c => c.chapter.number !== ch.chapter.number).concat({ ...ch, model: s.value.model, source: path.basename(o.target), createdAt: new Date().toISOString() });
    } catch (err) {
      failed.push(n);
      if (s.status === 'fulfilled') console.error(`Chapter ${n}: ${err.message}`);
    }
  });
  bank.chapters.sort((a, b) => a.chapter.number - b.chapter.number);
  bank.updatedAt = new Date().toISOString();
  if (!bank.chapters.length) throw new Error('No chapter came back; nothing written.');
  fs.writeFileSync(bankPath(o.out), JSON.stringify(bank, null, 2) + '\n');
  writeQuizFiles(bank, o.out);

  for (const ch of bank.chapters) {
    const count = s => ch.questions.filter(q => q.section === s).length;
    console.log(`Ch. ${ch.chapter.number} ${ch.chapter.title}: ${ch.concepts.length} concepts · ${count('multiple_choice')} multiple choice, ${count('explanatory')} explanatory, ${count('code_and_diagrams')} code and diagrams`);
  }
  console.log(`Tokens: ${usage.input_tokens.toLocaleString()} input, ${usage.cache_creation_input_tokens.toLocaleString()} cache write, ${usage.cache_read_input_tokens.toLocaleString()} cache read, ${usage.output_tokens.toLocaleString()} output · about ${dollars(costOf(usage))}`);
  for (const p of checkBank(bank)) console.warn('check:', p);
  if (failed.length) console.warn(`Chapters ${failed.join(', ')} failed. Run make again with --chapters ${failed.join(',')} and the same --out to add them.`);
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

async function grade(o) {
  const dir = o.target || o.out;
  const bank = loadBank(dir), qs = layout(bank), concepts = conceptIndex(bank);
  const answers = readAnswers(path.join(dir, 'answers.md'));
  if (!answers.size) throw new Error('answers.md has no answers yet.');

  const results = new Map(); // number -> { score 0..1, ... }
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

  let usage = null;
  if (written.length) {
    const client = loadKey();
    const messages = [{ role: 'user', content: `Grade these answers. Return one entry per number, with points awarded for each rubric criterion in order.\n\n${JSON.stringify(written, null, 2)}` }];
    const { input_tokens } = await client.messages.countTokens({ model: MODEL, system: GRADE_SYSTEM, messages });
    const est = (input_tokens * PRICE.input + (written.length * 500 + 8000) * PRICE.output) / 1e6;
    console.log(`${answers.size} answers: ${results.size} multiple choice marked here, ${written.length} written answers to grade · about ${dollars(est)}`);
    if (!(await confirm(o, 'Grade the written answers?'))) return;
    const message = await client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: GRADE_SYSTEM,
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema: GRADE_SCHEMA } },
      messages,
    }).finalMessage();
    usage = message.usage;
    for (const g of readJsonReply(message, 'Grading').grades) {
      const q = qs.find(x => x.number === g.number);
      if (!q || q.section === 'multiple_choice') continue;
      const got = q.rubric.reduce((s, r, i) => s + Math.max(0, Math.min(r.points, g.awarded[i] || 0)), 0);
      results.set(q.number, { score: got / points(q), points: got, feedback: g.feedback });
    }
  }

  // Concept mastery: the average score of every answered question that tests the concept.
  const byConcept = new Map();
  for (const q of qs) {
    const r = results.get(q.number);
    if (!r) continue;
    for (const id of q.concepts) byConcept.set(id, [...(byConcept.get(id) || []), r.score]);
  }
  const status = s => (s >= 0.8 ? 'Mastered' : s >= 0.5 ? 'Shaky' : 'Not yet');
  const rows = [...concepts.values()].map(c => {
    const s = byConcept.get(c.id);
    return { ...c, score: s ? s.reduce((a, b) => a + b, 0) / s.length : null };
  });

  const mc = qs.filter(q => q.section === 'multiple_choice' && results.has(q.number));
  const wr = qs.filter(q => q.section !== 'multiple_choice' && results.has(q.number));
  const pct = x => Math.round(x * 100) + '%';
  const lines = [`# Results · ${heading(bank)}`, '',
    [`Answered ${results.size} of ${qs.length}.`,
      mc.length ? `Multiple choice: ${mc.filter(q => results.get(q.number).score === 1).length} of ${mc.length} correct.` : '',
      wr.length ? `Written: ${wr.reduce((s, q) => s + results.get(q.number).points, 0)} of ${wr.reduce((s, q) => s + points(q), 0)} points.` : '',
    ].filter(Boolean).join(' '), ''];
  const revisit = rows.filter(r => r.score !== null && r.score < 0.8).sort((a, b) => a.score - b.score);
  lines.push('## Concepts to revisit', '');
  if (revisit.length) lines.push('| Concept | Status | Score | Reread |', '|---|---|---|---|', ...revisit.map(r => `| ${r.id} ${cell(r.name)} | ${status(r.score)} | ${pct(r.score)} | Ch. ${r.chapter}, p. ${r.pages} |`), '');
  else lines.push('None among the questions you answered.', '');
  const untested = rows.filter(r => r.score === null);
  if (untested.length) lines.push(`Not yet tested, because no answered question covers them: ${untested.map(r => `${r.id} ${r.name}`).join('; ')}.`, '');
  lines.push('## All concepts', '', '| Concept | Weight | Status | Score |', '|---|---|---|---|',
    ...rows.map(r => `| ${r.id} ${cell(r.name)} | ${r.weight} | ${r.score === null ? 'Not tested' : status(r.score)} | ${r.score === null ? '' : pct(r.score)} |`), '');
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
  fs.writeFileSync(path.join(dir, 'graded.json'), JSON.stringify({ gradedAt: new Date().toISOString(), results: Object.fromEntries(results), concepts: rows.map(({ id, score }) => ({ id, score })) }, null, 2) + '\n');
  console.log('wrote graded.md and graded.json in', dir);
  if (usage) console.log(`Grading: ${usage.input_tokens.toLocaleString()} input, ${usage.output_tokens.toLocaleString()} output tokens · about ${dollars(costOf(usage))}`);
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
