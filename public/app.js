import { animate, spring, stagger } from './vendor/anime.esm.min.js';

const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const LIMIT_MESSAGE = 'El archivo supera el limite maximo permitido de 1 GB. Selecciona un archivo mas pequeno.';
const LEGAL_NOTICE_KEY = 'metadata_legal_ack_v1';

const uploadForm = document.querySelector('#uploadForm');
const fileInput = document.querySelector('#fileInput');
const dropZone = document.querySelector('#dropZone');
const selectedFileBox = document.querySelector('#selectedFile');
const selectedName = document.querySelector('#selectedName');
const selectedSize = document.querySelector('#selectedSize');
const analyzeButton = document.querySelector('#analyzeButton');
const clearButton = document.querySelector('#clearButton');
const progressWrap = document.querySelector('#progressWrap');
const progressBar = document.querySelector('#progressBar');
const progressText = document.querySelector('#progressText');
const statusLine = document.querySelector('#statusLine');
const resultsSection = document.querySelector('#resultsSection');
const resultTitle = document.querySelector('#resultTitle');
const analysisDate = document.querySelector('#analysisDate');
const summaryCards = document.querySelector('#summaryCards');
const fileDetails = document.querySelector('#fileDetails');
const detectedDetails = document.querySelector('#detectedDetails');
const safetyDetails = document.querySelector('#safetyDetails');
const rawJson = document.querySelector('#rawJson');
const copyJson = document.querySelector('#copyJson');
const authOpen = document.querySelector('#authOpen');
const authModal = document.querySelector('#authModal');
const loginTab = document.querySelector('#loginTab');
const registerTab = document.querySelector('#registerTab');
const loginForm = document.querySelector('#loginForm');
const registerForm = document.querySelector('#registerForm');
const authMessage = document.querySelector('#authMessage');
const sessionUser = document.querySelector('#sessionUser');
const adminButton = document.querySelector('#adminButton');
const accountButton = document.querySelector('#accountButton');
const accountPanel = document.querySelector('#accountPanel');
const accountHistory = document.querySelector('#accountHistory');
const sessionsList = document.querySelector('#sessionsList');
const logoutButton = document.querySelector('#logoutButton');
const logoutOthers = document.querySelector('#logoutOthers');
const adminPanel = document.querySelector('#adminPanel');
const refreshAdmin = document.querySelector('#refreshAdmin');
const adminStats = document.querySelector('#adminStats');
const adminUsers = document.querySelector('#adminUsers');
const adminTelemetry = document.querySelector('#adminTelemetry');
const adminEvents = document.querySelector('#adminEvents');
const adminBlocks = document.querySelector('#adminBlocks');
const adminBlockForm = document.querySelector('#adminBlockForm');
const adminMessage = document.querySelector('#adminMessage');
const editorForm = document.querySelector('#editorForm');
const editButton = document.querySelector('#editButton');
const editStatus = document.querySelector('#editStatus');
const clearMetadataFields = document.querySelector('#clearMetadataFields');
const metadataFields = Array.from(document.querySelectorAll('[data-metadata-field]'));
const legalNotice = document.querySelector('#legalNotice');
const legalAccept = document.querySelector('#legalAccept');
const workbenchHead = document.querySelector('.workbench-head');
const assurancePanel = document.querySelector('.assurance-panel');
const legalPreview = document.querySelector('.legal-preview');
const passwordToggles = Array.from(document.querySelectorAll('[data-password-toggle]'));
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let currentFile = null;
let latestResult = null;
let currentUser = null;
let currentSessionId = '';
let motionPaused = document.visibilityState === 'hidden';

function canAnimate() {
  return !prefersReducedMotion.matches && !motionPaused;
}

function playMotion(target, params) {
  if (!canAnimate() || !target) return null;
  return animate(target, params);
}

document.addEventListener('visibilitychange', () => {
  motionPaused = document.visibilityState === 'hidden';
});

if (!prefersReducedMotion.matches) {
  document.documentElement.classList.add('motion-ready');
}

