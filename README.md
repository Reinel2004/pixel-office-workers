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
`operations` (orders only). Permissions are enforced by the server. Only `admin` also has the
Systems team (`system:read`) and Facebook posting; `admin` and `manager` can use UI Review
(`ui:review`) and see the AI usage tracker (`ai:usage`); only `admin` can change its limits and
prices (`ai:limits`).

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
| WAD Furniture Management | `api/ceo/cash-advances.php` | `ceo/cash-advances?from=&to=` | Employee cash advances issued in the range, every advance not yet fully paid, and repayments in the range (amount, remaining balance, status, date, employee id, name and position; names are shown in the office only and never sent to the AI). No remarks, contact details or photos |
| WAD Order Management | `api/ceo/office-orders.php` | `ceo/office-orders.php?from=&to=` or `?open=1`, plus `&products=1` for product details | Orders (one per group) with their record number (for links to `view_order.php`), status, due date, pieces done / total, least-advanced stage, last stage change, order price and downpayment, customer name (display only), and with `products=1` each order's pieces by category, type, wood and finish |
| WAD Order Management | `api/ceo/office-order-spec.php` | `ceo/office-order-spec.php?order=ORD-…` | One order's pieces for Tess's inspection checklist: category, design (type), size, thickness, dining dimensions and shape, wood, finish, jamb (hamba) with its wood and size, CNC, staff notes, whether a design photo / colour sample is attached, stage. No customer name, contact, address, price, labor or carpenter |

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

**Automatic data lookup.** When you ask Lia, Paolo, Nina, Bea, Rosa, Mika, Dev or Chief about
**orders, expenses, payments or employee cash advances** (English or Tagalog: *gastos, bayad,
vale, …*), the office reads the relevant records **by code before the AI answers**, instead of
leaving it to the AI to decide. It picks the period from the question (*today, yesterday, this
week, last week, last 30 days, this month, last month, October, 2026-09-01 to 2026-09-15, this
year, 2025*; **this month** when none is named, and it says so), keeps the topic for follow-ups
("and last month?"), reads only what your account may see, and calculates every total in integer
centavos: expenses (total, by category), payments received (income records by status), balances
still due on open orders (needs orders + finance access), orders (placed in the period, or all
open and overdue right now) and cash advances (issued and repaid in the period, outstanding now,
per employee). The task shows a **Looked up automatically** card for each: the figures, the period
and how it was chosen, the source system and host, the retrieval time and the record count. A
missing permission, a system that is not connected, or a failed read is shown as a limitation
(*"WAD Furniture Management is not connected: …"*), the AI is told to say that part could not be
checked, and nothing is estimated or taken from demo data. Employees reach the AI as `EMP-…`
codes only (a name you type is matched to its code by the office); names are shown on your screen.
Cash advances need `api/ceo/cash-advances.php` uploaded to WAD Furniture Management. To check the
lookups against your systems without AI: `npx tsx scripts/lookup-smoke.ts "your question"` in
`backend/` (prints statuses and counts only).

**Task Board (Tasks tab in the live feed).** Every report and assigned task of your account, newest
activity first, with the agent, title, when it was created and last updated, and its status:
**Queued**, **Working**, **Needs information** (the agent asked a question: answer it in the task),
**Ready for review** (an AI answer for you to check), **Completed** (reports calculated by code, or
an answer you marked complete), **Failed** or **Cancelled**. Filter by *In progress*, *Needs you*,
*Completed* or *Failed / cancelled*; the tab shows how many need you. Opening a task shows its
**instructions**, its actual **progress** (created, started, each step with its result or error,
follow-ups, review, cancel, with times), the **automatic lookups**, sources, the saved answer, the
**conversation**, and the actions: **reply / follow up** (the same task runs again with the
conversation so far, up to 10 follow-ups), **Mark complete**, **Cancel task** (a queued task is
taken off the queue; a working one has its AI request aborted) and **Run again as a new task**.
Only you see your tasks; every action checks that, plus the cross-site header. A submission key
and the in-flight check stop double submissions. Tasks are kept on the server, so they stay after
a reload, and in `TASKS_FILE` (default `backend/data/tasks.json`; empty = memory only) so they
survive a restart: a task that was running is shown as interrupted, photos are never saved, and
customer and employee names are left out of the file (those tasks then show numbers and codes).
On Render the file is wiped on redeploy unless you add a persistent disk. Agents still animate from
the task's real progress; "Needs information" makes the agent say so in the office. Waiting
questions also appear in **Attention needed**.

