-- =============================================================================
-- 004_documents.sql
-- The paperwork that authorises movement: receipts, material requests,
-- physical counts, adjustments, and the approval rules that gate them.
-- =============================================================================

CREATE TYPE doc_status AS ENUM (
  'DRAFT','REQUESTED','APPROVED','REJECTED','RESERVED','PARTIAL','COMPLETED','CANCELLED','CLOSED'
);

-- ------------------------------------------------------------ receiving -----
CREATE TABLE goods_receipt (
  id              bigserial PRIMARY KEY,
  company_id      bigint NOT NULL REFERENCES company(id),
  grn_no          text NOT NULL,
  warehouse_id    bigint NOT NULL REFERENCES warehouse(id),
  supplier_id     bigint NOT NULL REFERENCES supplier(id),
  po_no           text,
  delivery_note   text,
  invoice_no      text,
  received_on     date NOT NULL DEFAULT current_date,
  status          doc_status NOT NULL DEFAULT 'DRAFT',
  note            text,
  created_by      bigint NOT NULL REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, grn_no)
);

CREATE TABLE goods_receipt_line (
  id              bigserial PRIMARY KEY,
  receipt_id      bigint NOT NULL REFERENCES goods_receipt(id) ON DELETE CASCADE,
  item_id         bigint NOT NULL REFERENCES item(id),
  ordered_qty     numeric(14,3) CHECK (ordered_qty IS NULL OR ordered_qty > 0),
  received_qty    numeric(14,3) NOT NULL CHECK (received_qty > 0),
  unit_cost       numeric(14,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  batch_id        bigint REFERENCES batch(id),
  location_id     bigint NOT NULL REFERENCES location(id),
  condition       text NOT NULL DEFAULT 'GOOD' CHECK (condition IN ('GOOD','DAMAGED','QUARANTINE')),
  -- partial receipt is normal; over-receipt against a PO is not silent
  CHECK (ordered_qty IS NULL OR received_qty <= ordered_qty * 1.1)
);

-- --------------------------------------------------------- material req -----
CREATE TABLE stock_request (
  id              bigserial PRIMARY KEY,
  company_id      bigint NOT NULL REFERENCES company(id),
  request_no      text NOT NULL,
  warehouse_id    bigint NOT NULL REFERENCES warehouse(id),
  requested_by    bigint NOT NULL REFERENCES app_user(id),
  department_id   bigint REFERENCES department(id),
  project_id      bigint REFERENCES project(id),
  priority        text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL','HIGH','URGENT')),
  required_by     date,
  reason          text,
  status          doc_status NOT NULL DEFAULT 'REQUESTED',
  approved_by     bigint REFERENCES app_user(id),
  approved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, request_no),
  -- a request must be for somebody: a department, a project, or both
  CHECK (department_id IS NOT NULL OR project_id IS NOT NULL),
  -- Invariant: the person who raised a request cannot be the person who
  -- approved it. Maker and checker are always different people.
  CONSTRAINT request_maker_checker CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);

CREATE TABLE stock_request_line (
  id              bigserial PRIMARY KEY,
  request_id      bigint NOT NULL REFERENCES stock_request(id) ON DELETE CASCADE,
  item_id         bigint NOT NULL REFERENCES item(id),
  requested_qty   numeric(14,3) NOT NULL CHECK (requested_qty > 0),
  approved_qty    numeric(14,3) NOT NULL DEFAULT 0 CHECK (approved_qty >= 0),
  issued_qty      numeric(14,3) NOT NULL DEFAULT 0 CHECK (issued_qty >= 0),
  UNIQUE (request_id, item_id),
  -- you cannot approve more than was asked for, nor issue more than approved
  CHECK (approved_qty <= requested_qty),
  CHECK (issued_qty <= approved_qty)
);

-- ------------------------------------------------------------- counting -----
CREATE TABLE stock_count (
  id              bigserial PRIMARY KEY,
  company_id      bigint NOT NULL REFERENCES company(id),
  count_no        text NOT NULL,
  warehouse_id    bigint NOT NULL REFERENCES warehouse(id),
  zone            text,
  counted_by      bigint NOT NULL REFERENCES app_user(id),
  started_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  closed_by       bigint REFERENCES app_user(id),
  status          doc_status NOT NULL DEFAULT 'DRAFT',
  accuracy_pct    numeric(5,2) CHECK (accuracy_pct IS NULL OR accuracy_pct BETWEEN 0 AND 100),
  UNIQUE (company_id, count_no),
  CHECK ((closed_at IS NULL) = (closed_by IS NULL)),
  CHECK (closed_at IS NULL OR closed_at >= started_at)
);

CREATE TABLE stock_count_line (
  id              bigserial PRIMARY KEY,
  count_id        bigint NOT NULL REFERENCES stock_count(id) ON DELETE CASCADE,
  item_id         bigint NOT NULL REFERENCES item(id),
  location_id     bigint NOT NULL REFERENCES location(id),
  batch_id        bigint REFERENCES batch(id),
  system_qty      numeric(14,3) NOT NULL,
  physical_qty    numeric(14,3) NOT NULL CHECK (physical_qty >= 0),
  variance        numeric(14,3) GENERATED ALWAYS AS (physical_qty - system_qty) STORED,
  explanation     text,
  UNIQUE (count_id, item_id, location_id, batch_id),
  -- Invariant: a variance without a written explanation cannot be stored.
  -- This is why the count screen refuses to close, not politeness.
  CONSTRAINT variance_needs_explanation CHECK (
    physical_qty = system_qty OR
    (explanation IS NOT NULL AND length(btrim(explanation)) >= 5)
  )
);

