# CLAUDE.md — Aula

- Read `docs/design.md` before changing behavior or layout. Build only what the current task asks for.
- Stack: React 19 function components, Vite, plain CSS in `src/aula/aula.css`. No Tailwind, no UI or state libraries without asking first.
- All reads and writes go through `src/aula/lib/store.js`. Components never touch IndexedDB, fetch or localStorage for records directly.
- Business rules (progress, due text, accession codes, fills) live in `src/aula/lib/model.js`. Keep components thin.
- Visual rules: `border-radius: 0`, no box-shadow, no gradients, no centered page layouts. Colors come only from the tokens at the top of `aula.css`. A course color marks identity, never decoration. Accession codes, dates and numbers are set in IBM Plex Mono.
- Every color token has light and dark values; check both themes.
- Don't edit `public/aula-data.json` to change live data; it is only the first-run seed.
- After any UI change, run `npm run build`, then check the page at 1440 px and 390 px wide, light and dark, before reporting done.
- Commit at the end of each working session with a message that names what changed.
