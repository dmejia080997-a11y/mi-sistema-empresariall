(function () {
  const bootstrapNode = document.getElementById('workspace-bootstrap');
  if (!bootstrapNode) return;

  let bootstrap;
  try {
    bootstrap = JSON.parse(bootstrapNode.textContent || '{}');
  } catch (err) {
    return;
  }

  const labels = bootstrap.labels || {};
  const endpoints = bootstrap.endpoints || {};
  const icons = bootstrap.icons || {};
  const refs = {
    stage: document.getElementById('workspace-stage'),
    dock: document.getElementById('workspace-dock'),
    strip: document.getElementById('workspace-app-strip'),
    count: document.getElementById('workspace-module-count'),
    status: document.getElementById('workspace-status'),
    panel: document.getElementById('workspace-panel'),
    panelClose: document.getElementById('workspace-panel-close'),
    settingsToggle: document.getElementById('workspace-settings-toggle'),
    positionButtons: Array.from(document.querySelectorAll('[data-dock-position]')),
    save: document.getElementById('workspace-save'),
    visualReset: document.getElementById('workspace-visual-reset'),
    feedback: document.getElementById('workspace-save-feedback'),
    iconStyle: document.getElementById('workspace-icon-style'),
    layoutMode: document.getElementById('workspace-layout-mode'),
    themeColor: document.getElementById('workspace-theme-color'),
    accentColor: document.getElementById('workspace-accent-color'),
    backgroundColor: document.getElementById('workspace-background-color'),
    dockColor: document.getElementById('workspace-dock-color'),
    dockApps: document.getElementById('workspace-dock-apps'),
    dockEnabled: document.getElementById('workspace-dock-enabled'),
    dockMode: document.getElementById('workspace-dock-mode'),
    iconSize: document.getElementById('workspace-icon-size'),
    iconSizeValue: document.getElementById('workspace-icon-size-value'),
    glassEffect: document.getElementById('workspace-glass-effect'),
    showLabels: document.getElementById('workspace-show-labels')
  };

  const defaultSettings = {
    dockEnabled: true,
    dockPosition: 'left',
    dockMode: 'auto-hide',
    dockAutoHide: true,
    dockSize: 88,
    showLabels: true,
    themeColor: '#26445f',
    accentColor: '#247c7a',
    backgroundColor: '#eef3f5',
    dockColor: '#243041',
    dockModules: null,
    iconStyle: 'soft',
    iconSize: 88,
    useGlassEffect: true,
    layoutMode: 'light'
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clamp(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, numeric));
  }

  function normalizeColor(value, fallback) {
    const text = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
  }

  function normalizeDockModuleList(raw) {
    if (Array.isArray(raw)) {
      return raw
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);
    }
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      return parsed
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);
    } catch (err) {
      return null;
    }
  }

  function buildDefaultDockModules(modules) {
    const defaults = [];
    const availableKeys = modules.map((module) => module.moduleKey);
    ['notes', 'planner'].forEach((key) => {
      if (!availableKeys.includes(key) || defaults.includes(key)) return;
      defaults.push(key);
    });
    availableKeys.forEach((key) => {
      if (defaults.length >= 5 || defaults.includes(key)) return;
      defaults.push(key);
    });
    return defaults;
  }

  function resolveDockModules(raw, modules, fallback) {
    const availableKeys = modules.map((module) => module.moduleKey);
    const allowed = new Set(availableKeys);
    if (!availableKeys.length) return [];

    const parsed = normalizeDockModuleList(raw);
    if (parsed !== null) {
      return parsed.filter((key, index) => allowed.has(key) && parsed.indexOf(key) === index);
    }

    const fallbackParsed = normalizeDockModuleList(fallback);
    if (fallbackParsed !== null) {
      return fallbackParsed.filter((key, index) => allowed.has(key) && fallbackParsed.indexOf(key) === index);
    }

    return buildDefaultDockModules(modules);
  }

  function normalizeSettings(raw, modules, fallback) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const safeFallback = fallback && typeof fallback === 'object' ? fallback : defaultSettings;
    const dockPosition = ['left', 'right', 'top', 'bottom', 'center-top', 'center-bottom'].includes(input.dockPosition)
      ? input.dockPosition
      : safeFallback.dockPosition || defaultSettings.dockPosition;
    const dockMode = ['fixed', 'auto-hide', 'expandable'].includes(input.dockMode)
      ? input.dockMode
      : safeFallback.dockMode || defaultSettings.dockMode;
    const iconSize = clamp(input.iconSize || input.dockSize, 68, 116, safeFallback.iconSize || defaultSettings.iconSize);
    const rawDockModules = Object.prototype.hasOwnProperty.call(input, 'dockModules') ? input.dockModules : input.dock_modules;
    return {
      dockEnabled: input.dockEnabled !== false,
      dockPosition,
      dockMode,
      dockAutoHide: input.dockAutoHide !== false,
      dockSize: iconSize,
      showLabels: input.showLabels !== false,
      themeColor: normalizeColor(input.themeColor, safeFallback.themeColor || defaultSettings.themeColor),
      accentColor: normalizeColor(input.accentColor, safeFallback.accentColor || defaultSettings.accentColor),
      backgroundColor: normalizeColor(input.backgroundColor, safeFallback.backgroundColor || defaultSettings.backgroundColor),
      dockColor: normalizeColor(input.dockColor, safeFallback.dockColor || defaultSettings.dockColor),
      dockModules: resolveDockModules(rawDockModules, modules, safeFallback.dockModules),
      iconStyle: ['soft', 'solid', 'outline'].includes(input.iconStyle) ? input.iconStyle : (safeFallback.iconStyle || defaultSettings.iconStyle),
      iconSize,
      useGlassEffect: input.useGlassEffect !== false,
      layoutMode: ['light', 'dark'].includes(input.layoutMode) ? input.layoutMode : (safeFallback.layoutMode || defaultSettings.layoutMode)
    };
  }

  function normalizeModules(rawModules) {
    const modules = Array.isArray(rawModules) ? rawModules : [];
    return modules
      .filter((module) => module && module.moduleKey && module.isVisible !== false)
      .map((module, index) => ({
        moduleKey: String(module.moduleKey),
        name: String(module.name || module.moduleKey),
        desc: String(module.desc || ''),
        href: String(module.href || '#'),
        iconName: String(module.iconName || 'default'),
        color: normalizeColor(module.color, defaultSettings.accentColor),
        group: String(module.group || 'general'),
        sortOrder: Number.isFinite(Number(module.sortOrder)) ? Number(module.sortOrder) : index
      }))
      .sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
      });
  }

  let state = {
    modules: normalizeModules(bootstrap.workspaceState && bootstrap.workspaceState.modules),
    settings: defaultSettings
  };
  state.settings = normalizeSettings(bootstrap.workspaceState && bootstrap.workspaceState.settings, state.modules);
  let savedSettings = clone(state.settings);
  let panelOpen = Boolean(bootstrap.settingsPanelOpen);
  let dockHideTimer = null;
  let dockHotspot = null;

  function iconMarkup(name) {
    return icons[name] || icons.default || '';
  }

  function moduleMarkup(module, className) {
    const color = escapeHtml(module.color || state.settings.accentColor);
    return `
      <span class="${className}__icon" style="--item-color:${color}">${iconMarkup(module.iconName)}</span>
      <span class="${className}__name">${escapeHtml(module.name)}</span>
    `;
  }

  function getDockModules() {
    const selected = new Set(Array.isArray(state.settings.dockModules) ? state.settings.dockModules : []);
    return state.modules.filter((module) => selected.has(module.moduleKey));
  }

  function applyTheme() {
    document.body.style.setProperty('--workspace-theme', state.settings.themeColor);
    document.body.style.setProperty('--workspace-accent', state.settings.accentColor);
    document.body.style.setProperty('--workspace-bg', state.settings.backgroundColor);
    document.body.style.setProperty('--workspace-dock', state.settings.dockColor);
    document.body.style.setProperty('--workspace-icon-size', `${state.settings.iconSize}px`);
    document.body.classList.toggle('workspace-theme-dark', state.settings.layoutMode === 'dark');
    document.body.classList.toggle('workspace-no-glass', !state.settings.useGlassEffect);

    ['left', 'right', 'top', 'bottom', 'center-top', 'center-bottom'].forEach((position) => {
      refs.stage.classList.toggle(`is-dock-${position}`, state.settings.dockPosition === position);
    });
    ['soft', 'solid', 'outline'].forEach((style) => {
      refs.stage.classList.toggle(`is-style-${style}`, state.settings.iconStyle === style);
    });
    refs.stage.classList.toggle('is-glass', Boolean(state.settings.useGlassEffect));
    refs.stage.classList.toggle('is-labels-hidden', !state.settings.showLabels);
    refs.stage.classList.toggle('is-dock-disabled', !state.settings.dockEnabled);
    ['fixed', 'auto-hide', 'expandable'].forEach((mode) => {
      refs.stage.classList.toggle(`is-dock-mode-${mode}`, state.settings.dockMode === mode);
    });
  }

  function setDockRevealed(revealed) {
    clearTimeout(dockHideTimer);
    const isFixed = state.settings.dockMode === 'fixed';
    const isExpandable = state.settings.dockMode === 'expandable';
    const visible = state.settings.dockEnabled && (isFixed || isExpandable || Boolean(revealed));
    const expanded = isFixed || (isExpandable ? Boolean(revealed) : visible);
    refs.stage.classList.toggle('is-dock-revealed', visible);
    refs.stage.classList.toggle('is-dock-expanded', expanded);
    refs.dock.setAttribute('aria-hidden', visible ? 'false' : 'true');
    refs.dock.querySelectorAll('a').forEach((link) => {
      if (visible) {
        link.removeAttribute('tabindex');
      } else {
        link.setAttribute('tabindex', '-1');
      }
    });
  }

  function scheduleDockHide() {
    if (state.settings.dockMode === 'fixed') return;
    clearTimeout(dockHideTimer);
    dockHideTimer = setTimeout(() => {
      if (refs.dock.matches(':hover') || (dockHotspot && dockHotspot.matches(':hover')) || refs.dock.contains(document.activeElement)) return;
      setDockRevealed(false);
    }, 180);
  }

  function ensureDockHotspot() {
    if (dockHotspot || !refs.stage || !refs.dock) return;
    dockHotspot = document.createElement('button');
    dockHotspot.type = 'button';
    dockHotspot.className = 'workspace-dock-hotspot';
    dockHotspot.setAttribute('aria-label', labels.showDock || 'Mostrar dock');
    refs.stage.appendChild(dockHotspot);

    [dockHotspot, refs.dock].forEach((element) => {
      element.addEventListener('mouseenter', () => setDockRevealed(true));
      element.addEventListener('mouseleave', scheduleDockHide);
      element.addEventListener('focusin', () => setDockRevealed(true));
      element.addEventListener('focusout', scheduleDockHide);
    });
    dockHotspot.addEventListener('click', () => {
      if (state.settings.dockMode === 'expandable') {
        setDockRevealed(!refs.stage.classList.contains('is-dock-expanded'));
        return;
      }
      setDockRevealed(true);
    });
    dockHotspot.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      setDockRevealed(true);
      const firstLink = refs.dock.querySelector('a');
      if (firstLink) firstLink.focus();
    });
  }

  function updateControls() {
    refs.positionButtons.forEach((button) => {
      const active = button.dataset.dockPosition === state.settings.dockPosition;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    refs.iconStyle.value = state.settings.iconStyle;
    refs.layoutMode.value = state.settings.layoutMode;
    refs.dockEnabled.checked = Boolean(state.settings.dockEnabled);
    refs.dockMode.value = state.settings.dockMode;
    refs.themeColor.value = state.settings.themeColor;
    refs.accentColor.value = state.settings.accentColor;
    refs.backgroundColor.value = state.settings.backgroundColor;
    refs.dockColor.value = state.settings.dockColor;
    refs.iconSize.value = state.settings.iconSize;
    refs.iconSizeValue.textContent = `${state.settings.iconSize}px`;
    refs.glassEffect.checked = Boolean(state.settings.useGlassEffect);
    refs.showLabels.checked = Boolean(state.settings.showLabels);
    refs.panel.classList.toggle('is-open', panelOpen);
    refs.dockApps.innerHTML = '';

    if (!state.modules.length) {
      const empty = document.createElement('div');
      empty.className = 'workspace-dock-apps__empty';
      empty.textContent = labels.dockAppsEmpty || 'No hay aplicaciones disponibles para este dock.';
      refs.dockApps.appendChild(empty);
      return;
    }

    const selected = new Set(Array.isArray(state.settings.dockModules) ? state.settings.dockModules : []);
    state.modules.forEach((module) => {
      const item = document.createElement('label');
      item.className = 'workspace-dock-apps__item';
      item.innerHTML = `
        <input type="checkbox" value="${escapeHtml(module.moduleKey)}"${selected.has(module.moduleKey) ? ' checked' : ''} />
        <span class="workspace-dock-apps__icon" style="--item-color:${escapeHtml(module.color || state.settings.accentColor)}">${iconMarkup(module.iconName)}</span>
        <span class="workspace-dock-apps__text">
          <strong>${escapeHtml(module.name)}</strong>
          <small>${escapeHtml(module.desc || module.href)}</small>
        </span>
      `;
      refs.dockApps.appendChild(item);
    });
  }

  function renderDock() {
    refs.dock.innerHTML = '';
    const dockModules = getDockModules();
    let lastGroup = null;

    dockModules.forEach((module, index) => {
      if (index > 0 && module.group !== lastGroup) {
        const separator = document.createElement('span');
        separator.className = 'workspace-dock__separator';
        separator.setAttribute('aria-hidden', 'true');
        refs.dock.appendChild(separator);
      }

      const wrapper = document.createElement('div');
      wrapper.className = 'workspace-dock__slot';
      wrapper.innerHTML = `
        <a class="workspace-dock-app" href="${escapeHtml(module.href)}" title="${escapeHtml(module.name)}">
          ${moduleMarkup(module, 'workspace-dock-app')}
        </a>
      `;
      refs.dock.appendChild(wrapper);
      lastGroup = module.group;
    });

    if (!dockModules.length) {
      const empty = document.createElement('div');
      empty.className = 'workspace-empty';
      empty.textContent = labels.noModules || 'No hay modulos disponibles para este usuario.';
      refs.dock.appendChild(empty);
    }
  }

  function renderStrip() {
    refs.strip.innerHTML = '';
    state.modules.slice(0, 12).forEach((module) => {
      const link = document.createElement('a');
      link.className = 'workspace-strip-app';
      link.href = module.href;
      link.title = module.name;
      link.innerHTML = moduleMarkup(module, 'workspace-strip-app');
      refs.strip.appendChild(link);
    });
  }

  function render() {
    applyTheme();
    updateControls();
    renderDock();
    renderStrip();
    refs.count.textContent = String(state.modules.length);
    refs.status.textContent = labels.ready || 'Listo para usar';
    ensureDockHotspot();
    setDockRevealed(refs.stage.classList.contains('is-dock-revealed'));
  }

  function setFeedback(message, type) {
    refs.feedback.textContent = message || labels.dockHint || '';
    refs.feedback.classList.toggle('is-success', type === 'success');
    refs.feedback.classList.toggle('is-error', type === 'error');
  }

  async function saveSettings() {
    refs.save.disabled = true;
    const originalText = refs.save.textContent;
    refs.save.textContent = labels.saving || 'Guardando...';
    setFeedback(labels.saving || 'Guardando...', null);

    try {
      const response = await fetch(endpoints.save, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'csrf-token': bootstrap.csrfToken || ''
        },
        body: JSON.stringify({ settings: state.settings })
      });
      if (!response.ok) throw new Error('save_failed');
      const payload = await response.json();
      if (!payload || !payload.ok) throw new Error('save_failed');
      state.settings = normalizeSettings(payload.state && payload.state.settings ? payload.state.settings : state.settings, state.modules, state.settings);
      savedSettings = clone(state.settings);
      panelOpen = false;
      render();
      setFeedback(labels.saved || 'Ajustes guardados.', 'success');
    } catch (err) {
      setFeedback(labels.saveFailed || 'No se pudieron guardar los ajustes.', 'error');
    } finally {
      refs.save.disabled = false;
      refs.save.textContent = originalText;
    }
  }

  async function resetVisualSettings() {
    refs.visualReset.disabled = true;
    try {
      const response = await fetch(endpoints.settingsReset, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'csrf-token': bootstrap.csrfToken || ''
        },
        body: JSON.stringify({})
      });
      if (!response.ok) throw new Error('reset_failed');
      const payload = await response.json();
      if (!payload || !payload.ok) throw new Error('reset_failed');
      state.settings = normalizeSettings(payload.state && payload.state.settings ? payload.state.settings : defaultSettings, state.modules, defaultSettings);
      savedSettings = clone(state.settings);
      render();
      setFeedback(labels.saved || 'Ajustes guardados.', 'success');
    } catch (err) {
      setFeedback(labels.visualResetFailed || 'No se pudo restaurar la configuracion visual.', 'error');
    } finally {
      refs.visualReset.disabled = false;
    }
  }

  function updateSetting(key, value) {
    state.settings[key] = value;
    setFeedback(labels.dockHint || '', null);
    render();
  }

  function bindEvents() {
    refs.settingsToggle.addEventListener('click', () => {
      panelOpen = !panelOpen;
      render();
    });
    refs.panelClose.addEventListener('click', () => {
      panelOpen = false;
      state.settings = clone(savedSettings);
      render();
    });
    refs.positionButtons.forEach((button) => {
      button.addEventListener('click', () => {
        updateSetting('dockPosition', button.dataset.dockPosition || 'left');
      });
    });
    refs.iconStyle.addEventListener('change', () => updateSetting('iconStyle', refs.iconStyle.value));
    refs.layoutMode.addEventListener('change', () => updateSetting('layoutMode', refs.layoutMode.value));
    refs.dockEnabled.addEventListener('change', () => updateSetting('dockEnabled', refs.dockEnabled.checked));
    refs.dockMode.addEventListener('change', () => {
      state.settings.dockMode = refs.dockMode.value;
      state.settings.dockAutoHide = refs.dockMode.value === 'auto-hide';
      setFeedback(labels.dockHint || '', null);
      render();
    });
    refs.themeColor.addEventListener('input', () => updateSetting('themeColor', refs.themeColor.value));
    refs.accentColor.addEventListener('input', () => updateSetting('accentColor', refs.accentColor.value));
    refs.backgroundColor.addEventListener('input', () => updateSetting('backgroundColor', refs.backgroundColor.value));
    refs.dockColor.addEventListener('input', () => updateSetting('dockColor', refs.dockColor.value));
    refs.iconSize.addEventListener('input', () => {
      const nextSize = clamp(refs.iconSize.value, 68, 116, defaultSettings.iconSize);
      state.settings.iconSize = nextSize;
      state.settings.dockSize = nextSize;
      setFeedback(labels.dockHint || '', null);
      render();
    });
    refs.glassEffect.addEventListener('change', () => updateSetting('useGlassEffect', refs.glassEffect.checked));
    refs.showLabels.addEventListener('change', () => updateSetting('showLabels', refs.showLabels.checked));
    refs.dockApps.addEventListener('change', (event) => {
      const target = event.target;
      if (!target || target.type !== 'checkbox') return;
      const checked = Array.from(refs.dockApps.querySelectorAll('input[type="checkbox"]:checked'))
        .map((input) => input.value)
        .filter(Boolean);
      updateSetting('dockModules', checked);
    });
    refs.save.addEventListener('click', saveSettings);
    refs.visualReset.addEventListener('click', resetVisualSettings);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && panelOpen) {
        panelOpen = false;
        state.settings = clone(savedSettings);
        render();
        return;
      }
      if (event.key === 'Escape' && refs.stage.classList.contains('is-dock-revealed')) {
        setDockRevealed(false);
      }
    });
  }

  bindEvents();
  render();
})();
