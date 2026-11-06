# WAD AI Office

An animated isometric office where WAD Furniture agents walk between rooms, work at their
desks and meet at the Command Center. It has two modes:

- **Demo Mode** — every agent, customer, order and price is simulated (mock data in
  `frontend/src/data/mock.ts`). Runs entirely in the browser.
- **Connected Mode** — Bea, Paolo and Chief run read-only reports against **WAD Furniture
  Management** and **WAD Order Management** through a server that holds the credentials.
  Requires sign-in. Live results are never mixed with demo data and never stored in the browser.

## Current integration status

| Part | Status |
| --- | --- |
| Office scene, characters, animations, Demo Mode | Working (unchanged) |
| Connected Mode server, sign-in, roles, sessions | Working |
| Approved-host HTTP client (timeouts, retries, rate limits, redirects blocked, size cap) | Working, tested against stubbed responses |
| Job queue, duplicate prevention, task log, live events to the office | Working |
| Report calculations (finance totals, order status, overdue, order-ID linking) | Working, tested with fixtures |
| WAD Furniture Management adapter | Working — `api/ceo/records` (Bearer token), tested against local data |
| WAD Order Management adapter | Working — `api/ceo/office-orders.php` (Bearer token), tested against local data |
| Assign Task (free-text tasks for all 9 agents) | Working — Google Gemini with read-only data tools; needs `GEMINI_API_KEY` |

Without `FINANCE_API_TOKEN` / `ORDERS_API_TOKEN`, live reports end in a clear "Not configured"
failure. Nothing is estimated or replaced with demo data.

## Folders

The project is split so each half can be hosted on its own:

| Folder | What it is | Where it can be hosted |
| --- | --- | --- |
| `frontend/` | The office you see (React + Phaser). Static files only, no secrets. | Vercel (`frontend/vercel.json`) |
| `backend/` | The API server: sign-in, reports, AI tasks. Holds every token and key. | Render (`render.yaml`) |

Both folders have a `shared/` folder with the same type definitions. **`backend/shared` is the
original**: after editing it, run `npm run sync-shared` (from the top folder) to copy it to
`frontend/shared`. `npm test` fails if the two copies differ.

## Run it on this PC

Requirements: Node.js 18.18 or newer. From the top folder:

```bash
npm run install:all     # installs backend/ and frontend/ packages
```

Then start both with one command (Ctrl+C stops both):

```bash
npm run dev             # API server on http://127.0.0.1:8787 (reads backend/.env)
                        # + the office on http://localhost:5173; /api is forwarded to the backend
```

Or separately, in two terminals: `npm run dev:backend` and `npm run dev:frontend`.

First-time backend setup (inside `backend/`): `cp .env.example .env`, fill it in (never commit
it), and `npm run hash-password owner admin` to make an `APP_USERS` entry. If you set
`APP_USERS` in a shell, wrap the value in **single quotes**: password hashes contain `$`.

Other commands (top folder): `npm test` (shared check, server tests, office simulation),
`npm run build` (builds both). In `frontend/`: `npm run build:single` makes a one-file Demo Mode
preview. In `backend/`: `npm run gemini-models` lists the Gemini models your key can use.

## Deploy: backend on Render, frontend on Vercel

The browser only ever talks to the Vercel address. Vercel forwards every `/api/...` request to
Render (a rewrite in `frontend/vercel.json`), so the sign-in cookie, the same-origin checks and
the live updates work exactly as on this PC, and the backend never needs to allow other sites.

1. **Put the project on GitHub** (one repository with both folders). `.env` files, `node_modules`
   and build output are excluded by `.gitignore`. Check `backend/knowledge/` holds nothing private
   before pushing, because those notes would be in the repository.
2. **Render:** New → Blueprint → pick the repository. Render reads `render.yaml`, builds
   `backend/` and asks for the secret values: `APP_USERS`, `FINANCE_API_TOKEN`,
   `ORDERS_API_TOKEN`, `GEMINI_API_KEY`, and `APP_ORIGIN` (put your Vercel address here; if you
   don't know it yet, fill it in after step 3 and redeploy). Note the service address, e.g.
   `https://wad-ai-office-api.onrender.com`.
3. **Vercel:** in `frontend/vercel.json`, replace `https://YOUR-BACKEND.onrender.com` with the
   Render address and push. Then Add New → Project → the repository, set **Root Directory** to
   `frontend`, and deploy. No environment variables are needed on Vercel.
4. Open the Vercel address and sign in.

Good to know:
- Sign-ins and results are kept in the backend's memory. When Render restarts or redeploys,
  everyone has to sign in again and earlier results are gone.
- Render's free plan sleeps after a period without visits; the first visit after that takes
  about a minute while it wakes. A paid instance stays awake.
- Vercel's free (Hobby) plan is for personal, non-commercial use; a business needs Pro.
- If a long-open live connection is cut by the proxy, the office reconnects by itself and
  reloads the current state.
- The task log goes to Render's log view (`TASK_LOG_FILE` is empty there, because Render's disk
  is wiped on restart).