In Connected Mode, type a task for any agent in the bottom bar (or **Assign Task** in an agent's
panel). The server sends it to Gemini with that agent's role, today's date, your notes in
`backend/knowledge/`, and the read-only data tools that agent **and** your role may use:

| Agent | Live data the AI can look up |
| --- | --- |
| Paolo, Lia, Nina | Orders by date, open/overdue orders (`orders:read`) |
| Dev (Data Quality Checker) | Data checks calculated by code (`orders:read`; downpayment check only with `finance:read`); orders by date, open orders |
| Sam (Systems Monitor), Ivy (Security Officer) | The server's own measurements: system health, and sign-in and security events (`system:read`, admin only) |
| Bea | Finance records and totals (`finance:read`); order balances (needs both permissions) |
| Mika (Data Analyst, Intelligence Lab) | Order trends by month/week, product mix (category, type, wood, finish), production pipeline and bottlenecks (`orders:read`; order values only with `finance:read`); monthly income vs. expenses (`finance:read`) |
| Rosa (Collections Officer) | Balances and downpayments on open orders (needs both permissions); open orders |
| Joy (Customer Service) | Only the one order you pick for the reply (`orders:read`; balance only with `finance:read`) |
| Tess (Quality Control Assistant, Operations Hub) | Only the code-built inspection checklist of the order you pick in her panel (`orders:read`); never the staff notes |
| Aya (UI/UX Designer), Rey (Developer), Kim (QA Tester) | None in Assign Task: advice only. Their real work is **UI Review** (below), on screenshots you upload (`ui:review`) |
| Chief | All of the above |
| Marco, Carlo | None: writing only, using `backend/knowledge/` notes. Carlo also takes a **photo** (see below) |

- **Team discussion (Connected Mode):** click **Team discussion** next to Assign, type a topic
  (examples are offered), optional context and constraints, pick 2 to 4 participants (Chief
  moderates) and the report period, then **Start discussion**. The server runs a fixed, bounded
  workflow, every step a separate Gemini request with that agent's own role and evidence:
  *gathering* (one read-only evidence snapshot: order status, overdue orders, production stages,
  anonymised carpenter workload, data checks, and for finance accounts income/expenses and
  balances, all calculated by the existing report code, with retrieval time and period) →
  *round 1* (each specialist proposes alone: findings marked fact/hypothesis/recommendation with
  evidence ids, actions, assumptions, missing information) → *round 2* (each reviews the others:
  unsupported claims, constraints, trade-offs, improvements) → *Chief's synthesis* (summary,
  recommended approach, action items with proposed owners, risks, open questions, remaining
  disagreement). Limits: 2 to 4 specialists, at most 2·n + 1 contributions, one retry only for
  rate limits/timeouts/5xx, 2 specialists asked at once, 2 discussions running server-wide, one per
  user, 6 per user per hour, 10 minutes per discussion. Everything the agents see is limited to the
  requesting user's permissions; customer and staff names never reach Gemini; evidence ids an agent
  was not given are removed by code; a "fact" without evidence is relabelled a hypothesis. If a
  participant fails its contribution is labelled missing and Chief's summary lists it; if every
  proposal fails or Chief fails, the discussion is marked failed. Cancel stops new requests and
  aborts the running ones. Progress arrives over the live connection; the **Discuss** tab lists past
  discussions (owner only). Discussions are saved in `DISCUSSIONS_FILE` (default
  `backend/data/discussions.json`, git-ignored; empty = memory only); one cut off by a restart is
  shown as *Interrupted*, never as running. Token usage is shown when Gemini reports it. Proposals
  only: nothing is changed, sent or carried out. In the office, participants walk to the Command
  Center table with short statuses ("Reviewing data", "Proposing", "Reviewing ideas") and return
  afterwards; anyone busy with other work stays on it. **Demo Mode** shows clearly labelled sample
  discussions (no AI, no data), kept in the browser separately. To try the real AI cheaply on
  sample data: `npx tsx scripts/discussion-smoke.ts` in `backend/` (5 Gemini requests).
