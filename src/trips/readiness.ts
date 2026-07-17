import {
  ReadinessInputSchema,
  type Disruption,
  type ItineraryLeg,
  type Mission,
  type Traveler,
} from "./schemas.ts";

const MINUTE = 60_000;
const TRANSPORT_KINDS = new Set(["flight", "rail", "ground", "walk"]);

export type ReadinessStatus = "ready" | "at_risk" | "not_ready";
export type IssueCode =
  | "ambiguous_event_arrival"
  | "cancelled_leg"
  | "event_started"
  | "missed_connection"
  | "missed_departure"
  | "missing_event_arrival"
  | "non_refundable_leg"
  | "too_many_stops"
  | "total_budget_exceeded"
  | "traveler_budget_exceeded";

export interface ReadinessIssue {
  code: IssueCode;
  message: string;
  travelerId?: string;
  legId?: string;
}

export interface TravelerReadiness {
  travelerId: string;
  score: number;
  status: ReadinessStatus;
  scheduledArrivalAt: string | null;
  projectedArrivalAt: string | null;
  bufferMinutes: number | null;
  issues: ReadinessIssue[];
}

export interface ReadinessResult {
  missionId: string;
  evaluatedAt: string;
  score: number;
  status: ReadinessStatus;
  weakestTravelerIds: string[];
  totalCostCents: number;
  contract: { valid: boolean; violations: ReadinessIssue[] };
  travelers: TravelerReadiness[];
}

interface RouteProjection {
  scheduledArrivalAt: string | null;
  projectedArrivalAt: string | null;
  arrivalCompleted: boolean;
  issues: ReadinessIssue[];
}

function statusFor(score: number): ReadinessStatus {
  if (score === 100) return "ready";
  if (score > 0) return "at_risk";
  return "not_ready";
}

function timingScore(bufferMinutes: number, requiredMinutes: number) {
  if (bufferMinutes <= 0) return 0;
  if (requiredMinutes === 0 || bufferMinutes >= requiredMinutes) return 100;
  return Math.round((bufferMinutes / requiredMinutes) * 100);
}

function disruptionsFor(legId: string, disruptions: readonly Disruption[]) {
  return disruptions.filter((disruption) => disruption.legId === legId);
}

function delayMinutes(disruptions: readonly Disruption[], timing: "departure" | "duration") {
  return disruptions.reduce(
    (total, disruption) =>
      disruption.impact.type === "delay" && disruption.impact.timing === timing
        ? total + disruption.impact.minutes
        : total,
    0,
  );
}

function eventArrivalLegs(travelerId: string, legs: readonly ItineraryLeg[]) {
  return legs.filter(
    (leg) => TRANSPORT_KINDS.has(leg.kind) && leg.arrivesAtEvent && leg.travelerIds.includes(travelerId),
  );
}

