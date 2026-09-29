# Aula

A personal learning center for the Fall 2026 semester: four courses, their weekly modules and assignments, and every document and artifact filed under them. React + Vite, no server; your data lives in this browser's IndexedDB.

## Run it

```bash
npm install
npm run dev
```

On first run Aula imports `public/aula-data.json`, the semester exported from the claude.ai version on Sep 28, 2026. After that, everything you change is stored in the browser you use.

## Add it to your repo

**If the repo is new or a fresh `npm create vite` React scaffold:** copy everything here into the repo root, replacing `index.html`, `package.json` and `src/main.jsx`. Then:

```bash
npm install
npm run dev
git add .
git commit -m "Add Aula v1, ported from the claude.ai version"
git push
```

**If the repo already has an app:** copy `src/aula/`, `public/aula-data.json` and `docs/` in, add the Google Fonts `<link>` from `index.html` to yours, and render `<Aula />` from `src/aula/Aula.jsx`. Aula takes the whole page and uses hash routes (`#/`, `#/library`, `#/course/ai-410`), so it won't clash with a router that uses paths.

## Your data

- Records and uploaded files are stored per browser. Clearing site data deletes them.
- **Back up** in the rail saves every course, assignment and document as JSON. **Restore** replaces everything with a backup. Stored files are not in the backup; keep originals of any PDFs you attach.
- The claude.ai version keeps its own copy. The two don't sync, so treat this repo as the one you use from now on.

## Deploy (optional)

`npm run build` writes a static site to `dist/`. `base: './'` in `vite.config.js` lets it run from a GitHub Pages project path. Each browser that opens the deployed site starts from the seed data.

## Layout

```
docs/design.md                 the design doc, updated for React + Vite
public/aula-data.json          seed data, imported on first run
reference/aula-artifact-v1.html  the claude.ai version this was ported from
src/main.jsx                   mounts <Aula />
src/aula/Aula.jsx              root: loading, routing, drawer and toast state
src/aula/context.js            shared state hook
src/aula/lib/store.js          the only code that touches storage
src/aula/lib/model.js          constants and rules: progress, due dates, accession codes
src/aula/lib/dates.js          term calendar and date formatting
src/aula/components/           rail, rows and glyphs
src/aula/views/                Semester, Course, Library
src/aula/drawers/Drawer.jsx    document and assignment drawers, and the add forms
src/aula/aula.css              tokens and styles
```

## Next

Course chats need a small backend, because the Anthropic API key can't live in the browser. When that arrives, rewrite `src/aula/lib/store.js` to call it; the components don't change.
