(function () {
  function setupTabs() {
    const tabs = document.querySelector('[data-awb-tabs]');
    if (!tabs) return;
    tabs.addEventListener('click', (event) => {
      const button = event.target.closest('[data-tab]');
      if (!button) return;
      const id = button.getAttribute('data-tab');
      tabs.querySelectorAll('[data-tab]').forEach((tab) => tab.classList.toggle('active', tab === button));
      document.querySelectorAll('[data-tab-panel]').forEach((panel) => panel.classList.toggle('active', panel.getAttribute('data-tab-panel') === id));
    });
  }

  function renumberCargo() {
    document.querySelectorAll('[data-cargo-row]').forEach((row, index) => {
      row.querySelectorAll('[name]').forEach((field) => {
        field.name = field.name.replace(/cargo_items\[\d+\]/, 'cargo_items[' + index + ']');
      });
    });
    document.querySelectorAll('[data-dimension-group]').forEach((group, index) => {
      group.setAttribute('data-dimension-group', String(index));
      const title = group.querySelector('h3');
      if (title) title.textContent = 'Mercancía ' + (index + 1);
      group.querySelectorAll('[name]').forEach((field) => {
        field.name = field.name.replace(/cargo_items\[\d+\]/, 'cargo_items[' + index + ']');
      });
    });
  }

  function setupCargo() {
    const list = document.querySelector('[data-cargo-list]');
    const add = document.querySelector('[data-add-cargo]');
    const wrapper = document.querySelector('[data-dimensions-wrapper]');
    if (!list || !add || !wrapper) return;
    add.addEventListener('click', () => {
      const first = list.querySelector('[data-cargo-row]');
      const firstDim = wrapper.querySelector('[data-dimension-group]');
      if (!first || !firstDim) return;
      const cargoClone = first.cloneNode(true);
      cargoClone.querySelectorAll('input, textarea, select').forEach((field) => {
        if (field.type === 'checkbox') field.checked = false;
        else field.value = '';
      });
      const dimClone = firstDim.cloneNode(true);
      dimClone.querySelectorAll('input').forEach((field) => { field.value = ''; });
      list.appendChild(cargoClone);
      wrapper.appendChild(dimClone);
      renumberCargo();
    });
    list.addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-row]');
      if (!button) return;
      const rows = list.querySelectorAll('[data-cargo-row]');
      if (rows.length <= 1) return;
      const index = Array.from(rows).indexOf(button.closest('[data-cargo-row]'));
      button.closest('[data-cargo-row]').remove();
      const groups = wrapper.querySelectorAll('[data-dimension-group]');
      if (groups[index]) groups[index].remove();
      renumberCargo();
    });
  }

  function setupDimensions() {
    document.addEventListener('click', (event) => {
      const add = event.target.closest('[data-add-dimension]');
      if (add) {
        const group = add.closest('[data-dimension-group]');
        const list = group && group.querySelector('[data-dimension-list]');
        const first = list && list.querySelector('[data-dimension-row]');
        if (!first) return;
        const clone = first.cloneNode(true);
        clone.querySelectorAll('input').forEach((field) => { field.value = ''; });
        list.appendChild(clone);
        renumberDimensionList(group);
      }
      const remove = event.target.closest('[data-dimension-row] [data-remove-row]');
      if (remove) {
        const group = remove.closest('[data-dimension-group]');
        const rows = group.querySelectorAll('[data-dimension-row]');
        if (rows.length <= 1) return;
        remove.closest('[data-dimension-row]').remove();
        renumberDimensionList(group);
        computeWeights();
      }
    });
    document.addEventListener('input', (event) => {
      if (event.target.closest('[data-dimension-row]') || event.target.matches('[data-gross],[data-volume-weight]')) computeWeights();
    });
  }

  function renumberDimensionList(group) {
    const cargoIndex = group.getAttribute('data-dimension-group') || '0';
    group.querySelectorAll('[data-dimension-row]').forEach((row, dimIndex) => {
      row.querySelectorAll('[name]').forEach((field) => {
        field.name = field.name
          .replace(/cargo_items\[\d+\]/, 'cargo_items[' + cargoIndex + ']')
          .replace(/dimensions_rows\]\[\d+\]/, 'dimensions_rows][' + dimIndex + ']');
      });
    });
  }

  function number(field) {
    const value = Number(field && field.value);
    return Number.isFinite(value) ? value : 0;
  }

  function computeWeights() {
    document.querySelectorAll('[data-dimension-group]').forEach((group, index) => {
      let volumeWeight = 0;
      group.querySelectorAll('[data-dimension-row]').forEach((row) => {
        const qty = number(row.querySelector('[data-dim-qty]')) || 1;
        const length = number(row.querySelector('[data-dim-length]'));
        const width = number(row.querySelector('[data-dim-width]'));
        const height = number(row.querySelector('[data-dim-height]'));
        const unit = row.querySelector('select') ? row.querySelector('select').value : 'CM';
        volumeWeight += (length * width * height * qty) / (unit === 'IN' ? 366 : 6000);
      });
      const cargo = document.querySelectorAll('[data-cargo-row]')[index];
      if (!cargo) return;
      const volumeField = cargo.querySelector('[data-volume-weight]');
      const grossField = cargo.querySelector('[data-gross]');
      const chargeableField = cargo.querySelector('[data-chargeable]');
      if (volumeField && volumeWeight > 0) volumeField.value = volumeWeight.toFixed(2);
      if (chargeableField) chargeableField.value = Math.max(number(grossField), number(volumeField), number(chargeableField)).toFixed(2);
    });
  }

  setupTabs();
  setupCargo();
  setupDimensions();
  computeWeights();
})();
