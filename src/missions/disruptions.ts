import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { evaluateReadiness } from "../trips/readiness.ts";
import type { Disruption, ItineraryLeg, Mission } from "../trips/schemas.ts";
import {
  findDisruption,
  listDisruptions,
  saveDisruption,
  type DisruptionRecord,
} from "./store.ts";

const MAX_DISRUPTIONS = 1_000;

export function activeDisruptions(
  database: DatabaseSync,
  missionId: string,
  legs: ItineraryLeg[],
  records: DisruptionRecord[] = listDisruptions(database, missionId),
) {
  const legIds = new Set(legs.map(({ id }) => id));
  return records.filter(({ disruption }) => legIds.has(disruption.legId));
}

function readiness(mission: Mission, legs: ItineraryLeg[], disruptions: Disruption[], evaluatedAt: Date) {
  return evaluateReadiness({ mission, legs, disruptions, evaluatedAt: evaluatedAt.toISOString() });
}

export function currentTripState(
  database: DatabaseSync,
  mission: Mission,
  legs: ItineraryLeg[],
  evaluatedAt = new Date(),
) {
  const disruptions = activeDisruptions(database, mission.id, legs);
  return {
    disruptions,
    readiness: readiness(mission, legs, disruptions.map(({ disruption }) => disruption), evaluatedAt),
  };
}

export function ingestDisruption(
  database: DatabaseSync,
  mission: Mission,
  legs: ItineraryLeg[],
  disruption: Disruption,
  evaluatedAt = new Date(),
) {
  const existing = findDisruption(database, mission.id, disruption.id);
  if (existing && !isDeepStrictEqual(existing.disruption, disruption)) {
    return { outcome: "conflict" as const };
  }
  const stored = listDisruptions(database, mission.id);
  if (!existing && stored.length >= MAX_DISRUPTIONS) {
    return { outcome: "limit" as const };
  }
  const active = activeDisruptions(database, mission.id, legs, stored)
    .filter(({ disruption: item }) => item.id !== disruption.id);
  const nextDisruptions = [...active.map(({ disruption: item }) => item), disruption];
  const nextReadiness = readiness(mission, legs, nextDisruptions, evaluatedAt);
  const saved = existing
    ? { record: existing, created: false }
    : saveDisruption(database, mission.id, disruption, evaluatedAt);
  return { outcome: "accepted" as const, ...saved, readiness: nextReadiness };
}
