/**
 * The MongoDB arms of the agent tools (issue #1614): what `run_read_query`, `inspect_schema`, `inspect_plan` and
 * `profile_table` do on the `mongo` statement language.
 *
 * The harness is `kubectl-tools.test.ts`'s, on a MongoDB connection: the model's argument is a JSON OBJECT where
 * kubectl's is a line, and the one canonicaliser turns it into the text every server layer reads - so the assertions
 * here are about that form, the fence's refusals reaching nothing, and each arm's own reading.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { z } from "zod";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import {
  canonicalCommandText,
  type AgentToolContext,
  agentToolDefinition,
  runReadQueryTool,
  selectAgentTools,
} from "@/lib/agent/tools";
import { mongoInspectPlanTool, mongoInspectSchemaTool } from "@/lib/agent/mongo-tools";
import { draftedStatement, mongoProfileTable, profileTable } from "@/lib/agent/investigation";
import { mongoProfileTablePlan, runMongoProfile, mongoProfileModelText } from "@/lib/agent/mongo-tools";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { QueryError } from "@/lib/db/errors";
import type { DatabaseProvider, DatabaseObject, ObjectDetail } from "@/lib/db/types";
import type { AgentRunRecord, AgentRunEvent } from "@/lib/agent/types";
import { MongoDBProvider } from "@/lib/db/providers/document/mongodb";
import type { QueryResult } from "@/lib/types";

/** A MongoDB connection in the field form the seed file uses. */
const connection = {
  id: "seed:mongo-agent",
  name: "MongoDB agent",
  type: "mongodb" as const,
  host: "127.0.0.1",
  port: 27017,
  database: "app",
  user: "libredb_agent",
  password: "libredb_agent",
  createdAt: new Date(0),
};

const mongodb = new MongoDBProvider(connection);

/** A clock that never advances, so the deadline is never the reason anything fails. */
const frozenClock = () => 1_000;

interface MongoHarness {
  readonly context: AgentToolContext;
  readonly queryReadOnly: ReturnType<typeof mock>;
  readonly listObjects: ReturnType<typeof mock>;
  readonly describeObject: ReturnType<typeof mock>;
  readonly acquireProvider: ReturnType<typeof mock>;
}

function harness(overrides: Partial<AgentToolContext> = {}, result?: () => Promise<QueryResult>): MongoHarness {
  const queryReadOnly = mock(
    result === undefined
      ? async (): Promise<QueryResult> => ({
          rows: [{ customer: "Ada" }],
          fields: ["customer"],
          rowCount: 1,
          executionTime: 3,
        })
      : result,
  );
  const listObjects = mock(
    async (_container: readonly string[], kind: string): Promise<DatabaseObject[]> =>
      kind === "view"
        ? [{ name: "active_customers", kind: "view", path: ["app", "active_customers"] }]
        : [{ name: "orders", kind: "collection", path: ["app", "orders"] }],
  );
  const describeObject = mock(
    async (): Promise<ObjectDetail> => ({
      path: ["app", "orders"],
      columns: [
        { name: "customer", type: "string", nullable: true, isPrimary: false },
        { name: "status", type: "string", nullable: true, isPrimary: false },
      ],
      indexes: [{ name: "_id_", columns: ["_id"], unique: true }],
      foreignKeys: [],
    }),
  );
  const provider = {
    queryReadOnly,
    listObjects,
    describeObject,
    getCapabilities: () => mongodb.getCapabilities(),
  } as unknown as DatabaseProvider;
  const acquireProvider = mock(async () => provider);
  const context: AgentToolContext = {
    runId: "run-1",
    modelId: "unmeasured-model-for-tests",
    mode: "agent",
    workflowType: "investigation",
    statementLanguage: "mongo",
    actor: { sessionId: "session-1", role: "user" },
    connection,
    capabilities: mongodb.getCapabilities(),
    labels: mongodb.getLabels(),
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope(connection.id),
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2, frozenClock),
    repairs: new AgentRepairLedger(),
    acquireProvider,
    clock: () => 1_000,
    ...overrides,
  };
  return { context, queryReadOnly, listObjects, describeObject, acquireProvider };
}