function animatePageIntro() {
  if (!canAnimate()) return;
  const entranceTargets = [
    document.querySelector('.topbar'),
    ...document.querySelectorAll('.intro > *'),
    workbenchHead,
    uploadForm,
    editorForm,
    legalPreview,
    assurancePanel
  ].filter(Boolean);

  playMotion(entranceTargets, {
    opacity: [0, 1],
    translateY: [24, 0],
    delay: stagger(70),
    duration: 720,
    ease: 'outCubic'
  });

  playMotion(dropZone, {
    scale: [0.96, 1],
    duration: 920,
    delay: 340,
    ease: spring({ bounce: 0.22, duration: 920 })
  });

  playMotion('.drop-mark', {
    opacity: [0, 1],
    scale: [0.7, 1],
    rotate: [-8, 0],
    duration: 900,
    delay: 430,
    ease: spring({ bounce: 0.38, duration: 900 })
  });
}

function setupScrollReveals() {
  if (!canAnimate() || !('IntersectionObserver' in window)) return;
  const targets = Array.from(document.querySelectorAll([
    '.metadata-workflow',
    '.assurance-panel',
    '.account-panel',
    '.admin-panel',
    '.results-section',
    '.legal-footer'
  ].join(',')));
  targets.forEach((target) => target.classList.add('reveal-on-scroll'));

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      playMotion(entry.target, {
        opacity: [0, 1],
        translateY: [18, 0],
        duration: 440,
        ease: 'outCubic'
      });
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.16 });

  targets.forEach((target) => observer.observe(target));
}

function readLegalAcknowledgement() {
  try {
    return window.localStorage.getItem(LEGAL_NOTICE_KEY) === 'accepted';
  } catch {
    return false;
  }
}

function writeLegalAcknowledgement() {
  try {
    window.localStorage.setItem(LEGAL_NOTICE_KEY, 'accepted');
  } catch {
    // localStorage can be unavailable in hardened browser contexts.
  }
}

function legalFocusableElements() {
  if (!legalNotice || legalNotice.hidden) return [];
  return Array.from(legalNotice.querySelectorAll('a[href], button:not([disabled])'));
}

function openLegalNotice() {
  if (!legalNotice || readLegalAcknowledgement()) return;
  legalNotice.hidden = false;
  document.body.classList.add('modal-open');
  const targets = [
    legalNotice.querySelector('.legal-notice-card'),
    ...legalNotice.querySelectorAll('.legal-notice-grid article'),
    ...legalNotice.querySelectorAll('.legal-notice-links a'),
    legalAccept
  ].filter(Boolean);
  playMotion(targets, {
    opacity: [0, 1],
    translateY: [22, 0],
    scale: [0.98, 1],
    delay: stagger(50),
    duration: 520,
    ease: 'outCubic'
  });
  setTimeout(() => legalAccept?.focus(), 80);
}

function closeLegalNotice() {
  if (!legalNotice) return;
  writeLegalAcknowledgement();
  playMotion(legalNotice.querySelector('.legal-notice-card'), {
    opacity: [1, 0],
    translateY: [0, 14],
    duration: 180,
    ease: 'inCubic'
  });
  setTimeout(() => {
    legalNotice.hidden = true;
    document.body.classList.remove('modal-open');
  }, canAnimate() ? 190 : 0);
}

function animateDropPulse() {
  playMotion(dropZone, {
    scale: [1, 1.018, 1],
    duration: 560,
    ease: 'outCubic'
  });
}

function animateFileSelected() {
  playMotion(selectedFileBox, {
    opacity: [0, 1],
    translateY: [12, 0],
    duration: 420,
    ease: 'outCubic'
  });
  playMotion('.drop-mark', {
    scale: [1, 1.1, 1],
    rotate: [0, 4, 0],
    duration: 560,
    ease: spring({ bounce: 0.34, duration: 560 })
  });
  playMotion([analyzeButton, clearButton], {
    translateY: [8, 0],
    opacity: [0.7, 1],
    delay: stagger(45),
    duration: 320,
    ease: 'outCubic'
  });
}

function animateFileError() {
  playMotion(dropZone, {
    translateX: [0, -10, 8, -5, 0],
    duration: 420,
    ease: 'inOutQuad'
  });
}

function animateStatusLine(element) {
  playMotion(element, {
    opacity: [0.45, 1],
    translateY: [5, 0],
    duration: 240,
    ease: 'outCubic'
  });
}

