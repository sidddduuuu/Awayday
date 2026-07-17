import { timingSafeEqual } from "node:crypto";
import { dataResponse, enforceMutationRateLimit, handleApiError, HttpError, readJson } from "../../../../../src/http.ts";
import { ingestDisruption } from "../../../../../src/missions/disruptions.ts";
import { findItinerary, findMission, missionDatabase } from "../../../../../src/missions/store.ts";
import { DisruptionSchema, ResourceIdSchema } from "../../../../../src/trips/schemas.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NexlaDisruptionSchema = DisruptionSchema.extend({ missionId: ResourceIdSchema });

function assertNexlaKey(request: Request) {
  const expected = process.env.NEXLA_INGEST_KEY;
  if (!expected || Buffer.byteLength(expected) < 32) {
    throw new HttpError(503, "NEXLA_NOT_CONFIGURED", "Nexla ingestion is not configured");
  }
  const supplied = request.headers.get("x-awayday-ingest-key") || "";
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    throw new HttpError(401, "NEXLA_UNAUTHORIZED", "Nexla ingestion key is invalid");
  }
}

export async function POST(request: Request) {
  try {
    assertNexlaKey(request);
    enforceMutationRateLimit(request);
    const parsed = NexlaDisruptionSchema.parse(await readJson(request));
    const { missionId, ...disruption } = parsed;
    const database = missionDatabase();
    const mission = findMission(database, missionId)?.mission;
    if (!mission) throw new HttpError(404, "MISSION_NOT_FOUND", "Mission not found");
    const itinerary = findItinerary(database, missionId);
    if (!itinerary) throw new HttpError(404, "ITINERARY_NOT_FOUND", "Itinerary not found");
    const result = ingestDisruption(database, mission, itinerary.legs, disruption);
    if (result.outcome === "conflict") {
      throw new HttpError(409, "DISRUPTION_ID_CONFLICT", "Disruption ID is already in use");
    }
    if (result.outcome === "limit") {
      throw new HttpError(409, "DISRUPTION_LIMIT_REACHED", "The mission has reached its disruption limit");
    }
    return dataResponse(
      { disruption: result.record, readiness: result.readiness },
      result.created ? 201 : 200,
    );
  } catch (error) {
    return handleApiError(error, "nexla_disruption_ingest_failed");
  }
}
