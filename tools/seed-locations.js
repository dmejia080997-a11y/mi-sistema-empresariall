require('dotenv').config();

const { Country, State, City } = require('country-state-city');
const { createAppDatabase } = require('../src/config/database');

const db = createAppDatabase();

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      return resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      return resolve(row || null);
    });
  });
}

async function ensureColumn(table, name, type) {
  const columns = await new Promise((resolve, reject) => {
    db.all(
      `SELECT column_name AS name
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = ?
       ORDER BY ordinal_position`,
      [table],
      (err, rows) => {
      if (err) return reject(err);
      return resolve(rows || []);
      }
    );
  });
  if (columns.some((column) => column.name === name)) return;
  await run(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}

async function ensureSchema() {
  await run(`CREATE TABLE IF NOT EXISTS countries (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    iso2 TEXT,
    iso3 TEXT,
    phonecode TEXT,
    currency TEXT,
    region TEXT,
    subregion TEXT
  )`);
  await run(`CREATE TABLE IF NOT EXISTS states (
    id BIGSERIAL PRIMARY KEY,
    country_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    state_code TEXT,
    type TEXT,
    FOREIGN KEY (country_id) REFERENCES countries(id)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS cities (
    id BIGSERIAL PRIMARY KEY,
    state_id INTEGER,
    country_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    latitude TEXT,
    longitude TEXT,
    FOREIGN KEY (state_id) REFERENCES states(id),
    FOREIGN KEY (country_id) REFERENCES countries(id)
  )`);
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_countries_iso2 ON countries (iso2)');
  await run('CREATE INDEX IF NOT EXISTS idx_countries_name ON countries (name)');
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_states_country_code_name ON states (country_id, state_code, name)');
  await run('CREATE INDEX IF NOT EXISTS idx_states_country_id ON states (country_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_states_name ON states (name)');
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_cities_country_state_name ON cities (country_id, state_id, name)');
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_cities_country_name_no_state ON cities (country_id, name) WHERE state_id IS NULL');
  await run('CREATE INDEX IF NOT EXISTS idx_cities_state_id ON cities (state_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_cities_country_id ON cities (country_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_cities_name ON cities (name)');

  for (const table of ['customers', 'consignatarios']) {
    await ensureColumn(table, 'country_id', 'INTEGER');
    await ensureColumn(table, 'state_id', 'INTEGER');
    await ensureColumn(table, 'city_id', 'INTEGER');
    await ensureColumn(table, 'country_name', 'TEXT');
    await ensureColumn(table, 'state_name', 'TEXT');
    await ensureColumn(table, 'city_name', 'TEXT');
    await ensureColumn(table, 'address_line', 'TEXT');
    await ensureColumn(table, 'postal_code', 'TEXT');
    await ensureColumn(table, 'reference', 'TEXT');
  }
}

async function main() {
  await ensureSchema();
  const countries = Country.getAllCountries();
  const states = State.getAllStates();
  const cities = City.getAllCities();
  const countryIdByIso2 = new Map();
  const stateIdByKey = new Map();

  await run('BEGIN TRANSACTION');
  try {
    for (const country of countries) {
      const id = Number(country.numericCode) || countries.indexOf(country) + 1;
      await run(
        `INSERT INTO countries (id, name, iso2, iso3, phonecode, currency, region, subregion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           iso2 = excluded.iso2,
           iso3 = excluded.iso3,
           phonecode = excluded.phonecode,
           currency = excluded.currency,
           region = excluded.region,
           subregion = excluded.subregion`,
        [
          id,
          country.name || null,
          country.isoCode || null,
          country.isoCode ? null : null,
          country.phonecode || null,
          country.currency || null,
          null,
          null
        ]
      );
      countryIdByIso2.set(country.isoCode, id);
    }

    for (const state of states) {
      const countryId = countryIdByIso2.get(state.countryCode);
      if (!countryId || !state.name) continue;
      const stateName = state.countryCode === 'GT'
        ? String(state.name).replace(/\s+Department$/i, '')
        : state.name;
      const existingState = await get(
        'SELECT id FROM states WHERE country_id = ? AND state_code = ? LIMIT 1',
        [countryId, state.isoCode || '']
      );
      if (existingState) {
        await run('UPDATE states SET name = ?, type = ? WHERE id = ?', [stateName, null, existingState.id]);
      } else {
        await run(
          `INSERT INTO states (country_id, name, state_code, type)
           VALUES (?, ?, ?, ?)`,
          [countryId, stateName, state.isoCode || '', null]
        );
      }
    }

    const stateRows = await new Promise((resolve, reject) => {
      db.all('SELECT id, country_id, state_code, name FROM states', [], (err, rows) => {
        if (err) return reject(err);
        return resolve(rows || []);
      });
    });
    stateRows.forEach((row) => {
      stateIdByKey.set(`${row.country_id}|${row.state_code}`, row.id);
      stateIdByKey.set(`${row.country_id}|${row.name}`, row.id);
    });

    for (const city of cities) {
      const countryId = countryIdByIso2.get(city.countryCode);
      if (!countryId || !city.name) continue;
      const stateId = stateIdByKey.get(`${countryId}|${city.stateCode}`) || null;
      if (stateId) {
        await run(
          `INSERT INTO cities (state_id, country_id, name, latitude, longitude)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(country_id, state_id, name) DO UPDATE SET
             latitude = excluded.latitude,
             longitude = excluded.longitude`,
          [stateId, countryId, city.name, city.latitude || null, city.longitude || null]
        );
      } else {
        await run(
          `INSERT INTO cities (state_id, country_id, name, latitude, longitude)
           VALUES (NULL, ?, ?, ?, ?)
           ON CONFLICT(country_id, name) WHERE state_id IS NULL DO UPDATE SET
             latitude = excluded.latitude,
             longitude = excluded.longitude`,
          [countryId, city.name, city.latitude || null, city.longitude || null]
        );
      }
    }

    await run(
      `UPDATE customers
       SET country_id = COALESCE(country_id, (SELECT id FROM countries WHERE lower(name) = lower(COALESCE(customers.country_name, customers.country, 'Guatemala')) LIMIT 1)),
           country_name = COALESCE(NULLIF(country_name, ''), NULLIF(country, ''), 'Guatemala'),
           state_name = COALESCE(NULLIF(state_name, ''), NULLIF(department, '')),
           city_name = COALESCE(NULLIF(city_name, ''), NULLIF(municipality, '')),
           address_line = COALESCE(NULLIF(address_line, ''), NULLIF(full_address, ''), NULLIF(address, ''))`
    );
    await run(
      `UPDATE consignatarios
       SET country_id = COALESCE(country_id, (SELECT id FROM countries WHERE lower(name) = lower(COALESCE(consignatarios.country_name, consignatarios.country, 'Guatemala')) LIMIT 1)),
           country_name = COALESCE(NULLIF(country_name, ''), NULLIF(country, ''), 'Guatemala'),
           state_name = COALESCE(NULLIF(state_name, ''), NULLIF(department, '')),
           city_name = COALESCE(NULLIF(city_name, ''), NULLIF(municipality, '')),
           address_line = COALESCE(NULLIF(address_line, ''), NULLIF(full_address, ''))`
    );

    await run('COMMIT');
    const counts = {
      countries: await get('SELECT COUNT(1) AS total FROM countries'),
      states: await get('SELECT COUNT(1) AS total FROM states'),
      cities: await get('SELECT COUNT(1) AS total FROM cities')
    };
    console.log(`Locations seeded: countries=${counts.countries.total}, states=${counts.states.total}, cities=${counts.cities.total}`);
  } catch (err) {
    await run('ROLLBACK').catch(() => {});
    throw err;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    db.close();
  });
