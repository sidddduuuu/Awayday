import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signData } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { GET as health } from "../../app/api/health/route.ts";
import { POST as ingestNexlaDisruption } from "../../app/api/integrations/nexla/disruptions/route.ts";
import { GET as getActions, POST as createAction } from "../../app/api/missions/[id]/actions/route.ts";
import { POST as decideAction } from "../../app/api/missions/[id]/actions/[actionId]/decision/route.ts";
import { GET as getDisruptions, POST as createDisruption } from "../../app/api/missions/[id]/disruptions/route.ts";
import { GET as getItinerary, PUT as putItinerary } from "../../app/api/missions/[id]/itinerary/route.ts";
import { GET as getMission } from "../../app/api/missions/[id]/route.ts";
import { POST as createMission } from "../../app/api/missions/route.ts";
import {
  findItinerary,
  findOwnedMission,
  listActions,
  listDisruptions,
  findMissionForIntegration,
  openMissionDatabase,
  saveAction,
  saveDisruption,
  saveItinerary,
  saveMission,
  type DisruptionRecord,
  type ActionRecord,
  type ItineraryRecord,
  type MissionRecord,
} from "./store.ts";
import type { ReadinessResult } from "../trips/readiness.ts";
import {
  ActionSchema,
  MissionSchema,
  type CreateAction,
  type CreateMission,
  type Disruption,
  type Itinerary,
} from "../trips/schemas.ts";

process.env.AWAYDAY_DATABASE_PATH = ":memory:";

const authKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const publicJwk = {
  ...authKeys.publicKey.export({ format: "jwk" }),
  alg: "ES256",
  kid: "awayday-test-key",
  use: "sig",
};
const previousPomeriumRoute = process.env.POMERIUM_ROUTE_URL;
let publicOrigin = "http://127.0.0.1";
const jwksServer = createServer((request, response) => {
  if (request.url !== "/.well-known/pomerium/jwks.json") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ keys: [publicJwk] }));
});

before(async () => {
  jwksServer.listen(0, "127.0.0.1");
  await once(jwksServer, "listening");
  const address = jwksServer.address();
  if (!address || typeof address === "string") throw new Error("JWKS test server did not start");
  publicOrigin = `http://127.0.0.1:${address.port}`;
  process.env.POMERIUM_ROUTE_URL = publicOrigin;
});

after(async () => {
  jwksServer.close();
  await once(jwksServer, "close");
  if (previousPomeriumRoute === undefined) delete process.env.POMERIUM_ROUTE_URL;
  else process.env.POMERIUM_ROUTE_URL = previousPomeriumRoute;
});

function encodeJwtPart(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function authToken(
  subject: string,
  audience = new URL(publicOrigin).hostname,
  expiresAt = Math.floor(Date.now() / 1_000) + 300,
) {
  const now = Math.floor(Date.now() / 1_000);
  const header = encodeJwtPart({ alg: "ES256", kid: publicJwk.kid, typ: "JWT" });
  const payload = encodeJwtPart({ aud: audience, exp: expiresAt, iat: now, iss: new URL(publicOrigin).hostname, sub: subject });
  const message = `${header}.${payload}`;
  const signature = signData("sha256", Buffer.from(message), {
    key: authKeys.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${message}.${signature}`;
}

function authenticatedRequest(path: string, ownerId: string, audience?: string) {
  return new Request(`${publicOrigin}${path}`, {
    headers: { "x-pomerium-jwt-assertion": authToken(ownerId, audience) },
  });
}

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

function actionInput(costDeltaCents = 5_000): CreateAction {
  return {
    kind: "rebook",
    affectedLegIds: ["airport-to-event"],
    costDeltaCents,
    explanation: "Replace the delayed transfer with an available alternative",
  };
}

function request(body: string, ip: string, origin = publicOrigin, ownerId = ip) {
  return new Request(`${publicOrigin}/api/missions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "x-forwarded-for": ip,
      "x-pomerium-jwt-assertion": authToken(ownerId),
    },
    body,
  });
}

function itineraryRequest(missionId: string, body: string, ip: string, origin = publicOrigin, ownerId = ip) {
  return new Request(`${publicOrigin}/api/missions/${missionId}/itinerary`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      origin,
      "x-forwarded-for": ip,
      "x-pomerium-jwt-assertion": authToken(ownerId),
    },
    body,
  });
}

