# AI Sourcing Agent

A procurement assistant. You describe what you need to buy (commodity, quantity, location, target price). The app then:
- finds suppliers on the web with AI
- emails each one a request for quotation (RFQ)
- reads their replies and negotiates within your limits
- recommends the best deal

**Nothing binding is sent until a person approves.**

**Stack:** React (Vite, Tailwind, TanStack Query) · Node.js + Express · PostgreSQL · pg-boss (job queue on Postgres) · Gemini + Tavily (AI and web search) · SMTP / IMAP (email)

## How it works

| Step | What happens |
|---|---|
| 1. Request | You fill in the New request form |
| 2. Find suppliers | Tavily searches the web; Gemini picks real suppliers with contact details |
| 3. Send proposals | You choose suppliers; each gets one RFQ email |
| 4. Replies | Supplier replies are read from the inbox (IMAP), every 15 s |
| 5. Read quotes | Price, delivery, payment terms and validity are extracted |
| 6. Negotiate | Rule-based counter-offers, limited by max rounds and your maximum price |
| 7. Approve | Best offer is recommended → **you approve** → acceptance and regret emails go out |

## Architecture

```
React ──REST──► Express ──► PostgreSQL ◄── pg-boss jobs (same database)
                                              │
   discover-suppliers ─► deliver-message ─► (supplier replies) ─► process-reply ─┐
                              ▲                                                 │
                              └──────────── counter-offer (outbox) ◄────────────┘
                                   reply-timeout closes silent suppliers
```

- **Client (`client/`):** React app, with pages for Requests, Suppliers, Quotes, Negotiations, Approvals and Settings.
- **API (`server/`):** Express REST API. On startup it applies database migrations and starts the job worker.
- **Database:** PostgreSQL stores requests, suppliers, messages and offers. The job queue (pg-boss) lives in the same database, so no Redis is needed.
- **Jobs:** each step runs as a background job (discover, deliver, process reply, timeout), so it can be retried safely.
- **AI:** Tavily finds web pages and Gemini reads them to pick suppliers. Gemini also helps read supplier replies, with text rules as a fallback.
- **Email:** sent over SMTP (Gmail App Password), and replies are read over IMAP from the same mailbox.

**Key design rules**
- **Code decides prices, never the AI.** Counter-offers come from a pure function (`server/src/services/negotiation.js`).
- **Your target and maximum prices are never written in any email.**
- **Every email goes through an outbox** with an idempotency key, so retries and double clicks never send twice.
- **One function decides the request status** (`syncRequestStatus`), under a row lock, so parallel jobs can't conflict.
- **A person must approve** before any acceptance email is created.

## Run locally

**Requirements:** Node 20+ and PostgreSQL 13+.

```bash
npm run install:all                    # installs root, server and client
cp server/.env.example server/.env     # then edit server/.env (see below)
npm run dev                            # API on :4000 + web app on http://localhost:5173
```

`npm run dev` starts both the API and the web app, and the database tables are created automatically on first start. If the web app shows "Cannot reach the API server", check the terminal for the server's error.

**Choose a profile in `server/.env`:**

Mock (no API keys; nothing is emailed; simulated suppliers reply):
```env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/sourcing
AI_MODE=mock
EMAIL_TRANSPORT=simulated
SIMULATE_SUPPLIERS=true
INBOUND_PROVIDER=none
```

Live (real AI search and real email):
```env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/sourcing
AI_MODE=live
GEMINI_API_KEY=...            # https://aistudio.google.com/apikey
TAVILY_API_KEY=...            # https://app.tavily.com
EMAIL_TRANSPORT=smtp
SMTP_HOST=smtp.gmail.com
SMTP_USER=you@gmail.com
SMTP_PASS=...                 # 16-character Gmail App Password
EMAIL_FROM=Sourcing Desk <you@gmail.com>
EMAIL_REPLY_TO=you@gmail.com
EMAIL_ALLOWED_RECIPIENTS=supplier1@example.com,supplier2@example.com
INBOUND_PROVIDER=imap
SIMULATE_SUPPLIERS=false
REPLY_TIMEOUT_SECONDS=14400
```

Real email only goes to addresses in `EMAIL_ALLOWED_RECIPIENTS` (more can be allowed from the UI). All emails are sent from `EMAIL_FROM`; the Email field on the form doesn't change the sender. Restart `npm run dev` after editing `.env`.

**Tests**

```bash
npm test --prefix server     # uses a separate <db>_test database; never sends email or calls the AI
```

## Deployment

| Part | Host | Settings |
|---|---|---|
| Database | Neon | Use the **direct** connection string (without `-pooler`) |
| API | Render web service | Root `server`, build `npm ci`, start `npm start`, health check `/api/health` |
| Web app | Vercel | Root `client`, framework Vite; `client/vercel.json` forwards `/api/*` to the Render API |

On Render, set the live variables from the profile above, plus:
- `NODE_ENV=production`: the server then refuses mock AI, simulated email or suppliers, and a missing password.
- `APP_PASSWORD`: the shared password the web app asks for. `/api/health` and webhooks stay open.

The database tables are created on the first start.

## Project layout

```
server/src/
  index.js / app.js            boot (migrations, queue, worker) / Express app
  db/                          pool, migration runner, SQL migrations
  routes/                      requests, webhooks, email allowlist, insights
  services/                    discovery + AI, web search, email (mailer, inbound), proposals, reply parser, negotiation
  workflow/                    state machine, status/recommendation, send proposals, approval, queue + jobs
client/src/
  pages/                       RequestList, NewRequest, RequestDetail, Suppliers, Quotes, Negotiations, Approvals, Settings
  components/                  SupplierTable, SupplierPanel, Conversation, QuoteComparison, ApprovalPanel, Timeline, …
```

