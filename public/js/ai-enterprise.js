(() => {
  const root = document.querySelector('[data-ai-root]');
  if (!root) return;

  const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
  const form = root.querySelector('[data-composer]');
  const input = form ? form.querySelector('textarea[name="content"]') : null;
  const messages = root.querySelector('[data-messages]');
  const layout = root.querySelector('.ai-internal-layout');
  const historyToggle = root.querySelector('[data-history-toggle]');
  const resultPanel = root.querySelector('[data-result-panel]');
  const resultSummary = root.querySelector('[data-result-summary]');
  const resultHead = root.querySelector('[data-result-head]');
  const resultBody = root.querySelector('[data-result-body]');
  let lastIntent = '';
  let lastQuestion = '';
  let busy = false;
  const LONG_MESSAGE_LIMIT = 520;

  const KNOWN_ROOTS = new Set([
    'dashboard', 'launcher', 'workspace', 'inventory', 'categories', 'brands',
    'customers', 'consignatarios', 'packages', 'carrier-reception', 'invoices',
    'accounting', 'settings', 'users', 'manifests', 'airway-bills', 'cuscar',
    'projects', 'sales', 'suppliers', 'rrhh', 'ai', 'chat', 'notifications',
    'whatsapp', 'meta-inbox', 'mensajeria-meta', 'production'
  ]);

  function basePath() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return '';
    return KNOWN_ROOTS.has(parts[0]) ? '' : `/${parts[0]}`;
  }

  function appUrl(path) {
    return `${basePath()}${path}`;
  }

  async function postJson(url, payload) {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify(payload || {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || 'No se pudo completar la solicitud.');
    }
    return data;
  }

  function appendMessage(role, content) {
    if (!messages) {
      window.alert(content || 'No se pudo completar la solicitud.');
      return null;
    }
    messages.querySelector('.ai-welcome')?.remove();
    const article = document.createElement('article');
    article.className = `ai-message ai-message--${role}`;
    const body = document.createElement('div');
    body.className = 'ai-message__body';
    body.textContent = content || '';
    const time = document.createElement('time');
    time.textContent = new Date().toLocaleString();
    article.appendChild(body);
    if (role === 'assistant' && String(content || '').length > LONG_MESSAGE_LIMIT) {
      article.classList.add('is-collapsed');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'ai-message__toggle';
      toggle.textContent = 'Ver mas';
      toggle.addEventListener('click', () => {
        const collapsed = article.classList.toggle('is-collapsed');
        toggle.textContent = collapsed ? 'Ver mas' : 'Ver menos';
      });
      article.appendChild(toggle);
    }
    article.appendChild(time);
    messages.appendChild(article);
    messages.scrollTop = messages.scrollHeight;
    return article;
  }

  if (historyToggle && layout) {
    historyToggle.addEventListener('click', () => {
      const collapsed = layout.classList.toggle('is-history-collapsed');
      historyToggle.textContent = collapsed ? '+' : '-';
      historyToggle.setAttribute('aria-label', collapsed ? 'Mostrar historial' : 'Ocultar historial');
      historyToggle.setAttribute('title', collapsed ? 'Mostrar historial' : 'Ocultar historial');
    });
  }

  function renderTable(data) {
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const columns = Array.isArray(data.columns) && data.columns.length
      ? data.columns
      : Object.keys(rows[0] || {});
    if (!resultPanel || !resultHead || !resultBody) return;
    resultPanel.hidden = !rows.length;
    resultSummary.textContent = data.summary || data.answer || '';
    resultHead.innerHTML = '';
    resultBody.innerHTML = '';
    if (!rows.length) return;
    const headerRow = document.createElement('tr');
    columns.forEach((column) => {
      const th = document.createElement('th');
      th.textContent = column;
      headerRow.appendChild(th);
    });
    resultHead.appendChild(headerRow);
    rows.slice(0, 40).forEach((row) => {
      const tr = document.createElement('tr');
      columns.forEach((column) => {
        const td = document.createElement('td');
        td.textContent = row[column] === null || row[column] === undefined ? '' : row[column];
        tr.appendChild(td);
      });
      resultBody.appendChild(tr);
    });
  }

  async function ask(question) {
    const value = String(question || '').trim();
    if (busy || !value) return;
    busy = true;
    lastQuestion = value;
    appendMessage('user', value);
    const typing = appendMessage('assistant', 'Consultando datos internos...');
    try {
      const data = await postJson(appUrl('/ai/ask'), { question: value });
      typing.remove();
      appendMessage('assistant', data.answer || 'Sin respuesta.');
      lastIntent = data.intent || '';
      renderTable(data);
    } catch (err) {
      typing.remove();
      appendMessage('assistant', err.message || 'Ocurrió un error.');
    } finally {
      busy = false;
    }
  }

  if (form && input) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = input.value;
      input.value = '';
      ask(value);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
  }

  root.querySelectorAll('[data-ai-prompt]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!input) return;
      input.value = button.dataset.aiPrompt || '';
      input.focus();
    });
  });

  root.querySelectorAll('[data-history-question]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!input) return;
      input.value = button.dataset.historyQuestion || '';
      input.focus();
    });
  });

  root.querySelectorAll('[data-export-format]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!lastIntent) {
        appendMessage('assistant', 'Primero ejecuta una consulta con resultados para exportar.');
        return;
      }
      try {
        const data = await postJson(appUrl('/ai/export'), {
          intent: lastIntent,
          format: button.dataset.exportFormat || 'xlsx',
          question: lastQuestion
        });
        appendMessage('assistant', `Archivo generado: ${data.fileName}`);
        window.location.href = appUrl(data.publicPath);
      } catch (err) {
        appendMessage('assistant', err.message || 'No se pudo exportar.');
      }
    });
  });

  root.querySelectorAll('[data-toggle-intent]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await postJson(appUrl(`/ai/intents/${button.dataset.toggleIntent}/toggle`), {});
        window.location.reload();
      } catch (err) {
        appendMessage('assistant', err.message || 'No se pudo cambiar la intención.');
      }
    });
  });
})();
