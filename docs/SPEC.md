# SPEC.md — Harmonica Hub (`gaitabs`)

> **Status:** v1.1 Specification (Spec-Driven Design Contract)  
> **Workflow:** Spec → Plan (`docs/PLAN.md`) → Slice Implementation → Verification Gate → Diff Audit against `SPEC.md`

---

## 1. Mission & Success Criteria

Build **Harmonica Hub (`gaitabs`)**, a local-first web application for creating, timing, organizing, and playing harmonica tablature with lyrics and an interactive 10-hole harmonica simulator.

**Measurable v1 Success Criteria:**
1. **30-Second First Note:** A visitor hears accurate harmonica audio within 1 click/keystroke—no login, no mic permission prompt, no audio-unlock dead-end.
2. **Rhythm Clarity:** Non-music-readers visually distinguish note durations, rests, bar boundaries, and bends via proportional **Karaoke Note-Pills** synced to a moving playhead.
3. **5-Minute Authoring:** A user can paste plain-text tabs, live-record notes directly from the comb like a DAW, drag/resize notes & bars, transpose harp keys, and autosave without losing work or creating duplicate songs on refresh.
4. **Production Parity:** AudioWorklet bundling and playback pass identically in `vite dev` and `vite build` + `vite preview`.

---

## 2. Explicit Non-Goals & Forbidden Patterns (v1)

**Out of Scope for v1:**
- **No Rust / WASM engine** in v1 (keep behind `SynthEngine` interface for optional v2 swap).
- **No `SharedArrayBuffer`** and no required `COOP`/`COEP` server headers.
- **No backend runtime, auth, or pre-built multi-song catalog** (only the Golden Song Fixture is bundled for testing; user builds the catalog iteratively).
- **No live microphone pitch-tuner**, no WebMIDI, no MusicXML/ABC importers, no Print Sheet / PDF export.

**Forbidden Patterns (Automated Review Rejections):**
- NEVER store audio playback timing as floating-point beats or seconds (use integer `ppq: 480` ticks).
- NEVER bake `Hz` or transposed pitches into saved `SongDocument` files (store hole + breath action + bend steps + declared `harpKey`/`tuning`).
- NEVER import React, Zustand, or `zod` inside the `AudioWorkletProcessor` bundle.
- NEVER allocate heap arrays/objects inside `AudioWorkletProcessor.process()` or `renderBlock()`.
- NEVER drive note-on/note-off scheduling from `setInterval` or React state timers (sequence by sample index inside the AudioWorklet).
- NEVER create duplicate songs in IndexedDB on page reload (including under React `StrictMode` double-mount or after `#tab=` URL import).
- NEVER use CSS `linear-gradient` transitions on primary buttons (use flat solid color tokens to prevent hover flicker).

---

## 3. Tech Stack & Module Boundaries

Single flat SPA (no multi-package monorepo overhead in v1):
- **Runtime & Build:** Bun, Vite, React 19, TypeScript (`strict: true`).
- **State & Validation:** Zustand (UI state), Zod (schema validation & import guards).
- **Persistence & Sharing:** IndexedDB via `idb`, URL-hash compression via `lz-string`.

```text
src/
├── schema/    # Pure TS + Zod: SongDocument v1, PPQ math, TuningTable, Golden Fixture
├── parser/    # Pure TS: plain-text/Markdown tab importer & exporter
├── dsp/       # Pure TS: renderBlock() reed synth, in-worklet sequencer, AudioWorklet entry
├── storage/   # SongRepository interface, IndexedDbSongRepository, URL-hash codec
└── ui/        # React + Zustand: SideMenu (Transport + Editor tools), Note-Pill editor, Comb simulator, library drawer
```

**Dependency Rule:** `schema` has zero internal dependencies; `parser`, `dsp`, `storage` may depend on `schema`; only `ui` may import React/Zustand.

---

## 4. Canonical Data Model (`gaitabs.v1`) & Invariants

All songs are stored and exchanged as versioned JSON (`*.gaitab.json`). **Notes and lyrics are decoupled** inside bar-local containers so melismas (one syllable spanning multiple notes), instrumental intros, and mid-song bar edits do not corrupt downstream alignment.

