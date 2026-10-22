# AI Sourcing Agent

An automation workflow that takes a commodity request (commodity, location, quantity, target price), finds relevant suppliers with AI, sends them requests for quotation, reads their replies, negotiates within strict limits and recommends the best deal. **A person must approve before anything binding is sent.**

**Stack:** React (Vite, Tailwind, TanStack Query, React Hook Form) · Node.js + Express · PostgreSQL · pg-boss (job queue on Postgres) · Gemini or Claude API (optional)

## Workflow

| Step | What happens |
|---|---|
| 1. Request | Form → `POST /api/requests` → request saved, workflow starts |
| 2. Find suppliers | Gemini (Google Search grounding) or Claude + web search (or mock mode) → validated, de-duplicated, ranked suppliers |
| 3. Send proposals | User picks suppliers → one RFQ email each, through an outbox with retry-safe delivery |
| 4. Supplier replies | Replies arrive via `POST /api/webhooks/email` or the built-in supplier simulator |
| 5. Read quotes | Price, delivery, payment terms, validity extracted (rules, or the AI in live mode) |
| 6. Negotiate | Rule-based counter-offers, capped by max rounds and the buyer's maximum price |
| 7. Recommend & approve | Final offers scored → recommendation → **human approves** → acceptance + regret emails |

Everything runs **without an API key**: `AI_MODE=mock` generates demo suppliers, emails use a simulated transport (nothing is ever sent), and simulated suppliers answer proposals and counter-offers with consistent, realistic behaviour.

## Architecture

```
React ──REST──► Express ──► PostgreSQL ◄── pg-boss jobs (same database)
                                              │
   discover-suppliers ─► deliver-message ─► simulate-supplier-reply ─► process-reply ─┐
                              ▲                                                       │
                              └────────────── counter-offer (outbox) ◄────────────────┘
                                   reply-timeout closes silent suppliers
```

**Request statuses** (`server/src/workflow/stateMachine.js`, only listed transitions are allowed):

`DRAFT → DISCOVERING → SUPPLIERS_FOUND → SENDING_PROPOSALS → AWAITING_REPLIES → NEGOTIATING → DEAL_RECOMMENDED → CLOSED`
plus `NO_DEAL` (no offer within the maximum), `CANCELLED` (all offers rejected) and `FAILED` (retryable).

**Supplier (thread) statuses:** `PENDING → QUEUED → CONTACTED ⇄ COUNTERED →` `FINAL_OFFER` / `DECLINED` / `NO_RESPONSE` / `WALKED_AWAY` / `SEND_FAILED` / `NEEDS_REVIEW`, then `WON` / `LOST` after approval.

### Design decisions

- **Outbox for every email.** RFQs, counter-offers, acceptances and regrets are first written to `messages` as `PENDING`, each with a unique idempotency key (`rfq:<thread>`, `counter:<thread>:<round>`, `acceptance:<request>`). A `deliver-message` job locks the row and sends only if it is still `PENDING`. Double clicks, retries and duplicate jobs therefore never send twice. The key is also passed to the transport, so a real provider can dedupe the rare crash-after-send case.
- **Simulated transport only.** `server/src/services/mailer.js` records emails but never sends them, and the server refuses to start with any other `EMAIL_TRANSPORT`. A real provider (SMTP, Resend) would plug in at that same interface.
- **One place decides the request status.** `syncRequestStatus()` (`server/src/workflow/progress.js`) runs at the end of every transaction that changes a supplier thread, under a row lock on the request. It moves the request forward from the thread states, so concurrent per-supplier jobs cannot race each other.
- **Code decides prices, never the LLM.** `decideNextMove()` (`server/src/services/negotiation.js`) is a pure function:
  - The first counter anchors at 97% of target. Later counters concede up to 60% of the remaining gap by the last round.
  - A counter is never above the buyer's maximum, and never above a lower competing quote. When a competitor really is lower, the email says so, without giving numbers.
  - An offer at or below target is accepted, pending approval. At the round limit the latest offer becomes final if it is within the maximum; otherwise the agent walks away.
