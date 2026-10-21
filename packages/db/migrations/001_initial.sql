CREATE TABLE users (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (issuer, subject)
);
CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES users(id),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE documents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  title text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  transcript_revision integer NOT NULL DEFAULT 0 CHECK (transcript_revision >= 0),
  create_key text NOT NULL,
  create_hash text NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, owner_id, create_key),
  UNIQUE (id, workspace_id, owner_id),
  FOREIGN KEY (workspace_id, owner_id) REFERENCES memberships(workspace_id, user_id)
);
CREATE TABLE note_versions (
  document_id uuid NOT NULL REFERENCES documents(id),
  revision integer NOT NULL,
  notes text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, revision)
);
CREATE TABLE transcript_revisions (
  document_id uuid NOT NULL REFERENCES documents(id),
  revision integer NOT NULL,
  source text NOT NULL CHECK (source IN ('manual', 'azure_speech_fast')),
  segments jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, revision)
);
CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('summary', 'transcription')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  input jsonb NOT NULL,
  audio bytea,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
  attempt integer NOT NULL DEFAULT 0,
  lease_token integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  result jsonb,
  error jsonb,
  event_seq integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, owner_id, kind, idempotency_key),
  FOREIGN KEY (document_id, workspace_id, owner_id) REFERENCES documents(id, workspace_id, owner_id),
  CHECK (audio IS NULL OR octet_length(audio) <= 1920044)
);
CREATE INDEX jobs_schedule ON jobs (available_at, created_at) WHERE state IN ('queued', 'running', 'retry_wait');
CREATE INDEX jobs_owner_pending ON jobs (owner_id) WHERE state IN ('queued', 'running', 'retry_wait');
CREATE TABLE job_events (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, seq)
);
