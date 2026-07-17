import { assertSameOrigin, dataResponse, enforceMutationRateLimit, handleApiError, HttpError, readJson } from "../../../../../src/http.ts";
import { findItinerary, findMission, missionDatabase, saveItinerary } from "../../../../../src/missions/store.ts";
import { evaluateReadiness } from "../../../../../src/trips/readiness.ts";
import {
  ItinerarySchema,
  ResourceIdSchema,
  type ItineraryLeg,
  type Mission,
} from "../../../../../src/trips/schemas.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function loadMission({ params }: RouteContext) {
  const id = ResourceIdSchema.parse((await params).id);
  const record = findMission(missionDatabase(), id);
  if (!record) throw new HttpError(404, "MISSION_NOT_FOUND", "Mission not found");
  return record.mission;
}

function assembly(mission: Mission, legs: ItineraryLeg[]) {
  return evaluateReadiness({ mission, legs, disruptions: [], evaluatedAt: new Date().toISOString() });
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const mission = await loadMission(context);
    const itinerary = findItinerary(missionDatabase(), mission.id);
    if (!itinerary) throw new HttpError(404, "ITINERARY_NOT_FOUND", "Itinerary not found");
    return dataResponse({ itinerary, readiness: assembly(mission, itinerary.legs) });
  } catch (error) {
    return handleApiError(error, "itinerary_read_failed");
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    enforceMutationRateLimit(request);
    const mission = await loadMission(context);
    const itineraryInput = ItinerarySchema.parse(await readJson(request));
    const readiness = assembly(mission, itineraryInput.legs);
    const itinerary = saveItinerary(missionDatabase(), mission.id, itineraryInput);
    return dataResponse({ itinerary, readiness });
  } catch (error) {
    return handleApiError(error, "itinerary_save_failed");
  }
}
