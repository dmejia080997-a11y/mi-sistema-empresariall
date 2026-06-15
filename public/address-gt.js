(function () {
  const forms = document.querySelectorAll('[data-gt-address-form], [data-address-form]');
  if (!forms.length) return;

  const OTHER_CITY = '__other_city__';
  const defaultCountry = 'Guatemala';
  const cache = {
    countries: null,
    states: new Map(),
    cities: new Map(),
    citiesByCountry: new Map()
  };

  function normalize(value) {
    return String(value || '').trim().toLowerCase();
  }

  function option(label, value, selected, dataset) {
    const opt = document.createElement('option');
    opt.value = value == null ? '' : String(value);
    opt.textContent = label || value || '';
    if (selected) opt.selected = true;
    Object.entries(dataset || {}).forEach(([key, val]) => {
      if (val != null) opt.dataset[key] = String(val);
    });
    return opt;
  }

  function selectedValue(field) {
    return field ? field.getAttribute('data-selected') || field.value || '' : '';
  }

  function getOrCreateHidden(form, name) {
    let field = form.querySelector(`input[type="hidden"][name="${name}"]`);
    if (!field) {
      field = document.createElement('input');
      field.type = 'hidden';
      field.name = name;
      form.appendChild(field);
    }
    return field;
  }

  function setStatus(form, message) {
    let status = form.querySelector('[data-address-status]');
    if (!status) {
      status = document.createElement('div');
      status.className = 'helper full-row address-status';
      status.setAttribute('data-address-status', '');
      const city = form.querySelector('[data-municipality]');
      const label = city ? city.closest('label') : null;
      if (label && label.parentNode) label.parentNode.insertBefore(status, label.nextSibling);
    }
    status.textContent = message || '';
  }

  function setLoading(form, loading, label) {
    form.classList.toggle('address-loading', Boolean(loading));
    setStatus(form, loading ? (label || 'Cargando ubicaciones...') : '');
  }

  async function fetchJson(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Location request failed');
    return response.json();
  }

  async function getCountries() {
    if (cache.countries) return cache.countries;
    const data = await fetchJson('/api/locations/countries');
    cache.countries = Array.isArray(data.countries) ? data.countries : [];
    return cache.countries;
  }

  async function getStates(countryId) {
    const key = String(countryId || '');
    if (!key) return [];
    if (cache.states.has(key)) return cache.states.get(key);
    const data = await fetchJson(`/api/locations/states?country_id=${encodeURIComponent(key)}`);
    const states = Array.isArray(data.states) ? data.states : [];
    cache.states.set(key, states);
    return states;
  }

  async function getCities(stateId) {
    const key = String(stateId || '');
    if (!key) return [];
    if (cache.cities.has(key)) return cache.cities.get(key);
    const data = await fetchJson(`/api/locations/cities?state_id=${encodeURIComponent(key)}`);
    const cities = Array.isArray(data.cities) ? data.cities : [];
    cache.cities.set(key, cities);
    return cities;
  }

  async function getCitiesByCountry(countryId) {
    const key = String(countryId || '');
    if (!key) return [];
    if (cache.citiesByCountry.has(key)) return cache.citiesByCountry.get(key);
    const data = await fetchJson(`/api/locations/cities-by-country?country_id=${encodeURIComponent(key)}`);
    const cities = Array.isArray(data.cities) ? data.cities : [];
    cache.citiesByCountry.set(key, cities);
    return cities;
  }

  function selectedOption(select) {
    return select && select.options ? select.options[select.selectedIndex] : null;
  }

  function ensureSearch(select) {
    if (!select || select.dataset.searchReady === '1') return;
    select.dataset.searchReady = '1';
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'address-select-search';
    input.placeholder = select.getAttribute('data-search-placeholder') || 'Buscar...';
    input.autocomplete = 'off';
    select.parentNode.insertBefore(input, select);
    input.addEventListener('input', () => {
      const needle = normalize(input.value);
      Array.from(select.options).forEach((opt) => {
        if (!opt.value || opt.value === OTHER_CITY) {
          opt.hidden = false;
          return;
        }
        opt.hidden = needle && !normalize(opt.textContent).includes(needle);
      });
    });
  }

  function populate(select, placeholder, rows, currentName, currentId, manualOption) {
    if (!select) return;
    select.innerHTML = '';
    select.appendChild(option(placeholder, '', false));
    let matched = false;
    rows.forEach((row) => {
      const isSelected = (currentId && String(row.id) === String(currentId)) ||
        (!currentId && normalize(row.name) === normalize(currentName));
      if (isSelected) matched = true;
      select.appendChild(option(row.name, row.name, isSelected, { id: row.id || '', name: row.name || '' }));
    });
    if (currentName && !matched) {
      select.appendChild(option(currentName, currentName, true, { id: currentId || '', name: currentName }));
    }
    if (manualOption) select.appendChild(option('Otra ciudad / ingresar manualmente', OTHER_CITY, false));
  }

  function syncHidden(form, country, state, city, manualInput) {
    const countryOpt = selectedOption(country);
    const stateOpt = selectedOption(state);
    const cityOpt = selectedOption(city);
    const manualCity = manualInput && !manualInput.hidden ? manualInput.value.trim() : '';
    getOrCreateHidden(form, 'country_id').value = countryOpt && countryOpt.dataset.id ? countryOpt.dataset.id : '';
    getOrCreateHidden(form, 'state_id').value = stateOpt && stateOpt.dataset.id ? stateOpt.dataset.id : '';
    getOrCreateHidden(form, 'city_id').value = cityOpt && cityOpt.dataset.id && city.value !== OTHER_CITY ? cityOpt.dataset.id : '';
    getOrCreateHidden(form, 'country_name').value = country.value || '';
    getOrCreateHidden(form, 'state_name').value = state.value || '';
    getOrCreateHidden(form, 'city_name').value = manualCity || (city.value === OTHER_CITY ? '' : city.value || '');
  }

  function createManualCityInput(form, city) {
    let input = form.querySelector('[data-city-manual]');
    if (!input) {
      input = document.createElement('input');
      input.type = 'text';
      input.name = 'city_manual';
      input.placeholder = 'Ingresar ciudad';
      input.setAttribute('data-city-manual', '');
      input.hidden = true;
      const label = city.closest('label');
      if (label) label.appendChild(input);
    }
    return input;
  }

  function toggleManualCity(city, manualInput, form, country, state) {
    const manual = city.value === OTHER_CITY;
    manualInput.hidden = !manual;
    manualInput.required = manual;
    if (manual) manualInput.focus();
    syncHidden(form, country, state, city, manualInput);
  }

  async function initForm(form) {
    const country = form.querySelector('[data-country]');
    const state = form.querySelector('[data-department]');
    const city = form.querySelector('[data-municipality]');
    if (!country || !state || !city) return;

    const manualCity = createManualCityInput(form, city);
    const initialCountry = country.getAttribute('data-country-id') || '';
    const initialState = state.getAttribute('data-state-id') || '';
    const initialCity = city.getAttribute('data-city-id') || '';
    const initialCountryName = selectedValue(country) || defaultCountry;
    const initialStateName = selectedValue(state);
    const initialCityName = selectedValue(city);

    ensureSearch(country);
    ensureSearch(state);
    ensureSearch(city);

    try {
      setLoading(form, true, 'Cargando paises...');
      const countries = await getCountries();
      const countryMatch = countries.find((row) => String(row.id) === String(initialCountry)) ||
        countries.find((row) => normalize(row.name) === normalize(initialCountryName)) ||
        countries.find((row) => normalize(row.name) === normalize(defaultCountry));
      populate(country, 'Selecciona pais', countries, countryMatch ? countryMatch.name : initialCountryName, countryMatch ? countryMatch.id : initialCountry);
      setLoading(form, false);

      const countryId = selectedOption(country) && selectedOption(country).dataset.id;
      setLoading(form, true, 'Cargando estados...');
      const states = await getStates(countryId);
      populate(state, 'Selecciona estado/departamento', states, initialStateName, initialState);
      state.disabled = states.length === 0;
      const stateId = selectedOption(state) && selectedOption(state).dataset.id;
      const cities = states.length ? await getCities(stateId) : await getCitiesByCountry(countryId);
      populate(city, 'Selecciona ciudad/municipio', cities, initialCityName, initialCity, true);
      city.disabled = false;
      if (!cities.length) setStatus(form, 'No hay ciudades registradas. Usa Otra ciudad / ingresar manualmente.');
      syncHidden(form, country, state, city, manualCity);
      setLoading(form, false);
    } catch (err) {
      setLoading(form, false);
      setStatus(form, 'No se pudieron cargar ubicaciones. Puedes escribir la ciudad manualmente.');
      manualCity.hidden = false;
    }

    country.addEventListener('change', async () => {
      populate(state, 'Selecciona estado/departamento', [], '', '');
      populate(city, 'Selecciona ciudad/municipio', [], '', '', true);
      manualCity.hidden = true;
      manualCity.value = '';
      try {
        setLoading(form, true, 'Cargando estados...');
        const countryId = selectedOption(country) && selectedOption(country).dataset.id;
        const states = await getStates(countryId);
        populate(state, 'Selecciona estado/departamento', states, '', '');
        state.disabled = states.length === 0;
        const cities = states.length ? [] : await getCitiesByCountry(countryId);
        populate(city, 'Selecciona ciudad/municipio', cities, '', '', true);
        city.disabled = false;
        if (!states.length) setStatus(form, cities.length ? 'Este pais no tiene estados registrados.' : 'Este pais no tiene ciudades registradas. Usa ciudad manual.');
        syncHidden(form, country, state, city, manualCity);
        setLoading(form, false);
      } catch (err) {
        setLoading(form, false);
        setStatus(form, 'No se pudieron cargar ubicaciones.');
      }
    });

    state.addEventListener('change', async () => {
      populate(city, 'Selecciona ciudad/municipio', [], '', '', true);
      manualCity.hidden = true;
      manualCity.value = '';
      try {
        setLoading(form, true, 'Cargando ciudades...');
        const stateId = selectedOption(state) && selectedOption(state).dataset.id;
        const cities = await getCities(stateId);
        populate(city, 'Selecciona ciudad/municipio', cities, '', '', true);
        if (!cities.length) setStatus(form, 'No hay ciudades registradas. Usa Otra ciudad / ingresar manualmente.');
        syncHidden(form, country, state, city, manualCity);
        setLoading(form, false);
      } catch (err) {
        setLoading(form, false);
        setStatus(form, 'No se pudieron cargar ciudades.');
      }
    });

    city.addEventListener('change', () => toggleManualCity(city, manualCity, form, country, state));
    manualCity.addEventListener('input', () => syncHidden(form, country, state, city, manualCity));
    form.addEventListener('submit', () => {
      if (city.value === OTHER_CITY && manualCity.value.trim()) {
        city.dataset.manualSelected = '1';
      }
      syncHidden(form, country, state, city, manualCity);
    });
  }

  forms.forEach(initForm);
})();
