CREATE TABLE ai_usage_accounts (
  owner_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  limits jsonb NOT NULL CHECK (jsonb_typeof(limits) = 'object')
);
CREATE TABLE ai_usage_periods (
  owner_id uuid NOT NULL REFERENCES ai_usage_accounts(owner_id) ON DELETE CASCADE,
  period_start date NOT NULL CHECK (extract(day FROM period_start) = 1),
  settled jsonb NOT NULL CHECK (jsonb_typeof(settled) = 'object'),
  uncertain jsonb NOT NULL CHECK (jsonb_typeof(uncertain) = 'object'),
  settled_requests bigint NOT NULL DEFAULT 0 CHECK (settled_requests >= 0),
  uncertain_requests bigint NOT NULL DEFAULT 0 CHECK (uncertain_requests >= 0),
  PRIMARY KEY (owner_id,period_start)
);
CREATE TABLE ai_usage_calls (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  period_start date NOT NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  lease_token bigint NOT NULL CHECK (lease_token > 0),
  operation text NOT NULL CHECK (length(operation) BETWEEN 1 AND 80),
  provider text NOT NULL CHECK (provider IN ('azure','fixture')),
  configuration_version text NOT NULL CHECK (length(configuration_version) BETWEEN 1 AND 200),
  reserved jsonb NOT NULL CHECK (jsonb_typeof(reserved) = 'object'),
  actual jsonb CHECK (actual IS NULL OR jsonb_typeof(actual) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  FOREIGN KEY (owner_id,period_start) REFERENCES ai_usage_periods(owner_id,period_start) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE (job_id,lease_token,operation),
  CHECK ((actual IS NULL) = (settled_at IS NULL))
);
CREATE INDEX ai_usage_calls_period ON ai_usage_calls(owner_id,period_start);