function animateResultsIn() {
  playMotion(resultsSection, {
    opacity: [0, 1],
    translateY: [18, 0],
    duration: 520,
    ease: 'outCubic'
  });
  playMotion([...summaryCards.children, ...resultsSection.querySelectorAll('.detail-panel')], {
    opacity: [0, 1],
    translateY: [18, 0],
    delay: stagger(55),
    duration: 520,
    ease: 'outCubic'
  });
}

function animateEditorReady() {
  playMotion(editButton, {
    scale: [1, 1.018, 1],
    duration: 420,
    ease: 'outCubic'
  });
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function formatDate(iso) {
  if (!iso) return '--';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('es-DO');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function setStatus(message, tone = 'neutral') {
  statusLine.textContent = message;
  statusLine.className = `status-line ${tone}`;
  animateStatusLine(statusLine);
}

function setAuthMessage(message, tone = '') {
  authMessage.textContent = message || '';
  authMessage.className = tone ? `auth-message ${tone}` : 'auth-message';
}

function setAdminMessage(message, tone = '') {
  if (!adminMessage) return;
  adminMessage.textContent = message || '';
  adminMessage.className = tone ? `auth-message ${tone}` : 'auth-message';
}

function setFormBusy(form, isBusy) {
  form?.setAttribute('aria-busy', isBusy ? 'true' : 'false');
  form?.querySelectorAll('button, input, select, textarea').forEach((control) => {
    control.disabled = isBusy;
  });
}

function setEditStatus(message, tone = 'neutral') {
  editStatus.textContent = message;
  editStatus.className = `status-line ${tone}`;
  animateStatusLine(editStatus);
}

function hasMetadataValues() {
  return metadataFields.some((field) => field.value.trim().length > 0);
}

function canUseCurrentFile() {
  return Boolean(currentFile) && currentFile.size <= MAX_FILE_BYTES;
}

function updateEditorState(isBusy = false) {
  const wasDisabled = editButton.disabled;
  editButton.disabled = isBusy || !canUseCurrentFile() || !hasMetadataValues();
  if (wasDisabled && !editButton.disabled) animateEditorReady();
}

function setProgress(percent) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  progressBar.style.width = `${value}%`;
  progressText.textContent = `${value}%`;
}

function setBusy(isBusy) {
  uploadForm.classList.toggle('is-busy', isBusy);
  analyzeButton.disabled = isBusy || !currentFile || currentFile.size > MAX_FILE_BYTES;
  clearButton.disabled = isBusy || !currentFile;
  updateEditorState(isBusy);
}

function resetResults() {
  latestResult = null;
  resultsSection.hidden = true;
  rawJson.textContent = '{}';
  summaryCards.innerHTML = '';
  fileDetails.innerHTML = '';
  detectedDetails.innerHTML = '';
  safetyDetails.innerHTML = '';
}

function resetFile() {
  currentFile = null;
  fileInput.value = '';
  selectedFileBox.hidden = true;
  analyzeButton.disabled = true;
  clearButton.disabled = true;
  progressWrap.hidden = true;
  setProgress(0);
  setStatus('Esperando archivo');
  editorForm.reset();
  setEditStatus('Selecciona un archivo valido y completa al menos un campo.');
  updateEditorState();
  dropZone.classList.remove('has-file', 'has-error');
  resetResults();
}

function selectFile(file) {
  resetResults();
  currentFile = file || null;
  progressWrap.hidden = true;
  setProgress(0);

  if (!currentFile) {
    resetFile();
    return;
  }

  selectedFileBox.hidden = false;
  selectedName.textContent = currentFile.name || 'archivo sin nombre';
  selectedSize.textContent = formatBytes(currentFile.size);
  clearButton.disabled = false;
  dropZone.classList.add('has-file');

  if (currentFile.size > MAX_FILE_BYTES) {
    analyzeButton.disabled = true;
    dropZone.classList.add('has-error');
    setStatus(LIMIT_MESSAGE, 'error');
    setEditStatus(LIMIT_MESSAGE, 'error');
    updateEditorState();
    animateFileError();
    return;
  }

  dropZone.classList.remove('has-error');
  analyzeButton.disabled = false;
  updateEditorState();
  setEditStatus('Archivo listo para recibir metadata nueva.', 'ok');
  setStatus('Archivo listo para analizar', 'ok');
  animateFileSelected();
}

function createSummaryCard(label, value) {
  const article = document.createElement('article');
  article.className = 'summary-card';
  article.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
  return article;
}

function renderKvList(target, entries) {
  target.innerHTML = '';
  const visible = entries.filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '');
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'kv-row';
    empty.innerHTML = '<dt>Estado</dt><dd>Sin datos adicionales</dd>';
    target.append(empty);
    return;
  }

  for (const [key, value] of visible) {
    const row = document.createElement('div');
    row.className = 'kv-row';
    row.innerHTML = `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(Array.isArray(value) ? value.join(', ') : value)}</dd>`;
    target.append(row);
  }
}

