import { createApp } from "./app.js";
import { createPool, migrate, seedDemoSlots } from "./db.js";

const { DATABASE_URL, API_KEY, WEB_KEY, PORT = "3000", SEED_DEMO_SLOTS = "true" } = process.env;

if (!DATABASE_URL || !API_KEY) {
  console.error("DATABASE_URL and API_KEY must be set. See .env.example.");
  process.exit(1);
}

const pool = createPool(DATABASE_URL);
await migrate(pool);
if (SEED_DEMO_SLOTS !== "false") await seedDemoSlots(pool);

const app = createApp({ pool, apiKey: API_KEY, webKey: WEB_KEY });
const server = app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Clinic booking API listening on port ${PORT}`);
});

// Hosts send SIGTERM on every deploy. Let requests that are already running finish first.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
