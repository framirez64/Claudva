# Aula — Design Document

Exported from Claude Docs on Sep 28, 2026. The Technical architecture section, the build plan and the rule file below were updated for the React + Vite decision; the live doc on claude.ai still describes the earlier FastAPI plan.

## Thesis

Aula is a personal learning system: Canvas's structure, rebuilt for one student on one machine. It keeps courses, weekly modules, assignments and a calendar, and redraws them in a Swiss modernist register.

Its core job is tying every document to the course, week and assignment it serves, so nothing studied this semester floats loose. It launches holding the Fall 2026 semester: four courses, 12 weeks, September 28 to December 18.

## Outline

1. Context — what Aula borrows from Canvas and what it drops
2. Information architecture — the entities and how they connect
3. Screens — the views and how you move between them
4. Document tracking — accession codes, the reading ledger, storage
5. Visual language — grid, type, tokens, glyphs, prohibitions
6. Technical architecture — stack and local-first constraints
7. Seed data — the Fall 2026 semester
8. Build plan — phases and how each is checked
9. Open decisions
10. Future directions

## Context, goals and non-goals

Aula keeps Canvas's information architecture and drops everything that assumes other people are in the room.

| Canvas feature | In Aula | Note |
| --- | --- | --- |
| Dashboard course cards | Kept, as specimen plates | One color per course |
| Global navigation rail | Kept | Semester, Library, then the courses |
| Course navigation | Kept | Files becomes Documents; Grades becomes Progress |
| Modules | Kept | The primary course view, one module per week range |
| To-Do sidebar | Kept, as This Week | Next 7 days across all courses |
| Calendar | Kept, as the term ruler | 12 weeks, every due date by course |
| Grades | Renamed Progress | Self-assessed against syllabus weights |
| Inbox, Discussions, People, Announcements | Dropped | Single user |
| Quizzes, SpeedGrader, rubric editor | Dropped | Nothing to grade but your own work |

**Goals**

- Every document is reachable from its course, its week and its assignment in two clicks or fewer.
- This week, across all courses, fits on one screen.
- Every reading shows where it stands: page, status, notes.
- Every assignment records what you shipped for it: repo, report, recording or file.

**Non-goals:** accounts, sync, a native mobile app, LMS standards (LTI, SCORM), grading anyone else.

## Information architecture

Courses, weeks and assignments nest strictly; documents do not. One document can serve several weeks and several courses, which is why it sits outside the chain.

- **Term** — name, start, end, week count, light week
- **Course** — code, number, title, color token, hours per week, grading (weighted or completion)
- **Module** — course, week start and end, title, summary
- **Assignment** — course, module, due date, weight, status, self-score, deliverable link, notes; a weekly tally keeps a log instead of a due date
- **Document** — accession code, course (plus `alsoIn` for shared placements), kind, weeks, role, status, pages read and total, link, stored file, notes, reading log

| Field | Allowed values |
| --- | --- |
| Document kind | Book, Paper, Article, Notes, Dataset, Video, Repo, Artifact |
| Document status | Queued, Reading, Done, Reference |
| Placement role | Required, Optional, Reference |
| Assignment status | Not started, In progress, Submitted, Assessed |

## Screens and navigation

The shell hangs everything from a left axis, following Tschichold's case for asymmetric layout in *Die neue Typographie* (1928).

| View | Question it answers | What it shows |
| --- | --- | --- |
| Semester | What is happening across all courses this week? | Current week, the 12-week ruler of due dates, one plate per course, This Week column |
| Course · Modules | What belongs to each week? | Week sections with assignment and document rows; light and open weeks marked |
| Course · Assignments | What is due, and what is done? | Rows by due date, weight, inline status |
| Course · Documents | What is filed here? | Readings and data, then artifacts and repositories |
| Library | What am I reading, and where does it stand? | Every document, filterable by course, kind and status |
| Document drawer | Everything about one document | Fields, link, stored file, reading log, notes |
| Assignment drawer | Everything about one assignment | Status, module, due, weight, self-score, deliverable, notes |

## Document tracking

Every document gets an accession code, a home course and a reading log, so its place and its progress are never in question. This is the feature Aula exists for.

**Accession codes.** Course number, kind letter, sequence: `410-B-001` is the first book registered in AI 410. Kind letters: B book, P paper, A article, N notes, D dataset, V video, R repo, C Claude artifact. Unfiled documents use `GEN`. A document shared between courses keeps the code of the course that registered it.

