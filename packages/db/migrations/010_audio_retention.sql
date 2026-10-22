ALTER TABLE workspaces
  ADD COLUMN audio_retention_days integer NOT NULL DEFAULT 7 CHECK (audio_retention_days BETWEEN 0 AND 7),
  ADD COLUMN audio_processing_days integer NOT NULL DEFAULT 30 CHECK (audio_processing_days BETWEEN 1 AND 30);

ALTER TABLE recordings
  ADD COLUMN retention_started_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN retention_days integer NOT NULL DEFAULT 7 CHECK (retention_days BETWEEN 0 AND 7),
  ADD COLUMN retention_expires_at timestamptz NOT NULL DEFAULT now() + interval '720 hours',
  ADD COLUMN canonical_transcript_at timestamptz,
  ADD COLUMN deletion_reason text CHECK (deletion_reason IN ('user','document','revoked','retention'));

UPDATE recordings r SET canonical_transcript_at=now(),
  retention_expires_at=now()+interval '168 hours'
WHERE r.deleted_at IS NULL AND EXISTS (
  SELECT 1 FROM transcript_revisions t WHERE t.document_id=r.document_id AND NOT t.candidate
  AND t.recording_metadata->>'id'=r.id::text
  AND t.recording_metadata->>'seal_sha256'=r.seal_hash
);
CREATE INDEX recordings_retention ON recordings(retention_expires_at,id) WHERE deleted_at IS NULL;
