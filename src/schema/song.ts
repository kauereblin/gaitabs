import { z } from 'zod';

export const PPQ = 480 as const;

export const HARP_KEYS = [
  'C',
  'G',
  'A',
  'D',
  'F',
  'Bb',
  'Eb',
  'E',
  'Ab',
  'Db',
  'F#',
  'B',
] as const;

export const HarpKeySchema = z.enum(HARP_KEYS);
export type HarpKey = z.infer<typeof HarpKeySchema>;

export const TuningIdSchema = z.enum(['richter']);
export type TuningId = z.infer<typeof TuningIdSchema>;

export const BreathActionSchema = z.enum(['blow', 'draw', 'overblow', 'overdraw']);
export type BreathAction = z.infer<typeof BreathActionSchema>;

export const BendStepsSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type BendSteps = z.infer<typeof BendStepsSchema>;

export const ArticulationSchema = z.enum(['slur', 'vibrato', 'trill', 'wah']);
export type Articulation = z.infer<typeof ArticulationSchema>;

export const TimingModeSchema = z.enum(['unmeasured', 'measured']);
export type TimingMode = z.infer<typeof TimingModeSchema>;

export const HarmonicaNoteSchema = z.object({
  id: z.string().min(1),
  offsetTick: z.number().int().min(0),
  durationTicks: z.number().int().positive(),
  holes: z.array(z.number().int().min(1).max(10)).min(1).max(10),
  action: BreathActionSchema,
  bendSteps: BendStepsSchema,
  bendCents: z.number().min(-50).max(50).optional(),
  articulation: ArticulationSchema.optional(),
});
export type HarmonicaNote = z.infer<typeof HarmonicaNoteSchema>;

export const LyricSpanSchema = z.object({
  id: z.string().min(1),
  offsetTick: z.number().int().min(0),
  durationTicks: z.number().int().positive(),
  text: z.string(),
  joinNext: z.boolean().optional(),
});
export type LyricSpan = z.infer<typeof LyricSpanSchema>;

export const BarSchema = z.object({
  id: z.string().min(1),
  index: z.number().int().min(0),
  durationTicks: z.number().int().positive(),
  notes: z.array(HarmonicaNoteSchema),
  lyrics: z.array(LyricSpanSchema),
});
export type Bar = z.infer<typeof BarSchema>;

export const TimeSignatureSchema = z.object({
  numerator: z.number().int().min(1).max(16),
  denominator: z.union([z.literal(2), z.literal(4), z.literal(8)]),
});
export type TimeSignature = z.infer<typeof TimeSignatureSchema>;

export const SongDocumentSchema = z.object({
  id: z.string().uuid(),
  schemaVersion: z.literal(1),
  revision: z.number().int().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable().optional(),
  title: z.string().min(1).max(200),
  artist: z.string().max(200).optional(),
  instrument: z.object({
    tuning: TuningIdSchema,
    harpKey: HarpKeySchema,
  }),
  timingMode: TimingModeSchema,
  bpm: z.number().min(30).max(260),
  swingPercent: z.number().min(50).max(75),
  timeSignature: TimeSignatureSchema,
  bars: z.array(BarSchema),
});
export type SongDocument = z.infer<typeof SongDocumentSchema>;

export function defaultBarDurationTicks(ts: TimeSignature): number {
  return Math.round((ts.numerator * PPQ * 4) / ts.denominator);
}

export function ticksToSeconds(ticks: number, bpm: number): number {
  return (ticks / PPQ) * (60 / bpm);
}

export function secondsToTicks(seconds: number, bpm: number): number {
  return Math.round(seconds * (bpm / 60) * PPQ);
}

export function barAbsoluteStartTick(bars: readonly Bar[], barIndex: number): number {
  let acc = 0;
  const limit = Math.min(barIndex, bars.length);
  for (let i = 0; i < limit; i++) {
    acc += bars[i]!.durationTicks;
  }
  return acc;
}

export function getTotalTicks(bars: readonly Bar[]): number {
  let total = 0;
  for (const bar of bars) {
    total += bar.durationTicks;
  }
  return total;
}

export function createEmptySong(overrides?: Partial<Pick<SongDocument, 'title' | 'artist' | 'bpm' | 'timingMode'>> & { harpKey?: HarpKey }): SongDocument {
  const now = new Date().toISOString();
  const timeSignature: TimeSignature = { numerator: 4, denominator: 4 };
  return {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    title: overrides?.title ?? 'Untitled Harmonica Tab',
    artist: overrides?.artist,
    instrument: {
      tuning: 'richter',
      harpKey: overrides?.harpKey ?? 'C',
    },
    timingMode: overrides?.timingMode ?? 'measured',
    bpm: overrides?.bpm ?? 90,
    swingPercent: 50,
    timeSignature,
    bars: [
      {
        id: 'bar-0',
        index: 0,
        durationTicks: defaultBarDurationTicks(timeSignature),
        notes: [],
        lyrics: [],
      },
    ],
  };
}
