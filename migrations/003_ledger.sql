-- =============================================================================
-- 003_ledger.sql
--
-- The centre of the system. Two rules govern everything below:
--
--   1. There is no balance column anywhere. Quantity on hand is a SUM over
--      stock_txn, always, for every caller. Nothing can be typed over because
--      there is nothing to type over.
--   2. stock_txn is append-only. A mistake is corrected by posting a reversing
--      transaction, which leaves both the error and the correction visible.
--
-- Everything else in this file exists to stop the ledger being told a lie.
-- =============================================================================

CREATE TYPE txn_type AS ENUM (
  'RECEIVE',          -- goods in from a supplier            (qty > 0)
  'RETURN_IN',        -- unused material back from site      (qty > 0)
  'TRANSFER_IN',      -- arriving leg of a transfer          (qty > 0)
  'ISSUE',            -- out to project/department/employee  (qty < 0)
  'RETURN_SUPPLIER',  -- back to the supplier                (qty < 0)
  'TRANSFER_OUT',     -- departing leg of a transfer         (qty < 0)
  'ADJUST',           -- approved correction                 (either sign)
  'COUNT_ADJUST'      -- physical count variance             (either sign)
);

CREATE TABLE stock_txn (
  id            bigserial PRIMARY KEY,
  txn_no        text NOT NULL,
  company_id    bigint NOT NULL REFERENCES company(id),
  warehouse_id  bigint NOT NULL REFERENCES warehouse(id),
  location_id   bigint NOT NULL REFERENCES location(id),
  item_id       bigint NOT NULL REFERENCES item(id),
  batch_id      bigint REFERENCES batch(id),
  serial_id     bigint REFERENCES serial_unit(id),
  txn_type      txn_type NOT NULL,
  qty           numeric(14,3) NOT NULL CHECK (qty <> 0),
  unit_cost     numeric(14,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),

  -- what caused this movement: 'GRN', 'REQUEST', 'COUNT', 'ADJUSTMENT', 'TRANSFER'
  source_type   text,
  source_id     bigint,
  ref_no        text,                   -- both legs of a transfer share this

  party_type    text,                   -- Supplier | Project | Department | ...
  party_ref     text,
  reason        text,
  note          text,

  posted_at     timestamptz NOT NULL DEFAULT now(),
  posted_by     bigint NOT NULL REFERENCES app_user(id),
  reverses_id   bigint REFERENCES stock_txn(id),

  UNIQUE (company_id, txn_no),

  -- sign discipline: a receipt can never be negative, an issue never positive.
  -- This removes a whole class of data-entry error at the storage layer.
  CONSTRAINT txn_sign CHECK (
    (txn_type IN ('RECEIVE','RETURN_IN','TRANSFER_IN')            AND qty > 0) OR
    (txn_type IN ('ISSUE','RETURN_SUPPLIER','TRANSFER_OUT')       AND qty < 0) OR
    (txn_type IN ('ADJUST','COUNT_ADJUST'))
  ),
  -- an adjustment without a stated reason is not an adjustment, it is a guess
  CONSTRAINT txn_reason CHECK (
    txn_type NOT IN ('ADJUST','COUNT_ADJUST') OR
    (reason IS NOT NULL AND length(btrim(reason)) >= 5)
  )
);