- **Inspection checklists with Tess (Quality Control Assistant):** open Tess's panel (Operations
  Hub), click **Load open orders**, pick the order and **Build checklist**. The server reads that
  order's pieces from `api/ceo/office-order-spec.php` and builds the checklist **by code** (no AI):
  identical pieces are grouped ("2 × Door · Panel Door · Narra · With Varnish"), each with checks
  for **dimensions** (size and thickness, or length × width × height and shape for tables; square,
  no warping), **design & wood** (the ordered design, the design photo, CNC work, wood, no cracks or
  loose joints), **finish** (as ordered, even coat, colour sample, smoothness; or "left unfinished"),
  **jamb** (included or not, its wood and size, the door fits it) and **hardware**, plus labelling,
  cleaning and protection. Expected values are copied from the order; anything it does not record is
  marked **not recorded — confirm with sales**, never filled in. Hardware is not a field in WAD
  Order Management, so it comes only from hardware words in the notes (hinges/bisagra,
  lockset/seradura, handle/hawakan, closer, bolt/trangka…). Tick items on screen, **Copy** or
  **Print** it (ticks are not saved anywhere). *Ask Tess about this order* (AI) rewrites or explains
  it, e.g. *"in Tagalog for the carpenters"*: Gemini gets the checklist and the hardware words,
  never the notes themselves or the customer's name. When she builds one, Tess walks to the
  Workshop for a look. Demo Mode has two sample orders.
- **UI Review (Development Studio: Aya, Kim and Rey; admin and manager accounts, `ui:review`):**
  click **UI review** in the bottom bar. Choose the website (WAD Order Management, WAD Furniture
  Management, WAD AI Office or another), name the page, optionally its address (a label only: the
  office **never opens it**), the device (desktop, phone or both) and what should be better, and add
  1 to 3 screenshots. Tick the box confirming no customer names, phone numbers or addresses are
  visible (blur them or use test data: screenshots go to Google Gemini). Then:
  1. **Review:** Aya (layout, navigation, readability, mobile) and Kim (usability, workflow,
     feedback, errors, tap sizes, contrast) each look at the screenshots in a **separate** request;
     neither sees the other. Findings are numbered by code (A1…, K1…) with severity, area,
     suggestion and screenshot number; Kim adds test steps.
  2. **Plan:** Rey turns both into at most 8 changes (C1…): kind (CSS, HTML, PHP, JavaScript,
     content), effort S/M/L, risk, steps, how to check, and which findings each solves (unknown ids
     are dropped by code). He is told what the site is built with (order system: PHP + Tailwind CSS)
     and never invents file names.
  3. **Your turn:** tick the changes you want. The **Developer brief** (built by code from the
     ticked changes) is ready to **Copy** into your coding tool — for example Claude Code in VS Code
     opened in `C:\laragon\www\order-management` — which makes the change in your project. Check
     the diff, test it on your PC and on a phone, then upload to the live site as usual. Rey can't
     see or change code, and the office never deploys anything.
  4. **Re-check:** upload "after" screenshots of the same page. Kim compares them with the "before"
     ones (when the server still has them) and reports each **accepted** change as done, partly
     done, not done or cannot tell, plus anything that broke. Code adds a line for any change she
     left out and gives **Ready to release** only when every accepted change is done and nothing
     broke; otherwise **Needs fixes**. Up to 3 re-checks per review.
  Limits: a review is 3 Gemini requests and a re-check 1 (one retry only for rate limits, timeouts
  and 5xx); one run per user at a time, 2 server-wide, 8 runs per user per hour, 6 minutes per run;
  screenshots JPEG/PNG/WebP, checked by their real bytes, at most 2 MB each and 5 MB together (the
  browser shrinks them to 1600 px). Screenshots are kept **in server memory only** (never on disk or
  in a log; at most 10 reviews' worth, for a day) and shown only in the browser that uploaded them.
  The page name, goal, notes and any text inside the screenshots are passed to the AI as data, never
  as instructions; phone numbers and emails typed in are removed. Reviews (text only) are saved in
  `UI_REVIEWS_FILE` (default `backend/data/ui-reviews.json`; empty = memory only); a run cut off by
  a restart is marked interrupted. The **UI** tab lists your reviews (owner only). While a step
  runs, the team stands at the Dev Studio whiteboard. **Demo Mode** shows labelled sample reviews
  (no AI, nothing uploaded). To try the real AI on a drawn sample wireframe:
  `npx tsx scripts/uireview-smoke.ts` in `backend/` (4 Gemini requests).
- **Systems team (Sam and Ivy, Development Studio, admin accounts only):** the server times every
  call it makes to the order system, the finance system, Gemini and Facebook (duration and HTTP
  status only: no URLs, bodies or tokens) and keeps a short log of sign-ins and refused requests
  (client addresses only as an anonymous fingerprint; usernames only for real accounts). Both are
  kept in memory (24 hours of calls, 7 days of events) and reset on restart. Ask Sam *"Is everything
  working?"* for failures, slow systems, likely causes (401/403 token, 429 limits, 5xx system,
  timeout) and what to fix; ask Ivy *"Any suspicious sign-ins this week?"* for failed or locked
  sign-ins, password guessing from one source, blocked cross-site requests, permission denials and
  risky settings.
