(function () {
  const form = document.querySelector('[data-transport-form]');
  if (!form) return;
  const typeSelect = form.querySelector('[data-transport-type]');
  const panels = Array.from(form.querySelectorAll('[data-type-panel]'));
  const sections = Array.from(form.querySelectorAll('[data-type-section]'));

  function syncPanels() {
    const selected = typeSelect ? typeSelect.value : 'MAWB';
    const toggleScopedFields = (container, active) => {
      container.hidden = !active;
      container.querySelectorAll('input, textarea, select').forEach((field) => {
        field.disabled = !active;
      });
    };
    panels.forEach((panel) => {
      toggleScopedFields(panel, panel.getAttribute('data-type-panel') === selected);
    });
    sections.forEach((section) => {
      toggleScopedFields(section, section.getAttribute('data-type-section') === selected);
    });
  }

  if (typeSelect) typeSelect.addEventListener('change', syncPanels);
  syncPanels();
})();
