(() => {
  let cityLabel = '';

  const ensureAiChatAssets = () => {
    if (document.documentElement.dataset.aiChatLoaded) return;
    document.documentElement.dataset.aiChatLoaded = 'true';

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/css/ai-chat.css';
    document.head.appendChild(link);

    const script = document.createElement('script');
    script.src = '/js/ai-chat.js';
    script.defer = true;
    document.head.appendChild(script);
  };

  const ensureFooter = () => {
    let footer = document.querySelector('.status-footer');
    if (footer) return footer;
    footer = document.createElement('div');
    footer.className = 'status-footer';

    const line = document.createElement('div');
    line.className = 'status-line';
    line.textContent = '--:-- Horas --/--/----';

    footer.appendChild(line);
    document.body.appendChild(footer);
    return footer;
  };

  const formatNow = () => {
    const lang = document.documentElement.lang || 'es';
    const now = new Date();
    const timeFmt = new Intl.DateTimeFormat(lang, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    const dateFmt = new Intl.DateTimeFormat(lang, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return {
      time: timeFmt.format(now),
      date: dateFmt.format(now)
    };
  };

  const setCityLabel = (label) => {
    cityLabel = label || '';
    updateClock();
  };

  const formatLocationLabel = (address) => {
    if (!address) return '';
    const country = (address.country || '').trim();
    const region = (address.state || address.region || address.state_district || address.county || '').trim();
    if (country && region) return `${region}, ${country}`;
    return country || region || '';
  };

  const resolveCityFromCoords = async (lat, lon) => {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`;
    const response = await fetch(url, { headers: { 'Accept-Language': document.documentElement.lang || 'es' } });
    if (!response.ok) throw new Error('reverse failed');
    const data = await response.json();
    const address = data.address || {};
    return formatLocationLabel(address);
  };

  const setCity = () => {
    const lineEl = document.querySelector('.status-footer .status-line');
    if (!lineEl) return;
    if (!navigator.geolocation) {
      setCityLabel('');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const label = await resolveCityFromCoords(pos.coords.latitude, pos.coords.longitude);
          if (label) {
            setCityLabel(label === 'Guatemala' ? 'Guatemala' : label);
            return;
          }
        } catch (err) {
          // fall through to timezone fallback
        }
        setCityLabel('');
      },
      () => {
        setCityLabel('');
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 }
    );
  };

  const updateClock = () => {
    const footer = ensureFooter();
    const lineEl = footer.querySelector('.status-line');
    const formatted = formatNow();
    if (lineEl) {
      const suffix = cityLabel ? ` ${cityLabel}` : '';
      lineEl.textContent = `${formatted.time} Horas ${formatted.date}${suffix}`;
    }
  };

  const start = () => {
    ensureAiChatAssets();
    ensureFooter();
    updateClock();
    setCity();
    setInterval(updateClock, 1000);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
