import { randomUUID } from "node:crypto";
import {
  assertSameOrigin,
  authenticatedSubject,
  dataResponse,
  enforceMutationRateLimit,
  handleApiError,
  readJson,
} from "../../../src/http.ts";
import { missionDatabase, saveMission } from "../../../src/missions/store.ts";
import { CreateMissionSchema, MissionSchema } from "../../../src/trips/schemas.ts";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const ownerId = await authenticatedSubject(request);
    assertSameOrigin(request);
    enforceMutationRateLimit(ownerId);
    const input = CreateMissionSchema.parse(await readJson(request));
    const mission = MissionSchema.parse({ id: randomUUID(), ...input });
    return dataResponse(saveMission(missionDatabase(), mission, ownerId), 201);
  } catch (error) {
    return handleApiError(error, "mission_create_failed");
  }
}
