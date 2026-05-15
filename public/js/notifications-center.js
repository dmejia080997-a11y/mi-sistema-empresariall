(function () {
  const centers = Array.from(document.querySelectorAll('[data-notification-center]'));
  if (!centers.length) return;

  const isEnglish = (document.documentElement.lang || '').toLowerCase().startsWith('en');
  const labels = {
    loading: isEnglish ? 'Loading notifications...' : 'Cargando notificaciones...',
    empty: isEnglish ? 'There are no recent notifications.' : 'No hay notificaciones recientes.',
    error: isEnglish ? 'Notifications could not be updated.' : 'No se pudieron actualizar las notificaciones.',
    noMessage: isEnglish ? 'No additional detail.' : 'Sin detalle adicional.'
  };

  const formatDateTime = (value) => {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleString(isEnglish ? 'en-US' : 'es-GT', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const setBadge = (badge, unreadCount) => {
    const safeCount = Number(unreadCount) || 0;
    badge.textContent = safeCount > 99 ? '99+' : String(safeCount);
    badge.hidden = safeCount <= 0;
  };

  const renderItems = (list, items, allUrl) => {
    list.innerHTML = '';
    if (!Array.isArray(items) || !items.length) {
      list.innerHTML = `<div class="notification-center__empty">${labels.empty}</div>`;
      return;
    }

    items.forEach((item) => {
      const anchor = document.createElement('a');
      anchor.className = `notification-center__item ${item && item.is_read ? 'is-read' : 'is-unread'}`;
      anchor.href = (item && item.link_url) || allUrl || '/notifications';
      anchor.innerHTML = `
        <div class="notification-center__item-top">
          <span class="notification-center__item-title">${sanitizeText(item && item.title)}</span>
          <span class="notification-center__item-time">${sanitizeText(formatDateTime(item && item.created_at))}</span>
        </div>
        <div class="notification-center__item-message">${sanitizeText((item && item.message) || labels.noMessage)}</div>
      `;
      list.appendChild(anchor);
    });
  };

  const sanitizeText = (value) => {
    const text = value === undefined || value === null ? '' : String(value);
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  centers.forEach((center) => {
    const trigger = center.querySelector('[data-notification-trigger]');
    const dropdown = center.querySelector('[data-notification-dropdown]');
    const list = center.querySelector('[data-notification-list]');
    const badge = center.querySelector('[data-notification-count]');
    const unreadUrl = center.getAttribute('data-unread-url');
    const latestUrl = center.getAttribute('data-latest-url');
    const allUrl = center.getAttribute('data-all-url') || '/notifications';

    if (!trigger || !dropdown || !list || !badge || !unreadUrl || !latestUrl) return;

    let isOpen = false;
    let isFetching = false;

    const setOpen = (nextOpen) => {
      isOpen = Boolean(nextOpen);
      dropdown.hidden = !isOpen;
      trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    };

    const refresh = async () => {
      if (isFetching) return;
      isFetching = true;

      try {
        const [countResponse, latestResponse] = await Promise.all([
          fetch(unreadUrl, { credentials: 'same-origin', headers: { Accept: 'application/json' } }),
          fetch(latestUrl, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        ]);

        if (!countResponse.ok || !latestResponse.ok) {
          throw new Error('notification_fetch_failed');
        }

        const countPayload = await countResponse.json();
        const latestPayload = await latestResponse.json();
        setBadge(badge, countPayload && countPayload.unreadCount);
        renderItems(list, latestPayload && latestPayload.items, allUrl);
      } catch (error) {
        list.innerHTML = `<div class="notification-center__empty">${labels.error}</div>`;
      } finally {
        isFetching = false;
      }
    };

    center.__refreshNotifications = refresh;
    center.__setNotificationCenterOpen = setOpen;
    center.__toggleNotificationCenter = () => setOpen(!isOpen);

    trigger.addEventListener('click', () => {
      center.__toggleNotificationCenter();
      if (!dropdown.hidden) {
        refresh();
      }
    });

    document.addEventListener('click', (event) => {
      if (!center.contains(event.target)) {
        setOpen(false);
      }
    });

    refresh();
    window.setInterval(refresh, 15000);
  });

  const refreshAllCenters = () => {
    centers.forEach((center) => {
      if (typeof center.__refreshNotifications === 'function') {
        center.__refreshNotifications();
      }
    });
  };

  const resolveCenter = (scope) => {
    if (!scope) return centers[0] || null;
    return centers.find((center) => center.getAttribute('data-notification-center-scope') === scope) || null;
  };

  const setCenterOpen = (scope, nextOpen) => {
    const center = resolveCenter(scope);
    if (!center || typeof center.__setNotificationCenterOpen !== 'function') return false;
    center.__setNotificationCenterOpen(nextOpen);
    if (nextOpen && typeof center.__refreshNotifications === 'function') {
      center.__refreshNotifications();
    }
    return true;
  };

  window.addEventListener('app:notifications-refresh', refreshAllCenters);
  window.refreshNotificationCenter = refreshAllCenters;
  window.NotificationCenter = {
    refresh(scope) {
      if (!scope) {
        refreshAllCenters();
        return true;
      }
      const center = resolveCenter(scope);
      if (!center || typeof center.__refreshNotifications !== 'function') return false;
      center.__refreshNotifications();
      return true;
    },
    open(scope = 'global') {
      return setCenterOpen(scope, true);
    },
    close(scope = 'global') {
      return setCenterOpen(scope, false);
    },
    toggle(scope = 'global') {
      const center = resolveCenter(scope);
      if (!center || typeof center.__toggleNotificationCenter !== 'function') return false;
      center.__toggleNotificationCenter();
      if (!center.querySelector('[data-notification-dropdown]').hidden && typeof center.__refreshNotifications === 'function') {
        center.__refreshNotifications();
      }
      return true;
    }
  };
})();
