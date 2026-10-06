// Builds a question bank from a PDF of textbook chapters, then writes a short quiz and a long-form test.
// Runs on your machine only: the API key can't live in the browser, and the book never enters the repo.
//
//   node scripts/quiz-bank.mjs <chapters.pdf> [--out private/quizzes/ai-430-m1] [--book "..."] [--mc 6 --short 3 --long 2] [--yes]
//   node scripts/quiz-bank.mjs --render <bank.json>     rewrite the Markdown from a saved bank, no API call
//
// Needs ANTHROPIC_API_KEY in the environment, or in .env or .env.local (both gitignored).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
const PRICE = { input: 4, output: 20 }; // USD per million tokens, Claude Opus 5.5
const MAX_REQUEST_BYTES = 32 * 1024 * 1024; // API request limit; base64 adds a third to the PDF's size

const DEFAULTS = { book: 'Hands-On Large Language Models, by Jay Alammar and Maarten Grootendorst', out: 'private/quizzes/ai-430-m1', mc: 6, short: 3, long: 2 };

/* ---------- arguments ---------- */
function parseArgs(argv) {
  const opts = { ...DEFAULTS, yes: false, render: null, pdf: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') opts.yes = true;
    else if (a === '--render') opts.render = argv[++i];
    else if (['--out', '--book'].includes(a)) opts[a.slice(2)] = argv[++i];
    else if (['--mc', '--short', '--long'].includes(a)) opts[a.slice(2)] = Number(argv[++i]);
    else if (!a.startsWith('--') && !opts.pdf) opts.pdf = a;
    else throw new Error('Unknown option ' + a);
  }
  return opts;
}

/* ---------- the bank's shape (structured output) ---------- */
const strictObject = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const BANK_SCHEMA = strictObject({
  chapters: { type: 'array', items: strictObject({ number: { type: 'integer' }, title: { type: 'string' } }) },
  questions: {
    type: 'array',
    items: strictObject({
      chapter: { type: 'integer' },
      pages: { type: 'string', description: 'Page numbers printed on the book pages, such as "34" or "34-36".' },
      format: { type: 'string', enum: ['multiple_choice', 'short_answer', 'long_form'] },
      level: { type: 'string', enum: ['recall', 'understand', 'apply', 'analyze'] },
      prompt: { type: 'string' },
      choices: { type: 'array', items: { type: 'string' }, description: 'Four options for multiple_choice, without letters; empty otherwise.' },
      answer: { type: 'string', description: 'multiple_choice: the correct letter, A to D. short_answer: a model answer of one to three sentences. long_form: a model answer.' },
      explanation: { type: 'string', description: 'Why the answer is right, and for multiple_choice why the tempting wrong options are wrong.' },
      rubric: { type: 'array', items: strictObject({ criterion: { type: 'string' }, points: { type: 'integer' } }), description: 'long_form only, totalling 10 points; empty otherwise.' },
    }),
  },
});

const SYSTEM = `You write study questions for a graduate student working through a technical textbook on their own. Good questions test whether the student understood and can use the material, not whether they memorized wording. Every question must be answerable from the attached pages alone, and stand on its own without the book open.`;

function instructions(o) {
  return `The attached PDF holds consecutive chapters of ${o.book}.

Write a question bank covering every chapter in it, spread evenly across each chapter's sections. For each chapter write:
- ${o.mc} multiple_choice questions: four options, exactly one correct, with wrong options drawn from realistic misconceptions. Vary the position of the correct answer.
- ${o.short} short_answer questions, answerable in one to three sentences.
- ${o.long} long_form questions: explain, compare, derive, or design something the chapter teaches. Give a model answer and a rubric of three to five criteria totalling 10 points.

Mix the levels from recall to analyze, with most at understand or apply. Where a chapter shows code, include questions about what the code does or produces. Cite the page numbers printed on the book pages, not the PDF's own page count. Paraphrase rather than quoting more than a short phrase. List each chapter's number and title as the book gives them.`;
}

/* ---------- Markdown ---------- */
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
function renderQuiz(bank, { title, formats, withRubric }) {
  const qs = bank.questions.filter(q => formats.includes(q.format));
  const chapterTitle = n => (bank.chapters.find(c => c.number === n) || {}).title || '';
  const lines = [`# ${title}`, '', `${qs.length} question${qs.length === 1 ? '' : 's'}. The answer key is at the end.`, ''];
  const key = ['---', '', '## Answer key', ''];
  let n = 0, lastChapter = null;
  for (const q of qs) {
    n++;
    if (q.chapter !== lastChapter) { lines.push(`## Chapter ${q.chapter}: ${chapterTitle(q.chapter)}`, ''); lastChapter = q.chapter; }
    const tag = q.format === 'multiple_choice' ? 'Multiple choice' : q.format === 'short_answer' ? 'Short answer' : 'Long form, 10 points';
    lines.push(`**${n}.** ${q.prompt}  `, `*${tag} · ${q.level}*`, '');
    if (q.format === 'multiple_choice') { q.choices.forEach((c, i) => lines.push(`- ${LETTERS[i]}. ${c}`)); lines.push(''); }
    key.push(`**${n}.** ${q.format === 'multiple_choice' ? `**${q.answer}.** ${q.choices[LETTERS.indexOf(q.answer)] || ''}` : q.answer}  `,
      `${q.explanation} *(Ch. ${q.chapter}, p. ${q.pages})*`, '');
    if (withRubric && q.rubric.length) {
      key.push('| Criterion | Points |', '|---|---|', ...q.rubric.map(r => `| ${r.criterion.replace(/\|/g, '\\|')} | ${r.points} |`), '');
    }
  }
  return [...lines, ...key].join('\n');
}

