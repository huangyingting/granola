CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  action text NOT NULL CHECK (action IN (
    'account_created','account_access_changed','account_deleted','membership_access_changed',
    'document_created','document_updated','document_deleted','transcript_published',
    'recording_created','recording_sealed','recording_access_revoked','object_cleanup_confirmed',
    'job_created','job_state_changed','job_lease_replaced',
    'chat_thread_created','chat_thread_deleted','chat_turn_created','chat_turn_state_changed',
    'chat_dispatch_started','chat_turn_deleted','usage_limits_changed','usage_reserved','usage_settled',
    'retention_policy_changed','live_lease_opened','live_lease_closed','live_lease_deleted'
  )),
  resource_type text NOT NULL CHECK (resource_type IN (
    'account','membership','document','recording','object','job','chat_thread','chat_turn',
    'usage_account','usage_call','workspace','live_lease'
  )),
  resource_id uuid NOT NULL,
  workspace_id uuid,
  subject_owner_id uuid,
  document_id uuid,
  job_id uuid,
  turn_id uuid,
  actor_id uuid,
  request_id uuid,
  source text NOT NULL CHECK (source IN ('api','worker','deployment','system')),
  from_state text CHECK (from_state IN (
    'queued','running','retry_wait','succeeded','failed','cancelled','pending','sending','settled','expired'
  )),
  to_state text CHECK (to_state IN (
    'queued','running','retry_wait','succeeded','failed','cancelled','pending','sending','settled','expired'
  )),
  active boolean,
  revision integer CHECK (revision>=0),
  reason text CHECK (reason IN ('user','document','revoked','retention'))
);
CREATE INDEX audit_events_retention ON audit_events(created_at,id);
CREATE INDEX audit_events_request ON audit_events(request_id,id) WHERE request_id IS NOT NULL;
CREATE INDEX audit_events_resource ON audit_events(resource_type,resource_id,id);

CREATE FUNCTION write_audit_event(
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
    document_id,job_id,turn_id,actor_id,request_id,source,from_state,to_state,active,revision,reason)
  VALUES(p_action,p_kind,p_id,p_workspace,p_owner,p_document,
    coalesce(p_job,(context->>'job_id')::uuid),coalesce(p_turn,(context->>'turn_id')::uuid),
    (context->>'actor_id')::uuid,(context->>'request_id')::uuid,
    coalesce(context->>'source','system'),p_before,p_after,p_active,p_revision,p_reason);
END;
$$;

CREATE FUNCTION audit_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  workspace uuid;
  document uuid;
  owner uuid;
