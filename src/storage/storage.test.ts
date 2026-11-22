import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'bun:test';
import { compressToEncodedURIComponent } from 'lz-string';
import { PPQ, createEmptySong, type SongDocument } from '../schema/song.ts';
import { WONDERFUL_WORLD_GOLDEN_DOC } from '../schema/golden.ts';
import { toSongSummary } from './repository.ts';
import { IndexedDbSongRepository } from './indexedDbRepo.ts';
import {
  MAX_SAFE_URL_HASH_CHARS,
  URL_HASH_PREFIX,
  decodeSongFromHash,
  encodeSongToHash,
  parseSongJson,
  serializeSongJson,
} from './portability.ts';

function createTestRepo(): IndexedDbSongRepository {
  return new IndexedDbSongRepository({
    dbName: `gaitabs-test-${crypto.randomUUID()}`,
  });
}

describe('SongRepository & IndexedDbSongRepository', () => {
  const activeRepos: IndexedDbSongRepository[] = [];

  function trackRepo(): IndexedDbSongRepository {
    const repo = createTestRepo();
    activeRepos.push(repo);
    return repo;
  }

  afterEach(async () => {
    while (activeRepos.length > 0) {
      const repo = activeRepos.pop();
      if (repo) await repo.close();
    }
  });

  test('toSongSummary projects canonical fields cleanly', () => {
    const summary = toSongSummary(WONDERFUL_WORLD_GOLDEN_DOC);
    expect(summary).toEqual({
      id: WONDERFUL_WORLD_GOLDEN_DOC.id,
      title: WONDERFUL_WORLD_GOLDEN_DOC.title,
      artist: WONDERFUL_WORLD_GOLDEN_DOC.artist,
      harpKey: 'C',
      timingMode: 'unmeasured',
      revision: 1,
      updatedAt: WONDERFUL_WORLD_GOLDEN_DOC.updatedAt,
    });

    const noArtist = createEmptySong({ title: 'No Artist Song', harpKey: 'A' });
    const noArtistSummary = toSongSummary(noArtist);
    expect('artist' in noArtistSummary).toBe(false);
    expect(noArtistSummary.harpKey).toBe('A');
  });

  test('saves, retrieves, and increments revision monotonically on re-save', async () => {
    const repo = trackRepo();
    const initial = structuredClone(WONDERFUL_WORLD_GOLDEN_DOC);
    // Even if an incoming unsaved doc has revision > 1, a brand-new record starts at 1
    initial.revision = 4;

    const saved1 = await repo.save(initial);
    expect(saved1.revision).toBe(1);
    expect(saved1.deletedAt).toBeNull();
    expect(Date.parse(saved1.updatedAt)).not.toBeNaN();

    const fetched = await repo.get(saved1.id);
    expect(fetched).toEqual(saved1);

    // Re-save increments revision from 1 -> 2
    const saved2 = await repo.save({ ...saved1, title: 'Updated Wonderful World' });
    expect(saved2.revision).toBe(2);
    expect(saved2.title).toBe('Updated Wonderful World');
    expect(saved2.createdAt).toBe(saved1.createdAt);

    // Re-save with higher incoming revision bumps past max(existing, incoming)
    const saved3 = await repo.save({ ...saved2, revision: 5 });
    expect(saved3.revision).toBe(6);

    // Re-save with stale lower revision still increments monotonically
    const saved4 = await repo.save({ ...saved1, revision: 1 });
    expect(saved4.revision).toBe(7);
  });

  test('rejects invalid SongDocument on save via Zod', async () => {
    const repo = trackRepo();
    const invalid = structuredClone(WONDERFUL_WORLD_GOLDEN_DOC);
    invalid.bpm = 999; // out of 30..260 range

    await expect(repo.save(invalid)).rejects.toThrow();
    expect(await repo.get(invalid.id)).toBeNull();
  });

  test('lists songs with query, harpKey, timingMode filters and updatedAt descending order', async () => {
    const repo = trackRepo();

    const songA = createEmptySong({
      title: 'Crossroad Blues',
      artist: 'Robert Johnson',
      harpKey: 'A',
      timingMode: 'measured',
    });
    const songB = createEmptySong({
      title: 'Amazing Grace',
      artist: 'Traditional',
      harpKey: 'G',
      timingMode: 'unmeasured',
    });
    const songC = structuredClone(WONDERFUL_WORLD_GOLDEN_DOC);

    const savedA = await repo.save(songA);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const savedB = await repo.save(songB);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const savedC = await repo.save(songC);

    // Default list: sorted by updatedAt descending (C, B, A)
    const all = await repo.list();
    expect(all.map((s) => s.id)).toEqual([savedC.id, savedB.id, savedA.id]);

    // Filter by harpKey
    const gSongs = await repo.list({ harpKey: 'G' });
    expect(gSongs).toHaveLength(1);
    expect(gSongs[0]!.id).toBe(savedB.id);

    // Filter by timingMode
    const unmeasured = await repo.list({ timingMode: 'unmeasured' });
    expect(unmeasured.map((s) => s.id)).toEqual([savedC.id, savedB.id]);

    // Case-insensitive query matching title
    const bluesQuery = await repo.list({ query: '  BLUES ' });
    expect(bluesQuery).toHaveLength(1);
    expect(bluesQuery[0]!.id).toBe(savedA.id);

    // Case-insensitive query matching artist
    const artistQuery = await repo.list({ query: 'johnson' });
    expect(artistQuery).toHaveLength(1);
    expect(artistQuery[0]!.id).toBe(savedA.id);

    // Combined filter
    const combined = await repo.list({
      query: 'wonderful',
      harpKey: 'C',
      timingMode: 'unmeasured',
    });
    expect(combined).toHaveLength(1);
    expect(combined[0]!.id).toBe(savedC.id);

    // Non-matching filter
    expect(await repo.list({ query: 'nonexistent' })).toEqual([]);
  });

  test('soft-deletes with tombstone revision bump and supports hard purge', async () => {
    const repo = trackRepo();
    const saved = await repo.save(structuredClone(WONDERFUL_WORLD_GOLDEN_DOC));
    expect(saved.revision).toBe(1);

    // Soft-delete writes tombstone with deletedAt and increments revision
    await repo.remove(saved.id);

    expect(await repo.get(saved.id)).toBeNull();
    expect(await repo.list()).toEqual([]);

    const tombstone = await repo.getRaw(saved.id);
    expect(tombstone).not.toBeNull();
    expect(tombstone!.deletedAt).not.toBeNull();
    expect(tombstone!.revision).toBe(2);

    // Re-saving restores the song and bumps revision past tombstone (2 -> 3)
    const restored = await repo.save({ ...saved, deletedAt: null });
    expect(restored.revision).toBe(3);
    expect(restored.deletedAt).toBeNull();
    expect(await repo.get(saved.id)).toEqual(restored);

    // Hard purge completely removes the record
    await repo.remove(saved.id, { hard: true });
    expect(await repo.getRaw(saved.id)).toBeNull();
    expect(await repo.get(saved.id)).toBeNull();

    // Removing a missing id is a safe no-op
    await expect(repo.remove('00000000-0000-4000-8000-000000009999')).resolves.toBeUndefined();
  });
});

