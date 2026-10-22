CREATE TABLE deletion_recovery_origin (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  deployment_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  initialized_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(initialized_at))
);
INSERT INTO deletion_recovery_origin DEFAULT VALUES;

CREATE TABLE deletion_journal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  event text NOT NULL CHECK (event IN (
    'document_erased','recording_erased','recording_expiry_bound',
    'chat_thread_erased','chat_turn_erased','account_revoked','membership_revoked',
    'workspace_erased','workspace_retention_bound','job_erased','job_audio_erased',
    'staging_object_erased','verified_object_erased'
  )),
  resource_id uuid NOT NULL,
  workspace_id uuid,
  expires_at timestamptz CHECK (isfinite(expires_at)),
  retention_days integer CHECK (retention_days BETWEEN 0 AND 7),
  processing_days integer CHECK (processing_days BETWEEN 1 AND 30),
  reason text CHECK (reason IN ('user','document','revoked','retention')),
  CHECK ((event='membership_revoked')=(workspace_id IS NOT NULL)),
  CHECK ((event='recording_expiry_bound')=(expires_at IS NOT NULL)),
  CHECK ((event='workspace_retention_bound')=(retention_days IS NOT NULL)),
  CHECK ((event='workspace_retention_bound')=(processing_days IS NOT NULL)),
  CHECK (reason IS NULL OR event='recording_erased')
);
CREATE INDEX deletion_journal_transaction ON deletion_journal(transaction_id);
CREATE INDEX deletion_journal_resource ON deletion_journal(event,resource_id);

CREATE FUNCTION write_deletion_intent(
  p_event text,p_id uuid,p_workspace uuid DEFAULT NULL,
  p_expires timestamptz DEFAULT NULL,p_retention integer DEFAULT NULL,
  p_processing integer DEFAULT NULL,p_reason text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO deletion_journal(event,resource_id,workspace_id,expires_at,retention_days,processing_days,reason)
  VALUES(p_event,p_id,p_workspace,p_expires,p_retention,p_processing,p_reason);
END;
$$;

CREATE FUNCTION capture_deletion_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='users' THEN
    IF TG_OP='DELETE' THEN
      PERFORM write_deletion_intent('account_revoked',OLD.id);
    ELSIF TG_OP='INSERT' THEN
      IF NOT NEW.active THEN PERFORM write_deletion_intent('account_revoked',NEW.id); END IF;
    ELSIF OLD.active AND NOT NEW.active THEN
      PERFORM write_deletion_intent('account_revoked',NEW.id);
    END IF;
  ELSIF TG_TABLE_NAME='memberships' THEN
    IF TG_OP='DELETE' THEN
      PERFORM write_deletion_intent('membership_revoked',OLD.user_id,OLD.workspace_id);
    ELSIF TG_OP='INSERT' THEN
      IF NOT NEW.active THEN PERFORM write_deletion_intent('membership_revoked',NEW.user_id,NEW.workspace_id); END IF;
    ELSIF OLD.active AND NOT NEW.active THEN
      PERFORM write_deletion_intent('membership_revoked',NEW.user_id,NEW.workspace_id);
    END IF;
  ELSIF TG_TABLE_NAME='documents' THEN
    IF TG_OP='DELETE' THEN
      PERFORM write_deletion_intent('document_erased',OLD.id);
    ELSIF TG_OP='INSERT' THEN
      IF NEW.deleted_at IS NOT NULL THEN PERFORM write_deletion_intent('document_erased',NEW.id); END IF;
    ELSIF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      PERFORM write_deletion_intent('document_erased',NEW.id);
    END IF;
  ELSIF TG_TABLE_NAME='recordings' THEN
    IF TG_OP='DELETE' THEN
      PERFORM write_deletion_intent('recording_erased',OLD.id,p_reason=>OLD.deletion_reason);
    ELSIF TG_OP='INSERT' THEN
      IF NEW.deleted_at IS NOT NULL THEN
        PERFORM write_deletion_intent('recording_erased',NEW.id,p_reason=>NEW.deletion_reason);
      ELSE
        PERFORM write_deletion_intent('recording_expiry_bound',NEW.id,p_expires=>NEW.retention_expires_at);
      END IF;
    ELSIF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      PERFORM write_deletion_intent('recording_erased',NEW.id,p_reason=>NEW.deletion_reason);
    ELSIF NEW.deleted_at IS NULL AND NEW.retention_expires_at<OLD.retention_expires_at THEN
      PERFORM write_deletion_intent('recording_expiry_bound',NEW.id,p_expires=>NEW.retention_expires_at);
    END IF;
  ELSIF TG_TABLE_NAME='recording_objects' THEN
    IF TG_OP='DELETE' THEN
      PERFORM write_deletion_intent(OLD.kind||'_object_erased',OLD.id);
    ELSIF TG_OP='INSERT' THEN
      IF NEW.deleted_at IS NOT NULL OR NEW.cleanup_token>0 THEN
        PERFORM write_deletion_intent(NEW.kind||'_object_erased',NEW.id);
      END IF;
    ELSIF (OLD.cleanup_token=0 AND NEW.cleanup_token>0)
      OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND OLD.cleanup_token=0) THEN
      PERFORM write_deletion_intent(NEW.kind||'_object_erased',NEW.id);
    END IF;
  ELSIF TG_TABLE_NAME='jobs' THEN
    IF TG_OP='DELETE' THEN
      PERFORM write_deletion_intent('job_erased',OLD.id);
    ELSIF OLD.audio IS NOT NULL AND NEW.audio IS NULL THEN
      PERFORM write_deletion_intent('job_audio_erased',NEW.id);
    END IF;
  ELSIF TG_TABLE_NAME='chat_threads' THEN
    PERFORM write_deletion_intent('chat_thread_erased',OLD.id);
  ELSIF TG_TABLE_NAME='chat_turns' THEN
    PERFORM write_deletion_intent('chat_turn_erased',OLD.id);
  ELSIF TG_TABLE_NAME='workspaces' THEN
    IF TG_OP='DELETE' THEN
      PERFORM write_deletion_intent('workspace_erased',OLD.id);
    ELSIF TG_OP='INSERT' THEN
      PERFORM write_deletion_intent('workspace_retention_bound',NEW.id,
        p_retention=>NEW.audio_retention_days,p_processing=>NEW.audio_processing_days);
    ELSIF NEW.audio_retention_days<OLD.audio_retention_days OR NEW.audio_processing_days<OLD.audio_processing_days THEN
      PERFORM write_deletion_intent('workspace_retention_bound',NEW.id,
        p_retention=>NEW.audio_retention_days,p_processing=>NEW.audio_processing_days);
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER deletion_recovery AFTER INSERT OR UPDATE OF active OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION capture_deletion_intent();
CREATE TRIGGER deletion_recovery AFTER INSERT OR UPDATE OF active OR DELETE ON memberships FOR EACH ROW EXECUTE FUNCTION capture_deletion_intent();
CREATE TRIGGER deletion_recovery AFTER INSERT OR UPDATE OF deleted_at OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION capture_deletion_intent();
CREATE TRIGGER deletion_recovery AFTER INSERT OR UPDATE OF deleted_at,retention_expires_at OR DELETE ON recordings FOR EACH ROW EXECUTE FUNCTION capture_deletion_intent();
CREATE TRIGGER deletion_recovery AFTER INSERT OR UPDATE OF cleanup_token,deleted_at OR DELETE ON recording_objects FOR EACH ROW EXECUTE FUNCTION capture_deletion_intent();
CREATE TRIGGER deletion_recovery AFTER UPDATE OF audio OR DELETE ON jobs FOR EACH ROW EXECUTE FUNCTION capture_deletion_intent();
CREATE TRIGGER deletion_recovery AFTER DELETE ON chat_threads FOR EACH ROW EXECUTE FUNCTION capture_deletion_intent();
CREATE TRIGGER deletion_recovery AFTER DELETE ON chat_turns FOR EACH ROW EXECUTE FUNCTION capture_deletion_intent();
CREATE TRIGGER deletion_recovery AFTER INSERT OR UPDATE OF audio_retention_days,audio_processing_days OR DELETE ON workspaces FOR EACH ROW EXECUTE FUNCTION capture_deletion_intent();

