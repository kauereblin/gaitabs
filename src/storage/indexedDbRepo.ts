import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { SongDocumentSchema, type HarpKey, type SongDocument } from '../schema/song.ts';
import {
  toSongSummary,
  type RemoveSongOptions,
  type SongFilter,
  type SongRepository,
  type SongSummary,
} from './repository.ts';

export const DEFAULT_DB_NAME = 'gaitabs-v1' as const;
export const DEFAULT_DB_VERSION = 1 as const;
export const SONGS_STORE = 'songs' as const;

interface GaitabsDbSchema extends DBSchema {
  songs: {
    key: string;
    value: SongDocument;
    indexes: {
      updatedAt: string;
      title: string;
      harpKey: HarpKey;
    };
  };
}

export interface IndexedDbSongRepositoryOptions {
  dbName?: string;
  dbVersion?: number;
}

export class IndexedDbSongRepository implements SongRepository {
  private readonly dbName: string;
  private readonly dbVersion: number;
  private dbPromise: Promise<IDBPDatabase<GaitabsDbSchema>> | null = null;

  constructor(options?: IndexedDbSongRepositoryOptions) {
    this.dbName = options?.dbName ?? DEFAULT_DB_NAME;
    this.dbVersion = options?.dbVersion ?? DEFAULT_DB_VERSION;
  }

  private getDb(): Promise<IDBPDatabase<GaitabsDbSchema>> {
    if (!this.dbPromise) {
      this.dbPromise = openDB<GaitabsDbSchema>(this.dbName, this.dbVersion, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(SONGS_STORE)) {
            const store = db.createObjectStore(SONGS_STORE, { keyPath: 'id' });
            store.createIndex('updatedAt', 'updatedAt', { unique: false });
            store.createIndex('title', 'title', { unique: false });
            store.createIndex('harpKey', 'instrument.harpKey', { unique: false });
          }
        },
      });
    }
    return this.dbPromise;
  }

  async list(filter?: SongFilter): Promise<SongSummary[]> {
    const db = await this.getDb();
    const records = filter?.harpKey
      ? await db.getAllFromIndex(SONGS_STORE, 'harpKey', filter.harpKey)
      : await db.getAll(SONGS_STORE);

    const normalizedQuery = filter?.query?.trim().toLowerCase() ?? '';
    const matching: SongDocument[] = [];

    for (const raw of records) {
      const parsed = SongDocumentSchema.safeParse(raw);
      if (!parsed.success) continue;
      const doc = parsed.data;

      if (doc.deletedAt != null) continue;
      if (filter?.harpKey && doc.instrument.harpKey !== filter.harpKey) continue;
      if (filter?.timingMode && doc.timingMode !== filter.timingMode) continue;

      if (normalizedQuery) {
        const titleMatches = doc.title.toLowerCase().includes(normalizedQuery);
        const artistMatches = doc.artist?.toLowerCase().includes(normalizedQuery) ?? false;
        if (!titleMatches && !artistMatches) continue;
      }

      matching.push(doc);
    }

    matching.sort((a, b) => {
      const timeDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      if (timeDiff !== 0) return timeDiff;
      const isoCmp = b.updatedAt.localeCompare(a.updatedAt);
      if (isoCmp !== 0) return isoCmp;
      return b.revision - a.revision;
    });

    return matching.map(toSongSummary);
  }

  async get(id: string): Promise<SongDocument | null> {
    const db = await this.getDb();
    const raw = await db.get(SONGS_STORE, id);
    if (!raw) return null;

    const validated = SongDocumentSchema.parse(raw);
    if (validated.deletedAt != null) return null;
    return validated;
  }

  /**
   * Returns the raw record including soft-delete tombstones (useful for v2 sync engines and diagnostics).
   */
  async getRaw(id: string): Promise<SongDocument | null> {
    const db = await this.getDb();
    const raw = await db.get(SONGS_STORE, id);
    if (!raw) return null;
    return SongDocumentSchema.parse(raw);
  }

  async save(doc: SongDocument): Promise<SongDocument> {
    const validated = SongDocumentSchema.parse(doc);
    const db = await this.getDb();
    const tx = db.transaction(SONGS_STORE, 'readwrite');
    const existing = await tx.store.get(validated.id);

    const now = new Date().toISOString();
    const nextRevision = existing
      ? Math.max(existing.revision, validated.revision) + 1
      : 1;

    const nextDoc: SongDocument = SongDocumentSchema.parse({
      ...validated,
      createdAt: existing ? existing.createdAt : validated.createdAt,
      revision: nextRevision,
      updatedAt: now,
      deletedAt: validated.deletedAt ?? null,
    });

    await tx.store.put(nextDoc);
    await tx.done;
    return nextDoc;
  }

  async remove(id: string, options?: RemoveSongOptions): Promise<void> {
    const db = await this.getDb();
    if (options?.hard) {
      await db.delete(SONGS_STORE, id);
      return;
    }

    const tx = db.transaction(SONGS_STORE, 'readwrite');
    const existing = await tx.store.get(id);
    if (!existing) {
      await tx.done;
      return;
    }

    const now = new Date().toISOString();
    const tombstoned: SongDocument = SongDocumentSchema.parse({
      ...existing,
      revision: existing.revision + 1,
      updatedAt: now,
      deletedAt: now,
    });

    await tx.store.put(tombstoned);
    await tx.done;
  }

  async close(): Promise<void> {
    if (!this.dbPromise) return;
    const db = await this.dbPromise;
    db.close();
    this.dbPromise = null;
  }
}
