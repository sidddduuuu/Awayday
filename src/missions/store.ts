import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ActionSchema,
  DisruptionSchema,
  ItinerarySchema,
  MissionSchema,
  type Action,
  type Disruption,
  type Itinerary,
  type Mission,
} from "../trips/schemas.ts";

export interface MissionRecord {
  mission: Mission;
  createdAt: string;
  updatedAt: string;
}

export interface ItineraryRecord extends Itinerary {
  missionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DisruptionRecord {
  missionId: string;
  disruption: Disruption;
  createdAt: string;
}

export interface ActionRecord {
  action: Action;
  updatedAt: string;
}

const globals = globalThis as typeof globalThis & {
  awaydayDatabase?: DatabaseSync;
  awaydayDatabasePath?: string;
};

function prepareFile(path: string) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return path;
}

export function openMissionDatabase(path: string) {
  const location = path === ":memory:" ? path : prepareFile(resolve(path));
  const database = new DatabaseSync(location, { allowExtension: false });
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (location !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    chmodSync(location, 0o600);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS itineraries (
      mission_id TEXT PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS disruptions (
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (mission_id, id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS actions (
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (mission_id, id)
    ) STRICT;
  `);
  return database;
}

export function missionDatabase() {
  const path = process.env.AWAYDAY_DATABASE_PATH || ".data/awayday.db";
  if (globals.awaydayDatabase && globals.awaydayDatabasePath !== path) {
    throw new Error("Database path cannot change after the connection is opened");
  }
  globals.awaydayDatabase ??= openMissionDatabase(path);
  globals.awaydayDatabasePath ??= path;
  return globals.awaydayDatabase;
}

export function saveMission(database: DatabaseSync, mission: Mission, now = new Date()): MissionRecord {
  const timestamp = now.toISOString();
  database.prepare(`
    INSERT INTO missions (id, payload, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(mission.id, JSON.stringify(mission), timestamp, timestamp);
  return { mission, createdAt: timestamp, updatedAt: timestamp };
}

export function findMission(database: DatabaseSync, id: string): MissionRecord | null {
  const row = database.prepare(`
    SELECT payload, created_at, updated_at
    FROM missions
    WHERE id = ?
  `).get(id);
  if (!row) return null;
  if (typeof row.payload !== "string" || typeof row.created_at !== "string" || typeof row.updated_at !== "string") {
    throw new Error("Stored mission row has an invalid shape");
  }
  return {
    mission: MissionSchema.parse(JSON.parse(row.payload)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function saveItinerary(
  database: DatabaseSync,
  missionId: string,
  itinerary: Itinerary,
  now = new Date(),
): ItineraryRecord {
  const timestamp = now.toISOString();
  database.prepare(`
    INSERT INTO itineraries (mission_id, payload, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (mission_id) DO UPDATE SET
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `).run(missionId, JSON.stringify(itinerary), timestamp, timestamp);
  const saved = findItinerary(database, missionId);
  if (!saved) throw new Error("Saved itinerary could not be read");
  return saved;
}

export function findItinerary(database: DatabaseSync, missionId: string): ItineraryRecord | null {
  const row = database.prepare(`
    SELECT payload, created_at, updated_at
    FROM itineraries
    WHERE mission_id = ?
  `).get(missionId);
  if (!row) return null;
  if (typeof row.payload !== "string" || typeof row.created_at !== "string" || typeof row.updated_at !== "string") {
    throw new Error("Stored itinerary row has an invalid shape");
  }
  return {
    missionId,
    ...ItinerarySchema.parse(JSON.parse(row.payload)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function disruptionRecord(missionId: string, row: Record<string, unknown>): DisruptionRecord {
  if (typeof row.payload !== "string" || typeof row.created_at !== "string") {
    throw new Error("Stored disruption row has an invalid shape");
  }
  return {
    missionId,
    disruption: DisruptionSchema.parse(JSON.parse(row.payload)),
    createdAt: row.created_at,
  };
}

export function findDisruption(
  database: DatabaseSync,
  missionId: string,
  disruptionId: string,
): DisruptionRecord | null {
  const row = database.prepare(`
    SELECT payload, created_at
    FROM disruptions
    WHERE mission_id = ? AND id = ?
  `).get(missionId, disruptionId);
  return row ? disruptionRecord(missionId, row) : null;
}

export function listDisruptions(database: DatabaseSync, missionId: string): DisruptionRecord[] {
  return database.prepare(`
    SELECT payload, created_at
    FROM disruptions
    WHERE mission_id = ?
  `).all(missionId)
    .map((row) => disruptionRecord(missionId, row))
    .toSorted((left, right) =>
      Date.parse(left.disruption.reportedAt) - Date.parse(right.disruption.reportedAt)
      || left.disruption.id.localeCompare(right.disruption.id));
}

export function saveDisruption(
  database: DatabaseSync,
  missionId: string,
  disruption: Disruption,
  now = new Date(),
): { record: DisruptionRecord; created: boolean } {
  const result = database.prepare(`
    INSERT INTO disruptions (mission_id, id, payload, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (mission_id, id) DO NOTHING
  `).run(missionId, disruption.id, JSON.stringify(disruption), now.toISOString());
  const record = findDisruption(database, missionId, disruption.id);
  if (!record) throw new Error("Saved disruption could not be read");
  return { record, created: Number(result.changes) === 1 };
}

function actionRecord(row: Record<string, unknown>): ActionRecord {
  if (
    typeof row.payload !== "string"
    || typeof row.created_at !== "string"
    || typeof row.updated_at !== "string"
  ) {
    throw new Error("Stored action row has an invalid shape");
  }
  const action = ActionSchema.parse(JSON.parse(row.payload));
  if (action.createdAt !== row.created_at) throw new Error("Stored action timestamps do not match");
  return { action, updatedAt: row.updated_at };
}

export function findAction(database: DatabaseSync, missionId: string, actionId: string): ActionRecord | null {
  const row = database.prepare(`
    SELECT payload, created_at, updated_at
    FROM actions
    WHERE mission_id = ? AND id = ?
  `).get(missionId, actionId);
  return row ? actionRecord(row) : null;
}

export function listActions(database: DatabaseSync, missionId: string): ActionRecord[] {
  return database.prepare(`
    SELECT payload, created_at, updated_at
    FROM actions
    WHERE mission_id = ?
    ORDER BY created_at, id
  `).all(missionId).map(actionRecord);
}

export function saveAction(database: DatabaseSync, action: Action, now = new Date()): ActionRecord {
  const updatedAt = now.toISOString();
  database.prepare(`
    INSERT INTO actions (mission_id, id, payload, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(action.missionId, action.id, JSON.stringify(action), action.createdAt, updatedAt);
  const saved = findAction(database, action.missionId, action.id);
  if (!saved) throw new Error("Saved action could not be read");
  return saved;
}

export function transitionActionStatus(
  database: DatabaseSync,
  missionId: string,
  actionId: string,
  from: Action["status"],
  to: Action["status"],
  now = new Date(),
) {
  const current = findAction(database, missionId, actionId);
  if (!current) return { outcome: "not_found" as const };
  if (current.action.status !== from) return { outcome: "conflict" as const, record: current };
  const next = ActionSchema.parse({ ...current.action, status: to });
  const updatedAt = now.toISOString();
  const result = database.prepare(`
    UPDATE actions
    SET payload = ?, updated_at = ?
    WHERE mission_id = ? AND id = ? AND json_extract(payload, '$.status') = ?
  `).run(JSON.stringify(next), updatedAt, missionId, actionId, from);
  if (Number(result.changes) !== 1) {
    const record = findAction(database, missionId, actionId);
    return { outcome: "conflict" as const, record };
  }
  return { outcome: "updated" as const, record: { action: next, updatedAt } };
}

export function databaseIsHealthy(database: DatabaseSync) {
  return database.prepare("SELECT 1 AS ok").get()?.ok === 1;
}
