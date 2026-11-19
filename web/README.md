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
- **Collections**: import from Postman (connects through Settings first), upload a collection file, update from Postman, run. A collection's page lists its requests and runs, and can download or delete it.
- **Environments**: base URL, health check path and variables. Secret values are sent once and never shown again; leave one empty to keep it.
- **Runs**: the history, filterable by collection, environment, status and kind. A run's page follows it live:
  - plain runs: each request as it finishes, expandable to its checks, URL and response;
  - AI runs: what the agents are doing, approval cards (Approve / Refuse, with the diff), the agents' report, diagnoses, known bugs and the self-healer's changes, and the full log.
- **Settings**: the Postman API key.

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