let consoleSpy: ReturnType<typeof spyOn<Console, "log">>;

beforeEach(() => {
  consoleSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

const properties = (schema: unknown): string[] => Object.keys(z.toJSONSchema(schema as z.ZodType).properties ?? {});

const STATEMENT_WORKFLOWS = ["investigation", "query-optimization", "database-assessment", "data-analysis"] as const;

describe("run_read_query on mongo", () => {
  test("offers a command object on every mongo statement workflow, and the SQL argument stays SQL's", () => {
    for (const workflow of STATEMENT_WORKFLOWS) {
      const definition = agentToolDefinition("mongo", workflow, "run_read_query");
      expect(properties(definition.inputSchema), workflow).toEqual(["command", "rationale"]);
      expect(definition.operationId, workflow).toBe("mongo.query.read");
    }
    expect(properties(agentToolDefinition(undefined, "investigation", "run_read_query").inputSchema)).toEqual([
      "sql",
      "rationale",
    ]);
  });

  test("a mongo investigation is offered the catalog beside the read, and the analysis the profile too", () => {
    const investigation = selectAgentTools({
      mode: "agent",
      workflowType: "investigation",
      statementLanguage: "mongo",
    });
    expect(investigation.map((tool) => tool.name)).toEqual(["inspect_schema", "run_read_query", "compose_report"]);
    const analysis = selectAgentTools({ mode: "agent", workflowType: "data-analysis", statementLanguage: "mongo" });
    expect(analysis.map((tool) => tool.name)).toEqual([
      "inspect_schema",
      "run_read_query",
      "profile_table",
      "present_answer",
      "compose_report",
    ]);
  });

  test("an admitted command reaches the provider as canonical sorted-key text", async () => {
    const h = harness();
    const outcome = await runReadQueryTool(h.context, {
      command: { operation: "find", collection: "orders", filter: { status: "shipped" } },
      rationale: "read the orders",
    });
    expect(outcome.kind).toBe("completed");
    expect(h.queryReadOnly.mock.calls[0]?.[0]).toBe(
      '{"collection":"orders","filter":{"status":"shipped"},"operation":"find"}',
    );
    // The operation the audited pipeline recorded is the mongo one, not the SQL one.
    expect(outcome.kind === "completed" && outcome.artifact.operationId).toBe("mongo.query.read");
  });

  test("an empty command is invalid input, and the canonicaliser is total over the forms it takes", async () => {
    const h = harness();
    const empty = await runReadQueryTool(h.context, { command: {} });
    expect(empty.kind).toBe("unavailable");
    expect(empty.kind === "unavailable" && empty.reasonCode).toBe("INVALID_TOOL_INPUT");
    expect(h.queryReadOnly).not.toHaveBeenCalled();

    // The one canonicaliser the draft, the dispatch and the fingerprint all share.
    expect(canonicalCommandText('{"collection":"orders"}')).toBe('{"collection":"orders"}');
    expect(canonicalCommandText({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalCommandText({})).toBeNull();
    expect(canonicalCommandText([1])).toBeNull();
    expect(canonicalCommandText(null)).toBeNull();
    expect(canonicalCommandText(undefined)).toBeNull();
  });

  test("a write is answered with the fence's own sentence and reaches nothing", async () => {
    const h = harness();
    const outcome = await runReadQueryTool(h.context, {
      command: { collection: "orders", operation: "insertOne", documents: [{ a: 1 }] },
    });
    expect(outcome.kind).toBe("unavailable");
    expect(outcome.kind === "unavailable" && outcome.reasonCode).toBe("STATEMENT_NOT_ADMITTED");
    expect(outcome.kind === "unavailable" && outcome.detail).toContain("not one of the five reads");
    expect(h.acquireProvider).not.toHaveBeenCalled();
  });

  test("an sql argument on a mongo run is invalid input, and the field name is the language's own", async () => {
    const h = harness();
    const outcome = await runReadQueryTool(h.context, { sql: "SELECT 1" });
    expect(outcome.kind).toBe("unavailable");
    expect(outcome.kind === "unavailable" && outcome.reasonCode).toBe("INVALID_TOOL_INPUT");
    expect(h.queryReadOnly).not.toHaveBeenCalled();
  });
});

describe("inspect_schema on mongo", () => {
  test("a database-scoped read lists the collections through the provider's own inventory", async () => {
    const h = harness();
    const outcome = await mongoInspectSchemaTool(h.context, {});
    expect(outcome.kind).toBe("completed");
    expect(h.listObjects).toHaveBeenCalledWith(["app"], "collection");
    expect(outcome.kind === "completed" && outcome.artifact.operationId).toBe("mongo.schema.read");
  });

  test("a named collection is described in the kind the engine's own catalog row says", async () => {
    const h = harness();
    const outcome = await mongoInspectSchemaTool(h.context, { table: "orders" });
    expect(outcome.kind).toBe("completed");
    // The kind is resolved by listing the declared relation kinds until the name matches,
    // so a view is described as the view it is.
    expect(h.describeObject).toHaveBeenCalledWith(["app", "orders"], "collection");
    const view = await mongoInspectSchemaTool(h.context, { table: "active_customers" });
    expect(view.kind).toBe("completed");
    expect(h.describeObject).toHaveBeenLastCalledWith(["app", "active_customers"], "view");
  });

  test("the indexes kind describes the same collection, and a database-wide index inventory is redirected", async () => {
    const h = harness();
    const one = await mongoInspectSchemaTool(h.context, { kind: "indexes", table: "orders" });
    expect(one.kind).toBe("completed");
    expect(h.describeObject).toHaveBeenCalledTimes(1);

    const broad = await mongoInspectSchemaTool(h.context, { kind: "indexes" });
    expect(broad.kind).toBe("unavailable");
    expect(broad.kind === "unavailable" && broad.reasonCode).toBe("KIND_REFUSED");
    expect(broad.kind === "unavailable" && broad.detail).toContain("index-stats");
  });

  test("a relations read is refused as an absence the engine never stated", async () => {
    const h = harness();
    const outcome = await mongoInspectSchemaTool(h.context, { kind: "relations" });
    expect(outcome.kind).toBe("unavailable");
    expect(outcome.kind === "unavailable" && outcome.reasonCode).toBe("KIND_REFUSED");
    expect(outcome.kind === "unavailable" && outcome.detail).toContain("no foreign keys");
    expect(h.listObjects).not.toHaveBeenCalled();
  });

  test("a name no relation kind holds is refused with the name in the sentence", async () => {
    const h = harness();
    // The arm surfaces not-found as a QueryError the pipeline maps - the name and the
    // database in the sentence, so the model can correct the one thing it got wrong.
    await expect(mongoInspectSchemaTool(h.context, { table: "no_such" })).rejects.toThrow(
      /No collection named no_such in app/,
    );
    expect(h.describeObject).not.toHaveBeenCalled();
  });
});

describe("inspect_plan on mongo", () => {
  test("takes a command object and plans it under the estimating operation", async () => {
    const h = harness();
    const outcome = await mongoInspectPlanTool(h.context, {
      command: { collection: "orders", operation: "find", filter: { customer: "Ada" } },
    });
    expect(outcome.kind).toBe("completed");
    // The statement the provider is asked to plan is the canonical text, and the mode is the estimating one.
    const call = h.queryReadOnly.mock.calls[0];
    expect(call?.[0]).toBe('{"collection":"orders","filter":{"customer":"Ada"},"operation":"find"}');
    expect(call?.[2]).toBe("estimate-plan");
    expect(outcome.kind === "completed" && outcome.artifact.operationId).toBe("mongo.plan.estimate");
  });

  test("a shape the fence refuses is answered before anything is planned", async () => {
    const h = harness();
    const outcome = await mongoInspectPlanTool(h.context, {
      command: { collection: "orders", operation: "insertOne" },
    });
    // The plan descriptor's input validates the command's text with the same admission the read path uses,
    // so a write is refused by the pipeline's own input stage: the audited refusal, never the tool's.
    expect(outcome.kind).toBe("refused");
    expect(h.queryReadOnly).not.toHaveBeenCalled();
  });
});

describe("profile_table on mongo", () => {
  /** The snapshot's objects, in the shape a captured context-carrying event holds. */
  const objects = [
    {
      path: ["app", "orders"],
      name: "orders",
      kind: "collection",
      columns: [
        { name: "customer", type: "string", nullable: true, isPrimary: false },
        { name: "status", type: "string", nullable: true, isPrimary: false },
        { name: "total", type: "double", nullable: true, isPrimary: false },
      ],
      indexes: [],
      foreignKeys: [],
    },
  ];
  const recordWithSnapshot = (events: readonly AgentRunEvent[] = []): AgentRunRecord =>
    ({
      runId: "run-1",
      status: "running",
      events: [
        ...events,
        // The captured event carries the INVENTORY as one field, the shape a resumed run reads.
        {
          kind: "context-captured",
          atMs: 0,
          fingerprint: "fp",
          tableCount: objects.length,
          snapshot: { objects, kinds: [] },
        } as unknown as AgentRunEvent,
      ],
    }) as unknown as AgentRunRecord;

  test("the composition is server-side: one $group whose aliases are the SQL composition's", () => {
    const plan = mongoProfileTablePlan(objects, { table: "orders", depth: "basic" });
    if ("refusal" in plan) throw new Error(plan.refusal);
    const pipeline = (JSON.parse(plan.statement) as { pipeline: Record<string, unknown>[] }).pipeline;
    const group = pipeline[0]?.$group as Record<string, unknown>;
    expect(group.row_count).toEqual({ $sum: 1 });
    expect(group.present_0).toEqual({
      $sum: { $cond: [{ $in: [{ $type: "$customer" }, ["missing", "null"]] }, 0, 1] },
    });
    expect(plan.columns.map((column) => column.name)).toEqual(["customer", "status", "total"]);
  });

  test("pattern depth adds the shape tests on textual fields only, and the statement stays one read", () => {
    const plan = mongoProfileTablePlan(objects, { table: "orders", depth: "pattern" });
    if ("refusal" in plan) throw new Error(plan.refusal);
    const group = (JSON.parse(plan.statement) as { pipeline: Record<string, unknown>[] }).pipeline[0]?.$group as Record<
      string,
      unknown
    >;
    expect(group.shaped_0).toBeDefined();
    expect(group.shaped_2).toBeUndefined();
    expect(group.digits_0).toBeDefined();
  });

  test("distribution is refused with the cost it would take, and an unknown name with the candidates", () => {
    const distribution = mongoProfileTablePlan(objects, { table: "orders", depth: "distribution" });
    expect("refusal" in distribution && distribution.refusal).toContain("no one-statement shape");
    const unknown = mongoProfileTablePlan(objects, { table: "no_such" });
    expect("refusal" in unknown && unknown.refusal).toContain("No collection named no_such");
    // An input that does not parse as a selector at all is refused with the schema's own
    // rendering, naming every issue on one line.
    const malformed = mongoProfileTablePlan(objects, "not a selector" as unknown as { table?: string });
    expect("refusal" in malformed && malformed.refusal).toContain("expected object");
  });

  test("the run settles a step, records the table-profiled event, and answers in the SQL arm's sentences", async () => {
    // The row the composed aggregate answers: the aliases readTableProfile reads on either engine.
    const h = harness(undefined, async () => ({
      rows: [{ row_count: 7, present_0: 7, present_1: 6, present_2: 5 }],
      fields: ["row_count", "present_0", "present_1", "present_2"],
      rowCount: 1,
      executionTime: 3,
    }));
    const recorded: AgentRunEvent[] = [];
    const service = {
      resume: async () => ({ record: recordWithSnapshot() }),
      runStep: async (_runId: string, _step: unknown, execute: () => Promise<unknown>) => {
        await execute();
        return { kind: "performed" as const };
      },
      recordEvent: async (_runId: string, event: AgentRunEvent) => {
        recorded.push(event);
      },
    } as unknown as Parameters<typeof mongoProfileTable>[0];

    const result = await mongoProfileTable(
      service,
      h.context,
      recordWithSnapshot(),
      { table: "orders", depth: "basic" },
      new Set(),
      new Set(),
    );
    expect(result.kind).toBe("answered");
    if (result.kind === "answered") {
      expect(result.text).toContain("Profiled a collection");
      expect(result.text).toContain("Only counts were read");
    }
    const profiled = recorded.find((event) => event.kind === "table-profiled");
    expect(profiled).toBeDefined();
  });

  test("a read the provider refuses settles as refused, with the refusal's own sentence", async () => {
    const h = harness(undefined, async () => {
      throw new QueryError("Read-only execution exceeded the row budget: 11 rows > 10 allowed", "mongodb", "");
    });
    const settled: unknown[] = [];
    const service = {
      resume: async () => ({ record: recordWithSnapshot() }),
      runStep: async (_runId: string, _step: unknown, execute: () => Promise<unknown>) => {
        await execute();
        return { kind: "performed" as const };
      },
      recordEvent: async () => {},
    } as unknown as Parameters<typeof mongoProfileTable>[0];
    const refused = await mongoProfileTable(
      service,
      h.context,
      recordWithSnapshot(),
      { table: "orders" },
      new Set(),
      new Set(),
    );
    expect(refused.kind).toBe("answered");
    // The refusal's own model text is what the model reads: the row-budget sentence, not a
    // silent nothing.
    if (refused.kind === "answered") expect(refused.text).toContain("row budget");
  });

  test("a profile whose row does not map is PROFILE_UNREADABLE, refused rather than reported", async () => {
    // A read that answers no alias row: readTableProfile maps it to null, and the arm says so.
    const h = harness(undefined, async () => ({
      rows: [{ customer: "Ada" }],
      fields: ["customer"],
      rowCount: 1,
      executionTime: 3,
    }));
    const service = {
      resume: async () => ({ record: recordWithSnapshot() }),
      runStep: async (_runId: string, _step: unknown, execute: () => Promise<unknown>) => {
        await execute();
        return { kind: "performed" as const };
      },
      recordEvent: async () => {},
    } as unknown as Parameters<typeof mongoProfileTable>[0];
    const outcome = await mongoProfileTable(
      service,
      h.context,
      recordWithSnapshot(),
      { table: "orders" },
      new Set(),
      new Set(),
    );
    expect(outcome.kind).toBe("answered");
    // The arm's own sentence for a row that did not map: the counts could not be read, and
    // the model is told what to change - not a bare refusal code.
    if (outcome.kind === "answered") expect(outcome.text).toContain("could not be read as counts");
  });

  test("the draft of a command the model wrote as an object is the canonical text, with its rationale", async () => {
    // draftedStatement is the run loop's own entry: the model's input, the language's argument.
    const draft = draftedStatement(
      { command: { operation: "find", collection: "orders" }, rationale: "count the orders" },
      "command",
    );
    expect(draft).toEqual({ sql: '{"collection":"orders","operation":"find"}', rationale: "count the orders" });
    // No rationale is "(none given)", the sentence the SQL drafts settled on long ago.
    const bare = draftedStatement({ command: { collection: "orders", operation: "count" } }, "command");
    expect(bare?.rationale).toBe("(none given)");
    // A command that carries no statement (an empty object) drafts nothing.
    expect(draftedStatement({ command: {} }, "command")).toBeNull();
    // The other languages' text passes through unchanged.
    expect(draftedStatement({ sql: "SELECT 1" }, "sql")).toEqual({ sql: "SELECT 1", rationale: "(none given)" });
  });

  test("a replayed profile answers from the ledger, and an unsettled one honestly cannot be known", async () => {
    const h = harness(undefined, async () => ({
      rows: [{ row_count: 7, present_0: 7 }],
      fields: ["row_count", "present_0"],
      rowCount: 1,
      executionTime: 3,
    }));
    // Replayed: the step is already on the ledger, so re-reading would spend a statement to
    // learn what the run already knows.
    const replayed = await mongoProfileTable(
      {
        resume: async () => ({ record: recordWithSnapshot() }),
        runStep: async () => ({
          kind: "replayed" as const,
          event: {
            kind: "tool-completed" as const,
            stepId: "s",
            artifact: {
              correlationId: "a",
              operationId: "mongo.table.profile",
              summary: { rowCount: 7, elapsedMs: 3 },
            },
          },
        }),
        recordEvent: async () => {},
      } as unknown as Parameters<typeof mongoProfileTable>[0],
      h.context,
      recordWithSnapshot(),
      { table: "orders" },
      new Set(),
      new Set(),
    );
    expect(replayed.kind).toBe("answered");
    if (replayed.kind === "answered") expect(replayed.text).toContain("already taken in this run");

    // Indeterminate: the step was started before an interruption and nothing was recorded.
    const indeterminate = await mongoProfileTable(
      {
        resume: async () => ({ record: recordWithSnapshot() }),
        runStep: async () => ({ kind: "indeterminate" as const, stepId: "step_x" }),
        recordEvent: async () => {},
      } as unknown as Parameters<typeof mongoProfileTable>[0],
      h.context,
      recordWithSnapshot(),
      { table: "orders" },
      new Set(),
      new Set(),
    );
    expect(indeterminate.kind).toBe("answered");
    if (indeterminate.kind === "answered") expect(indeterminate.text).toContain("outcome was never recorded");

    // Cancelled and paused settle the run, not the call.
    const cancelled = await mongoProfileTable(
      {
        resume: async () => ({ record: recordWithSnapshot() }),
        runStep: async () => ({ kind: "cancelled" as const }),
        recordEvent: async () => {},
      } as unknown as Parameters<typeof mongoProfileTable>[0],
      h.context,
      recordWithSnapshot(),
      { table: "orders" },
      new Set(),
      new Set(),
    );
    expect(cancelled.kind).toBe("cancelled");
  });

  test("the dispatch hands a mongo run to the mongo arm, which is the arm under test here", async () => {
    // profileTable is the dispatcher both languages share: it resolves the run's language and
    // hands the call to this arm - the one seam where a mongo run could be routed to the SQL
    // composition by mistake, so the seam itself is asserted.
    const h = harness(undefined, async () => ({
      rows: [{ row_count: 7, present_0: 7 }],
      fields: ["row_count", "present_0"],
      rowCount: 1,
      executionTime: 3,
    }));
    const result = await profileTable(
      {
        resume: async () => ({ record: recordWithSnapshot() }),
        runStep: async (_runId: string, _step: unknown, execute: () => Promise<unknown>) => {
          await execute();
          return { kind: "performed" as const };
        },
        recordEvent: async () => {},
      } as unknown as Parameters<typeof profileTable>[0],
      h.context,
      { input: { table: "orders", depth: "basic" } },
      new Set(),
      new Set(),
    );
    expect(result.kind).toBe("answered");
    if (result.kind === "answered") expect(result.text).toContain("Profiled a collection");
  });

  test("the profile's model text fences the collection name and states the counts-only contract", () => {
    const plan = mongoProfileTablePlan(objects, { table: "orders" });
    if ("refusal" in plan) throw new Error(plan.refusal);
    const text = mongoProfileModelText(
      { table: "orders", depth: "basic", rowCount: 7, columns: [], findings: [] } as never,
      {
        runId: "run-1",
        operationId: "mongo.table.profile",
        correlationId: "abc123",
        summary: { rowCount: 1, elapsedMs: 1 },
      } as never,
      plan,
    );
    expect(text).toContain("Profiled a collection");
    expect(text).toContain("abc123");
    expect(text).toContain("UNTRUSTED");
  });
});
