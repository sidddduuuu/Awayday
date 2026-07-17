import * as z from "zod";

const MAX_CENTS = 1_000_000_000;
export const ResourceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const TimestampSchema = z.string().datetime({ offset: true });
const CentsSchema = z.number().int().min(0).max(MAX_CENTS);
const TransportKindSchema = z.enum(["flight", "rail", "ground", "walk"]);

function unique(values: readonly string[]) {
  return new Set(values).size === values.length;
}

export const TravelerSchema = z.strictObject({
  id: ResourceIdSchema,
  name: z.string().trim().min(1).max(100),
  origin: z.string().trim().min(1).max(120),
  budgetCents: CentsSchema,
  approvalLimitCents: CentsSchema,
});

export const TripConstraintsSchema = z.strictObject({
  totalBudgetCents: CentsSchema,
  refundableOnly: z.boolean(),
  maximumFlightStops: z.number().int().min(0).max(8),
  minimumArrivalBufferMinutes: z.number().int().min(0).max(24 * 60),
});

const MissionFields = {
  request: z.string().trim().min(1).max(2_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  event: z.strictObject({
    name: z.string().trim().min(1).max(160),
    venue: z.string().trim().min(1).max(160),
    startsAt: TimestampSchema,
  }),
  travelers: z.array(TravelerSchema).min(1).max(100),
  constraints: TripConstraintsSchema,
};

function validateMissionTravelers(mission: { travelers: { id: string }[] }, context: z.RefinementCtx) {
  if (!unique(mission.travelers.map(({ id }) => id))) {
    context.addIssue({ code: "custom", message: "Traveler IDs must be unique", path: ["travelers"] });
  }
}

export const CreateMissionSchema = z.strictObject(MissionFields).superRefine(validateMissionTravelers);
export const MissionSchema = z
  .strictObject({ id: ResourceIdSchema, ...MissionFields })
  .superRefine(validateMissionTravelers);

const CostSchema = z
  .strictObject({
    totalCents: CentsSchema,
    allocations: z
      .array(z.strictObject({ travelerId: ResourceIdSchema, amountCents: CentsSchema }))
      .max(100),
  })
  .superRefine((cost, context) => {
    if (!unique(cost.allocations.map(({ travelerId }) => travelerId))) {
      context.addIssue({ code: "custom", message: "Cost allocations must be unique by traveler", path: ["allocations"] });
    }
    const allocated = cost.allocations.reduce((sum, item) => sum + item.amountCents, 0);
    if (allocated !== cost.totalCents) {
      context.addIssue({ code: "custom", message: "Cost allocations must equal the total cost", path: ["allocations"] });
    }
  });

export const ItineraryLegSchema = z
  .strictObject({
    id: ResourceIdSchema,
    kind: z.enum(["flight", "rail", "ground", "walk", "hotel", "meal", "event"]),
    travelerIds: z.array(ResourceIdSchema).min(1).max(100),
    startsAt: TimestampSchema,
    endsAt: TimestampSchema,
    status: z.enum(["planned", "confirmed", "in_progress", "completed"]),
    actualEndAt: TimestampSchema.optional(),
    departurePolicy: z.enum(["fixed", "flexible"]).optional(),
    arrivesAtEvent: z.boolean(),
    refundable: z.boolean(),
    stops: z.number().int().min(0).max(8),
    cost: CostSchema,
  })
  .superRefine((leg, context) => {
    if (!unique(leg.travelerIds)) {
      context.addIssue({ code: "custom", message: "Traveler IDs on a leg must be unique", path: ["travelerIds"] });
    }
    const travelerIds = new Set(leg.travelerIds);
    leg.cost.allocations.forEach(({ travelerId }, index) => {
      if (!travelerIds.has(travelerId)) {
        context.addIssue({
          code: "custom",
          message: "Cost allocations must belong to a traveler on the leg",
          path: ["cost", "allocations", index, "travelerId"],
        });
      }
    });
    if (Date.parse(leg.endsAt) <= Date.parse(leg.startsAt)) {
      context.addIssue({ code: "custom", message: "Leg end must be after its start", path: ["endsAt"] });
    }
    if (TransportKindSchema.safeParse(leg.kind).success && !leg.departurePolicy) {
      context.addIssue({ code: "custom", message: "Transport legs require a departure policy", path: ["departurePolicy"] });
    }
    if (leg.arrivesAtEvent && !TransportKindSchema.safeParse(leg.kind).success) {
      context.addIssue({ code: "custom", message: "Only transport legs can arrive at the event", path: ["arrivesAtEvent"] });
    }
    if (leg.status === "completed" && !leg.actualEndAt) {
      context.addIssue({ code: "custom", message: "Completed legs require an actual end time", path: ["actualEndAt"] });
    }
    if (leg.status !== "completed" && leg.actualEndAt) {
      context.addIssue({ code: "custom", message: "Only completed legs can have an actual end time", path: ["actualEndAt"] });
    }
    if (leg.actualEndAt && Date.parse(leg.actualEndAt) <= Date.parse(leg.startsAt)) {
      context.addIssue({ code: "custom", message: "Actual end must be after the leg start", path: ["actualEndAt"] });
    }
    if (!TransportKindSchema.safeParse(leg.kind).success && leg.departurePolicy) {
      context.addIssue({ code: "custom", message: "Only transport legs have a departure policy", path: ["departurePolicy"] });
    }
    if (leg.kind !== "flight" && leg.stops !== 0) {
      context.addIssue({ code: "custom", message: "Only flight legs can contain stops", path: ["stops"] });
    }
  });

export const ItinerarySchema = z.strictObject({
  legs: z.array(ItineraryLegSchema).min(1).max(100),
});

export const DisruptionSchema = z.strictObject({
  id: ResourceIdSchema,
  legId: ResourceIdSchema,
  reportedAt: TimestampSchema,
  impact: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("delay"),
      minutes: z.number().int().min(1).max(7 * 24 * 60),
      timing: z.enum(["departure", "duration"]),
    }),
    z.strictObject({ type: z.literal("cancellation") }),
  ]),
});

