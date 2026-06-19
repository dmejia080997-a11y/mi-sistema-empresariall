(function () {
  function setupList(listSelector, addSelector, rowSelector, groupName) {
    const list = document.querySelector(listSelector);
    const addButton = document.querySelector(addSelector);
    if (!list || !addButton) return;

    function renumber() {
      list.querySelectorAll(rowSelector).forEach((row, index) => {
        row.querySelectorAll('[name]').forEach((field) => {
          field.name = field.name.replace(new RegExp(groupName + '\\[\\d+\\]'), groupName + '[' + index + ']');
        });
        const idField = row.querySelector('input[name$="[id]"]');
        if (idField && !idField.value) idField.value = String(index + 1);
      });
    }

    addButton.addEventListener('click', () => {
      const first = list.querySelector(rowSelector);
      if (!first) return;
      const clone = first.cloneNode(true);
      clone.querySelectorAll('input, textarea, select').forEach((field) => {
        if (field.type === 'checkbox') field.checked = false;
        else field.value = '';
      });
      list.appendChild(clone);
      renumber();
    });

    list.addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-row]');
      if (!button) return;
      const rows = list.querySelectorAll(rowSelector);
      if (rows.length <= 1) return;
      button.closest(rowSelector).remove();
      renumber();
    });
  }

  setupList('[data-container-list]', '[data-add-container]', '[data-container-row]', 'containers');
  setupList('[data-cargo-list]', '[data-add-cargo]', '[data-cargo-row]', 'cargo_items');
})();
