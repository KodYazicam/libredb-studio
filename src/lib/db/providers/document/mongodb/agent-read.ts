/**
 * The agent's read-only execution profile for MongoDB (issue #1614): the bounded read itself. The boundary and its
 * proof at open are `agent-boundary.ts`'s.
 *
 * **The statement itself is bounded five ways**, each stated where it is enforced:
 * the fence (`mongo-admission.ts`) admits the five read operations of the editor's
 * envelope and refuses the write stages of a pipeline; the driver call carries
 * `maxTimeMS`, the SERVER's own deadline (measured: `code 50` ended a `$where`
 * `sleep()` past its 500 ms budget); the find and aggregate calls are capped at one
 * row past the budget SERVER-SIDE (`limit`, a trailing `$limit`), so an unbounded
 * cursor is never materialised in Node; the client owns a backstop timer for the case
 * the server's deadline does not fire; and the assembled result is refused on the
 * row budget's one-past signal and on the byte budget, which is where a `distinct` -
 * whose reply is the whole array of values, not a cursor - is bounded.
 *
 * What this profile does NOT overclaim: MongoDB's profiler, once switched on, writes on
 * every read; `getSlowQueries()` reads `system.profile` and the empty panel is the
 * ordinary case (see the provider's labels). The boundary is about what THIS principal
 * can do, not about what the server records.
 */
import { QueryError, mapDatabaseError } from "../../../errors";
import { assertReadOnlyBudget, measureRowBytes } from "../../sql/read-only-budget";
import type { ReadOnlyStatementBudget } from "../../../types";
import type { Db, Document, MongoClient } from "mongodb";
import type { RevivedMongoReadEnvelope } from "./extended-json";
import { serializeMongoDocument } from "./values";

/**
 * The comment every command of the agent's carries, and the application name of its client (`index.ts`), so the
 * server's own records of a run (the profiler, the slow-query log, `$currentOp`, an audited authorization failure)
 * can be told from every other client's.
 */
export const AGENT_COMMAND_COMMENT = "libredb-studio-agent";

/** The client's backstop: how long after the server's own deadline the owned timer fires. */
const CLIENT_BACKSTOP_SLACK_MS = 2_000;

/** What a statement past `maxTimeMS` answers (measured: the executor's kill). */
const MONGO_MAX_TIME_EXPIRED_CODE = 50;

/**
 * One read's answer, in the shape the agent pipeline takes from every other engine:
 * rows as JSON-safe records, fields as their column names, and the elapsed time.
 */
export interface MongoAgentReadResult {
  readonly rows: Record<string, unknown>[];
  readonly fields: string[];
  readonly rowCount: number;
  readonly executionTime: number;
}

/**
 * The server's own deadline on one statement, as `maxTimeMS`. The number is the budget's
 * own, so the deadline a run shows the model is the deadline the server holds.
 */
function serverDeadline(budget: ReadOnlyStatementBudget): number {
  return Math.max(1, budget.statementTimeoutMs);
}

/**
 * The owned backstop: a timer this module fires when the server's own deadline did not.
 * It is granted the slack above the server's deadline so the two never race a correct
 * refusal - the backstop exists for the silent server, not the punctual one - and a
 * cursor it fires under is closed, which ends the iteration on the wire too.
 */
