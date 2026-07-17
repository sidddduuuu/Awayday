import { databaseIsHealthy, missionDatabase } from "../../../src/missions/store.ts";
import { dataResponse, handleApiError, HttpError } from "../../../src/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  try {
    if (!databaseIsHealthy(missionDatabase())) {
      throw new HttpError(503, "SERVICE_UNAVAILABLE", "The database is unavailable");
    }
    return dataResponse({ status: "ok", database: "ok" });
  } catch (error) {
    return handleApiError(error, "health_check_failed");
  }
}

