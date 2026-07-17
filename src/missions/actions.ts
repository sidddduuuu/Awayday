import { randomUUID } from "node:crypto";
import {
  ActionSchema,
  type Action,
  type CreateAction,
  type Itinerary,
  type Mission,
} from "../trips/schemas.ts";

function affectedTravelerIds(itinerary: Itinerary, legIds: readonly string[]) {
  const affected = new Set(legIds);
  return new Set(
    itinerary.legs
      .filter(({ id }) => affected.has(id))
      .flatMap(({ travelerIds }) => travelerIds),
  );
}

function itineraryCost(itinerary: Itinerary) {
  return itinerary.legs.reduce((total, leg) => total + leg.cost.totalCents, 0);
}

export type ActionProposalResult =
  | { outcome: "accepted"; action: Action }
  | { outcome: "invalid_cost_delta" }
  | { outcome: "unknown_leg"; legId: string };

export function proposeAction(
  mission: Mission,
  itinerary: Itinerary,
  input: CreateAction,
  id = randomUUID(),
  now = new Date(),
): ActionProposalResult {
  const knownLegIds = new Set(itinerary.legs.map(({ id: legId }) => legId));
  const unknownLegId = input.affectedLegIds.find((legId) => !knownLegIds.has(legId));
  if (unknownLegId) return { outcome: "unknown_leg", legId: unknownLegId };

  const projectedTotal = itineraryCost(itinerary) + input.costDeltaCents;
  if (projectedTotal < 0 || (input.kind === "notify" && input.costDeltaCents !== 0)) {
    return { outcome: "invalid_cost_delta" };
  }

  const travelerIds = affectedTravelerIds(itinerary, input.affectedLegIds);
  const approvalLimits = mission.travelers
    .filter(({ id: travelerId }) => travelerIds.has(travelerId))
    .map(({ approvalLimitCents }) => approvalLimitCents);
  if (approvalLimits.length !== travelerIds.size) {
    throw new Error("Stored itinerary references an unknown traveler");
  }
  const approvalLimit = Math.min(...approvalLimits);
  const addsCost = input.costDeltaCents > 0;
  const requiresApproval = addsCost && (
    input.costDeltaCents > approvalLimit || projectedTotal > mission.constraints.totalBudgetCents
  );
  const action = ActionSchema.parse({
    id,
    missionId: mission.id,
    ...input,
    status: requiresApproval ? "needs_approval" : "approved",
    requiresApproval,
    createdAt: now.toISOString(),
  });
  return { outcome: "accepted", action };
}
