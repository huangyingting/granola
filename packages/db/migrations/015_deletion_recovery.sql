CREATE TABLE deletion_recovery_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  verified_tip text CHECK(verified_tip ~ '^[0-9a-f]{64}$' AND length(verified_tip)=64),
  verified_generation numeric(20,0) CHECK(verified_generation BETWEEN 0 AND 18446744073709551615),
  verified_entry_references numeric(20,0) CHECK(verified_entry_references BETWEEN 0 AND 18446744073709551615),
  completed_at timestamptz CHECK(isfinite(completed_at)),
  usage_review_required boolean NOT NULL DEFAULT false,
  usage_proof_sha256 text CHECK(usage_proof_sha256 ~ '^[0-9a-f]{64}$' AND length(usage_proof_sha256)=64),
  CHECK((verified_tip IS NULL AND verified_generation IS NULL AND verified_entry_references IS NULL) OR
    (verified_tip IS NOT NULL AND verified_generation IS NOT NULL AND verified_entry_references IS NOT NULL)),
  CHECK(completed_at IS NULL OR verified_tip IS NOT NULL)
);
INSERT INTO deletion_recovery_state DEFAULT VALUES;

CREATE FUNCTION enforce_deletion_recovery_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_name text; expiry timestamptz; retention integer; processing integer;
BEGIN
  IF TG_TABLE_NAME='memberships' THEN
    IF NEW.active AND EXISTS(
      SELECT 1 FROM deletion_journal WHERE event='workspace_erased' AND resource_id=NEW.workspace_id
    ) THEN RAISE EXCEPTION 'deletion_recovery_fenced' USING ERRCODE='PDR01'; END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='documents' THEN event_name:='document_erased';
  ELSIF TG_TABLE_NAME='recordings' THEN event_name:='recording_erased';
  ELSIF TG_TABLE_NAME='chat_threads' THEN event_name:='chat_thread_erased';
  ELSIF TG_TABLE_NAME='chat_turns' THEN event_name:='chat_turn_erased';
  ELSIF TG_TABLE_NAME='jobs' THEN event_name:='job_erased';
  ELSIF TG_TABLE_NAME='workspaces' THEN event_name:='workspace_erased';
  ELSIF TG_TABLE_NAME='recording_objects' THEN event_name:=NEW.kind||'_object_erased';
  END IF;
  IF event_name IS NOT NULL AND EXISTS(
    SELECT 1 FROM deletion_journal WHERE event=event_name AND resource_id=NEW.id
  ) THEN
    RAISE EXCEPTION 'deletion_recovery_fenced' USING ERRCODE='PDR01';
  END IF;
  IF TG_TABLE_NAME='jobs' AND EXISTS(
    SELECT 1 FROM deletion_journal WHERE event='job_audio_erased' AND resource_id=NEW.id
  ) THEN RAISE EXCEPTION 'deletion_recovery_fenced' USING ERRCODE='PDR01'; END IF;
  IF TG_TABLE_NAME='documents' THEN
    IF EXISTS(
      SELECT 1 FROM deletion_journal WHERE event='workspace_erased' AND resource_id=NEW.workspace_id
    ) THEN RAISE EXCEPTION 'deletion_recovery_fenced' USING ERRCODE='PDR01'; END IF;
  END IF;
  IF TG_TABLE_NAME='recordings' THEN
    SELECT min(expires_at) INTO expiry FROM deletion_journal
      WHERE event='recording_expiry_bound' AND resource_id=NEW.id;
    IF expiry IS NOT NULL THEN NEW.retention_expires_at:=least(NEW.retention_expires_at,expiry); END IF;
  ELSIF TG_TABLE_NAME='workspaces' THEN
    SELECT min(retention_days),min(processing_days) INTO retention,processing
      FROM deletion_journal WHERE event='workspace_retention_bound' AND resource_id=NEW.id;
    IF retention IS NOT NULL THEN
      NEW.audio_retention_days:=least(NEW.audio_retention_days,retention);
      NEW.audio_processing_days:=least(NEW.audio_processing_days,processing);
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER deletion_recovery_fence BEFORE INSERT ON documents FOR EACH ROW EXECUTE FUNCTION enforce_deletion_recovery_fence();
CREATE TRIGGER deletion_recovery_fence BEFORE INSERT ON recordings FOR EACH ROW EXECUTE FUNCTION enforce_deletion_recovery_fence();
CREATE TRIGGER deletion_recovery_fence BEFORE INSERT ON recording_objects FOR EACH ROW EXECUTE FUNCTION enforce_deletion_recovery_fence();
CREATE TRIGGER deletion_recovery_fence BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION enforce_deletion_recovery_fence();
CREATE TRIGGER deletion_recovery_fence BEFORE INSERT ON chat_threads FOR EACH ROW EXECUTE FUNCTION enforce_deletion_recovery_fence();
CREATE TRIGGER deletion_recovery_fence BEFORE INSERT ON chat_turns FOR EACH ROW EXECUTE FUNCTION enforce_deletion_recovery_fence();
CREATE TRIGGER deletion_recovery_fence BEFORE INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION enforce_deletion_recovery_fence();
CREATE TRIGGER deletion_recovery_fence BEFORE INSERT OR UPDATE OF active ON memberships FOR EACH ROW EXECUTE FUNCTION enforce_deletion_recovery_fence();