CREATE INDEX txn_item_loc_idx  ON stock_txn (item_id, location_id);
CREATE INDEX txn_item_wh_idx   ON stock_txn (item_id, warehouse_id);
CREATE INDEX txn_item_batch_idx ON stock_txn (item_id, batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX txn_posted_idx    ON stock_txn (company_id, posted_at DESC);
CREATE INDEX txn_ref_idx       ON stock_txn (ref_no) WHERE ref_no IS NOT NULL;
CREATE INDEX txn_source_idx    ON stock_txn (source_type, source_id);
CREATE UNIQUE INDEX txn_single_reversal ON stock_txn (reverses_id) WHERE reverses_id IS NOT NULL;

-- Invariant 1 — the ledger is append-only.
CREATE TRIGGER stock_txn_no_update BEFORE UPDATE ON stock_txn
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();
CREATE TRIGGER stock_txn_no_delete BEFORE DELETE ON stock_txn
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();

-- -----------------------------------------------------------------------------
-- Invariant 2 — structural coherence of a single row, checked before insert:
--   the location belongs to the stated warehouse
--   the warehouse belongs to the stated company
--   a batched item carries a batch, and that batch belongs to that item
--   an expiry-controlled receipt carries an expiry date
--   the period being posted into is not locked
-- -----------------------------------------------------------------------------
CREATE FUNCTION trg_txn_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_loc_wh   bigint;
  v_wh_co    bigint;
  v_batched  boolean;
  v_expiry   boolean;
  v_b_item   bigint;
  v_b_exp    date;
  v_locked   boolean;
BEGIN
  SELECT warehouse_id INTO v_loc_wh FROM location WHERE id = NEW.location_id;
  IF v_loc_wh IS DISTINCT FROM NEW.warehouse_id THEN
    RAISE EXCEPTION 'location % does not belong to warehouse %',
      NEW.location_id, NEW.warehouse_id USING ERRCODE = 'check_violation';
  END IF;

  SELECT company_id INTO v_wh_co FROM warehouse WHERE id = NEW.warehouse_id;
  IF v_wh_co IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'warehouse % does not belong to company %',
      NEW.warehouse_id, NEW.company_id USING ERRCODE = 'check_violation';
  END IF;

  SELECT is_batched, is_expiry_controlled INTO v_batched, v_expiry
    FROM item WHERE id = NEW.item_id;

  IF v_batched AND NEW.batch_id IS NULL THEN
    RAISE EXCEPTION 'item % is batch controlled; a batch is required on every movement',
      NEW.item_id USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.batch_id IS NOT NULL THEN
    SELECT item_id, expires_on INTO v_b_item, v_b_exp FROM batch WHERE id = NEW.batch_id;
    IF v_b_item IS DISTINCT FROM NEW.item_id THEN
      RAISE EXCEPTION 'batch % belongs to a different item', NEW.batch_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_expiry AND v_b_exp IS NULL THEN
      RAISE EXCEPTION 'item % is expiry controlled; batch % has no expiry date',
        NEW.item_id, NEW.batch_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT is_locked INTO v_locked
    FROM period
   WHERE company_id = NEW.company_id
     AND year  = extract(year  FROM NEW.posted_at)::int
     AND month = extract(month FROM NEW.posted_at)::int;
  IF COALESCE(v_locked, false) THEN
    RAISE EXCEPTION 'period %-% is closed; post a correction in the open period instead',
      extract(year FROM NEW.posted_at)::int, extract(month FROM NEW.posted_at)::int
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER stock_txn_validate BEFORE INSERT ON stock_txn
  FOR EACH ROW EXECUTE FUNCTION trg_txn_validate();

-- -----------------------------------------------------------------------------
-- Invariant 3 — stock cannot go negative.
-- Checked per item per bin, and again per item per warehouse, after the row
-- lands. A company may switch this off deliberately; it is off by default and
-- the setting is auditable.
-- -----------------------------------------------------------------------------
CREATE FUNCTION fn_setting(p_company bigint, p_key text, p_default text)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT value FROM company_setting
                    WHERE company_id = p_company AND key = p_key), p_default)
$$;

