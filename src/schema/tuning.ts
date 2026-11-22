import type { BendSteps, BreathAction, HarmonicaNote, HarpKey, TuningId } from './song.ts';

/**
 * Standard 10-hole C Richter diatonic harmonica MIDI pitches (C4 = 60).
 * Index 0 corresponds to hole 1, index 9 corresponds to hole 10.
 */
const RICHTER_C_BLOW_MIDI = [60, 64, 67, 72, 76, 79, 84, 88, 91, 96] as const;
const RICHTER_C_DRAW_MIDI = [62, 67, 71, 74, 77, 81, 83, 86, 89, 93] as const;

/**
 * Standard Richter harmonica key offsets relative to C (in semitones).
 * Follows standard diatonic harp ordering from low G (-5) up to high F# (+6).
 */
export const HARP_KEY_SEMITONE_OFFSET: Readonly<Record<HarpKey, number>> = {
  G: -5,
  Ab: -4,
  A: -3,
  Bb: -2,
  B: -1,
  C: 0,
  Db: 1,
  D: 2,
  Eb: 3,
  E: 4,
  F: 5,
  'F#': 6,
};

/**
 * Maximum half-step bends allowed per hole and breath action in Richter tuning.
 * Draw bends: Hole 1 (1), Hole 2 (2), Hole 3 (3), Hole 4 (1), Hole 6 (1).
 * Blow bends: Hole 8 (1), Hole 9 (1), Hole 10 (2).
 */
const RICHTER_MAX_DRAW_BENDS: readonly BendSteps[] = [1, 2, 3, 1, 0, 1, 0, 0, 0, 0];
const RICHTER_MAX_BLOW_BENDS: readonly BendSteps[] = [0, 0, 0, 0, 0, 0, 0, 1, 1, 2];

const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

export function maxBendSteps(tuning: TuningId, hole: number, action: BreathAction): BendSteps {
  if (tuning !== 'richter') return 0;
  if (hole < 1 || hole > 10 || !Number.isInteger(hole)) return 0;
  const idx = hole - 1;
  if (action === 'draw') return RICHTER_MAX_DRAW_BENDS[idx] ?? 0;
  if (action === 'blow') return RICHTER_MAX_BLOW_BENDS[idx] ?? 0;
  return 0;
}

export function clampBendSteps(
  tuning: TuningId,
  hole: number,
  action: BreathAction,
  requested: number,
): BendSteps {
  const max = maxBendSteps(tuning, hole, action);
  const clamped = Math.max(0, Math.min(max, Math.round(requested)));
  return clamped as BendSteps;
}

export function canOverblow(tuning: TuningId, hole: number): boolean {
  if (tuning !== 'richter') return false;
  return hole >= 1 && hole <= 6;
}

export function canOverdraw(tuning: TuningId, hole: number): boolean {
  if (tuning !== 'richter') return false;
  return hole >= 7 && hole <= 10;
}

export function resolveHoleMidi(
  tuning: TuningId,
  harpKey: HarpKey,
  hole: number,
  action: BreathAction,
  bendSteps: number = 0,
  bendCents: number = 0,
): number {
  if (tuning !== 'richter') {
    throw new Error(`Unsupported tuning: ${String(tuning)}`);
  }
  const idx = Math.max(0, Math.min(9, Math.round(hole) - 1));
  const blow = RICHTER_C_BLOW_MIDI[idx]!;
  const draw = RICHTER_C_DRAW_MIDI[idx]!;
  const keyOffset = HARP_KEY_SEMITONE_OFFSET[harpKey];

  let baseMidi: number;
  if (action === 'blow') {
    const safeBend = clampBendSteps(tuning, idx + 1, 'blow', bendSteps);
    baseMidi = blow - safeBend;
  } else if (action === 'draw') {
    const safeBend = clampBendSteps(tuning, idx + 1, 'draw', bendSteps);
    baseMidi = draw - safeBend;
  } else if (action === 'overblow') {
    // Overblow excites above the higher reed (holes 1-6: draw + 1; fallback blow + 1)
    baseMidi = Math.max(blow, draw) + 1;
  } else {
    // Overdraw excites above the higher reed (holes 7-10: blow + 1)
    baseMidi = Math.max(blow, draw) + 1;
  }

  return baseMidi + keyOffset + bendCents / 100;
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToNoteName(midi: number): string {
  const rounded = Math.round(midi);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12]!;
  const octave = Math.floor(rounded / 12) - 1;
  return `${name}${octave}`;
}

export function resolveNoteFrequencies(
  note: Pick<HarmonicaNote, 'holes' | 'action' | 'bendSteps' | 'bendCents'>,
  tuning: TuningId,
  harpKey: HarpKey,
): number[] {
  return note.holes.map((hole) => {
    const midi = resolveHoleMidi(
      tuning,
      harpKey,
      hole,
      note.action,
      note.bendSteps,
      note.bendCents ?? 0,
    );
    return midiToHz(midi);
  });
}

export function formatNoteCaption(
  note: Pick<HarmonicaNote, 'holes' | 'action' | 'bendSteps' | 'bendCents'>,
  tuning: TuningId,
  harpKey: HarpKey,
): string {
  const seen: string[] = [];
  for (const hole of note.holes) {
    const midi = resolveHoleMidi(
      tuning,
      harpKey,
      hole,
      note.action,
      note.bendSteps,
      note.bendCents ?? 0,
    );
    const pitchClass = midiToNoteName(midi).replace(/-?\d+$/, '');
    if (!seen.includes(pitchClass)) {
      seen.push(pitchClass);
    }
  }
  return seen.join('·');
}

export function formatNoteToken(
  note: Pick<HarmonicaNote, 'holes' | 'action' | 'bendSteps'>,
): string {
  const bendMarks = "'".repeat(note.bendSteps);
  if (note.action === 'overblow') {
    return `${note.holes.join('')}ob`;
  }
  if (note.action === 'overdraw') {
    return `-${note.holes.join('')}od`;
  }
  const prefix = note.action === 'draw' ? '-' : '';
  if (note.holes.length === 1) {
    return `${prefix}${note.holes[0]}${bendMarks}`;
  }
  return `(${note.holes.map((h) => `${prefix}${h}`).join('')})${bendMarks}`;
}
