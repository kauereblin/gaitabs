import { describe, expect, test } from 'bun:test';
import {
  PPQ,
  SongDocumentSchema,
  barAbsoluteStartTick,
  createEmptySong,
  getTotalTicks,
  ticksToSeconds,
} from './song.ts';
import {
  clampBendSteps,
  formatNoteCaption,
  formatNoteToken,
  maxBendSteps,
  midiToHz,
  resolveHoleMidi,
  resolveNoteFrequencies,
} from './tuning.ts';
import { WONDERFUL_WORLD_GOLDEN_DOC } from './golden.ts';

describe('SongDocumentSchema & PPQ helpers', () => {
  test('validates empty song and golden fixture', () => {
    const empty = createEmptySong({ title: 'Test Tune', harpKey: 'G' });
    expect(SongDocumentSchema.parse(empty).instrument.harpKey).toBe('G');
    expect(SongDocumentSchema.parse(WONDERFUL_WORLD_GOLDEN_DOC).schemaVersion).toBe(1);
  });

  test('rejects float ticks, zero duration, and out-of-range holes', () => {
    const base = structuredClone(WONDERFUL_WORLD_GOLDEN_DOC);
    base.bars[0]!.notes[0]!.offsetTick = 12.5;
    expect(() => SongDocumentSchema.parse(base)).toThrow();

    const zeroDur = structuredClone(WONDERFUL_WORLD_GOLDEN_DOC);
    zeroDur.bars[0]!.notes[0]!.durationTicks = 0;
    expect(() => SongDocumentSchema.parse(zeroDur)).toThrow();

    const badHole = structuredClone(WONDERFUL_WORLD_GOLDEN_DOC);
    badHole.bars[0]!.notes[0]!.holes = [11];
    expect(() => SongDocumentSchema.parse(badHole)).toThrow();
  });

  test('computes deterministic ticksToSeconds and bar start ticks', () => {
    expect(ticksToSeconds(PPQ, 120)).toBeCloseTo(0.5, 6);
    expect(ticksToSeconds(PPQ * 4, 60)).toBeCloseTo(4.0, 6);
    expect(barAbsoluteStartTick(WONDERFUL_WORLD_GOLDEN_DOC.bars, 0)).toBe(0);
    expect(barAbsoluteStartTick(WONDERFUL_WORLD_GOLDEN_DOC.bars, 1)).toBe(9 * PPQ);
    expect(getTotalTicks(WONDERFUL_WORLD_GOLDEN_DOC.bars)).toBe(17 * PPQ);
  });
});

describe('Richter TuningTable & Bend Clamping', () => {
  test('enforces exact Richter draw and blow bend limits per hole', () => {
    expect(maxBendSteps('richter', 1, 'draw')).toBe(1);
    expect(maxBendSteps('richter', 2, 'draw')).toBe(2);
    expect(maxBendSteps('richter', 3, 'draw')).toBe(3);
    expect(maxBendSteps('richter', 4, 'draw')).toBe(1);
    expect(maxBendSteps('richter', 5, 'draw')).toBe(0);
    expect(maxBendSteps('richter', 6, 'draw')).toBe(1);
    expect(maxBendSteps('richter', 7, 'draw')).toBe(0);

    expect(maxBendSteps('richter', 7, 'blow')).toBe(0);
    expect(maxBendSteps('richter', 8, 'blow')).toBe(1);
    expect(maxBendSteps('richter', 9, 'blow')).toBe(1);
    expect(maxBendSteps('richter', 10, 'blow')).toBe(2);

    expect(clampBendSteps('richter', 5, 'draw', 2)).toBe(0);
    expect(clampBendSteps('richter', 3, 'draw', 3)).toBe(3);
    expect(clampBendSteps('richter', 4, 'draw', 3)).toBe(1);
  });

  test('derives accurate C harp pitches and transposes cleanly to G harp', () => {
    // C harp hole 4 blow = C5 (MIDI 72)
    expect(resolveHoleMidi('richter', 'C', 4, 'blow', 0)).toBe(72);
    // C harp hole 10 blow = C7 (MIDI 96 -> ~2093.00 Hz)
    expect(midiToHz(resolveHoleMidi('richter', 'C', 10, 'blow', 0))).toBeCloseTo(2093.0, 1);
    // C harp hole 3 draw whole-step bend = A4 (MIDI 69 -> 440 Hz)
    expect(midiToHz(resolveHoleMidi('richter', 'C', 3, 'draw', 2))).toBeCloseTo(440.0, 4);
    // Overblow on hole 6 = Bb5 (MIDI 82)
    expect(resolveHoleMidi('richter', 'C', 6, 'overblow', 0)).toBe(82);

    // Transposing C -> G shifts down 5 semitones
    const cFreqs = resolveNoteFrequencies(
      { holes: [4], action: 'blow', bendSteps: 0 },
      'richter',
      'C',
    );
    const gFreqs = resolveNoteFrequencies(
      { holes: [4], action: 'blow', bendSteps: 0 },
      'richter',
      'G',
    );
    expect(cFreqs[0]! / gFreqs[0]!).toBeCloseTo(Math.pow(2, 5 / 12), 5);
  });

  test('formats note tokens and pitch captions consistently across harp keys', () => {
    expect(formatNoteToken({ holes: [4], action: 'blow', bendSteps: 0 })).toBe('4');
    expect(formatNoteToken({ holes: [3], action: 'draw', bendSteps: 2 })).toBe("-3''");
    expect(formatNoteToken({ holes: [6], action: 'overblow', bendSteps: 0 })).toBe('6ob');
    expect(formatNoteToken({ holes: [3, 4], action: 'draw', bendSteps: 0 })).toBe('(-3-4)');

    expect(formatNoteCaption({ holes: [4], action: 'blow', bendSteps: 0 }, 'richter', 'C')).toBe('C');
    expect(formatNoteCaption({ holes: [3], action: 'blow', bendSteps: 0 }, 'richter', 'C')).toBe('G');
    expect(formatNoteCaption({ holes: [3], action: 'draw', bendSteps: 2 }, 'richter', 'C')).toBe('A');
    expect(formatNoteCaption({ holes: [4], action: 'blow', bendSteps: 0 }, 'richter', 'G')).toBe('G');
    expect(formatNoteCaption({ holes: [3, 4], action: 'draw', bendSteps: 0 }, 'richter', 'C')).toBe('B·D');
  });
});