- **Attention needed (bell in the top bar, Connected Mode):** one list, built by code (no AI)
  from what the server already knows, filtered by your account's permissions:
  **connections** (a business system, Gemini or Facebook not set up, or its recent calls failing,
  with the likely cause: token refused, rate limit, system error, unreachable; failures older than
  an hour with nothing since are left out), **AI limits** reached (everyone) or close (accounts that
  see AI usage), **blocked or failed work** (your own tasks, reports, team discussions and UI
  Reviews from the last 7 days) and **overdue orders** (open orders past their due date, most
  overdue first, up to 30; more than 7 days late = urgent). The badge counts urgent and warning
  items (red when something is urgent). Each item links to its record: the task, report,
  discussion or review opens in the side panel; connections and limits open the Systems tab; an
  overdue order opens its page in WAD Order Management (`view_order.php?id=…`, in a new tab: sign
  in there as usual). Order links need the updated `api/ceo/office-orders.php` (it now also sends
  each order's `record_id`). **Dismiss** hides an item in this browser only, until it changes (a
  new failure, a new due date or stage); **Show dismissed** brings them back. The list refreshes
  when you open it, a couple of seconds after a task, discussion or review finishes, and every 2
  minutes while the tab is visible. Overdue orders reuse the server's last read of the order
  system (the Workshop's live check), so this normally adds no requests to it.
- **AI usage tracker (Systems tab; admin and manager accounts see it, only admins change it):**
  every request the server actually sends to Gemini is counted (retries and failed ones too), with
  the tokens Gemini reports (input includes photos and screenshots; output includes thinking), by
  day (Manila time), feature (assigned tasks, team discussions, UI Review), team member and
  account. It shows today and this month, a 30-day chart (also as a table) and the latest 40
  requests (time, what for, result, tokens: never the prompt or answer).
  **Limits are checked before each request is sent**; a request over a limit is refused with
  "Office AI limit reached" (nothing is sent to Google, nothing is billed). Limits: requests per
  day for the whole office (default **500**; `0` pauses all AI), requests per account per day,
  tokens per day, and a monthly budget in US$. A bar turns amber from the warning level (default
  80%) and red when the limit is reached. **Cost is an estimate:** enter your model's prices (US$ per
  1 million input and output tokens, from Google's Gemini API pricing page for your tier) and the
  tracker multiplies the reported tokens by them; the monthly budget only works once both prices are
  set. On a free key the real cost is US$0 and the request limits are what matter. Admins change
  limits and prices under **Change limits and prices** (recorded in the task log, never the key);
  **Reset to server defaults** goes back to these settings: `AI_DAILY_REQUEST_LIMIT` (500; empty or
  `off` = no limit), `AI_USER_DAILY_REQUEST_LIMIT`, `AI_DAILY_TOKEN_LIMIT`, `AI_MONTHLY_BUDGET_USD`,
  `AI_PRICE_INPUT_USD_PER_M`, `AI_PRICE_OUTPUT_USD_PER_M`, `AI_USAGE_WARN_PERCENT` (80). Totals and
  office-set limits are saved in `AI_USAGE_FILE` (default `backend/data/ai-usage.json`; empty =
  memory only), 400 days kept. On Render that file is wiped on redeploy unless you add a persistent
  disk. Sam's health check includes today's usage and limits. Your real bill is on Google's
  billing page; the tracker counts only requests made by this server (not the Messenger chatbot or
  anything else using the same key).
- **Customer replies with Joy:** open Joy's panel (Sales & Growth), paste the customer's message
  from Messenger, Viber, SMS or email, and optionally click **Load open orders** and pick the
  customer's order (search by name or order number; the list is loaded only when you click). Joy
  drafts a **Reply** in the customer's language plus **Notes for staff**; click **Copy reply** and
  send it yourself. Nothing is sent from the office. Phone numbers and emails are removed on the
  server before the message is stored or sent to Gemini; names and addresses can't be detected
  reliably, so delete those before pasting. Gemini gets the picked order's status, stage, due date
  and items by order number only (balance only for finance accounts); the office fills in the
  customer's name when you copy. Joy never guesses an order: with none picked she asks the
  customer for their order number.
- **Caption + schedule in one task:** give Carlo a photo and a request such as *"Short caption for
  this door, schedule it Saturday 9am"*. He is told the current Manila date and time, writes the
  caption, and ends with a line `**Schedule:** YYYY-MM-DD HH:MM` (or `now`). The office checks that
  time by code (15 minutes to 29 days ahead) and shows a **Ready for your approval** card under his
  answer with the photo, caption and time. One click on **Approve & schedule** (or **Approve & post
  now**) sends it; **Edit** opens the full composer. Carlo never posts by himself, and one task can
  only ever make one post.
- **Photos for Carlo:** pick Carlo, click **Photo**, choose a JPEG, PNG or WebP picture (text is
  optional). The browser shrinks it to at most 1600 px and re-encodes it as JPEG, which also drops
  hidden camera data such as GPS location. The server checks the type, the file's real signature
  and size (max 3 MB), sends it to Gemini with the request, and forgets it when the task ends; it
  is never stored or logged (the task log keeps only its size). Carlo lists what he sees, then
  writes a caption, a short version and hashtags. He won't name the wood species unless you say
  it, and leaves out people, house numbers and plates. The photo is sent to Google: on a free key
  Google may use it to improve its products.
- Totals, counts and days overdue are calculated **by code** and handed to the AI; it is told to
  quote them, never to add them up or estimate.
- The AI can't change anything: every tool is a read-only GET through the existing adapters.
  The AI sees order numbers only; the office adds customer names on screen afterwards.
- Answers are marked "Written by AI" and list every lookup and its source.
- **No request loops.** Nothing calls an API on its own: every report and task starts from a
  click. One task makes at most `AI_MAX_TOOL_ROUNDS` + 1 Gemini requests (4 by default), and the
  last one has lookups switched off so the AI must answer. A task makes at most 6 data lookups,
  and an identical repeat reuses the first result. A Gemini request that fails because Google is overloaded (503), has a
  500 error or can't connect is retried once after a few seconds (counted in AI usage). Business-system requests retry at most `API_MAX_RETRIES` times (default 2,
  with backoff) on 429/5xx/network errors. AI tasks share a limit of 10 per minute.