function writeOutputs(bank, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const range = bank.chapters.length ? `Ch. ${bank.chapters[0].number}–${bank.chapters[bank.chapters.length - 1].number}` : 'chapters';
  const heading = `${String(bank.book || '').split(',')[0]} · ${range}`;
  const short = renderQuiz(bank, { title: `${heading} · Short quiz`, formats: ['multiple_choice', 'short_answer'], withRubric: false });
  const long = renderQuiz(bank, { title: `${heading} · Long-form test`, formats: ['long_form'], withRubric: true });
  fs.writeFileSync(path.join(dir, 'short-quiz.md'), short);
  fs.writeFileSync(path.join(dir, 'long-test.md'), long);
  return [path.join(dir, 'short-quiz.md'), path.join(dir, 'long-test.md')];
}

function checkBank(bank) {
  const problems = [];
  for (const [i, q] of bank.questions.entries()) {
    if (q.format === 'multiple_choice' && (q.choices.length !== 4 || !LETTERS.slice(0, 4).includes(q.answer))) problems.push(`question ${i + 1}: multiple choice needs four options and an answer A-D`);
    if (q.format === 'long_form' && q.rubric.reduce((s, r) => s + r.points, 0) !== 10) problems.push(`question ${i + 1}: rubric does not total 10 points`);
  }
  return problems;
}

/* ---------- main ---------- */
async function main() {
  const o = parseArgs(process.argv.slice(2));

  if (o.render) {
    const bank = JSON.parse(fs.readFileSync(o.render, 'utf8'));
    for (const f of writeOutputs(bank, path.dirname(o.render))) console.log('wrote', f);
    return;
  }
  if (!o.pdf) throw new Error('Usage: node scripts/quiz-bank.mjs <chapters.pdf> [--out dir] [--yes]   (or --render <bank.json>)');

  const pdf = fs.readFileSync(o.pdf);
  const data = pdf.toString('base64');
  if (data.length > MAX_REQUEST_BYTES - 1024 * 1024) {
    throw new Error(`The PDF is ${(pdf.length / 1048576).toFixed(1)} MB, too large for one request once encoded (about 23 MB is the ceiling). Split it into smaller chapter ranges.`);
  }

  for (const f of ['.env.local', '.env']) { try { process.loadEnvFile(f); } catch { /* the key can also come from the environment */ } }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY, or put ANTHROPIC_API_KEY=... in .env at the repo root.');
  const client = new Anthropic();

  const messages = [{
    role: 'user',
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: o.book },
      { type: 'text', text: instructions(o) },
    ],
  }];

  // Counting tokens is free; show the likely cost before spending anything.
  const { input_tokens } = await client.messages.countTokens({ model: MODEL, system: SYSTEM, messages });
  const perChapterQs = o.mc + o.short + o.long;
  const estOutput = 3 * perChapterQs * 450 + 15000; // assumes about three chapters; includes thinking
  console.log(`${path.basename(o.pdf)}: ${(pdf.length / 1048576).toFixed(1)} MB, ${input_tokens.toLocaleString()} input tokens`);
  console.log(`Estimated cost: about $${((input_tokens * PRICE.input + estOutput * PRICE.output) / 1e6).toFixed(2)} (${MODEL})`);
  if (!o.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ok = /^y/i.test(await rl.question('Generate the question bank? [y/N] '));
    rl.close();
    if (!ok) return;
  }

  console.log('Generating. This can take a few minutes...');
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default', // if a safety classifier declines, the API retries on its recommended model
    system: SYSTEM,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: BANK_SCHEMA } },
    messages,
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') throw new Error('The request was declined: ' + JSON.stringify(message.stop_details));
  if (message.stop_reason === 'max_tokens') throw new Error('The answer was cut off at max_tokens. Ask for fewer questions per chapter.');
  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const bank = { book: o.book, source: path.basename(o.pdf), model: message.model, createdAt: new Date().toISOString(), ...JSON.parse(text) };

  fs.mkdirSync(o.out, { recursive: true });
  const bankPath = path.join(o.out, 'bank.json');
  fs.writeFileSync(bankPath, JSON.stringify(bank, null, 2) + '\n');
  console.log('wrote', bankPath);
  for (const f of writeOutputs(bank, o.out)) console.log('wrote', f);

  const u = message.usage;
  const cost = (u.input_tokens * PRICE.input + u.output_tokens * PRICE.output) / 1e6;
  console.log(`${bank.questions.length} questions across ${bank.chapters.length} chapters · ${u.input_tokens.toLocaleString()} in / ${u.output_tokens.toLocaleString()} out · about $${cost.toFixed(2)}${message.model !== MODEL ? ' (served by ' + message.model + ')' : ''}`);
  for (const p of checkBank(bank)) console.warn('check:', p);
}

main().catch(err => {
  if (err instanceof Anthropic.AuthenticationError) console.error('The API key was rejected. Check ANTHROPIC_API_KEY.');
  else if (err instanceof Anthropic.RateLimitError) console.error('Rate limited. Wait a minute and run it again.');
  else if (err instanceof Anthropic.APIError) console.error(`API error ${err.status}: ${err.message}`);
  else console.error(err.message);
  process.exitCode = 1;
});
