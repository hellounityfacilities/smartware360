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

## Still to come in Phase 2

- `src/money.js` — integer-based currency arithmetic for valuation, so costs never meet
  a float.
- `src/auth.js` — scrypt password hashing, server-side sessions, login throttling against
  the `failed_logins` / `locked_until` columns already in the schema.
- Services for receiving, issuing, transfer, counting, requests and adjustments, each
  wrapping a single database transaction.
- `src/app.js` — the REST API, with the permission codes from `005_reference` enforced per
  route.
- A full-month API test: post a realistic month of movement through the API and assert the
  reports reconcile to the ledger.

Then Phase 3 ports the prototype's screens onto this API.
