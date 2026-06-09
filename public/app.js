const $ = (selector, root = document) => root.querySelector(selector);
const money = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

let state = null;
let stream = null;
let selectedPlate = '';
let lastPaymentUrl = '';
let capturedImage = '';
let autoDetectTimer = null;
let detecting = false;
let lastDetectedPlate = '';
let detectionLocked = false;

const app = $('#app');
const DETECTION_CROPS = [
  { id: 'full-frame', x: 0, y: 0, w: 1, h: 1, targetWidth: 1180, quality: 0.68 },
  { id: 'plate-zone', x: 0.08, y: 0.28, w: 0.84, h: 0.46, targetWidth: 1280, quality: 0.74 },
  { id: 'plate-zone-ocr', x: 0.16, y: 0.34, w: 0.68, h: 0.34, targetWidth: 1400, quality: 0.78, enhance: true }
];

function plateList() {
  return state?.vehicles || [];
}

function metrics() {
  const vehicles = plateList();
  const inside = vehicles.filter((v) => v.inside);
  const pending = vehicles.filter((v) => v.inside && !v.paid);
  const paid = (state?.payments || []).filter((p) => p.status === 'paid');
  const digital = paid.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  return {
    inside: inside.length,
    cars: inside.filter((v) => v.vehicle_type === 'Carro').length,
    motos: inside.filter((v) => v.vehicle_type === 'Moto').length,
    pending: pending.reduce((sum, v) => sum + Number(v.amount_due || 0), 0),
    digital,
    pendingCount: pending.length
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.reason || data.error || 'request_failed');
    err.data = data;
    throw err;
  }
  return data;
}

async function loadState() {
  state = await api('/api/state');
  if (!selectedPlate && state.vehicles?.[0]) selectedPlate = state.vehicles[0].plate;
}

function renderShell() {
  const isPayment = location.pathname.startsWith('/pagar/');
  if (isPayment) return renderPaymentPage(location.pathname.split('/').pop());
  return renderDashboard();
}