- **The buyer's limits stay private.** The target and maximum prices never appear in any outbound email; tests check this.
- **Human approval gate.** Acceptance emails are created only by `POST /requests/:id/approve`. The idempotency key is per request, so at most one supplier can ever be accepted. The acceptance states that the order becomes binding only when a formal purchase order is issued.
- **Simulated replies go through the real inbound path.** The simulator posts its replies through `ingestInboundEmail()`, the same code the webhook uses. Replies are matched by the `RFQ-XXXXXXXX-NN` reference, and each supplier persona is deterministic per thread.
- **Recovery.** On startup the worker applies pending migrations and re-queues unfinished work: discovery, pending deliveries, unprocessed replies, and suppliers still awaiting a reply. Jobs that keep crashing put the affected thread in `NEEDS_REVIEW` instead of hanging.
- **Recommendation scoring.** Final offers within the maximum are scored 70% price, 20% delivery time and 10% payment terms. The approver can still choose any eligible offer.

## Setup

Requirements: Node 20+, PostgreSQL 13+.

```bash
npm run install:all
cp server/.env.example server/.env   # set DATABASE_URL
npm run dev                          # API :4000 (applies migrations on start) + web app http://localhost:5173
```

`npm run dev` starts **both** the API and the web app. The web app alone shows "Cannot reach the API server".

### Tests

```bash
npm test --prefix server   # 61 tests: unit + integration against a separate <db>_test database
```

Integration tests use a real Postgres test database (created automatically) and an in-memory job queue, so they can run every step, retry or duplicate deterministically.

