ALTER TABLE jobs ADD COLUMN summary_started boolean NOT NULL DEFAULT false;

CREATE TABLE summary_runs (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL CHECK (provider IN ('azure','fixture')),
  configuration_version text NOT NULL CHECK (length(configuration_version) BETWEEN 1 AND 200),
  pipeline_version text NOT NULL CHECK (length(pipeline_version) BETWEEN 1 AND 80),
  resume_token uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE summary_resumes (
  job_id uuid NOT NULL REFERENCES summary_runs(job_id) ON DELETE CASCADE,
  token uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,token)
);
CREATE TABLE summary_steps (
  job_id uuid NOT NULL REFERENCES summary_runs(job_id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN ('extract','merge','generate')),
  round integer NOT NULL CHECK (round BETWEEN 0 AND 8),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 19999),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  prompt_version text NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 80),
  citations jsonb NOT NULL CHECK (jsonb_typeof(citations)='array' AND jsonb_array_length(citations) BETWEEN 1 AND 4096),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','completed')),
  call_id uuid REFERENCES ai_usage_calls(id) ON DELETE SET NULL,
  lease_token bigint,
  output jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,phase,round,ordinal),
  CHECK ((state='completed') = (output IS NOT NULL)),
  CHECK (output IS NULL OR jsonb_typeof(output)='object'),
  CHECK ((phase='merge' AND round>0) OR (phase<>'merge' AND round=0)),
  CHECK (phase<>'generate' OR ordinal=0)
);
