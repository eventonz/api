-- 010: api_keys.kind — 'app' (baked into a mobile build; reads must move to
-- install tokens) vs 'server' (CMS / worker / integrations; keep full access).
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'app';
UPDATE api_keys SET kind = 'server' WHERE id = 9;   -- cms-analytics (CMS → API)
