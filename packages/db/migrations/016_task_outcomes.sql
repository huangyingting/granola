CREATE TABLE task_outcome_coverage (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  observed_since timestamptz NOT NULL CHECK(isfinite(observed_since)),
  recovery_pending boolean NOT NULL
);
INSERT INTO task_outcome_coverage
  SELECT singleton,clock_timestamp(),usage_review_required FROM deletion_recovery_state;

CREATE INDEX audit_events_terminal_outcomes ON audit_events(created_at,resource_type,to_state)
  WHERE (
    (resource_type='job' AND action IN ('job_created','job_state_changed')) OR
    (resource_type='chat_turn' AND action IN ('chat_turn_created','chat_turn_state_changed'))
  ) AND to_state IN ('succeeded','failed','cancelled') AND from_state IS DISTINCT FROM to_state;
