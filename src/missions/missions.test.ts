import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GET as health } from "../../app/api/health/route.ts";
import { GET as getDisruptions, POST as createDisruption } from "../../app/api/missions/[id]/disruptions/route.ts";
import { GET as getItinerary, PUT as putItinerary } from "../../app/api/missions/[id]/itinerary/route.ts";
import { GET as getMission } from "../../app/api/missions/[id]/route.ts";
import { POST as createMission } from "../../app/api/missions/route.ts";
import {
  findItinerary,
  listDisruptions,
  findMission,
  openMissionDatabase,
  saveDisruption,
  saveItinerary,
  saveMission,
  type DisruptionRecord,
  type ItineraryRecord,
  type MissionRecord,
} from "./store.ts";
import type { ReadinessResult } from "../trips/readiness.ts";
import { MissionSchema, type CreateMission, type Disruption, type Itinerary } from "../trips/schemas.ts";

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

function itineraryInput(): Itinerary {
  return {
    legs: [
      {
        id: "airport-to-event",
        kind: "ground",
        travelerIds: ["traveler-a", "traveler-b"],
        startsAt: "2030-06-14T18:00:00Z",
        endsAt: "2030-06-14T19:00:00Z",
        status: "planned",
        departurePolicy: "flexible",
        arrivesAtEvent: true,
        refundable: true,
        stops: 0,
        cost: {
          totalCents: 40_000,
          allocations: [
            { travelerId: "traveler-a", amountCents: 20_000 },
            { travelerId: "traveler-b", amountCents: 20_000 },
          ],
        },
      },
    ],
  };
}

function disruptionInput(id = "delay-1", legId = "airport-to-event"): Disruption {
  return {
    id,
    legId,
    reportedAt: new Date(Date.now() - 1_000).toISOString(),
    impact: { type: "delay", minutes: 30, timing: "duration" },
  };
}

function request(body: string, ip: string, origin = "http://localhost") {
  return new Request("http://localhost/api/missions", {
    method: "POST",
    headers: { "content-type": "application/json", origin, "x-forwarded-for": ip },
    body,
  });
}

function itineraryRequest(missionId: string, body: string, ip: string, origin = "http://localhost") {
  return new Request(`http://localhost/api/missions/${missionId}/itinerary`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin, "x-forwarded-for": ip },
    body,
  });
}

function disruptionRequest(missionId: string, body: string, ip: string) {
  return new Request(`http://localhost/api/missions/${missionId}/disruptions`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost", "x-forwarded-for": ip },
    body,
  });
}

type ItineraryResponse = {
  data: { itinerary: ItineraryRecord; readiness: ReadinessResult };
};

type DisruptionResponse = {
  data: { disruption: DisruptionRecord; readiness: ReadinessResult };
};

type DisruptionsResponse = {
  data: { disruptions: DisruptionRecord[]; readiness: ReadinessResult };
};

async function payload<T>(response: Response) {
  return (await response.json()) as T;
}

async function createAssembledMission(key: string) {
  const created = await createMission(request(JSON.stringify(missionInput()), `${key}-mission`));
  const missionId = (await payload<{ data: MissionRecord }>(created)).data.mission.id;
  const assembled = await putItinerary(
    itineraryRequest(missionId, JSON.stringify(itineraryInput()), `${key}-itinerary`),
    { params: Promise.resolve({ id: missionId }) },
  );
  assert.equal(assembled.status, 200);
  return missionId;
}

