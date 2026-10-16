/**
 * The agent's admission of one MongoDB statement, next to the descriptor that reads it (`mongo.query.read`).
 *
 * The statement is the EDITOR's own command envelope - `{"collection": "...", "operation": "find", ...}` - parsed by
 * the same Extended-JSON rules the editor's `query()` parses it with, so what the model is told it may write is
 * exactly what the user's editor runs. The fence admits the five READ operations of that envelope and refuses
 * everything else: the writes the editor also accepts (`insertOne` and friends), the write stages of an aggregation
 * pipeline (`$out`, `$merge`), the SERVER-SIDE JAVASCRIPT operators (`$where`, `$function`, `$accumulator`) wherever
 * they sit in the envelope, a document that carries two operations, and an unknown top-level key. 4,096
 * characters is a deliberately narrower contract than the editor's own, for the reason the kubectl fence's is: a
 * model has no reason to send a longer read, and a shorter contract is one it can be told.
 *
 * Not the boundary. The boundary is the server's own refusal of everything the `read` role cannot do, proven at
 * open by a negative write probe (`mongodb-agent.ts`); this is what lets the model read the reason it was refused,
 * before anything is sent.
 *
 * WHY THE JAVASCRIPT OPERATORS ARE REFUSED, stated rather than implied: they are not writes - they cannot write,
 * and nothing they read leaves the collection the command already names - and `maxTimeMS` bounds even a busy loop
 * (measured: a `$where` `sleep()` died at its 500 ms budget). The refusal is a DECLARATION, not a mitigation: every
 * other layer of this profile trusts exactly two things, the principal's roles and the server's own deadline, and
 * admitting model-authored code into the engine's JavaScript sandbox would silently add a third - the sandbox. A
 * trust boundary nobody declared is the one a reviewer has to find by reading the engine's internals; this fence's
 * sentence says it instead, and a model with a genuine condition to express can express it as a plain filter or an
 * aggregation expression, which is what nearly every read already is.
 */
import { z } from "zod";
import { parseExtendedJson } from "@/lib/db/providers/document/mongodb";

export const MONGO_AGENT_MAX_STATEMENT_CHARS = 4096;

/** The operations of the editor's envelope the agent admits: the read set, and only it. */
const AGENT_READ_OPERATIONS: ReadonlySet<string> = new Set(["find", "findOne", "aggregate", "count", "distinct"]);

/** The top-level keys the envelope defines. Anything else is refused rather than ignored. */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "collection",
  "database",
  "operation",
  "filter",
  "pipeline",
  "field",
  "options",
]);

/** The aggregation stages that write, in the spelling the server knows them. */
const PIPELINE_WRITE_STAGES: ReadonlySet<string> = new Set(["$out", "$merge"]);

/**
 * The operators that run JavaScript ON THE SERVER, in the spelling the engine knows them: `$where` in a filter
 * (including inside `$and`/`$or` and a `$match` stage), `$function` and `$accumulator` in an aggregation expression
 * (including inside `$expr` in a filter). Their PRESENCE is the refusal, not their value: the key is the operator,
 * and a body arrives as code the model wrote.
 *
 * No false positives are possible at the key level: a JSON key starting with `$` in a filter or a pipeline is an
 * operator by the engine's own grammar - field names cannot carry the prefix - and the operators that merely match
 * and compute (`$regex`, `$regexMatch`, `$expr`, `$cond`) are not in this set.
 */
const SERVER_SIDE_JAVASCRIPT_KEYS: ReadonlySet<string> = new Set(["$where", "$function", "$accumulator"]);

export type MongoAdmissionCode =
  | "agent-too-large"
  | "not-json"
  | "not-one-command"
  | "unknown-key"
  | "missing-collection"
  | "missing-operation"
  | "non-read-operation"
  | "write-payload"
  | "bad-pipeline"
  | "pipeline-writes"
  | "server-side-javascript"
  | "bad-filter"
  | "missing-field"
  | "bad-options"
  | "bad-database";