**Registering.** Add a document or an artifact from any course or the Library, or drop a file onto a course's Documents tab.

**The reading log.** Each session logs a date, the page reached and an optional note. The first entry moves a document to Reading; reaching the last page moves it to Done.

## Visual language

Aula is set like a specimen catalogue: hairline rules, flush-left type, hard edges, and color used only to say which course.

**Type.** Poiret One (Regular only, bundled from `src/aula/fonts/Poiret_One`) for display and headings, Inter for body and interface text, IBM Plex Mono for accession codes, dates and every number.

**Tokens.**

| Token | Hex | Role |
| --- | --- | --- |
| ink | `#1E1C19` | Text, rules, glyphs |
| paper | `#EFE6D4` | Background |
| caracol | `#6E3F5C` | AI 410 Inference Systems |
| sky | `#3D7FA8` | AI 420 Evaluation Methods |
| brick | `#C9492E` | AI 430 Product Studio |
| ochre | `#E2A52B` | Unassigned since BUS 290 was dropped |

**Glyphs.** Bauhaus primitives drawn in ink: a square for a document, a triangle for an assignment, a circle for a repo or artifact. Fill carries status: hollow not started, half in progress, solid done, a center dot for reference.

**Course plates.** The course number large in Poiret One, an 8 px band of the course color on the left edge, then the current module, the next due item and the shelf count. The one diagonal accent on any screen is the current-week marker.

**Never:** rounded corners, drop shadows, gradients, centered page layouts, Tailwind's default palette, emoji, course colors used as decoration.

## Technical architecture

Aula is a React + Vite single-page app with no server. Records and uploaded files live in the browser's IndexedDB, behind one small storage module.

| Layer | Choice | Why |
| --- | --- | --- |
| UI | React 19, plain function components | Your repo's stack |
| Build | Vite | Fast dev server, static build for GitHub Pages |
| Data | IndexedDB via `src/aula/lib/store.js` | Local-first, no account, works offline |
| Files | Blobs in IndexedDB | PDFs open in a new tab from the app |
| Styling | Plain CSS, tokens as custom properties | Nothing inherits a framework's defaults |
| Routing | Hash routes (`#/`, `#/library`, `#/course/ai-410`) | Works on any static host |

`store.js` is the only file that knows where data lives. It exposes `subscribe`, `set`, `update`, `remove` and `files.put/url/remove`. Swapping to a FastAPI backend later means rewriting that one module; course chats will need that backend anyway, because the Anthropic API key can't live in the browser.

On first run the app imports `public/aula-data.json`, the semester exported from the claude.ai version. Back up and restore records as JSON from the rail.

## Seed data: Fall 2026

The term runs 2026-09-28 to 2026-12-18 in 12 weeks starting Mondays; week 9 (Nov 23–29, Thanksgiving) is a light week with nothing due. Assignments are due Sundays, and finals on Friday 2026-12-18. The full records are in `public/aula-data.json`.

BUS 290 Consulting Practicum was dropped on 2026-09-28 to focus on the technical courses; each course page ends with a Remove course action. The seed still contains BUS 290, so a fresh import brings it back.

## Build plan

1. **Port.** Done: every v1 view runs in React on IndexedDB. Check: `npm run dev`, then every document is two clicks or fewer from its course, week and assignment.
2. **A week of daily use.** Run the semester in it for a week, then list every friction point for a fix pass.
3. **Calendar and Progress views.** Check: weighted totals match the syllabus weights.
4. **Backend and course chats.** FastAPI behind `store.js`, then one chat per course grounded in that course's documents.

## Open decisions

| Decision | Call | Status |
| --- | --- | --- |
| Name | Aula | Open |
| Stack | React and Vite | Decided |
| File storage | Blobs in IndexedDB for now; managed folders when the backend lands | Open |
| Course colors | 410 caracol, 420 sky, 430 brick; ochre unassigned | Open |
| Glyph color | Ink only | Open |
| Progress | Self-assessed, weighted scores | Open |
| Practicum grading | Completion, no weights | Dropped with BUS 290 |
| Due day | Sundays; finals Friday, December 18 | Open |
| Phone layout | Full editing, desktop-first layout | Open |

## Future directions

- **Course chats.** One conversation per course, grounded in its documents and notes.
- **Search inside documents.** Plug Tagger in as Aula's search engine.
- **Spring 2027 term.** The taste-repository project becomes the flagship studio course.
- **Semester transcript.** Export what you read, built and shipped as a portfolio page.
