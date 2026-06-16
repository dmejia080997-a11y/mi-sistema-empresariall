ALTER TABLE items ADD COLUMN production_labor_cost REAL NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN production_days REAL NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN production_notes TEXT;
ALTER TABLE items ADD COLUMN production_photo_path TEXT;
ALTER TABLE items ADD COLUMN production_support_path TEXT;
