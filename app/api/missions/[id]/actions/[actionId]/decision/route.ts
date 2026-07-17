import * as z from "zod";
import {
  assertSameOrigin,
  dataResponse,
  enforceMutationRateLimit,
  handleApiError,
  HttpError,
  readJson,
} from "../../../../../../../src/http.ts";
import {
  findMission,
  missionDatabase,
  transitionActionStatus,
} from "../../../../../../../src/missions/store.ts";
import { ResourceIdSchema } from "../../../../../../../src/trips/schemas.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DecisionSchema = z.strictObject({ decision: z.enum(["approve", "reject"]) });
type RouteContext = { params: Promise<{ id: string; actionId: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  try {
    assertSameOrigin(request);
    enforceMutationRateLimit(request);
    const route = await params;
    const missionId = ResourceIdSchema.parse(route.id);
    const actionId = ResourceIdSchema.parse(route.actionId);
    if (!findMission(missionDatabase(), missionId)) {
      throw new HttpError(404, "MISSION_NOT_FOUND", "Mission not found");
    }
    const { decision } = DecisionSchema.parse(await readJson(request));
    const status = decision === "approve" ? "approved" : "rejected";
    const result = transitionActionStatus(
      missionDatabase(),
      missionId,
      actionId,
      "needs_approval",
      status,
    );
    if (result.outcome === "not_found") {
      throw new HttpError(404, "ACTION_NOT_FOUND", "Action not found");
    }
    if (result.outcome === "conflict") {
      throw new HttpError(409, "ACTION_ALREADY_DECIDED", "Action is not awaiting a decision");
    }
    return dataResponse(result.record);
  } catch (error) {
    return handleApiError(error, "action_decision_failed");
  }
}
