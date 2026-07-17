import { isDeepStrictEqual } from "node:util";
import { assertSameOrigin, dataResponse, enforceMutationRateLimit, handleApiError, HttpError, readJson } from "../../../../../src/http.ts";
import {
  findDisruption,
  findItinerary,
  findMission,
  listDisruptions,
  missionDatabase,
  saveDisruption,
  type DisruptionRecord,
} from "../../../../../src/missions/store.ts";
import { evaluateReadiness } from "../../../../../src/trips/readiness.ts";
import { DisruptionSchema, ResourceIdSchema, type Disruption } from "../../../../../src/trips/schemas.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };
const MAX_DISRUPTIONS = 1_000;

async function loadTrip({ params }: RouteContext) {
  const id = ResourceIdSchema.parse((await params).id);
  const database = missionDatabase();
  const mission = findMission(database, id)?.mission;
  if (!mission) throw new HttpError(404, "MISSION_NOT_FOUND", "Mission not found");
  const itinerary = findItinerary(database, id);
  if (!itinerary) throw new HttpError(404, "ITINERARY_NOT_FOUND", "Itinerary not found");
  return { database, mission, itinerary };
}

function activeDisruptions(
  trip: Awaited<ReturnType<typeof loadTrip>>,
  records: DisruptionRecord[] = listDisruptions(trip.database, trip.mission.id),
) {
  const legIds = new Set(trip.itinerary.legs.map(({ id }) => id));
  return records.filter(({ disruption }) => legIds.has(disruption.legId));
}

function readiness(trip: Awaited<ReturnType<typeof loadTrip>>, disruptions: Disruption[], evaluatedAt: Date) {
  return evaluateReadiness({
    mission: trip.mission,
    legs: trip.itinerary.legs,
    disruptions,
    evaluatedAt: evaluatedAt.toISOString(),
  });
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const trip = await loadTrip(context);
    const disruptions = activeDisruptions(trip);
    const evaluatedAt = new Date();
    return dataResponse({
      disruptions,
      readiness: readiness(trip, disruptions.map(({ disruption }) => disruption), evaluatedAt),
    });
  } catch (error) {
    return handleApiError(error, "disruption_list_failed");
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    enforceMutationRateLimit(request);
    const trip = await loadTrip(context);
    const disruption = DisruptionSchema.parse(await readJson(request));
    const existing = findDisruption(trip.database, trip.mission.id, disruption.id);
    if (existing && !isDeepStrictEqual(existing.disruption, disruption)) {
      throw new HttpError(409, "DISRUPTION_ID_CONFLICT", "Disruption ID is already in use");
    }
    const stored = listDisruptions(trip.database, trip.mission.id);
    if (!existing && stored.length >= MAX_DISRUPTIONS) {
      throw new HttpError(409, "DISRUPTION_LIMIT_REACHED", "The mission has reached its disruption limit");
    }
    const active = activeDisruptions(trip, stored).filter(({ disruption: item }) => item.id !== disruption.id);
    const nextDisruptions = [...active.map(({ disruption: item }) => item), disruption];
    const evaluatedAt = new Date();
    const nextReadiness = readiness(trip, nextDisruptions, evaluatedAt);
    const saved = existing
      ? { record: existing, created: false }
      : saveDisruption(trip.database, trip.mission.id, disruption, evaluatedAt);
    return dataResponse({ disruption: saved.record, readiness: nextReadiness }, saved.created ? 201 : 200);
  } catch (error) {
    return handleApiError(error, "disruption_create_failed");
  }
}
