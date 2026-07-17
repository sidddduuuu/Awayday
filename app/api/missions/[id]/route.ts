import { authenticatedSubject, dataResponse, handleApiError, HttpError } from "../../../../src/http.ts";
import { findOwnedMission, missionDatabase } from "../../../../src/missions/store.ts";
import { ResourceIdSchema } from "../../../../src/trips/schemas.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ownerId = await authenticatedSubject(request);
    const id = ResourceIdSchema.parse((await params).id);
    const record = findOwnedMission(missionDatabase(), id, ownerId);
    if (!record) throw new HttpError(404, "MISSION_NOT_FOUND", "Mission not found");
    return dataResponse(record);
  } catch (error) {
    return handleApiError(error, "mission_read_failed");
  }
}
