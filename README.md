# gaitabs — Harmonica Hub

A local-first web application for creating, timing, organizing, and playing 10-hole diatonic harmonica tablature with synchronized lyrics and an interactive real-time harmonica synthesizer.

## Features

- **Interactive 10-Hole Richter Harmonica Simulator:** Pure TypeScript `AudioWorklet` synthesizer using 11-level band-limited free-reed wavetable mipmaps, filtered breath-noise onset transients, per-hole clamped pitch bends, and hand-cupping ("wah") formant filtering. Playable via pointer/touch (drag up = blow, down = draw, horizontal glissando, deep vertical bend) or keyboard (**Two-Row** and **Breath-Switch** modes).
- **Karaoke Note-Pill Editor:** Visual rhythm-synced note pills above decoupled lyric spans (supporting melismas, instrumental bars, bar duplication, drag-and-drop note movement within and across bars, drag-and-drop bar reordering, bar stretch/shrink/fit, and inline note inspection).
- **DAW Live-Record Mode (`● Record`):** Tap holes on the harmonica comb or keyboard against a live beat clock/metronome to record timed notes and auto-generate bars in real time.
- **Smart Paste & Step-Tap:** Paste classic lyric-aligned text tabs (`3 -3 4 4 / I see trees of green`) and progressively enrich them with rhythm via pill dragging or half-speed Spacebar Step-Tap.
- **Local-First Storage:** Autosaves drafts to IndexedDB (`idb`) behind a `SongRepository` contract, plus `.gaitab.json` export/import, Markdown tab copy, and `#tab=` URL-hash sharing (`lz-string`).

## Getting Started

Requires [Bun](https://bun.sh/).

```sh
bun install
bun run dev        # Vite dev server on http://127.0.0.1:5173
```

### Verification & Build

```sh
bun test src       # Unit tests (schema, parser, DSP pitch/determinism, sequencer, storage)
bun run typecheck  # TypeScript strict check (tsc --noEmit)
bun run build      # Production build (dist/ + standalone AudioWorklet bundle)
bun run test:e2e   # Playwright E2E suite against vite preview
```

## Documentation

- [docs/SPEC.md](docs/SPEC.md) — Canonical v1.1 Spec-Driven Design contract, data schema, DSP protocol, and UI rules.
- [docs/PLAN.md](docs/PLAN.md) — Phased implementation plan and verification gates.
- [docs/GITHUB_PAGES.md](docs/GITHUB_PAGES.md) — Step-by-step guide to deploy GaiTabs to GitHub Pages.
- [GEMINI.md](GEMINI.md) — Repository guidelines and invariants for AI-assisted development.

## Credits & Inspirations

- **[CHIMERA (`chimera-vocal-synth`)](https://github.com/jamesondh/chimera-vocal-synth)** (MIT License): gaitabs' real-time browser audio architecture draws direct inspiration from CHIMERA's clean separation between the React/Zustand main thread and an isolated zero-allocation `AudioWorklet` engine, its deterministic block-size-independent offline `renderBlock()` unit testing pattern, and its ~60 Hz telemetry bridge for live visualizers.
