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
  stdio: "ignore",
});
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
  for (const path of ["/", "/collections", "/collections/1", "/environments", "/runs", "/runs/1", "/runs/3", "/known-bugs", "/changes", "/schedules", "/settings"]) {
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