### Running both on one server instead

`backend` can also serve the built office itself: build `frontend/` (`npm run build` there), set
`STATIC_DIR=../frontend/dist` in `backend/.env`, then run `npm run build && npm start` in
`backend/`. Use HTTPS and set `APP_ORIGIN` and `APP_COOKIE_SECURE=true`. Behind a reverse proxy,
also set `TRUST_PROXY=true`.

## Connected Mode

**Reports** (bottom bar, with a date range; all dates are Asia/Manila):

| Report | Agent | Needs permission | What it does |
| --- | --- | --- | --- |
| Finance summary | Bea | finance:read | Income, expenses and net per currency; expenses by category; budgets (budget vs. actual only if the docs confirm budgets use expense categories) |
| Order status | Paolo | orders:read | Orders in range by status, with production progress and due dates |
| Overdue orders | Paolo | orders:read | Open orders past their due date as of today in Manila |
| Combined report | Chief | both | Links finance records to orders **only by a verified shared order ID**, and lists records that could not be linked and orders whose costs are incomplete |

**How the office reflects live work:** each report is a server job with one step per agent.
The agent's name-tag dot and panel follow the server's events — *Queued*, *Working*,
*Completed*, *Error*. Walking to the desk or the meeting table is decoration only; a step is
marked completed only after the server has received and validated its result.

**Results show:** the source system, its host, the retrieval time (Manila), record count, record
references, notes about anything missing, and the label "Calculated by code from live records —
no AI". "No records found" is shown as a successful, empty result; connection errors, expired
credentials, missing permissions, rate limits and timeouts are each shown as distinct failures.

**Roles** (`APP_USERS`): `admin` and `manager` (finance + orders), `finance` (finance only),
`operations` (orders only). Permissions are enforced by the server.

## Security

- API credentials live only in server environment variables. The browser talks only to this
  server (`/api/...`). There are no `VITE_*` variables; `envPrefix` is set to `WAD_PUBLIC_` and
  nothing secret should ever use it.
- Requests go only to `FINANCE_API_BASE_URL` / `ORDERS_API_BASE_URL`, whose hosts must be listed
  in `API_ALLOWED_HOSTS` and use https. Paths cannot escape the base URL; redirects are not
  followed; only GET is sent (read-only).
- Sign-in uses scrypt password hashes, an HttpOnly SameSite=Strict session cookie, sign-in
  throttling (5 failures per address and 20 per username, each for 5 minutes), and a required request header plus Origin check on every state-changing call.
- Logs record method, host, path and status only. The task log (`TASK_LOG_FILE`) records report
  ids, type, user, status, timings and error codes — no amounts, customer details or credentials.
- Live results stay in server memory (last 200 jobs, per user) and in the open browser tab. They
  are not written to localStorage.

## Project layout

```
package.json         helper scripts for both folders (install:all, dev:*, build, test, sync-shared)
render.yaml          Render Blueprint for backend/
scripts/shared-sync.mjs   copies backend/shared to frontend/shared, or checks they match
backend/
  shared/            types and Asia/Manila date helpers (the original copy)
  src/
    index.ts           server entry
    app.ts             routes, sign-in checks, server-sent events, optional static files
    auth.ts            password hashing, sessions, roles, sign-in throttling
    config.ts          environment configuration and base-URL approval
    http/client.ts     the only outbound HTTP client (allowlist, retries, size cap)
    adapters/          finance.ts and orders.ts: read-only adapters for the WAD CEO API
    ai/                gemini.ts (Gemini client) and tasks.ts (agent roles, data tools)
    reports/calc.ts    report calculations in integer centavos
    jobs/              job runner, result validation, task log
    tests/             node:test suites
  scripts/           hash-password, gemini-models
  knowledge/         business notes the AI reads
frontend/
  shared/            copy of backend/shared (don't edit here)
  src/
    office/          office scene and rendering
    sim/             demo simulation engine (+ a small layer that shows live agent states)
    live/store.ts    Connected Mode client: session, live events, report and task submissions
    ui/              panels; ui/live/ holds the Connected Mode views
    agents/, data/mock.ts   characters, template brain, mock data
  scripts/sim-test.ts  simulation checks
  vercel.json        Vercel settings: build, /api forwarding, security headers
```