export interface MongoAdmissionRefusal {
  readonly code: MongoAdmissionCode;
  readonly message: string;
}

const EXAMPLE =
  '{"collection": "orders", "operation": "find", "filter": {"status": "shipped"}, "options": {"limit": 50}}';

/**
 * The refusal an agent's MongoDB statement meets before anything is sent, or null when it is admitted.
 *
 * Every message names what to change, because a refusal that carries nothing is a loop the ledger has already
 * recorded (`tools.ts`): the sentence is the half a model can act on.
 */
export function admitMongoStatement(text: string): MongoAdmissionRefusal | null {
  if (text.length > MONGO_AGENT_MAX_STATEMENT_CHARS) {
    return {
      code: "agent-too-large",
      message: `The statement is longer than ${MONGO_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: narrow the filter or the pipeline. Nothing was sent.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = parseExtendedJson(text.trim());
  } catch {
    return {
      code: "not-json",
      message: `The statement is not the JSON command envelope this database takes, so nothing was sent. The envelope is ${EXAMPLE}`,
    };
  }
  // An array - or any non-object - is a document that names no one command: two reads in one statement is the
  // shape this refuses, the same single-command rule the SQL fence's one-determinate-statement check enforces.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      code: "not-one-command",
      message: `The statement must be one JSON command object, not a list or a bare value. Send one read per statement, for example ${EXAMPLE}`,
    };
  }
  const command = parsed as Record<string, unknown>;
  if (typeof command.collection !== "string" || command.collection.length === 0) {
    return {
      code: "missing-collection",
      message: 'The command names no collection. Add "collection": "<name>" to the envelope. Nothing was sent.',
    };
  }
  const operation = command.operation;
  if (typeof operation !== "string" || operation.length === 0) {
    return {
      code: "missing-operation",
      message:
        'The command names no operation. Add "operation": "find" | "findOne" | "aggregate" | "count" | "distinct". Nothing was sent.',
    };
  }
  // The operation is judged BEFORE any unknown key, because a write deserves the write's own
  // sentence: "insertOne is not one of the five reads" tells the model what to change, where
  // "\"documents\" is not a key the envelope takes" would tell it nothing about the refusal
  // it actually met.
  if (!AGENT_READ_OPERATIONS.has(operation)) {
    return {
      code: "non-read-operation",
      message: `"${operation}" is not one of the five reads an agent may run (find, findOne, aggregate, count, distinct). The envelope the editor accepts also carries writes; this run may not send one. Nothing was sent.`,
    };
  }
  for (const key of Object.keys(command)) {
    // A write's own payload keys, arriving under a read operation: the shape is the write even
    // if the operation claims otherwise, so it is refused by what it carries rather than by
    // its label - and with the write's own sentence, not the unknown key's.
    if (key === "documents" || key === "update") {
      return {
        code: "write-payload",
        message:
          "The command carries a write's payload (documents or update) under a read's name. An agent read carries a filter, a pipeline or nothing. Nothing was sent.",
      };
    }
    if (!ENVELOPE_KEYS.has(key)) {
      return {
        code: "unknown-key",
        message: `"${key}" is not a key the command envelope takes (collection, database, operation, filter, pipeline, field, options): remove it. Nothing was sent.`,
      };
    }
  }
  if (command.database !== undefined && (typeof command.database !== "string" || command.database.length === 0)) {
    return {
      code: "bad-database",
      message: '"database" must be a non-empty string naming the database the command runs in. Nothing was sent.',
    };
  }
  if (
    command.filter !== undefined &&
    (typeof command.filter !== "object" || command.filter === null || Array.isArray(command.filter))
  ) {
    return { code: "bad-filter", message: '"filter" must be a JSON object of match conditions. Nothing was sent.' };
  }
  if (operation === "aggregate") {
    const pipeline = command.pipeline;
    if (!Array.isArray(pipeline)) {
      return {
        code: "bad-pipeline",
        message:
          'An aggregate names its stages in "pipeline": a JSON array, for example [{"$match": {...}}, {"$group": {...}}]. Nothing was sent.',
      };
    }
    for (const stage of pipeline) {
      if (typeof stage !== "object" || stage === null || Array.isArray(stage)) {
        return {
          code: "bad-pipeline",
          message: "Every pipeline stage must be a JSON object naming one stage. Nothing was sent.",
        };
      }
      for (const key of Object.keys(stage as Record<string, unknown>)) {
        if (PIPELINE_WRITE_STAGES.has(key)) {
          return {
            code: "pipeline-writes",
            message: `"${key}" writes the pipeline's result into a collection, so it is not a read even inside an aggregate. An agent aggregation reads; what it establishes goes into the report. Nothing was sent.`,
          };
        }
      }
    }
  }
  if (operation === "distinct") {
    if (typeof command.field !== "string" || command.field.length === 0) {
      return {
        code: "missing-field",
        message: 'A distinct names its field: add "field": "<name>" to the envelope. Nothing was sent.',
      };
    }
  }
  // The JavaScript operators are refused wherever they sit - a filter (under `$and`, inside `$expr`), a pipeline
  // stage (`$match`'s filter, `$project`'s expression, `$group`'s accumulator) - because their reach is the whole
  // envelope, not one field of it. The scan runs after the shape checks so a malformed envelope reads its own
  // sentence first, and before nothing: every operation carries a filter or a pipeline, and both are walked.
  const javaScriptOperator = firstServerSideJavaScriptKey(command);
  if (javaScriptOperator !== null) {
    return {
      code: "server-side-javascript",
      message: `"${javaScriptOperator}" runs JavaScript this run wrote on the server, and this run's contract runs none: the boundary is the principal's roles and the engine's own deadline, not a code sandbox. Express the condition as a plain filter or an aggregation expression ($regex, $cond, $switch) and send that. Nothing was sent.`,
    };
  }
  if (command.options !== undefined) {
    const options = command.options;
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      return {
        code: "bad-options",
        message: '"options" must be a JSON object (limit, skip, sort, projection). Nothing was sent.',
      };
    }
    for (const [key, value] of Object.entries(options as Record<string, unknown>)) {
      if ((key === "limit" || key === "skip") && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        return { code: "bad-options", message: `"${key}" must be a non-negative number. Nothing was sent.` };
      }
      if (
        (key === "sort" || key === "projection") &&
        (typeof value !== "object" || value === null || Array.isArray(value))
      ) {
        return { code: "bad-options", message: `"${key}" must be a JSON object. Nothing was sent.` };
      }
    }
  }
  return null;
}