- The task log records the agent and the prompt **length** only, never the prompt text.
- Settings: `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-flash-lite-latest`; run
  `npm run gemini-models` to list yours), `AI_MAX_TOOL_ROUNDS`, `AI_TIMEOUT_MS`, `KNOWLEDGE_DIR`.
- **Free-tier keys:** Google may use prompts and the data sent with them to improve its products,
  and the quota is small. Use a billing-enabled key for real business use.

## Facebook posting (Carlo)

**Videos.** Pick Carlo, click **Photo / video** and choose an MP4 or MOV (at most 200 MB), with
an optional request such as *"short caption, schedule it Saturday 9am"*. The browser checks the
file and takes **6 still frames** from it (JPEG, at most 768 px); only those frames go to the
server and to Gemini, never the video itself. Carlo is told it is a video of that length seen as
frames, describes only what the frames show (no sounds, speech or movement he cannot see) and
writes a video caption plus the Schedule line as for photos. The video stays in that browser tab
(it is gone after a reload). When you click **Approve & post now / schedule** (or post from the
composer, which also takes videos), the browser uploads it to the office server in 4 MB pieces
(this works through the Vercel forwarding; offsets, size and the file's real MP4/MOV signature are
checked), the server writes it to a temporary file and sends it to the Page with Facebook's
resumable video upload (start, the parts Facebook asks for, finish with the description and,
for scheduling, published=false + scheduled_publish_time), then deletes the file. The button shows
the upload and Facebook progress; keep the tab open until it says posted. One upload posts at
most once; if Facebook refuses it, *try again* reuses the upload (a timeout is not retried, as the
post may have gone through). Unused uploads are deleted after 2 hours. Scheduled videos appear
under **Pending posts** (tagged *video*) and can be cancelled there; a video is only deleted if it
belongs to this Page. Browsers cannot open some phone formats (for example HEVC on Windows): the
office then asks you to export the video as MP4 (H.264). The Page token needs the same
permissions as for photos (`pages_manage_posts`). Test Gemini with drawn sample frames:
`npx tsx scripts/video-smoke.ts` in `backend/` (1 Gemini request).

