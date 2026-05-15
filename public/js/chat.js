(function () {
  const root = document.querySelector('[data-chat-thread-root]');
  const list = document.getElementById('chat-message-list');

  if (!list) return;

  const scrollToBottom = (force) => {
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (force || distanceFromBottom < 140) {
      list.scrollTop = list.scrollHeight;
    }
  };

  const getInitials = (value) => {
    const text = String(value || '').trim();
    if (!text) return 'CH';
    const parts = text.split(/\s+/).filter(Boolean).slice(0, 2);
    if (!parts.length) return text.slice(0, 2).toUpperCase();
    return parts.map((part) => part.charAt(0).toUpperCase()).join('').slice(0, 2);
  };

  const buildAvatarElement = (label, imageUrl, sizeClass) => {
    const avatar = document.createElement('span');
    avatar.className = `chat-avatar ${sizeClass || ''}`.trim();
    if (imageUrl) {
      const img = document.createElement('img');
      img.src = imageUrl;
      img.alt = label || 'Usuario';
      img.loading = 'lazy';
      avatar.appendChild(img);
      return avatar;
    }
    avatar.classList.add('is-fallback');
    avatar.textContent = getInitials(label);
    avatar.setAttribute('aria-hidden', 'true');
    return avatar;
  };

  scrollToBottom(true);

  if (!root) return;

  const threadId = Number(root.dataset.threadId || 0);
  const currentUserId = Number(root.dataset.currentUserId || 0);
  const otherUsername = root.dataset.otherUsername || 'El usuario';
  const csrfToken = root.dataset.csrf || '';
  const form = document.querySelector('[data-chat-compose-form]');
  const textarea = form ? form.querySelector('textarea[name="body"]') : null;
  const submitButton = form ? form.querySelector('button[type="submit"]') : null;
  const genericFileInput = form ? form.querySelector('[data-chat-file-input]') : null;
  const cameraPhotoInput = form ? form.querySelector('[data-chat-camera-photo-input]') : null;
  const cameraVideoInput = form ? form.querySelector('[data-chat-camera-video-input]') : null;
  const attachmentStatus = form ? form.querySelector('[data-chat-attachment-status]') : null;
  const voiceStatus = form ? form.querySelector('[data-chat-voice-status]') : null;
  const emojiToggle = form ? form.querySelector('[data-chat-emoji-toggle]') : null;
  const emojiPanel = form ? form.querySelector('[data-chat-emoji-panel]') : null;
  const cameraToggle = form ? form.querySelector('[data-chat-camera-toggle]') : null;
  const cameraPanel = form ? form.querySelector('[data-chat-camera-panel]') : null;
  const fileTrigger = form ? form.querySelector('[data-chat-file-trigger]') : null;
  const iconButtons = form ? Array.from(form.querySelectorAll('[data-chat-icon]')) : [];
  const cameraModeButtons = form ? Array.from(form.querySelectorAll('[data-chat-camera-mode]')) : [];
  const cameraLivePreview = form ? form.querySelector('[data-chat-camera-live]') : null;
  const cameraStatus = form ? form.querySelector('[data-chat-camera-status]') : null;
  const cameraCaptureButton = form ? form.querySelector('[data-chat-camera-capture]') : null;
  const voiceToggle = form ? form.querySelector('[data-chat-voice-toggle]') : null;
  const attachmentDraft = form ? form.querySelector('[data-chat-attachment-draft]') : null;
  const attachmentName = form ? form.querySelector('[data-chat-attachment-name]') : null;
  const attachmentMeta = form ? form.querySelector('[data-chat-attachment-meta]') : null;
  const attachmentClear = form ? form.querySelector('[data-chat-attachment-clear]') : null;
  const voicePreview = form ? form.querySelector('[data-chat-voice-preview]') : null;
  const imagePreview = form ? form.querySelector('[data-chat-image-preview]') : null;
  const videoPreview = form ? form.querySelector('[data-chat-video-preview]') : null;
  const threadBaseUrl = form && form.action ? form.action.replace(/\/message(?:\?.*)?$/i, '') : window.location.pathname;
  const typingUrl = `${threadBaseUrl}/typing`;
  const streamUrl = `${threadBaseUrl}/stream`;
  const typingIndicator = document.querySelector('[data-chat-typing-indicator]');
  const typingText = typingIndicator ? typingIndicator.querySelector('.chat-typing-indicator__text') : null;
  const countEl = document.querySelector('[data-chat-message-count]');
  const threadCard = document.querySelector(`.chat-thread-card[data-thread-id="${threadId}"]`);
  const messageIds = new Set(
    Array.from(list.querySelectorAll('[data-message-id]'))
      .map((node) => Number(node.dataset.messageId || 0))
      .filter((value) => value > 0)
  );

  let isSending = false;
  let localTypingActive = false;
  let lastTypingSentAt = 0;
  let localTypingTimer = null;
  let remoteTypingTimer = null;
  let voiceRecorder = null;
  let voiceStream = null;
  let recordingChunks = [];
  let recordingStartedAt = 0;
  let recordingTicker = null;
  let isRecording = false;
  let isStartingRecording = false;
  let voiceHoldRequested = false;
  let voiceAutoSendRequested = false;
  let cameraMode = 'photo';
  let cameraStream = null;
  let cameraRecorder = null;
  let cameraChunks = [];
  let isCameraStarting = false;
  let isCameraRecording = false;
  let selectedAttachmentFile = null;
  let currentAudioPreviewUrl = '';
  let currentImagePreviewUrl = '';
  let currentVideoPreviewUrl = '';

  const TYPING_IDLE_MS = 1400;
  const TYPING_REFRESH_MS = 900;
  const REMOTE_TYPING_HIDE_MS = 2200;

  const requestNotificationRefresh = () => {
    window.dispatchEvent(new CustomEvent('app:notifications-refresh', {
      detail: { source: 'chat', threadId }
    }));
  };

  const toLocaleDate = (value) => {
    if (!value) return 'Sin fecha';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleString('es-GT', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const setMessageCount = () => {
    if (!countEl) return;
    countEl.textContent = String(messageIds.size);
  };

  const formatBytes = (value) => `${Number(value || 0).toLocaleString('es-GT')} bytes`;

  const getAttachmentExtension = (fileName) => {
    const text = String(fileName || '').trim().toLowerCase();
    const match = text.match(/\.[^.]+$/);
    return match ? match[0] : '';
  };

  const isAudioAttachment = (attachment) => {
    if (!attachment) return false;
    if (attachment.isAudio) return true;
    const mimeType = String(attachment.mimeType || attachment.type || '').toLowerCase();
    if (mimeType.startsWith('audio/')) return true;
    return ['.webm', '.ogg', '.mp3', '.mp4', '.m4a', '.aac', '.wav'].includes(
      getAttachmentExtension(attachment.originalName || attachment.name || '')
    );
  };

  const isImageAttachment = (attachment) => {
    if (!attachment) return false;
    if (attachment.isImage) return true;
    const mimeType = String(attachment.mimeType || attachment.type || '').toLowerCase();
    if (mimeType.startsWith('image/')) return true;
    return ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg', '.heic', '.heif'].includes(
      getAttachmentExtension(attachment.originalName || attachment.name || '')
    );
  };

  const isVideoAttachment = (attachment) => {
    if (!attachment) return false;
    if (attachment.isVideo) return true;
    const mimeType = String(attachment.mimeType || attachment.type || '').toLowerCase();
    if (mimeType.startsWith('video/')) return true;
    return ['.mp4', '.webm', '.mov', '.m4v', '.ogv'].includes(
      getAttachmentExtension(attachment.originalName || attachment.name || '')
    );
  };

  const getAttachmentSummary = (attachment) => {
    if (!attachment) return 'Sin mensajes enviados todavia.';
    if (isAudioAttachment(attachment)) return 'Audio de voz';
    if (isImageAttachment(attachment)) return 'Foto';
    if (isVideoAttachment(attachment)) return 'Video';
    return `Adjunto: ${attachment.originalName || attachment.name || 'archivo'}`;
  };

  const setVoiceStatusText = (message) => {
    if (voiceStatus) {
      voiceStatus.textContent = message;
    }
  };

  const clearPreviewUrls = () => {
    if (currentAudioPreviewUrl) {
      window.URL.revokeObjectURL(currentAudioPreviewUrl);
      currentAudioPreviewUrl = '';
    }
    if (currentImagePreviewUrl) {
      window.URL.revokeObjectURL(currentImagePreviewUrl);
      currentImagePreviewUrl = '';
    }
    if (currentVideoPreviewUrl) {
      window.URL.revokeObjectURL(currentVideoPreviewUrl);
      currentVideoPreviewUrl = '';
    }
  };

  const resetMediaPreview = (element) => {
    if (!element) return;
    if (typeof element.pause === 'function') {
      element.pause();
    }
    element.removeAttribute('src');
    element.hidden = true;
    if (typeof element.load === 'function') {
      element.load();
    }
  };

  const clearDraftPreview = () => {
    clearPreviewUrls();
    if (imagePreview) {
      imagePreview.removeAttribute('src');
      imagePreview.hidden = true;
    }
    if (videoPreview) {
      resetMediaPreview(videoPreview);
    }
    if (voicePreview) {
      resetMediaPreview(voicePreview);
    }
  };

  const setFilePreview = (element, file, type) => {
    if (!element || !file) return;
    const previewUrl = window.URL.createObjectURL(file);
    element.src = previewUrl;
    element.hidden = false;
    if (type === 'audio') currentAudioPreviewUrl = previewUrl;
    if (type === 'image') currentImagePreviewUrl = previewUrl;
    if (type === 'video') currentVideoPreviewUrl = previewUrl;
  };

  const clearAttachmentInputValues = () => {
    if (genericFileInput) genericFileInput.value = '';
    if (cameraPhotoInput) cameraPhotoInput.value = '';
    if (cameraVideoInput) cameraVideoInput.value = '';
  };

  const clearSelectedAttachment = () => {
    selectedAttachmentFile = null;
    clearAttachmentInputValues();
    clearDraftPreview();
  };

  const syncAttachmentUi = () => {
    const file = selectedAttachmentFile;

    if (attachmentStatus) {
      attachmentStatus.textContent = file
        ? `${file.name || 'archivo'} - ${formatBytes(file.size)}`
        : 'No hay archivo seleccionado. Puedes adjuntar cualquier tipo de archivo. Maximo 10 MB.';
    }

    if (attachmentDraft) {
      attachmentDraft.hidden = !file;
    }
    if (attachmentClear) {
      attachmentClear.hidden = !file;
    }

    if (!file) {
      if (attachmentName) attachmentName.textContent = 'archivo';
      if (attachmentMeta) attachmentMeta.textContent = 'Sin archivo seleccionado.';
      clearDraftPreview();
      if (!isRecording && !isStartingRecording) {
        setVoiceStatusText('Manten presionado el microfono para grabar audio.');
      }
      return;
    }

    if (attachmentName) attachmentName.textContent = file.name || 'archivo';
    if (attachmentMeta) {
      attachmentMeta.textContent = `${file.type || 'archivo'} - ${formatBytes(file.size)}`;
    }

    clearDraftPreview();
    if (isImageAttachment(file)) {
      setFilePreview(imagePreview, file, 'image');
    } else if (isVideoAttachment(file)) {
      setFilePreview(videoPreview, file, 'video');
    } else if (isAudioAttachment(file)) {
      setFilePreview(voicePreview, file, 'audio');
    }

    if (!isRecording && !isStartingRecording) {
      setVoiceStatusText(isAudioAttachment(file)
        ? 'Audio listo para enviar.'
        : 'Adjunto listo para enviar.');
    }
  };

  const setSelectedAttachment = (file) => {
    selectedAttachmentFile = file || null;
    clearAttachmentInputValues();
    syncAttachmentUi();
  };

  const setCameraStatusText = (message) => {
    if (cameraStatus) {
      cameraStatus.textContent = message;
    }
  };

  const stopStream = (stream) => {
    if (!stream) return;
    stream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch (err) {
        // ignore track stop errors
      }
    });
  };

  const stopVoiceStream = () => {
    if (!voiceStream) return;
    stopStream(voiceStream);
    voiceStream = null;
  };

  const stopCameraStream = () => {
    if (!cameraStream) return;
    stopStream(cameraStream);
    cameraStream = null;
    if (cameraLivePreview) {
      cameraLivePreview.pause();
      cameraLivePreview.srcObject = null;
    }
  };

  const resetRecordingTicker = () => {
    if (recordingTicker) {
      window.clearInterval(recordingTicker);
      recordingTicker = null;
    }
  };

  const updateRecordingStatus = () => {
    if (!isRecording) return;
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - recordingStartedAt) / 1000));
    const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
    const seconds = String(elapsedSeconds % 60).padStart(2, '0');
    setVoiceStatusText(`Grabando audio... ${minutes}:${seconds}`);
  };

  const getPreferredAudioMimeType = () => {
    if (!window.MediaRecorder || typeof window.MediaRecorder.isTypeSupported !== 'function') {
      return '';
    }
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
      'audio/webm',
      'audio/ogg',
      'audio/mp4'
    ];
    return candidates.find((candidate) => window.MediaRecorder.isTypeSupported(candidate)) || '';
  };

  const getAudioExtensionForMimeType = (mimeType) => {
    const normalized = String(mimeType || '').toLowerCase();
    if (normalized.includes('ogg')) return '.ogg';
    if (normalized.includes('mp4')) return '.mp4';
    if (normalized.includes('mpeg') || normalized.includes('mp3')) return '.mp3';
    if (normalized.includes('wav')) return '.wav';
    if (normalized.includes('aac')) return '.aac';
    if (normalized.includes('m4a')) return '.m4a';
    return '.webm';
  };

  const getPreferredVideoMimeType = () => {
    if (!window.MediaRecorder || typeof window.MediaRecorder.isTypeSupported !== 'function') {
      return '';
    }
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=h264,opus',
      'video/webm',
      'video/mp4'
    ];
    return candidates.find((candidate) => window.MediaRecorder.isTypeSupported(candidate)) || '';
  };

  const getVideoExtensionForMimeType = (mimeType) => {
    const normalized = String(mimeType || '').toLowerCase();
    if (normalized.includes('mp4')) return '.mp4';
    if (normalized.includes('ogg')) return '.ogv';
    if (normalized.includes('quicktime')) return '.mov';
    return '.webm';
  };

  const setVoiceButtonRecordingState = (active) => {
    if (!voiceToggle) return;
    voiceToggle.classList.toggle('is-recording', active);
    voiceToggle.setAttribute('aria-pressed', active ? 'true' : 'false');
  };

  const supportsVoiceNotes = Boolean(
    voiceToggle
    && voicePreview
    && window.MediaRecorder
    && navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function'
  );

  const supportsInlineCamera = Boolean(
    cameraToggle
    && cameraPanel
    && cameraLivePreview
    && cameraCaptureButton
    && window.isSecureContext
    && navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function'
  );

  const supportsCameraVideoRecording = Boolean(window.MediaRecorder);

  const updateCameraModeUi = () => {
    cameraModeButtons.forEach((button) => {
      const active = button.dataset.chatCameraMode === cameraMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.disabled = isCameraRecording;
    });

    if (!cameraCaptureButton) return;

    if (cameraMode === 'photo') {
      cameraCaptureButton.textContent = 'Tomar foto';
      cameraCaptureButton.disabled = isCameraStarting;
      return;
    }

    cameraCaptureButton.textContent = isCameraRecording ? 'Detener y adjuntar video' : 'Iniciar video';
    cameraCaptureButton.disabled = isCameraStarting || (!supportsCameraVideoRecording && !cameraVideoInput);
  };

  const syncCameraStatus = () => {
    if (isCameraRecording) {
      setCameraStatusText('Grabando video. Pulsa de nuevo para detener y adjuntarlo.');
      return;
    }
    if (isCameraStarting) {
      setCameraStatusText('Activando camara...');
      return;
    }
    if (!supportsInlineCamera) {
      setCameraStatusText('Este navegador no permite abrir la camara integrada del chat.');
      return;
    }
    setCameraStatusText(cameraMode === 'photo'
      ? 'La camara se activa en vivo. Pulsa para tomar la foto.'
      : 'La camara se activa en vivo. Puedes grabar un video corto para adjuntarlo.');
  };

  const clearEmptyState = () => {
    const emptyState = list.querySelector('[data-chat-empty-state]');
    if (emptyState) emptyState.remove();
  };

  const buildReadStatusLabel = (message) => {
    return message.isRead ? `Leido ${toLocaleDate(message.readAt)}` : 'Pendiente de lectura';
  };

  const buildAttachmentElement = (attachment) => {
    const attachmentCard = document.createElement('div');
    attachmentCard.className = 'chat-attachment-card';

    const attachmentInfo = document.createElement('div');
    attachmentInfo.className = 'chat-attachment-card__content';

    const attachmentNameEl = document.createElement('strong');
    attachmentNameEl.textContent = attachment.originalName || 'archivo';

    const attachmentMetaEl = document.createElement('small');
    attachmentMetaEl.className = 'muted';
    attachmentMetaEl.textContent = `${attachment.mimeType || 'archivo'} - ${formatBytes(attachment.sizeBytes)}`;

    attachmentInfo.appendChild(attachmentNameEl);
    attachmentInfo.appendChild(attachmentMetaEl);

    if (isImageAttachment(attachment)) {
      const image = document.createElement('img');
      image.className = 'chat-attachment-media';
      image.loading = 'lazy';
      image.alt = attachment.originalName || 'Imagen adjunta';
      image.src = attachment.downloadUrl;
      attachmentInfo.appendChild(image);
    } else if (isVideoAttachment(attachment)) {
      const video = document.createElement('video');
      video.className = 'chat-attachment-media';
      video.controls = true;
      video.preload = 'metadata';
      video.src = attachment.downloadUrl;
      attachmentInfo.appendChild(video);
    } else if (isAudioAttachment(attachment)) {
      const audio = document.createElement('audio');
      audio.className = 'chat-audio-player';
      audio.controls = true;
      audio.preload = 'none';
      audio.src = attachment.downloadUrl;
      attachmentInfo.appendChild(audio);
    }

    const downloadLink = document.createElement('a');
    downloadLink.className = 'btn app-btn app-btn-small';
    downloadLink.href = attachment.downloadUrl;
    downloadLink.textContent = 'Descargar';

    attachmentCard.appendChild(attachmentInfo);
    attachmentCard.appendChild(downloadLink);
    return attachmentCard;
  };

  const buildMessageElement = (message) => {
    const isOwn = Number(message.senderId || 0) === currentUserId;
    const article = document.createElement('article');
    article.className = `chat-bubble ${isOwn ? 'is-own' : 'is-other'}`;
    article.dataset.messageId = String(message.id);

    const meta = document.createElement('div');
    meta.className = 'chat-bubble__meta';

    const person = document.createElement('div');
    person.className = 'chat-person chat-person-compact';
    person.appendChild(buildAvatarElement(message.senderDisplayName || message.senderUsername || otherUsername, message.senderAvatarUrl, 'chat-avatar-small'));

    const author = document.createElement('strong');
    author.textContent = message.senderDisplayName || message.senderUsername || (isOwn ? 'Tu' : otherUsername);
    person.appendChild(author);

    const timestamp = document.createElement('span');
    timestamp.textContent = toLocaleDate(message.createdAt);

    meta.appendChild(person);
    meta.appendChild(timestamp);
    article.appendChild(meta);

    if (message.body) {
      const body = document.createElement('div');
      body.className = 'chat-bubble__body';
      body.textContent = message.body;
      article.appendChild(body);
    }

    if (message.attachment) {
      article.appendChild(buildAttachmentElement(message.attachment));
    }

    if (isOwn) {
      const status = document.createElement('div');
      status.className = 'chat-bubble__status';

      const chip = document.createElement('span');
      chip.className = `app-chip ${message.isRead ? 'app-chip-success' : 'app-chip-warning'}`;
      chip.textContent = buildReadStatusLabel(message);

      status.appendChild(chip);
      article.appendChild(status);
    }

    return article;
  };

  const updateThreadPreview = (message) => {
    if (!threadCard) return;
    const preview = threadCard.querySelector('p');
    const time = threadCard.querySelector('small');
    const unreadBadge = threadCard.querySelector('.app-badge');

    if (preview) {
      preview.textContent = message.body || (message.attachment
        ? getAttachmentSummary(message.attachment)
        : 'Sin mensajes enviados todavia.');
    }
    if (time) {
      time.textContent = toLocaleDate(message.createdAt);
    }
    if (unreadBadge && Number(message.senderId || 0) !== currentUserId) {
      unreadBadge.remove();
    }
  };

  const upsertMessage = (message, options = {}) => {
    if (!message || !message.id) return;
    const existing = list.querySelector(`[data-message-id="${message.id}"]`);
    const element = buildMessageElement(message);

    if (existing) {
      existing.replaceWith(element);
    } else {
      clearEmptyState();
      messageIds.add(Number(message.id));
      setMessageCount();
      list.appendChild(element);
      element.classList.add('is-live');
      window.setTimeout(() => element.classList.remove('is-live'), 240);
    }

    updateThreadPreview(message);
    scrollToBottom(Boolean(options.forceScroll));
  };

  const hideRemoteTyping = () => {
    if (!typingIndicator) return;
    typingIndicator.hidden = true;
    if (remoteTypingTimer) {
      window.clearTimeout(remoteTypingTimer);
      remoteTypingTimer = null;
    }
  };

  const showRemoteTyping = (username) => {
    if (!typingIndicator) return;
    if (typingText) {
      typingText.textContent = `${username || otherUsername} esta escribiendo...`;
    }
    typingIndicator.hidden = false;
    if (remoteTypingTimer) {
      window.clearTimeout(remoteTypingTimer);
    }
    remoteTypingTimer = window.setTimeout(hideRemoteTyping, REMOTE_TYPING_HIDE_MS);
  };

  const postTypingState = (active) => {
    if (!csrfToken || !threadId) return;
    fetch(typingUrl, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: !active,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify({ active })
    }).catch(() => {});
  };

  const shouldTriggerTypingFromKeydown = (event) => {
    if (!event || event.isComposing) return false;
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') {
      return false;
    }
    if (event.key === 'Tab' || event.key === 'Escape') return false;
    if (event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Enter') return true;
    return typeof event.key === 'string' && event.key.length === 1;
  };

  const sendTypingState = (active, force) => {
    const now = Date.now();
    if (!force && active && localTypingActive && now - lastTypingSentAt < TYPING_REFRESH_MS) {
      return;
    }
    if (!force && active === localTypingActive && !active) {
      return;
    }
    localTypingActive = active;
    lastTypingSentAt = now;
    postTypingState(active);
  };

  const scheduleTypingStop = () => {
    if (localTypingTimer) {
      window.clearTimeout(localTypingTimer);
    }
    localTypingTimer = window.setTimeout(() => {
      sendTypingState(false, true);
    }, TYPING_IDLE_MS);
  };

  const togglePanel = (panel, toggle, show) => {
    if (!panel || !toggle) return;
    panel.hidden = !show;
    toggle.setAttribute('aria-expanded', show ? 'true' : 'false');
  };

  const getCameraConstraints = () => {
    if (cameraMode === 'video') {
      return [
        { video: { facingMode: { ideal: 'environment' } }, audio: true },
        { video: { facingMode: { ideal: 'environment' } }, audio: false },
        { video: true, audio: false }
      ];
    }
    return [
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
      { video: true, audio: false }
    ];
  };

  const ensureCameraStream = async () => {
    if (!supportsInlineCamera) return false;
    if (cameraStream) {
      if (cameraLivePreview && cameraLivePreview.srcObject !== cameraStream) {
        cameraLivePreview.srcObject = cameraStream;
      }
      return true;
    }

    isCameraStarting = true;
    updateCameraModeUi();
    syncCameraStatus();

    let stream = null;
    let lastError = null;
    for (const constraints of getCameraConstraints()) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (err) {
        lastError = err;
      }
    }

    isCameraStarting = false;

    if (!stream) {
      updateCameraModeUi();
      setCameraStatusText(lastError && lastError.name === 'NotAllowedError'
        ? 'No se pudo acceder a la camara. Revisa los permisos del navegador.'
        : 'No fue posible abrir la camara desde el chat.');
      return false;
    }

    cameraStream = stream;
    if (cameraLivePreview) {
      cameraLivePreview.srcObject = cameraStream;
      try {
        await cameraLivePreview.play();
      } catch (err) {
        // ignore autoplay errors; browser may require the user gesture already used to open the panel
      }
    }

    updateCameraModeUi();
    syncCameraStatus();
    return true;
  };

  const closeCameraPanel = async (options = {}) => {
    const discardRecording = options.discardRecording !== false;

    if (isCameraRecording && discardRecording && cameraRecorder && cameraRecorder.state !== 'inactive') {
      await new Promise((resolve) => {
        cameraRecorder.addEventListener('stop', resolve, { once: true });
        cameraRecorder.stop();
      }).catch(() => {});
    }

    cameraRecorder = null;
    cameraChunks = [];
    isCameraRecording = false;
    isCameraStarting = false;
    stopCameraStream();
    updateCameraModeUi();
    syncCameraStatus();
    togglePanel(cameraPanel, cameraToggle, false);
  };

  const openCameraPanel = async () => {
    togglePanel(cameraPanel, cameraToggle, true);
    updateCameraModeUi();
    syncCameraStatus();
    const opened = await ensureCameraStream();
    if (!opened && !supportsInlineCamera) {
      setCameraStatusText('Este navegador no permite abrir la camara integrada del chat.');
    }
  };

  const closePopovers = () => {
    togglePanel(emojiPanel, emojiToggle, false);
    closeCameraPanel().catch(() => {});
  };

  const stopRecording = async (options = {}) => {
    const discard = Boolean(options.discard);
    const autoSend = Boolean(options.autoSend);

    if (!voiceRecorder || voiceRecorder.state === 'inactive') {
      stopVoiceStream();
      isRecording = false;
      resetRecordingTicker();
      setVoiceButtonRecordingState(false);
      if (discard) {
        clearSelectedAttachment();
        syncAttachmentUi();
      }
      if (!discard) {
        syncAttachmentUi();
      }
      return;
    }

    await new Promise((resolve) => {
      const recordedMimeType = voiceRecorder.mimeType || 'audio/webm';
      voiceRecorder.addEventListener('stop', () => {
        stopVoiceStream();
        isRecording = false;
        resetRecordingTicker();
        setVoiceButtonRecordingState(false);

        let shouldAutoSend = false;
        if (!discard && recordingChunks.length) {
          const blob = new Blob(recordingChunks, { type: recordedMimeType });
          const fileName = `audio-voz-${Date.now()}${getAudioExtensionForMimeType(recordedMimeType)}`;
          selectedAttachmentFile = new File([blob], fileName, {
            type: recordedMimeType,
            lastModified: Date.now()
          });
          shouldAutoSend = autoSend;
        } else if (discard) {
          clearSelectedAttachment();
        }

        recordingChunks = [];
        syncAttachmentUi();
        if (shouldAutoSend && form && !isSending) {
          window.setTimeout(() => {
            if (!isSending) {
              form.requestSubmit();
            }
          }, 0);
        }
        resolve();
      }, { once: true });

      voiceRecorder.stop();
    });

    voiceRecorder = null;
  };

  const startRecording = async () => {
    if (!supportsVoiceNotes || isRecording || isStartingRecording) return;

    try {
      isStartingRecording = true;
      clearSelectedAttachment();
      syncAttachmentUi();

      voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getPreferredAudioMimeType();
      voiceRecorder = mimeType ? new MediaRecorder(voiceStream, { mimeType }) : new MediaRecorder(voiceStream);
      recordingChunks = [];
      voiceRecorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size > 0) {
          recordingChunks.push(event.data);
        }
      });
      voiceRecorder.start();
      isRecording = true;
      recordingStartedAt = Date.now();
      setVoiceButtonRecordingState(true);
      updateRecordingStatus();
      recordingTicker = window.setInterval(updateRecordingStatus, 1000);

      if (!voiceHoldRequested) {
        await stopRecording({
          discard: !voiceAutoSendRequested,
          autoSend: voiceAutoSendRequested
        });
      }
    } catch (err) {
      stopVoiceStream();
      setVoiceButtonRecordingState(false);
      setVoiceStatusText('No se pudo acceder al microfono. Revisa los permisos del navegador.');
    } finally {
      isStartingRecording = false;
    }
  };

  const captureCameraPhoto = async () => {
    if (!cameraLivePreview || !cameraStream) return;
    const width = cameraLivePreview.videoWidth || 1280;
    const height = cameraLivePreview.videoHeight || 960;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      setCameraStatusText('No fue posible tomar la foto desde el chat.');
      return;
    }
    context.drawImage(cameraLivePreview, 0, 0, width, height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) {
      setCameraStatusText('No fue posible generar la foto capturada.');
      return;
    }

    const fileName = `chat-foto-${Date.now()}.jpg`;
    setSelectedAttachment(new File([blob], fileName, {
      type: 'image/jpeg',
      lastModified: Date.now()
    }));
    setCameraStatusText('Foto adjuntada al chat.');
    await closeCameraPanel({ discardRecording: false });
  };

  const stopCameraRecording = async (options = {}) => {
    const attach = options.attach !== false;

    if (!cameraRecorder || cameraRecorder.state === 'inactive') {
      cameraRecorder = null;
      cameraChunks = [];
      isCameraRecording = false;
      updateCameraModeUi();
      syncCameraStatus();
      return;
    }

    await new Promise((resolve) => {
      const recordedMimeType = cameraRecorder.mimeType || 'video/webm';
      cameraRecorder.addEventListener('stop', async () => {
        isCameraRecording = false;

        if (attach && cameraChunks.length) {
          const blob = new Blob(cameraChunks, { type: recordedMimeType });
          const fileName = `chat-video-${Date.now()}${getVideoExtensionForMimeType(recordedMimeType)}`;
          setSelectedAttachment(new File([blob], fileName, {
            type: recordedMimeType,
            lastModified: Date.now()
          }));
          setCameraStatusText('Video adjuntado al chat.');
          cameraChunks = [];
          cameraRecorder = null;
          updateCameraModeUi();
          syncCameraStatus();
          await closeCameraPanel({ discardRecording: false });
          resolve();
          return;
        }

        cameraChunks = [];
        cameraRecorder = null;
        updateCameraModeUi();
        syncCameraStatus();
        resolve();
      }, { once: true });

      cameraRecorder.stop();
    });
  };

  const startCameraRecording = async () => {
    if (!supportsCameraVideoRecording) {
      if (cameraVideoInput) {
        cameraVideoInput.click();
        return;
      }
      setCameraStatusText('Este navegador no permite grabar video desde el chat.');
      return;
    }

    const opened = await ensureCameraStream();
    if (!opened || !cameraStream || isCameraRecording) return;

    const mimeType = getPreferredVideoMimeType();
    cameraRecorder = mimeType ? new MediaRecorder(cameraStream, { mimeType }) : new MediaRecorder(cameraStream);
    cameraChunks = [];
    cameraRecorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) {
        cameraChunks.push(event.data);
      }
    });
    cameraRecorder.start();
    isCameraRecording = true;
    updateCameraModeUi();
    syncCameraStatus();
  };

  if (textarea) {
    const insertAtCursor = (value) => {
      const icon = String(value || '');
      if (!icon) return;

      const start = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
      const end = Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : textarea.value.length;
      const prefix = textarea.value.slice(0, start);
      const suffix = textarea.value.slice(end);
      const needsLeadingSpace = prefix && !/\s$/.test(prefix);
      const needsTrailingSpace = suffix && !/^\s/.test(suffix);
      const insertion = `${needsLeadingSpace ? ' ' : ''}${icon}${needsTrailingSpace ? ' ' : ''}`;

      textarea.value = `${prefix}${insertion}${suffix}`;
      const caret = prefix.length + insertion.length;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    };

    iconButtons.forEach((button) => {
      button.addEventListener('click', () => {
        insertAtCursor(button.dataset.iconValue || button.textContent || '');
        closePopovers();
        sendTypingState(true, false);
        scheduleTypingStop();
      });
    });

    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closePopovers();
      }
      if (shouldTriggerTypingFromKeydown(event)) {
        sendTypingState(true, false);
        scheduleTypingStop();
      }
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
        return;
      }
      event.preventDefault();
      if (form && !isSending) {
        form.requestSubmit();
      }
    });

    textarea.addEventListener('input', () => {
      if (!textarea.value.trim()) {
        if (localTypingTimer) {
          window.clearTimeout(localTypingTimer);
        }
        sendTypingState(false, true);
        return;
      }
      sendTypingState(true, false);
      scheduleTypingStop();
    });

    textarea.addEventListener('blur', () => {
      if (localTypingTimer) {
        window.clearTimeout(localTypingTimer);
      }
      sendTypingState(false, true);
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    if (localTypingTimer) {
      window.clearTimeout(localTypingTimer);
    }
    sendTypingState(false, true);
  });

  if (emojiToggle) {
    emojiToggle.addEventListener('click', () => {
      const nextState = emojiPanel ? emojiPanel.hidden : false;
      togglePanel(emojiPanel, emojiToggle, nextState);
      closeCameraPanel().catch(() => {});
    });
  }

  if (cameraToggle) {
    cameraToggle.addEventListener('click', async () => {
      const nextState = cameraPanel ? cameraPanel.hidden : false;
      togglePanel(emojiPanel, emojiToggle, false);
      if (!nextState) {
        await closeCameraPanel();
        return;
      }
      await openCameraPanel();
    });
  }

  if (fileTrigger && genericFileInput) {
    fileTrigger.addEventListener('click', () => {
      closePopovers();
      genericFileInput.click();
    });
  }

  cameraModeButtons.forEach((button) => {
    button.addEventListener('click', async () => {
      const mode = button.dataset.chatCameraMode === 'video' ? 'video' : 'photo';
      if (mode === cameraMode || isCameraRecording) return;
      cameraMode = mode;
      stopCameraStream();
      updateCameraModeUi();
      syncCameraStatus();
      if (cameraPanel && !cameraPanel.hidden) {
        await ensureCameraStream();
      }
    });
  });

  if (cameraCaptureButton) {
    cameraCaptureButton.addEventListener('click', async () => {
      if (isCameraStarting) return;

      if (!supportsInlineCamera) {
        if (cameraMode === 'photo' && cameraPhotoInput) {
          cameraPhotoInput.click();
        } else if (cameraMode === 'video' && cameraVideoInput) {
          cameraVideoInput.click();
        }
        return;
      }

      if (cameraMode === 'photo') {
        const opened = await ensureCameraStream();
        if (opened) {
          await captureCameraPhoto();
        }
        return;
      }

      if (!isCameraRecording) {
        await startCameraRecording();
        return;
      }

      await stopCameraRecording({ attach: true });
    });
  }

  [genericFileInput, cameraPhotoInput, cameraVideoInput].forEach((input) => {
    if (!input) return;
    input.addEventListener('change', () => {
      const file = input.files && input.files.length ? input.files[0] : null;
      setSelectedAttachment(file);
    });
  });

  if (attachmentClear) {
    attachmentClear.addEventListener('click', () => {
      clearSelectedAttachment();
      syncAttachmentUi();
    });
  }

  if (supportsVoiceNotes) {
    const endVoiceCapture = async (options = {}) => {
      const discard = Boolean(options.discard);
      voiceHoldRequested = false;
      voiceAutoSendRequested = !discard;
      if (isRecording) {
        await stopRecording({
          discard,
          autoSend: !discard
        });
      }
    };

    voiceToggle.addEventListener('click', (event) => {
      event.preventDefault();
    });

    voiceToggle.addEventListener('pointerdown', async (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (isSending) return;
      event.preventDefault();
      closePopovers();
      voiceHoldRequested = true;
      voiceAutoSendRequested = false;
      await startRecording();
    });

    voiceToggle.addEventListener('pointercancel', () => {
      endVoiceCapture({ discard: true });
    });

    voiceToggle.addEventListener('keydown', async (event) => {
      if (event.repeat) return;
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      closePopovers();
      voiceHoldRequested = true;
      voiceAutoSendRequested = false;
      await startRecording();
    });

    voiceToggle.addEventListener('keyup', (event) => {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      endVoiceCapture();
    });

    window.addEventListener('pointerup', () => {
      endVoiceCapture();
    });
  } else if (voiceToggle) {
    voiceToggle.disabled = true;
    setVoiceStatusText('Este navegador no permite grabar audio desde el chat.');
  }

  document.addEventListener('click', (event) => {
    if (!form || form.contains(event.target)) return;
    closePopovers();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closePopovers();
    }
  });

  updateCameraModeUi();
  syncCameraStatus();
  syncAttachmentUi();

  if (threadId > 0) {
    requestNotificationRefresh();
  }

  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (isSending) return;
      if (isRecording || isStartingRecording) {
        window.alert('Termina la grabacion antes de enviar el mensaje.');
        return;
      }
      if (isCameraRecording || isCameraStarting) {
        window.alert('Termina la captura de camara antes de enviar el mensaje.');
        return;
      }

      const body = textarea ? textarea.value.trim() : '';
      const hasAttachment = Boolean(selectedAttachmentFile);
      if (!body && !hasAttachment) {
        if (textarea) textarea.focus();
        return;
      }

      isSending = true;
      form.classList.add('is-sending');
      if (submitButton) submitButton.disabled = true;

      try {
        const formData = new FormData(form);
        formData.delete('attachment');
        if (selectedAttachmentFile) {
          formData.set('attachment', selectedAttachmentFile, selectedAttachmentFile.name);
        }

        const response = await fetch(form.action, {
          method: 'POST',
          body: formData,
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
          }
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload || !payload.ok) {
          if (payload && payload.redirectUrl) {
            window.location.href = payload.redirectUrl;
            return;
          }
          throw new Error(payload && payload.error ? payload.error : 'No se pudo enviar el mensaje.');
        }

        if (payload.message) {
          upsertMessage(payload.message, { forceScroll: true });
        }
        form.reset();
        clearSelectedAttachment();
        syncAttachmentUi();
        closePopovers();
        hideRemoteTyping();
        if (localTypingTimer) {
          window.clearTimeout(localTypingTimer);
        }
        sendTypingState(false, true);
      } catch (err) {
        window.alert(err && err.message ? err.message : 'No se pudo enviar el mensaje.');
      } finally {
        isSending = false;
        form.classList.remove('is-sending');
        if (submitButton) submitButton.disabled = false;
        if (textarea) textarea.focus();
      }
    });
  }

  if (window.EventSource && threadId > 0) {
    const source = new EventSource(streamUrl);

    source.addEventListener('ready', (event) => {
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch (err) {
        payload = null;
      }
      if (!payload || !Array.isArray(payload.activeTypers) || !payload.activeTypers.length) return;
      const activeTyper = payload.activeTypers.find((entry) => Number(entry.userId || 0) !== currentUserId);
      if (!activeTyper) return;
      showRemoteTyping(activeTyper.displayName || otherUsername);
    });

    source.addEventListener('message-created', (event) => {
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch (err) {
        payload = null;
      }
      if (!payload || !payload.message) return;
      upsertMessage(payload.message, {
        forceScroll: Number(payload.message.senderId || 0) !== currentUserId
      });
      if (Number(payload.message.senderId || 0) !== currentUserId) {
        hideRemoteTyping();
      }
    });

    source.addEventListener('typing', (event) => {
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch (err) {
        payload = null;
      }
      if (!payload || Number(payload.userId || 0) === currentUserId) return;
      if (payload.active) {
        showRemoteTyping(payload.displayName || otherUsername);
      } else {
        hideRemoteTyping();
      }
    });

    window.addEventListener('beforeunload', () => {
      source.close();
      stopVoiceStream();
      stopCameraStream();
      resetRecordingTicker();
      clearDraftPreview();
    });
  } else {
    window.addEventListener('beforeunload', () => {
      stopVoiceStream();
      stopCameraStream();
      resetRecordingTicker();
      clearDraftPreview();
    });
  }
})();
