ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('summary','transcription','recording_transcription'));
ALTER TABLE jobs ADD COLUMN progress jsonb;
CREATE INDEX jobs_recording_source ON jobs ((input->>'recording_id')) WHERE kind='recording_transcription';

CREATE TABLE recording_transcription_runs (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('azure','fixture')),
  configuration_version text NOT NULL,
  completed_chunks integer NOT NULL DEFAULT 0 CHECK (completed_chunks BETWEEN 0 AND 10000),
  segment_count integer NOT NULL DEFAULT 0 CHECK (segment_count BETWEEN 0 AND 100000),
  text_bytes integer NOT NULL DEFAULT 0 CHECK (text_bytes BETWEEN 0 AND 8000000),
  usage jsonb NOT NULL,
  uncertain_requests integer NOT NULL DEFAULT 0 CHECK (uncertain_requests >= 0),
  pending_chunk uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE recording_transcription_chunks (
  job_id uuid NOT NULL REFERENCES recording_transcription_runs(job_id) ON DELETE CASCADE,
  chunk_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 9999),
  segments jsonb NOT NULL,
  PRIMARY KEY(job_id,chunk_id),
  UNIQUE(job_id,ordinal)
);

ALTER TABLE transcript_revisions
  ADD COLUMN candidate boolean NOT NULL DEFAULT false,
  ADD COLUMN based_on_revision integer CHECK (based_on_revision >= 0),
  ADD COLUMN recording_metadata jsonb,
  ADD COLUMN timeline_count integer NOT NULL DEFAULT 0 CHECK (timeline_count BETWEEN 0 AND 20000);
CREATE TABLE transcript_timeline (
  document_id uuid NOT NULL,
  revision integer NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 19999),
  entry jsonb NOT NULL,
  PRIMARY KEY(document_id,revision,position),
  FOREIGN KEY(document_id,revision) REFERENCES transcript_revisions(document_id,revision) ON DELETE CASCADE
);
CREATE TABLE transcript_applications (
  document_id uuid NOT NULL,
  request_key text NOT NULL,
  request_hash text NOT NULL,
  revision integer NOT NULL,
  PRIMARY KEY(document_id,request_key),
  FOREIGN KEY(document_id,revision) REFERENCES transcript_revisions(document_id,revision) ON DELETE CASCADE
);
