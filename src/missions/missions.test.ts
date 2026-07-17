import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GET as health } from "../../app/api/health/route.ts";
import { GET as getMission } from "../../app/api/missions/[id]/route.ts";
import { POST as createMission } from "../../app/api/missions/route.ts";
import { findMission, openMissionDatabase, saveMission, type MissionRecord } from "./store.ts";
import { MissionSchema, type CreateMission } from "../trips/schemas.ts";

process.env.AWAYDAY_DATABASE_PATH = ":memory:";

function missionInput(): CreateMission {
  return {
    request: "Coordinate this group arrival without breaking their rules",
    currency: "USD",
    event: { name: "Championship", venue: "City Ground", startsAt: "2030-06-14T20:00:00Z" },
    travelers: [
      { id: "traveler-a", name: "Alex", origin: "Boston", budgetCents: 80_000, approvalLimitCents: 10_000 },
      { id: "traveler-b", name: "Sam", origin: "Chicago", budgetCents: 90_000, approvalLimitCents: 12_000 },
    ],
    constraints: {
      totalBudgetCents: 170_000,
      refundableOnly: true,
      maximumFlightStops: 0,
      minimumArrivalBufferMinutes: 45,
    },
  };
}

function request(body: string, ip: string, origin = "http://localhost") {
  return new Request("http://localhost/api/missions", {
    method: "POST",
    headers: { "content-type": "application/json", origin, "x-forwarded-for": ip },
    body,
  });
}

async function payload<T>(response: Response) {
  return (await response.json()) as T;
}

describe("mission persistence", () => {
  it("survives a database close and reopen with private file permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "awayday-store-"));
    const path = join(directory, "missions.db");
    const mission = MissionSchema.parse({ id: "persisted-mission", ...missionInput() });
    try {
      const first = openMissionDatabase(path);
      saveMission(first, mission, new Date("2030-01-01T00:00:00Z"));
      first.close();

      const second = openMissionDatabase(path);
      const stored = findMission(second, mission.id);
      second.close();

      assert.deepEqual(stored?.mission, mission);
      assert.equal(stored?.createdAt, "2030-01-01T00:00:00.000Z");
      assert.equal(statSync(path).mode & 0o777, 0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("mission API", () => {
  it("reports live database health", async () => {
    const response = health();
    assert.equal(response.status, 200);
    assert.deepEqual(await payload(response), { data: { status: "ok", database: "ok" } });
  });

  it("creates a server-identified mission and reads it back", async () => {
    const created = await createMission(request(JSON.stringify(missionInput()), "create-read"));
    const createdBody = await payload<{ data: MissionRecord }>(created);
    assert.equal(created.status, 201);
    assert.match(createdBody.data.mission.id, /^[0-9a-f-]{36}$/);
    assert.equal(created.headers.get("cache-control"), "no-store");

    const found = await getMission(
      new Request(`http://localhost/api/missions/${createdBody.data.mission.id}`),
      { params: Promise.resolve({ id: createdBody.data.mission.id }) },
    );
    assert.equal(found.status, 200);
    assert.deepEqual(await payload(found), createdBody);
  });

  it("returns a stable not-found error", async () => {
    const response = await getMission(
      new Request("http://localhost/api/missions/missing-mission"),
      { params: Promise.resolve({ id: "missing-mission" }) },
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await payload(response), {
      error: { code: "MISSION_NOT_FOUND", message: "Mission not found" },
    });
  });

  it("rejects malformed and oversized JSON", async () => {
    const malformed = await createMission(request("{", "malformed"));
    assert.equal(malformed.status, 400);
    assert.equal((await payload<{ error: { code: string } }>(malformed)).error.code, "INVALID_JSON");

    const oversized = await createMission(request(JSON.stringify({ request: "x".repeat(70_000) }), "oversized"));
    assert.equal(oversized.status, 413);
    assert.equal((await payload<{ error: { code: string } }>(oversized)).error.code, "PAYLOAD_TOO_LARGE");
  });

  it("rejects invalid mission fields and cross-origin mutations", async () => {
    const invalid = await createMission(request(JSON.stringify({ ...missionInput(), currency: "dollars" }), "invalid"));
    assert.equal(invalid.status, 400);
    assert.equal((await payload<{ error: { code: string } }>(invalid)).error.code, "VALIDATION_ERROR");

    const crossOrigin = await createMission(
      request(JSON.stringify(missionInput()), "cross-origin", "https://attacker.example"),
    );
    assert.equal(crossOrigin.status, 403);
    assert.equal((await payload<{ error: { code: string } }>(crossOrigin)).error.code, "ORIGIN_FORBIDDEN");
  });

  it("rate limits repeated mission creation", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await createMission(request(JSON.stringify(missionInput()), "rate-limit"));
      assert.equal(response.status, 201);
    }
    const blocked = await createMission(request(JSON.stringify(missionInput()), "rate-limit"));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "60");
  });
});
