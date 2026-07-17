import {
  assertSameOrigin,
  dataResponse,
  enforceMutationRateLimit,
  handleApiError,
  HttpError,
  readJson,
} from "../../../../../src/http.ts";
import { proposeAction } from "../../../../../src/missions/actions.ts";
import {
  findItinerary,
  findMission,
  listActions,
  missionDatabase,
  saveAction,
} from "../../../../../src/missions/store.ts";
import { CreateActionSchema, ResourceIdSchema } from "../../../../../src/trips/schemas.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function missionId({ params }: RouteContext) {
  return ResourceIdSchema.parse((await params).id);
}

async function loadMission(context: RouteContext) {
  const id = await missionId(context);
  const mission = findMission(missionDatabase(), id)?.mission;
  if (!mission) throw new HttpError(404, "MISSION_NOT_FOUND", "Mission not found");
  return mission;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const mission = await loadMission(context);
    return dataResponse({ actions: listActions(missionDatabase(), mission.id) });
  } catch (error) {
    return handleApiError(error, "action_list_failed");
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    enforceMutationRateLimit(request);
    const mission = await loadMission(context);
    const itinerary = findItinerary(missionDatabase(), mission.id);
    if (!itinerary) throw new HttpError(404, "ITINERARY_NOT_FOUND", "Itinerary not found");
    const input = CreateActionSchema.parse(await readJson(request));
    const proposal = proposeAction(mission, { legs: itinerary.legs }, input);
    if (proposal.outcome === "unknown_leg") {
      throw new HttpError(400, "UNKNOWN_ACTION_LEG", "An affected leg does not exist");
    }
    if (proposal.outcome === "invalid_cost_delta") {
      throw new HttpError(400, "INVALID_COST_DELTA", "The action cost change is invalid");
    }
    return dataResponse(saveAction(missionDatabase(), proposal.action), 201);
  } catch (error) {
    return handleApiError(error, "action_create_failed");
  }
}