function routeFor(travelerId: string, arrival: ItineraryLeg, legs: readonly ItineraryLeg[]) {
  const arrivalStartsAt = Date.parse(arrival.startsAt);
  return legs
    .filter(
      (leg) =>
        TRANSPORT_KINDS.has(leg.kind) &&
        leg.travelerIds.includes(travelerId) &&
        Date.parse(leg.startsAt) <= arrivalStartsAt,
    )
    .toSorted((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
}

function projectLeg(
  leg: ItineraryLeg,
  previousEnd: number | null,
  disruptions: readonly Disruption[],
  evaluatedAt: number,
): { projectedEnd: number; issue?: ReadinessIssue } {
  if (leg.status === "completed") return { projectedEnd: Date.parse(leg.actualEndAt!) };
  if (disruptions.some(({ impact }) => impact.type === "cancellation")) {
    return {
      projectedEnd: Date.parse(leg.endsAt),
      issue: { code: "cancelled_leg", message: "A required journey leg is cancelled", legId: leg.id },
    };
  }
  const duration = Date.parse(leg.endsAt) - Date.parse(leg.startsAt);
  let projectedStart = Date.parse(leg.startsAt) + delayMinutes(disruptions, "departure") * MINUTE;
  if (
    previousEnd !== null &&
    previousEnd > projectedStart &&
    leg.departurePolicy === "fixed" &&
    leg.status !== "in_progress"
  ) {
    return {
      projectedEnd: projectedStart + duration,
      issue: { code: "missed_connection", message: "A delayed leg misses a fixed departure", legId: leg.id },
    };
  }
  if (leg.status !== "in_progress" && evaluatedAt > projectedStart && leg.departurePolicy === "fixed") {
    return {
      projectedEnd: projectedStart + duration,
      issue: { code: "missed_departure", message: "A fixed departure has already been missed", legId: leg.id },
    };
  }
  if (leg.status !== "in_progress") projectedStart = Math.max(projectedStart, evaluatedAt);
  if (previousEnd !== null) projectedStart = Math.max(projectedStart, previousEnd);
  return { projectedEnd: projectedStart + duration + delayMinutes(disruptions, "duration") * MINUTE };
}

function projectRoute(
  travelerId: string,
  legs: readonly ItineraryLeg[],
  disruptions: readonly Disruption[],
  evaluatedAt: string,
): RouteProjection {
  const arrivals = eventArrivalLegs(travelerId, legs);
  if (arrivals.length !== 1) {
    const code = arrivals.length === 0 ? "missing_event_arrival" : "ambiguous_event_arrival";
    return {
      scheduledArrivalAt: null,
      projectedArrivalAt: null,
      arrivalCompleted: false,
      issues: [{ code, message: arrivals.length === 0 ? "No journey reaches the event" : "More than one active journey reaches the event" }],
    };
  }
  const arrival = arrivals[0];
  const evaluatedAtMs = Date.parse(evaluatedAt);
  let previousEnd: number | null = null;
  for (const leg of routeFor(travelerId, arrival, legs)) {
    const relevantDisruptions = disruptionsFor(leg.id, disruptions)
      .filter((disruption) => Date.parse(disruption.reportedAt) <= evaluatedAtMs);
    const projection = projectLeg(leg, previousEnd, relevantDisruptions, evaluatedAtMs);
    if (projection.issue) return { scheduledArrivalAt: arrival.endsAt, projectedArrivalAt: null, arrivalCompleted: false, issues: [projection.issue] };
    previousEnd = projection.projectedEnd;
  }
  return {
    scheduledArrivalAt: arrival.endsAt,
    projectedArrivalAt: previousEnd === null ? null : new Date(previousEnd).toISOString(),
    arrivalCompleted: arrival.status === "completed",
    issues: [],
  };
}

function groupViolations(mission: Mission, legs: readonly ItineraryLeg[]): ReadinessIssue[] {
  const total = legs.reduce((sum, leg) => sum + leg.cost.totalCents, 0);
  return total > mission.constraints.totalBudgetCents
    ? [{ code: "total_budget_exceeded", message: "The itinerary exceeds the total mission budget" }]
    : [];
}

function legViolations(mission: Mission, leg: ItineraryLeg): ReadinessIssue[] {
  const violations: ReadinessIssue[] = [];
  if (mission.constraints.refundableOnly && !leg.refundable) {
    for (const travelerId of leg.travelerIds) {
      violations.push({ code: "non_refundable_leg", message: "A required booking is not refundable", travelerId, legId: leg.id });
    }
  }
  if (leg.kind === "flight" && leg.stops > mission.constraints.maximumFlightStops) {
    for (const travelerId of leg.travelerIds) {
      violations.push({ code: "too_many_stops", message: "A flight exceeds the stop limit", travelerId, legId: leg.id });
    }
  }
  return violations;
}

function travelerBudgetViolations(mission: Mission, legs: readonly ItineraryLeg[]): ReadinessIssue[] {
  return mission.travelers.flatMap((traveler) => {
    const spend = legs.flatMap(({ cost }) => cost.allocations)
      .filter(({ travelerId }) => travelerId === traveler.id)
      .reduce((sum, allocation) => sum + allocation.amountCents, 0);
    return spend > traveler.budgetCents
      ? [{ code: "traveler_budget_exceeded" as const, message: "A traveler exceeds their private budget", travelerId: traveler.id }]
      : [];
  });
}

function contractViolations(mission: Mission, legs: readonly ItineraryLeg[]) {
  return [
    ...groupViolations(mission, legs),
    ...legs.flatMap((leg) => legViolations(mission, leg)),
    ...travelerBudgetViolations(mission, legs),
  ];
}

function evaluateTraveler(
  traveler: Traveler,
  mission: Mission,
  legs: readonly ItineraryLeg[],
  disruptions: readonly Disruption[],
  violations: readonly ReadinessIssue[],
  evaluatedAt: string,
): TravelerReadiness {
  const route = projectRoute(traveler.id, legs, disruptions, evaluatedAt);
  const contractIssues = violations.filter((issue) => !issue.travelerId || issue.travelerId === traveler.id);
  const issues = [...route.issues, ...contractIssues];
  let bufferMinutes: number | null = null;
  if (route.projectedArrivalAt) {
    bufferMinutes = Math.floor((Date.parse(mission.event.startsAt) - Date.parse(route.projectedArrivalAt)) / MINUTE);
  }
  if (Date.parse(evaluatedAt) >= Date.parse(mission.event.startsAt) && !route.arrivalCompleted) {
    issues.push({ code: "event_started", message: "The event has started before arrival", travelerId: traveler.id });
  }
  const score = issues.length || bufferMinutes === null
    ? 0
    : timingScore(bufferMinutes, mission.constraints.minimumArrivalBufferMinutes);
  return {
    travelerId: traveler.id,
    score,
    status: statusFor(score),
    scheduledArrivalAt: route.scheduledArrivalAt,
    projectedArrivalAt: route.projectedArrivalAt,
    bufferMinutes,
    issues,
  };
}

export function evaluateReadiness(input: unknown): ReadinessResult {
  const parsed = ReadinessInputSchema.parse(input);
  const violations = contractViolations(parsed.mission, parsed.legs);
  const travelers = parsed.mission.travelers.map((traveler) =>
    evaluateTraveler(traveler, parsed.mission, parsed.legs, parsed.disruptions, violations, parsed.evaluatedAt),
  );
  const score = Math.min(...travelers.map((traveler) => traveler.score));
  return {
    missionId: parsed.mission.id,
    evaluatedAt: parsed.evaluatedAt,
    score,
    status: statusFor(score),
    weakestTravelerIds: travelers.filter((traveler) => traveler.score === score).map(({ travelerId }) => travelerId),
    totalCostCents: parsed.legs.reduce((sum, leg) => sum + leg.cost.totalCents, 0),
    contract: { valid: violations.length === 0, violations },
    travelers,
  };
}
