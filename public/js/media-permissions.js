(function () {
  const script = document.querySelector('[data-app-media-permissions]');
  if (!script || !window.isSecureContext || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return;
  }

  const userId = String(script.dataset.userId || '').trim() || 'anonymous';
  const sessionKey = `app-media-permissions-requested:${userId}`;

  try {
    if (window.sessionStorage && window.sessionStorage.getItem(sessionKey) === '1') {
      return;
    }
  } catch (err) {
    // Ignore storage access issues and continue with a one-time request.
  }

  const markRequested = () => {
    try {
      if (window.sessionStorage) {
        window.sessionStorage.setItem(sessionKey, '1');
      }
    } catch (err) {
      // Ignore storage write issues.
    }
  };

  const requestMediaPermissions = async () => {
    markRequested();
    let stream = null;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true
      });
    } catch (err) {
      return;
    }

    stream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch (err) {
        // Ignore track shutdown errors.
      }
    });
  };

  if (document.readyState === 'complete') {
    window.setTimeout(requestMediaPermissions, 250);
    return;
  }

  window.addEventListener('load', () => {
    window.setTimeout(requestMediaPermissions, 250);
  }, { once: true });
})();
