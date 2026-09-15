-- =============================================================================
-- 001_foundation.sql
-- Tenancy, physical structure, identity, and the two append-only spines
-- (audit_log and doc_sequence) that every later migration depends on.
-- =============================================================================

CREATE TABLE company (
  id            bigserial PRIMARY KEY,
  code          text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{2,12}$'),
  name          text NOT NULL,
  name_ar       text,
  currency      char(3) NOT NULL DEFAULT 'QAR',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Settings are per company and typed as text; callers coerce. Nothing that a
-- customer might reasonably want different is hard-coded in the application.
CREATE TABLE company_setting (
  company_id    bigint NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  key           text NOT NULL,
  value         text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, key)
);

CREATE TABLE warehouse (
  id            bigserial PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES company(id),
  code          text NOT NULL,
  name          text NOT NULL,
  name_ar       text,
  site          text,
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, code)
);

-- Company > Warehouse > Zone > Rack > Shelf > Bin. The bin is the only level
-- that holds stock; the rest are attributes of it, so the hierarchy stays one
-- table and utilisation rolls up with a GROUP BY instead of a recursive walk.
CREATE TABLE location (
  id            bigserial PRIMARY KEY,
  warehouse_id  bigint NOT NULL REFERENCES warehouse(id),
  zone          text NOT NULL,
  rack          text NOT NULL,
  shelf         text NOT NULL,
  bin           text NOT NULL,
  code          text NOT NULL,
  capacity      numeric(14,3) NOT NULL DEFAULT 0 CHECK (capacity >= 0),
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (warehouse_id, zone, rack, shelf, bin),
  UNIQUE (warehouse_id, code)
);
CREATE INDEX location_wh_idx ON location (warehouse_id) WHERE is_active;

-- ---------------------------------------------------------------- identity --
CREATE TABLE role (
  id            bigserial PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  is_system     boolean NOT NULL DEFAULT false
);

CREATE TABLE permission (
  code          text PRIMARY KEY,
  description   text NOT NULL
);

CREATE TABLE role_permission (
  role_id         bigint NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permission(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE app_user (
  id              bigserial PRIMARY KEY,
  company_id      bigint NOT NULL REFERENCES company(id),
  username        text NOT NULL,
  full_name       text NOT NULL,
  email           text,
  role_id         bigint NOT NULL REFERENCES role(id),
  -- scrypt output, never a reversible or unsalted digest
  password_hash   text,
  password_salt   text,
  is_active       boolean NOT NULL DEFAULT true,
  failed_logins   int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, username)
);

-- A user may be confined to specific warehouses. No rows here means all of them.
CREATE TABLE user_warehouse (
  user_id       bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  warehouse_id  bigint NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, warehouse_id)
);

CREATE TABLE session (
  id            text PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  device        text,
  revoked_at    timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX session_user_idx ON session (user_id) WHERE revoked_at IS NULL;

-- ------------------------------------------------------------- accounting --
-- A period can be locked. Once locked, nothing may post into it — this is what
-- makes a closed month actually closed rather than closed by convention.
CREATE TABLE period (
  id            bigserial PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES company(id),
  year          int NOT NULL CHECK (year BETWEEN 2000 AND 2200),
  month         int NOT NULL CHECK (month BETWEEN 1 AND 12),
  is_locked     boolean NOT NULL DEFAULT false,
  locked_at     timestamptz,
  locked_by     bigint REFERENCES app_user(id),
  UNIQUE (company_id, year, month),
  CHECK (NOT is_locked OR (locked_at IS NOT NULL AND locked_by IS NOT NULL))
);

-- ---------------------------------------------------- gapless numbering ----
-- Document numbers must have no holes: an auditor reading GRN-000041 must be
-- able to demand GRN-000040. A sequence object would leak numbers on rollback,
-- so the counter is a row taken under lock inside the caller's transaction.
CREATE TABLE doc_sequence (
  company_id    bigint NOT NULL REFERENCES company(id),
  doc_type      text NOT NULL,
  prefix        text NOT NULL,
  next_value    bigint NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  width         int NOT NULL DEFAULT 6 CHECK (width BETWEEN 4 AND 12),
  PRIMARY KEY (company_id, doc_type)
);

CREATE FUNCTION next_doc_no(p_company bigint, p_type text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_next bigint; v_prefix text; v_width int;
BEGIN
  UPDATE doc_sequence
     SET next_value = next_value + 1
   WHERE company_id = p_company AND doc_type = p_type
  RETURNING next_value - 1, prefix, width INTO v_next, v_prefix, v_width;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no document sequence defined for % / %', p_company, p_type
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_prefix || lpad(v_next::text, v_width, '0');
END $$;

-- --------------------------------------------------------------- audit -----
-- Append-only. Old and new values are captured as text so one table covers
-- every entity without a column per subject.
CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  company_id    bigint NOT NULL REFERENCES company(id),
  at            timestamptz NOT NULL DEFAULT now(),
  user_id       bigint REFERENCES app_user(id),
  action        text NOT NULL,
  entity        text NOT NULL,
  entity_id     text,
  old_value     text,
  new_value     text,
  reason        text,
  device        text,
  ip            inet
);
CREATE INDEX audit_at_idx ON audit_log (company_id, at DESC);
CREATE INDEX audit_entity_idx ON audit_log (entity, entity_id);

CREATE FUNCTION trg_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();
