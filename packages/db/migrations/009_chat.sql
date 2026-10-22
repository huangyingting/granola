CREATE TABLE chat_threads (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  last_position integer NOT NULL CHECK (last_position BETWEEN 1 AND 100000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,document_id,owner_id)
);
CREATE INDEX chat_threads_document ON chat_threads(document_id,created_at,id);
CREATE TABLE chat_turns (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL,
  document_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 100000),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (length(request_hash)=64),
  request jsonb NOT NULL CHECK (jsonb_typeof(request)='object'),
  evidence jsonb CHECK (evidence IS NULL OR jsonb_typeof(evidence)='object'),
  evidence_hash text NOT NULL CHECK (length(evidence_hash)=64),
  mode text NOT NULL CHECK (mode IN ('full','retrieved')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
  dispatch text NOT NULL DEFAULT 'pending' CHECK (dispatch IN ('pending','sending')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
  lease_token integer NOT NULL DEFAULT 0 CHECK (lease_token >= 0),
  lease_until timestamptz,
  provider text CHECK (provider IN ('azure','fixture')),
  configuration_version text CHECK (length(configuration_version) BETWEEN 1 AND 200),
  prompt_version text CHECK (length(prompt_version) BETWEEN 1 AND 80),
  call_id uuid,
  preview_text text CHECK (length(preview_text) <= 4000),
  preview_updates integer NOT NULL DEFAULT 0 CHECK (preview_updates BETWEEN 0 AND 80),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result)='object'),
  error jsonb CHECK (error IS NULL OR jsonb_typeof(error)='object'),
  resume_token uuid,
  event_seq integer NOT NULL DEFAULT 0 CHECK (event_seq >= 0),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (thread_id,document_id,owner_id) REFERENCES chat_threads(id,document_id,owner_id) ON DELETE CASCADE,
  UNIQUE (document_id,owner_id,idempotency_key),
  UNIQUE (thread_id,position),
  CHECK ((state='succeeded')=(result IS NOT NULL)),
  CHECK ((provider IS NULL)=(configuration_version IS NULL) AND (provider IS NULL)=(prompt_version IS NULL)),
  CHECK ((state='running')=(lease_until IS NOT NULL))
);
CREATE INDEX chat_turns_queue ON chat_turns(created_at,id) WHERE state IN ('queued','running');
CREATE INDEX chat_turns_owner_pending ON chat_turns(owner_id) WHERE state IN ('queued','running');
CREATE INDEX chat_turns_expiry ON chat_turns(expires_at) WHERE evidence IS NOT NULL AND state<>'succeeded';
CREATE TABLE chat_requests (
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (length(request_hash)=64),
  turn_id uuid REFERENCES chat_turns(id) ON DELETE SET NULL,
  PRIMARY KEY (document_id,owner_id,idempotency_key)
);
CREATE INDEX chat_requests_turn ON chat_requests(turn_id) WHERE turn_id IS NOT NULL;
CREATE TABLE chat_events (
  turn_id uuid NOT NULL REFERENCES chat_turns(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq > 0),
  event_type text NOT NULL CHECK (event_type IN ('turn.accepted','turn.progress','answer.completed','turn.failed','turn.cancelled')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (turn_id,seq)
);
CREATE INDEX chat_events_retention ON chat_events(created_at);
CREATE TABLE chat_resumes (
  turn_id uuid NOT NULL REFERENCES chat_turns(id) ON DELETE CASCADE,
  token uuid NOT NULL,
  PRIMARY KEY (turn_id,token)
);
ALTER TABLE ai_usage_calls DROP CONSTRAINT ai_usage_calls_request_kind_check;
ALTER TABLE ai_usage_calls DROP CONSTRAINT ai_usage_origin;
ALTER TABLE ai_usage_calls ADD COLUMN chat_turn_id uuid REFERENCES chat_turns(id) ON DELETE SET NULL;
ALTER TABLE ai_usage_calls ADD CONSTRAINT ai_usage_calls_request_kind_check CHECK (request_kind IN ('job','live','chat'));
ALTER TABLE ai_usage_calls ADD CONSTRAINT ai_usage_chat_operation CHECK (request_kind<>'chat' OR operation='question-answer');
ALTER TABLE ai_usage_calls ADD CONSTRAINT ai_usage_origin CHECK (
  (request_kind='job' AND live_lease_id IS NULL AND chat_turn_id IS NULL AND lease_token IS NOT NULL) OR
  (request_kind='live' AND job_id IS NULL AND chat_turn_id IS NULL AND lease_token IS NULL) OR
  (request_kind='chat' AND job_id IS NULL AND live_lease_id IS NULL AND lease_token IS NOT NULL)
);
CREATE UNIQUE INDEX ai_usage_calls_chat_dispatch ON ai_usage_calls(chat_turn_id,lease_token,operation) WHERE chat_turn_id IS NOT NULL;
ALTER TABLE chat_turns ADD FOREIGN KEY (call_id) REFERENCES ai_usage_calls(id) ON DELETE SET NULL;
