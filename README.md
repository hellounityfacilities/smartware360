[README.md](https://github.com/user-attachments/files/32230665/README.md)
# SMARTWARE 360

![tests](https://github.com/hellounityfacilities/smartware360/actions/workflows/test.yml/badge.svg)

Warehouse management and daily operations system, built for facilities management,
construction, trading and spare-parts businesses operating in Qatar. English and Arabic,
QAR, multi-warehouse.

**[Open the live demo →](https://hellounityfacilities.github.io/smartware360/)**

The demo runs entirely in the browser with 120 days of seeded data for a Doha facilities
management company: four warehouses, 382 bin locations, 44 SKUs, around 1,250
transactions. Nothing to install, nothing to sign up for. The seeded warehouse has real
problems in it — items below reorder, expiring batches, dead stock — because a demo where
everything is green shows none of the system working.

---

## The one design decision

**There is no stock balance column anywhere in the database.**

Quantity on hand is summed from an append-only transaction ledger every time it is read.
There is no number for anyone to type over, no field that can drift from its history, and
no way to "fix" a balance quietly at month end. A mistake is corrected by posting a
reversal, which leaves the error and the correction side by side.

Everything else follows from that. The daily equation on the home screen —

```
opening + receipts + returns + transfers in
        − issues − returns to supplier − transfers out
        ± adjustments = closing
```

— balances by construction, not by agreement, because all nine numbers are sums over the
same rows.

## Guarantees the database enforces

Not the application. The database. They hold for the API, for a future mobile client, and
for a developer connecting with psql.

- Stock cannot go negative, per bin and per warehouse, unless a company explicitly opts in
- The transaction ledger refuses `UPDATE` and `DELETE`; so does the audit log
- A closed accounting period refuses new postings
- A transfer must have two legs that net to zero, or it does not commit at all
- Whoever raises a material request or an adjustment cannot approve it
- An approver must actually hold the role the value band requires
- A count variance cannot be saved without a written explanation
- Document numbers are gapless — a rolled-back transaction leaves no hole
- An offline transaction replayed on reconnect cannot post twice

33 invariants in total. Each one has a test that tries to violate it and asserts the
refusal. [`ARCHITECTURE.md`](ARCHITECTURE.md) lists them all.

## Running the tests

```bash
npm install
npm test
```

```
59 passed, 0 failed, 59 assertions
```

Around two seconds, with no database server to install — the suite runs against
PostgreSQL 18 compiled to WebAssembly, so trigger timing and constraint deferral behave
exactly as they will in production.

## What is here

| | |
|---|---|
| `index.html` | The working prototype — one file, no build step, no dependencies |
| `migrations/` | Five SQL migrations: foundation, masters, ledger, documents, reference data |
| `src/` | Migration runner and database layer |
| `test/` | The invariant suite |
| `ARCHITECTURE.md` | The schema, and all 33 invariants with what each one prevents |

## Status

The prototype is complete and the database layer is built and tested. Next is the REST
API, then porting the prototype's screens onto it.

Two things are deliberately absent rather than stubbed: IoT and RFID, which need hardware
that isn't connected, and tax, which is configurable and set to zero by default. Nothing
assumes Qatar VAT applies.
