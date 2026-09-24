/**
 * FileTaskStorage: the durable TaskStorage adapter (BG-13 / issue #65).
 *
 * The TaskStorage interface, TaskRecord / Subscription / TaskEvent schema and the
 * InMemoryTaskStorage adapter live in ./task-storage.ts (BG-01). This module is the second
 * adapter the two-adapter rule requires; the interface is unchanged.
 *
 * Layout under the injected base directory (ADR-0022 where it speaks):
 *   - tasks/<taskId>.json                         one TaskRecord per file (ADR-0022 "What we add" §3:
 *                                                 persisted to <sessionDir>/tasks/<taskId>.json)
 *   - subscriptions/<subscriberId>-<taskId>.json  one Subscription per file (§5: persisted to
 *                                                 <sessionDir>/subscriptions/<subscriberId>-<taskId>.json)
 *   - events/<subscriberId>-<taskId>.jsonl        append-only newline-delimited TaskEvent log
 *
 * ADR-0022 §5 (What we add) documents the event log as "<sessionDir>/event-log/<eventId>.json"
 * indexed by (subscriptionId, cursor). Issue #65 deliberately overrides that with the
 * subscriber-partitioned JSONL file above: one file per (subscriberId, taskId) pairs the
 * subscriber's tasks, and loadEvents(subscriberId, since) merges those files back into one
 * ULID-ordered stream. That keeps the event log keyed by the SUBSCRIBER (BG-01's fixed bug and
 * the TaskStorage interface contract), while giving the log O(1) appends and a cursor scan per
 * file instead of one small file per event.
 *
 * Design notes:
 *
 * - **Atomic JSON writes.** saveTask / saveSubscription write to a sibling temp path
 *   ("<target>.tmp-<uuid>") and then fs.rename onto the target, so a crash never leaves a
 *   half-written record (issue #65 requirement 3). Parent directories are created on demand.
 *   The event log is append-only and is therefore appended in place (appendFile), not rewritten.
 *
 * - **Explicit errors, never a silent empty read.** A missing file is the interface's
 *   "absent" state (loadTask/loadSubscription return null; an absent event log yields nothing).
 *   A file that exists but does not parse throws a descriptive Error naming the path — the
 *   caller must not be able to mistake corruption for absence (issue #65 requirement 4).
 *
 * - **DI seam.** The constructor takes the base directory plus an optional options object whose
 *   fs field defaults to node:fs/promises. Tests inject a delegating facade to force an IO
 *   failure (EACCES on read, ENOSPC on rename) that a temp-dir test cannot produce portably.
 *
 * - **Complexity.** loadTask / loadSubscription / saveTask / saveSubscription / deleteTask are
 *   O(1) filesystem calls on one file; listTasks is O(files). appendEvents is O(k) reads/appends
 *   for a k-event batch: it checks ownership with one direct loadSubscription per distinct taskId
 *   (never a scan of subscriptions/), then appends without rewriting the log. A run-level
 *   subscriber's N appends are therefore O(N), not O(N^2). The only O(s) subscription scan
 *   (s = files in subscriptions/) is the empty-batch / error-message path and loadEvents, which
 *   reads the subscriber's files and sorts the merged result in O(s + E log E), E = events yielded.
 */

import { ok as assertPresent } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  Subscription,
  TaskEvent,
  TaskFilter,
  TaskRecord,
  TaskStorage,
  ULID,
} from "./task-storage.ts";

/**
 * The subset of node:fs/promises FileTaskStorage uses, so tests can inject a delegating facade
 * and force an IO failure. Every method mirrors the node:fs/promises signature it is wired to.
 */
