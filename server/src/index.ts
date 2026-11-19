// Starts the API server: npm start (PORT, default 4000; QA_DB for the database file).
import { buildApp } from "./app.ts";

const { app } = buildApp(undefined, { logger: true });
const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