Carlo drafts, a person approves. Nothing is posted until someone with the `social:post`
permission (role `admin`, or the new role `marketing`) clicks **Post** or **Schedule**.

- **From a caption task:** after Carlo answers, click **Post to Facebook…**. The caption and
  hashtags (not his "What I see" notes) and the photo are filled in; edit them, choose **Post
  now** or **Schedule** (date and time in Asia/Manila, 15 minutes to 29 days ahead), tick "I
  checked the text and photo", then click the button.
- **From Carlo's panel:** **New post** to write one yourself, and **Pending posts**: the Page's
  scheduled posts (read from Facebook, so posts scheduled in Meta Business Suite appear too),
  with **Cancel post**.
- Scheduling uses Facebook's own scheduler, so a post goes out on time even if this server is
  asleep or restarted. Photo posts are scheduled as Meta documents: the photo is uploaded as
  unpublished and temporary, then attached to a scheduled feed post.
- Safety: the token stays on the server (sent in a header, never in a URL or log); each approval
  has a one-time key, so a double click or a resend posts only once; a POST is never retried (a
  timeout tells you to check the Page first); at most 10 posts per user per hour; only this
  Page's posts can be cancelled. The task log records who posted, when, the post ID and the text
  length.

**Setup (once):**
1. You must be an admin of the Facebook **Page** (posting to personal profiles isn't possible).
2. At developers.facebook.com create an app (type Business) and add Facebook Login for Business.
3. In the Graph API Explorer, pick the app, grant `pages_show_list`, `pages_read_engagement` and
   `pages_manage_posts`, then choose your Page to get a **Page access token**. Exchange it for a
   long-lived one (Access Token Debugger → Extend).
4. In `backend/.env` (or Render's environment): `FACEBOOK_PAGE_ID` (the Page's numeric ID),
   `FACEBOOK_PAGE_TOKEN`, and optionally `FACEBOOK_APP_SECRET`. Restart the server: the log shows
   "Facebook posting: ready".

Meta's screens and permission names change from time to time; if a step looks different, follow
Meta's current Pages API documentation.

## Catalog (Kat)

Kat (Catalog Manager, Content Studio) adds new products to the online catalog
(wadfurniture-catalog.vercel.app, from the GitHub repository `Reinel2004/WAD-CATALOG`).

1. Pick **Kat**, click **Photo**, choose the product photo and optionally add details
   (*"main door, 90 x 210cm, narra"*), then **Assign**. The browser shrinks the photo first
   (longest side 1600 px, under 1 MB), which also removes hidden camera data such as GPS.
2. Kat looks at the photo and drafts the entry in the catalog's style: category (Doors,
   Cabinets, Dining Tables, Bed Frames), door type for doors (Main Door, Ordinary, Double Door,
   Flush Door), name, material, dimensions, finishes and description. She never guesses a size or
   wood from the photo; if she can't tell the category, the task goes to **Needs information**.