INSERT INTO deletion_journal(event,resource_id) SELECT 'document_erased',id FROM documents WHERE deleted_at IS NOT NULL;
INSERT INTO deletion_journal(event,resource_id,reason) SELECT 'recording_erased',id,deletion_reason FROM recordings WHERE deleted_at IS NOT NULL;
INSERT INTO deletion_journal(event,resource_id,expires_at) SELECT 'recording_expiry_bound',id,retention_expires_at FROM recordings WHERE deleted_at IS NULL;
INSERT INTO deletion_journal(event,resource_id) SELECT 'account_revoked',id FROM users WHERE NOT active;
INSERT INTO deletion_journal(event,resource_id,workspace_id) SELECT 'membership_revoked',user_id,workspace_id FROM memberships WHERE NOT active;
INSERT INTO deletion_journal(event,resource_id,retention_days,processing_days)
  SELECT 'workspace_retention_bound',id,audio_retention_days,audio_processing_days FROM workspaces;
INSERT INTO deletion_journal(event,resource_id)
  SELECT kind||'_object_erased',id FROM recording_objects WHERE deleted_at IS NOT NULL OR cleanup_token>0;
INSERT INTO deletion_journal(event,resource_id) SELECT 'job_audio_erased',id FROM jobs WHERE kind='transcription' AND audio IS NULL;

CREATE FUNCTION reject_deletion_journal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'deletion_journal_immutable';
END;
$$;
CREATE TRIGGER deletion_journal_immutable BEFORE UPDATE OR DELETE ON deletion_journal FOR EACH ROW EXECUTE FUNCTION reject_deletion_journal_mutation();
CREATE TRIGGER deletion_journal_immutable_truncate BEFORE TRUNCATE ON deletion_journal FOR EACH STATEMENT EXECUTE FUNCTION reject_deletion_journal_mutation();
CREATE TRIGGER deletion_origin_immutable BEFORE UPDATE OR DELETE ON deletion_recovery_origin FOR EACH ROW EXECUTE FUNCTION reject_deletion_journal_mutation();
CREATE TRIGGER deletion_origin_immutable_truncate BEFORE TRUNCATE ON deletion_recovery_origin FOR EACH STATEMENT EXECUTE FUNCTION reject_deletion_journal_mutation();
