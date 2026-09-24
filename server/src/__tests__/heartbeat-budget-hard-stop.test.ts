import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

// Per-agent adapter behaviour: the spender reports a billed cost that crosses the
// budget, the bystander blocks until the test releases it (a run still in flight).
const adapterBehaviour = vi.hoisted(() => ({
  costUsdByAgent: new Map<string, number>(),
  blockers: new Map<string, { promise: Promise<void>; release: () => void }>(),
}));

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (ctx: { agent: { id: string } }) => {
    const blocker = adapterBehaviour.blockers.get(ctx.agent.id);
    if (blocker) await blocker.promise;
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Budget hard-stop test run.",
      provider: "test",
      biller: "test",
      model: "test-model",
      billingType: "metered_api",
      costUsd: adapterBehaviour.costUsdByAgent.get(ctx.agent.id) ?? 0,
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat budget hard-stop tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

function createBlocker() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describeEmbeddedPostgres("heartbeat budget hard-stop enforcement", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-budget-hard-stop-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    for (const blocker of adapterBehaviour.blockers.values()) blocker.release();
    adapterBehaviour.blockers.clear();
    adapterBehaviour.costUsdByAgent.clear();
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await waitForCondition(async () => {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      return runs.every((run) => run.status !== "queued" && run.status !== "running");
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "budget_incidents",
        "approvals",
        "budget_policies",
        "heartbeat_run_events",
        "cost_events",
        "activity_log",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  async function seedHardStopPolicy(input: {
    companyId: string;
    scopeType: "company" | "agent";
    scopeId: string;
    amountCents: number;
  }) {
    await db.insert(budgetPolicies).values({
      companyId: input.companyId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: input.amountCents,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });
  }

  async function getRunStatus(runId: string) {
    return db
      .select({ status: heartbeatRuns.status, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  it("lets the crossing run finish, then pauses the agent and blocks its next wakeup", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Spender");
    await seedHardStopPolicy({ companyId, scopeType: "agent", scopeId: agentId, amountCents: 100 });
    // A single run that alone costs more than the whole budget.
    adapterBehaviour.costUsdByAgent.set(agentId, 1.5);

    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual" });
    expect(run).not.toBeNull();

    // The budget pause is applied when the run's cost event is recorded, after the
    // run itself is marked succeeded; finalizeAgentStatus() must then keep it.
    await waitForCondition(async () => {
      const [agent] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, agentId));
      return agent?.status === "paused";
    });

    // The enforcement is reactive: the run that crosses the limit is not cut short,
    // so the ledger records the overshoot.
    expect(await getRunStatus(run!.id)).toMatchObject({ status: "succeeded" });
    const [spend] = await db
      .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
      .from(costEvents)
      .where(eq(costEvents.agentId, agentId));
    expect(spend?.total).toBe(150);

    const [agent] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(agent).toMatchObject({ status: "paused", pauseReason: "budget" });

    const incidents = await db
      .select({ thresholdType: budgetIncidents.thresholdType })
      .from(budgetIncidents)
      .where(and(eq(budgetIncidents.companyId, companyId), eq(budgetIncidents.scopeId, agentId)));
    expect(incidents.map((incident) => incident.thresholdType)).toContain("hard");

    await expect(
      heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("cancels another agent's in-flight run when a company hard-stop is crossed", async () => {
    const companyId = await seedCompany();
    const spenderId = await seedAgent(companyId, "Spender");
    const bystanderId = await seedAgent(companyId, "Bystander");
    await seedHardStopPolicy({ companyId, scopeType: "company", scopeId: companyId, amountCents: 100 });
    adapterBehaviour.costUsdByAgent.set(spenderId, 1.5);
    const bystanderBlocker = createBlocker();
    adapterBehaviour.blockers.set(bystanderId, bystanderBlocker);

    const bystanderRun = await heartbeat.wakeup(bystanderId, { source: "on_demand", triggerDetail: "manual" });
    expect(bystanderRun).not.toBeNull();
    await waitForCondition(async () =>
      mockAdapterExecute.mock.calls.some(([ctx]) => ctx.agent.id === bystanderId),
    );
    expect((await getRunStatus(bystanderRun!.id))?.status).toBe("running");

    const spenderRun = await heartbeat.wakeup(spenderId, { source: "on_demand", triggerDetail: "manual" });
    expect(spenderRun).not.toBeNull();

    await waitForCondition(async () => (await getRunStatus(bystanderRun!.id))?.status === "cancelled");
    expect(await getRunStatus(bystanderRun!.id)).toMatchObject({
      status: "cancelled",
      error: "Cancelled due to budget pause",
    });
    expect((await getRunStatus(spenderRun!.id))?.status).toBe("succeeded");

    const [company] = await db
      .select({ status: companies.status, pauseReason: companies.pauseReason })
      .from(companies)
      .where(eq(companies.id, companyId));
    expect(company).toMatchObject({ status: "paused", pauseReason: "budget" });

    // When the cancelled adapter call finally returns, it must not resurrect the run.
    bystanderBlocker.release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await getRunStatus(bystanderRun!.id))?.status).toBe("cancelled");

    // A budget-paused company suppresses wakes (skipped, not a 409) before the
    // budget invocation check is reached.
    const executeCallsBefore = mockAdapterExecute.mock.calls.length;
    await expect(
      heartbeat.wakeup(bystanderId, { source: "on_demand", triggerDetail: "manual" }),
    ).resolves.toBeNull();
    const skipped = await db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, bystanderId),
          eq(agentWakeupRequests.status, "skipped"),
        ),
      );
    expect(skipped).toEqual([{ status: "skipped", reason: "company.inactive" }]);
    expect(mockAdapterExecute.mock.calls.length).toBe(executeCallsBefore);
  });
});