export const ActionSchema = z.strictObject({
  id: ResourceIdSchema,
  missionId: ResourceIdSchema,
  kind: z.enum(["reroute", "reschedule", "rebook", "notify"]),
  status: z.enum(["proposed", "needs_approval", "approved", "executing", "succeeded", "failed", "rejected"]),
  affectedLegIds: z.array(ResourceIdSchema).min(1).max(100),
  costDeltaCents: z.number().int().min(-MAX_CENTS).max(MAX_CENTS),
  requiresApproval: z.boolean(),
  explanation: z.string().trim().min(1).max(1_000),
  createdAt: TimestampSchema,
});

export const ReadinessInputSchema = z
  .strictObject({
    mission: MissionSchema,
    legs: z.array(ItineraryLegSchema).max(1_000),
    disruptions: z.array(DisruptionSchema).max(1_000),
    evaluatedAt: TimestampSchema,
  })
  .superRefine((input, context) => {
    const travelerIds = new Set(input.mission.travelers.map(({ id }) => id));
    const legIds = input.legs.map(({ id }) => id);
    if (!unique(legIds)) context.addIssue({ code: "custom", message: "Leg IDs must be unique", path: ["legs"] });
    if (!unique(input.disruptions.map(({ id }) => id))) {
      context.addIssue({ code: "custom", message: "Disruption IDs must be unique", path: ["disruptions"] });
    }
    input.legs.forEach((leg, index) => {
      [...leg.travelerIds, ...leg.cost.allocations.map(({ travelerId }) => travelerId)].forEach((travelerId) => {
        if (!travelerIds.has(travelerId)) {
          context.addIssue({ code: "custom", message: `Unknown traveler ${travelerId}`, path: ["legs", index] });
        }
      });
    });
    const knownLegIds = new Set(legIds);
    input.disruptions.forEach((disruption, index) => {
      if (!knownLegIds.has(disruption.legId)) {
        context.addIssue({ code: "custom", message: `Unknown leg ${disruption.legId}`, path: ["disruptions", index, "legId"] });
      }
    });
  });

export type Mission = z.infer<typeof MissionSchema>;
export type CreateMission = z.infer<typeof CreateMissionSchema>;
export type Traveler = z.infer<typeof TravelerSchema>;
export type ItineraryLeg = z.infer<typeof ItineraryLegSchema>;
export type Itinerary = z.infer<typeof ItinerarySchema>;
export type Disruption = z.infer<typeof DisruptionSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type ReadinessInput = z.infer<typeof ReadinessInputSchema>;
