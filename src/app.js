import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { advisoryLock, insertSlots, withTransaction } from "./db.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const RATE_LIMIT_ATTEMPTS = 5; // per email...
const RATE_LIMIT_WINDOW_SECONDS = 60; // ...per rolling minute

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const BOOKING_COLUMNS = "id, slot_id, name, email, status, created_at";

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";
const fail = (status, message) => ({ status, body: { error: message } });

function formatBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: row.created_at.toISOString(),
  };
}

// Stable JSON, so the same body always hashes the same whatever its key order.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (text) => crypto.createHash("sha256").update(text).digest();

// Hash both sides first so the comparison is constant time whatever the lengths.
function keysMatch(provided, expected) {
  if (typeof provided !== "string" || !expected) return false;
  return crypto.timingSafeEqual(sha256(provided), sha256(expected));
}

// Level 5. Returns 0 if the attempt is allowed (and records it), otherwise the
// number of seconds until the oldest attempt in the window expires.
async function takeRateLimitSlot(client, email) {
  await client.query(
    `DELETE FROM booking_attempts
      WHERE email = $1
        AND attempted_at <= clock_timestamp() - make_interval(secs => $2)`,
    [email, RATE_LIMIT_WINDOW_SECONDS],
  );
  const { rows } = await client.query(
    `SELECT count(*)::int AS attempts,
            CEIL(EXTRACT(EPOCH FROM (min(attempted_at)
                 + make_interval(secs => $2) - clock_timestamp())))::int AS retry_after
       FROM booking_attempts
      WHERE email = $1`,
    [email, RATE_LIMIT_WINDOW_SECONDS],
  );
  if (rows[0].attempts >= RATE_LIMIT_ATTEMPTS) {
    return Math.max(1, rows[0].retry_after);
  }
  await client.query("INSERT INTO booking_attempts (email) VALUES ($1)", [email]);
  return 0;
}

// Levels 1 to 3. Runs inside the caller's transaction.
async function createBooking(client, body) {
  if (!isPlainObject(body)) return fail(400, "request body must be a JSON object");

  const { slot_id: slotId, name, email } = body;
  if (!isNonEmptyString(slotId)) return fail(400, "slot_id is required");
  if (!isNonEmptyString(name)) return fail(400, "name is required");
  if (!isNonEmptyString(email)) return fail(400, "email is required");

  const cleanName = name.trim();
  const cleanEmail = email.trim().toLowerCase();
  if (cleanName.length > 200) return fail(400, "name is too long");
  if (cleanEmail.length > 254 || !EMAIL_PATTERN.test(cleanEmail)) {
    return fail(400, "email is not valid");
  }

  const slot = await client.query(
    "SELECT (start_at <= now()) AS started FROM slots WHERE id = $1",
    [slotId],
  );
  if (slot.rowCount === 0) return fail(404, "slot not found");
  if (slot.rows[0].started) return fail(400, "slot has already started");

  // Level 3. The partial unique index decides the winner when requests race:
  // exactly one insert succeeds, the others conflict and insert nothing.
  const inserted = await client.query(
    `INSERT INTO bookings (id, slot_id, name, email, status)
     VALUES ($1, $2, $3, $4, 'confirmed')
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
     RETURNING ${BOOKING_COLUMNS}`,
    [crypto.randomUUID(), slotId, cleanName, cleanEmail],
  );
  if (inserted.rowCount === 0) return fail(409, "slot is already booked");

  return { status: 201, body: formatBooking(inserted.rows[0]) };
}