function flattenMetadata(metadata = {}) {
  const entries = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [innerKey, innerValue] of Object.entries(value)) {
        if (innerValue && typeof innerValue === 'object' && !Array.isArray(innerValue)) continue;
        entries.push([`${key}.${innerKey}`, innerValue]);
      }
    } else {
      entries.push([key, value]);
    }
  }
  return entries;
}

function renderResult(result) {
  latestResult = result;
  resultsSection.hidden = false;
  resultTitle.textContent = result.originalName || 'Metadatos extraidos';
  analysisDate.textContent = formatDate(result.analyzedAt);

  summaryCards.innerHTML = '';
  summaryCards.append(
    createSummaryCard('Nombre', result.originalName || '--'),
    createSummaryCard('Tamano', result.sizeHuman || formatBytes(result.sizeBytes)),
    createSummaryCard('Tipo MIME', result.mimeType || '--'),
    createSummaryCard('Extension', result.extension || 'sin extension')
  );

  renderKvList(fileDetails, [
    ['Nombre', result.originalName],
    ['Tamano exacto', `${result.sizeBytes} bytes`],
    ['Tamano legible', result.sizeHuman],
    ['Tipo MIME declarado', result.declaredMimeType],
    ['Tipo MIME detectado', result.mimeType],
    ['Extension', result.extension || 'sin extension'],
    ['Fecha de analisis', result.analyzedAt ? new Date(result.analyzedAt).toISOString() : '--'],
    ['Guardado en cuenta', result.owned ? 'Si' : 'No']
  ]);

  const detection = result.metadata?.detection || {};
  renderKvList(detectedDetails, [
    ['Tipo detectado', detection.detectedType],
    ['Categoria', detection.category],
    ['Muestra analizada', `${detection.parserSampleBytes || 0} bytes`],
    ...flattenMetadata(detection.typeMetadata)
  ]);

  const safety = result.metadata?.safety || {};
  renderKvList(safetyDetails, [
    ['Archivo almacenado', safety.fileStored ? 'Si' : 'No'],
    ['Contenido retenido', safety.retainedContent ? 'Si' : 'No'],
    ['Enlace publico', safety.publicLinkCreated ? 'Si' : 'No'],
    ['Limite maximo', safety.maxFileSizeHuman || formatBytes(MAX_FILE_BYTES)]
  ]);

  rawJson.textContent = JSON.stringify(result, null, 2);
  animateResultsIn();
}

async function apiJson(url, body = null, method = 'POST') {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || 'No se pudo completar la solicitud.');
  }
  return data;
}

function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);

    const request = new XMLHttpRequest();
    request.open('POST', '/api/analyze');
    request.responseType = 'json';
    request.withCredentials = true;

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) setProgress((event.loaded / event.total) * 100);
    });

    request.addEventListener('load', () => {
      const data = request.response || {};
      if (request.status < 200 || request.status >= 300 || !data.ok) {
        reject(new Error(data.error || 'No se pudo extraer la metadata.'));
        return;
      }
      resolve(data.result);
    });

    request.addEventListener('error', () => reject(new Error('No se pudo conectar con el servidor.')));
    request.addEventListener('timeout', () => reject(new Error('El analisis tardo demasiado.')));
    request.timeout = 0;
    request.send(formData);
  });
}

