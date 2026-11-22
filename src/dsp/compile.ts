import {
  barAbsoluteStartTick,
  getTotalTicks,
  type SongDocument,
} from '../schema/song.ts';
import { resolveNoteFrequencies } from '../schema/tuning.ts';
import type { ScheduledReedEvent } from './types.ts';

export interface CompiledScore {
  events: ScheduledReedEvent[];
  totalTicks: number;
}

/**
 * Compiles a canonical `SongDocument` into flat, sorted, Hz-resolved
 * `ScheduledReedEvent` entries ready for transfer to the AudioWorklet sequencer.
 *
 * Kept strictly outside the AudioWorklet module graph so the worklet bundle
 * never imports Zod runtime schemas from `src/schema/song.ts`.
 */
export function compileSongToScheduledEvents(doc: SongDocument): CompiledScore {
  const { tuning, harpKey } = doc.instrument;
  const events: ScheduledReedEvent[] = [];
  let maxNoteEndTick = 0;

  for (let barIdx = 0; barIdx < doc.bars.length; barIdx++) {
    const bar = doc.bars[barIdx];
    if (!bar) continue;
    const barStart = barAbsoluteStartTick(doc.bars, barIdx);

    for (let noteIdx = 0; noteIdx < bar.notes.length; noteIdx++) {
      const note = bar.notes[noteIdx];
      if (!note) continue;

      const startTick = barStart + note.offsetTick;
      const durationTicks = Math.max(1, Math.round(note.durationTicks));
      const frequenciesHz = resolveNoteFrequencies(note, tuning, harpKey);
      // Subtle human breath contour: downbeats slightly fuller, inner/off-beats slightly lighter
      const isBarDownbeat = note.offsetTick === 0;
      const isOnBeat = note.offsetTick % 480 === 0;
      const baseVel = note.holes.length > 1 ? 0.72 : isBarDownbeat ? 0.88 : isOnBeat ? 0.81 : 0.76;
      const velocity = note.action === 'draw' ? Math.min(0.92, baseVel + 0.02) : baseVel;

      const ev: ScheduledReedEvent = {
        id: note.id,
        startTick,
        durationTicks,
        holes: [...note.holes],
        frequenciesHz,
        action: note.action,
        bendSteps: note.bendSteps,
        velocity,
      };
      if (note.articulation !== undefined) {
        ev.articulation = note.articulation;
      }

      events.push(ev);

      const endTick = startTick + durationTicks;
      if (endTick > maxNoteEndTick) {
        maxNoteEndTick = endTick;
      }
    }
  }

  // Deterministic ordering by startTick (JS Array.prototype.sort is stable).
  events.sort((a, b) => a.startTick - b.startTick);

  const barTotal = getTotalTicks(doc.bars);
  const totalTicks = Math.max(barTotal, maxNoteEndTick);

  return { events, totalTicks };
}
