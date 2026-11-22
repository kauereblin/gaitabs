import { describe, expect, test } from 'bun:test';
import { SongDocumentSchema } from '../schema/song.ts';
import { WONDERFUL_WORLD_GOLDEN_DOC, WONDERFUL_WORLD_TEXT } from '../schema/golden.ts';
import { exportTextTab, parseTabToken, parseTextTab } from './textTab.ts';

describe('Plain-Text Harmonica Tab Parser', () => {
  test('parses blow, draw, bends, overblow/overdraw, and chord tokens', () => {
    expect(parseTabToken('4')).toEqual({ holes: [4], action: 'blow', bendSteps: 0 });
    expect(parseTabToken('+4')).toEqual({ holes: [4], action: 'blow', bendSteps: 0 });
    expect(parseTabToken('-4')).toEqual({ holes: [4], action: 'draw', bendSteps: 0 });
    expect(parseTabToken("-3'''")).toEqual({ holes: [3], action: 'draw', bendSteps: 3 });
    // Hole 5 draw cannot bend -> clamps to 0
    expect(parseTabToken("-5''")).toEqual({ holes: [5], action: 'draw', bendSteps: 0 });
    expect(parseTabToken("10''")).toEqual({ holes: [10], action: 'blow', bendSteps: 2 });
    expect(parseTabToken('6ob')).toEqual({ holes: [6], action: 'overblow', bendSteps: 0 });
    expect(parseTabToken('-7od')).toEqual({ holes: [7], action: 'overdraw', bendSteps: 0 });
    expect(parseTabToken('34')).toEqual({ holes: [3, 4], action: 'blow', bendSteps: 0 });
    expect(parseTabToken('(4 5)')).toEqual({ holes: [4, 5], action: 'blow', bendSteps: 0 });
    expect(parseTabToken('(-3-4)')).toEqual({ holes: [3, 4], action: 'draw', bendSteps: 0 });
  });

  test('exports Markdown tab sheet with header and lyrics', () => {
    const md = exportTextTab(WONDERFUL_WORLD_GOLDEN_DOC, true);
    expect(md).toContain(`# ${WONDERFUL_WORLD_GOLDEN_DOC.title}`);
    expect(md).toContain('Artist: Golden Fixture');
    expect(md).toContain('Harp: C (richter)');
    expect(md).toContain('BPM: 76');
    expect(md).toContain('trees');
    expect(md).toContain('-6');
  });

  test('parses WONDERFUL_WORLD_TEXT into expected golden structure', () => {
    const parsed = parseTextTab(WONDERFUL_WORLD_TEXT, {
      title: WONDERFUL_WORLD_GOLDEN_DOC.title,
      artist: WONDERFUL_WORLD_GOLDEN_DOC.artist,
      harpKey: 'C',
      bpm: 76,
    });

    // Must validate cleanly against canonical Zod schema
    expect(() => SongDocumentSchema.parse(parsed)).not.toThrow();
    expect(parsed.timingMode).toBe('unmeasured');
    expect(parsed.bars).toHaveLength(2);

    // Bar 0: 9 notes and 9 lyric spans matching golden fixture
    const bar0 = parsed.bars[0]!;
    expect(bar0.notes.map((n) => ({ h: n.holes, a: n.action, b: n.bendSteps }))).toEqual(
      WONDERFUL_WORLD_GOLDEN_DOC.bars[0]!.notes.map((n) => ({
        h: n.holes,
        a: n.action,
        b: n.bendSteps,
      })),
    );
    expect(bar0.lyrics.map((l) => l.text)).toEqual(
      WONDERFUL_WORLD_GOLDEN_DOC.bars[0]!.lyrics.map((l) => l.text),
    );
    expect(bar0.lyrics[6]?.joinNext).toBe(true);

    // Bar 1: 8 notes and 8 lyric spans matching golden fixture
    const bar1 = parsed.bars[1]!;
    expect(bar1.notes.map((n) => ({ h: n.holes, a: n.action, b: n.bendSteps }))).toEqual(
      WONDERFUL_WORLD_GOLDEN_DOC.bars[1]!.notes.map((n) => ({
        h: n.holes,
        a: n.action,
        b: n.bendSteps,
      })),
    );
    expect(bar1.lyrics.map((l) => l.text)).toEqual(
      WONDERFUL_WORLD_GOLDEN_DOC.bars[1]!.lyrics.map((l) => l.text),
    );
  });

  test('round-trips exported text tab cleanly back into notes', () => {
    const exported = exportTextTab(WONDERFUL_WORLD_GOLDEN_DOC, false);
    const reparsed = parseTextTab(exported);
    expect(reparsed.bars).toHaveLength(2);
    expect(reparsed.bars[0]!.notes).toHaveLength(9);
    expect(reparsed.bars[1]!.notes).toHaveLength(8);
  });
});
