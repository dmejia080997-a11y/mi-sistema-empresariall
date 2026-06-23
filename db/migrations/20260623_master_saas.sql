CREATE TABLE IF NOT EXISTS global_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NULL,
  user_id BIGINT NULL,
  user_name TEXT NULL,
  action TEXT NOT NULL,
  module TEXT NULL,
  description TEXT NULL,
  ip_address TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS license_plan TEXT NOT NULL DEFAULT 'Basico';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS license_starts_at DATE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS license_ends_at DATE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS license_max_users INTEGER NOT NULL DEFAULT 5;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS license_allowed_modules TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS license_status TEXT NOT NULL DEFAULT 'active';
