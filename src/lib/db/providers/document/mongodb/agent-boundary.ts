/**
 * The agent's read-only execution profile for MongoDB (issue #1614): the boundary, and the
 * gate that proves it at the profiled connection's open.
 *
 * 1. **The principal is proven by a NEGATIVE WRITE PROBE, not by reading its roles.**
 *    A user created with the `read` role is a claim; the probe asks the server to refuse
 *    a write and takes only that refusal as proof. Measured on MongoDB 9.0.4: an
 *    `insertOne` into the probe collection as the `read`-only user answers
 *    `MongoServerError` code 13, "not authorized on <db> to execute command {insert: …}".
 *    Measured on a server started without `--auth`: the same write SUCCEEDS - role
 *    restrictions are not enforced at all without authentication (the shape the issue
 *    recorded on 2026-09-27 and the reason reading `connectionStatus` would prove
 *    nothing) - so the probe cleans up after its own surprise and refuses the connection
 *    with `PROFILE_PRIVILEGES_TOO_BROAD`, which is the honest verdict: no read-only
 *    boundary the profile could rest on exists on that server.
 *
 *    The probe writes into the CONNECTED database only, by the issue's own design: a
 *    principal granted `readWrite` on some other database still passes the probe on this
 *    one, and what contains it there is the fence (no write operation is ever admitted)
 *    and the server's own per-database authorization of every read the envelope may aim
 *    elsewhere. Documented rather than widened, because widening it would probe every
 *    database the connection can NAME, which the connection has no list of.
 *
 * 2. **THE GATE IS THE SERVER'S OWN SELF-IDENTIFICATION, fail-closed.** `buildInfo` answers the
 *    fields a genuine MongoDB answers (`version`, `versionArray`, `allocator`,
 *    `javascriptEngine`, `storageEngines` containing `wiredTiger`), and names a compat layer
 *    when there is one: FerretDB, measured, answers a `ferretdb: {version, package}` field
 *    of its own and no `allocator`, `javascriptEngine` or `storageEngines` at all. A server
 *    that fails the positive shape, or names itself, is refused with
 *    `PROFILE_UNSUPPORTED_TARGET` until its own enforcement is measured - the D347
 *    precedent, which is how Percona is treated on the MySQL wire.
 */
import { ExecutionProfileError } from "../../../errors";
import type { Db, Document, MongoClient } from "mongodb";

/** The collection the probe writes into, refused by the server when the boundary holds. */
const AGENT_PROBE_COLLECTION = "libredb_agent_probe";

/** What a write past the boundary must answer: MongoDB's authorization refusal. */
const MONGO_UNAUTHORIZED_CODE = 13;

/** The wire's floor for the fields a genuine MongoDB answers on `buildInfo`. */
const GENUINE_MONGODB_STORAGE_ENGINE = "wiredTiger";

/**
 * The engine admission: this server must positively be the MongoDB the boundary was
 * measured on. The `ferretdb` field names the one compat layer that mimics a MongoDB
 * version string (measured: it answers `version: "7.0.77"` with no `allocator`,
 * `javascriptEngine` or `storageEngines` beside it), and the positive shape - a numeric
 * version triple, the storage engines list carrying `wiredTiger` - is what Amazon
 * DocumentDB and Azure Cosmos DB, which also speak the wire but answer thinner
 * `buildInfo`s, fail in the fail-closed direction.
 */
function assertAgentEngineIsAdmissible(buildInfo: Document): void {
  if (buildInfo.ferretdb !== undefined) {
    throw new ExecutionProfileError(
      "The agent read-only execution profile is proven on MongoDB only; this server identifies itself as FerretDB on the wire, and its own enforcement is not measured, so the connection is refused.",
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
  const version = buildInfo.version;
  const storageEngines = buildInfo.storageEngines;
  const admissible =
    typeof version === "string" &&
    /^\d+\.\d+\.\d+/.test(version) &&
    Array.isArray(storageEngines) &&
    (storageEngines as unknown[]).includes(GENUINE_MONGODB_STORAGE_ENGINE);
  if (!admissible) {
    throw new ExecutionProfileError(
      "The agent read-only execution profile is proven on MongoDB only; this server's own buildInfo does not answer the shape a MongoDB answers, so its enforcement is unproven and the connection is refused.",
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
}

/**
 * The negative write probe, run once at the profiled connection's open.
 *
 * PASS is a refusal: the server answered the write with its authorization error, which is
 * the one proof a read-only boundary exists. A write that SUCCEEDS is the no-auth shape
 * (or an over-privileged principal), and is answered with the probe's own cleanup -
 * `deleteMany` of what it just inserted, which the same over-broad principal is allowed
 * to do - and then a refusal: the profile does not leave its probe document behind and
 * does not run as a principal that wrote. Any other error is neither proof nor
 * disproof, so it propagates as the connect's own failure rather than being read as a
 * verdict.
 */
async function probeAgentPrincipalCannotWrite(db: Db): Promise<void> {
  let insertRefused: boolean;
  try {
    await db.collection(AGENT_PROBE_COLLECTION).insertOne({ probe: true });
    insertRefused = false;
  } catch (error) {
    if (isAuthorizationRefusal(error)) return;
    throw error;
  }
  // The write succeeded, so the boundary does not exist for this principal. What the
  // probe just wrote is removed before the refusal, so the one observable side effect of
  // discovering that is nothing.
  await db
    .collection(AGENT_PROBE_COLLECTION)
    .deleteMany({})
    .catch(() => {});
  throw new ExecutionProfileError(
    "The agent read-only execution profile requires a server that refuses this principal's writes, and this one accepted one: authentication is off, or the connection's own user holds privileges no read-only boundary can contain. Point the connection's agent credential at a least-privilege principal, or connect as one.",
    "PROFILE_PRIVILEGES_TOO_BROAD",
  );
}

function isAuthorizationRefusal(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === MONGO_UNAUTHORIZED_CODE;
}

/**
 * The whole of the profile's verification: the server identifies itself as the engine
 * the boundary was measured on, and the principal's inability to write is proven by the
 * server's own refusal. Run at the PROFILED connection's open, which is the #1629 shape:
 * plan mode and the operations workflow ground through their own profile and are never
 * refused here, and a statement-sending run's grounding - the first thing it does - is.
 */
export async function verifyAgentProfile(client: MongoClient, databaseName: string): Promise<void> {
  const db = client.db(databaseName);
  const buildInfo = await db.command({ buildInfo: 1 }).catch((error: unknown) => {
    throw error;
  });
  assertAgentEngineIsAdmissible(buildInfo as Document);
  await probeAgentPrincipalCannotWrite(db);
}