export interface TaskStorageFs {
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  readFile(path: string, options: { encoding: "utf8" }): Promise<string>;
  writeFile(path: string, data: string, options: { encoding: "utf8" }): Promise<void>;
  appendFile(path: string, data: string, options: { encoding: "utf8" }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
}

/** Constructor options; fs defaults to node:fs/promises. */
export interface FileTaskStorageOptions {
  fs?: TaskStorageFs;
}

const DEFAULT_FS: TaskStorageFs = {
  mkdir: (path, options) => mkdir(path, options),
  readFile: (path, options) => readFile(path, options),
  writeFile: (path, data, options) => writeFile(path, data, options),
  appendFile: (path, data, options) => appendFile(path, data, options),
  rename: (oldPath, newPath) => rename(oldPath, newPath),
  unlink: (path) => unlink(path),
  readdir: (path) => readdir(path),
};

/** True for the one readdir/readFile failure that means "absent", not "IO broke". */
function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareEventId(a: TaskEvent, b: TaskEvent): number {
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/**
 * File-backed TaskStorage rooted at baseDir. Creates directories lazily; never scans more than
 * the directory it needs. All IO goes through the injected TaskStorageFs.
 */
export class FileTaskStorage implements TaskStorage {
  readonly #baseDir: string;
  readonly #fs: TaskStorageFs;

  constructor(baseDir: string, options: FileTaskStorageOptions = {}) {
    if (baseDir.length === 0) {
      throw new TypeError("FileTaskStorage: baseDir is required");
    }
    this.#baseDir = baseDir;
    this.#fs = options.fs ?? DEFAULT_FS;
  }

  // -- task CRUD -------------------------------------------------------------

  /** O(1) read of tasks/<taskId>.json; null on ENOENT, throw on corruption. */
  async loadTask(taskId: ULID): Promise<TaskRecord | null> {
    return await this.#readJson<TaskRecord>(this.#taskPath(taskId));
  }

  /** Atomic write (temp + rename) of tasks/<taskId>.json. */
  async saveTask(record: TaskRecord): Promise<void> {
    assertPresent(record, "saveTask: record is required");
    await this.#writeJson(this.#taskPath(record.id), record);
  }

  /** Unlink tasks/<taskId>.json; rejects when the file is absent. */
  async deleteTask(taskId: ULID): Promise<void> {
    const path = this.#taskPath(taskId);
    if (!(await this.#exists(path))) {
      throw new Error("deleteTask: unknown taskId " + taskId);
    }
    await this.#fs.unlink(path);
  }

  /** O(files) scan of tasks/, applying the TaskFilter's exact-match predicates. */
  async *listTasks(filter?: TaskFilter): AsyncIterable<TaskRecord> {
    const dir = this.#tasksDir();
    for (const name of (await this.#readdirOrEmpty(dir)).sort()) {
      if (!name.endsWith(".json")) continue;
      const record = await this.#readJson<TaskRecord>(join(dir, name));
      // A file that disappeared between readdir and read is a concurrent delete, not corruption.
      if (record === null) continue;
      if (filter?.status !== undefined && record.status !== filter.status) continue;
      if (filter?.label !== undefined && record.label !== filter.label) continue;
      yield record;
    }
  }

  // -- subscription CRUD -----------------------------------------------------

  /** O(1) read of subscriptions/<subscriberId>-<taskId>.json. */
  async loadSubscription(subscriberId: ULID, taskId: ULID): Promise<Subscription | null> {
    return await this.#readJson<Subscription>(this.#subPath(subscriberId, taskId));
  }

  /** Atomic write of subscriptions/<subscriberId>-<taskId>.json. */
  async saveSubscription(sub: Subscription): Promise<void> {
    assertPresent(sub, "saveSubscription: sub is required");
    await this.#writeJson(this.#subPath(sub.subscriberId, sub.taskId), sub);
  }

  // -- event log -------------------------------------------------------------

  /**
   * Append the incoming events to each event file, sorted by eventId within the batch. Rejects
   * when the subscriber is unknown or owns no Subscription for one of the events' tasks (the
   * file log is partitioned by (subscriberId, taskId); an undiscoverable event is an error, not
   * a silent drop). Empty batches are a no-op after the subscriber check, matching InMemory.
   */
  async appendEvents(subscriptionId: ULID, events: TaskEvent[]): Promise<void> {
    if (events.length === 0) {
      // Check order matches InMemoryTaskStorage: an empty batch still rejects an unknown subscriber.
      if ((await this.#subscriptionsFor(subscriptionId)).length === 0) {
        throw new Error("appendEvents: unknown subscriptionId " + subscriptionId);
      }
      return;
    }
    const byTask = new Map<ULID, TaskEvent[]>();
    for (const event of events) {
      const group = byTask.get(event.taskId);
      if (group === undefined) byTask.set(event.taskId, [event]);
      else group.push(event);
    }
    // O(1) per distinct (subscriberId, taskId) subscription check on the common path: a
    // run-level subscriber appends once per task, so scanning every subscription file here would
    // be O(N^2). Only the error path pays for that scan, to choose the right message.
    let missingTaskId: ULID | undefined;
    for (const taskId of byTask.keys()) {
      if ((await this.loadSubscription(subscriptionId, taskId)) === null) {
        missingTaskId = taskId;
        break;
      }
    }
    if (missingTaskId !== undefined) {
      if ((await this.#subscriptionsFor(subscriptionId)).length === 0) {
        throw new Error("appendEvents: unknown subscriptionId " + subscriptionId);
      }
      throw new Error(
        "appendEvents: no subscription for subscriber " +
          subscriptionId +
          " on task " +
          missingTaskId,
      );
    }
    await this.#fs.mkdir(this.#eventsDir(), { recursive: true });
    for (const [taskId, group] of byTask) {
      const ordered = group.every(
        (event, index) => index === 0 || compareEventId(group[index - 1] as TaskEvent, event) <= 0,
      )
        ? group
        : [...group].sort(compareEventId);
      const payload = ordered.map((event) => JSON.stringify(event)).join("\n") + "\n";
      await this.#fs.appendFile(this.#eventPath(subscriptionId, taskId), payload, {
        encoding: "utf8",
      });
    }
  }

  /**
   * Merge the subscriber's per-task event files, filter to eventId > since, yield in ULID order.
   * Throws for an unknown subscriber (constraint #3: a typo must not look like "no events").
   */
  async *loadEvents(subscriptionId: ULID, since?: ULID): AsyncIterable<TaskEvent> {
    const subscriptions = await this.#subscriptionsFor(subscriptionId);
    if (subscriptions.length === 0) {
      throw new Error("loadEvents: unknown subscriptionId " + subscriptionId);
    }
    const merged: TaskEvent[] = [];
    for (const sub of subscriptions) {
      merged.push(...(await this.#readEvents(this.#eventPath(subscriptionId, sub.taskId))));
    }
    merged.sort(compareEventId);
    for (const event of merged) {
      if (since !== undefined && event.eventId <= since) continue;
      yield event;
    }
  }

  // -- internals -------------------------------------------------------------

  /** Every Subscription row whose subscriberId matches; empty when none exist. */
  async #subscriptionsFor(subscriberId: ULID): Promise<Subscription[]> {
    const dir = this.#subsDir();
    const matches: Subscription[] = [];
    for (const name of await this.#readdirOrEmpty(dir)) {
      if (!name.endsWith(".json")) continue;
      const sub = await this.#readJson<Subscription>(join(dir, name));
      if (sub !== null && sub.subscriberId === subscriberId) matches.push(sub);
    }
    return matches;
  }

  /** Read + parse one JSON object; null on ENOENT. Throws a path-naming error on corruption. */
  async #readJson<T>(path: string): Promise<T | null> {
    let raw: string;
    try {
      raw = await this.#fs.readFile(path, { encoding: "utf8" });
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
    return this.#parseJson<T>(path, raw);
  }

  /** Parse a JSON object, or throw an explicit corruption error naming the file. */
  #parseJson<T>(path: string, raw: string): T {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error("FileTaskStorage: corrupt JSON in " + path + ": " + errorText(error));
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("FileTaskStorage: corrupt JSON in " + path + ": expected a JSON object");
    }
    return value as T;
  }

  /** Read one JSONL event log; empty on ENOENT; throws on a corrupt line. */
  async #readEvents(path: string): Promise<TaskEvent[]> {
    let raw: string;
    try {
      raw = await this.#fs.readFile(path, { encoding: "utf8" });
    } catch (error) {
      if (isEnoent(error)) return [];
      throw error;
    }
    const events: TaskEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch (error) {
        throw new Error("FileTaskStorage: corrupt event JSON in " + path + ": " + errorText(error));
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(
          "FileTaskStorage: corrupt event JSON in " + path + ": expected a JSON object",
        );
      }
      events.push(value as TaskEvent);
    }
    return events;
  }

  /** Write value as pretty JSON to path via a sibling temp file + rename (atomic). */
  async #writeJson(path: string, value: unknown): Promise<void> {
    await this.#fs.mkdir(dirname(path), { recursive: true });
    const tempPath = path + ".tmp-" + randomUUID();
    await this.#fs.writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8" });
    await this.#fs.rename(tempPath, path);
  }

