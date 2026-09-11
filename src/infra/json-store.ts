import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { z } from 'zod';
import {
  improvementLogSchema,
  rankHistoryEntrySchema,
  rankHistorySchema,
  watchwordsSchema,
} from '../core/schemas.js';
import type { ImprovementLog, RankHistory, RankHistoryEntry, Watchwords } from '../core/types.js';

export class JsonStoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'JsonStoreError';
  }
}

export async function readJsonFile<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new JsonStoreError(`failed to read ${path}: ${(err as Error).message}`, 'READ_FAILED');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new JsonStoreError(`invalid JSON in ${path}: ${(err as Error).message}`, 'INVALID_JSON');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new JsonStoreError(
      `schema validation failed for ${path}: ${result.error.message}`,
      'SCHEMA_INVALID',
    );
  }
  return result.data;
}

/** Writes JSON atomically: write to a temp file in the same directory, then rename. */
export async function writeJsonFileAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(tmpPath, content, 'utf8');
  try {
    await rename(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export function loadWatchwords(path: string): Promise<Watchwords> {
  return readJsonFile(path, watchwordsSchema) as Promise<Watchwords>;
}

export function loadRankHistory(path: string): Promise<RankHistory> {
  return readJsonFile(path, rankHistorySchema) as Promise<RankHistory>;
}

export function loadImprovementLog(path: string): Promise<ImprovementLog> {
  return readJsonFile(path, improvementLogSchema) as Promise<ImprovementLog>;
}

export function saveImprovementLog(path: string, log: ImprovementLog): Promise<void> {
  return writeJsonFileAtomic(path, log);
}

/**
 * The only write API for rank-history.json. Enforces append-only semantics:
 * rejects a duplicate (date, source) pair and never mutates existing entries.
 * See DESIGN.md section 6.
 */
export async function appendRankHistory(path: string, entry: RankHistoryEntry): Promise<RankHistory> {
  const parsedEntry = rankHistoryEntrySchema.parse(entry);
  const history = await loadRankHistory(path);
  const duplicate = history.entries.some(
    (e) => e.date === parsedEntry.date && e.source === parsedEntry.source,
  );
  if (duplicate) {
    throw new JsonStoreError(
      `duplicate rank-history entry for date=${parsedEntry.date} source=${parsedEntry.source}`,
      'DUPLICATE_ENTRY',
    );
  }
  const next: RankHistory = {
    schemaVersion: 1,
    entries: [...history.entries, parsedEntry],
  };
  await writeJsonFileAtomic(path, next);
  return next;
}
