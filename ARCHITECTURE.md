[ARCHITECTURE.md](https://github.com/user-attachments/files/32232563/ARCHITECTURE.md)
# SMARTWARE 360 — server architecture

Phase 2, part one: the schema and the guarantees it enforces.

Stack: Node 20+, PostgreSQL 16+, raw SQL migrations through the `pg` driver, no ORM.
Tests run against PGlite — real PostgreSQL 18 compiled to WebAssembly — so trigger
timing, constraint deferral and transaction isolation behave exactly as they will in
production, with no database server to install.

```
npm install
npm test                 # 59 assertions, in-process, ~2 seconds
DATABASE_URL=postgres://… npm run migrate
```

---

## The governing idea

**There is no balance column.** Not on `item`, not on `location`, not anywhere. Quantity
on hand is a `SUM` over `stock_txn`, computed at read time, for every caller — the API,
a report, a developer with psql. A test asserts this directly: if anyone ever adds an
`on_hand` or `balance` column to a master table, the suite fails.

This is what makes the rest possible. A balance you cannot write cannot be quietly
corrected, drift from its transactions, or be "fixed" by someone under pressure at
month end.

The second rule follows from the first: **`stock_txn` is append-only**. `UPDATE` and
`DELETE` both raise. A mistake is corrected by posting a mirrored reversal, which leaves
the error and the correction side by side in the audit trail — which is what an auditor
actually wants to see.

---

## The 33 invariants

These are enforced by the database, not by the application. Every one has a test that
tries to violate it and asserts the refusal.

**The ledger itself**
1. `stock_txn` refuses `UPDATE`.
2. `stock_txn` refuses `DELETE`.
3. `audit_log` refuses `UPDATE` and `DELETE`.
4. A movement of zero quantity is rejected.
5. Sign discipline by type: receipts and transfers-in are always positive, issues and
   transfers-out always negative. Only adjustments may go either way.
6. An adjustment or count variance without a reason of at least five characters is rejected.

**Structural coherence**
7. The location must belong to the stated warehouse.
8. The warehouse must belong to the stated company.
9. A batch-controlled item cannot move without a batch.
10. A batch must belong to the item it is being posted against.
11. An expiry-controlled item cannot have an undated batch.
12. An item cannot be expiry-controlled without being batch-controlled.

**Quantity**
13. Stock cannot go negative in a bin.
14. Stock cannot go negative in a warehouse.
15. Negative stock is permitted only when a company explicitly opts in, and the setting
    is a row that can be audited.

**Time**
16. A locked period refuses new postings. Closed means closed.

**Transfers**
17. Both legs share a reference and must net to zero, checked at commit so the legs may
    be inserted in either order. A one-legged transfer cannot exist.
18. A transfer leg without a reference number is rejected.

**Corrections**
19. A reversal must mirror the original exactly — same item, location, batch, opposite
    quantity.
20. A reversal cannot itself be reversed.
21. A transaction can be reversed at most once.

**Numbering**
22. Document numbers are gapless per company and type. A rolled-back transaction leaves
    no hole, because the counter is a locked row rather than a sequence object.
23. Requesting a number for an undefined document type raises rather than inventing one.

**Authorisation**
24. A requester cannot approve their own material request.
25. The person who raises an adjustment cannot approve it, whatever their rank.
26. Approved quantity cannot exceed requested quantity.
27. Issued quantity cannot exceed approved quantity.
28. An adjustment cannot reach the ledger without an approval recorded first.
29. The approver must actually hold the role the value band requires. A Warehouse
    Manager cannot sign off a QAR 40,000 write-off by clicking harder — only a role
    holding `approve.any` overrides the band.
30. An adjustment can post to the ledger at most once.

**Counting**
31. A count line whose physical quantity differs from the system quantity cannot be
    stored without a written explanation. This is why the count screen refuses to close.
32. Variance is a generated column — computed by the database, never supplied by a client.

**Operational**
33. An offline transaction replayed on reconnect collides on its idempotency key rather
    than posting the movement twice.

---

## Schema map

| Migration | Contents |
|---|---|
| `001_foundation` | company, settings, warehouse, location, roles, permissions, users, sessions, periods, gapless numbering, audit log |
| `002_masters` | UoM, categories, items, batches, serials, suppliers, departments, projects, employees |
| `003_ledger` | `stock_txn` and its five trigger families, reservations, balance views, `fn_on_hand` / `fn_reserved` / `fn_available` / `fn_fefo_batch` / `fn_day_movement` |
| `004_documents` | goods receipts, material requests, counts, adjustments, approval thresholds, attachments, notifications, idempotency |
| `005_reference` | permissions, the nine standard roles and their grants, units of measure |

Migrations are immutable. The runner stores a checksum and refuses to proceed if an
already-applied file has been edited — history is corrected by adding `006`, never by
rewriting `003`.

### Reservations

`stock_reservation` never touches the ledger. It reduces what `fn_available` reports and
leaves `fn_on_hand` alone, so physical and available quantity can never be conflated by
accident. A test asserts the difference is exactly the reserved quantity.

### The daily equation

`fn_day_movement` returns opening, each flow, and closing from a single scan of the
ledger. Because all of them are sums over the same rows, the equation on the home screen
balances by construction rather than by agreement:

```
opening + receipts + returns in + transfers in
        − issues − returns to supplier − transfers out
        ± adjustments = closing
```

Two tests check this: that the equation balances, and that closing equals the sum of the
entire ledger.

---

---

## The API

45 routes, no web framework. The router is about eighty lines over node's `http` module —
the surface is small, and every dependency in a system holding a customer's inventory is
something that has to be patched for the life of the product.

```
npm start                # migrate, then listen on :8080
curl localhost:8080/health
```

| Area | Routes |
|---|---|
| Session | `POST /api/session`, `DELETE /api/session`, `GET /api/me` |
| Reference | `/api/warehouses`, `/api/locations`, `/api/items`, `/api/scan/:code` |
| Movement | `/api/receipts`, `/api/issues`, `/api/transfers`, `/api/transactions/:id/reverse` |
| Adjustments | `/api/adjustments` and `/approve`, `/reject` |
| Counting | `/api/counts`, `/api/counts/:id/close` |
| Requests | `/api/requests` and `/approve`, `/reserve`, `/issue`, `/cancel` |
| Reports | balances, day, movement, valuation, accuracy, variances, consumption, activity, utilisation, health |
| Intelligence | reorder, forecast, dead-stock, expiring, abc-xyz, risk, anomalies, tomorrow |
| Control | `/api/audit`, `/api/settings` |

Authentication is a server-side session, not a signed token, so revoking one takes effect
on the next request rather than whenever a token happens to expire — which matters when a
handheld goes missing. Passwords are scrypt with a per-user salt. Failed sign-ins are
counted on the user row and lock the account for fifteen minutes after five attempts, and
an unknown username costs the same time and returns the same message as a wrong password,
so the endpoint cannot be used to enumerate users.

Permission checks live in the services rather than in the routes, so a permission cannot
be bypassed later by calling a service from somewhere else.

## Money

Inventory valuation multiplies quantity by cost thousands of times per report. In floating
point the total drifts — not by much, but by enough that a finance manager reconciling to
two decimal places finds a number nobody can explain. So money is carried as BigInt minor
units and only becomes a string at the edge. Quantities carry three decimals and unit costs
four, both as scaled integers, rounded half away from zero exactly once at the end of a
calculation.

One test demonstrates why: adding `0.1 + 0.2` a thousand times in floating point does not
reach 300, and the integer path does.

## Tests

```bash
npm test          # all three suites, about 30 seconds
```

| Suite | Assertions | What it proves |
|---|---|---|
| `money.test.js` | 24 | Precision, rounding, and the float-drift case |
| `schema.test.js` | 59 | Each of the 33 invariants refuses what it should |
| `api.test.js` | 94 | A month of activity through the HTTP layer reconciles to the ledger |

**177 assertions.**

The API suite drives a realistic month — sign-in and lockout, receiving with batches and
quarantine, issuing with FEFO enforcement and an audited override, a transfer, a material
request through requested → approved → reserved → issued, an adjustment through the
approval bands, and a physical count with an explained variance. It ends with the
assertion that matters commercially: the sum of what the API reports as stock on hand
equals the sum of the transaction ledger, to three decimals, and valuation computed
independently matches the report.

---

## Still to come

**Phase 3** — port the prototype's screens onto this API: React, the bilingual layer,
print and export.

**Phase 4** — field readiness: PWA with a service worker, a genuine offline queue in
IndexedDB replaying against the `idempotency_key` table already in the schema, handheld
scanner support, photo and signature upload to real storage.

**Phase 5** — the operating layer: scheduled daily executive report, notification routing,
and forecasting retuned against a customer's actual history rather than a moving average.

**Phase 6** — integration and hardening: OpenAPI documentation, accounting integration,
multi-company tenancy, backups with restore testing, and the full acceptance walk from
purchase order to updated dashboard.
