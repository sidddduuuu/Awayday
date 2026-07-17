# Awayday

> **Get us there.** An autonomous matchday operator that plans, coordinates, and protects a group trip to a live event.

Awayday is not another AI travel-search interface. A user gives it a mission—an event, a group, a budget, and a few non-negotiables—and it produces a coordinated, bookable plan. Once the trip is underway, Awayday monitors disruptions and resolves them within each traveler’s approved rules.

**Example mission**

> Get me and my girlfriend to the World Cup match in Miami. Keep the total under $1,800, prefer direct flights, stay near the stadium in a 4.3+ rated hotel, include dinner after the game, and do not book anything nonrefundable. Ask only if there is a real tradeoff.

## The problem

Travel sites make users coordinate dozens of separate decisions: flights, hotels, transportation, reservations, budgets, calendars, and cancellations. That becomes especially painful for sporting events, where kickoff is fixed, inventory changes rapidly, and one delayed traveler can break a group plan.

Current AI travel products mostly recommend options. They do not own the outcome: **getting the entire group to kickoff on time**.

## The product

Awayday turns a request into a **Shared Arrival Contract**:

> Get these people to this event by this time, within each person’s budget and permissions. Resolve ordinary disruptions automatically; ask only when a rule must bend.

### Core promise: Get Us There

The main screen is an **Arrival Confidence Map**. Every traveler has a live journey:

`Home → Airport → Flight → Hotel → Stadium → Seat`

Awayday calculates a shared `Kickoff Readiness` score, highlights the weak link, and shows exactly what the agent is doing.

Example live event:

> **Kickoff readiness: 82%**  
> Maya’s connection is delayed by 43 minutes. Awayday moved group dinner 30 minutes later and rerouted her directly to the stadium. New group arrival: **7:26 PM**, 34 minutes before kickoff.

This makes the product a real-time coordination agent—not a prettier booking site.

## Key experiences

### 1. Mission input

Users describe a trip naturally, then confirm a compact set of controls:

- Event, destination, dates, and group members
- Total and per-person budgets
- Hard rules: refundable-only, direct flight, hotel quality, maximum transfer time
- Preferences: aisle seat, airline, neighborhood, dinner type
- Autonomy level: plan only, ready for approval, or autopilot

### 2. Trip Assembly

The agent visibly builds the plan in stages: event → flight → stay → transfer → dinner. A live budget meter shows how one choice affects every other choice.

### 3. Tradeoff cards

Awayday never asks vague questions. It asks only when it cannot meet the user’s contract.

> **One tradeoff needs you**  
> Stay under budget with a 6:10 AM connecting flight, or spend $94 more for a direct flight. Which rule should bend?

### 4. Shared Arrival Contract

Each traveler can set private rules and payment approval limits. The group sees the shared plan and readiness score, not anyone else’s sensitive details.

### 5. Matchday Rescue

When conditions change, the agent finds the safest fix within its mandate: re-route transport, adjust a reservation, notify the group, or escalate one focused decision.

### 6. Matchday Memory Reel

After the event, Awayday creates a shareable recap with the itinerary, route, group moments, photos, match result, and spend summary. It is the memorable, social finish—not the core workflow.

## Why this is different

| Typical travel app | Awayday |
| --- | --- |
| Searches individual bookings | Owns a group arrival outcome |
| Shows lists of options | Assembles and protects one coordinated plan |
| Re-planning is manual | Detects disruptions and resolves them within rules |
| Optimizes each traveler separately | Optimizes the whole group, while respecting private constraints |
| Chat is the interface | A visual, live operational dashboard is the interface |

## Agent architecture

Awayday is built around a clear division of responsibility.

| Layer | Role | Example in Awayday |
| --- | --- | --- |
| **Zero** | Discover and invoke agent-ready external capabilities | Find an available restaurant, ground-transfer, weather, or reservation service when the agent needs it |
| **Nexla** | Unify and govern real-time data streams | Combine flight status, traffic, weather, venue entry windows, reservations, and group state into one live trip context |
| **Pomerium** | Enforce identity-aware, scoped permissions | Allow the agent to read a calendar, reserve dinner below a limit, or send alerts—without giving broad account or payment access |
| **Akash** | Run the persistent agent infrastructure | Host monitoring, orchestration workers, and real-time event processing |
| **LLM orchestration** | Plan, reason over constraints, and explain decisions | Select the best route, identify a conflict, and create a concise tradeoff card |

> Note: Zero accelerates dynamic tool access; it does not bypass supplier inventory, authentication, payment approval, or provider rules. The MVP can use a curated set of travel and local-service integrations while the architecture stays extensible.

