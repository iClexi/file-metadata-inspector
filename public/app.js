const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const LIMIT_MESSAGE = 'El archivo supera el limite maximo permitido de 1 GB. Selecciona un archivo mas pequeno.';

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

let currentFile = null;
let latestResult = null;

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
    return;
  }

  dropZone.classList.remove('has-error');
  analyzeButton.disabled = false;
  setStatus('Archivo listo para analizar', 'ok');
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
  analysisDate.textContent = result.analyzedAt ? new Date(result.analyzedAt).toLocaleString('es-DO') : '--';

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
    ['Fecha de analisis', result.analyzedAt ? new Date(result.analyzedAt).toISOString() : '--']
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
}

function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);

    const request = new XMLHttpRequest();
    request.open('POST', '/api/analyze');
    request.responseType = 'json';

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
    setStatus('Metadata extraida correctamente', 'ok');
  } catch (error) {
    setStatus(error.message || 'No se pudo completar el analisis.', 'error');
  } finally {
    setBusy(false);
  }
});

clearButton.addEventListener('click', resetFile);

copyJson.addEventListener('click', async () => {
  if (!latestResult) return;
  await navigator.clipboard.writeText(JSON.stringify(latestResult, null, 2));
  setStatus('JSON copiado', 'ok');
});
