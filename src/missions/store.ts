import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ItinerarySchema, MissionSchema, type Itinerary, type Mission } from "../trips/schemas.ts";

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

export function databaseIsHealthy(database: DatabaseSync) {
  return database.prepare("SELECT 1 AS ok").get()?.ok === 1;
}
