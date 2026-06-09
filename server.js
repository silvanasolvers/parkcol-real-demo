import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import QRCode from 'qrcode';
import pg from 'pg';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const DATABASE_URL = process.env.DATABASE_URL || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const demoPlates = [
  { plate: 'KLM428', type: 'Carro', color: 'Gris plata', make: 'Renault', service: 'Horas', owner: 'Visitante' },
  { plate: 'RFT21E', type: 'Moto', color: 'Negra', make: 'Yamaha', service: 'Horas', owner: 'Visitante' },
  { plate: 'MBO739', type: 'Carro', color: 'Blanco', make: 'Chevrolet', service: 'Valet', owner: 'Valet Parkcol' },
  { plate: 'VNS84F', type: 'Moto', color: 'Roja', make: 'AKT', service: 'Amanecida', owner: 'Visitante' },
  { plate: 'JQX615', type: 'Carro', color: 'Azul oscuro', make: 'Mazda', service: 'Mensualidad', owner: 'Laura Restrepo' },
  { plate: 'TUP33G', type: 'Moto', color: 'Blanca', make: 'Honda', service: 'Mensualidad', owner: 'Andres Velez' }
];

const tariffs = {
  Carro: { hourly: 6000, dayCap: 36000, overnight: 28000, valet: 18000 },
  Moto: { hourly: 3000, dayCap: 18000, overnight: 15000, valet: 0 }
};

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function entryAmount(vehicle) {
  if (vehicle.service === 'Mensualidad') return 0;
  if (vehicle.service === 'Amanecida') return tariffs[vehicle.type]?.overnight || 12000;
  if (vehicle.service === 'Valet') return tariffs[vehicle.type]?.valet || 18000;
  return tariffs[vehicle.type]?.hourly || 4000;
}