```ts
export const PPQ = 480 as const;

export type HarpKey = 'C' | 'G' | 'A' | 'D' | 'F' | 'Bb' | 'Eb' | 'E' | 'Ab' | 'Db' | 'F#' | 'B';
export type TuningId = 'richter';
export type BreathAction = 'blow' | 'draw' | 'overblow' | 'overdraw';
export type BendSteps = 0 | 1 | 2 | 3;
export type Articulation = 'slur' | 'vibrato' | 'trill' | 'wah';

export interface HarmonicaNote {
  id: string;
  offsetTick: number;      // >= 0, relative to parent Bar start
  durationTicks: number;   // > 0, integer ticks at PPQ = 480
  holes: number[];         // 1..10, non-empty (length > 1 = chord/split)
  action: BreathAction;
  bendSteps: BendSteps;    // clamped per hole & action by TuningTable
  bendCents?: number;      // optional microtonal fine-tune (-50..+50)
  articulation?: Articulation;
}

export interface LyricSpan {
  id: string;
  offsetTick: number;      // >= 0, relative to parent Bar start
  durationTicks: number;   // > 0
  text: string;
  joinNext?: boolean;      // hyphenated syllable continuation (e.g. "won-")
}

export interface Bar {
  id: string;
  index: number;           // 0-based sequential
  durationTicks: number;   // e.g. 1920 for 4/4 at PPQ=480; user-shrinkable & stretchable
  notes: HarmonicaNote[];
  lyrics: LyricSpan[];
}

export interface SongDocument {
  id: string;              // UUID v4 (primary key for IndexedDB & future Postgres)
  schemaVersion: 1;
  revision: number;        // monotonic integer >= 1 for optimistic concurrency / v2 sync
  createdAt: string;       // ISO-8601 UTC
  updatedAt: string;       // ISO-8601 UTC
  deletedAt?: string | null;
  title: string;
  artist?: string;
  instrument: {
    tuning: TuningId;
    harpKey: HarpKey;
  };
  timingMode: 'unmeasured' | 'measured';
  bpm: number;             // 30..260
  swingPercent: number;    // 50 (straight) .. 75 (heavy swing)
  timeSignature: { numerator: number; denominator: 2 | 4 | 8 };
  bars: Bar[];
}
```

### Hard Domain Invariants
1. **Richter Bend Clamping (`TuningTable`):**
   - Draw bends allowed: Hole 1 (`1`), Hole 2 (`2`), Hole 3 (`3`), Hole 4 (`1`), Hole 6 (`1`).
   - Blow bends allowed: Hole 8 (`1`), Hole 9 (`1`), Hole 10 (`2`).
   - All other `(hole, action)` pairs clamp `bendSteps` to `0`.
2. **Pure Pitch Derivation:** `resolveNoteFrequencies(note, tuning, harpKey): number[]` is a pure function. Changing `instrument.harpKey` transposes audio without mutating `bars`.
3. **Bar-Local Timing & Shrinking:** `note.offsetTick >= 0`, integer `note.durationTicks > 0`. Bars grow when a note overflows, shrink back when a previously stretched trailing note shrinks, and support explicit user stretch/shrink/fit controls so no dead silence trails into the next bar.

---

## 5. Plain-Text Importer/Exporter (`src/parser`) & Golden Fixture

Plain text is a **projection**, not the canonical store. Legacy lyric-aligned tabs import into `timingMode: 'unmeasured'` with deterministic placeholder ticks (`480` per token).

**Token Grammar:**
- Blow: `4` or `+4`; Draw: `-4`; Bends: `-3'`, `-3''`, `-3'''`, `10''`; Overblow/Overdraw: `6ob`, `-7od`; Chords: `34`, `(34)`, `(4 5)`, `-3-4`.

### Golden Song Fixture (`What a Wonderful World` — Opening Phrase)
Lives in `src/schema/golden.ts` and passes parser + round-trip + playback tests:

```text
3 -3    4   4    6    -6  -6 -6  6
I see trees of green, red roses too
-5 6   -5    5   -4  -4 -4   4
I see them bloom for me and you
```

---

## 6. DSP & `AudioWorklet` Contract (`src/dsp`)

Keep `chimera-vocal-synth`'s clean UI-vs-Worklet boundary, implemented in **Pure TypeScript** behind a swappable `SynthEngine` interface:

- **Synthesis Model (v1):** Band-limited wavetable/additive free-reed voices, filtered breath-noise onset transient, smooth pitch-bend glide, dynamic biquad formant + hand-cupping ("wah") filter, and `tanh` soft clipper.
- **Sample-Accurate Sequencer & Caret Lifecycle:**
  - Lives inside `AudioWorkletProcessor`, advancing by `sampleFrame`.
  - **Natural Breath & Articulation Phrasing:** Keeps `SongDocument` notes juxtaposed while shortening non-slurred note releases slightly before the next event (`~22%` on blow↔draw reversals, `~16%` on repeated-hole tongue re-attacks, `~10%` on same-breath hole slides; `slur` stays full legato) paired with a gentle reed attack bloom and musical velocity contour.
  - **End-of-Song Reset:** When non-looped playback reaches `totalTicks`, the sequencer stops and automatically resets `currentTick` to `0` so pressing `▶ Play` again starts immediately without requiring `■ Stop`.
  - **Paused Seek:** Supports `action: 'seek'` so clicking any position in a bar while paused immediately moves and persists the worklet's `currentTick` caret.
  - **DAW Record Clock:** Supports `action: 'record'` (unbounded sample-accurate beat clock + optional metronome clicks) so users can tap notes on the comb/keyboard and create timed bars in real time.

```ts
export type WorkletInMsg =
  | { type: 'noteOn'; voiceId: number; freqHz: number; velocity: number; wah: number; hole?: number }
  | { type: 'notePitch'; voiceId: number; freqHz: number }
  | { type: 'noteOff'; voiceId: number }
  | { type: 'setWah'; wah: number }
  | { type: 'panic' }
  | { type: 'loadScore'; events: ScheduledReedEvent[]; bpm: number; swingPercent: number; totalTicks: number }
  | { type: 'transport'; action: 'play' | 'pause' | 'stop' | 'seek' | 'record'; startTick?: number; speed?: number; loop?: { startTick: number; endTick: number } | null; countIn?: boolean; metronome?: boolean };
```

