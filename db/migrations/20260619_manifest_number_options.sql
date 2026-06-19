ALTER TABLE manifests ADD COLUMN manifest_number TEXT NULL;
ALTER TABLE manifests ADD COLUMN manifest_number_mode TEXT NOT NULL DEFAULT 'automatic';
