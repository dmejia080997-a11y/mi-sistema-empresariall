(function () {
  if (window.__globalDockLoaded) return;
  window.__globalDockLoaded = true;

  const defaultSettings = {
    dockEnabled: true,
    dockPosition: 'left',
    dockMode: 'auto-hide',
    dockAutoHide: true,
    dockSize: 92,
    showLabels: true,
    themeColor: '#26445f',
    accentColor: '#247c7a',
    backgroundColor: '#eef3f5',
    dockColor: '#172033',
    dockModules: null,
    iconStyle: 'soft',
    iconSize: 92,
    useGlassEffect: true,
    layoutMode: 'light'
  };

  const positions = ['left', 'right', 'top', 'bottom', 'center-top', 'center-bottom'];
  const modes = ['fixed', 'auto-hide', 'expandable'];

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeColor(value, fallback) {
    const text = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
  }

  function clamp(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, numeric));
  }

  function normalizeBool(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const text = String(value == null ? '' : value).toLowerCase();
    if (['1', 'true', 'on', 'yes', 'si'].includes(text)) return true;
    if (['0', 'false', 'off', 'no'].includes(text)) return false;
    return fallback;
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
    const iconSize = clamp(
      input.iconSize || input.icon_size || input.dockSize || input.dock_size,
      72,
      132,
      safeFallback.iconSize || defaultSettings.iconSize
    );
    const dockMode = modes.includes(String(input.dockMode || input.dock_mode || '').toLowerCase())
      ? String(input.dockMode || input.dock_mode).toLowerCase()
      : safeFallback.dockMode || defaultSettings.dockMode;
    return {
      dockEnabled: normalizeBool(
        Object.prototype.hasOwnProperty.call(input, 'dockEnabled') ? input.dockEnabled : input.dock_enabled,
        safeFallback.dockEnabled
      ),
      dockPosition: positions.includes(String(input.dockPosition || input.dock_position || '').toLowerCase())
        ? String(input.dockPosition || input.dock_position).toLowerCase()
        : safeFallback.dockPosition || defaultSettings.dockPosition,
      dockMode,
      dockAutoHide: normalizeBool(
        Object.prototype.hasOwnProperty.call(input, 'dockAutoHide') ? input.dockAutoHide : input.dock_auto_hide,
        dockMode === 'auto-hide'
      ),
      dockSize: iconSize,
      dockModules: resolveDockModules(
        Object.prototype.hasOwnProperty.call(input, 'dockModules') ? input.dockModules : input.dock_modules,
        modules,
        safeFallback.dockModules
      ),
      showLabels: normalizeBool(
        Object.prototype.hasOwnProperty.call(input, 'showLabels') ? input.showLabels : input.show_labels,
        safeFallback.showLabels
      ),
      themeColor: normalizeColor(input.themeColor || input.theme_color, safeFallback.themeColor || defaultSettings.themeColor),
      accentColor: normalizeColor(input.accentColor || input.accent_color, safeFallback.accentColor || defaultSettings.accentColor),
      backgroundColor: normalizeColor(input.backgroundColor || input.background_color, safeFallback.backgroundColor || defaultSettings.backgroundColor),
      dockColor: normalizeColor(input.dockColor || input.dock_color, safeFallback.dockColor || defaultSettings.dockColor),
      iconStyle: ['soft', 'solid', 'outline'].includes(input.iconStyle || input.icon_style)
        ? input.iconStyle || input.icon_style
        : safeFallback.iconStyle || defaultSettings.iconStyle,
      iconSize,
      useGlassEffect: normalizeBool(
        Object.prototype.hasOwnProperty.call(input, 'useGlassEffect') ? input.useGlassEffect : input.use_glass_effect,
        safeFallback.useGlassEffect
      ),
      layoutMode: ['light', 'dark'].includes(input.layoutMode || input.layout_mode)
        ? input.layoutMode || input.layout_mode
        : safeFallback.layoutMode || defaultSettings.layoutMode
    };
  }

  function normalizeModules(rawModules, settings, currentPath) {
    const modules = Array.isArray(rawModules) ? rawModules : [];
    return modules
      .filter((module) => module && module.moduleKey && module.isVisible !== false)
      .map((module, index) => {
        const href = String(module.href || '#');
        return {
          moduleKey: String(module.moduleKey),
          name: String(module.name || module.moduleKey),
          href,
          iconName: String(module.iconName || 'default'),
          color: normalizeColor(module.color, settings.accentColor),
          group: String(module.group || 'general'),
          sortOrder: Number.isFinite(Number(module.sortOrder)) ? Number(module.sortOrder) : index,
          isActive: isActiveHref(href, currentPath)
        };
      })
      .sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
      });
  }

  function iconMarkup(icons, name) {
    return icons[name] || icons.default || '';
  }

  function pathParts(value) {
    try {
      const url = new URL(value, window.location.origin);
      return {
        path: url.pathname.replace(/\/+$/, '') || '/',
        query: url.search || ''
      };
    } catch (err) {
      return { path: '/', query: '' };
    }
  }

  function isActiveHref(href, currentPath) {
    const current = pathParts(currentPath || `${window.location.pathname}${window.location.search}`);
    const target = pathParts(href);
    if (target.query && current.path === target.path) return current.query === target.query;
    if (target.path === '/') return current.path === '/';
    return current.path === target.path || current.path.startsWith(`${target.path}/`);
  }

  function effectivePosition(position) {
    const mobile = window.matchMedia('(max-width: 760px)').matches;
    if (!mobile) return position;
    if (position === 'top' || position === 'center-top') return 'top';
    return 'bottom';
  }

  function setLinksEnabled(dock, enabled) {
    dock.querySelectorAll('a').forEach((link) => {
      if (enabled) {
        link.removeAttribute('tabindex');
      } else {
        link.setAttribute('tabindex', '-1');
      }
    });
    dock.setAttribute('aria-hidden', enabled ? 'false' : 'true');
  }

  function syncBodyDockState(position, mode) {
    if (!document.body) return;
    positions.forEach((item) => document.body.classList.remove(`dock-${item}`));
    modes.forEach((item) => document.body.classList.remove(`dock-mode-${item}`));
    document.body.classList.add('has-global-dock', `dock-${position}`, `dock-mode-${mode}`);
  }

  function applySettings(root, settings) {
    const position = effectivePosition(settings.dockPosition);
    const compactIconSize = clamp(Math.round(settings.iconSize * 0.72), 54, 78, 66);

    positions.forEach((item) => root.classList.remove(`is-${item}`));
    modes.forEach((item) => root.classList.remove(`is-mode-${item}`));
    root.classList.remove('is-dark', 'is-style-soft', 'is-style-solid', 'is-style-outline', 'is-glass', 'is-labels-hidden');

    root.classList.add(`is-${position}`);
    root.classList.add(`is-mode-${settings.dockMode}`);
    root.classList.add(`is-style-${settings.iconStyle}`);
    root.classList.toggle('is-dark', settings.layoutMode === 'dark');
    root.classList.toggle('is-glass', Boolean(settings.useGlassEffect));
    root.classList.toggle('is-labels-hidden', !settings.showLabels);
    root.style.setProperty('--global-dock-theme', settings.themeColor);
    root.style.setProperty('--global-dock-accent', settings.accentColor);
    root.style.setProperty('--global-dock-bg', settings.backgroundColor);
    root.style.setProperty('--global-dock-color', settings.dockColor);
    root.style.setProperty('--global-dock-icon-size', `${compactIconSize}px`);
    root.dataset.position = position;
    syncBodyDockState(position, settings.dockMode);
  }

  function renderDock(dock, modules, icons, labels, settings) {
    dock.innerHTML = '';
    const selected = new Set(Array.isArray(settings.dockModules) ? settings.dockModules : []);
    const visibleModules = modules.filter((module) => selected.has(module.moduleKey));
    let lastGroup = null;

    visibleModules.forEach((module, index) => {
      if (index > 0 && module.group !== lastGroup) {
        const separator = document.createElement('span');
        separator.className = 'global-dock__separator';
        separator.setAttribute('aria-hidden', 'true');
        dock.appendChild(separator);
      }

      const wrapper = document.createElement('div');
      wrapper.className = 'global-dock__slot';
      wrapper.innerHTML = `
        <a class="global-dock-app${module.isActive ? ' is-active' : ''}" href="${escapeHtml(module.href)}" title="${escapeHtml(module.name)}"${module.isActive ? ' aria-current="page"' : ''}>
          <span class="global-dock-app__icon" style="--item-color:${escapeHtml(module.color || settings.accentColor)}">${iconMarkup(icons, module.iconName)}</span>
          <span class="global-dock-app__name">${escapeHtml(module.name)}</span>
        </a>
      `;
      dock.appendChild(wrapper);
      lastGroup = module.group;
    });

    if (!visibleModules.length) {
      const empty = document.createElement('div');
      empty.className = 'global-dock-empty';
      empty.textContent = labels.noModules || 'No hay modulos disponibles para este usuario.';
      dock.appendChild(empty);
    }
  }

  function createDock(payload) {
    const state = payload.state || {};
    const labels = payload.labels || {};
    const icons = payload.icons || {};
    const bootstrapSettings = normalizeSettings(state.settings, [], defaultSettings);
    const modules = normalizeModules(state.modules, bootstrapSettings, payload.currentPath);
    const settings = normalizeSettings(state.settings, modules, bootstrapSettings);
    if (!settings.dockEnabled) return;
    const mount = document.querySelector('[data-global-dock-mount]') || document.body;
    if (document.querySelector('.global-dock-shell[data-global-dock-root]')) return;

    const root = document.createElement('div');
    root.className = 'global-dock-shell';
    root.dataset.globalDockRoot = 'true';

    const hotspot = document.createElement('button');
    hotspot.type = 'button';
    hotspot.className = 'global-dock-hotspot';
    hotspot.setAttribute('aria-label', labels.showDock || 'Mostrar dock');
    hotspot.setAttribute('aria-expanded', 'false');

    const dock = document.createElement('aside');
    dock.className = 'global-dock';
    dock.setAttribute('aria-label', labels.modulesTitle || 'Modulos permitidos');
    dock.setAttribute('aria-hidden', 'true');

    root.appendChild(hotspot);
    root.appendChild(dock);
    applySettings(root, settings);
    renderDock(dock, modules, icons, labels, settings);

    let hideTimer = null;
    let suppressHotspotClick = false;
    const autoHide = settings.dockMode === 'auto-hide';
    const expandable = settings.dockMode === 'expandable';
    const fixed = settings.dockMode === 'fixed';

    const setOpen = (open) => {
      clearTimeout(hideTimer);
      if (fixed) {
        root.classList.add('is-revealed', 'is-expanded');
        hotspot.setAttribute('aria-expanded', 'true');
        setLinksEnabled(dock, true);
        return;
      }
      if (autoHide) {
        root.classList.toggle('is-revealed', Boolean(open));
        root.classList.toggle('is-expanded', Boolean(open));
        hotspot.setAttribute('aria-expanded', open ? 'true' : 'false');
        setLinksEnabled(dock, Boolean(open));
        return;
      }
      root.classList.add('is-revealed');
      root.classList.toggle('is-expanded', Boolean(open));
      hotspot.setAttribute('aria-expanded', open ? 'true' : 'false');
      setLinksEnabled(dock, true);
    };

    const scheduleClose = () => {
      if (fixed) return;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (root.matches(':hover') || root.contains(document.activeElement)) return;
        setOpen(false);
      }, 220);
    };

    root.addEventListener('mouseenter', () => setOpen(true));
    root.addEventListener('mouseleave', scheduleClose);
    root.addEventListener('focusin', () => setOpen(true));
    root.addEventListener('focusout', scheduleClose);

    hotspot.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') return;
      event.preventDefault();
      const nextOpen = !root.classList.contains('is-expanded') || (autoHide && !root.classList.contains('is-revealed'));
      setOpen(nextOpen);
      suppressHotspotClick = true;
    });

    hotspot.addEventListener('click', () => {
      if (suppressHotspotClick) {
        suppressHotspotClick = false;
        return;
      }
      const nextOpen = !root.classList.contains('is-expanded') || (autoHide && !root.classList.contains('is-revealed'));
      setOpen(nextOpen);
      if (autoHide && nextOpen) {
        const firstLink = dock.querySelector('a');
        if (firstLink) firstLink.focus();
      }
    });

    root.addEventListener('click', (event) => {
      if (!expandable || root.classList.contains('is-expanded')) return;
      if (hotspot.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(true);
    }, true);

    document.addEventListener('pointerdown', (event) => {
      if (fixed || root.contains(event.target)) return;
      setOpen(false);
    }, { passive: true });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      hotspot.blur();
    });

    window.addEventListener('resize', () => applySettings(root, settings), { passive: true });

    mount.appendChild(root);
    setOpen(fixed || expandable);
    if (expandable) setOpen(false);
  }

  function payloadFromBootstrap() {
    const node = document.getElementById('global-dock-bootstrap');
    if (!node) return null;
    try {
      return JSON.parse(node.textContent || '{}');
    } catch (err) {
      return null;
    }
  }

  async function init() {
    if (!document.body) return;
    const bootPayload = payloadFromBootstrap();
    if (bootPayload && bootPayload.ok) {
      createDock(bootPayload);
      return;
    }
    try {
      const response = await fetch('/workspace/global-dock', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) return;
      const payload = await response.json();
      if (!payload || !payload.ok) return;
      createDock(payload);
    } catch (err) {
      return;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
