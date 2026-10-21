ALTER TABLE users ADD COLUMN live_access_epoch integer NOT NULL DEFAULT 1 CHECK (live_access_epoch > 0);
CREATE FUNCTION advance_live_access_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.active IS DISTINCT FROM NEW.active THEN
    NEW.live_access_epoch := OLD.live_access_epoch + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER live_access_epoch BEFORE UPDATE OF active ON users
  FOR EACH ROW EXECUTE FUNCTION advance_live_access_epoch();

CREATE TABLE live_sources (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  document_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  recording_id uuid NOT NULL,
  preview_id uuid NOT NULL,
  track_id uuid NOT NULL,
  capture_epoch uuid NOT NULL,
  next_sample integer CHECK (next_sample BETWEEN 0 AND 230400000),
  next_sequence integer CHECK (next_sequence BETWEEN 0 AND 288001),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id,owner_id,document_id),
  UNIQUE (owner_id,recording_id,preview_id,track_id,capture_epoch),
  FOREIGN KEY (document_id,workspace_id,owner_id) REFERENCES documents(id,workspace_id,owner_id) ON DELETE CASCADE,
  CHECK ((next_sample IS NULL) = (next_sequence IS NULL))
);
CREATE TABLE live_leases (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  document_id uuid NOT NULL,
  lease_token uuid NOT NULL,
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (length(request_hash)=64),
  locale text NOT NULL CHECK (locale IN ('en-US','zh-CN')),
  provider text NOT NULL CHECK (provider IN ('azure','fixture')),
  configuration_version text NOT NULL CHECK (length(configuration_version) BETWEEN 1 AND 200),
  membership_epoch integer NOT NULL CHECK (membership_epoch > 0),
  user_epoch integer NOT NULL CHECK (user_epoch > 0),
  access_expires_at timestamptz NOT NULL,
  lease_until timestamptz NOT NULL,
  deadline timestamptz NOT NULL,
  accepted_samples integer NOT NULL DEFAULT 0 CHECK (accepted_samples BETWEEN 0 AND 960000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  close_code text CHECK (close_code IN ('cancelled','failed','expired','settled')),
  FOREIGN KEY (source_id,owner_id,document_id) REFERENCES live_sources(id,owner_id,document_id) ON DELETE CASCADE,
  UNIQUE (owner_id,request_key),
  CHECK ((closed_at IS NULL) = (close_code IS NULL)),
  CHECK (lease_until <= deadline AND lease_until <= access_expires_at),
  CHECK (deadline <= created_at + interval '80 seconds')
);
CREATE UNIQUE INDEX live_leases_source_active ON live_leases(source_id) WHERE closed_at IS NULL;
CREATE INDEX live_leases_source ON live_leases(source_id);
CREATE INDEX live_leases_owner_active ON live_leases(owner_id) WHERE closed_at IS NULL;
CREATE INDEX live_leases_owner_created ON live_leases(owner_id,created_at);
CREATE INDEX live_leases_expiry ON live_leases(lease_until) WHERE closed_at IS NULL;
CREATE INDEX live_leases_retention ON live_leases(created_at) WHERE closed_at IS NOT NULL;
CREATE INDEX live_sources_retention ON live_sources(updated_at);
CREATE INDEX live_sources_document ON live_sources(document_id);

ALTER TABLE ai_usage_calls ALTER COLUMN lease_token DROP NOT NULL;
ALTER TABLE ai_usage_calls ADD COLUMN request_kind text NOT NULL DEFAULT 'job' CHECK (request_kind IN ('job','live'));
ALTER TABLE ai_usage_calls ADD COLUMN live_lease_id uuid REFERENCES live_leases(id) ON DELETE SET NULL;
ALTER TABLE ai_usage_calls ADD CONSTRAINT ai_usage_origin CHECK (
  (request_kind='job' AND live_lease_id IS NULL AND lease_token IS NOT NULL) OR
  (request_kind='live' AND job_id IS NULL AND lease_token IS NULL)
);
CREATE UNIQUE INDEX ai_usage_calls_live_dispatch ON ai_usage_calls(live_lease_id) WHERE live_lease_id IS NOT NULL;
