ALTER TABLE deletion_journal ADD COLUMN publication_scope uuid;
ALTER TABLE deletion_journal ALTER COLUMN publication_scope SET DEFAULT
  nullif(current_setting('notes.deletion_scope',true),'')::uuid;
CREATE INDEX deletion_journal_publication_scope ON deletion_journal(publication_scope)
  WHERE publication_scope IS NOT NULL;

CREATE TABLE deletion_archive_binding (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  deployment_id uuid NOT NULL REFERENCES deletion_recovery_origin(deployment_id),
  archive_identity text NOT NULL CHECK(archive_identity ~ '^[0-9a-f]{64}$' AND length(archive_identity)=64),
  baseline_tip text NOT NULL CHECK(baseline_tip ~ '^[0-9a-f]{64}$' AND length(baseline_tip)=64),
  baseline_generation numeric(20,0) NOT NULL CHECK(baseline_generation BETWEEN 0 AND 18446744073709551615),
  baseline_entry_references numeric(20,0) NOT NULL CHECK(baseline_entry_references BETWEEN 0 AND 18446744073709551615),
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(bound_at))
);
CREATE TABLE deletion_publications (
  id uuid PRIMARY KEY,
  scope uuid,
  tip text NOT NULL CHECK(tip ~ '^[0-9a-f]{64}$' AND length(tip)=64),
  generation numeric(20,0) NOT NULL CHECK(generation BETWEEN 1 AND 18446744073709551615),
  entry_references numeric(20,0) NOT NULL CHECK(entry_references BETWEEN 1 AND 18446744073709551615),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(recorded_at))
);
CREATE TABLE deletion_receipts (
  intent_id uuid PRIMARY KEY,
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$' AND length(sha256)=64),
  publication_id uuid NOT NULL REFERENCES deletion_publications(id),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(applied_at))
);
CREATE INDEX deletion_publications_generation ON deletion_publications(generation DESC);

CREATE FUNCTION require_deletion_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM deletion_archive_binding) AND (
    NEW.publication_scope IS NULL OR NOT EXISTS(
      SELECT 1 FROM deletion_receipts r JOIN deletion_publications p ON p.id=r.publication_id
      WHERE r.intent_id=NEW.id AND p.scope=NEW.publication_scope
    )
  ) THEN
    RAISE EXCEPTION 'deletion_archive_receipt_required';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER deletion_publication_required AFTER INSERT ON deletion_journal
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_deletion_publication();

CREATE TRIGGER deletion_binding_immutable BEFORE UPDATE OR DELETE ON deletion_archive_binding
  FOR EACH ROW EXECUTE FUNCTION reject_deletion_journal_mutation();
CREATE TRIGGER deletion_binding_immutable_truncate BEFORE TRUNCATE ON deletion_archive_binding
  FOR EACH STATEMENT EXECUTE FUNCTION reject_deletion_journal_mutation();
CREATE TRIGGER deletion_publication_immutable BEFORE UPDATE OR DELETE ON deletion_publications
  FOR EACH ROW EXECUTE FUNCTION reject_deletion_journal_mutation();
CREATE TRIGGER deletion_publication_immutable_truncate BEFORE TRUNCATE ON deletion_publications
  FOR EACH STATEMENT EXECUTE FUNCTION reject_deletion_journal_mutation();
CREATE TRIGGER deletion_receipt_immutable BEFORE UPDATE OR DELETE ON deletion_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_deletion_journal_mutation();
CREATE TRIGGER deletion_receipt_immutable_truncate BEFORE TRUNCATE ON deletion_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_deletion_journal_mutation();
