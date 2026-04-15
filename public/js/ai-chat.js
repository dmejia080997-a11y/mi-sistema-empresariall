(() => {
  const BLOCKLIST = [/^\/login/, /^\/master/, /^\/customer/];
  if (BLOCKLIST.some((re) => re.test(window.location.pathname))) return;
  if (document.querySelector('[data-ai-chat-root]')) return;

  const MODULE_LABELS = {
    dashboard: 'Dashboard',
    inventory: 'Inventario',
    customers: 'Clientes',
    consignatarios: 'Consignatarios',
    packages: 'Paquetes',
    carrier_reception: 'Recepcion de carrier',
    billing: 'Facturacion',
    accounting: 'Contabilidad',
    settings: 'Configuracion',
    users: 'Usuarios',
    manifests: 'Manifiestos',
    airway_bills: 'Guia aerea',
    cuscar: 'CUSCAR'
  };

  const resolveModuleFromPath = (path) => {
    const rules = [
      { re: /^\/dashboard/, module: 'dashboard' },
      { re: /^\/launcher/, module: 'dashboard' },
      { re: /^\/inventory/, module: 'inventory' },
      { re: /^\/categories/, module: 'inventory' },
      { re: /^\/brands/, module: 'inventory' },
      { re: /^\/customers/, module: 'customers' },
      { re: /^\/consignatarios/, module: 'consignatarios' },
      { re: /^\/packages/, module: 'packages' },
      { re: /^\/carrier-reception/, module: 'carrier_reception' },
      { re: /^\/invoices/, module: 'billing' },
      { re: /^\/accounting/, module: 'accounting' },
      { re: /^\/settings/, module: 'settings' },
      { re: /^\/users/, module: 'users' },
      { re: /^\/manifests/, module: 'manifests' },
      { re: /^\/airway-bills/, module: 'airway_bills' },
      { re: /^\/cuscar/, module: 'cuscar' }
    ];
    const found = rules.find((rule) => rule.re.test(path));
    return found ? found.module : null;
  };

  const moduleCode = resolveModuleFromPath(window.location.pathname);
  const moduleLabel = moduleCode ? MODULE_LABELS[moduleCode] || moduleCode : 'Modulo actual';

  const root = document.createElement('div');
  root.className = 'ai-chat';
  root.dataset.aiChatRoot = 'true';
  root.innerHTML = `
    <div class="ai-chat__quick">
      <button class="ai-chat__quick-btn" type="button" data-ai-quick="notes" aria-label="Notas rapidas">
        <span class="ai-chat__quick-icon">N</span>
        <span class="ai-chat__quick-label">Notas</span>
      </button>
      <button class="ai-chat__quick-btn" type="button" data-ai-quick="planner" aria-label="Planificador rapido">
        <span class="ai-chat__quick-icon">P</span>
        <span class="ai-chat__quick-label">Planificador</span>
      </button>
    </div>
    <button class="ai-chat__fab" type="button" data-ai-chat-toggle aria-expanded="false" aria-controls="ai-chat-panel">
      <span class="ai-chat__fab-icon">?</span>
      <span class="ai-chat__fab-label">Ayuda</span>
    </button>
    <section class="ai-chat__panel" id="ai-chat-panel" aria-hidden="true">
      <div class="ai-chat__header">
        <div>
          <div class="ai-chat__title">Asistente del sistema</div>
          <div class="ai-chat__subtitle" data-ai-chat-module>${moduleLabel}</div>
        </div>
        <button class="ai-chat__close" type="button" data-ai-chat-close aria-label="Cerrar">×</button>
      </div>
      <div class="ai-chat__messages" data-ai-chat-messages></div>
      <form class="ai-chat__form" data-ai-chat-form>
        <input class="ai-chat__input" type="text" name="message" placeholder="Escribe tu pregunta..." autocomplete="off" />
        <button class="ai-chat__send" type="submit">Enviar</button>
      </form>
    </section>
  `;

  document.body.appendChild(root);

  const quickOverlay = document.createElement('div');
  quickOverlay.className = 'ai-quick';
  quickOverlay.innerHTML = `
    <div class="ai-quick__backdrop" data-ai-quick-backdrop></div>
    <div class="ai-quick__panel ai-quick__panel--notes" data-ai-quick-panel="notes" aria-hidden="true">
      <button class="ai-quick__close" type="button" data-ai-quick-close aria-label="Cerrar">×</button>
      <div class="ai-quick__header">
        <div class="ai-quick__title" id="ai-quick-notes-title">Nueva nota</div>
        <div class="ai-quick__subtitle">Se guarda en Inicio</div>
      </div>
      <div class="ai-quick__paper">
        <textarea class="ai-quick__textarea" data-ai-quick-notes-text placeholder="Escribe tu nota..."></textarea>
      </div>
      <div class="ai-quick__actions">
        <button class="ai-quick__cancel" type="button" data-ai-quick-cancel>Cancelar</button>
        <button class="ai-quick__save" type="button" data-ai-quick-save-notes>Guardar</button>
      </div>
      <div class="ai-quick__status" data-ai-quick-status-notes></div>
    </div>
    <div class="ai-quick__panel ai-quick__panel--planner" data-ai-quick-panel="planner" aria-hidden="true">
      <button class="ai-quick__close" type="button" data-ai-quick-close aria-label="Cerrar">×</button>
      <div class="ai-quick__header">
        <div class="ai-quick__title" id="ai-quick-planner-title">Nueva actividad</div>
        <div class="ai-quick__subtitle">Se guarda en Planificacion de Inicio</div>
      </div>
      <div class="ai-quick__fields">
        <label class="ai-quick__label" for="ai-quick-date">Fecha</label>
        <input class="ai-quick__input" type="date" id="ai-quick-date" data-ai-quick-planner-date />
        <label class="ai-quick__label" for="ai-quick-text">Actividad</label>
        <input class="ai-quick__input" type="text" id="ai-quick-text" data-ai-quick-planner-text placeholder="Escribe la actividad..." />
      </div>
      <div class="ai-quick__actions">
        <button class="ai-quick__cancel" type="button" data-ai-quick-cancel>Cancelar</button>
        <button class="ai-quick__save" type="button" data-ai-quick-save-planner>Guardar</button>
      </div>
      <div class="ai-quick__status" data-ai-quick-status-planner></div>
    </div>
  `;
  document.body.appendChild(quickOverlay);

  const toggleBtn = root.querySelector('[data-ai-chat-toggle]');
  const closeBtn = root.querySelector('[data-ai-chat-close]');
  const panel = root.querySelector('.ai-chat__panel');
  const messagesEl = root.querySelector('[data-ai-chat-messages]');
  const form = root.querySelector('[data-ai-chat-form]');
  const input = root.querySelector('.ai-chat__input');
  const sendBtn = root.querySelector('.ai-chat__send');
  const quickButtons = root.querySelectorAll('[data-ai-quick]');
  const quickBackdrop = quickOverlay.querySelector('[data-ai-quick-backdrop]');
  const quickPanels = quickOverlay.querySelectorAll('[data-ai-quick-panel]');
  const quickCloses = quickOverlay.querySelectorAll('[data-ai-quick-close]');
  const quickCancels = quickOverlay.querySelectorAll('[data-ai-quick-cancel]');
  const notesTextarea = quickOverlay.querySelector('[data-ai-quick-notes-text]');
  const notesSave = quickOverlay.querySelector('[data-ai-quick-save-notes]');
  const notesStatus = quickOverlay.querySelector('[data-ai-quick-status-notes]');
  const plannerDate = quickOverlay.querySelector('[data-ai-quick-planner-date]');
  const plannerText = quickOverlay.querySelector('[data-ai-quick-planner-text]');
  const plannerSave = quickOverlay.querySelector('[data-ai-quick-save-planner]');
  const plannerStatus = quickOverlay.querySelector('[data-ai-quick-status-planner]');
  const tokenEl = document.querySelector('meta[name="csrf-token"]');
  let csrfToken = tokenEl ? tokenEl.getAttribute('content') : null;
  let permissionMap = null;
  let quickOpenPanel = null;
  let quickBusy = false;

  const NOTE_COLORS = ['#fff07a', '#ff9ad7', '#7de7ff', '#b3ff8f', '#ffb86b', '#c9a3ff'];

  const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const padNumber = (value) => String(value).padStart(2, '0');
  const toIsoDate = (date) =>
    `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`;

  const setQuickStatus = (el, message) => {
    if (!el) return;
    el.textContent = message || '';
  };

  const setQuickOpen = (panelKey) => {
    quickOpenPanel = panelKey || null;
    quickOverlay.classList.toggle('is-open', !!panelKey);
    document.body.classList.toggle('ai-quick-open', !!panelKey);
    quickPanels.forEach((panelEl) => {
      const isActive = panelEl.dataset.aiQuickPanel === panelKey;
      panelEl.classList.toggle('is-active', isActive);
      panelEl.setAttribute('aria-hidden', String(!isActive));
    });
    if (panelKey === 'notes' && notesTextarea) {
      setTimeout(() => notesTextarea.focus(), 80);
    }
    if (panelKey === 'planner' && plannerText) {
      if (plannerDate) plannerDate.value = toIsoDate(new Date());
      setTimeout(() => plannerText.focus(), 80);
    }
  };

  const closeQuick = () => {
    setQuickOpen(null);
    setQuickStatus(notesStatus, '');
    setQuickStatus(plannerStatus, '');
  };

  const fetchJson = async (url, options) => {
    const resp = await fetch(url, options);
    const data = await resp.json().catch(() => null);
    return { ok: resp.ok, data };
  };

  const setOpen = (open) => {
    root.classList.toggle('ai-chat--open', open);
    toggleBtn.setAttribute('aria-expanded', String(open));
    panel.setAttribute('aria-hidden', String(!open));
    if (open) {
      setTimeout(() => input.focus(), 120);
    }
  };

  const appendMessage = (role, text) => {
    const msg = document.createElement('div');
    msg.className = `ai-chat__message ai-chat__message--${role}`;
    const lines = String(text || '').split('\n');
    lines.forEach((line, idx) => {
      const span = document.createElement('span');
      span.textContent = line;
      msg.appendChild(span);
      if (idx < lines.length - 1) {
        msg.appendChild(document.createElement('br'));
      }
    });
    messagesEl.appendChild(msg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return msg;
  };

  const ensureCsrfToken = async () => {
    if (csrfToken) return csrfToken;
    try {
      const response = await fetch('/ai/token', { credentials: 'same-origin' });
      const data = await response.json();
      if (response.ok && data && data.token) {
        csrfToken = data.token;
        return csrfToken;
      }
    } catch (err) {
      return null;
    }
    return null;
  };

  const loadPermissions = async () => {
    if (permissionMap) return permissionMap;
    try {
      const response = await fetch('/ai/context', { credentials: 'same-origin' });
      const data = await response.json();
      if (response.ok && data) {
        permissionMap = data.permissions || null;
        return permissionMap;
      }
    } catch (err) {
      return null;
    }
    return null;
  };

  const welcomeLines = [
    `Hola, soy tu asistente de ayuda para ${moduleLabel}.`,
    'Ahora puedo enviar tus preguntas al servidor.',
    'Escribe tu consulta para empezar.'
  ];
  appendMessage('bot', welcomeLines.join('\n'));

  let busy = false;

  const sendQuestion = async (question) => {
    if (busy) return;
    const trimmed = String(question || '').trim();
    if (!trimmed) return;

    busy = true;
    sendBtn.disabled = true;
    appendMessage('user', trimmed);
    const typing = appendMessage('bot', 'Escribiendo...');
    typing.classList.add('ai-chat__typing');

    try {
      const token = await ensureCsrfToken();
      const perms = await loadPermissions();
      const payload = {
        question: trimmed,
        module: moduleCode,
        route: window.location.pathname,
        page_title: document.title,
        permissions: perms,
        _csrf: token
      };

      const response = await fetch('/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      });

      const data = await response.json().catch(() => null);
      typing.remove();

      if (!response.ok || !data || !data.answer) {
        const msg = data && data.error ? data.error : 'No pude responder en este momento.';
        appendMessage('bot', msg);
      } else {
        appendMessage('bot', data.answer);
      }
    } catch (err) {
      typing.remove();
      appendMessage('bot', 'Ocurrio un error al consultar la ayuda.');
    } finally {
      busy = false;
      sendBtn.disabled = false;
    }
  };

  toggleBtn.addEventListener('click', () => {
    setOpen(!root.classList.contains('ai-chat--open'));
  });

  closeBtn.addEventListener('click', () => setOpen(false));

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value;
    input.value = '';
    sendQuestion(value);
  });

  if (quickButtons && quickButtons.length) {
    quickButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.aiQuick;
        if (!target) return;
        setQuickOpen(target);
      });
    });
  }

  if (quickBackdrop) {
    quickBackdrop.addEventListener('click', closeQuick);
  }

  if (quickCloses && quickCloses.length) {
    quickCloses.forEach((btn) => btn.addEventListener('click', closeQuick));
  }

  if (quickCancels && quickCancels.length) {
    quickCancels.forEach((btn) => btn.addEventListener('click', closeQuick));
  }

  if (notesSave) {
    notesSave.addEventListener('click', async () => {
      if (quickBusy) return;
      const text = (notesTextarea && notesTextarea.value ? notesTextarea.value : '').trim();
      if (!text) return;
      setQuickStatus(notesStatus, '');
      quickBusy = true;
      notesSave.disabled = true;
      try {
        const token = await ensureCsrfToken();
        const existingResp = await fetchJson('/launcher/notes', { headers: { 'Accept': 'application/json' } });
        const existingNotes = existingResp.ok && existingResp.data && Array.isArray(existingResp.data.notes)
          ? existingResp.data.notes
          : [];
        const nextColor = NOTE_COLORS[existingNotes.length % NOTE_COLORS.length];
        const newNote = {
          id: createId(),
          text,
          color: nextColor
        };
        const payloadNotes = [newNote, ...existingNotes].map((note, index) => ({
          id: note.id || createId(),
          text: note.text || '',
          color: note.color || nextColor,
          position: index
        }));
        const saveResp = await fetchJson('/launcher/notes', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': token || ''
          },
          body: JSON.stringify({ notes: payloadNotes })
        });
        if (!saveResp.ok) {
          setQuickStatus(notesStatus, 'No se pudo guardar la nota.');
          return;
        }
        if (notesTextarea) notesTextarea.value = '';
        closeQuick();
      } catch (err) {
        setQuickStatus(notesStatus, 'Ocurrio un error al guardar.');
      } finally {
        quickBusy = false;
        notesSave.disabled = false;
      }
    });
  }

  if (plannerSave) {
    plannerSave.addEventListener('click', async () => {
      if (quickBusy) return;
      const text = (plannerText && plannerText.value ? plannerText.value : '').trim();
      if (!text) return;
      const dateValue = plannerDate && plannerDate.value ? plannerDate.value : toIsoDate(new Date());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return;
      setQuickStatus(plannerStatus, '');
      quickBusy = true;
      plannerSave.disabled = true;
      try {
        const token = await ensureCsrfToken();
        const loadResp = await fetchJson(`/launcher/planner?start=${dateValue}&end=${dateValue}`, {
          headers: { 'Accept': 'application/json' }
        });
        const existingItems =
          loadResp.ok &&
          loadResp.data &&
          Array.isArray(loadResp.data.entries) &&
          loadResp.data.entries[0] &&
          Array.isArray(loadResp.data.entries[0].items)
            ? loadResp.data.entries[0].items
            : [];
        const nextItems = [...existingItems, { id: createId(), text, done: false }];
        const saveResp = await fetchJson('/launcher/planner', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': token || ''
          },
          body: JSON.stringify({ entries: [{ date: dateValue, items: nextItems }] })
        });
        if (!saveResp.ok) {
          setQuickStatus(plannerStatus, 'No se pudo guardar la actividad.');
          return;
        }
        if (plannerText) plannerText.value = '';
        closeQuick();
      } catch (err) {
        setQuickStatus(plannerStatus, 'Ocurrio un error al guardar.');
      } finally {
        quickBusy = false;
        plannerSave.disabled = false;
      }
    });
  }
})();