CREATE FUNCTION trg_txn_no_negative() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_bin numeric; v_wh numeric;
BEGIN
  IF fn_setting(NEW.company_id, 'allow_negative_stock', 'false') = 'true' THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum(qty),0) INTO v_bin
    FROM stock_txn WHERE item_id = NEW.item_id AND location_id = NEW.location_id;
  IF v_bin < 0 THEN
    RAISE EXCEPTION 'insufficient stock: item % in location % would fall to %',
      NEW.item_id, NEW.location_id, v_bin USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(sum(qty),0) INTO v_wh
    FROM stock_txn WHERE item_id = NEW.item_id AND warehouse_id = NEW.warehouse_id;
  IF v_wh < 0 THEN
    RAISE EXCEPTION 'insufficient stock: item % in warehouse % would fall to %',
      NEW.item_id, NEW.warehouse_id, v_wh USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER stock_txn_no_negative
  AFTER INSERT ON stock_txn DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION trg_txn_no_negative();

-- -----------------------------------------------------------------------------
-- Invariant 4 — a transfer must balance.
-- Both legs share a ref_no and must sum to zero by the end of the transaction.
-- Deferred, so the two legs may be inserted in either order.
-- -----------------------------------------------------------------------------
CREATE FUNCTION trg_transfer_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_sum numeric; v_legs int;
BEGIN
  IF NEW.txn_type NOT IN ('TRANSFER_IN','TRANSFER_OUT') THEN RETURN NULL; END IF;
  IF NEW.ref_no IS NULL THEN
    RAISE EXCEPTION 'a transfer leg must carry a reference number'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(sum(qty),0), count(*) INTO v_sum, v_legs
    FROM stock_txn
   WHERE ref_no = NEW.ref_no AND txn_type IN ('TRANSFER_IN','TRANSFER_OUT');

  IF v_legs < 2 OR v_sum <> 0 THEN
    RAISE EXCEPTION 'transfer % does not balance: % legs netting to %',
      NEW.ref_no, v_legs, v_sum USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER stock_txn_transfer_balanced
  AFTER INSERT ON stock_txn DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_transfer_balanced();

-- -----------------------------------------------------------------------------
-- Invariant 5 — a reversal must mirror exactly what it reverses, once.
-- -----------------------------------------------------------------------------
CREATE FUNCTION trg_txn_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o stock_txn%ROWTYPE;
BEGIN
  IF NEW.reverses_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO o FROM stock_txn WHERE id = NEW.reverses_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cannot reverse transaction % — it does not exist', NEW.reverses_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF o.reverses_id IS NOT NULL THEN
    RAISE EXCEPTION 'transaction % is itself a reversal and cannot be reversed', o.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.qty <> -o.qty OR NEW.item_id <> o.item_id OR NEW.location_id <> o.location_id
     OR NEW.batch_id IS DISTINCT FROM o.batch_id THEN
    RAISE EXCEPTION 'a reversal must mirror the original exactly (item, location, batch, quantity)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER stock_txn_reversal BEFORE INSERT ON stock_txn
  FOR EACH ROW EXECUTE FUNCTION trg_txn_reversal();

-- -----------------------------------------------------------------------------
-- Reservations. Physical quantity and available quantity are different numbers
-- and the schema refuses to let them be confused: a reservation never touches
-- the ledger, it only reduces what fn_available reports.
-- -----------------------------------------------------------------------------
CREATE TABLE stock_reservation (
  id            bigserial PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES company(id),
  warehouse_id  bigint NOT NULL REFERENCES warehouse(id),
  item_id       bigint NOT NULL REFERENCES item(id),
  qty           numeric(14,3) NOT NULL CHECK (qty > 0),
  qty_released  numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty_released >= 0),
  source_type   text NOT NULL,
  source_id     bigint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    bigint NOT NULL REFERENCES app_user(id),
  released_at   timestamptz,
  CHECK (qty_released <= qty)
);
CREATE INDEX reservation_open_idx ON stock_reservation (item_id, warehouse_id)
  WHERE released_at IS NULL;

-- ------------------------------------------------------------- balances -----
CREATE VIEW v_stock_by_location AS
  SELECT item_id, warehouse_id, location_id, sum(qty) AS qty
    FROM stock_txn GROUP BY item_id, warehouse_id, location_id HAVING sum(qty) <> 0;