export function createApp({ pool, apiKey, webKey }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  // --- Public: the web page, its config, and a health check -----------------
  app.use((req, res, next) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Idempotency-Key",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Expose-Headers": "Retry-After",
    });
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/healthz", (req, res) => res.json({ ok: true }));

  // The page uses a limited key that can list slots, book and read a booking,
  // but cannot reset data or cancel. It is public by design.
  app.get("/config.json", (req, res) => res.json({ webKey: webKey || null }));

  app.use(express.static(PUBLIC_DIR));

  // --- Level 2: everything below needs the API key --------------------------
  // This runs before the body is parsed, so a bad key is always a 401.
  app.use((req, res, next) => {
    // Availability changes constantly, so nothing here may be cached.
    res.set("Cache-Control", "no-store");
    const provided = req.get("x-api-key");
    if (keysMatch(provided, apiKey)) return next();

    if (keysMatch(provided, webKey)) {
      const allowed =
        (req.method === "GET" && req.path === "/slots") ||
        (req.method === "POST" && req.path === "/bookings") ||
        (req.method === "GET" && /^\/bookings\/[^/]+$/.test(req.path));
      if (allowed) return next();
      return res.status(403).json({ error: "this key cannot do that" });
    }
    res.status(401).json({ error: "missing or invalid API key" });
  });

  app.use(express.json({ limit: "5mb" }));

  const route = (handler) => (req, res, next) => handler(req, res).catch(next);

  // --- Level 1: replace all slots -------------------------------------------
  app.post(
    "/reset",
    route(async (req, res) => {
      const slots = req.body?.slots;
      if (!Array.isArray(slots)) return res.status(400).json({ error: "slots must be an array" });

      const seen = new Set();
      for (const slot of slots) {
        const valid =
          isPlainObject(slot) &&
          isNonEmptyString(slot.id) &&
          isNonEmptyString(slot.provider) &&
          typeof slot.start === "string" &&
          typeof slot.end === "string" &&
          !Number.isNaN(Date.parse(slot.start)) &&
          !Number.isNaN(Date.parse(slot.end));
        if (!valid) {
          return res.status(400).json({
            error: "each slot needs id, provider, start and end (ISO date-times)",
          });
        }
        if (seen.has(slot.id)) {
          return res.status(400).json({ error: `duplicate slot id: ${slot.id}` });
        }
        seen.add(slot.id);
      }

      await withTransaction(pool, async (client) => {
        // Bookings, idempotency keys and rate limit counters all go too, so a
        // fresh reset is a genuinely clean slate.
        await client.query(
          "TRUNCATE bookings, slots, idempotency_keys, booking_attempts RESTART IDENTITY",
        );
        if (slots.length > 0) await insertSlots(client, slots);
      });
      res.status(200).json({ ok: true, slots: slots.length });
    }),
  );

  // --- Level 1: list slots --------------------------------------------------
  app.get(
    "/slots",
    route(async (req, res) => {
      const { provider } = req.query;
      if (provider !== undefined && typeof provider !== "string") {
        return res.status(400).json({ error: "provider must be a single value" });
      }
      const { rows } = await pool.query(
        `SELECT s.id, s.provider, s.start_raw AS start, s.end_raw AS "end",
                NOT EXISTS (SELECT 1 FROM bookings b
                             WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
           FROM slots s
          WHERE ($1::text IS NULL OR s.provider = $1)
          ORDER BY s.start_at ASC, s.id ASC`,
        [provider ?? null],
      );
      res.json({ slots: rows });
    }),
  );

  // --- Levels 1 to 5: book a slot -------------------------------------------
  app.post(
    "/bookings",
    route(async (req, res) => {
      const body = req.body;
      const idempotencyKey = (req.get("idempotency-key") ?? "").trim() || null;
      const requestHash = idempotencyKey ? sha256(canonicalJson(body)).toString("hex") : null;
      const rateLimitEmail =
        isPlainObject(body) && typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

      const outcome = await withTransaction(pool, async (client) => {
        // Level 4. The lock makes two requests with the same key run one after
        // the other, so the second always finds the first one's saved response.
        if (idempotencyKey) {
          await advisoryLock(client, `idem:${idempotencyKey}`);
          const saved = await client.query(
            "SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1",
            [idempotencyKey],
          );
          if (saved.rowCount > 0) {
            if (saved.rows[0].request_hash !== requestHash) {
              return fail(422, "Idempotency-Key was already used with a different request body");
            }
            return { status: saved.rows[0].status_code, body: saved.rows[0].response };
          }
        }

        // Level 5. Counted before validation, so failed attempts count too.
        // The lock keeps concurrent requests for one email from slipping past
        // the limit together, and keeps that email's bookings in order.
        if (rateLimitEmail) {
          await advisoryLock(client, `rate:${rateLimitEmail}`);
          const retryAfter = await takeRateLimitSlot(client, rateLimitEmail);
          if (retryAfter > 0) {
            return {
              status: 429,
              headers: { "Retry-After": String(retryAfter) },
              body: { error: "too many booking attempts for this email, try again later" },
            };
          }
        }

        const result = await createBooking(client, body);

        if (idempotencyKey) {
          await client.query(
            `INSERT INTO idempotency_keys (key, request_hash, status_code, response)
             VALUES ($1, $2, $3, $4::jsonb)`,
            [idempotencyKey, requestHash, result.status, JSON.stringify(result.body)],
          );
        }
        return result;
      }).catch((err) => {
        // The slot was deleted by a reset while this request was in flight.
        if (err.code === "23503") return fail(404, "slot not found");
        throw err;
      });

      if (outcome.headers) res.set(outcome.headers);
      res.status(outcome.status).json(outcome.body);
    }),
  );

  // --- Level 4: a person's bookings, paged ----------------------------------
  app.get(
    "/bookings",
    route(async (req, res) => {
      const { email, limit, cursor } = req.query;

      if (!isNonEmptyString(email)) return res.status(400).json({ error: "email is required" });

      let pageSize = 10;
      if (limit !== undefined) {
        if (typeof limit !== "string" || !/^\d+$/.test(limit)) {
          return res.status(400).json({ error: "limit must be a whole number from 1 to 50" });
        }
        pageSize = Number(limit);
        if (pageSize < 1 || pageSize > 50) {
          return res.status(400).json({ error: "limit must be a whole number from 1 to 50" });
        }
      }

      let after = 0;
      if (cursor !== undefined) {
        const decoded = typeof cursor === "string" ? Buffer.from(cursor, "base64url").toString() : "";
        if (!/^\d+$/.test(decoded)) return res.status(400).json({ error: "cursor is not valid" });
        after = decoded;
      }

      const { rows } = await pool.query(
        `SELECT seq, ${BOOKING_COLUMNS}
           FROM bookings
          WHERE email = $1 AND seq > $2
          ORDER BY seq ASC
          LIMIT $3`,
        [email.trim().toLowerCase(), after, pageSize + 1],
      );

      const page = rows.slice(0, pageSize);
      const hasMore = rows.length > pageSize;
      res.json({
        bookings: page.map(formatBooking),
        next_cursor: hasMore
          ? Buffer.from(String(page[page.length - 1].seq)).toString("base64url")
          : null,
      });
    }),
  );

  // --- Level 1: get one booking ---------------------------------------------
  app.get(
    "/bookings/:id",
    route(async (req, res) => {
      const { rows } = await pool.query(`SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1`, [
        req.params.id,
      ]);
      if (rows.length === 0) return res.status(404).json({ error: "booking not found" });
      res.json(formatBooking(rows[0]));
    }),
  );

  // --- Level 3: cancel ------------------------------------------------------
  app.delete(
    "/bookings/:id",
    route(async (req, res) => {
      // One atomic UPDATE, so two simultaneous cancels can't both succeed.
      const updated = await pool.query(
        `UPDATE bookings SET status = 'cancelled'
          WHERE id = $1 AND status = 'confirmed'
          RETURNING ${BOOKING_COLUMNS}`,
        [req.params.id],
      );
      if (updated.rowCount > 0) return res.json(formatBooking(updated.rows[0]));

      const exists = await pool.query("SELECT 1 FROM bookings WHERE id = $1", [req.params.id]);
      if (exists.rowCount === 0) return res.status(404).json({ error: "booking not found" });
      res.status(409).json({ error: "booking is already cancelled" });
    }),
  );

  // --- Anything else --------------------------------------------------------
  app.use((req, res) => res.status(404).json({ error: "not found" }));

  app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") {
      return res.status(400).json({ error: "request body is not valid JSON" });
    }
    if (err.type === "entity.too.large") {
      return res.status(413).json({ error: "request body is too large" });
    }
    console.error(err);
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}
