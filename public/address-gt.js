(function () {
  const data = window.GT_LOCATIONS || {
    country: 'Guatemala',
    departments: {}
  };

  const forms = document.querySelectorAll('[data-gt-address-form]');
  if (!forms.length) return;

  const departments = Object.keys(data.departments || {});
  const defaultCountry = data.country || 'Guatemala';

  function ensureOption(select, value) {
    if (!value) return;
    const exists = Array.from(select.options).some((opt) => opt.value === value);
    if (!exists) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      select.appendChild(opt);
    }
  }

  function populateDepartments(select, selected) {
    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    const placeholderText = select.getAttribute('data-placeholder');
    placeholder.textContent = placeholderText || 'Select department';
    select.appendChild(placeholder);
    departments.forEach((dept) => {
      const opt = document.createElement('option');
      opt.value = dept;
      opt.textContent = dept;
      if (selected && selected === dept) opt.selected = true;
      select.appendChild(opt);
    });
    if (selected) ensureOption(select, selected);
  }

  function populateMunicipalities(select, department, selected) {
    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    const placeholderText = select.getAttribute('data-placeholder');
    placeholder.textContent = placeholderText || 'Select municipality';
    select.appendChild(placeholder);
    const list = (data.departments && data.departments[department]) || [];
    list.forEach((mun) => {
      const opt = document.createElement('option');
      opt.value = mun;
      opt.textContent = mun;
      if (selected && selected === mun) opt.selected = true;
      select.appendChild(opt);
    });
    if (selected) ensureOption(select, selected);
  }

  forms.forEach((form) => {
    const country = form.querySelector('[data-country]');
    const dept = form.querySelector('[data-department]');
    const muni = form.querySelector('[data-municipality]');

    if (country) {
      const selectedCountry = country.getAttribute('data-selected') || country.value;
      if (selectedCountry && selectedCountry !== defaultCountry) {
        ensureOption(country, selectedCountry);
        country.value = selectedCountry;
      } else {
        country.value = selectedCountry || defaultCountry;
      }
    }

    if (dept && muni) {
      const selectedDept = dept.getAttribute('data-selected') || dept.value;
      const selectedMuni = muni.getAttribute('data-selected') || muni.value;
      populateDepartments(dept, selectedDept);
      populateMunicipalities(muni, selectedDept, selectedMuni);
      dept.addEventListener('change', () => {
        populateMunicipalities(muni, dept.value, '');
      });
    }
  });
})();
