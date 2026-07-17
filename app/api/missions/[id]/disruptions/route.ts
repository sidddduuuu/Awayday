import { assertSameOrigin, dataResponse, enforceMutationRateLimit, handleApiError, HttpError, readJson } from "../../../../../src/http.ts";
import { currentTripState, ingestDisruption } from "../../../../../src/missions/disruptions.ts";
import {
  findItinerary,
  findMission,
  missionDatabase,
} from "../../../../../src/missions/store.ts";
import { DisruptionSchema, ResourceIdSchema } from "../../../../../src/trips/schemas.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function loadTrip({ params }: RouteContext) {
  const id = ResourceIdSchema.parse((await params).id);
  const database = missionDatabase();
  const mission = findMission(database, id)?.mission;
  if (!mission) throw new HttpError(404, "MISSION_NOT_FOUND", "Mission not found");
  const itinerary = findItinerary(database, id);
  if (!itinerary) throw new HttpError(404, "ITINERARY_NOT_FOUND", "Itinerary not found");
  return { database, mission, itinerary };
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const trip = await loadTrip(context);
    return dataResponse(currentTripState(trip.database, trip.mission, trip.itinerary.legs));
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
    const result = ingestDisruption(trip.database, trip.mission, trip.itinerary.legs, disruption);
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
    return handleApiError(error, "disruption_create_failed");
  }
}
