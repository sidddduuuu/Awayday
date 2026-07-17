import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZodError } from "zod";
import { evaluateReadiness } from "./readiness.ts";
import { ActionSchema, type ReadinessInput } from "./schemas.ts";

function input(): ReadinessInput {
  return {
    mission: {
      id: "mission-1",
      request: "Get the group to the event on time",
      currency: "USD",
      event: { name: "Final", venue: "Central Stadium", startsAt: "2027-01-01T20:00:00Z" },
      travelers: [
        { id: "alex", name: "Alex", origin: "North", budgetCents: 50_000, approvalLimitCents: 5_000 },
        { id: "sam", name: "Sam", origin: "South", budgetCents: 50_000, approvalLimitCents: 5_000 },
      ],
      constraints: {
        totalBudgetCents: 100_000,
        refundableOnly: true,
        maximumFlightStops: 0,
        minimumArrivalBufferMinutes: 30,
      },
    },
    legs: [
      {
        id: "alex-flight",
        kind: "flight",
        travelerIds: ["alex"],
        startsAt: "2027-01-01T16:00:00Z",
        endsAt: "2027-01-01T18:00:00Z",
        status: "confirmed",
        departurePolicy: "fixed",
        arrivesAtEvent: false,
        refundable: true,
        stops: 0,
        cost: { totalCents: 20_000, allocations: [{ travelerId: "alex", amountCents: 20_000 }] },
      },
      {
        id: "alex-transfer",
        kind: "ground",
        travelerIds: ["alex"],
        startsAt: "2027-01-01T18:10:00Z",
        endsAt: "2027-01-01T19:00:00Z",
        status: "confirmed",
        departurePolicy: "flexible",
        arrivesAtEvent: true,
        refundable: true,
        stops: 0,
        cost: { totalCents: 5_000, allocations: [{ travelerId: "alex", amountCents: 5_000 }] },
      },
      {
        id: "sam-rail",
        kind: "rail",
        travelerIds: ["sam"],
        startsAt: "2027-01-01T17:30:00Z",
        endsAt: "2027-01-01T18:30:00Z",
        status: "confirmed",
        departurePolicy: "fixed",
        arrivesAtEvent: false,
        refundable: true,
        stops: 0,
        cost: { totalCents: 12_000, allocations: [{ travelerId: "sam", amountCents: 12_000 }] },
      },
      {
        id: "sam-transfer",
        kind: "ground",
        travelerIds: ["sam"],
        startsAt: "2027-01-01T18:40:00Z",
        endsAt: "2027-01-01T19:20:00Z",
        status: "confirmed",
        departurePolicy: "flexible",
        arrivesAtEvent: true,
        refundable: true,
        stops: 0,
        cost: { totalCents: 4_000, allocations: [{ travelerId: "sam", amountCents: 4_000 }] },
      },
    ],
    disruptions: [],
    evaluatedAt: "2027-01-01T12:00:00Z",
  };
}

describe("evaluateReadiness", () => {
  it("calculates group readiness from arbitrary itinerary input without mutating it", () => {
    const value = input();
    const original = structuredClone(value);
    const result = evaluateReadiness(value);

    assert.equal(result.score, 100);
    assert.equal(result.totalCostCents, 41_000);
    assert.deepEqual(result.weakestTravelerIds, ["alex", "sam"]);
    assert.deepEqual(value, original);
  });

  it("propagates a duration delay through a flexible transfer", () => {
    const value = input();
    value.disruptions.push({
      id: "delay-1",
      legId: "sam-rail",
      reportedAt: "2027-01-01T11:45:00Z",
      impact: { type: "delay", minutes: 25, timing: "duration" },
    });

    const result = evaluateReadiness(value);
    const sam = result.travelers.find(({ travelerId }) => travelerId === "sam")!;
    assert.equal(sam.projectedArrivalAt, "2027-01-01T19:35:00.000Z");
    assert.equal(sam.bufferMinutes, 25);
    assert.equal(result.score, 83);
    assert.deepEqual(result.weakestTravelerIds, ["sam"]);
  });

  it("marks a traveler not ready when an earlier delay misses a fixed departure", () => {
    const value = input();
    value.legs[1].departurePolicy = "fixed";
    value.disruptions.push({
      id: "delay-1",
      legId: "alex-flight",
      reportedAt: "2027-01-01T11:45:00Z",
      impact: { type: "delay", minutes: 20, timing: "duration" },
    });

    const result = evaluateReadiness(value);
    assert.equal(result.score, 0);
    assert.equal(result.travelers[0].issues[0].code, "missed_connection");
  });

  it("ignores disruptions reported after the evaluation time", () => {
    const value = input();
    value.disruptions.push({
      id: "future-delay",
      legId: "sam-rail",
      reportedAt: "2027-01-01T13:00:00Z",
      impact: { type: "delay", minutes: 90, timing: "duration" },
    });

    assert.equal(evaluateReadiness(value).score, 100);
  });

  it("marks a confirmed fixed departure in the past as missed", () => {
    const value = input();
    value.evaluatedAt = "2027-01-01T16:30:00Z";

    const result = evaluateReadiness(value);
    assert.equal(result.score, 0);
    assert.equal(result.travelers[0].issues[0].code, "missed_departure");
  });

  it("does not mark a fixed leg already in progress as missed", () => {
    const value = input();
    value.evaluatedAt = "2027-01-01T16:30:00Z";
    value.legs[0].status = "in_progress";

    assert.equal(evaluateReadiness(value).travelers[0].score, 100);
  });

  it("uses actual completion time instead of invalidating a completed leg", () => {
    const value = input();
    value.evaluatedAt = "2027-01-01T18:05:00Z";
    value.legs[0].status = "completed";
    value.legs[0].actualEndAt = "2027-01-01T18:00:00Z";
    value.disruptions.push({
      id: "late-cancellation",
      legId: "alex-flight",
      reportedAt: "2027-01-01T18:01:00Z",
      impact: { type: "cancellation" },
    });

    const result = evaluateReadiness(value);
    assert.equal(result.travelers[0].score, 100);
    assert.equal(result.travelers[0].projectedArrivalAt, "2027-01-01T19:00:00.000Z");
  });

  it("enforces total, personal, refundability, and stop constraints", () => {
    const value = input();
    value.mission.constraints.totalBudgetCents = 10_000;
    value.mission.travelers[0].budgetCents = 10_000;
    value.legs[0].refundable = false;
    value.legs[0].stops = 1;

    const result = evaluateReadiness(value);
    const codes = new Set(result.contract.violations.map(({ code }) => code));
    assert.equal(result.contract.valid, false);
    assert.equal(result.score, 0);
    assert.deepEqual(codes, new Set([
      "total_budget_exceeded",
      "traveler_budget_exceeded",
      "non_refundable_leg",
      "too_many_stops",
    ]));
  });

  it("rejects unknown traveler references at the boundary", () => {
    const value = input();
    value.legs[0].travelerIds = ["unknown"];
    assert.throws(() => evaluateReadiness(value), ZodError);
  });
});

describe("ActionSchema", () => {
  it("validates an action independently of any UI or provider", () => {
    const action = ActionSchema.parse({
      id: "action-1",
      missionId: "mission-1",
      kind: "reroute",
      status: "needs_approval",
      affectedLegIds: ["leg-1"],
      costDeltaCents: 2_500,
      requiresApproval: true,
      explanation: "A fixed connection can no longer be reached",
      createdAt: "2027-01-01T18:00:00Z",
    });
    assert.equal(action.costDeltaCents, 2_500);
  });
});
