# PLAN.md — Harmonica Hub (`gaitabs`) Implementation Plan

> **Derived strictly from:** [SPEC.md](SPEC.md)  
> **Execution Rule:** Complete one phase (`P0` → `P3`) at a time. Do not advance until all verification commands in the current phase pass and the diff is audited against `SPEC.md` Non-Goals and Forbidden Patterns.

---

## Pre-Flight: Project Bootstrap (Start of P0)

- [x] **P0.0 — Initialize Bun + Vite + React + TypeScript Workspace**
  - Create `package.json` with scripts: `dev`, `build`, `preview`, `test`, `typecheck`, `test:e2e`.
  - Dependencies: `react`, `react-dom`, `zustand`, `zod`, `idb`, `lz-string`.
  - DevDependencies: `typescript`, `vite`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`, `@types/bun`, `playwright` (or `playwright-core`).
  - Create `tsconfig.json` (`strict: true`, `noUncheckedIndexedAccess: true`, `isolatedModules: true`), `vite.config.ts`, `index.html`, and minimal `src/main.tsx` placeholder.

---

## Phase P0 — Schema, Tuning, Golden Fixture & Plain-Text Parser

**Boundary:** `src/schema/` (zero internal imports) and `src/parser/` (imports `src/schema/` only).

- [x] **P0.1 — Canonical Data Model & Zod Schemas (`src/schema/song.ts`)**
  - Implement `PPQ = 480`, `HarpKey`, `TuningId`, `BreathAction`, `BendSteps`, `Articulation`, `HarmonicaNote`, `LyricSpan`, `Bar`, and `SongDocument` (`schemaVersion: 1`, `revision`, `createdAt`, `updatedAt`, `deletedAt?`).
  - Enforce integer `offsetTick >= 0`, integer `durationTicks > 0`, `holes` non-empty subset of `1..10`, `bpm` (`30..260`), `swingPercent` (`50..75`).
  - Export `createEmptySong()` and `ticksToSeconds(ticks, bpm)` / `barAbsoluteStartTick(bars, barIndex)` pure helpers.

- [x] **P0.2 — Richter Tuning Table & Bend Clamping (`src/schema/tuning.ts`)**
  - Implement Richter interval layout for holes `1..10` (`blow`, `draw`, `overblow`, `overdraw`) and semitone offsets for all 12 `HarpKey` values.
  - Implement `maxBendSteps(tuning, hole, action)` invariant:
    - Draw bends: Hole 1 (`1`), Hole 2 (`2`), Hole 3 (`3`), Hole 4 (`1`), Hole 6 (`1`).
    - Blow bends: Hole 8 (`1`), Hole 9 (`1`), Hole 10 (`2`).
    - All others clamp to `0`.
  - Implement pure `clampBendSteps()` and `resolveNoteFrequencies(note, tuning, harpKey): number[]` (`A4 = 440 Hz`).

- [x] **P0.3 — Golden Song Fixture (`src/schema/golden.ts`)**
  - Export `WONDERFUL_WORLD_TEXT` (the 4-line opening phrase from `SPEC.md` §5).
  - Export `WONDERFUL_WORLD_GOLDEN_DOC` (`timingMode: 'unmeasured'`, `harpKey: 'C'`, `tuning: 'richter'`, Bar 0 with 9 notes + lyrics, Bar 1 with 8 notes + lyrics).

- [x] **P0.4 — Plain-Text / Markdown Tab Importer & Exporter (`src/parser/textTab.ts`)**
  - Parse tokens: blow (`4`, `+4`), draw (`-4`), bends (`-3'`, `-3''`, `-3'''`, `10''`), overblow/overdraw (`6ob`, `-7od`), chords (`34`, `(34)`, `-3-4`).
  - Pair tab-token lines with the following lyric line by column alignment into `Bar` (`notes[]` + `lyrics[]`, `timingMode: 'unmeasured'`, `480` ticks/slot default), preserving hyphenated continuation (`joinNext`).
  - Export `SongDocument` back to clean plain-text/Markdown tab lines (lossy projection without timing metadata).

- [x] **P0.5 — P0 Unit Tests & Gate**
  - Add `src/schema/schema.test.ts` (Zod validation, invalid tick/hole rejection, Richter bend clamping, `C` → `G` key transposition math, `resolveNoteFrequencies` accuracy).
  - Add `src/parser/textTab.test.ts` (token edge cases, chord tokens, hyphenated syllables, `WONDERFUL_WORLD_TEXT` → matches `WONDERFUL_WORLD_GOLDEN_DOC` structure).
  - **Gate:** `bun test src/schema src/parser && bun run typecheck`

---

## Phase P1 — Pure TS DSP Engine, `AudioWorklet` & 10-Hole Comb Simulator

**Boundary:** `src/dsp/` (zero React/Zustand/Zod runtime imports; pure `renderBlock()` separated from browser `AudioWorklet` shell).

- [x] **P1.1 — DSP Types & `SynthEngine` Contract (`src/dsp/types.ts`)**
  - Define `ScheduledReedEvent`, `WorkletInMsg`, `WorkletTelemetry`, and `SynthEngine` interface (`start`, `noteOn`, `notePitch`, `noteOff`, `loadScore`, `transport`, `subscribeTelemetry`, `dispose`).

- [x] **P1.2 — Pure TS Free-Reed Synthesizer (`src/dsp/engine.ts`)**
  - Implement pre-allocated voice pool (polyphony >= 8, zero heap allocations inside `renderBlock()`).
  - Per voice: band-limited wavetable/additive harmonic reed oscillator (asymmetric free-reed spectrum, stable up to hole 10 / high keys), filtered breath-noise onset transient, smooth per-sample pitch ramp for bends/glissandos, dynamic biquad formant + hand-cupping ("wah") filter, and soft-clip output limiter (`|sample| <= 1.0`).
  - Implement `renderBlock(out: Float32Array, sampleRate: number, state: EngineState)` pure function with block-size independence and NaN/Inf guards.

- [x] **P1.3 — In-Worklet Sample-Accurate Sequencer (`src/dsp/sequencer.ts`)**
  - Advance score playback by `sampleFrame` counter (never main-thread `setInterval`).
  - Support `speed` (`0.5`, `0.75`, `1.0`), 4-beat count-in, swing timing (`swingPercent`), and `loop` (`{ startTick, endTick }`).

- [x] **P1.4 — `AudioWorkletProcessor` & Main-Thread Bridge (`src/dsp/worklet.ts`, `src/dsp/bridge.ts`)**
  - `worklet.ts`: self-contained processor (zero UI/Zod imports) processing `WorkletInMsg`, running `sequencer` + `renderBlock()`, emitting `WorkletTelemetry` at ~60 Hz (`cpuLoad`, `peakLevel`, `currentTick`, `activeHoles`).
  - `bridge.ts`: manages `AudioContext`, Vite-safe worklet URL loading (`?worker&url` or `new URL('./worklet.ts', import.meta.url)`), synchronous first-interaction `AudioContext.resume()`, and telemetry subscription.

- [x] **P1.5 — Interactive 10-Hole Comb UI (`src/ui/components/HarmonicaComb.tsx`, `src/ui/state/useAudioStore.ts`)**
  - Audio unlock banner/overlay (*"Click any hole or press Play to wake the harp"*) whose first click unlocks audio and sounds the clicked hole.
  - Pointer/touch comb: drag up = blow, drag down = draw, horizontal slide = glissando, deep vertical drag on bendable holes = continuous bend clamped by `maxBendSteps` with live bend meter (`-3'`, `-3''`, `-3'''`).
  - Toggleable keyboard modes: Two-Row (`1–0` blow, `Q–P` draw, `ArrowDown`/`Z`/`X` bend) and Breath-Switch (`1–0` hole select, hold `Space` = draw).

- [x] **P1.6 — P1 Unit Tests & Gate**
  - Add `src/dsp/engine.test.ts`: test `renderBlock()` for finiteness (`Number.isFinite`), bounded output (`|s| <= 1.0`), block-size independence (64 vs 128 vs 1024 samples), silence when idle, and fundamental frequency detection (zero-crossing/autocorrelation/DFT) within `±5 cents` of `resolveNoteFrequencies()` including bends and hole 10 blow.
  - Add `src/dsp/sequencer.test.ts`: test count-in, `0.5x` speed, swing offset, and A-B loop wraparound.
  - **Gate:** `bun test src/schema src/parser src/dsp && bun run typecheck`

---

## Phase P2 — Karaoke Note-Pill Editor, Smart Paste & Playback Sync

**Boundary:** `src/ui/` (Zustand store + React editor/player views) wired to `src/dsp` and `src/parser`.

- [x] **P2.1 — Editor & Transport Zustand Store (`src/ui/state/useSongStore.ts`)**
  - Hold active `SongDocument`, undo/redo history stack (or bar-level snapshots), selected note/bar, `timingMode`, and playback controls (`play`, `pause`, `stop`, `seekTick`, `speed`, `loopRange`, `harpKey`).
  - Pure actions for bar-local edits: `insertNote`, `resizeNoteDuration`, `updateNoteActionBend`, `splitOrEditLyric`, `transposeHarpKey`, `applyStepTapTimestamps`.

- [x] **P2.2 — Karaoke Note-Pill Timeline & Editor (`src/ui/components/NotePillEditor.tsx`)**
  - Render bars with vertical dividers and soft beat lines; render `HarmonicaNote` pills (`width ∝ durationTicks`, gaps = rests) directly above `LyricSpan` track.
  - Drag right edge of a pill to resize `durationTicks` (snapping to grid divisions when snap is enabled); click pill to edit hole/blow/draw/bend; edit lyric spans independently (supporting melismas and `joinNext`).
  - Live playhead driven by `WorkletTelemetry.currentTick` via `requestAnimationFrame` interpolation.

- [x] **P2.3 — Smart Paste & Half-Speed Step-Tap Authoring (`src/ui/components/SmartPasteModal.tsx`, `src/ui/hooks/useStepTap.ts`)**
  - Smart Paste modal: paste plain-text tabs (`WONDERFUL_WORLD_TEXT`) → parse via `src/parser/textTab.ts` → load into Note-Pill editor.
  - Step-Tap mode: press `Space` sequentially at `0.5x` or `1x` speed against metronome clicks to stamp `offsetTick` and `durationTicks` onto sequential notes, with optional beat-grid snap and `swingPercent` toggle, switching song to `timingMode: 'measured'`.

- [x] **P2.4 — Practice & Transport Bar (`src/ui/components/TransportBar.tsx`)**
  - Play / Pause / Stop, `0.5x / 0.75x / 1x` speed selector, 4-beat count-in toggle, A-B loop range selector, 1-click `HarpKey` switcher (`C`, `G`, `A`, `D`, `F`, etc.), and live comb highlight sync during playback.

- [x] **P2.5 — P2 Production-Build & E2E Gate**
  - Configure Playwright test (`tests/e2e/playback.spec.ts`) running against `bun run build && bun run preview` (critical to verify `AudioWorklet` bundling in production mode).
  - Verify: (1) 1-click audio unlock transitions `AudioContext` to running, (2) Smart Paste of `WONDERFUL_WORLD_TEXT` renders Bar 0 & Bar 1 pills/lyrics, (3) Play advances telemetry playhead, (4) `0.5x` speed and A-B loop wrap cleanly.
  - **Gate:** `bun test && bun run typecheck && bun run build && bun run test:e2e`

---

## Phase P3 — Postgres-Ready IndexedDB Persistence, Sharing & Print Sheet

**Boundary:** `src/storage/` + `src/ui/` Library Drawer & Print CSS.

- [x] **P3.1 — `SongRepository` Contract & `IndexedDbSongRepository` (`src/storage/repository.ts`, `src/storage/indexedDbRepo.ts`)**
  - Define `SongSummary` and `SongRepository` (`list`, `get`, `save`, `remove`) matching `SPEC.md` §7.
  - Implement `IndexedDbSongRepository` using `idb` (`dbName: 'gaitabs-v1'`, store `songs` keyed by `id`, indexes `updatedAt`, `title`, `harpKey`).
  - On `save(doc)`: validate via Zod `SongDocumentSchema`, enforce optimistic `revision` increment and UTC `updatedAt` timestamp so a v2 PostgreSQL `JSONB` sync adapter swaps in cleanly.

- [x] **P3.2 — Autosave, Library Drawer & Golden Fixture Loader (`src/ui/components/LibraryDrawer.tsx`)**
  - Debounced autosave (e.g., 400 ms) of active draft to `IndexedDbSongRepository` with visible `"Saved locally"` status indicator.
  - Library Drawer: search/filter by `harpKey` and `timingMode`, New Song, Delete, Duplicate, and a **"Load Golden Fixture"** action for testing without a pre-built catalog.

- [x] **P3.3 — Portability: `.gaitab.json`, Markdown Export, `#tab=` URL Codec & Print CSS (`src/storage/portability.ts`, `src/ui/styles/print.css`)**
  - Export/Import `.gaitab.json` validated strictly through Zod (reject malformed versions with clear UI toast).
  - Export plain-text/Markdown tab sheet to clipboard/file.
  - URL-hash sharing (`#tab=<lz-string>`) with size warning if URL exceeds safe browser limits (~8 KB compressed).
  - `@media print` stylesheet rendering a high-contrast black-on-white lyric + note-pill sheet with page-break safety.

- [x] **P3.4 — P3 Verification & Final Spec Audit Gate**
  - Add `src/storage/storage.test.ts`: repository CRUD, optimistic `revision` bump, Zod rejection on corrupt import, `#tab=` `lz-string` encode/decode round-trip.
  - Extend Playwright E2E (`tests/e2e/persistence.spec.ts`): create/paste song → reload page → assert draft restored from IndexedDB → export/re-import `.gaitab.json` → open `#tab=` share URL.
  - **Final Gate:** `bun test && bun run typecheck && bun run build && bun run test:e2e`
  - **Final Audit:** Diff all changed files against `docs/SPEC.md` §2 (*Non-Goals & Forbidden Patterns*).