---

## 7. Persistence & Postgres-Ready Repository (`src/storage`)

v1 persists locally in **IndexedDB (`idb`)** behind `SongRepository` (`list`, `get`, `save`, `remove`) matching a future PostgreSQL `songs (id UUID PRIMARY KEY, revision INT, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, doc JSONB)` table 1:1.

- **Reload & Session Hydration Contract:**
  - Hydration is strictly idempotent (guarded against React `StrictMode` double-invocation).
  - Persist `lastOpenedSongId` in `localStorage`; on reload, restore the previously opened song (falling back to most recently updated). Never auto-create a new song if one already exists in the library.
  - After decoding a `#tab=` share URL, clear the hash (`history.replaceState`) so subsequent reloads do not re-import duplicates.

---

## 8. Tab Authoring, Simulator UX & UI Rules (`src/ui`)

1. **Symbol-First UI Rule:** Keep clear symbols before words on transport/primary buttons (`▶ Play`, `❚❚ Pause`, `■ Stop`, `● Record`, `↻ Loop`, `⧉`, `＋ Bar`, `＋ Note`, `✕`, etc.) while respecting any symbols intentionally trimmed by the user.
2. **Flat Solid Primary Controls & Centered Main-Column Shell:** Primary buttons use flat solid color fills with smooth `background-color` hover transitions (no gradients, no hover blink). The app uses normal **document/page scroll** (no inner vertical scroll container on `.bars-scroll`). A widened sticky left **Side Menu** (`.side-menu`, `288px`) houses **Playback Transport** (`.transport-bar`, with strictly inline `side-tick-meter`) and **Editor Tools** (`.editor-toolbar`) on desktop, collapsing into a slide-in drawer on mobile (`<= 900px`), while `.main-column` stays centered on the page. The 10-hole comb (`.comb-section`) is **fixed at the bottom** (`position: fixed; bottom: 0`), aligned with `.main-column` on desktop and full-width on mobile (`<= 900px`). On mobile (`<= 768px`), all 10 comb holes fit side-by-side (`repeat(10, minmax(0, 1fr))`) with zero horizontal scrollbars inside components.
3. **Audio Unlock & 10-Hole Comb:** Unlock synchronously on first click; pointer/touch drag up = blow, down = draw, horizontal = glissando, deep vertical = per-hole clamped bend + live bend meter; toggleable Two-Row (`1–0`/`Q–P` + bend keys) and Breath-Switch (`1–0` + `Space` draw) keyboard modes.
4. **Karaoke Note-Pill Editor:**
   - Click anywhere on a bar track (paused or playing) to move the caret to that exact tick; page scroll smoothly follows the moving caret during playback/recording so the active bar stays visible above the fixed bottom comb.
   - Each note pill displays both its hole token (`4`, `-3''`) and dynamic musical note caption (`C`, `D`, `Eb`, `G`, `A`, `B`, updating live with `harpKey`).
   - **Draggable Notes & Intra-Bar Lyrics:** Drag note pills horizontally within a bar or vertically across bars; drag right edge to resize duration. Drag lyric spans horizontally between beats strictly clamped inside their parent bar (click without dragging edits text inline).
   - **Floating Selected Note Inspector Card:** Renders as a floating mini-menu popover anchored aside the selected note with comfortable `13px` typography, an **always-visible 1–10 Holes/Chord multi-select bar** (no Hole combobox), Action/Bend/Articulation/Offset/Duration controls, and `Delete Note` + `Done` aligned to the right.
   - **Bar Controls:** Duplicate bar (`⧉`), drag bar handle (`⠿`) to reorder bars, and stretch/shrink/auto-fit bar length (`−` / `+` beats, `↔ Fit`, and right-edge bar resize handle).
5. **DAW Live-Record Mode (`● Record`):** Plays a live beat clock/metronome; tapping holes on the comb or keyboard records timed notes (onset + duration + bend) and automatically appends bars as playback advances.

---

## 9. Phased Milestones & Verification Matrix

| Phase | Scope | Automated Verification Gate |
|---|---|---|
| **P0 — Schema & Parser** | `src/schema`, `src/parser`, Golden Fixture | `bun test src/schema src/parser && bun run typecheck` |
| **P1 — DSP & Comb Simulator** | `src/dsp`, `renderBlock()`, Worklet, 10-hole Comb UI | `bun test src/dsp && bun run typecheck` |
| **P2 — Note-Pill Editor, DAW Record & Sync** | Sequencer seek/reset/record, draggable notes/bars, bar stretch/shrink, inline inspector | `bun run build && bun run test:e2e` |
| **P3 — Storage & Portability** | Idempotent `IndexedDbSongRepository`, `.gaitab.json`, MD export, `#tab=` URL | `bun test src && bun run build && bun run test:e2e` |
