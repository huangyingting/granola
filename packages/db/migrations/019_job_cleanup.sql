CREATE TABLE job_cleanup_cursor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  job_id uuid
);
INSERT INTO job_cleanup_cursor(singleton,job_id) VALUES(true,NULL);

ALTER TABLE recording_transcription_runs ADD COLUMN retired_at timestamptz;
ALTER TABLE summary_runs ADD COLUMN retired_at timestamptz;
