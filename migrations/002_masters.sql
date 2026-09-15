-- =============================================================================
-- 002_masters.sql
-- Item master, suppliers, and the cost centres stock can be issued against.
-- =============================================================================

CREATE TABLE uom (
  code          text PRIMARY KEY,
  name          text NOT NULL,
  name_ar       text,
  is_integral   boolean NOT NULL DEFAULT true   -- pieces cannot be fractional
);

CREATE TABLE category (
  id            bigserial PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES company(id),
  parent_id     bigint REFERENCES category(id),
  name          text NOT NULL,
  name_ar       text,
  code          text NOT NULL,
  UNIQUE (company_id, code),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE TABLE supplier (
  id              bigserial PRIMARY KEY,
  company_id      bigint NOT NULL REFERENCES company(id),
  code            text NOT NULL,
  name            text NOT NULL,
  name_ar         text,
  contact_person  text,
  phone           text,
  email           text,
  address         text,
  payment_terms   text,
  lead_time_days  int NOT NULL DEFAULT 7 CHECK (lead_time_days BETWEEN 0 AND 365),
  is_active       boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, code)
);

CREATE TABLE department (
  id            bigserial PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES company(id),
  code          text NOT NULL,
  name          text NOT NULL,
  name_ar       text,
  UNIQUE (company_id, code)
);

CREATE TABLE project (
  id            bigserial PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES company(id),
  code          text NOT NULL,
  name          text NOT NULL,
  name_ar       text,
  starts_on     date,
  ends_on       date,
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, code),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);

CREATE TABLE employee (
  id            bigserial PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES company(id),
  code          text NOT NULL,
  name          text NOT NULL,
  department_id bigint REFERENCES department(id),
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, code)
);

-- ------------------------------------------------------------------ item ---
-- Note what is absent: there is no quantity, no on_hand, no balance column.
-- Stock is a property of the ledger, not of the item. min/max/reorder are
-- policy, not position.
CREATE TABLE item (
  id                  bigserial PRIMARY KEY,
  company_id          bigint NOT NULL REFERENCES company(id),
  sku                 text NOT NULL,
  barcode             text,
  name                text NOT NULL,
  name_ar             text,
  category_id         bigint NOT NULL REFERENCES category(id),
  brand               text,
  model               text,
  part_no             text,
  description         text,
  spec                text,
  uom_code            text NOT NULL REFERENCES uom(code),
  min_qty             numeric(14,3) NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  max_qty             numeric(14,3) NOT NULL DEFAULT 0 CHECK (max_qty >= 0),
  reorder_qty         numeric(14,3) NOT NULL DEFAULT 0 CHECK (reorder_qty >= 0),
  standard_cost       numeric(14,4) NOT NULL DEFAULT 0 CHECK (standard_cost >= 0),
  issue_price         numeric(14,4) NOT NULL DEFAULT 0 CHECK (issue_price >= 0),
  default_supplier_id bigint REFERENCES supplier(id),
  home_warehouse_id   bigint REFERENCES warehouse(id),
  is_batched          boolean NOT NULL DEFAULT false,
  is_expiry_controlled boolean NOT NULL DEFAULT false,
  is_serialised       boolean NOT NULL DEFAULT false,
  warranty_months     int CHECK (warranty_months IS NULL OR warranty_months >= 0),
  alternative_item_id bigint REFERENCES item(id),
  image_url           text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, sku),
  CHECK (max_qty = 0 OR max_qty >= min_qty),
  -- an expiry-controlled item must carry batches; you cannot date what you
  -- cannot identify
  CHECK (NOT is_expiry_controlled OR is_batched),
  CHECK (alternative_item_id IS NULL OR alternative_item_id <> id)
);
CREATE UNIQUE INDEX item_barcode_idx ON item (company_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX item_name_idx ON item (company_id, lower(name));
CREATE INDEX item_name_ar_idx ON item (company_id, name_ar);
CREATE INDEX item_part_idx ON item (company_id, lower(part_no));

-- Several suppliers may quote the same item; the cheapest is not always the
-- best, so price and lead time are both kept per supplier.
CREATE TABLE item_supplier (
  item_id         bigint NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  supplier_id     bigint NOT NULL REFERENCES supplier(id) ON DELETE CASCADE,
  supplier_sku    text,
  last_price      numeric(14,4) CHECK (last_price IS NULL OR last_price >= 0),
  lead_time_days  int CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  PRIMARY KEY (item_id, supplier_id)
);

-- ----------------------------------------------------------------- batch ---
CREATE TABLE batch (
  id              bigserial PRIMARY KEY,
  item_id         bigint NOT NULL REFERENCES item(id),
  batch_no        text NOT NULL,
  manufactured_on date,
  expires_on      date,
  UNIQUE (item_id, batch_no),
  CHECK (expires_on IS NULL OR manufactured_on IS NULL OR expires_on > manufactured_on)
);
CREATE INDEX batch_expiry_idx ON batch (item_id, expires_on NULLS LAST);

CREATE TABLE serial_unit (
  id            bigserial PRIMARY KEY,
  item_id       bigint NOT NULL REFERENCES item(id),
  serial_no     text NOT NULL,
  batch_id      bigint REFERENCES batch(id),
  UNIQUE (item_id, serial_no)
);

-- A batched item's batch must belong to that item. Enforced at insert on the
-- ledger, but stated here so the intent is readable in the schema.
CREATE FUNCTION trg_batch_item_match() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_expiry_controlled boolean;
BEGIN
  SELECT is_expiry_controlled INTO v_expiry_controlled FROM item WHERE id = NEW.item_id;
  IF v_expiry_controlled AND NEW.expires_on IS NULL THEN
    RAISE EXCEPTION 'item % is expiry controlled; batch % needs an expiry date',
      NEW.item_id, NEW.batch_no USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER batch_expiry_required BEFORE INSERT OR UPDATE ON batch
  FOR EACH ROW EXECUTE FUNCTION trg_batch_item_match();