function renderDashboard() {
  const m = metrics();
  const selected = plateList().find((v) => v.plate === selectedPlate) || plateList()[0];
  selectedPlate = selected?.plate || '';
  app.innerHTML = `
    <main class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">P</div>
          <div>
            <strong>Parkcol Smart Control</strong>
            <span>Demo operativo - TURNO02</span>
          </div>
        </div>
        <div class="top-actions">
          <button class="ghost" id="refresh">Actualizar</button>
          <button class="primary" id="closeShift">Cerrar turno</button>
        </div>
      </header>

      <section class="metrics-grid">
        ${metric('Vehículos dentro', m.inside, `${m.cars} carros / ${m.motos} motos`)}
        ${metric('Pagos pendientes', money.format(m.pending), `${m.pendingCount} por cobrar`)}
        ${metric('Recaudo digital', money.format(m.digital), 'QR / link simulado')}
        ${metric('Fuente de datos', state.mode === 'postgres' ? 'Postgres' : 'Memoria', state.mode === 'postgres' ? 'DB demo aislada' : 'Fallback local')}
      </section>

      <section class="workbench">
        <div class="scanner-panel">
          <div class="section-head">
            <div>
              <span class="eyebrow">Entrada</span>
              <h1>Captura de placa</h1>
            </div>
            <span class="status-dot ${stream ? 'ok' : ''}" id="cameraStatus">${detectionLocked ? 'Lectura bloqueada' : stream ? 'Detector activo' : 'Camara web'}</span>
          </div>
          <div class="camera-box">
            <video id="camera" autoplay playsinline muted></video>
            <canvas id="snapshot" width="960" height="540"></canvas>
            <div class="scan-overlay">
              <span></span><span></span><span></span><span></span>
            </div>
          </div>
          <div class="scan-controls">
            <button class="secondary" id="startCamera">Abrir cámara</button>
            <button class="secondary" id="capture">Detectar ahora</button>
            <button class="ghost" id="resumeDetection">Seguir detectando</button>
            <button class="ghost" id="simulate">Simular lectura</button>
          </div>
          <div class="plate-form">
            <label>Placa detectada / confirmada</label>
            <input id="plateInput" value="${selected?.plate || 'KLM428'}" maxlength="6" />
            <label>Tipo</label>
            <select id="typeInput">
              <option ${selected?.vehicle_type === 'Carro' ? 'selected' : ''}>Carro</option>
              <option ${selected?.vehicle_type === 'Moto' ? 'selected' : ''}>Moto</option>
              <option ${selected?.vehicle_type === 'Por confirmar' ? 'selected' : ''}>Por confirmar</option>
            </select>
            <label>Servicio</label>
            <select id="serviceInput">
              <option>Horas</option>
              <option>Mensualidad</option>
              <option>Amanecida</option>
              <option>Valet</option>
            </select>
            <button class="primary" id="registerEntry">Registrar ingreso</button>
          </div>
          <div class="result-line" id="resultLine">Lectura lista para confirmar.</div>
        </div>

        <div class="operations-panel">
          <div class="section-head">
            <div>
              <span class="eyebrow">Operación</span>
              <h2>Flujo Parkcol</h2>
            </div>
            <span class="status-dot ok">En vivo</span>
          </div>

          <div class="selected-vehicle">
            <div>
              <span>Placa activa</span>
              <strong>${selected?.plate || '-'}</strong>
            </div>
            <div>
              <strong>${selected?.status || '-'}</strong>
            </div>
            <div>
              <span>Valor</span>
              <strong>${money.format(selected?.amount_due || 0)}</strong>
            </div>
          </div>

          <div class="action-grid">
            <button id="makeQr" class="action-card">
              <strong>Generar QR</strong>
              <span>Link de pago para ${selected?.plate || 'placa'}</span>
            </button>
            <button id="markPaid" class="action-card">
              <strong>Pago simulado</strong>
              <span>Actualiza estado compartido</span>
            </button>
            <button id="exitVehicle" class="action-card">
              <strong>Validar salida</strong>
              <span>Autoriza si ya está pagado</span>
            </button>
            <button id="runScenario" class="action-card">
              <strong>Escenario completo</strong>
              <span>Entrada + QR + pago + salida</span>
            </button>
          </div>

          <div class="qr-panel ${lastPaymentUrl ? 'active' : ''}">
            <div id="qrBox">${lastPaymentUrl ? `<img src="/api/payments/${selected?.payment_id}/qr" alt="QR de pago" />` : '<span>QR</span>'}</div>
            <div>
              <strong>${lastPaymentUrl ? 'QR generado' : 'Sin QR activo'}</strong>
              <p>${lastPaymentUrl ? `<a href="${lastPaymentUrl}" target="_blank">${lastPaymentUrl}</a>` : 'El QR abrirá una página real de pago simulado.'}</p>
            </div>
          </div>
        </div>
      </section>

      <section class="data-grid">
        <div class="table-panel">
          <div class="section-head compact">
            <h2>Vehículos</h2>
            <span>${plateList().length} registros</span>
          </div>
          <div class="vehicle-list">
            ${plateList().map(vehicleRow).join('')}
          </div>
        </div>
        <div class="table-panel">
          <div class="section-head compact">
            <h2>Mensualidades</h2>
            <span>2 placas / 1 dentro</span>
          </div>
          <div class="membership-list">
            ${(state.memberships || []).map((m) => `
              <button class="membership-row">
                <strong>${m.owner_name}</strong>
                <span>${(m.plates || []).join(' / ')}</span>
                <em>${m.status} hasta ${m.valid_until}</em>
              </button>
            `).join('')}
          </div>
        </div>
        <div class="table-panel">
          <div class="section-head compact">
            <h2>Bitácora</h2>
            <span>Últimos eventos</span>
          </div>
          <div class="event-list">
            ${(state.events || []).map((e) => `<div><span>${time(e.created_at)}</span><strong>${e.message}</strong></div>`).join('')}
          </div>
        </div>
      </section>
    </main>
  `;
  bindDashboard();
}

function metric(label, value, hint) {
  return `<article class="metric"><span>${label}</span><strong>${value}</strong><em>${hint}</em></article>`;
}

function vehicleRow(v) {
  return `
    <button class="vehicle-row ${v.plate === selectedPlate ? 'active' : ''}" data-plate="${v.plate}">
      <strong>${v.plate}</strong>
      <span>${v.vehicle_type} · ${v.color || '-'} · ${v.make || '-'}</span>
      <em>${v.status}</em>
      <b>${money.format(v.amount_due || 0)}</b>
    </button>
  `;
}

function time(value) {
  if (!value) return '--:--';
  return new Date(value).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}

function bindDashboard() {
  $('#refresh').onclick = refresh;
  $('#closeShift').onclick = closeShift;
  $('#startCamera').onclick = startCamera;
  $('#capture').onclick = () => detectCurrentFrame(false);
  $('#resumeDetection').onclick = resumeDetection;
  $('#simulate').onclick = simulateRead;
  $('#registerEntry').onclick = registerEntry;
  $('#makeQr').onclick = makeQr;
  $('#markPaid').onclick = markSelectedPaid;
  $('#exitVehicle').onclick = exitSelected;
  $('#runScenario').onclick = runScenario;
  document.querySelectorAll('.vehicle-row').forEach((btn) => {
    btn.onclick = () => {
      selectedPlate = btn.dataset.plate;
      lastPaymentUrl = '';
      renderDashboard();
    };
  });
  bootCameraElement();
}