function withClientBackstop<T>(read: () => Promise<T>, budget: ReadOnlyStatementBudget): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const backstop = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new QueryError(
            `Read-only execution exceeded the statement deadline of ${budget.statementTimeoutMs}ms and the server did not end it, so the client stopped waiting`,
            "mongodb",
            "",
          ),
        ),
      budget.statementTimeoutMs + CLIENT_BACKSTOP_SLACK_MS,
    );
  });
  return Promise.race([read(), backstop]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** One past the row budget: the extra row is the signal, exactly as the SQL engines use it. */
function rowBound(budget: ReadOnlyStatementBudget): number {
  return budget.maxResultRows + 1;
}

/** The row-budget refusal, in the sentence the SQL profile already established. */
function rowBudgetRefusal(rows: number, budget: ReadOnlyStatementBudget, statement: string): QueryError {
  return new QueryError(
    `Read-only execution exceeded the row budget: ${rows} rows > ${budget.maxResultRows} allowed`,
    "mongodb",
    statement,
  );
}

/** The byte-budget refusal, same sentence, measured on the assembled rows. */
function byteBudgetRefusal(bytes: number, budget: ReadOnlyStatementBudget, statement: string): QueryError {
  return new QueryError(
    `Read-only execution exceeded the byte budget: ${bytes} bytes > ${budget.maxResultBytes} allowed`,
    "mongodb",
    statement,
  );
}

/**
 * One admitted statement, read under the profile's bounds.
 *
 * The envelope is the EDITOR's own, so what the run executes is what the user's editor
 * runs for the same text, and the hand-over of an auto-executed answer needs no
 * translation. `find` and `aggregate` are capped server-side - `limit` clamped to one
 * past the budget, a trailing `$limit` appended - so the rows a cursor can deliver are
 * bounded before they cross the wire; `distinct`'s reply is the whole array, which the
 * row budget refuses after assembly; `count` answers one number.
 *
 * `mode: "estimate-plan"` wraps the envelope's own operation in the server's `explain`
 * at `queryPlanner` verbosity, which plans and does not execute - the estimate the SQL
 * engines take from an `EXPLAIN`, in this engine's own word.
 */
export async function readMongoForAgent(
  client: MongoClient,
  databaseName: string,
  envelope: RevivedMongoReadEnvelope,
  budget: ReadOnlyStatementBudget,
  mode: "execute" | "estimate-plan",
  statement: string,
): Promise<MongoAgentReadResult> {
  assertReadOnlyBudget(budget, "mongodb");
  const db = envelope.database !== undefined ? client.db(envelope.database) : client.db(databaseName);
  const startedAt = Date.now();
  let documents: Document[];
  try {
    documents = await withClientBackstop(
      () => (mode === "estimate-plan" ? explainEnvelope(db, envelope, budget) : readEnvelope(db, envelope, budget)),
      budget,
    );
  } catch (error) {
    if (isMaxTimeExpired(error)) {
      throw new QueryError(
        `Read-only execution exceeded the statement deadline of ${budget.statementTimeoutMs}ms and was killed server-side`,
        "mongodb",
        statement,
      );
    }
    throw error instanceof QueryError ? error : mapDatabaseError(error, "mongodb", statement);
  }

  // The +1 row is the budget's own signal, read here rather than refused server-side for
  // the operations whose reply is assembled rather than cursored.
  if (documents.length > budget.maxResultRows) {
    throw rowBudgetRefusal(documents.length, budget, statement);
  }
  let bytes = 0;
  for (const document of documents) {
    bytes += measureRowBytes(document);
    if (bytes > budget.maxResultBytes) {
      throw byteBudgetRefusal(bytes, budget, statement);
    }
  }

  const rows = documents.map((document) => serializeMongoDocument(document));
  const fields = [...new Set(documents.flatMap((document) => Object.keys(document)))];
  return { rows, fields, rowCount: rows.length, executionTime: Date.now() - startedAt };
}

async function readEnvelope(
  db: Db,
  envelope: RevivedMongoReadEnvelope,
  budget: ReadOnlyStatementBudget,
): Promise<Document[]> {
  const collection = db.collection(envelope.collection);
  const maxTimeMS = serverDeadline(budget);
  switch (envelope.operation) {
    case "find": {
      const cursor = collection.find(envelope.filter ?? {});
      if (envelope.options?.projection !== undefined) cursor.project(envelope.options.projection);
      if (envelope.options?.sort !== undefined) cursor.sort(envelope.options.sort);
      if (envelope.options?.skip !== undefined) cursor.skip(envelope.options.skip);
      // One past the budget, or the envelope's own limit when it is smaller: the server
      // stops the cursor there, so the rows arrive already bounded.
      cursor.limit(Math.min(envelope.options?.limit ?? Number.POSITIVE_INFINITY, rowBound(budget)));
      cursor.maxTimeMS(maxTimeMS);
      try {
        return await cursor.toArray();
      } finally {
        await cursor.close().catch(() => {});
      }
    }
    case "findOne": {
      const document = await collection.findOne(envelope.filter ?? {}, {
        projection: envelope.options?.projection,
        maxTimeMS,
      });
      return document === null ? [] : [document];
    }
    case "aggregate": {
      const pipeline = [...(envelope.pipeline ?? []), { $limit: rowBound(budget) }];
      const cursor = collection.aggregate(pipeline, { maxTimeMS });
      try {
        return await cursor.toArray();
      } finally {
        await cursor.close().catch(() => {});
      }
    }
    case "count": {
      const count = await collection.countDocuments(envelope.filter ?? {}, { maxTimeMS });
      return [{ count }];
    }
    case "distinct": {
      const values = await collection.distinct(envelope.field!, envelope.filter ?? {}, { maxTimeMS });
      return values.map((value) => ({ [envelope.field!]: value }));
    }
  }
}

/**
 * The estimating plan: the envelope's own operation, wrapped in `explain` at
 * `queryPlanner` verbosity - measured on MongoDB 9.0.4, the reply carries
 * `queryPlanner.winningPlan` and `serverInfo` and runs no pipeline. The one row is the
 * plan itself, serialized the way every other row is.
 */
async function explainEnvelope(
  db: Db,
  envelope: RevivedMongoReadEnvelope,
  budget: ReadOnlyStatementBudget,
): Promise<Document[]> {
  const command = explainCommandFor(envelope);
  const explained = await db.command({ explain: command, verbosity: "queryPlanner" });
  return [explained as Document];
}

/** The envelope's operation as the `explain` command takes it: the wire form of the same read. */
function explainCommandFor(envelope: RevivedMongoReadEnvelope): Document {
  switch (envelope.operation) {
    case "find": {
      const find: Document = { find: envelope.collection, filter: envelope.filter ?? {} };
      if (envelope.options?.sort !== undefined) find.sort = envelope.options.sort;
      if (envelope.options?.projection !== undefined) find.projection = envelope.options.projection;
      if (envelope.options?.skip !== undefined) find.skip = envelope.options.skip;
      if (envelope.options?.limit !== undefined) find.limit = envelope.options.limit;
      return find;
    }
    case "aggregate":
      return { aggregate: envelope.collection, pipeline: envelope.pipeline ?? [], cursor: {} };
    case "count":
      return { count: envelope.collection, query: envelope.filter ?? {} };
    case "distinct":
      return { distinct: envelope.collection, key: envelope.field, query: envelope.filter ?? {} };
    case "findOne":
      return { find: envelope.collection, filter: envelope.filter ?? {}, limit: 1 };
  }
}

function isMaxTimeExpired(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === MONGO_MAX_TIME_EXPIRED_CODE
  );
}