describe("mission persistence", () => {
  it("survives a database close and reopen with private file permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "awayday-store-"));
    const path = join(directory, "missions.db");
    const mission = MissionSchema.parse({ id: "persisted-mission", ...missionInput() });
    const disruption = disruptionInput("persisted-delay");
    try {
      const first = openMissionDatabase(path);
      saveMission(first, mission, new Date("2030-01-01T00:00:00Z"));
      saveItinerary(first, mission.id, itineraryInput(), new Date("2030-01-01T00:01:00Z"));
      saveDisruption(first, mission.id, disruption, new Date("2030-01-01T00:02:00Z"));
      first.close();

      const second = openMissionDatabase(path);
      const stored = findMission(second, mission.id);
      const storedItinerary = findItinerary(second, mission.id);
      const storedDisruptions = listDisruptions(second, mission.id);
      second.close();

      assert.deepEqual(stored?.mission, mission);
      assert.equal(stored?.createdAt, "2030-01-01T00:00:00.000Z");
      assert.deepEqual(storedItinerary?.legs, itineraryInput().legs);
      assert.equal(storedItinerary?.createdAt, "2030-01-01T00:01:00.000Z");
      assert.deepEqual(storedDisruptions.map(({ disruption: item }) => item), [disruption]);
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

  it("assembles, replaces, and reads a mission itinerary with derived readiness", async () => {
    const created = await createMission(request(JSON.stringify(missionInput()), "itinerary-create"));
    const missionId = (await payload<{ data: MissionRecord }>(created)).data.mission.id;
    const first = await putItinerary(
      itineraryRequest(missionId, JSON.stringify(itineraryInput()), "itinerary-save"),
      { params: Promise.resolve({ id: missionId }) },
    );
    const firstBody = await payload<ItineraryResponse>(first);
    assert.equal(first.status, 200);
    assert.deepEqual(firstBody.data.itinerary.legs, itineraryInput().legs);
    assert.equal(firstBody.data.readiness.status, "ready");
    assert.equal(firstBody.data.readiness.totalCostCents, 40_000);

    const original = itineraryInput();
    const replacement = { legs: [{ ...original.legs[0], id: "airport-to-event-v2" }] };
    const replaced = await putItinerary(
      itineraryRequest(missionId, JSON.stringify(replacement), "itinerary-replace"),
      { params: Promise.resolve({ id: missionId }) },
    );
    const replacedBody = await payload<ItineraryResponse>(replaced);
    assert.equal(replacedBody.data.itinerary.createdAt, firstBody.data.itinerary.createdAt);

    const found = await getItinerary(
      new Request(`http://localhost/api/missions/${missionId}/itinerary`),
      { params: Promise.resolve({ id: missionId }) },
    );
    const foundBody = await payload<ItineraryResponse>(found);
    assert.equal(found.status, 200);
    assert.deepEqual(foundBody.data.itinerary.legs, replacement.legs);
    assert.equal(foundBody.data.readiness.status, "ready");
  });

  it("rejects invalid itinerary ownership and missing resources", async () => {
    const missingMission = await putItinerary(
      itineraryRequest("missing-mission", JSON.stringify(itineraryInput()), "missing-itinerary-mission"),
      { params: Promise.resolve({ id: "missing-mission" }) },
    );
    assert.equal(missingMission.status, 404);

    const created = await createMission(request(JSON.stringify(missionInput()), "itinerary-errors"));
    const missionId = (await payload<{ data: MissionRecord }>(created)).data.mission.id;
    const noItinerary = await getItinerary(
      new Request(`http://localhost/api/missions/${missionId}/itinerary`),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal(noItinerary.status, 404);

    const original = itineraryInput();
    const invalid = {
      legs: [{
        ...original.legs[0],
        cost: { totalCents: 20_000, allocations: [{ travelerId: "traveler-c", amountCents: 20_000 }] },
      }],
    };
    const invalidTraveler = await putItinerary(
      itineraryRequest(missionId, JSON.stringify(invalid), "invalid-itinerary-traveler"),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal(invalidTraveler.status, 400);

    const crossOrigin = await putItinerary(
      itineraryRequest(missionId, JSON.stringify(itineraryInput()), "itinerary-cross-origin", "https://attacker.example"),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal(crossOrigin.status, 403);
  });

  it("ingests a disruption idempotently and recomputes live readiness", async () => {
    const missionId = await createAssembledMission("disruption-live");
    const disruption = disruptionInput();
    const created = await createDisruption(
      disruptionRequest(missionId, JSON.stringify(disruption), "disruption-create"),
      { params: Promise.resolve({ id: missionId }) },
    );
    const createdBody = await payload<DisruptionResponse>(created);
    assert.equal(created.status, 201);
    assert.equal(createdBody.data.readiness.status, "at_risk");

    const repeated = await createDisruption(
      disruptionRequest(missionId, JSON.stringify(disruption), "disruption-repeat"),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal(repeated.status, 200);

    const listed = await getDisruptions(
      new Request(`http://localhost/api/missions/${missionId}/disruptions`),
      { params: Promise.resolve({ id: missionId }) },
    );
    const listedBody = await payload<DisruptionsResponse>(listed);
    assert.equal(listedBody.data.disruptions.length, 1);
    assert.equal(listedBody.data.readiness.status, "at_risk");

    const itinerary = await getItinerary(
      new Request(`http://localhost/api/missions/${missionId}/itinerary`),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal((await payload<ItineraryResponse>(itinerary)).data.readiness.status, "at_risk");
  });

  it("rejects conflicting disruption IDs and unknown legs", async () => {
    const missionId = await createAssembledMission("disruption-errors");
    const disruption = disruptionInput("delay-conflict");
    await createDisruption(
      disruptionRequest(missionId, JSON.stringify(disruption), "disruption-first"),
      { params: Promise.resolve({ id: missionId }) },
    );

    const conflict: Disruption = {
      ...disruption,
      impact: { type: "delay", minutes: 45, timing: "duration" },
    };
    const conflicted = await createDisruption(
      disruptionRequest(missionId, JSON.stringify(conflict), "disruption-conflict"),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal(conflicted.status, 409);

    const unknownLeg = disruptionInput("unknown-leg-delay", "missing-leg");
    const invalid = await createDisruption(
      disruptionRequest(missionId, JSON.stringify(unknownLeg), "disruption-unknown-leg"),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal(invalid.status, 400);
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