  /** readdir, treating a missing directory as empty rather than an error. */
  async #readdirOrEmpty(dir: string): Promise<string[]> {
    try {
      return await this.#fs.readdir(dir);
    } catch (error) {
      if (isEnoent(error)) return [];
      throw error;
    }
  }

  /** True when path is readable; a non-ENOENT read failure propagates. */
  async #exists(path: string): Promise<boolean> {
    try {
      await this.#fs.readFile(path, { encoding: "utf8" });
      return true;
    } catch (error) {
      if (isEnoent(error)) return false;
      throw error;
    }
  }

  #tasksDir(): string {
    return join(this.#baseDir, "tasks");
  }

  #subsDir(): string {
    return join(this.#baseDir, "subscriptions");
  }

  #eventsDir(): string {
    return join(this.#baseDir, "events");
  }

  #taskPath(taskId: ULID): string {
    return join(this.#tasksDir(), taskId + ".json");
  }

  #subPath(subscriberId: ULID, taskId: ULID): string {
    return join(this.#subsDir(), subscriberId + "-" + taskId + ".json");
  }

  #eventPath(subscriberId: ULID, taskId: ULID): string {
    return join(this.#eventsDir(), subscriberId + "-" + taskId + ".jsonl");
  }
}

/** Convenience factory mirroring createTaskRegistry (session-runtime workstream imports this). */
export function createFileTaskStorage(
  baseDir: string,
  options?: FileTaskStorageOptions,
): FileTaskStorage {
  return new FileTaskStorage(baseDir, options);
}