/**
 * The first server-side-JavaScript operator key anywhere in the envelope, or null when there is none.
 *
 * Walks objects by every key and arrays by every element, to the depth the envelope itself reaches: the 4,096-
 * character contract bounds the tree (a nesting level costs at least two characters of braces), and the parser has
 * already walked it once - this walk cannot be deeper than the parse that produced it, so it needs no depth cap of
 * its own, and one without a cap is one without a hole a level deeper than it stops.
 */
function firstServerSideJavaScriptKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstServerSideJavaScriptKey(entry);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SERVER_SIDE_JAVASCRIPT_KEYS.has(key)) return key;
    const found = firstServerSideJavaScriptKey(nested);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The envelope of an admitted statement, as the provider's own read path takes it: the statement was parsed by
 * `parseExtendedJson` once already, so this is that parse's value rather than a second one that could disagree.
 */
export function parseAdmittedMongoStatement(text: string): Record<string, unknown> {
  return parseExtendedJson(text.trim()) as Record<string, unknown>;
}

/** The input `mongo.query.read` validates: one command, admitted. Strict, so a stray `sql` key is refused. */
export const mongoAgentReadInput = z
  .strictObject({ command: z.string().min(1).max(MONGO_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitMongoStatement(value.command);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["command"], message: refusal.message });
  });
