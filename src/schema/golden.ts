import { PPQ, type SongDocument } from './song.ts';

export const WONDERFUL_WORLD_TEXT = [
  '3 -3    4   4    6    -6  -6 -6  6',
  'I see trees of green, red roses too',
  '-5 6   -5    5   -4  -4 -4   4',
  'I see them bloom for me and you',
].join('\n');

export const WONDERFUL_WORLD_GOLDEN_DOC: SongDocument = {
  id: '00000000-0000-4000-8000-000000000001',
  schemaVersion: 1,
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  title: 'What a Wonderful World (Opening Phrase)',
  artist: 'Golden Fixture',
  instrument: {
    tuning: 'richter',
    harpKey: 'C',
  },
  timingMode: 'unmeasured',
  bpm: 76,
  swingPercent: 58,
  timeSignature: {
    numerator: 4,
    denominator: 4,
  },
  bars: [
    {
      id: 'bar-0',
      index: 0,
      durationTicks: 9 * PPQ,
      notes: [
        { id: 'n-0-0', offsetTick: 0 * PPQ, durationTicks: PPQ, holes: [3], action: 'blow', bendSteps: 0 },
        { id: 'n-0-1', offsetTick: 1 * PPQ, durationTicks: PPQ, holes: [3], action: 'draw', bendSteps: 0 },
        { id: 'n-0-2', offsetTick: 2 * PPQ, durationTicks: PPQ, holes: [4], action: 'blow', bendSteps: 0 },
        { id: 'n-0-3', offsetTick: 3 * PPQ, durationTicks: PPQ, holes: [4], action: 'blow', bendSteps: 0 },
        { id: 'n-0-4', offsetTick: 4 * PPQ, durationTicks: PPQ, holes: [6], action: 'blow', bendSteps: 0 },
        { id: 'n-0-5', offsetTick: 5 * PPQ, durationTicks: PPQ, holes: [6], action: 'draw', bendSteps: 0 },
        { id: 'n-0-6', offsetTick: 6 * PPQ, durationTicks: PPQ, holes: [6], action: 'draw', bendSteps: 0 },
        { id: 'n-0-7', offsetTick: 7 * PPQ, durationTicks: PPQ, holes: [6], action: 'draw', bendSteps: 0 },
        { id: 'n-0-8', offsetTick: 8 * PPQ, durationTicks: PPQ, holes: [6], action: 'blow', bendSteps: 0 },
      ],
      lyrics: [
        { id: 'l-0-0', offsetTick: 0 * PPQ, durationTicks: PPQ, text: 'I' },
        { id: 'l-0-1', offsetTick: 1 * PPQ, durationTicks: PPQ, text: 'see' },
        { id: 'l-0-2', offsetTick: 2 * PPQ, durationTicks: PPQ, text: 'trees' },
        { id: 'l-0-3', offsetTick: 3 * PPQ, durationTicks: PPQ, text: 'of' },
        { id: 'l-0-4', offsetTick: 4 * PPQ, durationTicks: PPQ, text: 'green,' },
        { id: 'l-0-5', offsetTick: 5 * PPQ, durationTicks: PPQ, text: 'red' },
        { id: 'l-0-6', offsetTick: 6 * PPQ, durationTicks: PPQ, text: 'ro-', joinNext: true },
        { id: 'l-0-7', offsetTick: 7 * PPQ, durationTicks: PPQ, text: 'ses' },
        { id: 'l-0-8', offsetTick: 8 * PPQ, durationTicks: PPQ, text: 'too' },
      ],
    },
    {
      id: 'bar-1',
      index: 1,
      durationTicks: 8 * PPQ,
      notes: [
        { id: 'n-1-0', offsetTick: 0 * PPQ, durationTicks: PPQ, holes: [5], action: 'draw', bendSteps: 0 },
        { id: 'n-1-1', offsetTick: 1 * PPQ, durationTicks: PPQ, holes: [6], action: 'blow', bendSteps: 0 },
        { id: 'n-1-2', offsetTick: 2 * PPQ, durationTicks: PPQ, holes: [5], action: 'draw', bendSteps: 0 },
        { id: 'n-1-3', offsetTick: 3 * PPQ, durationTicks: PPQ, holes: [5], action: 'blow', bendSteps: 0 },
        { id: 'n-1-4', offsetTick: 4 * PPQ, durationTicks: PPQ, holes: [4], action: 'draw', bendSteps: 0 },
        { id: 'n-1-5', offsetTick: 5 * PPQ, durationTicks: PPQ, holes: [4], action: 'draw', bendSteps: 0 },
        { id: 'n-1-6', offsetTick: 6 * PPQ, durationTicks: PPQ, holes: [4], action: 'draw', bendSteps: 0 },
        { id: 'n-1-7', offsetTick: 7 * PPQ, durationTicks: PPQ, holes: [4], action: 'blow', bendSteps: 0 },
      ],
      lyrics: [
        { id: 'l-1-0', offsetTick: 0 * PPQ, durationTicks: PPQ, text: 'I' },
        { id: 'l-1-1', offsetTick: 1 * PPQ, durationTicks: PPQ, text: 'see' },
        { id: 'l-1-2', offsetTick: 2 * PPQ, durationTicks: PPQ, text: 'them' },
        { id: 'l-1-3', offsetTick: 3 * PPQ, durationTicks: PPQ, text: 'bloom' },
        { id: 'l-1-4', offsetTick: 4 * PPQ, durationTicks: PPQ, text: 'for' },
        { id: 'l-1-5', offsetTick: 5 * PPQ, durationTicks: PPQ, text: 'me' },
        { id: 'l-1-6', offsetTick: 6 * PPQ, durationTicks: PPQ, text: 'and' },
        { id: 'l-1-7', offsetTick: 7 * PPQ, durationTicks: PPQ, text: 'you' },
      ],
    },
  ],
};
