import pg from "pg";

export function createPool(connectionString) {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
  });
  // Hosted Postgres (Neon, Supabase) closes idle connections. Without this
  // handler that would crash the process instead of just dropping the client.
  pool.on("error", (err) => console.error("idle db client error:", err.message));
  return pool;
}

// Every guarantee the API makes under concurrency is enforced here, by the
// database, not by application code.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  id        text PRIMARY KEY,
  provider  text NOT NULL,
  start_raw text NOT NULL,          -- returned to clients exactly as sent
  end_raw   text NOT NULL,
  start_at  timestamptz NOT NULL,   -- used for ordering and the "already started" check
  end_at    timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  seq        bigserial PRIMARY KEY, -- insertion order, used for oldest-first and cursors
  id         text NOT NULL UNIQUE,
  slot_id    text NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  name       text NOT NULL,
  email      text NOT NULL,         -- always stored lower case
  status     text NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Level 3: at most one CONFIRMED booking per slot. Cancelled bookings don't
-- count, so a cancelled slot can be booked again.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_by_email ON bookings (email, seq);

-- Level 4: remembers the response for each Idempotency-Key.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          text PRIMARY KEY,
  request_hash text NOT NULL,
  status_code  integer NOT NULL,
  response     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Level 5: one row per booking attempt, per email.
CREATE TABLE IF NOT EXISTS booking_attempts (
  id           bigserial PRIMARY KEY,
  email        text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS booking_attempts_by_email
  ON booking_attempts (email, attempted_at);
`;

export async function migrate(pool) {
  // Two instances booting at once must not race to create the tables. The lock
  // is transaction scoped, so it is safe behind a connection pooler as well.
  await withTransaction(pool, async (client) => {
    await advisoryLock(client, "migrate");
    await client.query(SCHEMA);
  });
}

export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // connection is already gone, nothing to roll back
    }
    throw err;
  } finally {
    client.release();
  }
}

// Serialises work that shares a key (the same Idempotency-Key, the same email)
// until the surrounding transaction ends.
export function advisoryLock(client, key) {
  return client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

function isoNoMillis(date) {
  return date.toISOString().replace(".000Z", "Z");
}

// Gives the web page something to show on a fresh database. The checker calls
// POST /reset, which replaces all of this.
export async function seedDemoSlots(pool) {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM slots");
  if (rows[0].n > 0) return;

  const providers = ["Dr Ade", "Dr Bello"];
  const times = [9, 10, 11, 14, 15];
  const slots = [];
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);

  for (let day = 1; day <= 7; day++) {
    for (const provider of providers) {
      for (const hour of times) {
        const start = new Date(base.getTime() + day * 86_400_000 + hour * 3_600_000);
        const end = new Date(start.getTime() + 30 * 60_000);
        slots.push({
          id: `s${slots.length + 1}`,
          provider,
          start: isoNoMillis(start),
          end: isoNoMillis(end),
        });
      }
    }
  }
  await insertSlots(pool, slots);
}

export function insertSlots(client, slots) {
  return client.query(
    `INSERT INTO slots (id, provider, start_raw, end_raw, start_at, end_at)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[],
                          $5::timestamptz[], $6::timestamptz[])`,
    [
      slots.map((s) => s.id),
      slots.map((s) => s.provider),
      slots.map((s) => s.start),
      slots.map((s) => s.end),
      slots.map((s) => new Date(s.start).toISOString()),
      slots.map((s) => new Date(s.end).toISOString()),
    ],
  );
}