function normalizePlate(value = '') {
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function plateLooksColombian(plate) {
  return /^[A-Z]{3}\d{3}$/.test(plate) || /^[A-Z]{3}\d{2}[A-Z]$/.test(plate);
}

class MemoryStore {
  constructor() {
    this.vehicles = [];
    this.payments = [];
    this.events = [];
    this.closures = [];
    this.memberships = [];
  }

  async init() {
    if (this.vehicles.length) return;
    this.memberships = [
      { id: 'mem_001', owner_name: 'Laura Restrepo', plates: ['JQX615', 'LAR902'], status: 'active', valid_until: '2026-07-31' },
      { id: 'mem_002', owner_name: 'Andres Velez', plates: ['TUP33G', 'AVK12H'], status: 'active', valid_until: '2026-07-15' }
    ];
    for (const seed of demoPlates.slice(0, 4)) {
      await this.createEntry({ ...seed, confidence: seed.type === 'Moto' ? 0.88 : 0.94, source: 'seed' });
    }
    const firstPaid = this.vehicles[0];
    if (firstPaid) await this.markPaid(firstPaid.payment_id);
    this.events.unshift({ id: id('evt'), event_type: 'system', message: 'Turno 02 abierto en caja principal', created_at: nowIso(), metadata: {} });
  }

  async state() {
    return {
      mode: 'memory',
      vehicles: this.vehicles,
      payments: this.payments,
      closures: this.closures,
      memberships: this.memberships,
      events: this.events.slice(0, 30),
      tariffs
    };
  }

  async createEntry(input) {
    const plate = normalizePlate(input.plate) || this.nextPlate();
    const membership = this.memberships.find((m) => m.plates.includes(plate));
    const existingInsideForMembership = membership
      ? this.vehicles.find((v) => v.inside && v.membership_id === membership.id && v.plate !== plate)
      : null;
    const service = membership ? 'Mensualidad' : (input.service || 'Horas');
    const amount = entryAmount({ type: input.type || 'Carro', service });
    const vehicle = {
      id: id('veh'),
      plate,
      vehicle_type: input.type || 'Carro',
      color: input.color || 'Gris plata',
      make: input.make || 'Marca probable',
      service_type: service,
      owner_name: membership?.owner_name || input.owner || 'Visitante',
      membership_id: membership?.id || null,
      status: existingInsideForMembership ? 'Bloqueado por mensualidad' : (amount === 0 ? 'Mensualidad activa' : 'Dentro / pago pendiente'),
      inside: !existingInsideForMembership,
      paid: amount === 0,
      entry_at: nowIso(),
      exit_at: null,
      amount_due: amount,
      confidence: input.confidence ?? 0.91,
      image_data: input.imageData || null,
      metadata: input.metadata || {}
    };
    const payment = {
      id: id('pay'),
      vehicle_id: vehicle.id,
      plate,
      amount,
      status: amount === 0 ? 'paid' : 'pending',
      paid_at: amount === 0 ? nowIso() : null,
      created_at: nowIso()
    };
    vehicle.payment_id = payment.id;
    this.vehicles.unshift(vehicle);
    this.payments.unshift(payment);
    this.events.unshift({
      id: id('evt'),
      vehicle_id: vehicle.id,
      event_type: 'entry',
      message: existingInsideForMembership
        ? `${plate} requiere validacion: mensualidad ya tiene otro vehiculo dentro`
        : `${plate} ingreso como ${service}`,
      created_at: nowIso(),
      metadata: { confidence: vehicle.confidence, source: input.source || 'camera' }
    });
    return { vehicle, payment };
  }

  nextPlate() {
    const used = new Set(this.vehicles.map((v) => v.plate));
    return demoPlates.find((p) => !used.has(p.plate))?.plate || `ABC${Math.floor(100 + Math.random() * 899)}`;
  }

  async markPaid(paymentId) {
    const payment = this.payments.find((p) => p.id === paymentId);
    if (!payment) return null;
    payment.status = 'paid';
    payment.paid_at = nowIso();
    const vehicle = this.vehicles.find((v) => v.id === payment.vehicle_id);
    if (vehicle) {
      vehicle.paid = true;
      vehicle.status = vehicle.inside ? 'Pagado / listo para salir' : 'Pagado';
      this.events.unshift({ id: id('evt'), vehicle_id: vehicle.id, event_type: 'payment', message: `${vehicle.plate} pago confirmado`, created_at: nowIso(), metadata: { amount: payment.amount } });
    }
    return { payment, vehicle };
  }

  async authorizeExit(plate) {
    const normalized = normalizePlate(plate);
    const vehicle = this.vehicles.find((v) => v.plate === normalized && v.inside);
    if (!vehicle) return { ok: false, reason: 'not_inside' };
    if (!vehicle.paid) return { ok: false, reason: 'payment_pending', vehicle };
    vehicle.inside = false;
    vehicle.exit_at = nowIso();
    vehicle.status = 'Salida autorizada';
    this.events.unshift({ id: id('evt'), vehicle_id: vehicle.id, event_type: 'exit', message: `${vehicle.plate} salida autorizada`, created_at: nowIso(), metadata: {} });
    return { ok: true, vehicle };
  }

  async closeShift(shift = 'TURNO02') {
    const paid = this.payments.filter((p) => p.status === 'paid');
    const digital_amount = paid.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const cash_amount = 135000;
    const closure = { id: id('cls'), shift, cash_amount, digital_amount, total_amount: cash_amount + digital_amount, differences: 0, created_at: nowIso() };
    this.closures.unshift(closure);
    this.events.unshift({ id: id('evt'), event_type: 'closure', message: `${shift} cerrado y enviado al celular`, created_at: nowIso(), metadata: closure });
    return closure;
  }
}

class PostgresStore extends MemoryStore {
  constructor(databaseUrl) {
    super();
    this.pool = new Pool({ connectionString: databaseUrl, ssl: databaseUrl.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined });
  }

  async init() {
    await this.pool.query(`
      create table if not exists memberships (
        id text primary key,
        owner_name text not null,
        plates text[] not null,
        status text not null,
        valid_until date
      );
      create table if not exists vehicles (
        id text primary key,
        plate text not null,
        vehicle_type text not null,
        color text,
        make text,
        service_type text,
        owner_name text,
        membership_id text,
        status text,
        inside boolean default true,
        paid boolean default false,
        entry_at timestamptz default now(),
        exit_at timestamptz,
        amount_due integer default 0,
        confidence numeric,
        image_data text,
        metadata jsonb default '{}'::jsonb,
        payment_id text
      );
      create table if not exists payments (
        id text primary key,
        vehicle_id text,
        plate text not null,
        amount integer default 0,
        status text default 'pending',
        paid_at timestamptz,
        created_at timestamptz default now()
      );
      create table if not exists events (
        id text primary key,
        vehicle_id text,
        event_type text not null,
        message text not null,
        created_at timestamptz default now(),
        metadata jsonb default '{}'::jsonb
      );
      create table if not exists cash_closures (
        id text primary key,
        shift text not null,
        cash_amount integer default 0,
        digital_amount integer default 0,
        total_amount integer default 0,
        differences integer default 0,
        created_at timestamptz default now()
      );
    `);
    const count = await this.pool.query('select count(*)::int as count from vehicles');
    if (count.rows[0].count === 0) {
      await this.seedPostgres();
    }
  }

  async seedPostgres() {
    await this.pool.query(
      `insert into memberships (id, owner_name, plates, status, valid_until)
       values ($1,$2,$3,$4,$5), ($6,$7,$8,$9,$10)
       on conflict (id) do nothing`,
      ['mem_001', 'Laura Restrepo', ['JQX615', 'LAR902'], 'active', '2026-07-31', 'mem_002', 'Andres Velez', ['TUP33G', 'AVK12H'], 'active', '2026-07-15']
    );
    for (const seed of demoPlates.slice(0, 4)) {
      await this.createEntry({ ...seed, confidence: seed.type === 'Moto' ? 0.88 : 0.94, source: 'seed' });
    }
    const first = await this.pool.query('select payment_id from vehicles order by entry_at desc limit 1');
    if (first.rows[0]?.payment_id) await this.markPaid(first.rows[0].payment_id);
  }

  async state() {
    const [vehicles, payments, closures, memberships, events] = await Promise.all([
      this.pool.query('select * from vehicles order by entry_at desc limit 100'),
      this.pool.query('select * from payments order by created_at desc limit 100'),
      this.pool.query('select * from cash_closures order by created_at desc limit 20'),
      this.pool.query('select * from memberships order by owner_name asc'),
      this.pool.query('select * from events order by created_at desc limit 30')
    ]);
    return { mode: 'postgres', vehicles: vehicles.rows, payments: payments.rows, closures: closures.rows, memberships: memberships.rows, events: events.rows, tariffs };
  }

  async createEntry(input) {
    const plate = normalizePlate(input.plate) || demoPlates[Math.floor(Math.random() * demoPlates.length)].plate;
    const member = await this.pool.query('select * from memberships where $1 = any(plates) and status = $2 limit 1', [plate, 'active']);
    const membership = member.rows[0];
    const insideMember = membership
      ? await this.pool.query('select * from vehicles where inside = true and membership_id = $1 and plate <> $2 limit 1', [membership.id, plate])
      : { rows: [] };
    const service = membership ? 'Mensualidad' : (input.service || 'Horas');
    const amount = entryAmount({ type: input.type || 'Carro', service });
    const blocked = insideMember.rows.length > 0;
    const vehicleId = id('veh');
    const paymentId = id('pay');
    const vehicle = {
      id: vehicleId,
      plate,
      vehicle_type: input.type || 'Carro',
      color: input.color || 'Gris plata',
      make: input.make || 'Marca probable',
      service_type: service,
      owner_name: membership?.owner_name || input.owner || 'Visitante',
      membership_id: membership?.id || null,
      status: blocked ? 'Bloqueado por mensualidad' : (amount === 0 ? 'Mensualidad activa' : 'Dentro / pago pendiente'),
      inside: !blocked,
      paid: amount === 0,
      amount_due: amount,
      confidence: input.confidence ?? 0.91,
      image_data: input.imageData || null,
      metadata: input.metadata || {},
      payment_id: paymentId
    };
    await this.pool.query(
      `insert into vehicles (id, plate, vehicle_type, color, make, service_type, owner_name, membership_id, status, inside, paid, amount_due, confidence, image_data, metadata, payment_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [vehicle.id, vehicle.plate, vehicle.vehicle_type, vehicle.color, vehicle.make, vehicle.service_type, vehicle.owner_name, vehicle.membership_id, vehicle.status, vehicle.inside, vehicle.paid, vehicle.amount_due, vehicle.confidence, vehicle.image_data, vehicle.metadata, vehicle.payment_id]
    );
    await this.pool.query(
      `insert into payments (id, vehicle_id, plate, amount, status, paid_at)
       values ($1,$2,$3,$4,$5,$6)`,
      [paymentId, vehicleId, plate, amount, amount === 0 ? 'paid' : 'pending', amount === 0 ? new Date() : null]
    );
    await this.pool.query('insert into events (id, vehicle_id, event_type, message, metadata) values ($1,$2,$3,$4,$5)', [
      id('evt'),
      vehicleId,
      'entry',
      blocked ? `${plate} requiere validacion: mensualidad ya tiene otro vehiculo dentro` : `${plate} ingreso como ${service}`,
      { confidence: vehicle.confidence, source: input.source || 'camera' }
    ]);
    return { vehicle, payment: { id: paymentId, vehicle_id: vehicleId, plate, amount, status: amount === 0 ? 'paid' : 'pending' } };
  }

  async markPaid(paymentId) {
    const pay = await this.pool.query('update payments set status = $2, paid_at = now() where id = $1 returning *', [paymentId, 'paid']);
    const payment = pay.rows[0];
    if (!payment) return null;
    const veh = await this.pool.query('update vehicles set paid = true, status = case when inside then $2 else $3 end where id = $1 returning *', [payment.vehicle_id, 'Pagado / listo para salir', 'Pagado']);
    const vehicle = veh.rows[0];
    await this.pool.query('insert into events (id, vehicle_id, event_type, message, metadata) values ($1,$2,$3,$4,$5)', [id('evt'), vehicle.id, 'payment', `${vehicle.plate} pago confirmado`, { amount: payment.amount }]);
    return { payment, vehicle };
  }

  async authorizeExit(plate) {
    const found = await this.pool.query('select * from vehicles where plate = $1 and inside = true order by entry_at desc limit 1', [normalizePlate(plate)]);
    const vehicle = found.rows[0];
    if (!vehicle) return { ok: false, reason: 'not_inside' };
    if (!vehicle.paid) return { ok: false, reason: 'payment_pending', vehicle };
    const updated = await this.pool.query('update vehicles set inside = false, exit_at = now(), status = $2 where id = $1 returning *', [vehicle.id, 'Salida autorizada']);
    await this.pool.query('insert into events (id, vehicle_id, event_type, message, metadata) values ($1,$2,$3,$4,$5)', [id('evt'), vehicle.id, 'exit', `${vehicle.plate} salida autorizada`, {}]);
    return { ok: true, vehicle: updated.rows[0] };
  }

  async closeShift(shift = 'TURNO02') {
    const paid = await this.pool.query("select coalesce(sum(amount),0)::int as total from payments where status = 'paid'");
    const digitalAmount = Number(paid.rows[0].total || 0);
    const cashAmount = 135000;
    const closure = { id: id('cls'), shift, cash_amount: cashAmount, digital_amount: digitalAmount, total_amount: cashAmount + digitalAmount, differences: 0 };
    const inserted = await this.pool.query('insert into cash_closures (id, shift, cash_amount, digital_amount, total_amount, differences) values ($1,$2,$3,$4,$5,$6) returning *', [closure.id, closure.shift, closure.cash_amount, closure.digital_amount, closure.total_amount, closure.differences]);
    await this.pool.query('insert into events (id, event_type, message, metadata) values ($1,$2,$3,$4)', [id('evt'), 'closure', `${shift} cerrado y enviado al celular`, inserted.rows[0]]);
    return inserted.rows[0];
  }
}

const store = DATABASE_URL ? new PostgresStore(DATABASE_URL) : new MemoryStore();

async function analyzeWithOpenAI(imageData) {
  if (!process.env.OPENAI_API_KEY || !imageData?.startsWith('data:image')) return null;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [{
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              'Eres un detector ALPR para un demo de parqueadero en Colombia.',
              'Lee la placa visible del vehículo y detecta tipo, color y marca probable.',
              'Devuelve SOLO JSON valido sin markdown con estas llaves exactas:',
              '{"plate": string|null, "type": "Carro"|"Moto"|null, "color": string|null, "make": string|null, "confidence": number}',
              'Usa formatos colombianos: carros ABC123, motos ABC12D. Si no ves una placa clara, plate debe ser null y confidence menor a 0.55.'
            ].join(' ')
          },
          { type: 'input_image', image_url: imageData }
        ]
      }]
    })
  });
  if (!response.ok) throw new Error(`OpenAI ${response.status}`);
  const data = await response.json();
  const text = data.output_text || data.output?.flatMap((o) => o.content || []).map((c) => c.text).join('') || '';
  try {
    return JSON.parse(text.replace(/^```json|```$/g, '').trim());
  } catch {
    return null;
  }
}

function normalizeVehicleType(value) {
  if (/moto/i.test(value || '')) return 'Moto';
  if (/carro|auto|camioneta|vehiculo/i.test(value || '')) return 'Carro';
  return null;
}

function cleanDetectedText(value) {
  const text = String(value || '').trim();
  if (!text || /^null|unknown|desconoc/i.test(text)) return null;
  return text.slice(0, 40);
}

function buildDetectedVehicle(detected, fallback = null) {
  const hasImageDetection = Boolean(detected?.plate);
  const finalPlate = normalizePlate(detected?.plate || fallback?.plate || '');
  const confidence = Math.max(0, Math.min(1, Number(detected?.confidence) || (hasImageDetection ? 0.68 : 0)));
  return {
    plate: finalPlate || null,
    type: normalizeVehicleType(detected?.type) || fallback?.type || null,
    color: cleanDetectedText(detected?.color) || fallback?.color || null,
    make: cleanDetectedText(detected?.make) || fallback?.make || null,
    confidence,
    plate_format_ok: finalPlate ? plateLooksColombian(finalPlate) : false,
    source: hasImageDetection ? 'openai_vision' : (fallback ? 'demo_fallback' : 'no_detection')
  };
}

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, mode: DATABASE_URL ? 'postgres' : 'memory' });
});

app.get('/api/state', async (_req, res) => {
  res.json(await store.state());
});

app.post('/api/detect', async (req, res) => {
  const { imageData } = req.body || {};
  let detected = null;
  try {
    detected = await analyzeWithOpenAI(imageData);
  } catch (err) {
    detected = null;
  }
  res.json(buildDetectedVehicle(detected));
});

app.post('/api/scan', async (req, res) => {
  const { imageData, plate, type, service } = req.body || {};
  let detected = null;
  try {
    detected = plate ? null : await analyzeWithOpenAI(imageData);
  } catch (err) {
    detected = null;
  }
  const fallback = demoPlates[Math.floor(Math.random() * demoPlates.length)];
  const ai = buildDetectedVehicle(detected, plate ? null : fallback);
  const finalPlate = normalizePlate(plate || ai.plate || fallback.plate);
  const input = {
    plate: finalPlate,
    type: type || ai.type || 'Carro',
    color: ai.color || 'Por confirmar',
    make: ai.make || 'Por confirmar',
    service: service || fallback.service,
    owner: fallback.owner,
    confidence: plate ? 0.99 : ai.confidence,
    imageData,
    source: detected ? 'openai_vision' : (plate ? 'operator_confirmed' : 'demo_detection'),
    metadata: { detected, plate_format_ok: plateLooksColombian(finalPlate) }
  };
  const result = await store.createEntry(input);
  res.json({ ...result, plate_format_ok: plateLooksColombian(finalPlate), payment_url: `${PUBLIC_BASE_URL}/pagar/${result.payment.id}` });
});

app.post('/api/payments/:id/pay', async (req, res) => {
  const result = await store.markPaid(req.params.id);
  if (!result) return res.status(404).json({ error: 'payment_not_found' });
  res.json(result);
});

app.get('/api/payments/:id/qr', async (req, res) => {
  const url = `${PUBLIC_BASE_URL}/pagar/${req.params.id}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#0d2a52', light: '#ffffff' } });
  res.type('image/svg+xml').send(svg);
});

app.post('/api/exit', async (req, res) => {
  const result = await store.authorizeExit(req.body?.plate);
  res.status(result.ok ? 200 : 409).json(result);
});

app.post('/api/closures', async (req, res) => {
  res.json(await store.closeShift(req.body?.shift || 'TURNO02'));
});

app.get('/api/payment-page/:id', async (req, res) => {
  const state = await store.state();
  const payment = state.payments.find((p) => p.id === req.params.id);
  const vehicle = payment ? state.vehicles.find((v) => v.id === payment.vehicle_id) : null;
  if (!payment) return res.status(404).json({ error: 'payment_not_found' });
  res.json({ payment, vehicle });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

store.init()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Parkcol real demo running on ${PORT} (${DATABASE_URL ? 'postgres' : 'memory'})`);
    });
  })
  .catch((err) => {
    console.error('Failed to start Parkcol demo:', err);
    process.exit(1);
  });
