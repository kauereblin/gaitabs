# GEMINI.md — Repository Rules for Gaitabs (Harmonica Hub)

## Source of Truth
- Always read and keep [docs/SPEC.md](docs/SPEC.md) updated **before** or alongside any behavioral or architectural change.
- Follow [docs/PLAN.md](docs/PLAN.md) for phased execution and verification gates.

## Architecture & Module Boundaries
- Single flat Bun + Vite + React 19 + TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`) SPA:
  - `src/schema/` — Pure TS + Zod canonical `SongDocument` (`ppq: 480`), `TuningTable`, Golden Fixture. **Zero internal imports.**
  - `src/parser/` — Plain-text / Markdown harmonica tab importer & exporter. May import `src/schema/` only.
  - `src/dsp/` — Pure TS zero-allocation free-reed synthesizer (`renderBlock()`), sample-accurate `sequencer.ts`, self-contained `worklet.ts`, and `bridge.ts`. **NEVER import React, Zustand, or `zod` runtime code inside `src/dsp/worklet.ts`.**
  - `src/storage/` — Postgres-ready `SongRepository` contract, `IndexedDbSongRepository` (`idb`), and `.gaitab.json` / `#tab=` URL portability. May import `src/schema/` only.
  - `src/ui/` — React + Zustand UI (`SideMenu`, `TransportBar`, `NotePillEditor`, `HarmonicaComb`, `SmartPasteModal`, `LibraryDrawer`) and flat CSS (`app.css`). Print Sheet / `print.css` is intentionally removed.

## Non-Negotiable Rules
1. **Integer Rational Timing:** Always store note/lyric offsets and durations as integer ticks at `PPQ = 480`. Never store float beats, seconds, or baked Hz in `SongDocument`.
2. **Zero Allocations in Audio Thread:** Never allocate arrays/objects inside `renderBlock()`, `renderBlockRange()`, or `AudioWorkletProcessor.process()`.
3. **Sample-Accurate Sequencer Only:** Never schedule audio notes with `setInterval` or React timers. Caret seeks (`action: 'seek'`) and end-of-song resets (`currentTick = 0`) live in `src/dsp/sequencer.ts`.
4. **Idempotent Reload Persistence:** Remember the last opened song ID, clear `#tab=` hashes after import, and guard hydration against React `StrictMode` double-invocation so reloading never creates duplicate songs.
5. **Symbol-First UI Rule:** Place clear symbols before words on key action buttons (`▶ Play`, `❚❚ Pause`, `■ Stop`, `● Record`, `↻ Loop`, `⧉`, `＋ Bar`, `✕`), and **never re-add symbols/emojis that the user intentionally removed** (e.g., `Delete Note`, `Done`).
6. **Flat Solid Primary Buttons:** Never transition CSS `linear-gradient` on primary buttons; use flat solid color tokens to avoid hover flicker.
7. **Centered Main Column, Side Menu & Fixed Bottom Comb:** Use normal full-page scrolling (NEVER put vertical scroll inside `.bars-scroll`). Center `.main-column`, place `.side-menu` (`288px` desktop, slide-in drawer `<= 900px`) on the left with generous spacing and strictly inline `.side-tick-meter`, and keep `.comb-section` `position: fixed; bottom: 0;` (aligned with `.main-column` on desktop, full-width `<= 900px`). Ensure mobile (`<= 768px`) fits all 10 comb holes side-by-side with zero horizontal scrollbars inside components.
8. **Floating Note Inspector Card:** Render the `Selected Note Inspector` as a floating mini-menu card positioned aside the selected note with comfortable `13px` typography, an always-visible 1–10 Holes/Chord segmented selector (no Hole combobox), and `Delete Note` + `Done` aligned to the right.

## Verification Commands
Run all gates before finishing any change:
```powershell
bun test src
bun run typecheck
bun run build
bun run test:e2e
```