## The business-system API pages

Each system has a read-only page written for this office, using the same Bearer token as its
other `api/ceo/` endpoints. Both must be uploaded to the live sites:

| System | File on that site | Called as | Returns |
| --- | --- | --- | --- |
| WAD Furniture Management | `api/ceo/records.php` | `ceo/records?from=&to=` (no `.php`: the site redirects `.php` URLs) | Income records (every status), operating expenses with category, monthly budgets |
| WAD Order Management | `api/ceo/office-orders.php` | `ceo/office-orders.php?from=&to=` or `?open=1` | Orders (one per group), status, due date, pieces done / total, least-advanced stage, order price and downpayment |

Rules the adapters follow:
- Only `Delivered` closes an order; `Pending`, `In Progress` and `Finished` past their due date are overdue.
- Payroll and material purchases are separate tables in the finance app and are not counted as expenses.
- Income records carry no order ID, so the combined report does not link finance to orders.
- Budgets are monthly totals, not per category, so budget-vs-actual by category is not shown.
- Balance = order price (sum of the pieces' prices) - downpayment, as `orders.php` shows it; a
  Delivered order counts as paid. (`invoice.php` subtracts referral fees first, so its balance can
  be lower.)
- Customer names are fetched for **display only**: reports and AI answers show them next to the
  order number (e.g. "Maria Reyes (ORD-4AC57F69)"). They are never sent to the AI provider (its
  tools see order numbers only; the browser adds the names) and never written to the task log.
  Contact numbers, addresses and descriptions are never requested.

## Assign Task (AI)

In Connected Mode, type a task for any agent in the bottom bar (or **Assign Task** in an agent's
panel). The server sends it to Gemini with that agent's role, today's date, your notes in
`backend/knowledge/`, and the read-only data tools that agent **and** your role may use:

| Agent | Live data the AI can look up |
| --- | --- |
| Paolo, Lia, Nina, Dev | Orders by date, open/overdue orders (`orders:read`) |
| Bea | Finance records and totals (`finance:read`); order balances (needs both permissions) |
| Rosa (Collections Officer) | Balances and downpayments on open orders (needs both permissions); open orders |
| Chief | All of the above |
| Marco, Carlo | None: writing only, using `backend/knowledge/` notes |

- Totals, counts and days overdue are calculated **by code** and handed to the AI; it is told to
  quote them, never to add them up or estimate.
- The AI can't change anything: every tool is a read-only GET through the existing adapters.
  The AI sees order numbers only; the office adds customer names on screen afterwards.
- Answers are marked "Written by AI" and list every lookup and its source.
- **No request loops.** Nothing calls an API on its own: every report and task starts from a
  click. One task makes at most `AI_MAX_TOOL_ROUNDS` + 1 Gemini requests (4 by default), and the
  last one has lookups switched off so the AI must answer. A task makes at most 6 data lookups,
  and an identical repeat reuses the first result. Gemini requests are never retried
  automatically. Business-system requests retry at most `API_MAX_RETRIES` times (default 2,
  with backoff) on 429/5xx/network errors. AI tasks share a limit of 10 per minute.
- The task log records the agent and the prompt **length** only, never the prompt text.
- Settings: `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-flash-lite-latest`; run
  `npm run gemini-models` to list yours), `AI_MAX_TOOL_ROUNDS`, `AI_TIMEOUT_MS`, `KNOWLEDGE_DIR`.
- **Free-tier keys:** Google may use prompts and the data sent with them to improve its products,
  and the quota is small. Use a billing-enabled key for real business use.

## Demo Mode features (unchanged)

New Door Inquiry with Approve/Reject, Production Review, Marketing Draft, custom template tasks,
character and room panels, zoom/pan/reset, pause, sound toggle, activity feed, reduced motion,
and Reset demo. See the in-app labels; all of it uses mock data only.

## Not implemented yet

- Job history survives only while the server runs (in memory); the task log file persists.
- Write access of any kind — intentionally excluded.
