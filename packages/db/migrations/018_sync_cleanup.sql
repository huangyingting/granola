CREATE TABLE sync_cleanup_cursor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  workspace_id uuid
);
INSERT INTO sync_cleanup_cursor(singleton,workspace_id) VALUES(true,NULL);
