ALTER TABLE documents ADD COLUMN tags text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(tags) <= 16);
ALTER TABLE note_versions ADD COLUMN content jsonb;
ALTER TABLE workspaces ADD COLUMN sync_seq bigint NOT NULL DEFAULT 0 CHECK (sync_seq >= 0);
ALTER TABLE workspaces ADD COLUMN sync_floor bigint NOT NULL DEFAULT 0 CHECK (sync_floor >= 0 AND sync_floor <= sync_seq);
ALTER TABLE memberships ADD COLUMN sync_epoch integer NOT NULL DEFAULT 1 CHECK (sync_epoch > 0);
CREATE FUNCTION advance_membership_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.active IS DISTINCT FROM NEW.active THEN
    NEW.sync_epoch := OLD.sync_epoch + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER membership_epoch BEFORE UPDATE OF active ON memberships
  FOR EACH ROW EXECUTE FUNCTION advance_membership_epoch();
CREATE TABLE note_mutations (
  document_id uuid NOT NULL REFERENCES documents(id),
  operation text NOT NULL CHECK (operation IN ('notes','metadata')),
  mutation_id text NOT NULL,
  request_hash text NOT NULL,
  applied_revision integer NOT NULL CHECK (applied_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, operation, mutation_id)
);
-- Change metadata outlives purged resources; no meeting body is stored here.
CREATE TABLE sync_changes (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  seq bigint NOT NULL CHECK (seq > 0),
  owner_id uuid NOT NULL REFERENCES users(id),
  document_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('document','transcript','job','deleted')),
  revision integer NOT NULL CHECK (revision > 0),
  transcript_revision integer NOT NULL CHECK (transcript_revision >= 0),
  job_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, seq),
  CHECK ((kind = 'job') = (job_id IS NOT NULL))
);
CREATE INDEX sync_changes_owner ON sync_changes (workspace_id, owner_id, seq);
