# AI Sourcing Agent

An automation workflow that takes a commodity request (commodity, location, quantity, target price), finds relevant suppliers with AI, sends them requests for quotation, reads their replies, negotiates within strict limits and recommends the best deal. **A person must approve before anything binding is sent.**

**Stack:** React (Vite, Tailwind, TanStack Query, React Hook Form) · Node.js + Express · PostgreSQL · pg-boss (job queue on Postgres) · Gemini or Claude API (optional)

## Demo

The full interviewer walkthrough (talking points, feature tour, optional live segment, likely questions) is in **[docs/DEMO.md](docs/DEMO.md)**.

Quick start in mock mode (no API keys, nothing is emailed): in `server/.env` set `AI_MODE=mock`, `EMAIL_TRANSPORT=simulated`, `SIMULATE_SUPPLIERS=true`, `INBOUND_PROVIDER=none`, then:

```bash
npm run install:all
npm run dev            # http://localhost:5173 → New request
```

Three datasets that end in a recommended deal (buyer name `Procurement Team`, email blank):

| # | Commodity | Specifications | Qty | Location | Currency | Target | Max | Rounds | Needed by |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1121 Basmati Rice | Extra-long grain, aged 12 months, 25 kg bags, moisture ≤ 12% | 20 tonnes | Dubai, UAE | USD | 850 | 1000 | 3 | 2026-12-15 |
| 2 | Refined Sunflower Oil | Food-grade, FSSAI compliant, sealed 15-litre containers | 5000 kg | Hyderabad, Telangana, India | INR | 140 | 165 | 3 | 2026-11-30 |
| 3 | Portland Cement OPC 53 Grade | BIS IS 12269 certified, fresh production, 50 kg bags | 200 tonnes | Nellore, Andhra Pradesh, India | INR | 6500 | 7800 | 2 | 2026-11-30 |

## Workflow

