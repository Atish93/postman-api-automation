// Clicks through the real app in a browser, against a fresh database, a fake API and a fake Postman.
// Run: npm run e2e (after npm run build). Needs Playwright with Chromium:
//   npm i -D playwright && npx playwright install chromium
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeApi, fakePostman, fakeSmtp, fixtureCollection, POSTMAN_KEY } from "../../server/test/helpers.ts";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
let chromium: any;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.log("Playwright isn't installed. Run: npm i -D playwright && npx playwright install chromium");
  process.exit(1);
}

const api = await fakeApi();
const pm = await fakePostman();
const smtp = await fakeSmtp("app-pass");
const dir = mkdtempSync(join(tmpdir(), "qa-e2e-"));
const port = 4300 + Math.floor(Math.random() * 500);
const server = spawn("npx", ["tsx", "src/index.ts"], {
  cwd: fileURLToPath(new URL("../../server/", import.meta.url)),
  env: { ...process.env, PORT: String(port), QA_DB: join(dir, "qa.db"), QA_RUNS_DIR: join(dir, "runs"), POSTMAN_API_BASE: pm.url, POSTMAN_API_KEY: "" },
  stdio: ["ignore", "pipe", "ignore"],
});
// The one-time setup code is printed in the server's log, as a real user would see it.
let serverLog = "";
server.stdout!.on("data", (c) => (serverLog += c));
const setupCode = () => serverLog.match(/\b([0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4})\b/)?.[1];
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (e: any) {
    failed++;
    // A screenshot of the page at the moment it failed, to see why.
    const shot = join(dir, `failed-${failed}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    console.log(`FAIL  ${name}\n      ${String(e.message).split("\n")[0]}\n      Screenshot: ${shot}`);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors: string[] = [];
page.on("pageerror", (e: Error) => errors.push(e.message));
page.on("console", (m: any) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
const button = (name: string) => page.getByRole("button", { name, exact: true });

await check("first visit: you're asked to set a password with the setup code from the server's log", async () => {
  await page.goto(`${base}/collections`);
  await page.waitForURL(/\/setup\?next=%2Fcollections/);
  await page.getByLabel("Setup code").fill("0000-0000-0000");
  await page.getByLabel("New password").fill("e2e password 123");
  await page.getByLabel("Repeat it").fill("e2e password 123");
  await button("Set password and continue").click();
  await page.getByText("That setup code isn't right").waitFor();
  if (!setupCode()) throw new Error("no setup code in the server log");
  await page.getByLabel("Setup code").fill(setupCode()!);
  await button("Set password and continue").click();
  await page.waitForURL(`${base}/collections`);
});

await check("log out, then a wrong and a right password", async () => {
  await page.getByRole("button", { name: "Log out" }).first().click();
  await page.waitForURL(/\/login/);
  await page.goto(`${base}/settings`);
  await page.waitForURL(/\/login\?next=%2Fsettings/);
  await page.getByLabel("Password").fill("wrong password");
  await button("Log in").click();
  await page.getByText("Wrong password.").waitFor();
  await page.getByLabel("Password").fill("e2e password 123");
  await button("Log in").click();
  await page.waitForURL(`${base}/settings`);
});

await check("an empty dashboard shows the getting-started steps", async () => {
  await page.goto(base);
  await page.getByText("No runs yet").waitFor();
  await page.getByText("Connect Postman").first().waitFor();
});

await check("Settings: a wrong Postman key is refused with a reason", async () => {
  await page.goto(`${base}/settings`);
  await page.getByPlaceholder("PMAK-…").fill("PMAK-wrong");
  await button("Save key").click();
  await page.getByText("Postman rejected the API key").waitFor();
});

await check("Settings: the right key connects, and only its end is shown", async () => {
  await page.getByPlaceholder("PMAK-…").fill(POSTMAN_KEY);
  await button("Save key").click();
  await page.getByText("Connected · key ending").waitFor();
  if ((await page.content()).includes(POSTMAN_KEY)) throw new Error("the full key is on the page");
});

await check("Environments: create one with a secret variable", async () => {
  await page.goto(`${base}/environments`);
  await page.getByRole("link", { name: "New environment" }).first().click();
  await page.getByPlaceholder("Stg", { exact: true }).fill("Test");
  await page.getByPlaceholder("stg", { exact: true }).fill("test");
  await page.getByPlaceholder("https://stg.example.com").fill(api.url);
  await page.getByPlaceholder("/health").fill("/health");
  await button("Add variable").click();
  await page.getByLabel("Variable name").fill("apiToken");
  await page.getByLabel("Value").fill("secret-123");
  await page.getByLabel("Secret").check();
  await button("Create environment").click();
  await page.waitForURL(`${base}/environments`);
  await page.getByText("1 variable, 1 secret").waitFor();
});

await check("Environments: a saved secret shows only as masked, and is kept when saving again", async () => {
  await page.getByRole("link", { name: /Test/ }).first().click();
  await page.getByPlaceholder("Unchanged (••••23)").waitFor();
  await button("Save changes").click();
  await page.waitForURL(`${base}/environments`);
});

await check("Collections: upload a collection file", async () => {
  const file = join(dir, "fake.postman_collection.json");
  writeFileSync(file, JSON.stringify(fixtureCollection()));
  await page.goto(`${base}/collections`);
  await page.locator('input[type="file"]').setInputFiles(file);
  await page.getByText('Uploaded "Fake API tests"').waitFor();
  await page.getByRole("link", { name: "Fake API tests", exact: true }).waitFor();
});

await check("Collections: import one from Postman", async () => {
  await button("Import from Postman").first().click();
  await page.getByRole("dialog").getByText("Fake API tests (from Postman)").waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "Import" }).click();
  await page.getByRole("dialog").getByText("Imported", { exact: true }).waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  await page.getByRole("link", { name: "Fake API tests (from Postman)" }).waitFor();
});

await check("Run dialog: AI runs are offered only for collections from Postman", async () => {
  await page.getByRole("row", { name: /^Fake API tests Uploaded/ }).getByRole("button", { name: "Run" }).click();
  await page.getByText("AI runs need a collection imported from Postman").waitFor();
  if (!(await page.getByRole("radio", { name: /AI run/ }).isDisabled())) throw new Error("the AI option is enabled");
});

await check("Run: a plain run starts, shows live progress, and passes using the secret variable", async () => {
  await button("Start run").click();
  await page.waitForURL(/\/runs\/\d+$/);
  await page.getByText("Passed", { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.getByText("03 Uses an environment variable").waitFor();
  const failedChecks = await page.locator("text=Failed checks").locator("..").textContent();
  if (!failedChecks?.includes("0")) throw new Error(`failed checks: ${failedChecks}`);
});

await check("Run: an AI run on a down server stops with the server-issue message (no AI cost)", async () => {
  api.state.mode = "down";
  await page.goto(`${base}/collections`);
  await page.getByRole("row", { name: /from Postman/ }).getByRole("button", { name: "Run" }).click();
  await page.getByRole("radio", { name: /AI run/ }).check();
  await button("Start run").click();
  await page.waitForURL(/\/runs\/\d+$/);
  await page.getByText("Facing server issues, please check Test Env").first().waitFor({ timeout: 60_000 });
  api.state.mode = "ok";
});

await check("Build with AI: needs a description, then starts a build run (a down server stops it before any AI cost)", async () => {
  api.state.mode = "down";
  await page.goto(`${base}/collections`);
  await button("Build with AI").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("What should be tested?").fill("too short");
  if (!(await dialog.getByRole("button", { name: "Start building" }).isDisabled())) throw new Error("starts with a too-short description");
  await dialog.getByRole("button", { name: /firstname and lastname filters/ }).click();
  await dialog.getByRole("button", { name: "Start building" }).click();
  await page.waitForURL(/\/runs\/\d+$/);
  await page.getByText("What to test").waitFor();
  await page.getByText("AI build").first().waitFor();
  await page.getByText("Facing server issues, please check Test Env").first().waitFor({ timeout: 60_000 });
  api.state.mode = "ok";
});

await check("Known bugs and AI changes pages explain themselves when empty", async () => {
  await page.goto(`${base}/known-bugs`);
  await page.getByText("No known bugs").waitFor();
  await page.goto(`${base}/changes`);
  await page.getByText("No changes yet").waitFor();
});

await check("Runs: the history lists both runs and filters by status", async () => {
  await page.goto(`${base}/runs`);
  await page.getByRole("link", { name: "#2" }).waitFor();
  await page.getByRole("link", { name: "#1" }).waitFor();
  await page.getByLabel("Status").selectOption("passed");
  await page.getByRole("link", { name: "#1" }).waitFor();
  if (await page.getByRole("link", { name: "#2" }).count()) throw new Error("the server-issue run is still listed");
});

await check("Dashboard: shows the runs and the headline figures", async () => {
  await page.goto(base);
  await page.getByText("Runs, last 7 days").waitFor();
  await page.getByRole("heading", { name: "Latest runs" }).waitFor();
  await page.getByText("Runs per day").waitFor();
});

await check("Settings: email is saved and a test email arrives", async () => {
  await page.goto(`${base}/settings`);
  await page.getByPlaceholder("smtp.gmail.com", { exact: true }).fill("127.0.0.1");
  await page.getByLabel("Port", { exact: true }).fill(String(smtp.port));
  await page.getByLabel(/Use SSL/).uncheck();
  await page.getByPlaceholder("you@gmail.com", { exact: true }).fill("qa@example.com");
  await page.getByLabel("Password", { exact: true }).fill("app-pass"); // the hint describes the field, it isn't part of its name
  await page.getByLabel("Dashboard address").fill(base);
  await button("Save").first().click();
  await page.getByText("Email settings saved").waitFor();
  await page.getByLabel("Send a test email to").fill("me@example.com");
  await button("Send test").click();
  await page.getByText("Test email sent to me@example.com").waitFor();
  if (!smtp.mails.some((m) => m.to.includes("me@example.com"))) throw new Error("no email arrived");
});

await check("Collection: report recipients and a schedule", async () => {
  await page.goto(`${base}/collections`);
  await page.getByRole("link", { name: "Fake API tests", exact: true }).click();
  await page.getByLabel("Email addresses").fill("dev@example.com, not-an-address");
  await page.getByRole("button", { name: "Add", exact: true }).last().click();
  await page.getByText("Not an email address: not-an-address").waitFor();
  await page.getByLabel("Email addresses").fill("dev@example.com");
  await page.getByRole("button", { name: "Add", exact: true }).last().click();
  await page.getByRole("radio", { name: /^Every run/ }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Report settings saved").waitFor();
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Next runs:").waitFor();
  await dialog.getByRole("button", { name: "Create schedule" }).click();
  await page.getByText("Weekdays at 07:00").first().waitFor();
});

await check("Run: with a report rule, a finished run is emailed and shows it", async () => {
  const before = smtp.mails.length;
  await page.getByRole("button", { name: "Run", exact: true }).first().click();
  await button("Start run").click();
  await page.waitForURL(/\/runs\/\d+$/);
  await page.getByText(/Sent to dev@example.com/).waitFor({ timeout: 30_000 });
  if (smtp.mails.length <= before) throw new Error("no email arrived");
});

await check("Run: email the report by hand, and open it", async () => {
  await button("Email report").click();
  await page.getByRole("dialog").getByRole("textbox").fill("boss@example.com");
  await page.getByRole("dialog").getByRole("button", { name: "Send" }).click();
  await page.getByText("Report sent to boss@example.com").waitFor();
  const [report] = await Promise.all([page.waitForEvent("popup"), page.getByRole("link", { name: "Open report" }).click()]);
  await report.waitForLoadState();
  if (!(await report.title()).includes("Fake API tests")) throw new Error(`report title: ${await report.title()}`);
  await report.close();
});

await check("Settings: says secrets are encrypted and where the key file is", async () => {
  await page.goto(`${base}/settings`);
  await page.getByText("are stored encrypted (AES-256-GCM)").waitFor();
  await page.getByText(/secret\.key/).first().waitFor();
});

await check("Environments: compare side by side, then copy a secret into another environment", async () => {
  const made = await page.request.post(`${base}/api/environments`, { data: { name: "stg", label: "Stg", base_url: api.url, health_path: "/health", variables: [{ key: "region", value: "us" }] } });
  if (!made.ok()) throw new Error(`creating Stg: ${made.status()}`);
  await page.goto(`${base}/environments`);
  await page.getByRole("link", { name: "Compare and copy" }).click();
  await page.waitForURL(/\/environments\/compare/);
  const row = (key: string) => page.getByRole("row", { name: new RegExp(`^${key}`) });
  await row("apiToken").getByText("Missing").waitFor();
  await row("apiToken").getByText("••••23").waitFor();
  if ((await page.content()).includes("secret-123")) throw new Error("a secret value is on the page");
  await row("apiToken").getByRole("button", { name: "Copy apiToken" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("add", { exact: true }).waitFor(); // the preview: it will be added to Stg
  await dialog.getByRole("button", { name: "Copy 1 value to Stg" }).click();
  await page.getByText("Copied 1 value to Stg").waitFor();
  await row("apiToken").getByText("Same").waitFor();
});

await check("Test data: upload a CSV; a run goes once per row and shows which row failed", async () => {
  const file = join(dir, "tokens.csv");
  writeFileSync(file, "apiToken,note\nsecret-123,right\nwrong-token,wrong\n");
  await page.goto(`${base}/collections/1`);
  await page.getByLabel("Choose a CSV or JSON file").setInputFiles(file);
  await page.getByText("tokens.csv: 2 rows, 2 columns").waitFor();
  await page.getByRole("dialog").getByText("Not used: note.").waitFor(); // the preview opens after uploading
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Run", exact: true }).first().click();
  await page.getByLabel("Test data").selectOption({ label: "tokens.csv (2 rows)" });
  await button("Start run").click();
  await page.waitForURL(/\/runs\/\d+$/);
  await page.getByText("Failed", { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.getByText("Test data: tokens.csv, 2 rows, once per row").waitFor();
  await page.getByText("· 3 requests passed").waitFor(); // row 1: the right token
  await page.getByText("1 of 3 requests failed").waitFor(); // row 2: the wrong token
});

await check("Settings: runs at the same time, sessions, and a backup made by hand", async () => {
  await page.goto(`${base}/settings`);
  await page.getByText("this one").waitFor();
  await page.getByLabel("Runs at the same time").selectOption("3");
  await button("Apply").click();
  await page.getByText("Up to 3 runs at the same time").waitFor();
  await button("Back up now").click();
  await page.getByText(/^Backup made: qa-\d{8}-\d{6}-manual\.db$/).waitFor();
  await page.getByText("Made by hand").first().waitFor();
});

await check("Audit log: lists what happened, including the copied secret and the failed login, and filters", async () => {
  await page.goto(`${base}/audit`);
  await page.getByText("Copied values from Test to Stg: added apiToken").waitFor();
  await page.getByText("Wrong password", { exact: true }).waitFor();
  await page.getByText(/^Started plain run #\d+: Fake API tests on \w+ with tokens\.csv/).first().waitFor();
  if ((await page.content()).includes("secret-123")) throw new Error("a secret value is in the audit log");
  await page.getByLabel("Show").selectOption("auth.");
  await page.getByText("Set the dashboard password").waitFor();
  if (await page.getByText("Copied values from Test to Stg").count()) throw new Error("the filter didn't apply");
});

// ---- Contracts ----
const PETS = `openapi: 3.0.3
info: { title: Pet Store, version: 1.0.0 }
paths:
  /pets: { get: { summary: List pets, responses: { '200': { description: ok } } }, post: { summary: Add a pet, responses: { '201': { description: created }, '400': { description: invalid } } } }
  /pets/{id}: { get: { summary: Get a pet, responses: { '200': { description: ok }, '404': { description: not found } } } }
`;
let contractId = 0;
await check("Contracts: upload an OpenAPI file and see its endpoints", async () => {
  const file = join(dir, "pets.yaml");
  writeFileSync(file, PETS);
  await page.goto(`${base}/contracts`);
  await page.getByText("No contracts yet").waitFor();
  await button("Add contract").first().click();
  await page.getByLabel("Choose a contract file").setInputFiles(file);
  await page.getByRole("dialog").getByRole("button", { name: "Add contract" }).click();
  await page.waitForURL(/\/contracts\/\d+$/);
  contractId = Number(page.url().split("/").pop());
  await page.getByRole("heading", { name: "Pet Store" }).waitFor();
  await page.getByText("3 of 3 selected for testing").waitFor();
  await button("Deselect all").click();
  await page.getByText("0 of 3 selected for testing").waitFor();
  await page.getByText("Select at least one endpoint to generate tests.").waitFor();
  if (!(await button("Generate tests").isDisabled())) throw new Error("Generate is enabled with nothing selected");
  await button("Select all").click();
  await page.getByText("3 of 3 selected for testing").waitFor();
  // A group: the spec has no tags here, so endpoints are grouped by path ("/pets").
  await page.getByLabel("All endpoints in /pets").uncheck();
  await page.getByText("0 of 3 selected for testing").waitFor();
  await page.getByLabel("All endpoints in /pets").check();
  await page.getByText("3 of 3 selected for testing").waitFor();
  // A range: click the first, shift-click the last; everything between follows.
  await button("Deselect all").click();
  await page.getByLabel("Test GET /pets", { exact: true }).click();
  await page.getByLabel("Test GET /pets/{id}").click({ modifiers: ["Shift"] });
  await page.getByText("3 of 3 selected for testing").waitFor();
  await page.getByLabel("Test POST /pets").click();
  await page.getByText("2 of 3 selected for testing").waitFor();
  if (!(await page.getByLabel("All endpoints in /pets").evaluate((el: any) => el.indeterminate))) throw new Error("the group checkbox should show 'some'");
});

await check("Contracts: generate tests for the chosen endpoints (a down server stops it before any AI cost)", async () => {
  api.state.mode = "down";
  await button("Generate tests").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("You review them").waitFor();
  // The pre-run check calls a real endpoint: the test API has no /pets, so it warns and holds the start.
  await dialog.getByText("The contract's endpoint isn't at this base URL, so every test would fail.").waitFor();
  if (!(await dialog.getByRole("button", { name: "Start" }).isDisabled())) throw new Error("Start is enabled although the base URL looks wrong");
  await dialog.getByLabel(/Start anyway/).check();
  await page.getByLabel("Anything to focus on? (optional)").fill("Mostly errors");
  await dialog.getByRole("button", { name: "Start" }).click();
  await page.waitForURL(/\/runs\/\d+$/);
  await page.getByText("AI contract").first().waitFor();
  await page.getByRole("link", { name: "Pet Store" }).waitFor();
  await page.getByText(/Facing server issues, please check \w+ Env/).first().waitFor({ timeout: 60_000 });
  api.state.mode = "ok";
});

// Two runs as the agents would leave them: one waiting for the case review, one finished.
const plan = { collection_name: "Pet Store Contract Tests (agent-built)", summary: "Checks listing and getting pets.", gaps: ["404 has no body schema"],
  cases: [
    { id: "TC01", endpoint: "GET /pets", type: "positive", title: "List pets", expected: "200" },
    { id: "TC02", endpoint: "GET /pets/{id}", type: "negative", title: "Unknown pet", expected: "404" },
    { id: "TC03", endpoint: "GET /pets/{id}", type: "positive", title: "Get a pet", expected: "200 with a name" },
  ] };
const seeded = new DatabaseSync(join(dir, "qa.db"));
const addRun = (status: string, result: unknown = null) => Number(seeded.prepare(`INSERT INTO runs (collection_name, environment_id, environment_label, kind, ai_mode, contract_id, status, result_json, created_at, started_at, finished_at)
  VALUES ('Contract: Pet Store', 1, 'Test', 'ai', 'contract', ?, ?, ?, datetime('now'), datetime('now'), ?)`).run(contractId, status, result ? JSON.stringify(result) : null, status === "running" ? null : new Date().toISOString()).lastInsertRowid);
const waiting = addRun("running");
seeded.prepare("INSERT INTO run_events (run_id, seq, type, data_json, created_at) VALUES (?, 1, 'approval_request', ?, datetime('now'))").run(waiting, JSON.stringify({ id: 1, kind: "test_cases", plan }));
const builtCollection = { info: { name: plan.collection_name, schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" }, item: plan.cases.map((c) => ({ name: `${c.id} ${c.title}`, request: { method: "GET", url: "{{baseUrl}}/pets" } })) };
const finished = addRun("passed", { collections: [], report: "", contract: { name: "Pet Store", plan, review_rounds: 1, collection: builtCollection } });
seeded.close();

await check("Case review: drop one, edit one, add one; what's sent is exactly the edited cases", async () => {
  let sent = "";
  await page.route(`**/api/runs/${waiting}/approval`, async (route: any) => {
    sent = JSON.parse(route.request().postData()).answer;
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  });
  await page.goto(`${base}/runs/${waiting}`);
  await page.getByText("Review the test cases").waitFor();
  await page.getByText("404 has no body schema").waitFor();
  await button("Approve all 3 cases").waitFor();
  await button("Deselect all").click();
  await page.getByText("0 of 3 cases selected").waitFor();
  if (!(await page.getByRole("button", { name: /^Approve/ }).isDisabled())) throw new Error("approving nothing is allowed");
  await button("Select all").click();
  await page.getByText("3 of 3 cases selected").waitFor();
  await page.getByLabel("All cases for GET /pets/{id}").uncheck();
  await page.getByText("1 of 3 cases selected").waitFor();
  await page.getByLabel("All cases for GET /pets/{id}").check();
  await page.getByText("3 of 3 cases selected").waitFor();
  await page.getByLabel("Keep TC02").uncheck();
  if (!(await page.getByLabel("All cases for GET /pets/{id}").evaluate((el: any) => el.indeterminate))) throw new Error("the endpoint's checkbox should show 'some'");
  await page.getByRole("button", { name: /TC03/ }).click();
  await page.getByLabel("Expected").fill("200 with a name and an id");
  await button("Add a case").click();
  await page.getByLabel("Title").last().fill("List pets with a negative limit");
  await page.getByLabel("Expected").last().fill("400");
  await button("Approve 3 cases with my changes").click();
  await page.waitForTimeout(300);
  const p = JSON.parse(sent);
  if (JSON.stringify(p.cases.map((c: any) => c.id)) !== '["TC01","TC03","TC04"]') throw new Error(`cases sent: ${sent}`);
  if (p.cases[1].expected !== "200 with a name and an id" || p.cases[2].title !== "List pets with a negative limit") throw new Error(`edits not sent: ${sent}`);
  if (p.collection_name !== plan.collection_name) throw new Error("the plan's other fields were lost");
  await page.unroute(`**/api/runs/${waiting}/approval`);
  // Now for real, with a long edit: the server must accept the size (this sample run has no agent behind it, so it answers "not waiting").
  await page.getByRole("button", { name: /TC01/ }).click();
  await page.getByLabel("Expected").first().fill("200. Body is a JSON array matching the 200 array-of-Pet schema; every item has a string name and an array photoUrls. ".repeat(8));
  await page.getByRole("button", { name: /^Approve/ }).click();
  await page.getByText("This run isn't waiting for an approval.").waitFor();
  if (await page.getByText(/Too big/).count()) throw new Error("the edited plan was refused as too big");
});

await check("Add to Postman: choose the workspace, then a folder in an existing collection, confirm", async () => {
  await page.goto(`${base}/runs/${finished}`);
  await button("Choose where to add it").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Workspace").selectOption({ label: "Practice (personal)" });
  await dialog.getByRole("radio", { name: /A folder in an existing collection/ }).check();
  await dialog.getByRole("combobox", { name: "Collection", exact: true }).selectOption({ label: "Fake API tests (from Postman)" });
  await dialog.getByLabel("Folder name").fill("Pets contract");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByText("Add 3 requests to the workspace Practice, as a new folder Pets contract in the collection Fake API tests (from Postman)?").waitFor();
  if (pm.store.get("1-abc").item.some((i: any) => i.name === "Pets contract")) throw new Error("published before confirming");
  await dialog.getByRole("button", { name: "Yes, add them" }).click();
  await page.getByText("Added 3 requests to Practice → Fake API tests (from Postman) → Pets contract").waitFor();
  const folder = pm.store.get("1-abc").item.find((i: any) => i.name === "Pets contract");
  if (folder?.item?.length !== 3) throw new Error("the folder isn't in the collection");
  await page.getByText(/Added 3 requests to Practice → folder Pets contract in collection Fake API tests/).waitFor();
});

await check("Add to Postman as a new project: asks each environment's base URL and creates the environments", async () => {
  const before = (await (await page.request.get(`${base}/api/environments`)).json()).length;
  await page.goto(`${base}/runs/${finished}`);
  await button("Add it somewhere else too").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: /A new collection/ }).check();
  await dialog.getByLabel("Collection name").fill("Pets project");
  await dialog.getByLabel("Test base URL").fill("https://test.pets.example.com/v1");
  await dialog.getByLabel("Stg base URL").fill("ftp://nope");
  await dialog.getByText("Base URLs start with http:// or https://.").waitFor();
  await dialog.getByLabel("Stg base URL").fill("https://stg.pets.example.com/v1");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByText("Pets project - Stg").waitFor();
  await dialog.getByRole("button", { name: "Yes, add them" }).click();
  await page.getByText(/Added 3 requests to Practice → Pets project, with 2 environments/).waitFor();
  const made = pm.environments.filter((e: any) => e.name.startsWith("Pets project - "));
  if (made.length !== 2 || made[1].values[0].value !== "https://stg.pets.example.com/v1") throw new Error(`environments: ${JSON.stringify(made)}`);
  const after = (await (await page.request.get(`${base}/api/environments`)).json()).length;
  if (after !== before + 2) throw new Error(`dashboard environments ${before} → ${after}`);
});

await check("Contract page: lists its runs and where its tests are in Postman", async () => {
  await page.goto(`${base}/contracts/${contractId}`);
  await page.getByText("Practice → Fake API tests (from Postman) → Pets contract").waitFor();
  await page.getByText(`#${finished} on Test`).waitFor();
});