function collectMetadataEdits() {
  const edits = {};
  for (const field of metadataFields) {
    const key = field.dataset.metadataField;
    const value = field.value.trim();
    if (key && value) edits[key] = value;
  }
  if (!Object.keys(edits).length) {
    throw new Error('Completa al menos un campo de metadata.');
  }
  return edits;
}

function filenameFromDisposition(header) {
  const value = String(header || '');
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      return encoded[1];
    }
  }
  const plain = value.match(/filename="([^"]+)"/i);
  return plain?.[1] || 'metadata-actualizada';
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function editMetadataFile(file, edits) {
  const formData = new FormData();
  formData.append('metadata', JSON.stringify(edits));
  formData.append('file', file);

  const response = await fetch('/api/edit-metadata', {
    method: 'POST',
    credentials: 'same-origin',
    body: formData
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'No se pudo crear el archivo actualizado.');
  }

  return {
    blob: await response.blob(),
    filename: filenameFromDisposition(response.headers.get('content-disposition'))
  };
}

function setAuthMode(mode) {
  const register = mode === 'register';
  loginTab.classList.toggle('active', !register);
  registerTab.classList.toggle('active', register);
  loginTab.setAttribute('aria-selected', register ? 'false' : 'true');
  registerTab.setAttribute('aria-selected', register ? 'true' : 'false');
  loginForm.hidden = register;
  registerForm.hidden = !register;
  document.querySelector('#authTitle').textContent = register ? 'Crear cuenta privada' : 'Entrar a la cuenta';
  setAuthMessage('');
  const activeForm = register ? registerForm : loginForm;
  playMotion(activeForm.querySelectorAll('.auth-field, .primary-button, .form-note'), {
    opacity: [0, 1],
    translateY: [8, 0],
    delay: stagger(38),
    duration: 260,
    ease: 'outCubic'
  });
}

function openAuth(mode = 'login') {
  setAuthMode(mode);
  authModal.hidden = false;
  document.body.classList.add('modal-open');
  const focusTarget = mode === 'register' ? document.querySelector('#registerUsername') : document.querySelector('#loginEmail');
  playMotion(authModal.querySelector('.auth-panel'), {
    opacity: [0, 1],
    translateY: [18, 0],
    scale: [0.98, 1],
    duration: 360,
    ease: 'outCubic'
  });
  playMotion(authModal.querySelectorAll('.auth-aside > *, .auth-box > *'), {
    opacity: [0, 1],
    translateY: [14, 0],
    delay: stagger(45),
    duration: 420,
    ease: 'outCubic'
  });
  setTimeout(() => focusTarget?.focus(), 40);
}

function closeAuth() {
  authModal.hidden = true;
  document.body.classList.remove('modal-open');
}

function setupPasswordToggles() {
  passwordToggles.forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.querySelector(`#${button.dataset.passwordToggle}`);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.textContent = show ? 'Ocultar' : 'Ver';
      button.setAttribute('aria-label', show ? 'Ocultar contrasena' : 'Mostrar contrasena');
      button.setAttribute('aria-pressed', show ? 'true' : 'false');
      input.focus();
    });
  });
}

function renderAuthState(user) {
  currentUser = user || null;
  authOpen.hidden = Boolean(currentUser);
  sessionUser.hidden = !currentUser;
  accountButton.hidden = !currentUser;
  adminButton.hidden = currentUser?.role !== 'admin';
  if (sessionUser) sessionUser.textContent = currentUser ? currentUser.username : '';
  if (currentUser?.role !== 'admin') adminPanel.hidden = true;
  if (!currentUser) {
    accountPanel.hidden = true;
    adminPanel.hidden = true;
    accountHistory.innerHTML = '';
    sessionsList.innerHTML = '';
  }
}

async function loadMe() {
  const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
  const data = await response.json().catch(() => ({}));
  renderAuthState(data.user || null);
}