BEGIN
  IF TG_TABLE_NAME='users' THEN
    IF TG_OP='DELETE' THEN
      PERFORM write_audit_event('account_deleted','account',OLD.id,p_owner=>OLD.id);
    ELSIF TG_OP='INSERT' THEN
      PERFORM write_audit_event('account_created','account',NEW.id,p_owner=>NEW.id,p_active=>NEW.active);
    ELSIF OLD.active IS DISTINCT FROM NEW.active THEN
      PERFORM write_audit_event('account_access_changed','account',NEW.id,p_owner=>NEW.id,p_active=>NEW.active);
    END IF;
  ELSIF TG_TABLE_NAME='memberships' THEN
    IF TG_OP='DELETE' THEN
      PERFORM write_audit_event('membership_access_changed','membership',OLD.user_id,OLD.workspace_id,OLD.user_id,p_active=>false);
    ELSIF TG_OP='INSERT' THEN
      PERFORM write_audit_event('membership_access_changed','membership',NEW.user_id,NEW.workspace_id,NEW.user_id,p_active=>NEW.active);
    ELSIF OLD.active IS DISTINCT FROM NEW.active THEN
      PERFORM write_audit_event('membership_access_changed','membership',NEW.user_id,NEW.workspace_id,NEW.user_id,p_active=>NEW.active);
    END IF;
  ELSIF TG_TABLE_NAME='documents' THEN
    IF TG_OP='INSERT' THEN
      PERFORM write_audit_event('document_created','document',NEW.id,NEW.workspace_id,NEW.owner_id,NEW.id,p_revision=>NEW.revision);
    ELSIF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      PERFORM write_audit_event('document_deleted','document',NEW.id,NEW.workspace_id,NEW.owner_id,NEW.id);
    ELSE
      IF OLD.revision IS DISTINCT FROM NEW.revision THEN
        PERFORM write_audit_event('document_updated','document',NEW.id,NEW.workspace_id,NEW.owner_id,NEW.id,p_revision=>NEW.revision);
      END IF;
      IF OLD.transcript_revision IS DISTINCT FROM NEW.transcript_revision THEN
        PERFORM write_audit_event('transcript_published','document',NEW.id,NEW.workspace_id,NEW.owner_id,NEW.id,p_revision=>NEW.transcript_revision);
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='recordings' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.deleted_at IS NULL THEN
        PERFORM write_audit_event('recording_created','recording',NEW.id,NEW.workspace_id,NEW.owner_id,NEW.document_id);
      ELSE
        PERFORM write_audit_event('recording_access_revoked','recording',NEW.id,NEW.workspace_id,NEW.owner_id,NEW.document_id,p_reason=>NEW.deletion_reason);
      END IF;
    ELSE
      IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        PERFORM write_audit_event('recording_access_revoked','recording',NEW.id,NEW.workspace_id,NEW.owner_id,NEW.document_id,p_reason=>NEW.deletion_reason);
      END IF;
      IF OLD.seal_hash IS NULL AND NEW.seal_hash IS NOT NULL THEN
        PERFORM write_audit_event('recording_sealed','recording',NEW.id,NEW.workspace_id,NEW.owner_id,NEW.document_id);
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='recording_objects' THEN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      SELECT r.workspace_id,r.document_id,r.owner_id INTO workspace,document,owner FROM recordings r WHERE r.id=NEW.recording_id;
      PERFORM write_audit_event('object_cleanup_confirmed','object',NEW.id,workspace,owner,document);
    END IF;
  ELSIF TG_TABLE_NAME='jobs' THEN
    IF TG_OP='INSERT' THEN
      PERFORM write_audit_event('job_created','job',NEW.id,NEW.workspace_id,NEW.owner_id,NEW.document_id,NEW.id,p_after=>NEW.state);
    ELSIF OLD.state IS DISTINCT FROM NEW.state THEN
      PERFORM write_audit_event('job_state_changed','job',NEW.id,NEW.workspace_id,NEW.owner_id,NEW.document_id,NEW.id,p_before=>OLD.state,p_after=>NEW.state);
    ELSIF NEW.state='running' AND OLD.lease_token IS DISTINCT FROM NEW.lease_token THEN
      PERFORM write_audit_event('job_lease_replaced','job',NEW.id,NEW.workspace_id,NEW.owner_id,NEW.document_id,NEW.id,p_before=>OLD.state,p_after=>NEW.state);
    END IF;
  ELSIF TG_TABLE_NAME='chat_threads' THEN
    IF TG_OP='DELETE' THEN
      SELECT d.workspace_id INTO workspace FROM documents d WHERE d.id=OLD.document_id;
      PERFORM write_audit_event('chat_thread_deleted','chat_thread',OLD.id,workspace,OLD.owner_id,OLD.document_id);
    ELSE
      SELECT d.workspace_id INTO workspace FROM documents d WHERE d.id=NEW.document_id;
      PERFORM write_audit_event('chat_thread_created','chat_thread',NEW.id,workspace,NEW.owner_id,NEW.document_id);
    END IF;
  ELSIF TG_TABLE_NAME='chat_turns' THEN
    IF TG_OP='DELETE' THEN
      SELECT d.workspace_id INTO workspace FROM documents d WHERE d.id=OLD.document_id;
      PERFORM write_audit_event('chat_turn_deleted','chat_turn',OLD.id,workspace,OLD.owner_id,OLD.document_id,p_turn=>OLD.id);
    ELSE
      SELECT d.workspace_id INTO workspace FROM documents d WHERE d.id=NEW.document_id;
      IF TG_OP='INSERT' THEN
        PERFORM write_audit_event('chat_turn_created','chat_turn',NEW.id,workspace,NEW.owner_id,NEW.document_id,p_turn=>NEW.id,p_after=>NEW.state);
      ELSIF OLD.state IS DISTINCT FROM NEW.state THEN
        PERFORM write_audit_event('chat_turn_state_changed','chat_turn',NEW.id,workspace,NEW.owner_id,NEW.document_id,p_turn=>NEW.id,p_before=>OLD.state,p_after=>NEW.state);
      ELSIF OLD.dispatch IS DISTINCT FROM NEW.dispatch AND NEW.dispatch='sending' THEN
        PERFORM write_audit_event('chat_dispatch_started','chat_turn',NEW.id,workspace,NEW.owner_id,NEW.document_id,p_turn=>NEW.id,p_before=>OLD.dispatch,p_after=>NEW.dispatch);
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='ai_usage_accounts' THEN
    IF TG_OP='INSERT' THEN
      PERFORM write_audit_event('usage_limits_changed','usage_account',NEW.owner_id,p_owner=>NEW.owner_id);
    ELSIF OLD.limits IS DISTINCT FROM NEW.limits THEN
      PERFORM write_audit_event('usage_limits_changed','usage_account',NEW.owner_id,p_owner=>NEW.owner_id);
    END IF;
  ELSIF TG_TABLE_NAME='ai_usage_calls' THEN
    IF NEW.job_id IS NOT NULL THEN
      SELECT j.workspace_id,j.document_id INTO workspace,document FROM jobs j WHERE j.id=NEW.job_id;
    ELSIF NEW.chat_turn_id IS NOT NULL THEN
      SELECT d.workspace_id,t.document_id INTO workspace,document FROM chat_turns t JOIN documents d ON d.id=t.document_id WHERE t.id=NEW.chat_turn_id;
    ELSIF NEW.live_lease_id IS NOT NULL THEN
      SELECT s.workspace_id,l.document_id INTO workspace,document FROM live_leases l JOIN live_sources s ON s.id=l.source_id WHERE l.id=NEW.live_lease_id;
    END IF;
    IF TG_OP='INSERT' THEN
      PERFORM write_audit_event('usage_reserved','usage_call',NEW.id,workspace,NEW.owner_id,document,NEW.job_id,NEW.chat_turn_id);
    ELSIF OLD.settled_at IS NULL AND NEW.settled_at IS NOT NULL THEN
      PERFORM write_audit_event('usage_settled','usage_call',NEW.id,workspace,NEW.owner_id,document,NEW.job_id,NEW.chat_turn_id);
    END IF;
  ELSIF TG_TABLE_NAME='workspaces' THEN
    IF OLD.audio_retention_days IS DISTINCT FROM NEW.audio_retention_days OR OLD.audio_processing_days IS DISTINCT FROM NEW.audio_processing_days THEN
      PERFORM write_audit_event('retention_policy_changed','workspace',NEW.id,NEW.id);
    END IF;
  ELSIF TG_TABLE_NAME='live_leases' THEN
    IF TG_OP='DELETE' THEN
      SELECT d.workspace_id INTO workspace FROM documents d WHERE d.id=OLD.document_id;
      PERFORM write_audit_event('live_lease_deleted','live_lease',OLD.id,workspace,OLD.owner_id,OLD.document_id,p_before=>OLD.close_code);
    ELSE
      SELECT s.workspace_id INTO workspace FROM live_sources s WHERE s.id=NEW.source_id;
      IF TG_OP='INSERT' THEN
        PERFORM write_audit_event('live_lease_opened','live_lease',NEW.id,workspace,NEW.owner_id,NEW.document_id);
      ELSIF OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL THEN
        PERFORM write_audit_event('live_lease_closed','live_lease',NEW.id,workspace,NEW.owner_id,NEW.document_id,p_after=>NEW.close_code);
      END IF;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER lifecycle_audit AFTER INSERT OR UPDATE OF active OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION audit_lifecycle();
