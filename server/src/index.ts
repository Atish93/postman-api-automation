// Starts the API server: npm start (PORT, default 4000; QA_DB for the database file).

// The database uses Node's built-in SQLite (node:sqlite), available from Node.js 22.13.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `The QA dashboard server needs Node.js 22.13 or newer; this is ${process.versions.node}.\n` +
      "Install the current LTS from https://nodejs.org, or with nvm: nvm install 22 && nvm use 22",
  );
  process.exit(1);
}

const { buildApp } = await import("./app.ts");
const { app, scheduler } = buildApp(undefined, { logger: true });
scheduler.start();
const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
