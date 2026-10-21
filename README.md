# Clinic booking API

An API that lets patients book appointment slots, plus a small web page that uses it. Built for the Koya Cohort 4 assessment, Task 1. It covers all five levels.

- **API base URL:** add your deployed URL here
- **Web page:** the same URL, at `/`

Stack: Node 22, Express, Postgres. The web page is one HTML file with no build step.

## Run it locally

You need Node 20 or newer and a Postgres database.

```bash
npm install
cp .env.example .env        # then fill in DATABASE_URL and API_KEY
export $(grep -v '^#' .env | xargs)
npm start
```

Open http://localhost:3000. The tables are created on startup, and demo slots are added if the database has none.

Every API request needs the header `X-API-Key: <your API_KEY>`.

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/reset` | Deletes everything, then loads the slots you send |
| GET | `/slots` | Lists slots, earliest first. Optional `?provider=` |
| POST | `/bookings` | Books a slot. Optional `Idempotency-Key` header |
| GET | `/bookings?email=` | A person's bookings, oldest first, paged with `limit` and `cursor` |
| GET | `/bookings/{id}` | One booking |
| DELETE | `/bookings/{id}` | Cancels a booking and frees the slot |

Errors always look like `{"error": "<message>"}`.

## How each level works

**Level 1: the basics.** Slots and bookings live in Postgres, so they are still there on the next request. Slot times are stored twice: the original text, which is what the API returns, and a real timestamp, which is what sorting and the "already started" check use.

**Level 2: keys and validation.** The key check runs before the body is even parsed, so a bad key is always a 401, even with broken JSON. Name and email are trimmed, and the email is stored in lower case. Missing, empty or invalid fields are a 400, an unknown slot is a 404, and a slot that has already started is a 400.

**Level 3: no double booking.** This is enforced by the database, not by code that checks first. There is a partial unique index: only one booking per slot may have the status `confirmed`.

```sql
CREATE UNIQUE INDEX one_confirmed_booking_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';
```

The booking is inserted with `ON CONFLICT DO NOTHING`. If 50 requests arrive at once, Postgres lets exactly one insert through and the other 49 insert nothing, which the API turns into a 409. A "check, then insert" in application code would have a gap between the two steps where two requests could both pass. The index has no gap. Cancelled bookings don't count, so a cancelled slot can be booked again. Cancelling is a single `UPDATE ... WHERE status = 'confirmed'`, so two simultaneous cancels can't both succeed.

**Level 4: retries and paging.** When a request has an `Idempotency-Key`, I take a Postgres advisory lock on that key. Requests with the same key then run one after another, so the second one always finds the first one's saved response. The saved row holds a hash of the request body, the status code and the response. Same key and same body replays the saved response. Same key and a different body is a 422. The body is hashed with its keys sorted, so field order doesn't matter. Paging uses a cursor built from the booking's insertion number, so pages stay correct even when new bookings arrive between requests. I fetch one extra row to know whether another page exists, which means the last page always has `next_cursor: null`.

**Level 5: rate limiting.** Every attempt is a row in `booking_attempts`. Before anything else, the API removes that email's rows older than 60 seconds and counts what is left. At 5 or more, the request gets a 429 with `Retry-After` set to the seconds until the oldest attempt falls out of the window. Otherwise the attempt is recorded. The check runs before validation, so failed attempts count too. A per email advisory lock stops simultaneous requests from all squeezing past the limit together. Emails are lower cased and trimmed first, so changing the case doesn't dodge the limit.

## Judgement calls

The spec left a few things open. This is what I chose and why.

- **A replayed request is not a new attempt.** If you retry with the same `Idempotency-Key`, you get the saved response and it doesn't use up one of your 5 attempts. A retry is the same attempt, not a new one.
- **A 429 is never saved against an Idempotency Key.** It is a temporary condition, so the same request can succeed later.
- **A 429 doesn't extend the wait.** Rejected requests aren't recorded, so hammering the endpoint can't keep you locked out.
- **`/reset` clears everything,** including idempotency keys and rate limit counters. Otherwise a test that reuses an email would be blocked by an earlier one.
- **Slots in the past are still listed.** `/reset` accepts them by design, and a slot that has started is refused at booking time, not hidden.
- **Cancelled bookings still appear** in a person's booking list, with status `cancelled`.

## The web page

The page lists open slots grouped by day, lets you filter by doctor, and books a slot through a small form. Then it shows a confirmation. A few details worth knowing:

- Each booking attempt sends an `Idempotency-Key`. If the network drops or someone double clicks, the retry reuses the same key, so nobody is booked twice.
- If someone else takes your slot first, you get a clear message and a refreshed list.
- If you hit the rate limit, the button counts down the `Retry-After` seconds.
- The confirmation survives a reload, because the booking id is kept in the URL and loaded with `GET /bookings/{id}`.
- The page uses a second key, `WEB_KEY`, which can list slots, book and read a booking, but cannot reset or cancel. It has to be visible to the browser, so I limited what it can do. The full `API_KEY` is never sent to the page.

## Tests

```bash
TEST_DATABASE_URL=postgres://user@localhost:5432/clinic_test npm test
```

74 tests against a real Postgres, covering every level. The ones I care about most are the concurrent ones:

- 50 people booking the same slot at once: exactly one wins.
- 20 slots raced by 8 people each: exactly 20 bookings.
- 20 simultaneous requests with one `Idempotency-Key`: one booking, one answer.
- 12 simultaneous attempts from one email: exactly 5 get through.

I also broke the locks on purpose to check the tests really fail without them. They do.

## Deploying

1. Create a free Postgres database on [Neon](https://neon.tech) and copy its connection string.
2. Create a Web Service on [Render](https://render.com) from this repo. `render.yaml` has the settings.
3. Set the environment variables `DATABASE_URL`, `API_KEY` and `WEB_KEY`.
4. Free Render services go to sleep after 15 minutes without traffic, and the first request afterwards is slow. Point a free uptime monitor at `/healthz` every 5 minutes to keep it awake.

## What I would do next

- Idempotency keys are kept forever. In production they should expire after a day or so, with a cleanup job.
- Every booking attempt writes a row for rate limiting. That is fine at clinic scale. At much higher traffic I would move the counters to Redis.
- The page was checked in a real browser by script, but it has no automated tests of its own.