3. In the task, an **Add to the catalog** form is filled in from her answer. Check and edit every
   field, then click **Add to catalog**.
4. The server checks every field again, then makes **one commit** in the catalog repository with
   the photo (`WAD-CATALOG/assets/<category folder>/wad-<id>.jpg`) and the new entry at the end of
   `products.js` (the next free id, written like the other products). Vercel rebuilds the site
   from that commit, so the product is live in about a minute. The task links to the catalog and
   to the commit on GitHub.

**Several products at once.** In step 1, select up to 10 photos together (one product per
photo). The browser makes two copies of each: a catalog copy (under 1 MB, kept in the tab) and a
smaller copy (1024 px, under 300 KB) that is the only one sent to Gemini. Kat writes one numbered
entry per photo ("**Catalog entry 2**" belongs to photo 2) and skips a photo she cannot use with a
reason (for example a blurry photo, or the same product twice). The task shows one card per photo:
untick any you don't want, edit the rest, and click **Add N products to catalog**. Each photo is
then uploaded on its own (small requests, fine behind the Vercel forwarding) and all products go
into **one commit** with consecutive ids, so the site rebuilds once. Uploaded photos wait on the
server for at most 2 hours; at most 30 products per user per hour.

Safety: only accounts with `catalog:write` (roles `admin` and `marketing`) can add products. The
token stays on the server and goes only to api.github.com. The office only **adds** products: it
never edits or removes existing ones, and the branch is never force-pushed (if someone changed the
catalog at the same moment, it starts again once on top of their change). Text fields are plain
text (characters that could break the page, such as `<`, `>`, `"` and backslashes, are removed).
`products.js` is edited as text, never run, and refused if it no longer looks like
`const products = [ … ];`. Each approval adds its products at most once,
and the task log records who added which products and the commit. The photo stays in the browser
tab that chose it and is gone after a reload. To remove or change a product later, edit
`products.js` in the repository (the catalog site has no editor).

**Setup (once):**
1. On GitHub, signed in as the repository owner (or someone with write access), go to
   Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate.
   Resource owner: the account that owns the repository. Repository access: **Only select
   repositories** → `WAD-CATALOG`. Permissions → Repository permissions → **Contents: Read and
   write** (Metadata: read-only is added automatically). Choose an expiry and copy the token.
2. In `backend/.env` (and Render's environment): `CATALOG_GITHUB_TOKEN=<the token>`. Optional:
   `CATALOG_GITHUB_REPO` (default `Reinel2004/WAD-CATALOG`), `CATALOG_GITHUB_BRANCH` (default
   `main`), `CATALOG_GITHUB_FOLDER` (the folder in the repository that holds `products.js`,
   `index.html` and `assets/`; default `WAD-CATALOG`, because WAD's repository keeps the site in
   that folder; set it empty if the files are at the top level), `CATALOG_SITE_URL` (default
   `https://wadfurniture-catalog.vercel.app`).
3. Check the settings without changing anything: `npx tsx scripts/catalog-check.ts` in
   `backend/` prints how many products the catalog has (or what is wrong).
   Restart the server: the log shows "Catalog (Kat): ready". Kat's panel shows the number of
   products on the site.
4. Make sure the catalog's Vercel project deploys automatically from `main` (Vercel → the catalog
   project → Settings → Git). Without that, the commit is saved but the site does not update.

Test Kat's drafting with a drawn sample photo: `npx tsx scripts/kat-smoke.ts` in `backend/`
(add `--batch` for two photos; 1 Gemini request; nothing is sent to GitHub).

## Demo Mode features (unchanged)

New Door Inquiry with Approve/Reject, Production Review, Marketing Draft, custom template tasks,
character and room panels, zoom/pan/reset, pause, sound toggle, activity feed, reduced motion,
and Reset demo. See the in-app labels; all of it uses mock data only.