| Step | What happens |
|---|---|
| 1. Request | Form → `POST /api/requests` → request saved, workflow starts |
| 2. Find suppliers | Tavily web search + Gemini (or Claude with web search, or mock mode) → validated, de-duplicated, ranked suppliers |
| 3. Send proposals | User picks suppliers → one RFQ email each, through an outbox with retry-safe delivery |
| 4. Supplier replies | Replies arrive via the IMAP inbox poller, `POST /api/webhooks/email`, or the built-in supplier simulator |
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
- **Simulated by default, real email opt-in.** `server/src/services/mailer.js` records emails without sending unless `EMAIL_TRANSPORT=smtp`. Real email only goes to allow-listed recipients (see *Real email testing*).
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
npm test --prefix server   # unit + integration tests against a separate <db>_test database (never real email or search)
```

Integration tests use a real Postgres test database (created automatically) and an in-memory job queue, so they can run every step, retry or duplicate deterministically.

### Environment variables (`server/.env`)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection string |
| `AI_MODE` | `live` if the provider's key is set, else `mock` | `mock` needs no API key |
| `AI_PROVIDER` | `gemini` if `GEMINI_API_KEY` is set, else `anthropic` | Which AI runs live mode |
| `GEMINI_API_KEY` | — | Gemini key from [Google AI Studio](https://aistudio.google.com/apikey); enables live supplier search and AI reply parsing |
| `GEMINI_MODEL` | `gemini-3.5-flash` | Gemini model for live mode |
| `SEARCH_PROVIDER` | `tavily` if `TAVILY_API_KEY` is set, else `none` | How Gemini finds suppliers online: `tavily` (free web search, Gemini reads the results), `gemini` (Google Search grounding, needs billing) or `none` (AI knowledge only, marked "not web-verified") |
| `TAVILY_API_KEY` | — | Free key from [Tavily](https://app.tavily.com) for live supplier search |
| `ANTHROPIC_API_KEY` | — | Alternative: Claude for live mode (`AI_PROVIDER=anthropic`) |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Claude model for live mode |
| `MAX_SUPPLIERS` / `MAX_WEB_SEARCHES` | `5` / `6` | Discovery limits |
| `EMAIL_TRANSPORT` | `simulated` | `simulated` (nothing sent) or `smtp` (real email, allow-listed recipients only) |
| `SIMULATE_SUPPLIERS` | `true` | Simulated suppliers reply to proposals and counters |
| `SIM_REPLY_DELAY_SECONDS` | `3-8` | Simulated reply delay (range or fixed number) |
| `REPLY_TIMEOUT_SECONDS` | `45` | How long to wait for a reply each round |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | — | SMTP server and login for real email (Gmail: your address and an App Password) |
| `EMAIL_FROM` / `EMAIL_REPLY_TO` | — | Sender, and the mailbox supplier replies go to (also used in email signatures) |
| `EMAIL_ALLOWED_RECIPIENTS` | — | Addresses (or `@domain`) that may receive real email; more can be approved in the UI |
| `INBOUND_PROVIDER` | `none` | `imap` reads supplier replies from the Reply-To inbox; `none` uses the webhook / simulator only |
| `INBOUND_POLL_SECONDS` | `15` | How often the IMAP inbox is checked |
| `INBOUND_WEBHOOK_SECRET` | — | If set, required as `X-Webhook-Secret` on the inbound webhook |
| `RUN_WORKER` | `true` | `false` runs the API without the job worker |

## Using the app

| Page | What it shows |
|---|---|
| **Requests** | All requests with KPI cards, status tabs, search and sort |
| **Request details** | Workflow stepper, approval panel, quote comparison, suppliers, activity. **View details** on a supplier opens a side panel with the latest quote, offer history, negotiation status, recovery tools and the email conversation |
| **Suppliers** | Every supplier across requests, with how often each was contacted, quoted and won |
| **Quotes** | Every price received, compared with the target; buyer-entered prices are marked **Manual** |
| **Negotiations** | Open supplier conversations (waiting, countered, final, closed) |
| **Approvals** | Requests waiting for a decision, and recently approved deals |
| **Settings** | Read-only AI, search and email configuration (from `server/.env`), plus the email allowlist |

Every action shows a toast with its result; form fields still show their own errors.

**Recovery tools** (supplier side panel, real email):
- **Re-check replies:** re-reads the newest priced reply of a supplier that needs review.
- **Enter quote manually:** types in a price the parser missed. It is treated like a reply, but stored and shown as **Manual entry · not confirmed by the supplier**, in the panel, Quotes page, comparison and approval panel.
- **Mark as no response:** closes a supplier that will never reply, so the request can be recommended.
- **Apply latest quote:** if a supplier sends a **lower** price after their offer was marked final (and nothing is approved yet), it becomes their offer and the recommendation is re-ranked. No email is sent. New replies are applied automatically; the button is for replies that arrived earlier.

Prices a supplier wrote that never became an offer (for example, sent while the supplier was under review) are listed in the offer history as *not used in negotiation*.

**Gmail limitation.** The app only tracks emails it sends itself and replies that arrive in the inbox. Emails you send from Gmail directly (for example a manual "We accept") are not recorded, so the request keeps waiting. Make buyer decisions (approve, reject) in the app.

**Email signature.** With real email, RFQs and acceptances are signed with the buyer name and the mailbox replies actually reach (`EMAIL_REPLY_TO`, else `EMAIL_FROM`), so suppliers never see a placeholder such as `procurement@example.com`. Rupee amounts use Indian grouping (₹6,85,000.00), as in the UI.

**Search credits (Tavily).** One discovery runs up to 8 basic Tavily searches (1 credit each): 3 supplier searches plus up to 5 "<name> contact email" lookups for suppliers found without an email. Results are saved on the request (`discovery_cache`), so an automatic retry after an AI failure reuses them instead of searching again. **Retry search / Rediscover** clears them and searches fresh. Tests never call Tavily.

**When Gemini is overloaded.** Google answers HTTP 503 ("high demand") or 500/502/504 when a model is busy. Each Gemini call retries these itself (after 2 s and 6 s, or the server's `Retry-After`). If the model is still busy, the request fails with a message saying it is a Google-side capacity issue, not your key or model, and you can use **Retry search** later. A Gemini failure never silently swaps in unverified suppliers; only a search outage falls back to AI knowledge, clearly marked "not web-verified". Quota errors (429) and a wrong key or model (400/401/403/404) are reported as such.

**Mock mode.** `AI_MODE=mock` (or no AI key) still generates demo suppliers on reserved `example.com` addresses, and `SIMULATE_SUPPLIERS=true` lets simulated suppliers reply. Nothing in mock mode can reach a real inbox.

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
| `POST` | `/api/requests/:id/suppliers` | `{ name, email, website? }`: add a supplier by hand (also while collecting quotes) |
| `PATCH` | `/api/requests/:id/suppliers/:threadId` | `{ email }`: email to use for this supplier on this request |
| `POST` | `/api/requests/:id/suppliers/:threadId/recheck` | Re-read replies (needs review), or apply a newer lower quote after a final offer |
| `POST` | `/api/requests/:id/suppliers/:threadId/quote` | `{ unit_price, delivery_days?, payment_terms? }`: enter a quote manually |
| `POST` | `/api/requests/:id/suppliers/:threadId/close` | Mark a waiting supplier as no response |
| `POST` | `/api/requests/:id/send-proposals` | `{ requestSupplierIds? }`: send RFQs (or retry a failed send) |
| `POST` | `/api/requests/:id/approve` | `{ requestSupplierId, approvedBy }`: approve one final offer |
| `POST` | `/api/requests/:id/reject` | `{ rejectedBy, reason? }`: reject all offers |
| `POST` | `/api/webhooks/email` | `{ from, subject, text, messageId? }`: inbound supplier email |
| `GET` / `POST` / `DELETE` | `/api/email-allowlist` | Addresses approved for real email from the UI |
| `GET` | `/api/suppliers` · `/api/quotes` · `/api/negotiations` | Cross-request views for the Suppliers, Quotes and Negotiations pages (quotes include `source: supplier \| manual`) |
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
  routes/                      requests (incl. send, approve, reject, recovery), webhooks, email allowlist, insights
  services/
    discovery.js, ai.js        supplier search (Tavily + Gemini, Claude with web search, or mock)
    webSearch.js               Tavily client
    emailAllowlist.js          recipients approved from the UI
    inbound/                   IMAP client and reply-text helpers
    proposals.js               RFQ, counter, acceptance and regret templates
    mailer.js                  simulated or SMTP transport, recipient allowlist
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
  pages/                       RequestList, NewRequest, RequestDetail, Suppliers, Quotes, Negotiations, Approvals, Settings
  components/                  Sidebar, Topbar, SupplierTable, SupplierPanel, Conversation, QuoteComparison, ApprovalPanel,
                               AllowlistPanel, Timeline, Toaster, StatusBadge, WorkflowStepper
```
