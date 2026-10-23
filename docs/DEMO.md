# Demo script: AI Sourcing Desk

A 10–12 minute walkthrough for an interviewer. Part 3 is the core (mock mode, fully automatic and safe); Part 5 is an optional real-world segment with live AI search and real email.

---

## 0. Before the call (checklist)

**Mock profile** (recommended for the main demo: no API keys, no emails leave the machine). In `server/.env`:

```env
AI_MODE=mock
EMAIL_TRANSPORT=simulated
SIMULATE_SUPPLIERS=true
INBOUND_PROVIDER=none
SIM_REPLY_DELAY_SECONDS=3-8
REPLY_TIMEOUT_SECONDS=45
```

**Live profile** (only for Part 5): `AI_MODE=live`, `AI_PROVIDER=gemini`, `GEMINI_API_KEY`, `TAVILY_API_KEY`, `EMAIL_TRANSPORT=smtp` with the Gmail App Password, `INBOUND_PROVIDER=imap`, `SIMULATE_SUPPLIERS=false`, a large `REPLY_TIMEOUT_SECONDS` (e.g. `14400`) and your test supplier address allowed (Settings → allowed recipients, or `EMAIL_ALLOWED_RECIPIENTS`).

Then:
1. `npm run dev` (API on :4000 + web app on http://localhost:5173). Restart after any `.env` change.
2. Check the top bar pills: **AI: Mock data** and **Email: Simulated** (or Live/Real for Part 5).
3. Optional: `npm test --prefix server`; keep the green result in a terminal to show later.
4. Browser at the **Requests** page, sidebar expanded (Ctrl+B toggles it), zoom 90–100 %.
5. Keep the three datasets below open in another window to copy from.

---

## 1. The problem (≈1 min)

> "A buyer needs a commodity: say 20 tonnes of basmati rice delivered to Dubai at around $850 a tonne. Today that means searching for suppliers, emailing each one for a quote, chasing replies, haggling and comparing offers. This app automates that loop with AI, but **a person approves before anything binding is sent**."

The 7 steps: request → find suppliers → send proposals (RFQs) → collect replies → read quotes → negotiate → recommend & human approval.

## 2. How it is built (≈1 min)

- **React** (Vite, Tailwind, TanStack Query) → **Express** REST API → **PostgreSQL**. Background work runs in a **pg-boss** job queue on the same database (discovery, email delivery, reply processing, timeouts).
- **The AI finds and reads; code decides.** Gemini (with Tavily web search) finds suppliers and extracts prices from emails. Counter-offer prices, limits and scoring are plain, tested code: the LLM never sets a price.
- **Every email goes through an outbox** with an idempotency key, so retries or double-clicks never send twice.
- **A state machine** with row locks moves each request and each supplier thread forward; only allowed transitions happen.

---

## 3. End-to-end walkthrough (mock mode, dataset 1, ≈5 min)

| Step | Do | Say / point out |
|---|---|---|
| 1. Request | Sidebar **New request**. Fill in dataset 1. Try submitting with Maximum < Target first. | Required fields have `*`; validation is field-level ("Max price must be at least the target price") and the same rules run on the server. Live total preview on the right. Click **Find suppliers**. |
| 2. Find suppliers | Watch the stepper move to **Find suppliers · In progress**, then the supplier list appear. | In mock mode suppliers are generated on reserved `example.com` addresses, so nothing real can be emailed. Each has a **fit score** and "Why it fits". Stepper now says **Send proposals · Your action**: nothing runs until the buyer chooses. |
| 3. Send proposals | Untick one supplier, then **Send proposals to N suppliers**. | Buyer stays in control of who is contacted. Each RFQ gets a reference like `RFQ-46CB27EC-01` used to match replies. Open **View details** on a supplier → conversation shows the RFQ email. Note it never mentions the target or maximum. |
| 4. Collect quotes | Wait a few seconds; the banner shows "Waiting for supplier quotes", activity fills up. | Simulated suppliers reply through the **same inbound path as real email** (webhook/IMAP). Some quote, some decline, some never reply (closed after the reply timeout). |
| 5. Read quotes | Open a supplier panel → **Latest quote** card and conversation. | Price, delivery, payment terms and validity are extracted (rules in mock, Gemini in live). |
| 6. Negotiate | Watch counters in the conversation and **Counter-offers used x / 3**. | Rule-based: first counter anchors at 97 % of target, later ones concede toward the supplier, never above the maximum or a cheaper competitor's price. Counter emails are marked "Proposed · awaiting supplier". |
| 7. Recommend | Request moves to **Needs approval**. Show the approval panel and **Quotation comparison**. | Final offers within the maximum are scored 70 % price, 20 % delivery, 10 % payment terms. Shows total, saving vs target and vs opening quote, and the score per supplier. |
| 8. Approve | Enter **Approved by**, click **Approve …**, confirm. | Only this click creates the acceptance email, worded "subject to a formal purchase order". Losing suppliers get a polite regret. Request → **Closed**; the approval records who and when. Toast confirms. |

Optional: run **dataset 2 or 3** in parallel to show several requests at once (Requests page: KPI cards, tabs, search, sort).

---

## 4. Feature tour (≈2 min)

- **Suppliers** page: every supplier across requests, with contacted / quoted / won counts and search.
- **Quotes** page: every price received vs target; buyer-entered prices carry a **Manual** badge.
- **Negotiations** page: open conversations by stage (waiting, countered, final, closed).
- **Approvals** page: requests waiting for a decision and recently approved deals.
- **Settings** page: the AI, search and email configuration read from the server, plus the email allowlist.
- **Supplier side panel**: latest quote, full quote history (supplier vs manual entries), negotiation details, conversation timeline (collapsible, latest highlighted) and **Recovery tools**:
  - **Re-check replies**: re-reads a reply the parser could not read.
  - **Enter quote manually**: for a price received by phone; labelled "Manual entry · not confirmed by the supplier" everywhere.
  - **Mark as no response**: closes a silent supplier so the request can be recommended.
  - **Apply latest quote**: a lower price that arrived after an offer was marked final.
- **Activity** timeline: every step, decision and error, in plain language.

---

## 5. Real-world segment (optional, live profile, ≈3 min)

1. Create a request with **dataset 2** (or 3). Discovery now uses **Tavily** web search; **Gemini** reads the results and picks genuine suppliers (stock pages and directories are skipped). Emails are accepted only on the supplier's own domain, never guessed. Suppliers without a public email get a clear notice and **Add email**.
2. Set your test address on one supplier (**Add email**), allow it (**Allow this address**), and send. Show the real RFQ arriving in the test mailbox.
3. Reply from the test mailbox as the supplier, keeping the `RFQ-…` reference in the subject, e.g. `Price: INR 152 per kg, delivery within 7 days, payment Net 30`. Within about 15 s the IMAP poller ingests it, Gemini extracts the quote and the agent sends a counter-offer.
4. Reply "We accept your counter-offer." → the offer becomes final → **Needs approval** → approve.
5. Mention the safeguards: only allow-listed recipients can be emailed; replies are de-duplicated; a Gemini outage shows "Gemini is temporarily unavailable (HTTP 503)…" with **Retry search** (web results are reused, so no extra search credits), and the app never silently falls back to mock data.

Note: emails you send yourself from Gmail are not tracked (the app reads the inbox, not Sent). Make buyer decisions in the app.

---

## 6. Safety and quality talking points

- The buyer's **target and maximum never appear in any email** (tested).
- **Human approval gate**: acceptance emails are created only by the approve endpoint, at most one per request (idempotency key).
- **Outbox + idempotency keys** for every email; **dedupe** for inbound email (Message-ID or content hash); stale replies are ignored.
- **Real email is opt-in** and restricted to an allowlist; mock mode uses reserved domains.
- **Tests**: 130+ unit and integration tests against a separate `_test` database, with fake email, AI and search; they never call real services.

## 7. Challenges and lessons

| # | Challenge | What was hard | How it was solved |
|---|---|---|---|
| 1 | Keeping the AI away from prices | LLM output is not predictable or auditable, and a wrong number in an email is a real commitment risk. | The AI only finds suppliers and extracts quotes. Counter-offers, limits and scoring are a pure, tested function. Every AI answer is validated with a schema, with a rules-based fallback if the AI fails. |
| 2 | Email that never sends twice | Retries, double clicks and crashes can duplicate emails. Real Gmail needed an App Password, and an antivirus program intercepted the TLS connection ("self-signed certificate"). | Outbox table with an idempotency key per email (`rfq:<thread>`, `counter:<thread>:<round>`, `acceptance:<request>`) and a row lock before sending. Real email only to allow-listed addresses, approvable from the UI. |
| 3 | Reading real supplier emails | Replies quote our own email (so our counter price appears in theirs), arrive twice, arrive late, or are vague ("Yes, we are interested", "Accepted"). Prices come as "₹7,00,000", in bullet lists or in bold. | Quoted history is stripped; replies are matched by the `RFQ-…` reference; duplicates are dropped by Message-ID or a content hash; replies older than our latest counter are ignored. A reply without a price keeps the supplier waiting instead of failing it. Recovery tools handle the rest. |
| 4 | Many suppliers replying at once | Parallel jobs could move the same request to two different statuses. | A state machine with allowed transitions, row locks, and one function (`syncRequestStatus`) that derives the request status from its suppliers. |
| 5 | Unreliable AI and search providers | The Gemini model was retired (404); Google Search grounding needed billing (429); Gemini returned 503 "high demand"; retries re-ran the web search and wasted Tavily credits; AI could invent contact details. | Switched to Tavily search with Gemini reading the results. Transient Gemini errors are retried inside the call, search results are cached for job retries, and errors say clearly what failed. Emails are accepted only on the supplier's own domain. No silent fallback to mock data. |
| 6 | Human-in-the-loop correctness | A quote typed in by the buyer looked like the supplier's; a lower price arriving after an offer was final was ignored. | Every offer and message records its source (supplier or manual) and the UI labels it. A lower final price is applied before approval without sending email. Only the approve button creates the acceptance email. |
| 7 | Small but real bugs | Dates shifted by a day in UTC+5:30; rupee amounts need lakh grouping. | Postgres DATE values are returned as plain strings; money is formatted with `en-IN` for INR in both the UI and emails. |
| 8 | Testing without real services | Real email, AI and search are slow, costly and non-deterministic. | A separate `<db>_test` database, fake transports for email, AI and search, and an intercepted job queue, so every step, retry and duplicate runs deterministically (130+ tests). |

**Known gaps and next steps**
- An acceptance that names a price different from our counter-offer should be treated as a new quote, not an acceptance.
- Check that the reply's sender matches the supplier's email address, not only the RFQ reference.
- Save the agreed terms (price, delivery, payment, validity, and where each came from) when the buyer approves.
- Authentication and roles (the API currently has no login).
- Track emails the buyer sends directly from Gmail (the Sent folder).

## 8. Likely questions

| Question | Short answer |
|---|---|
| Why not let the LLM negotiate? | Prices must be predictable and auditable. The LLM extracts and finds; a pure, tested function decides counters within hard limits. |
| What if the AI invents a supplier or email? | Search results ground discovery; emails must appear in the results on the supplier's own domain; unverified results are labelled "Not web-verified". |
| How does it scale? | Jobs are queued per supplier and request in Postgres (pg-boss); workers can scale horizontally; row locks keep state transitions safe. |
| Costs? | One discovery is at most 8 Tavily basic searches; Gemini calls are small JSON extractions. Retries reuse cached search results. |
| What would you add next? | Authentication and roles, supplier sender verification, agreed-terms snapshot at approval, purchase-order generation, Gmail Sent-folder sync. |

## 9. If something goes wrong live

| Symptom | Fix |
|---|---|
| "Cannot reach the API server" | `npm run dev` must run both server and client; check its terminal. |
| Gemini 503 "temporarily unavailable" | Google capacity issue; wait a minute and click **Retry search**, or switch to the mock profile. |
| Tavily quota reached | Suppliers come from AI knowledge, marked "Not web-verified"; or use the mock profile. |
| Reply email does not appear | Keep the `RFQ-…` reference in the subject; the poller checks every 15 s. Use **Re-check replies** or **Enter quote manually**. |

---

## Demo datasets (positive flows)

All three use **Negotiation rounds** as listed, **Buyer name** `Procurement Team`, **Buyer email** blank. A maximum about 15–20 % above target lets most simulated suppliers end within the limit, so each run ends with a recommended deal.

### Dataset 1: Basmati rice (USD, 3 rounds)

| Field | Value |
|---|---|
| Commodity | `1121 Basmati Rice` |
| Specifications | `Extra-long grain, aged 12 months, 25 kg bags, moisture ≤ 12%` |
| Quantity / Unit | `20` / tonnes |
| Delivery location | `Dubai, UAE` |
| Needed by | `2026-12-15` |
| Currency | USD |
| Negotiation rounds | 3 |
| Target price per tonne | `850` |
| Maximum price | `1000` |

Point out: dollar formatting, three counter rounds, competitor leverage ("we have received more competitive offers").

### Dataset 2: Refined sunflower oil (INR, 3 rounds)

| Field | Value |
|---|---|
| Commodity | `Refined Sunflower Oil` |
| Specifications | `Food-grade, FSSAI compliant, sealed 15-litre containers` |
| Quantity / Unit | `5000` / kg |
| Delivery location | `Hyderabad, Telangana, India` |
| Needed by | `2026-11-30` |
| Currency | INR |
| Negotiation rounds | 3 |
| Target price per kg | `140` |
| Maximum price | `165` |

Point out: Indian number grouping (₹7,00,000.00 target total), a per-kg unit.

### Dataset 3: Portland cement (INR, 2 rounds)

| Field | Value |
|---|---|
| Commodity | `Portland Cement OPC 53 Grade` |
| Specifications | `BIS IS 12269 certified, fresh production, 50 kg bags` |
| Quantity / Unit | `200` / tonnes |
| Delivery location | `Nellore, Andhra Pradesh, India` |
| Needed by | `2026-11-30` |
| Currency | INR |
| Negotiation rounds | 2 |
| Target price per tonne | `6500` |
| Maximum price | `7800` |

Point out: fewer rounds means the agent concedes faster; the offer at the round limit becomes final if it is within the maximum.