async function bootCameraElement() {
  const video = $('#camera');
  if (video && stream) video.srcObject = stream;
}

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 30 }
      },
      audio: false
    });
    await tuneCameraTrack(stream);
    $('#camera').srcObject = stream;
    setResult('Detector activo en alta resolución. Buscando placa automáticamente...');
    $('#cameraStatus').textContent = 'Detector activo HD';
    $('#cameraStatus').classList.add('ok');
    startAutoDetect();
  } catch {
    setResult('No se pudo abrir cámara. Usa simulación o escribe la placa.');
  }
}

async function tuneCameraTrack(cameraStream) {
  const [track] = cameraStream.getVideoTracks();
  if (!track?.getCapabilities || !track.applyConstraints) return;
  const caps = track.getCapabilities();
  const advanced = [];
  if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
    advanced.push({ focusMode: 'continuous' });
  }
  if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes('continuous')) {
    advanced.push({ exposureMode: 'continuous' });
  }
  if (advanced.length) {
    await track.applyConstraints({ advanced }).catch(() => {});
  }
}

function captureFrame(silent = false) {
  const bundle = captureFrameBundle(silent);
  return bundle?.imageData || '';
}

function captureFrameBundle(silent = false) {
  const video = $('#camera');
  const canvas = $('#snapshot');
  if (!video.videoWidth) {
    if (!silent) setResult('Abre la cámara primero o usa simulación.');
    return null;
  }
  const images = DETECTION_CROPS.map((crop) => renderDetectionCrop(video, canvas, crop)).filter(Boolean);
  capturedImage = images[0]?.imageData || '';
  return { imageData: capturedImage, images };
}

function renderDetectionCrop(video, canvas, crop) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const sx = Math.max(0, Math.round(sourceWidth * crop.x));
  const sy = Math.max(0, Math.round(sourceHeight * crop.y));
  const sw = Math.min(sourceWidth - sx, Math.round(sourceWidth * crop.w));
  const sh = Math.min(sourceHeight - sy, Math.round(sourceHeight * crop.h));
  if (sw < 80 || sh < 60) return null;
  const aspect = sw / sh;
  const targetWidth = Math.min(crop.targetWidth, Math.max(sw, 960));
  const targetHeight = Math.round(targetWidth / aspect);
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.filter = crop.enhance ? 'grayscale(1) contrast(1.45) brightness(1.08)' : 'none';
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
  ctx.filter = 'none';
  return {
    id: crop.id,
    source: { x: crop.x, y: crop.y, w: crop.w, h: crop.h },
    imageData: canvas.toDataURL('image/jpeg', crop.quality)
  };
}

function startAutoDetect() {
  if (autoDetectTimer) clearInterval(autoDetectTimer);
  if (detectionLocked) return;
  setTimeout(() => detectCurrentFrame(true), 900);
  autoDetectTimer = setInterval(() => detectCurrentFrame(true), 3200);
}

async function detectCurrentFrame(auto = false) {
  if (detectionLocked) {
    if (!auto) setResult('Lectura bloqueada. Toca "Seguir detectando" para buscar otra placa.');
    return;
  }
  if (detecting) return;
  const frame = captureFrameBundle(true);
  if (!frame?.imageData) return;
  detecting = true;
  if (!auto) setResult('Analizando placa con OCR visual...');
  try {
    const detected = await api('/api/detect', {
      method: 'POST',
      body: JSON.stringify(frame)
    });
    applyDetection(detected, auto);
  } catch (err) {
    const reason = err?.data?.message || err?.message || 'error';
    if (!auto) setResult(`No pude detectar la placa en esta toma (${reason}).`);
  } finally {
    detecting = false;
  }
}

function applyDetection(detected, auto) {
  if (!detected?.plate) {
    if (!auto) setResult('No hay placa clara en cámara.');
    return;
  }
  const plateInput = $('#plateInput');
  const typeInput = $('#typeInput');
  const serviceInput = $('#serviceInput');
  plateInput.value = detected.plate;
  typeInput.value = detected.type || 'Por confirmar';
  if (detected.source === 'openai_vision' && detected.confidence >= 0.78) {
    serviceInput.value = serviceInput.value || 'Horas';
  }
  const pct = Math.round(Number(detected.confidence || 0) * 100);
  const makeLabel = detected.make
    ? `${detected.make}${detected.make_source === 'logo' ? ' (logo)' : detected.make_source === 'text' ? ' (texto)' : ''}`
    : null;
  const details = [detected.type, detected.color, makeLabel].filter(Boolean).join(' · ');
  const changed = lastDetectedPlate !== detected.plate;
  lastDetectedPlate = detected.plate;
  lockDetection();
  if (changed || !auto) {
    setResult(`Lectura bloqueada: ${detected.plate} (${pct}%). ${details || 'Tipo/color/marca por confirmar.'}`);
  }
}

