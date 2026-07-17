import { dataResponse, handleApiError, HttpError } from "../../../../src/http.ts";
import { findMission, missionDatabase } from "../../../../src/missions/store.ts";
import { ResourceIdSchema } from "../../../../src/trips/schemas.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = ResourceIdSchema.parse((await params).id);
    const record = findMission(missionDatabase(), id);
    if (!record) throw new HttpError(404, "MISSION_NOT_FOUND", "Mission not found");
    return dataResponse(record);
  } catch (error) {
    return handleApiError(error, "mission_read_failed");
  }
}
