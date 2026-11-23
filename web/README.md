# QA dashboard web app

The dashboard's interface (phase 2 of `docs/ROADMAP.md`): React + TypeScript, built with Vite, styled with Tailwind, charts with Recharts. It talks only to the server in `server/`.

## Use it

Build it once; the server then serves it at the same address as the API:

    cd web && npm install && npm run build
    cd ../server && npm start          # open http://127.0.0.1:4000

After changing the web app, run `npm run build` again and reload the page; the server doesn't need restarting.

## Develop it

Run the server and Vite's dev server side by side; Vite reloads on every save and passes `/api` to the server:

    cd server && npm start             # API on port 4000
    cd web && npm run dev              # open http://localhost:5173

## Pages

- **Dashboard**: runs and pass rate over the last 7 days compared with the 7 before, open known bugs, AI cost; runs per day by outcome and pass rate per day (each with a table view); latest runs. With no runs yet, it shows the four steps to a first run.
- **Collections**: import from Postman (connects through Settings first), upload a collection file, update from Postman, run. **Build with AI**: describe what to test; the agents write a plan for you to approve or send back, build the collection, debug and fix it, publish it to Postman, and it's added here. A collection's page lists its requests and runs, and can download or delete it.
- **Environments**: base URL, health check path and variables. Secret values are sent once, stored encrypted and never shown again; leave one empty to keep it. **Compare and copy** puts environments side by side (same, different or missing, secrets compared without being shown) and copies chosen values from one to another, with a preview of what will be added or replaced.
- **Runs**: the history, filterable by collection, environment, status and kind. A run's page follows it live:
  - plain runs: each request as it finishes, expandable to its checks, URL and response;
  - AI runs: what the agents are doing, approval cards (Approve / Refuse, with the diff), the agents' report, diagnoses, known bugs and the self-healer's changes, and the full log.
- **Known bugs**: every known bug across collections and environments, open or possibly fixed, with when it was first and last seen and the evidence.
- **AI changes**: every change the self-healer made, with its diff and reason, whether you approved it, and whether it was kept or undone.
- **Schedules**: every schedule, with its next run and last result; pause, edit, delete. A collection's page has its own schedules too.
- **Contracts** (Generate tests checks the environment first: it calls a real endpoint, says if the base URL looks wrong and offers the contract's, and lists the credentials to fill in; when adding the result to Postman as a new collection, it asks each environment's base URL and creates the environments): add an API contract (OpenAPI/Swagger file or link, a Postman spec, or a PDF/Word/Markdown document), choose endpoints, and generate tests. On the run's page you review the Contract Analyst's test cases (keep, edit, remove, add, or send back), and when the run passes you choose the Postman workspace and a new collection or a folder in an existing one, then confirm. Links and Postman specs can be checked for changes.
- **Audit log**: who changed what and when, filterable: logins, settings, environments (which keys, never the values), runs, every AI approval, backups.
- **Settings**: the Postman API key, the mail server for reports (with a test email), the password and where you're logged in, how many runs may run at once, backups (make one now, download), and where the encryption key for saved secrets is.

The first visit asks you to set a password (with the setup code from the server's log); after that, every page needs a login. Log out at the bottom of the navigation.

A collection's page has a **Test data** card: upload a CSV or JSON file, preview it, and see which columns the collection doesn't use. Choose the file when running or scheduling and the collection runs once per row; the run's page groups requests by row and every failure says which row it came from.

A collection's page also sets **who gets its reports by email, and when**: every run, every failure, or only new failures. Each run's page can open or download the full report, email it now, and shows what was sent.

Light, dark, or matching the system: the switch is at the bottom of the navigation. Run statuses always show an icon and a label, never colour alone; every chart has a table view.

## Preview with sample data

To see the dashboard with a month of history before you have one, fill a separate database with invented runs:

    cd server
    npm run seed:demo -- data/demo.db
    QA_DB=data/demo.db npm start

Your real database (`data/qa.db`) is never touched by this.

## Tests

    npm run typecheck
    npm run build && npm run e2e

`e2e` clicks through the real app in a browser against a fresh database, a fake API and a fake Postman: connecting Postman, creating an environment with a secret, uploading and importing collections, plain and AI runs, the run history, the dashboard, the theme switch, and checks that no page scrolls sideways on a phone. It needs Playwright with Chromium: `npm i -D playwright && npx playwright install chromium`.