function disruptionRequest(missionId: string, body: string, ip: string, ownerId = ip) {
  return new Request(`${publicOrigin}/api/missions/${missionId}/disruptions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: publicOrigin,
      "x-forwarded-for": ip,
      "x-pomerium-jwt-assertion": authToken(ownerId),
    },
    body,
  });
}

function nexlaRequest(body: string, key: string, ip: string) {
  return new Request(`${publicOrigin}/api/integrations/nexla/disruptions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-awayday-ingest-key": key,
      "x-forwarded-for": ip,
    },
    body,
  });
}

function actionRequest(missionId: string, body: string, ip: string, ownerId = ip) {
  return new Request(`${publicOrigin}/api/missions/${missionId}/actions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: publicOrigin,
      "x-forwarded-for": ip,
      "x-pomerium-jwt-assertion": authToken(ownerId),
    },
    body,
  });
}

function decisionRequest(
  missionId: string,
  actionId: string,
  decision: "approve" | "reject",
  ip: string,
  ownerId = ip,
) {
  return new Request(`${publicOrigin}/api/missions/${missionId}/actions/${actionId}/decision`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: publicOrigin,
      "x-forwarded-for": ip,
      "x-pomerium-jwt-assertion": authToken(ownerId),
    },
    body: JSON.stringify({ decision }),
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

type ActionsResponse = { data: { actions: ActionRecord[] } };

async function payload<T>(response: Response) {
  return (await response.json()) as T;
}

async function createAssembledMission(key: string) {
  const created = await createMission(request(JSON.stringify(missionInput()), `${key}-mission`, publicOrigin, key));
  const missionId = (await payload<{ data: MissionRecord }>(created)).data.mission.id;
  const assembled = await putItinerary(
    itineraryRequest(missionId, JSON.stringify(itineraryInput()), `${key}-itinerary`, publicOrigin, key),
    { params: Promise.resolve({ id: missionId }) },
  );
  assert.equal(assembled.status, 200);
  return { missionId, ownerId: key };
}

describe("mission persistence", () => {
  it("survives a database close and reopen with private file permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "awayday-store-"));
    const path = join(directory, "missions.db");
    const mission = MissionSchema.parse({ id: "persisted-mission", ...missionInput() });
    const disruption = disruptionInput("persisted-delay");
    const action = ActionSchema.parse({
      id: "persisted-action",
      missionId: mission.id,
      ...actionInput(),
      status: "approved",
      requiresApproval: false,
      createdAt: "2030-01-01T00:03:00.000Z",
    });
    try {
      const first = openMissionDatabase(path);
      saveMission(first, mission, "persist-owner", new Date("2030-01-01T00:00:00Z"));
      saveItinerary(first, mission.id, itineraryInput(), new Date("2030-01-01T00:01:00Z"));
      saveDisruption(first, mission.id, disruption, new Date("2030-01-01T00:02:00Z"));
      saveAction(first, action, new Date("2030-01-01T00:03:00Z"));
      first.close();

      const second = openMissionDatabase(path);
      const stored = findMissionForIntegration(second, mission.id);
      const owned = findOwnedMission(second, mission.id, "persist-owner");
      const hidden = findOwnedMission(second, mission.id, "other-owner");
      const storedItinerary = findItinerary(second, mission.id);
      const storedDisruptions = listDisruptions(second, mission.id);
      const storedActions = listActions(second, mission.id);
      second.close();

      assert.deepEqual(stored?.mission, mission);
      assert.deepEqual(owned?.mission, mission);
      assert.equal(hidden, null);
      assert.equal(stored?.createdAt, "2030-01-01T00:00:00.000Z");
      assert.deepEqual(storedItinerary?.legs, itineraryInput().legs);
      assert.equal(storedItinerary?.createdAt, "2030-01-01T00:01:00.000Z");
      assert.deepEqual(storedDisruptions.map(({ disruption: item }) => item), [disruption]);
      assert.deepEqual(storedActions.map(({ action: item }) => item), [action]);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps legacy ownerless missions inaccessible after migration", () => {
    const directory = mkdtempSync(join(tmpdir(), "awayday-legacy-store-"));
    const path = join(directory, "missions.db");
    const mission = MissionSchema.parse({ id: "legacy-mission", ...missionInput() });
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE missions (
          id TEXT PRIMARY KEY,
          payload TEXT NOT NULL CHECK (json_valid(payload)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT
      `);
      legacy.prepare(`
        INSERT INTO missions (id, payload, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(mission.id, JSON.stringify(mission), "2030-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z");
      legacy.close();

      const migrated = openMissionDatabase(path);
      const unscoped = findMissionForIntegration(migrated, mission.id);
      const owned = findOwnedMission(migrated, mission.id, "new-owner");
      migrated.close();

      assert.deepEqual(unscoped?.mission, mission);
      assert.equal(owned, null);
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
      authenticatedRequest(`/api/missions/${createdBody.data.mission.id}`, "create-read"),
      { params: Promise.resolve({ id: createdBody.data.mission.id }) },
    );
    assert.equal(found.status, 200);
    assert.deepEqual(await payload(found), createdBody);

    const hidden = await getMission(
      authenticatedRequest(`/api/missions/${createdBody.data.mission.id}`, "other-owner"),
      { params: Promise.resolve({ id: createdBody.data.mission.id }) },
    );
    assert.equal(hidden.status, 404);
  });

  it("requires a valid signed Pomerium assertion", async () => {
    const missing = new Request(`${publicOrigin}/api/missions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: publicOrigin },
      body: JSON.stringify(missionInput()),
    });
    const missingResponse = await createMission(missing);
    assert.equal(missingResponse.status, 401);
    assert.equal((await payload<{ error: { code: string } }>(missingResponse)).error.code, "AUTH_REQUIRED");

    const wrongAudience = request(JSON.stringify(missionInput()), "wrong-audience");
    wrongAudience.headers.set("x-pomerium-jwt-assertion", authToken("wrong-audience", "other.example.com"));
    assert.equal((await createMission(wrongAudience)).status, 401);

    const expired = request(JSON.stringify(missionInput()), "expired");
    expired.headers.set("x-pomerium-jwt-assertion", authToken("expired", undefined, 1));
    assert.equal((await createMission(expired)).status, 401);

    const tampered = request(JSON.stringify(missionInput()), "tampered");
    const token = authToken("tampered");
    const signatureStart = token.lastIndexOf(".") + 1;
    const changed = token[signatureStart] === "A" ? "B" : "A";
    tampered.headers.set("x-pomerium-jwt-assertion", `${token.slice(0, signatureStart)}${changed}${token.slice(signatureStart + 1)}`);
    assert.equal((await createMission(tampered)).status, 401);
  });

  it("assembles, replaces, and reads a mission itinerary with derived readiness", async () => {
    const created = await createMission(request(JSON.stringify(missionInput()), "itinerary-create"));
    const missionId = (await payload<{ data: MissionRecord }>(created)).data.mission.id;
    const first = await putItinerary(
      itineraryRequest(missionId, JSON.stringify(itineraryInput()), "itinerary-save", publicOrigin, "itinerary-create"),
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
      itineraryRequest(missionId, JSON.stringify(replacement), "itinerary-replace", publicOrigin, "itinerary-create"),
      { params: Promise.resolve({ id: missionId }) },
    );
    const replacedBody = await payload<ItineraryResponse>(replaced);
    assert.equal(replacedBody.data.itinerary.createdAt, firstBody.data.itinerary.createdAt);

    const found = await getItinerary(
      authenticatedRequest(`/api/missions/${missionId}/itinerary`, "itinerary-create"),
      { params: Promise.resolve({ id: missionId }) },
    );
    const foundBody = await payload<ItineraryResponse>(found);
    assert.equal(found.status, 200);
    assert.deepEqual(foundBody.data.itinerary.legs, replacement.legs);
    assert.equal(foundBody.data.readiness.status, "ready");

    const hidden = await getItinerary(
      authenticatedRequest(`/api/missions/${missionId}/itinerary`, "other-owner"),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal(hidden.status, 404);
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
      authenticatedRequest(`/api/missions/${missionId}/itinerary`, "itinerary-errors"),
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
      itineraryRequest(
        missionId,
        JSON.stringify(invalid),
        "invalid-itinerary-traveler",
        publicOrigin,
        "itinerary-errors",
      ),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal(invalidTraveler.status, 400);

    const crossOrigin = await putItinerary(
      itineraryRequest(
        missionId,
        JSON.stringify(itineraryInput()),
        "itinerary-cross-origin",
        "https://attacker.example",
        "itinerary-errors",
      ),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal(crossOrigin.status, 403);
  });

  it("ingests a disruption idempotently and recomputes live readiness", async () => {
    const { missionId, ownerId } = await createAssembledMission("disruption-live");
    const disruption = disruptionInput();
    const created = await createDisruption(
      disruptionRequest(missionId, JSON.stringify(disruption), "disruption-create", ownerId),
      { params: Promise.resolve({ id: missionId }) },
    );
    const createdBody = await payload<DisruptionResponse>(created);
    assert.equal(created.status, 201);
    assert.equal(createdBody.data.readiness.status, "at_risk");

    const repeated = await createDisruption(
      disruptionRequest(missionId, JSON.stringify(disruption), "disruption-repeat", ownerId),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal(repeated.status, 200);

    const listed = await getDisruptions(
      authenticatedRequest(`/api/missions/${missionId}/disruptions`, ownerId),
      { params: Promise.resolve({ id: missionId }) },
    );
    const listedBody = await payload<DisruptionsResponse>(listed);
    assert.equal(listedBody.data.disruptions.length, 1);
    assert.equal(listedBody.data.readiness.status, "at_risk");

    const hidden = await getDisruptions(
      authenticatedRequest(`/api/missions/${missionId}/disruptions`, "other-owner"),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal(hidden.status, 404);

    const itinerary = await getItinerary(
      authenticatedRequest(`/api/missions/${missionId}/itinerary`, ownerId),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal((await payload<ItineraryResponse>(itinerary)).data.readiness.status, "at_risk");
  });

  it("rejects conflicting disruption IDs and unknown legs", async () => {
    const { missionId, ownerId } = await createAssembledMission("disruption-errors");
    const disruption = disruptionInput("delay-conflict");
    await createDisruption(
      disruptionRequest(missionId, JSON.stringify(disruption), "disruption-first", ownerId),
      { params: Promise.resolve({ id: missionId }) },
    );

    const conflict: Disruption = {
      ...disruption,
      impact: { type: "delay", minutes: 45, timing: "duration" },
    };
    const conflicted = await createDisruption(
      disruptionRequest(missionId, JSON.stringify(conflict), "disruption-conflict", ownerId),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal(conflicted.status, 409);

    const unknownLeg = disruptionInput("unknown-leg-delay", "missing-leg");
    const invalid = await createDisruption(
      disruptionRequest(missionId, JSON.stringify(unknownLeg), "disruption-unknown-leg", ownerId),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal(invalid.status, 400);
  });

  it("rejects unconfigured and unauthenticated Nexla ingestion", async () => {
    const previous = process.env.NEXLA_INGEST_KEY;
    try {
      delete process.env.NEXLA_INGEST_KEY;
      const unconfigured = await ingestNexlaDisruption(nexlaRequest("{}", "unused", "nexla-unconfigured"));
      assert.equal(unconfigured.status, 503);

      process.env.NEXLA_INGEST_KEY = "test-only-nexla-ingest-key-000000000000";
      const unauthorized = await ingestNexlaDisruption(nexlaRequest("{}", "wrong", "nexla-unauthorized"));
      assert.equal(unauthorized.status, 401);
    } finally {
      if (previous === undefined) delete process.env.NEXLA_INGEST_KEY;
      else process.env.NEXLA_INGEST_KEY = previous;
    }
  });

  it("ingests a normalized Nexla record through the shared disruption path", async () => {
    const previous = process.env.NEXLA_INGEST_KEY;
    const key = "test-only-nexla-ingest-key-000000000000";
    process.env.NEXLA_INGEST_KEY = key;
    try {
      const { missionId } = await createAssembledMission("nexla-live");
      const disruption = disruptionInput("nexla-delay");
      const body = JSON.stringify({ missionId, ...disruption });
      const created = await ingestNexlaDisruption(nexlaRequest(body, key, "nexla-create"));
      const createdBody = await payload<DisruptionResponse>(created);
      assert.equal(created.status, 201);
      assert.equal(createdBody.data.readiness.status, "at_risk");

      const repeated = await ingestNexlaDisruption(nexlaRequest(body, key, "nexla-repeat"));
      assert.equal(repeated.status, 200);

      const invalid = await ingestNexlaDisruption(
        nexlaRequest(JSON.stringify({ missionId, ...disruption, unexpected: true }), key, "nexla-invalid"),
      );
      assert.equal(invalid.status, 400);
    } finally {
      if (previous === undefined) delete process.env.NEXLA_INGEST_KEY;
      else process.env.NEXLA_INGEST_KEY = previous;
    }
  });

  it("creates server-controlled actions and lists them", async () => {
    const { missionId, ownerId } = await createAssembledMission("action-create");
    const created = await createAction(
      actionRequest(missionId, JSON.stringify(actionInput()), "action-create", ownerId),
      { params: Promise.resolve({ id: missionId }) },
    );
    const createdBody = await payload<{ data: ActionRecord }>(created);
    assert.equal(created.status, 201);
    assert.match(createdBody.data.action.id, /^[0-9a-f-]{36}$/);
    assert.equal(createdBody.data.action.missionId, missionId);
    assert.equal(createdBody.data.action.requiresApproval, false);
    assert.equal(createdBody.data.action.status, "approved");

    const listed = await getActions(
      authenticatedRequest(`/api/missions/${missionId}/actions`, ownerId),
      { params: Promise.resolve({ id: missionId }) },
    );
    const listedBody = await payload<ActionsResponse>(listed);
    assert.equal(listed.status, 200);
    assert.deepEqual(listedBody.data.actions, [createdBody.data]);

    const hidden = await getActions(
      authenticatedRequest(`/api/missions/${missionId}/actions`, "other-owner"),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal(hidden.status, 404);

    const injected = await createAction(
      actionRequest(
        missionId,
        JSON.stringify({ ...actionInput(), status: "approved", requiresApproval: false }),
        "action-injected",
        ownerId,
      ),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal(injected.status, 400);
  });

  it("requires approval above a traveler limit and allows only one decision", async () => {
    const { missionId, ownerId } = await createAssembledMission("action-approval");
    const proposed = await createAction(
      actionRequest(missionId, JSON.stringify(actionInput(15_000)), "action-needs-approval", ownerId),
      { params: Promise.resolve({ id: missionId }) },
    );
    const proposedBody = await payload<{ data: ActionRecord }>(proposed);
    assert.equal(proposedBody.data.action.requiresApproval, true);
    assert.equal(proposedBody.data.action.status, "needs_approval");

    const actionId = proposedBody.data.action.id;
    const unauthorized = await decideAction(
      decisionRequest(missionId, actionId, "approve", "action-wrong-owner", "other-owner"),
      { params: Promise.resolve({ id: missionId, actionId }) },
    );
    assert.equal(unauthorized.status, 404);

    const approved = await decideAction(
      decisionRequest(missionId, actionId, "approve", "action-approve", ownerId),
      { params: Promise.resolve({ id: missionId, actionId }) },
    );
    assert.equal(approved.status, 200);
    assert.equal((await payload<{ data: ActionRecord }>(approved)).data.action.status, "approved");

    const repeated = await decideAction(
      decisionRequest(missionId, actionId, "reject", "action-repeat-decision", ownerId),
      { params: Promise.resolve({ id: missionId, actionId }) },
    );
    assert.equal(repeated.status, 409);
  });

  it("rejects invalid action legs and cost changes", async () => {
    const { missionId, ownerId } = await createAssembledMission("action-errors");
    const unknownLeg = await createAction(
      actionRequest(
        missionId,
        JSON.stringify({ ...actionInput(), affectedLegIds: ["missing-leg"] }),
        "action-unknown-leg",
        ownerId,
      ),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal(unknownLeg.status, 400);

    const impossibleRefund = await createAction(
      actionRequest(missionId, JSON.stringify(actionInput(-50_000)), "action-invalid-refund", ownerId),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal(impossibleRefund.status, 400);

    const paidNotification = await createAction(
      actionRequest(
        missionId,
        JSON.stringify({ ...actionInput(100), kind: "notify" }),
        "action-paid-notification",
        ownerId,
      ),
      { params: Promise.resolve({ id: missionId }) },
    );
    assert.equal(paidNotification.status, 400);
  });

  it("returns a stable not-found error", async () => {
    const response = await getMission(
      authenticatedRequest("/api/missions/missing-mission", "missing-owner"),
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

    const noOrigin = request(JSON.stringify(missionInput()), "missing-origin");
    noOrigin.headers.delete("origin");
    assert.equal((await createMission(noOrigin)).status, 403);
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
