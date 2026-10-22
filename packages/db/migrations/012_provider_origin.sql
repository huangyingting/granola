ALTER TABLE jobs ADD COLUMN origin_request_id uuid;
ALTER TABLE chat_turns ADD COLUMN origin_request_id uuid;
ALTER TABLE live_leases ADD COLUMN origin_request_id uuid;

ALTER TABLE jobs ALTER COLUMN origin_request_id SET DEFAULT
  ((nullif(current_setting('notes.audit_context',true),'')::jsonb)->>'request_id')::uuid;
ALTER TABLE chat_turns ALTER COLUMN origin_request_id SET DEFAULT
  ((nullif(current_setting('notes.audit_context',true),'')::jsonb)->>'request_id')::uuid;
ALTER TABLE live_leases ALTER COLUMN origin_request_id SET DEFAULT
  ((nullif(current_setting('notes.audit_context',true),'')::jsonb)->>'request_id')::uuid;