CREATE VIEW v_stock_by_warehouse AS
  SELECT item_id, warehouse_id, sum(qty) AS qty
    FROM stock_txn GROUP BY item_id, warehouse_id HAVING sum(qty) <> 0;

CREATE VIEW v_stock_by_batch AS
  SELECT t.item_id, t.warehouse_id, t.batch_id, b.batch_no, b.expires_on, sum(t.qty) AS qty
    FROM stock_txn t JOIN batch b ON b.id = t.batch_id
   GROUP BY t.item_id, t.warehouse_id, t.batch_id, b.batch_no, b.expires_on
  HAVING sum(t.qty) <> 0;

CREATE FUNCTION fn_on_hand(p_item bigint, p_warehouse bigint DEFAULT NULL)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(qty),0) FROM stock_txn
   WHERE item_id = p_item AND (p_warehouse IS NULL OR warehouse_id = p_warehouse)
$$;

CREATE FUNCTION fn_reserved(p_item bigint, p_warehouse bigint DEFAULT NULL)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(qty - qty_released),0) FROM stock_reservation
   WHERE item_id = p_item AND released_at IS NULL
     AND (p_warehouse IS NULL OR warehouse_id = p_warehouse)
$$;

CREATE FUNCTION fn_available(p_item bigint, p_warehouse bigint DEFAULT NULL)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT fn_on_hand(p_item, p_warehouse) - fn_reserved(p_item, p_warehouse)
$$;

-- FEFO: the batch that should leave first. Batches without an expiry sort last,
-- so dated stock is always consumed before undated stock.
CREATE FUNCTION fn_fefo_batch(p_item bigint, p_warehouse bigint)
RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT batch_id FROM v_stock_by_batch
   WHERE item_id = p_item AND warehouse_id = p_warehouse AND qty > 0
   ORDER BY expires_on NULLS LAST, batch_id
   LIMIT 1
$$;

-- Daily movement, from the ledger only. This is the query behind the home
-- screen equation; opening + ins - outs +/- adjustments must equal closing by
-- construction, because all five numbers come from the same sum.
CREATE FUNCTION fn_day_movement(p_company bigint, p_warehouse bigint, p_day date)
RETURNS TABLE (
  opening numeric, receipts numeric, returns_in numeric, transfers_in numeric,
  issues numeric, returns_out numeric, transfers_out numeric,
  adjustments numeric, closing numeric, txn_count bigint
) LANGUAGE sql STABLE AS $$
  WITH scope AS (
    SELECT * FROM stock_txn
     WHERE company_id = p_company
       AND (p_warehouse IS NULL OR warehouse_id = p_warehouse)
  ), o AS (
    SELECT COALESCE(sum(qty),0) v FROM scope WHERE posted_at < p_day::timestamptz
  ), d AS (
    SELECT * FROM scope
     WHERE posted_at >= p_day::timestamptz
       AND posted_at <  (p_day + 1)::timestamptz
  )
  SELECT
    (SELECT v FROM o),
    COALESCE(sum(qty) FILTER (WHERE txn_type='RECEIVE'),0),
    COALESCE(sum(qty) FILTER (WHERE txn_type='RETURN_IN'),0),
    COALESCE(sum(qty) FILTER (WHERE txn_type='TRANSFER_IN'),0),
    COALESCE(-sum(qty) FILTER (WHERE txn_type='ISSUE'),0),
    COALESCE(-sum(qty) FILTER (WHERE txn_type='RETURN_SUPPLIER'),0),
    COALESCE(-sum(qty) FILTER (WHERE txn_type='TRANSFER_OUT'),0),
    COALESCE(sum(qty) FILTER (WHERE txn_type IN ('ADJUST','COUNT_ADJUST')),0),
    (SELECT v FROM o) + COALESCE(sum(qty),0),
    count(*)
  FROM d
$$;