function renderAccountHistory(items) {
  if (!items?.length) {
    accountHistory.innerHTML = '<p class="muted">Todavia no hay analisis asociados a esta cuenta.</p>';
    return;
  }
  accountHistory.innerHTML = items.map((item) => `
    <article class="history-item">
      <div>
        <strong>${escapeHtml(item.originalName || 'archivo')}</strong>
        <span>${escapeHtml(formatDate(item.createdAt))}</span>
      </div>
      <p>${escapeHtml([item.mimeType, item.detectedType, item.sizeHuman].filter(Boolean).join(' · '))}</p>
      <small>${escapeHtml(item.extension || 'sin extension')}</small>
    </article>
  `).join('');
}

function renderSessions(items) {
  if (!items?.length) {
    sessionsList.innerHTML = '<p class="muted">No hay sesiones activas.</p>';
    return;
  }
  sessionsList.innerHTML = items.map((session) => `
    <article class="session-item">
      <div>
        <strong>${escapeHtml(session.device_label || 'Dispositivo')}${session.current ? ' · actual' : ''}</strong>
        <span>${escapeHtml(session.ip || 'IP no disponible')}</span>
      </div>
      <small>Ultima actividad: ${escapeHtml(formatDate(session.last_seen_at))}</small>
      <small>Creada: ${escapeHtml(formatDate(session.created_at))}</small>
      <button class="secondary-button compact revoke-session" type="button" data-session="${escapeHtml(session.id)}" ${session.current ? 'disabled' : ''}>Cerrar</button>
    </article>
  `).join('');

  sessionsList.querySelectorAll('.revoke-session').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.getAttribute('data-session');
      if (!id) return;
      await apiJson(`/api/account/sessions/${encodeURIComponent(id)}/revoke`);
      await loadAccount();
    });
  });
}

async function loadAccount() {
  if (!currentUser) return;
  const [history, sessions] = await Promise.all([
    fetch('/api/account/history', { credentials: 'same-origin' }).then((response) => response.json()),
    fetch('/api/account/sessions', { credentials: 'same-origin' }).then((response) => response.json())
  ]);
  renderAccountHistory(history.analyses || []);
  currentSessionId = sessions.current_session_id || '';
  renderSessions((sessions.sessions || []).map((session) => ({
    ...session,
    current: session.current || session.id === currentSessionId
  })));
}

function renderAdminStats(stats = {}) {
  const cards = [
    ['Usuarios', stats.users ?? 0],
    ['Analisis', stats.analyses ?? 0],
    ['Visitas 24h', stats.visits_today ?? 0],
    ['Sesiones activas', stats.active_sessions ?? 0],
    ['Bloqueos', stats.active_blocks ?? 0]
  ];
  adminStats.innerHTML = cards.map(([label, value]) => `
    <article class="summary-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `).join('');
}

function renderAdminUsers(items = []) {
  if (!items.length) {
    adminUsers.innerHTML = '<p class="muted">Sin usuarios registrados.</p>';
    return;
  }
  adminUsers.innerHTML = items.map((user) => `
    <article class="admin-item">
      <div>
        <strong>${escapeHtml(user.username || 'usuario')}</strong>
        <span>${escapeHtml(user.role || 'user')}</span>
      </div>
      <p>${escapeHtml(user.email || '')}</p>
      <small>IP inicial: ${escapeHtml(user.created_ip || 'no disponible')} · Analisis: ${escapeHtml(user.analysis_count ?? 0)} · Sesiones: ${escapeHtml(user.active_sessions ?? 0)}</small>
      <small>Ultima actividad: ${escapeHtml(formatDate(user.last_activity))}</small>
    </article>
  `).join('');
}

function renderAdminTelemetry(items = []) {
  if (!items.length) {
    adminTelemetry.innerHTML = '<p class="muted">Sin telemetria registrada todavia.</p>';
    return;
  }
  adminTelemetry.innerHTML = items.map((item) => `
    <article class="admin-item">
      <div>
        <strong>${escapeHtml(item.ip || 'IP no disponible')}</strong>
        <span>${escapeHtml(formatDate(item.created_at))}</span>
      </div>
      <p>${escapeHtml(`${item.method || 'GET'} ${item.path || '/'}`)}</p>
      <small>${escapeHtml(item.device_label || [item.browser, item.os, item.device_type].filter(Boolean).join(' · ') || 'Dispositivo')}</small>
      <small>${escapeHtml([item.username || item.email || 'visitante', item.cf_country ? `Pais proxy: ${item.cf_country}` : '', item.accept_language || ''].filter(Boolean).join(' · '))}</small>
      <small>${escapeHtml(item.user_agent || 'User-agent no disponible')}</small>
    </article>
  `).join('');
}

