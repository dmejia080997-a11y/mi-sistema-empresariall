CREATE TABLE IF NOT EXISTS countries (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  iso2 TEXT,
  iso3 TEXT,
  phonecode TEXT,
  currency TEXT,
  region TEXT,
  subregion TEXT
);

CREATE TABLE IF NOT EXISTS states (
  id BIGSERIAL PRIMARY KEY,
  country_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  state_code TEXT,
  type TEXT,
  FOREIGN KEY (country_id) REFERENCES countries(id)
);

CREATE TABLE IF NOT EXISTS cities (
  id BIGSERIAL PRIMARY KEY,
  state_id INTEGER,
  country_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  latitude TEXT,
  longitude TEXT,
  FOREIGN KEY (state_id) REFERENCES states(id),
  FOREIGN KEY (country_id) REFERENCES countries(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_countries_iso2 ON countries (iso2);
CREATE INDEX IF NOT EXISTS idx_countries_name ON countries (name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_states_country_code_name ON states (country_id, state_code, name);
CREATE INDEX IF NOT EXISTS idx_states_country_id ON states (country_id);
CREATE INDEX IF NOT EXISTS idx_states_name ON states (name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cities_country_state_name ON cities (country_id, state_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cities_country_name_no_state ON cities (country_id, name) WHERE state_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_cities_state_id ON cities (state_id);
CREATE INDEX IF NOT EXISTS idx_cities_country_id ON cities (country_id);
CREATE INDEX IF NOT EXISTS idx_cities_name ON cities (name);

ALTER TABLE customers ADD COLUMN country_id INTEGER;
ALTER TABLE customers ADD COLUMN state_id INTEGER;
ALTER TABLE customers ADD COLUMN city_id INTEGER;
ALTER TABLE customers ADD COLUMN country_name TEXT;
ALTER TABLE customers ADD COLUMN state_name TEXT;
ALTER TABLE customers ADD COLUMN city_name TEXT;
ALTER TABLE customers ADD COLUMN address_line TEXT;
ALTER TABLE customers ADD COLUMN postal_code TEXT;
ALTER TABLE customers ADD COLUMN reference TEXT;

ALTER TABLE consignatarios ADD COLUMN country_id INTEGER;
ALTER TABLE consignatarios ADD COLUMN state_id INTEGER;
ALTER TABLE consignatarios ADD COLUMN city_id INTEGER;
ALTER TABLE consignatarios ADD COLUMN country_name TEXT;
ALTER TABLE consignatarios ADD COLUMN state_name TEXT;
ALTER TABLE consignatarios ADD COLUMN city_name TEXT;
ALTER TABLE consignatarios ADD COLUMN address_line TEXT;
ALTER TABLE consignatarios ADD COLUMN postal_code TEXT;
ALTER TABLE consignatarios ADD COLUMN reference TEXT;

UPDATE customers
SET country_name = COALESCE(NULLIF(country_name, ''), NULLIF(country, ''), 'Guatemala'),
    state_name = COALESCE(NULLIF(state_name, ''), NULLIF(department, '')),
    city_name = COALESCE(NULLIF(city_name, ''), NULLIF(municipality, '')),
    address_line = COALESCE(NULLIF(address_line, ''), NULLIF(full_address, ''), NULLIF(address, ''))
WHERE country_name IS NULL OR state_name IS NULL OR city_name IS NULL OR address_line IS NULL;

UPDATE consignatarios
SET country_name = COALESCE(NULLIF(country_name, ''), NULLIF(country, ''), 'Guatemala'),
    state_name = COALESCE(NULLIF(state_name, ''), NULLIF(department, '')),
    city_name = COALESCE(NULLIF(city_name, ''), NULLIF(municipality, '')),
    address_line = COALESCE(NULLIF(address_line, ''), NULLIF(full_address, ''))
WHERE country_name IS NULL OR state_name IS NULL OR city_name IS NULL OR address_line IS NULL;
