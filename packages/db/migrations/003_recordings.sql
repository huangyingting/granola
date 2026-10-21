CREATE TABLE recordings (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  source_created_at timestamptz NOT NULL,
  tracks jsonb NOT NULL,
  create_key text NOT NULL,
  create_hash text NOT NULL,
  seal jsonb,
  seal_hash text,
  seal_key text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, create_key),
  FOREIGN KEY (document_id, workspace_id, owner_id) REFERENCES documents(id, workspace_id, owner_id),
  CHECK ((seal IS NULL) = (seal_hash IS NULL)),
  CHECK ((seal IS NULL) = (seal_key IS NULL))
);
CREATE INDEX recordings_document ON recordings(document_id, created_at, id);
CREATE INDEX recordings_owner ON recordings(owner_id, deleted_at);

CREATE TABLE recording_objects (
  id uuid PRIMARY KEY,
  recording_id uuid NOT NULL REFERENCES recordings(id),
  chunk_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('staging', 'verified')),
  request_key text,
  upload_expires timestamptz,
  protected_until timestamptz NOT NULL,
  cleanup_token integer NOT NULL DEFAULT 0,
  cleanup_until timestamptz,
  cleanup_after timestamptz NOT NULL,
  deleted_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, recording_id),
  UNIQUE (chunk_id, kind, request_key)
);
CREATE INDEX recording_objects_cleanup ON recording_objects(cleanup_after, protected_until);
CREATE INDEX recording_objects_recording ON recording_objects(recording_id);

CREATE TABLE recording_chunks (
  id uuid PRIMARY KEY,
  recording_id uuid NOT NULL REFERENCES recordings(id),
  track_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 0 AND sequence < 10000),
  sample_start bigint NOT NULL CHECK (sample_start >= 0),
  sample_count integer NOT NULL CHECK (sample_count > 0 AND sample_count <= 480000),
  descriptor jsonb NOT NULL,
  request_key text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'checking', 'verified')),
  verified_object uuid,
  verification_token integer NOT NULL DEFAULT 0,
  verification_until timestamptz,
  UNIQUE (recording_id, request_key),
  UNIQUE (recording_id, track_id, sequence),
  FOREIGN KEY (verified_object, recording_id) REFERENCES recording_objects(id, recording_id),
  CHECK ((state = 'verified') = (verified_object IS NOT NULL))
);
CREATE INDEX recording_chunks_verified ON recording_chunks(verified_object) WHERE verified_object IS NOT NULL;
CREATE TABLE recording_completions (
  chunk_id uuid NOT NULL REFERENCES recording_chunks(id) ON DELETE CASCADE,
  request_key text NOT NULL,
  upload_id uuid NOT NULL REFERENCES recording_objects(id),
  PRIMARY KEY (chunk_id, request_key)
);