function renderAdminEvents(items = []) {
  if (!items.length) {
    adminEvents.innerHTML = '<p class="muted">Sin eventos registrados.</p>';
    return;
  }
  adminEvents.innerHTML = items.map((event) => `
    <article class="admin-item">
      <div>
        <strong>${escapeHtml(event.event_type || 'evento')}</strong>
        <span>${escapeHtml(formatDate(event.created_at))}</span>
      </div>
      <p>${escapeHtml([event.username || event.email || 'usuario anonimo', event.entity_type, event.entity_id].filter(Boolean).join(' · '))}</p>
      <small>IP: ${escapeHtml(event.ip || 'no disponible')}</small>
      <small>${escapeHtml(JSON.stringify(event.details || {}))}</small>
    </article>
  `).join('');
}

function renderAdminBlocks(items = []) {
  if (!items.length) {
    adminBlocks.innerHTML = '<p class="muted">No hay bloqueos activos.</p>';
    return;
  }
  adminBlocks.innerHTML = items.map((block) => `
    <article class="admin-item">
      <div>
        <strong>${escapeHtml(block.block_type || 'bloqueo')}: ${escapeHtml(block.value || '')}</strong>
        <span>${escapeHtml(formatDate(block.created_at))}</span>
      </div>
      <p>${escapeHtml(block.reason || 'Sin motivo registrado')}</p>
      <small>Creado por: ${escapeHtml(block.created_by_username || 'admin')}</small>
      <button class="secondary-button compact revoke-block" type="button" data-block="${escapeHtml(block.id)}">Quitar bloqueo</button>
    </article>
  `).join('');
  adminBlocks.querySelectorAll('.revoke-block').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.getAttribute('data-block');
      if (!id) return;
      button.disabled = true;
      await apiJson(`/api/admin/blocks/${encodeURIComponent(id)}/revoke`);
      await loadAdmin();
    });
  });
}

function renderAdmin(data) {
  renderAdminStats(data.stats || {});
  renderAdminUsers(data.users || []);
  renderAdminTelemetry(data.telemetry || []);
  renderAdminEvents(data.events || []);
  renderAdminBlocks(data.blocks || []);
}

async function loadAdmin() {
  if (currentUser?.role !== 'admin') return;
  setAdminMessage('Cargando panel administrativo...');
  try {
    const response = await fetch('/api/admin/overview', { credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || 'No se pudo cargar el panel admin.');
    renderAdmin(data);
    setAdminMessage('Panel actualizado.', 'ok');
  } catch (error) {
    setAdminMessage(error.message || 'No se pudo cargar el panel admin.', 'error');
  }
}

fileInput.addEventListener('change', () => {
  selectFile(fileInput.files?.[0]);
});

dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});

for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add('is-dragging');
    animateDropPulse();
  });
}

for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove('is-dragging');
  });
}

dropZone.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) selectFile(file);
});

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentFile) {
    setStatus('Selecciona un archivo para analizar.', 'error');
    return;
  }
  if (currentFile.size > MAX_FILE_BYTES) {
    setStatus(LIMIT_MESSAGE, 'error');
    return;
  }

  setBusy(true);
  progressWrap.hidden = false;
  setProgress(0);
  setStatus('Analizando metadata tecnica...');

  try {
    const result = await uploadFile(currentFile);
    setProgress(100);
    renderResult(result);
    if (currentUser) await loadAccount();
    setStatus('Metadata extraida correctamente', 'ok');
  } catch (error) {
    setStatus(error.message || 'No se pudo completar el analisis.', 'error');
  } finally {
    setBusy(false);
  }
});

clearButton.addEventListener('click', resetFile);

metadataFields.forEach((field) => {
  field.addEventListener('input', () => updateEditorState());
});

clearMetadataFields.addEventListener('click', () => {
  editorForm.reset();
  updateEditorState();
  setEditStatus(canUseCurrentFile() ? 'Campos limpiados.' : 'Selecciona un archivo valido y completa al menos un campo.');
});

editorForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentFile) {
    setEditStatus('Selecciona un archivo para editar su metadata.', 'error');
    return;
  }
  if (currentFile.size > MAX_FILE_BYTES) {
    setEditStatus(LIMIT_MESSAGE, 'error');
    return;
  }

  let edits;
  try {
    edits = collectMetadataEdits();
  } catch (error) {
    setEditStatus(error.message, 'error');
    return;
  }

  setBusy(true);
  setEditStatus('Aplicando metadata y preparando descarga...');
  try {
    const { blob, filename } = await editMetadataFile(currentFile, edits);
    triggerDownload(blob, filename);
    setEditStatus('Archivo actualizado entregado. No se guardo una copia.', 'ok');
    setStatus('Metadata editada correctamente', 'ok');
    playMotion(editorForm, {
      scale: [1, 1.006, 1],
      duration: 520,
      ease: 'outCubic'
    });
  } catch (error) {
    setEditStatus(error.message || 'No se pudo editar la metadata.', 'error');
  } finally {
    setBusy(false);
  }
});

copyJson.addEventListener('click', async () => {
  if (!latestResult) return;
  await navigator.clipboard.writeText(JSON.stringify(latestResult, null, 2));
  setStatus('JSON copiado', 'ok');
});

authOpen.addEventListener('click', () => openAuth('login'));
loginTab.addEventListener('click', () => setAuthMode('login'));
registerTab.addEventListener('click', () => setAuthMode('register'));
authModal.querySelectorAll('[data-auth-close]').forEach((button) => button.addEventListener('click', closeAuth));

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(loginForm);
  setFormBusy(loginForm, true);
  setAuthMessage('Validando...');
  try {
    const data = await apiJson('/api/auth/login', {
      email: form.get('email'),
      password: form.get('password')
    });
    renderAuthState(data.user || null);
    closeAuth();
    await loadAccount();
    accountPanel.hidden = false;
  } catch (error) {
    setAuthMessage(error.message, 'error');
  } finally {
    setFormBusy(loginForm, false);
  }
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(registerForm);
  setFormBusy(registerForm, true);
  setAuthMessage('Creando cuenta...');
  try {
    const data = await apiJson('/api/auth/register', {
      username: form.get('username'),
      email: form.get('email'),
      password: form.get('password')
    });
    renderAuthState(data.user || null);
    closeAuth();
    await loadAccount();
    accountPanel.hidden = false;
  } catch (error) {
    setAuthMessage(error.message, 'error');
  } finally {
    setFormBusy(registerForm, false);
  }
});

accountButton.addEventListener('click', async () => {
  accountPanel.hidden = !accountPanel.hidden;
  if (!accountPanel.hidden) await loadAccount();
});

adminButton?.addEventListener('click', async () => {
  adminPanel.hidden = !adminPanel.hidden;
  if (!adminPanel.hidden) {
    await loadAdmin();
    window.scrollTo({ top: Math.max(0, adminPanel.offsetTop - 18), behavior: 'auto' });
  }
});

refreshAdmin?.addEventListener('click', loadAdmin);

adminBlockForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(adminBlockForm);
  setFormBusy(adminBlockForm, true);
  setAdminMessage('Creando bloqueo...');
  try {
    await apiJson('/api/admin/blocks', {
      blockType: form.get('blockType'),
      value: form.get('value'),
      reason: form.get('reason')
    });
    adminBlockForm.reset();
    await loadAdmin();
    setAdminMessage('Bloqueo creado.', 'ok');
  } catch (error) {
    setAdminMessage(error.message || 'No se pudo crear el bloqueo.', 'error');
  } finally {
    setFormBusy(adminBlockForm, false);
  }
});

logoutButton.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  renderAuthState(null);
  setStatus('Sesion cerrada');
});

logoutOthers.addEventListener('click', async () => {
  await apiJson('/api/account/sessions/logout-others');
  await loadAccount();
});

legalAccept?.addEventListener('click', closeLegalNotice);

legalNotice?.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const focusables = legalFocusableElements();
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

setupPasswordToggles();
setupScrollReveals();
animatePageIntro();
loadMe().catch(() => renderAuthState(null));
openLegalNotice();