describe('Portability: JSON, Markdown, and #tab= URL Codec', () => {
  test('round-trips SongDocument via serializeSongJson and parseSongJson', () => {
    const json = serializeSongJson(WONDERFUL_WORLD_GOLDEN_DOC);
    expect(json).toContain('\n  "schemaVersion": 1');
    const parsed = parseSongJson(json);
    expect(parsed).toEqual(WONDERFUL_WORLD_GOLDEN_DOC);
  });

  test('rejects corrupt JSON syntax and invalid SongDocument schema', () => {
    expect(() => parseSongJson('{ not valid json')).toThrow(/Invalid song JSON/i);

    const badVersion = { ...structuredClone(WONDERFUL_WORLD_GOLDEN_DOC), schemaVersion: 2 };
    expect(() => parseSongJson(JSON.stringify(badVersion))).toThrow(/Invalid SongDocument schema/i);

    const floatTicks = structuredClone(WONDERFUL_WORLD_GOLDEN_DOC);
    floatTicks.bars[0]!.notes[0]!.offsetTick = 12.5;
    expect(() => parseSongJson(JSON.stringify(floatTicks))).toThrow(/Invalid SongDocument schema/i);

    const badHole = structuredClone(WONDERFUL_WORLD_GOLDEN_DOC);
    badHole.bars[0]!.notes[0]!.holes = [11];
    expect(() => parseSongJson(JSON.stringify(badHole))).toThrow(/Invalid SongDocument schema/i);
  });

  test('round-trips WONDERFUL_WORLD_GOLDEN_DOC through #tab= lz-string URL hash', () => {
    const encoded = encodeSongToHash(WONDERFUL_WORLD_GOLDEN_DOC);
    expect(encoded.hash.startsWith(URL_HASH_PREFIX)).toBe(true);
    expect(encoded.encodedLength).toBe(encoded.hash.length);
    expect(encoded.exceedsSafeLimit).toBe(false);
    expect(encoded.encodedLength).toBeLessThan(MAX_SAFE_URL_HASH_CHARS);

    const decoded = decodeSongFromHash(encoded.hash);
    expect(decoded).toEqual(WONDERFUL_WORLD_GOLDEN_DOC);
  });

  test('flags exceedsSafeLimit when compressed hash exceeds MAX_SAFE_URL_HASH_CHARS', () => {
    const hugeSong: SongDocument = {
      ...structuredClone(WONDERFUL_WORLD_GOLDEN_DOC),
      bars: Array.from({ length: 120 }, (_, bi) => ({
        id: `bar-${bi}-${crypto.randomUUID()}`,
        index: bi,
        durationTicks: 8 * PPQ,
        notes: Array.from({ length: 8 }, (__, ni) => ({
          id: `n-${bi}-${ni}-${crypto.randomUUID()}`,
          offsetTick: ni * PPQ,
          durationTicks: PPQ,
          holes: [((bi + ni) % 10) + 1],
          action: (ni % 2 === 0 ? 'blow' : 'draw') as 'blow' | 'draw',
          bendSteps: 0 as const,
        })),
        lyrics: Array.from({ length: 8 }, (__, li) => ({
          id: `l-${bi}-${li}-${crypto.randomUUID()}`,
          offsetTick: li * PPQ,
          durationTicks: PPQ,
          text: `syl-${bi}-${li}-${crypto.randomUUID().slice(0, 8)}`,
        })),
      })),
    };

    const encoded = encodeSongToHash(hugeSong);
    expect(encoded.encodedLength).toBeGreaterThan(MAX_SAFE_URL_HASH_CHARS);
    expect(encoded.exceedsSafeLimit).toBe(true);
    expect(decodeSongFromHash(encoded.hash)).toEqual(hugeSong);
  });

  test('decodeSongFromHash returns null without #tab= prefix and throws on corrupt payloads', () => {
    expect(decodeSongFromHash('')).toBeNull();
    expect(decodeSongFromHash('#')).toBeNull();
    expect(decodeSongFromHash('#other=abc')).toBeNull();

    expect(() => decodeSongFromHash('#tab=')).toThrow(/Corrupted #tab= URL hash/i);
    expect(() => decodeSongFromHash('#tab=!!!not-valid-lz!!!')).toThrow(/Corrupted #tab= URL hash/i);

    const compressedBadSchema = compressToEncodedURIComponent(JSON.stringify({ hello: 'world' }));
    expect(() => decodeSongFromHash(`#tab=${compressedBadSchema}`)).toThrow(
      /Corrupted #tab= URL hash/i,
    );
  });
});