CREATE TRIGGER lifecycle_audit AFTER INSERT OR UPDATE OF active OR DELETE ON memberships FOR EACH ROW EXECUTE FUNCTION audit_lifecycle();
CREATE TRIGGER lifecycle_audit AFTER INSERT OR UPDATE OF revision,transcript_revision,deleted_at ON documents FOR EACH ROW EXECUTE FUNCTION audit_lifecycle();
CREATE TRIGGER lifecycle_audit AFTER INSERT OR UPDATE OF seal_hash,deleted_at ON recordings FOR EACH ROW EXECUTE FUNCTION audit_lifecycle();
CREATE TRIGGER lifecycle_audit AFTER UPDATE OF deleted_at ON recording_objects FOR EACH ROW EXECUTE FUNCTION audit_lifecycle();
CREATE TRIGGER lifecycle_audit AFTER INSERT OR UPDATE OF state,lease_token ON jobs FOR EACH ROW EXECUTE FUNCTION audit_lifecycle();
CREATE TRIGGER lifecycle_audit AFTER INSERT OR DELETE ON chat_threads FOR EACH ROW EXECUTE FUNCTION audit_lifecycle();
CREATE TRIGGER lifecycle_audit AFTER INSERT OR UPDATE OF state,dispatch OR DELETE ON chat_turns FOR EACH ROW EXECUTE FUNCTION audit_lifecycle();
CREATE TRIGGER lifecycle_audit AFTER INSERT OR UPDATE OF limits ON ai_usage_accounts FOR EACH ROW EXECUTE FUNCTION audit_lifecycle();
CREATE TRIGGER lifecycle_audit AFTER INSERT OR UPDATE OF settled_at ON ai_usage_calls FOR EACH ROW EXECUTE FUNCTION audit_lifecycle();
CREATE TRIGGER lifecycle_audit AFTER UPDATE OF audio_retention_days,audio_processing_days ON workspaces FOR EACH ROW EXECUTE FUNCTION audit_lifecycle();
CREATE TRIGGER lifecycle_audit AFTER INSERT OR UPDATE OF closed_at OR DELETE ON live_leases FOR EACH ROW EXECUTE FUNCTION audit_lifecycle();