### Environment variables (`server/.env`)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection string |
| `AI_MODE` | `live` if the provider's key is set, else `mock` | `mock` needs no API key |
| `AI_PROVIDER` | `gemini` if `GEMINI_API_KEY` is set, else `anthropic` | Which AI runs live mode |
| `GEMINI_API_KEY` | — | Gemini key from [Google AI Studio](https://aistudio.google.com/apikey); enables live supplier search (Google Search grounding) and AI reply parsing |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model for live mode |
| `ANTHROPIC_API_KEY` | — | Alternative: Claude for live mode (`AI_PROVIDER=anthropic`) |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Claude model for live mode |
| `MAX_SUPPLIERS` / `MAX_WEB_SEARCHES` | `5` / `6` | Discovery limits |
| `EMAIL_TRANSPORT` | `simulated` | Only `simulated` is implemented |
| `SIMULATE_SUPPLIERS` | `true` | Simulated suppliers reply to proposals and counters |
| `SIM_REPLY_DELAY_SECONDS` | `3-8` | Simulated reply delay (range or fixed number) |
| `REPLY_TIMEOUT_SECONDS` | `45` | How long to wait for a reply each round |
| `INBOUND_WEBHOOK_SECRET` | — | If set, required as `X-Webhook-Secret` on the inbound webhook |
| `RUN_WORKER` | `true` | `false` runs the API without the job worker |

## Real email testing (optional)

Simulated email stays the default for the demo and all automated tests. Real delivery happens only with `EMAIL_TRANSPORT=smtp`, and then only to addresses listed in `EMAIL_ALLOWED_RECIPIENTS`. Recipients are never rewritten or redirected. Anything not on the list is refused when you select it (400), and also blocked at delivery time, where it fails immediately without retries.

**Where replies go.** A supplier's reply goes to our `EMAIL_REPLY_TO` mailbox, not to the supplier's own inbox. With `INBOUND_PROVIDER=imap`, the server reads that inbox over **IMAP**, signing in with the **same account as SMTP** (`SMTP_USER` / `SMTP_PASS`). For Gmail this is the App Password you already use for sending, so no extra credentials or Google Cloud setup are needed. It polls every `INBOUND_POLL_SECONDS` and hands each new email to the same reply pipeline the webhook uses. Other providers can still post to `POST /api/webhooks/email`.

Most temp-mail inboxes **cannot send**, so a "supplier" on Temp Mail can read our RFQ but must reply from a mailbox that can send (for example a second Gmail).

**Gmail setup (one time)**
1. Turn on **2-Step Verification** for the Google account, then create an **App Password** (Google Account → Security → 2-Step Verification → App passwords).
2. In `server/.env`, set `EMAIL_TRANSPORT=smtp`, `SMTP_USER` (your Gmail address), `SMTP_PASS` (the 16-character App Password), `EMAIL_FROM`, and `EMAIL_REPLY_TO` (the same Gmail address). List your Temp Mail supplier addresses in `EMAIL_ALLOWED_RECIPIENTS`. See `server/.env.example`.
3. Set `INBOUND_PROVIDER=imap`. The defaults (`imap.gmail.com:993`, TLS, `INBOX`) suit Gmail. For another provider, set `IMAP_HOST` / `IMAP_PORT`. Gmail's IMAP access is on by default; if logins fail, check it under Gmail → Settings → Forwarding and POP/IMAP.

**Test run**
1. Raise `REPLY_TIMEOUT_SECONDS` (e.g. `14400`) because people reply slowly, then restart `npm run dev`. `GET /api/health` shows the transport, the allowlist size and the inbound provider (`imap`).
2. On a request in "Suppliers found", use **Add a supplier** to add each Temp Mail address, then send proposals.
3. Reply from a sending mailbox to the Gmail address, keeping `RFQ-XXXXXXXX-NN` in the subject. The poller picks it up within `INBOUND_POLL_SECONDS` and the negotiation continues; counter-offers go to the Temp Mail inbox.

**How the IMAP poller behaves**
- **Which mail it reads:** each poll opens one connection, searches `IMAP_MAILBOX` for mail from the last `INBOUND_SINCE_DAYS` days that was not sent by `SMTP_USER`, reads each new message's text (or HTML) part, and logs out.
- **What it handles once:** handled messages are stored in `inbound_cursor` (keyed by the mailbox's UIDVALIDITY and the message UID), so each email is processed once. Messages are not marked read or moved. Mail without an RFQ reference from an unknown sender is skipped and logged.
- **Reply text:** only the reply itself is read. Quoted history (`On … wrote:` and `>` lines) is stripped, so prices in our own quoted counter-offer are never taken as the supplier's.
- **Failed logins:** a failed login logs how to fix it (check `SMTP_USER` / `SMTP_PASS` and IMAP access), then pauses polling for 5 minutes so repeated attempts don't lock the account.

**Duplicates.** Every inbound email is stored once, whether it arrives via the webhook, the IMAP poller or a repeated post. The dedupe key is its Message-ID, or a hash of sender, subject and body. A reply received before our latest counter-offer is ignored as stale, so it can never start an extra negotiation round.

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/requests` | Create a request and start supplier discovery |
| `GET` | `/api/requests` | List requests |
| `GET` | `/api/requests/:id` | Request with suppliers, messages, offers, recommendation, timeline |
| `POST` | `/api/requests/:id/rediscover` | Re-run supplier discovery |
| `POST` | `/api/requests/:id/suppliers` | `{ name, email, website? }`: add a supplier by hand (before sending) |
| `POST` | `/api/requests/:id/send-proposals` | `{ requestSupplierIds? }`: send RFQs (or retry a failed send) |
| `POST` | `/api/requests/:id/approve` | `{ requestSupplierId, approvedBy }`: approve one final offer |
| `POST` | `/api/requests/:id/reject` | `{ rejectedBy, reason? }`: reject all offers |
| `POST` | `/api/webhooks/email` | `{ from, subject, text, messageId? }`: inbound supplier email |
| `GET` | `/api/health` | Health check, shows AI mode and email transport |

Try a "real" supplier reply by hand (simulation off, using the RFQ ref shown in the UI):

```bash
curl -X POST localhost:4000/api/webhooks/email -H "Content-Type: application/json" \
  -d '{"from":"sales@supplier.example.com","subject":"Re: RFQ-46CB27EC-01","text":"Price: USD 845.00 per tonne\nDelivery: within 12 days\nPayment terms: Net 30"}'
```

## Project layout

```
server/src/
  index.js / app.js            boot (migrations, queue, worker) / Express app
  db/                          pool, migration runner, SQL migrations (idempotent)
  routes/                      requests (incl. send, approve, reject), webhooks
  services/
    discovery.js, ai.js        supplier search (Gemini or Claude with web search, or mock)
    proposals.js               RFQ, counter, acceptance and regret templates
    mailer.js                  simulated email transport
    inbound.js                 matches replies to suppliers by RFQ reference
    replyParser.js             quote extraction (rules; Gemini or Claude in live mode)
    negotiation.js             counter-offer rules and offer scoring (pure)
    simulation/                simulated supplier personas and reply texts
  workflow/
    stateMachine.js            statuses, transitions, event log
    progress.js                derives request status, builds the recommendation
    sendProposals.js           Step 3 selection + outbox
    approval.js                Step 7 approve / reject
    queue.js, worker.js        pg-boss setup, job handlers, recovery
    jobs/                      discover, deliver, simulate reply, process reply, reply timeout
client/src/
  pages/                       NewRequest, RequestList, RequestDetail
  components/                  SupplierTable, QuoteComparison, ApprovalPanel, WorkflowStepper, Timeline, StatusBadge
```
