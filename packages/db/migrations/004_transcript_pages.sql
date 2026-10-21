ALTER TABLE transcript_revisions
  ADD COLUMN segment_count integer NOT NULL DEFAULT 0 CHECK (segment_count BETWEEN 0 AND 100000),
  ADD COLUMN text_bytes integer NOT NULL DEFAULT 0 CHECK (text_bytes BETWEEN 0 AND 8000000);

CREATE TABLE transcript_segments (
  document_id uuid NOT NULL,
  revision integer NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 99999),
  id text NOT NULL CHECK (length(id) = 36),
  segment jsonb NOT NULL CHECK (jsonb_typeof(segment) = 'object' AND segment->>'id' = id),
  PRIMARY KEY (document_id, revision, position),
  UNIQUE (document_id, revision, id),
  FOREIGN KEY (document_id, revision) REFERENCES transcript_revisions(document_id, revision) ON DELETE CASCADE
);

INSERT INTO transcript_segments (document_id, revision, position, id, segment)
SELECT t.document_id, t.revision, (s.ordinality - 1)::integer, s.value->>'id', s.value
FROM transcript_revisions t
CROSS JOIN LATERAL jsonb_array_elements(t.segments) WITH ORDINALITY AS s(value, ordinality);

UPDATE transcript_revisions t
SET segment_count = jsonb_array_length(t.segments),
    text_bytes = (
      SELECT COALESCE(sum(octet_length(s.value->>'text')), 0)::integer
      FROM jsonb_array_elements(t.segments) AS s(value)
    );

ALTER TABLE transcript_revisions DROP COLUMN segments;
