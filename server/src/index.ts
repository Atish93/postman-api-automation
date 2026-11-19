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

// After pulling a new version, packages it added may not be installed yet: say so instead of crashing.
{
  const { existsSync, readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const deps = Object.keys(JSON.parse(readFileSync(`${root}package.json`, "utf8")).dependencies ?? {});
  const missing = deps.filter((d) => !existsSync(`${root}node_modules/${d}/package.json`));
  if (missing.length) {
    console.error(`Some packages this version needs aren't installed: ${missing.join(", ")}.
Run this in the server folder, then start again:

    npm install
`);
    process.exit(1);
  }
}

const { buildApp } = await import("./app.ts");
const { app, db, scheduler, backups } = buildApp(undefined, { logger: true });
scheduler.start();
backups.start();
const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
// No password yet: print the setup code now, so it's in the log before anyone opens the page.
const { hasPassword, currentSetupCode } = await import("./auth.ts");
if (!hasPassword(db)) currentSetupCode();
