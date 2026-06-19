(function () {
  const list = document.querySelector('[data-items-list]');
  const addButton = document.querySelector('[data-add-item]');
  if (!list || !addButton) return;

  function renumber() {
    list.querySelectorAll('[data-item-row]').forEach((row, index) => {
      row.querySelectorAll('[name]').forEach((field) => {
        field.name = field.name.replace(/items\[\d+\]/, `items[${index}]`);
      });
    });
  }

  addButton.addEventListener('click', () => {
    const first = list.querySelector('[data-item-row]');
    if (!first) return;
    const clone = first.cloneNode(true);
    clone.querySelectorAll('input, textarea').forEach((field) => {
      field.value = field.name.includes('[moneda]') ? 'USD' : '';
    });
    list.appendChild(clone);
    renumber();
  });

  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-item]');
    if (!button) return;
    const rows = list.querySelectorAll('[data-item-row]');
    if (rows.length <= 1) return;
    button.closest('[data-item-row]').remove();
    renumber();
  });
})();