**Intelligence Lab shows the AI at work:** the hologram and server racks react to Gemini tasks.
Blue, fast rings and rising data with "AI thinking · Rosa" while a task runs; a green check with
"Answer ready" when it finishes; an amber pause sign with "AI usage limit reached" for 30 seconds
when the free quota runs out; a red flicker when a request fails. In Demo Mode it lights up while
a template draft is prepared (labelled "template"; no AI is used there).

**Workshop (shop floor):** the room at the front right, next to the court and below Finance, has
four benches (saw table, planer, workbench, sanding & varnish table), a lumber rack and a rack of
finished doors. Its pixel carpenters are the **real carpenters** from WAD Order Management: one
per name in the carpenter list (`workers`, role carpenter), in that order, plus anyone assigned on
an order but missing from the list. Each keeps their own place at a bench (eight places; with more
carpenters, the busiest eight stand at the benches and the room panel lists everyone). Their name
tag shows how many open orders they have, counting both `carpenter` and `hamba_carpenter`. With
orders In Progress they work at their bench; with only Pending orders they prepare wood; with none
they sweep. The rack shows one door per Finished order waiting for delivery. They are animation
only, not AI. The data comes from `GET /api/orders/workshop` (names and counts only: no customers,
prices or labor; `orders:read`), read at sign-in, after Paolo's tasks or order reports (at most once
a minute), with **Refresh** in the Workshop's room panel, and by the live updates below. Demo Mode shows
"Carpenter 1–4" sample people. During his tasks Paolo walks to the shop floor, looks around, then
returns to his desk. (Production stages are not used here: that feature is not live yet.)

**Creative Studio:** when Carlo gets a photo task (Connected Mode), he walks to the left easel
and the photo appears on its canvas, slanted to match it, while he studies it. The photo is
drawn from your browser's copy only and leaves the easel 15 seconds after the task. On the back
wall, a posts board shows one pinned card per scheduled Facebook post (up to 6) and a label such
as "2 posts scheduled · next Nov 10, 9:00 AM". It reads the schedule at sign-in, after you post or
cancel, and by the live updates below; it shows only for accounts that can post.

**Live updates (no reload needed):** task results already arrive instantly over the office's live
connection. On top of that, while at least one office is open the server re-checks the order
system (Workshop carpenters and counts) and the Facebook Page's scheduled posts every 2 minutes,
and pushes only what changed to every open office whose account may see it. It is one shared
check per source, not one per browser; checks never overlap; a source that fails waits longer
each time (up to 15 minutes); and it stops when the last office closes. A post or cancel made in
the office triggers a quick re-check so other open offices see it within seconds. Set
`LIVE_REFRESH_SECONDS` (60 to 3600, default 120) in `backend/.env` to change the pace, or `0` to
switch it off. Joy's order picker and the AI tasks still read data only when you ask.

**Breaks when idle** (both modes): a worker with nothing to do for 20 to 60 seconds goes on a
10 to 20 second break: treadmill, weights or stretching in the Gym, hoops or volleyball on the
Court, making coffee at the coffee station (it steams while someone brews), a snack or the lounge
in the Pantry, or a short walk around the office. Some breaks are **chats**: two free workers meet
at the coffee station, the pantry table, the water cooler, the court or the Sales sofa and trade a
short conversation in speech bubbles. If one is called away, the other says "Talk later!" and
goes back too. At most 4 are away at once. A new task (demo or live) brings them straight back. Switch it off under
Settings → "Breaks when idle"; it's also off when Reduced motion is on. Breaks are decoration
only and never change a task's status.

## Not implemented yet

- Job history survives only while the server runs (in memory); the task log file persists.
- Write access of any kind — intentionally excluded.
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
| Paolo, Lia, Nina | Orders by date, open/overdue orders (`orders:read`) |
| Dev (Data Quality Checker) | Data checks calculated by code (`orders:read`; downpayment check only with `finance:read`); orders by date, open orders |
| Sam (Systems Monitor), Ivy (Security Officer) | The server's own measurements: system health, and sign-in and security events (`system:read`, admin only) |
| Bea | Finance records and totals (`finance:read`); order balances (needs both permissions) |
| Rosa (Collections Officer) | Balances and downpayments on open orders (needs both permissions); open orders |
| Joy (Customer Service) | Only the one order you pick for the reply (`orders:read`; balance only with `finance:read`) |
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
