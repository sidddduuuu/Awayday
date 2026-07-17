import { assertSameOrigin, dataResponse, enforceMutationRateLimit, handleApiError, HttpError, readJson } from "../../../../../src/http.ts";
import { currentTripState } from "../../../../../src/missions/disruptions.ts";
import {
  findItinerary,
  findMission,
  missionDatabase,
  saveItinerary,
} from "../../../../../src/missions/store.ts";
import { ItinerarySchema, ResourceIdSchema } from "../../../../../src/trips/schemas.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function loadMission({ params }: RouteContext) {
  const id = ResourceIdSchema.parse((await params).id);
  const record = findMission(missionDatabase(), id);
  if (!record) throw new HttpError(404, "MISSION_NOT_FOUND", "Mission not found");
  return record.mission;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const mission = await loadMission(context);
    const itinerary = findItinerary(missionDatabase(), mission.id);
    if (!itinerary) throw new HttpError(404, "ITINERARY_NOT_FOUND", "Itinerary not found");
    const state = currentTripState(missionDatabase(), mission, itinerary.legs);
    return dataResponse({ itinerary, readiness: state.readiness });
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
    const readiness = currentTripState(missionDatabase(), mission, itineraryInput.legs).readiness;
    const itinerary = saveItinerary(missionDatabase(), mission.id, itineraryInput);
    return dataResponse({ itinerary, readiness });
  } catch (error) {
    return handleApiError(error, "itinerary_save_failed");
  }
}