function lockDetection() {
  detectionLocked = true;
  if (autoDetectTimer) clearInterval(autoDetectTimer);
  autoDetectTimer = null;
  const status = $('#cameraStatus');
  if (status) status.textContent = 'Lectura bloqueada';
}

function resumeDetection() {
  detectionLocked = false;
  lastDetectedPlate = '';
  const status = $('#cameraStatus');
  if (status && stream) status.textContent = 'Detector activo HD';
  setResult('Detector activo. Buscando otra placa...');
  startAutoDetect();
}

function simulateRead() {
  const samples = ['KLM428', 'RFT21E', 'MBO739', 'VNS84F', 'JQX615', 'TUP33G'];
  $('#plateInput').value = samples[Math.floor(Math.random() * samples.length)];
  lockDetection();
  setResult('Lectura simulada con formato colombiano.');
}

async function registerEntry() {
  const plate = $('#plateInput').value.trim().toUpperCase();
  const type = $('#typeInput').value;
  const service = $('#serviceInput').value;
  const result = await api('/api/scan', {
    method: 'POST',
    body: JSON.stringify({ plate, type, service, imageData: capturedImage })
  });
  selectedPlate = result.vehicle.plate;
  lastPaymentUrl = result.payment_url;
  await refresh(false);
  setResult(`${result.vehicle.plate} registrado. Confianza ${(Number(result.vehicle.confidence || 0) * 100).toFixed(0)}%.`);
}

async function makeQr() {
  const selected = plateList().find((v) => v.plate === selectedPlate);
  if (!selected) return;
  lastPaymentUrl = `${location.origin}/pagar/${selected.payment_id}`;
  renderDashboard();
}

async function markSelectedPaid() {
  const selected = plateList().find((v) => v.plate === selectedPlate);
  if (!selected?.payment_id) return;
  await api(`/api/payments/${selected.payment_id}/pay`, { method: 'POST', body: '{}' });
  await refresh(false);
}

async function exitSelected() {
  try {
    await api('/api/exit', { method: 'POST', body: JSON.stringify({ plate: selectedPlate }) });
    await refresh(false);
  } catch (err) {
    setResult(err.data?.reason === 'payment_pending' ? 'Salida bloqueada: pago pendiente.' : 'No hay vehículo dentro con esa placa.');
  }
}

async function closeShift() {
  await api('/api/closures', { method: 'POST', body: JSON.stringify({ shift: 'TURNO02' }) });
  await refresh(false);
}

async function runScenario() {
  $('#plateInput').value = 'KLM428';
  await registerEntry();
  await makeQr();
  await markSelectedPaid();
  await exitSelected();
}

async function refresh(render = true) {
  await loadState();
  if (render) renderDashboard();
}

function setResult(text) {
  const el = $('#resultLine');
  if (el) el.textContent = text;
}

async function renderPaymentPage(paymentId) {
  let data;
  try {
    data = await api(`/api/payment-page/${paymentId}`);
  } catch {
    app.innerHTML = `<main class="payment-page"><section><h1>Pago no encontrado</h1><a href="/">Volver</a></section></main>`;
    return;
  }
  const { payment, vehicle } = data;
  app.innerHTML = `
    <main class="payment-page">
      <section class="payment-box">
        <div class="brand center"><div class="brand-mark">P</div><strong>Parkcol Pago</strong></div>
        <span class="eyebrow">Pago autoservicio</span>
        <h1>${vehicle?.plate || payment.plate}</h1>
        <p>${vehicle?.vehicle_type || 'Vehículo'} · ${vehicle?.service_type || 'Horas'} · ${vehicle?.color || ''}</p>
        <div class="pay-amount">${money.format(payment.amount || 0)}</div>
        <div class="payment-status ${payment.status}">${payment.status === 'paid' ? 'Pagado' : 'Pendiente'}</div>
        <button class="primary full" id="payNow" ${payment.status === 'paid' ? 'disabled' : ''}>Pagar ahora</button>
        <a class="ghost-link" href="/">Volver al control</a>
      </section>
    </main>
  `;
  $('#payNow')?.addEventListener('click', async () => {
    await api(`/api/payments/${paymentId}/pay`, { method: 'POST', body: '{}' });
    renderPaymentPage(paymentId);
  });
}

await loadState();
renderShell();