await check("Schedules page lists the schedule", async () => {
  await page.goto(`${base}/schedules`);
  await page.getByText("Weekdays at 07:00").waitFor();
});

await check("Theme: switching to dark is applied and remembered", async () => {
  await page.getByRole("radio", { name: "Dark" }).first().click();
  if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== "dark") throw new Error("not dark");
  await page.reload();
  if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== "dark") throw new Error("not remembered");
});

await check("Phone width: no page scrolls sideways", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/", "/collections", "/collections/1", "/environments", "/environments/compare", "/runs", "/runs/1", "/runs/3", "/known-bugs", "/changes", "/schedules", "/audit", "/settings", "/contracts", "/contracts/1"]) {
    await page.goto(base + path);
    await page.waitForLoadState("networkidle");
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    if (width > 390) {
      // Name the elements that stick out, to make the failure easy to fix.
      const culprits = await page.evaluate(() => [...document.querySelectorAll("body *")]
        .filter((el) => {
          if (el.getBoundingClientRect().right <= 391) return false;
          if ([...el.children].some((c) => c.getBoundingClientRect().right > 391)) return false; // report the innermost
          for (let p = el.parentElement; p; p = p.parentElement) if (getComputedStyle(p).overflowX !== "visible") return false; // inside a scroll area: fine
          return true;
        })
        .slice(0, 3).map((el) => `<${el.tagName.toLowerCase()} class="${el.className}">${(el.textContent ?? "").slice(0, 40)}`));
      throw new Error(`${path} is ${width}px wide: ${culprits.join(" | ")}`);
    }
  }
});

await check("no errors in the browser console", async () => {
  if (errors.length) throw new Error(errors.join(" | "));
});

await browser.close();
server.kill();
api.close();
pm.close();
smtp.close();
console.log(`\n${failed ? `${failed} check(s) FAILED` : "All checks passed"}`);
process.exit(failed ? 1 : 0);
