(function () {
  const root = document.querySelector('[data-original-launcher]');
  if (!root) return;

  const csrfToken = root.dataset.csrf || '';
  const lang = document.documentElement.lang || 'es';
  const widgetPrefsRaw = root.dataset.widgetPrefs || 'null';
  const notePalette = ['#fff2b8', '#ffd4e7', '#cfefff', '#ddf6c6', '#ffe0c2', '#e5d6ff'];
  const plannerPalette = ['#fff2b8', '#ffd4e7', '#cfefff', '#ddf6c6', '#ffe0c2', '#e5d6ff'];
  const defaultPrefs = {
    order: ['hero', 'notes', 'planner', 'apps'],
    visibility: { hero: true, notes: true, planner: true, apps: true },
    notesCollapsed: false,
    notesLayout: 'vertical',
    plannerHidePast: false,
    plannerHideBefore: null,
    plannerFocusDate: null,
    plannerColor: notePalette[0]
  };

  let widgetPrefs = defaultPrefs;
  try {
    const parsed = JSON.parse(widgetPrefsRaw);
    if (parsed && typeof parsed === 'object') {
      widgetPrefs = {
        ...defaultPrefs,
        ...parsed,
        visibility: { ...defaultPrefs.visibility, ...(parsed.visibility || {}) },
        order: Array.isArray(parsed.order) && parsed.order.length ? parsed.order.slice() : defaultPrefs.order.slice()
      };
    }
  } catch (err) {
    widgetPrefs = { ...defaultPrefs };
  }

  const widgetLayout = root.querySelector('[data-widget-layout]');
  const widgetCards = Array.from(root.querySelectorAll('[data-widget-card]'));
  const widgetToggles = Array.from(root.querySelectorAll('[data-widget-toggle]'));

  const notesBoard = root.querySelector('[data-notes-board]');
  const notesGrid = root.querySelector('[data-notes-grid]');
  const notesAdd = root.querySelector('[data-notes-add]');
  const notesHide = root.querySelector('[data-notes-hide]');
  const notesShow = root.querySelector('[data-notes-show]');
  const notesLayout = root.querySelector('[data-notes-layout]');

  const plannerBoard = root.querySelector('[data-planner-board]');
  const plannerGrid = root.querySelector('[data-planner-grid]');
  const plannerPaletteRoot = root.querySelector('[data-planner-palette]');
  const plannerQuick = root.querySelector('[data-planner-quick]');
  const plannerQuickToggle = root.querySelector('[data-planner-quick-toggle]');
  const plannerQuickDate = root.querySelector('[data-planner-quick-date]');
  const plannerQuickText = root.querySelector('[data-planner-quick-text]');
  const plannerQuickSave = root.querySelector('[data-planner-quick-save]');
  const plannerQuickCancel = root.querySelector('[data-planner-quick-cancel]');
  const plannerFocusDate = root.querySelector('[data-planner-focus-date]');
  const plannerFocusToday = root.querySelector('[data-planner-focus-today]');
  const plannerHidePast = root.querySelector('[data-planner-hide-past]');

  const notesText = {
    layoutGrid: lang === 'en' ? 'View grid' : 'Ver en cuadricula',
    layoutVertical: lang === 'en' ? 'View vertical' : 'Ver en vertical'
  };
  const plannerText = {
    current: lang === 'en' ? 'Current week' : 'Semana actual',
    next: lang === 'en' ? 'Next week' : 'Proxima semana',
    addItem: lang === 'en' ? 'Add item' : 'Agregar punto',
    remove: lang === 'en' ? 'Remove' : 'Quitar',
    placeholder: lang === 'en' ? 'Write tasks or reminders...' : 'Escribe tareas o recordatorios...'
  };

  let notes = [];
  let plannerEntries = new Map();
  let plannerQuickOpen = false;
  let plannerRange = null;

  const noteSaveDebounce = debounce(saveNotes, 350);
  const prefsSaveDebounce = debounce(savePrefs, 300);
  const plannerSaveDebounce = debounce(savePlannerEntries, 450);

  function debounce(fn, wait) {
    let timer = null;
    return function debounced() {
      clearTimeout(timer);
      timer = setTimeout(() => fn(), wait);
    };
  }

  function uid(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  }

  function isoDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function parseIsoDate(value) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  function startOfWeek(date) {
    const safe = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = safe.getDay();
    const offset = day === 0 ? -6 : 1 - day;
    safe.setDate(safe.getDate() + offset);
    return safe;
  }

  function addDays(date, days) {
    const safe = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    safe.setDate(safe.getDate() + days);
    return safe;
  }

  function formatDayLabel(date) {
    return new Intl.DateTimeFormat(lang, { weekday: 'short', day: 'numeric', month: 'short' }).format(date);
  }

  function formatRange(start, end) {
    const startLabel = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short' }).format(start);
    const endLabel = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short' }).format(end);
    return `${startLabel} - ${endLabel}`;
  }

  function fetchJson(url, options) {
    return fetch(url, options).then((resp) => resp.json().catch(() => ({ ok: false })));
  }

  function savePrefs() {
    fetchJson('/launcher/widgets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CSRF-Token': csrfToken
      },
      body: JSON.stringify({ prefs: widgetPrefs })
    }).catch(() => {});
  }

  function applyWidgetPrefs() {
    const order = Array.isArray(widgetPrefs.order) && widgetPrefs.order.length ? widgetPrefs.order : defaultPrefs.order;
    order.forEach((key) => {
      const card = widgetLayout.querySelector(`[data-widget-card="${key}"]`);
      if (card) widgetLayout.appendChild(card);
    });
    widgetCards.forEach((card) => {
      const key = card.dataset.widgetCard;
      const visible = key ? widgetPrefs.visibility[key] !== false : true;
      card.hidden = !visible;
    });
    widgetToggles.forEach((input) => {
      const key = input.dataset.widgetToggle;
      input.checked = widgetPrefs.visibility[key] !== false;
    });
    updateNotesBoardState();
    updatePlannerState();
  }

  function updateNotesBoardState() {
    if (!notesBoard) return;
    const isVertical = widgetPrefs.notesLayout !== 'grid';
    notesBoard.classList.toggle('is-vertical', isVertical);
    notesBoard.classList.toggle('is-collapsed', Boolean(widgetPrefs.notesCollapsed));
    if (notesLayout) {
      notesLayout.textContent = isVertical ? notesText.layoutGrid : notesText.layoutVertical;
    }
  }

  function renderNotes() {
    if (!notesGrid) return;
    notesGrid.innerHTML = '';
    notes.forEach((note, index) => {
      const card = document.createElement('article');
      card.className = 'note-card';
      card.style.setProperty('--note-color', note.color || notePalette[0]);

      const actions = document.createElement('div');
      actions.className = 'note-actions';

      const palette = document.createElement('div');
      palette.className = 'note-palette';
      notePalette.forEach((color) => {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'note-swatch';
        swatch.style.setProperty('--swatch-color', color);
        swatch.addEventListener('click', () => {
          note.color = color;
          renderNotes();
          noteSaveDebounce();
        });
        palette.appendChild(swatch);
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'note-delete';
      remove.textContent = lang === 'en' ? 'Delete' : 'Borrar';
      remove.addEventListener('click', () => {
        notes.splice(index, 1);
        renderNotes();
        noteSaveDebounce();
      });

      const text = document.createElement('textarea');
      text.className = 'note-text';
      text.placeholder = lang === 'en' ? 'Write here...' : 'Escribe aqui...';
      text.value = note.text || '';
      text.addEventListener('input', () => {
        note.text = text.value;
        noteSaveDebounce();
      });

      actions.appendChild(palette);
      actions.appendChild(remove);
      card.appendChild(actions);
      card.appendChild(text);
      notesGrid.appendChild(card);
    });
  }

  function saveNotes() {
    const payload = notes.map((note, index) => ({
      id: note.id,
      text: note.text || '',
      color: note.color || notePalette[0],
      position: index
    }));
    fetchJson('/launcher/notes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CSRF-Token': csrfToken
      },
      body: JSON.stringify({ notes: payload })
    }).catch(() => {});
  }

  function ensureDayEntry(dateKey) {
    if (!plannerEntries.has(dateKey)) {
      plannerEntries.set(dateKey, { date: dateKey, items: [] });
    }
    return plannerEntries.get(dateKey);
  }

  function renderPlannerPalette() {
    if (!plannerPaletteRoot) return;
    plannerPaletteRoot.innerHTML = '';
    plannerPalette.forEach((color) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'planner-swatch';
      button.style.setProperty('--swatch-color', color);
      button.classList.toggle('is-active', color === widgetPrefs.plannerColor);
      button.addEventListener('click', () => {
        widgetPrefs.plannerColor = color;
        updatePlannerState();
        prefsSaveDebounce();
      });
      plannerPaletteRoot.appendChild(button);
    });
  }

  function buildPlannerWeeks() {
    const focus = parseIsoDate(widgetPrefs.plannerFocusDate) || new Date();
    const firstWeekStart = startOfWeek(focus);
    const secondWeekStart = addDays(firstWeekStart, 7);
    const weeks = [
      { title: plannerText.current, start: firstWeekStart },
      { title: plannerText.next, start: secondWeekStart }
    ];
    plannerRange = {
      start: isoDate(firstWeekStart),
      end: isoDate(addDays(secondWeekStart, 6))
    };
    return weeks.map((week) => ({
      ...week,
      end: addDays(week.start, 6),
      days: Array.from({ length: 7 }, (_, idx) => addDays(week.start, idx))
    }));
  }

  function updatePlannerState() {
    if (!plannerBoard) return;
    plannerBoard.style.setProperty('--planner-note', widgetPrefs.plannerColor || plannerPalette[0]);
    if (plannerHidePast) plannerHidePast.checked = Boolean(widgetPrefs.plannerHidePast);
    if (plannerFocusDate) plannerFocusDate.value = widgetPrefs.plannerFocusDate || isoDate(new Date());
    renderPlannerPalette();
    renderPlanner();
  }

  function renderPlanner() {
    if (!plannerGrid) return;
    const weeks = buildPlannerWeeks();
    const today = isoDate(new Date());
    plannerGrid.innerHTML = '';

    weeks.forEach((week) => {
      const weekCard = document.createElement('section');
      weekCard.className = 'planner-week';

      const header = document.createElement('div');
      header.className = 'planner-week-header';
      header.innerHTML = `
        <div class="planner-week-title">${week.title}</div>
        <div class="planner-week-range">${formatRange(week.start, week.end)}</div>
      `;
      weekCard.appendChild(header);

      const days = document.createElement('div');
      days.className = 'planner-days';

      week.days.forEach((date) => {
        const dateKey = isoDate(date);
        const entry = ensureDayEntry(dateKey);
        const dayCard = document.createElement('article');
        dayCard.className = 'planner-day';
        dayCard.style.setProperty('--planner-note', widgetPrefs.plannerColor || plannerPalette[0]);
        if (dateKey === today) dayCard.classList.add('is-today');
        if (widgetPrefs.plannerHidePast && dateKey < today) dayCard.classList.add('is-hidden');

        const label = document.createElement('div');
        label.className = 'planner-day-label';
        label.textContent = formatDayLabel(date);
        dayCard.appendChild(label);

        const list = document.createElement('div');
        list.className = 'planner-list';
        (entry.items || []).forEach((item, itemIndex) => {
          const row = document.createElement('div');
          row.className = 'planner-item';

          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.className = 'planner-item-check';
          checkbox.checked = Boolean(item.done);
          checkbox.addEventListener('change', () => {
            item.done = checkbox.checked;
            plannerSaveDebounce();
          });

          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'planner-item-input';
          input.value = item.text || '';
          input.placeholder = plannerText.placeholder;
          input.maxLength = 200;
          input.addEventListener('input', () => {
            item.text = input.value;
            plannerSaveDebounce();
          });

          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'planner-item-remove';
          remove.textContent = plannerText.remove;
          remove.addEventListener('click', () => {
            entry.items.splice(itemIndex, 1);
            renderPlanner();
            plannerSaveDebounce();
          });

          row.appendChild(checkbox);
          row.appendChild(input);
          row.appendChild(remove);
          list.appendChild(row);
        });

        const addButton = document.createElement('button');
        addButton.type = 'button';
        addButton.className = 'planner-item-add';
        addButton.textContent = plannerText.addItem;
        addButton.addEventListener('click', () => {
          entry.items.push({ id: uid('item'), text: '', done: false });
          renderPlanner();
        });

        dayCard.appendChild(list);
        dayCard.appendChild(addButton);
        days.appendChild(dayCard);
      });

      weekCard.appendChild(days);
      plannerGrid.appendChild(weekCard);
    });
  }

  function serializePlannerEntries() {
    return Array.from(plannerEntries.values()).map((entry) => ({
      date: entry.date,
      items: (entry.items || [])
        .map((item) => ({
          id: item.id || uid('item'),
          text: String(item.text || '').trim(),
          done: Boolean(item.done)
        }))
        .filter((item) => item.text)
    }));
  }

  function savePlannerEntries() {
    fetchJson('/launcher/planner', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CSRF-Token': csrfToken
      },
      body: JSON.stringify({ entries: serializePlannerEntries() })
    }).catch(() => {});
  }

  function loadNotes() {
    fetchJson('/launcher/notes', { headers: { Accept: 'application/json' } })
      .then((resp) => {
        notes = resp && resp.ok && Array.isArray(resp.notes) ? resp.notes : [];
        if (!notes.length) {
          notes = [{ id: uid('note'), text: '', color: notePalette[0] }];
        }
        renderNotes();
      })
      .catch(() => {
        notes = [{ id: uid('note'), text: '', color: notePalette[0] }];
        renderNotes();
      });
  }

  function loadPlanner() {
    const weeks = buildPlannerWeeks();
    const start = isoDate(weeks[0].start);
    const end = isoDate(weeks[1].end);
    fetchJson(`/launcher/planner?start=${start}&end=${end}`, { headers: { Accept: 'application/json' } })
      .then((resp) => {
        plannerEntries = new Map();
        if (resp && resp.ok && Array.isArray(resp.entries)) {
          resp.entries.forEach((entry) => {
            plannerEntries.set(entry.date, {
              date: entry.date,
              items: Array.isArray(entry.items) ? entry.items.map((item) => ({
                id: item.id || uid('item'),
                text: item.text || '',
                done: Boolean(item.done)
              })) : []
            });
          });
        }
        renderPlanner();
      })
      .catch(() => {
        plannerEntries = new Map();
        renderPlanner();
      });
  }

  widgetToggles.forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.widgetToggle;
      widgetPrefs.visibility[key] = input.checked;
      applyWidgetPrefs();
      prefsSaveDebounce();
    });
  });

  if (notesAdd) {
    notesAdd.addEventListener('click', () => {
      notes.unshift({ id: uid('note'), text: '', color: notePalette[0] });
      renderNotes();
      noteSaveDebounce();
    });
  }
  if (notesHide) {
    notesHide.addEventListener('click', () => {
      widgetPrefs.notesCollapsed = true;
      updateNotesBoardState();
      prefsSaveDebounce();
    });
  }
  if (notesShow) {
    notesShow.addEventListener('click', () => {
      widgetPrefs.notesCollapsed = false;
      updateNotesBoardState();
      prefsSaveDebounce();
    });
  }
  if (notesLayout) {
    notesLayout.addEventListener('click', () => {
      widgetPrefs.notesLayout = widgetPrefs.notesLayout === 'grid' ? 'vertical' : 'grid';
      updateNotesBoardState();
      prefsSaveDebounce();
    });
  }

  if (plannerQuickToggle) {
    plannerQuickToggle.addEventListener('click', () => {
      plannerQuickOpen = !plannerQuickOpen;
      plannerQuick.classList.toggle('is-open', plannerQuickOpen);
      plannerQuickToggle.classList.toggle('is-active', plannerQuickOpen);
      if (plannerQuickDate && !plannerQuickDate.value) plannerQuickDate.value = isoDate(new Date());
      if (plannerQuickOpen && plannerQuickText) plannerQuickText.focus();
    });
  }
  if (plannerQuickCancel) {
    plannerQuickCancel.addEventListener('click', () => {
      plannerQuickOpen = false;
      plannerQuick.classList.remove('is-open');
      plannerQuickToggle.classList.remove('is-active');
      if (plannerQuickText) plannerQuickText.value = '';
    });
  }
  if (plannerQuickSave) {
    plannerQuickSave.addEventListener('click', () => {
      const dateKey = plannerQuickDate && plannerQuickDate.value ? plannerQuickDate.value : isoDate(new Date());
      const text = plannerQuickText ? String(plannerQuickText.value || '').trim() : '';
      if (!text) return;
      const entry = ensureDayEntry(dateKey);
      entry.items.push({ id: uid('item'), text, done: false });
      if (plannerQuickText) plannerQuickText.value = '';
      plannerQuickOpen = false;
      plannerQuick.classList.remove('is-open');
      plannerQuickToggle.classList.remove('is-active');
      renderPlanner();
      plannerSaveDebounce();
    });
  }
  if (plannerHidePast) {
    plannerHidePast.addEventListener('change', () => {
      widgetPrefs.plannerHidePast = plannerHidePast.checked;
      updatePlannerState();
      prefsSaveDebounce();
    });
  }
  if (plannerFocusDate) {
    plannerFocusDate.addEventListener('change', () => {
      widgetPrefs.plannerFocusDate = plannerFocusDate.value || isoDate(new Date());
      prefsSaveDebounce();
      loadPlanner();
    });
  }
  if (plannerFocusToday) {
    plannerFocusToday.addEventListener('click', () => {
      widgetPrefs.plannerFocusDate = isoDate(new Date());
      if (plannerFocusDate) plannerFocusDate.value = widgetPrefs.plannerFocusDate;
      prefsSaveDebounce();
      loadPlanner();
    });
  }

  applyWidgetPrefs();
  renderNotes();
  renderPlannerPalette();
  loadNotes();
  loadPlanner();
})();