### Live resolution loop

1. Nexla ingests a change such as a delay, weather alert, traffic spike, or reservation update.
2. The orchestration agent recomputes each traveler’s arrival path and the group readiness score.
3. The agent discovers or calls the necessary action through Zero-compatible tools.
4. Pomerium evaluates whether that action is permitted for this traveler, task, time, and dollar limit.
5. The agent executes an approved action or renders one tradeoff card for human approval.
6. The Arrival Confidence Map updates for the entire group.

## UI direction

The interface should feel like calm mission control, not a crowded booking website.

- **Top:** one-line mission and clear agent status
- **Center:** animated group journey map / timeline with a visible critical path
- **Right rail:** budget, rules, and autopilot status
- **Bottom sheet:** high-signal tradeoff cards and agent actions
- **Final state:** a polished, shareable matchday plan

The visual moment for a demo is a simulated disruption: the map turns amber/red, the agent proposes and performs a compliant repair, and `Kickoff Readiness` returns to green.

## MVP

### Build now

- Natural-language mission creation
- Mock or limited live event, flight, hotel, transfer, and dining data
- Constraint engine for budget, timing, refunds, ratings, and group preferences
- Trip Assembly screen with total budget and rationale
- Arrival Confidence Map with simulated disruption scenarios
- Tradeoff card and one-click approval flow
- Activity log explaining every agent action

### Build next

- Authenticated booking and payment workflows
- Calendar and email ingestion
- Live flight, traffic, weather, and venue feeds
- Per-user permission policies and spend mandates
- Multi-currency, ticket inventory, cancellation, and rebooking flows
- Post-match Memory Reel

## Demo script

1. Enter: “Get five friends to a Miami match by kickoff. Everyone has a different budget and no one wants a nonrefundable booking.”
2. Watch Awayday assemble the shared plan and show that the group is on track.
3. Introduce a delayed flight for one traveler.
4. The `Kickoff Readiness` score drops; the UI identifies the broken link.
5. Awayday re-routes airport transport and shifts dinner. If a budget rule must break, it asks one exact question.
6. Approve the tradeoff. The score returns green and the group receives an updated shared plan.

## Success metrics

- Time from mission to an approved, coherent plan
- Percentage of changes resolved without human intervention
- Number of questions asked per completed trip
- On-time group arrival rate
- Budget adherence rate
- User trust: approvals, overrides, and agent-action reversals

## Product principles

1. **Outcome over recommendations.** The system is accountable for a shared arrival, not a list of links.
2. **Autonomy with guardrails.** Users decide the rules; the agent does the coordination.
3. **Explain decisions, not hidden reasoning.** Show the practical reason and tradeoff behind every action.
4. **Protect private constraints.** A group plan should not expose one person’s financial or personal preferences.
5. **Ask less, but ask better.** Interrupt only when a user’s contract cannot be met.

## Suggested stack

- **Frontend:** Next.js, TypeScript, Tailwind CSS, Framer Motion, Mapbox
- **Backend:** Node.js / Python service layer, PostgreSQL, Redis, event queue
- **Agent orchestration:** durable workflow engine plus tool-calling LLM
- **Real-time:** WebSockets or Server-Sent Events for map and activity updates
- **Infrastructure:** Akash for workers/services; secure secrets and scoped access through Pomerium
- **Data and integrations:** Nexla for governed live data; Zero and curated providers for tool access

## Sponsor tooling

Keep sponsor credentials out of Git. Use short-lived development sessions where available and dedicated service credentials only when the deployed architecture needs them.

### Zero

```bash
zero --version
zero auth login
zero auth whoami
zero wallet balance
```

Zero provides dynamic capability discovery and invocation. Always inspect a capability before calling it and set an explicit `--max-pay` for paid calls.

### Nexla

Nexla's CLI package and access token are account-gated. Download the CLI from the Nexla console, install the downloaded package, then configure the environment:

```bash
pip3 install <downloaded-nexla-cli-package>
nexla env configure
```

Use a temporary session token for development. Create a scoped service key only when an unattended data flow exists.

### Pomerium

```bash
brew tap pomerium/tap
brew install pomerium-cli
pomerium-cli --version
```

Running the Pomerium gateway also requires Docker and a Pomerium Zero cluster token. Add its Compose configuration only after the protected Awayday service exists.

### Akash

```bash
brew tap akash-network/tap
brew install akash-provider-services
provider-services version
```

Create and fund an Akash wallet only when the first deployable container exists; wallet creation emits a recovery phrase that must be stored securely.

## Name

**Awayday** is the working name. Its core feature and promise is **Get Us There**.
