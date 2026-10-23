ALTER TABLE audit_events ADD COLUMN job_kind text;
-- Existing entries remain NULL; avoid scanning retained history to validate them.
ALTER TABLE audit_events ADD CONSTRAINT audit_events_job_kind_check CHECK (
  job_kind IS NULL OR (
    resource_type='job' AND job_kind IN ('summary','transcription','recording_transcription')
  )
) NOT VALID;

CREATE OR REPLACE FUNCTION write_audit_event(
  p_action text,p_kind text,p_id uuid,p_workspace uuid DEFAULT NULL,
  p_owner uuid DEFAULT NULL,p_document uuid DEFAULT NULL,
  p_job uuid DEFAULT NULL,p_turn uuid DEFAULT NULL,
  p_before text DEFAULT NULL,p_after text DEFAULT NULL,
  p_active boolean DEFAULT NULL,p_revision integer DEFAULT NULL,p_reason text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  context jsonb := coalesce(nullif(current_setting('notes.audit_context',true),'')::jsonb,'{}'::jsonb);
BEGIN
  INSERT INTO audit_events(action,resource_type,resource_id,workspace_id,subject_owner_id,
    document_id,job_id,turn_id,actor_id,request_id,source,from_state,to_state,active,revision,reason,job_kind)
  VALUES(p_action,p_kind,p_id,p_workspace,p_owner,p_document,
    coalesce(p_job,(context->>'job_id')::uuid),coalesce(p_turn,(context->>'turn_id')::uuid),
    (context->>'actor_id')::uuid,(context->>'request_id')::uuid,
    coalesce(context->>'source','system'),p_before,p_after,p_active,p_revision,p_reason,
    CASE WHEN p_kind='job' THEN (SELECT kind FROM jobs WHERE id=p_id) END);
END;
$$;
