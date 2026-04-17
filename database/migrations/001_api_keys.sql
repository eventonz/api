CREATE TABLE IF NOT EXISTS api_keys (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,          -- e.g. "Evento iOS App", "Evento Android App"
  key_hash    CHAR(64) NOT NULL UNIQUE,       -- SHA-256 hex of the actual token
  app_id      INTEGER,                        -- optional: link to apps table
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash) WHERE active = TRUE;