-- ---------------------------------------------------------- adjustments -----
CREATE TABLE adjustment_threshold (
  id              bigserial PRIMARY KEY,
  company_id      bigint NOT NULL REFERENCES company(id),
  max_value       numeric(14,2),               -- NULL means "and above"
  approver_role_id bigint NOT NULL REFERENCES role(id),
  UNIQUE (company_id, max_value)
);

CREATE TABLE stock_adjustment (
  id              bigserial PRIMARY KEY,
  company_id      bigint NOT NULL REFERENCES company(id),
  adj_no          text NOT NULL,
  warehouse_id    bigint NOT NULL REFERENCES warehouse(id),
  location_id     bigint NOT NULL REFERENCES location(id),
  item_id         bigint NOT NULL REFERENCES item(id),
  batch_id        bigint REFERENCES batch(id),
  qty             numeric(14,3) NOT NULL CHECK (qty <> 0),
  value           numeric(14,2) NOT NULL CHECK (value >= 0),
  reason          text NOT NULL CHECK (length(btrim(reason)) >= 5),
  status          doc_status NOT NULL DEFAULT 'REQUESTED',
  raised_by       bigint NOT NULL REFERENCES app_user(id),
  raised_at       timestamptz NOT NULL DEFAULT now(),
  approved_by     bigint REFERENCES app_user(id),
  approved_at     timestamptz,
  posted_txn_id   bigint REFERENCES stock_txn(id),
  UNIQUE (company_id, adj_no),
  -- Invariant: maker cannot be checker on an adjustment either.
  CONSTRAINT adj_maker_checker CHECK (approved_by IS NULL OR approved_by <> raised_by),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  -- Invariant: nothing reaches the ledger without an approval first.
  CONSTRAINT adj_post_requires_approval CHECK (posted_txn_id IS NULL OR approved_by IS NOT NULL)
);
CREATE UNIQUE INDEX adj_one_posting ON stock_adjustment (posted_txn_id)
  WHERE posted_txn_id IS NOT NULL;

-- Which role must approve a given value. Returns the narrowest matching band.
CREATE FUNCTION fn_required_approver(p_company bigint, p_value numeric)
RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT approver_role_id FROM adjustment_threshold
   WHERE company_id = p_company AND (max_value IS NULL OR p_value <= max_value)
   ORDER BY max_value NULLS LAST
   LIMIT 1
$$;

-- Invariant: the approver must actually hold the role the value band requires.
-- A Warehouse Manager cannot sign off a QAR 40,000 write-off by clicking harder.
CREATE FUNCTION trg_adj_approver_rank() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_required bigint; v_actual bigint;
BEGIN
  IF NEW.approved_by IS NULL THEN RETURN NEW; END IF;
  IF OLD.approved_by IS NOT DISTINCT FROM NEW.approved_by THEN RETURN NEW; END IF;

  v_required := fn_required_approver(NEW.company_id, NEW.value);
  SELECT role_id INTO v_actual FROM app_user WHERE id = NEW.approved_by;

  IF v_required IS NOT NULL AND v_actual <> v_required
     AND NOT EXISTS (SELECT 1 FROM role_permission rp
                      WHERE rp.role_id = v_actual AND rp.permission_code = 'approve.any') THEN
    RAISE EXCEPTION 'adjustment of % requires approval by role %, not role %',
      NEW.value, v_required, v_actual USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER adj_approver_rank BEFORE UPDATE ON stock_adjustment
  FOR EACH ROW EXECUTE FUNCTION trg_adj_approver_rank();

-- --------------------------------------------------- evidence and alerts ----
CREATE TABLE attachment (
  id            bigserial PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES company(id),
  entity        text NOT NULL,
  entity_id     bigint NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('PHOTO','PDF','IMAGE','DOC','SIGNATURE')),
  filename      text NOT NULL,
  content_type  text NOT NULL,
  byte_size     bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 26214400),
  storage_key   text NOT NULL,
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by   bigint NOT NULL REFERENCES app_user(id),
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachment_entity_idx ON attachment (entity, entity_id);

CREATE TABLE notification (
  id            bigserial PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES company(id),
  user_id       bigint REFERENCES app_user(id),
  role_id       bigint REFERENCES role(id),
  kind          text NOT NULL,
  severity      text NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO','WARN','CRITICAL')),
  title         text NOT NULL,
  body          text,
  entity        text,
  entity_id     bigint,
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz,
  CHECK (user_id IS NOT NULL OR role_id IS NOT NULL)
);
CREATE INDEX notification_unread_idx ON notification (company_id, user_id) WHERE read_at IS NULL;

-- Offline clients replay transactions on reconnect. The client generates the
-- key; a duplicate replay collides here instead of double-posting the movement.
CREATE TABLE idempotency_key (
  key           text PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES company(id),
  user_id       bigint NOT NULL REFERENCES app_user(id),
  request_hash  text NOT NULL,
  response_body text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
