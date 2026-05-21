const express = require('express');
const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1); // trust Render's proxy for real IP
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 10000;

// Serve background images for overlays
app.get('/velho-oeste.png', (req, res) => res.sendFile(__dirname + '/velho-oeste.png'));
app.get('/crown.svg', (req, res) => res.sendFile(__dirname + '/crown.svg'));
app.get('/jar.png', (req, res) => res.sendFile(__dirname + '/jar.png'));
app.get('/jar-new.jpg', (req, res) => res.sendFile(__dirname + '/jar-new.jpg'));

// ── Image proxy (para avatares TikTok no OBS) ──
app.get('/img-proxy', (req, res) => {
  const url = decodeURIComponent(req.query.url || '');
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) { res.status(400).end(); return; }
  const mod = url.startsWith('https://') ? https : http;
  const proxyReq = mod.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.tiktok.com/',
      'Origin': 'https://www.tiktok.com'
    }
  }, (response) => {
    res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    response.pipe(res);
  });
  proxyReq.on('error', () => { if (!res.headersSent) res.status(502).end(); });
  proxyReq.setTimeout(6000, () => { proxyReq.destroy(); if (!res.headersSent) res.status(504).end(); });
});
app.get('/jar-glass.png', (req, res) => res.sendFile(__dirname + '/jar-glass.png'));

// ============================================
// ACCOUNTS SYSTEM (MongoDB + file fallback)
// ============================================
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
let accounts = {};           // in-memory cache
let accountsCol = null;      // MongoDB collection (null = use file)
let roomsCol = null;         // MongoDB collection for room state (combo carousel, etc.)
const persistedRooms = {};   // cache: roomId → persisted state from Mongo

// Load from file as initial cache / fallback
try { accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8')); } catch(e) { accounts = {}; }

function saveAccountsFile() {
  try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2)); } catch(e) {}
}

// MongoDB setup (only if MONGO_URI env var is set)
async function connectMongo() {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.log('[DB] No MONGO_URI — using file storage (not persistent on Render)'); return; }
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db('livestream');
    accountsCol = db.collection('accounts');
    // Load all accounts into memory cache
    const docs = await accountsCol.find({}).toArray();
    docs.forEach(doc => { accounts[doc._id] = doc; });

    // Load persisted room state (combo carousel, etc.)
    roomsCol = db.collection('rooms');
    const roomDocs = await roomsCol.find({}).toArray();
    roomDocs.forEach(doc => { persistedRooms[doc._id] = doc; });
    console.log(`[DB] MongoDB connected — ${docs.length} account(s), ${roomDocs.length} room(s) loaded`);
  } catch(e) {
    console.error('[DB] MongoDB connection failed, using file fallback:', e.message);
    accountsCol = null;
  }
}

async function saveAccount(key, data) {
  accounts[key] = data;
  if (accountsCol) {
    try { await accountsCol.replaceOne({ _id: key }, { _id: key, ...data }, { upsert: true }); }
    catch(e) { console.error('[DB] saveAccount error:', e.message); saveAccountsFile(); }
  } else {
    saveAccountsFile();
  }
}

async function getAccount(key) {
  return accounts[key] || null;
}

// Persiste estado específico de sala no Mongo (com debounce por sala+chave)
const _persistTimers = {};
function persistRoomState(roomId, key, value) {
  if (!roomsCol) return;
  const t = `${roomId}_${key}`;
  if (_persistTimers[t]) clearTimeout(_persistTimers[t]);
  _persistTimers[t] = setTimeout(async () => {
    try {
      const update = { [key]: value, updatedAt: Date.now() };
      await roomsCol.updateOne(
        { _id: roomId },
        { $set: update },
        { upsert: true }
      );
      if (!persistedRooms[roomId]) persistedRooms[roomId] = { _id: roomId };
      persistedRooms[roomId][key] = value;
    } catch(e) {
      console.error('[DB] persistRoomState error:', e.message);
    }
  }, 800); // debounce 800ms para evitar muitas escritas
}

function hashPass(password, salt) {
  return crypto.createHash('sha256').update(salt + password + 'LSI_SALT_2025').digest('hex');
}

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Subscription status helper
function getSubscriptionStatus(acc) {
  const now = Date.now();
  if (acc.subscription === 'active' && acc.subscriptionEnd && acc.subscriptionEnd > now) return 'active';
  if (acc.subscription === 'trial' && acc.trialEnds && acc.trialEnds > now) return 'trial';
  if (acc.subscription === 'pending_payment') return 'pending_payment'; // needs card setup
  // Legacy accounts without subscriptionEnd (treat as active)
  if (acc.subscription === 'active' && !acc.subscriptionEnd && !acc.trialEnds) return 'active';
  return 'expired';
}

// Get real IP from request
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return (forwarded ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress) || 'unknown';
}

// Register
app.post('/api/register', express.json(), async (req, res) => {
  const { username, password, email, hwid } = req.body || {};
  if (!username || !password || !email) return res.json({ ok: false, error: 'Preencha todos os campos' });
  if (username.trim().length < 3) return res.json({ ok: false, error: 'Nome de usuário deve ter pelo menos 3 caracteres' });
  if (password.length < 6) return res.json({ ok: false, error: 'Senha deve ter pelo menos 6 caracteres' });
  if (!email.includes('@')) return res.json({ ok: false, error: 'Email inválido' });
  const key = username.toLowerCase().trim();
  if (await getAccount(key)) return res.json({ ok: false, error: 'Nome de usuário já está em uso' });
  const emailUsed = Object.values(accounts).find(a => a.email && a.email.toLowerCase() === email.toLowerCase().trim());
  if (emailUsed) return res.json({ ok: false, error: 'Email já cadastrado em outra conta' });

  // ── Triplo bloqueio: HWID > IP > Email ──
  const clientIp = getClientIp(req);
  const hwidUsedTrial = hwid && Object.values(accounts).find(a => a.hwid === hwid && (a.trialEnds || a.subscription === 'active'));
  const ipUsedTrial = !hwidUsedTrial && Object.values(accounts).find(a => a.registrationIp === clientIp && (a.trialEnds || a.subscription === 'active'));
  const skipTrial = !!(hwidUsedTrial || ipUsedTrial);
  const blockReason = hwidUsedTrial ? 'hwid' : (ipUsedTrial ? 'ip' : null);

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPass(password, salt);
  const token = makeToken();

  // Se HWID ou IP já usou trial → conta nasce 'expired', precisa pagar pra usar
  const subscription = skipTrial ? 'expired' : 'pending_payment';
  const data = {
    username: username.trim(), email: email.toLowerCase().trim(),
    hash, salt, token, createdAt: Date.now(), lastLogin: Date.now(),
    subscription, registrationIp: clientIp, hwid: hwid || ''
  };
  await saveAccount(key, data);
  console.log(`[Register] ${key} | IP: ${clientIp} | HWID: ${(hwid || '').substring(0,12)}... | skipTrial: ${skipTrial}${blockReason ? ' (block: ' + blockReason + ')' : ''}`);
  res.json({ ok: true, token, username: username.trim(), subscription, needsPaymentSetup: !skipTrial });
});

// Login
app.post('/api/login', express.json(), async (req, res) => {
  const { username, password, hwid } = req.body || {};
  const key = (username || '').toLowerCase().trim();
  const acc = await getAccount(key);
  if (!acc) return res.json({ ok: false, error: 'Usuário não encontrado' });
  if (hashPass(password, acc.salt) !== acc.hash) return res.json({ ok: false, error: 'Senha incorreta' });
  acc.token = makeToken();
  acc.lastLogin = Date.now();
  if (hwid && !acc.hwid) acc.hwid = hwid; // salva HWID na primeira vez que logar com app atualizado
  await saveAccount(key, acc);
  const status = getSubscriptionStatus(acc);
  res.json({ ok: true, token: acc.token, username: acc.username, email: acc.email, subscription: status, trialEnds: acc.trialEnds, subscriptionEnd: acc.subscriptionEnd, createdAt: acc.createdAt });
});

// Validate token (auto-login)
app.post('/api/validate-token', express.json(), async (req, res) => {
  const { username, token } = req.body || {};
  const key = (username || '').toLowerCase().trim();
  const acc = await getAccount(key);
  if (!acc || acc.token !== token) return res.json({ ok: false, error: 'Sessão expirada' });
  const status = getSubscriptionStatus(acc);
  res.json({ ok: true, username: acc.username, email: acc.email, subscription: status, trialEnds: acc.trialEnds, subscriptionEnd: acc.subscriptionEnd, createdAt: acc.createdAt });
});

// Health check endpoint
app.get('/', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), rooms: Object.keys(rooms).length }));

const ADMIN_SECRET = 'LSI_ADMIN_2025_Gabriel'; // chave secreta do admin

// Admin: list all usernames (no passwords)
app.get('/api/admin/accounts', (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Acesso negado' });
  const list = Object.values(accounts).map(a => ({
    username: a.username,
    email: a.email || '',
    registrationIp: a.registrationIp || '',
    hwid: a.hwid ? (a.hwid.substring(0, 12) + '...') : '',
    createdAt: new Date(a.createdAt).toISOString(),
    lastLogin: new Date(a.lastLogin).toISOString(),
    subscription: a.subscription,
    trialEnds: a.trialEnds ? new Date(a.trialEnds).toISOString() : null,
    subscriptionEnd: a.subscriptionEnd ? new Date(a.subscriptionEnd).toISOString() : null
  }));
  res.json({ total: list.length, accounts: list });
});

// Admin: reset subscription (for testing)
app.get('/api/admin/reset-subscription', async (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Acesso negado' });
  const { username, status } = req.query;
  if (!username) return res.json({ ok: false, error: 'Informe username' });
  const key = username.toLowerCase().trim();
  const acc = await getAccount(key);
  if (!acc) return res.json({ ok: false, error: 'Usuário não encontrado' });
  const newStatus = status || 'pending_payment';
  acc.subscription = newStatus;
  delete acc.subscriptionEnd;
  delete acc.trialEnds;
  delete acc.mpSubscriptionId;
  await saveAccount(key, acc);
  res.json({ ok: true, message: `Subscription de "${acc.username}" resetada para "${newStatus}"` });
});

// Admin: reset password
app.get('/api/admin/reset-password', async (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Acesso negado' });
  const { username, newpassword } = req.query;
  if (!username || !newpassword) return res.json({ ok: false, error: 'Informe username e newpassword' });
  if (newpassword.length < 6) return res.json({ ok: false, error: 'Senha precisa ter pelo menos 6 caracteres' });
  const key = username.toLowerCase().trim();
  const acc = await getAccount(key);
  if (!acc) return res.json({ ok: false, error: 'Usuário não encontrado' });
  const salt = crypto.randomBytes(16).toString('hex');
  acc.hash = hashPass(newpassword, salt);
  acc.salt = salt;
  acc.token = makeToken(); // invalida sessão atual
  await saveAccount(key, acc);
  res.json({ ok: true, message: `Senha de "${acc.username}" resetada com sucesso!` });
});

// ============================================
// EMAIL - Forgot Password (via Brevo HTTP API)
// ============================================
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER  = process.env.BREVO_SENDER_EMAIL || 'livestreaminsofc@gmail.com';
if (BREVO_API_KEY) console.log('[Email] Brevo API key loaded ✅');
else console.log('[Email] No BREVO_API_KEY — forgot password disabled');

async function sendEmail(to, subject, html) {
  if (!BREVO_API_KEY) throw new Error('BREVO_API_KEY not set');
  const body = JSON.stringify({
    sender: { name: 'Live Stream INS', email: BREVO_SENDER },
    to: [{ email: to }],
    subject,
    htmlContent: html
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.brevo.com', port: 443, path: '/v3/smtp/email', method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        const parsed = (() => { try { return JSON.parse(raw); } catch(e) { return {}; } })();
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(new Error(parsed.message || `HTTP ${res.statusCode}: ${raw}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const resetCodes = new Map(); // email -> { code, username, expires }

app.post('/api/forgot-password', express.json(), async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.json({ ok: false, error: 'Informe o email' });
  if (!BREVO_API_KEY) return res.json({ ok: false, error: 'Serviço de email não configurado' });
  const emailLow = email.toLowerCase().trim();
  const acc = Object.values(accounts).find(a => a.email && a.email.toLowerCase() === emailLow);
  if (!acc) return res.json({ ok: false, error: 'Nenhuma conta encontrada com esse email' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  resetCodes.set(emailLow, { code, username: acc.username.toLowerCase(), expires: Date.now() + 15 * 60 * 1000 });
  try {
    await sendEmail(email, '🔑 Código de recuperação - Live Stream INS',
      `<div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:32px;background:#0e1120;color:#e2e8f0;border-radius:16px;">
        <h2 style="color:#a78bfa;margin-bottom:12px;">Recuperação de senha</h2>
        <p style="margin-bottom:20px;">Use o código abaixo para redefinir sua senha. Ele expira em <strong>15 minutos</strong>.</p>
        <div style="font-size:40px;font-weight:bold;letter-spacing:10px;color:#fff;background:rgba(124,58,237,0.25);padding:24px;border-radius:12px;text-align:center;margin-bottom:20px;">${code}</div>
        <p style="color:rgba(255,255,255,0.4);font-size:12px;">Se você não solicitou isso, ignore este email.</p>
      </div>`
    );
    console.log(`[Email] Reset code sent to ${emailLow}`);
    res.json({ ok: true });
  } catch(e) {
    console.error('[Email] Send error:', e.message);
    res.json({ ok: false, error: 'Erro ao enviar email. Tente novamente.' });
  }
});

// Admin: test email
app.get('/api/admin/test-email', async (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Acesso negado' });
  if (!BREVO_API_KEY) return res.json({ ok: false, error: 'BREVO_API_KEY não configurado' });
  const target = req.query.to || 'livestreaminsofc@gmail.com';
  try {
    await sendEmail(target, '✅ Teste de email - Live Stream INS', '<p>Se você recebeu isso, o email está funcionando! ✅</p>');
    res.json({ ok: true, message: 'Email enviado para ' + target });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/reset-password', express.json(), async (req, res) => {
  const { email, code, newPassword } = req.body || {};
  if (!email || !code || !newPassword) return res.json({ ok: false, error: 'Dados incompletos' });
  if (newPassword.length < 6) return res.json({ ok: false, error: 'Senha deve ter pelo menos 6 caracteres' });
  const emailLow = email.toLowerCase().trim();
  const entry = resetCodes.get(emailLow);
  if (!entry) return res.json({ ok: false, error: 'Nenhum código enviado para este email' });
  if (Date.now() > entry.expires) { resetCodes.delete(emailLow); return res.json({ ok: false, error: 'Código expirado. Solicite um novo.' }); }
  if (entry.code !== code.trim()) return res.json({ ok: false, error: 'Código incorreto' });
  const acc = await getAccount(entry.username);
  if (!acc) return res.json({ ok: false, error: 'Conta não encontrada' });
  const salt = crypto.randomBytes(16).toString('hex');
  acc.hash = hashPass(newPassword, salt);
  acc.salt = salt;
  acc.token = makeToken();
  await saveAccount(entry.username, acc);
  resetCodes.delete(emailLow);
  res.json({ ok: true });
});

// ============================================
// MERCADOPAGO - Subscriptions
// ============================================
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const RELAY_URL = 'https://tiktok-live-relay.onrender.com';

async function mpRequest(method, mpPath, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.mercadopago.com', port: 443, path: mpPath, method,
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({ error: 'parse error' }); } });
    });
    req.on('error', e => resolve({ error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

// Create subscription and return payment link
app.post('/api/subscribe', express.json(), async (req, res) => {
  if (!MP_ACCESS_TOKEN) return res.json({ ok: false, error: 'MercadoPago não configurado' });
  const { username, token, plan } = req.body || {};
  if (!username || !token || !plan) return res.json({ ok: false, error: 'Dados incompletos' });
  const key = username.toLowerCase().trim();
  const acc = await getAccount(key);
  if (!acc || acc.token !== token) return res.json({ ok: false, error: 'Sessão inválida' });
  const plans = {
    trial:   { label: '3 dias grátis + Mensal', amount: 60,  frequency: 1,  frequencyType: 'months', trial: true },
    monthly: { label: 'Mensal',                 amount: 60,  frequency: 1,  frequencyType: 'months', trial: false },
    annual:  { label: 'Anual',                  amount: 600, frequency: 12, frequencyType: 'months', trial: false }
  };
  const planInfo = plans[plan];
  if (!planInfo) return res.json({ ok: false, error: 'Plano inválido' });

  const autoRecurring = {
    frequency: planInfo.frequency,
    frequency_type: planInfo.frequencyType,
    transaction_amount: planInfo.amount,
    currency_id: 'BRL'
  };
  // Add free trial if this is the trial setup
  if (planInfo.trial) {
    autoRecurring.free_trial = { frequency: 3, frequency_type: 'days' };
  }

  const result = await mpRequest('POST', '/preapproval', {
    reason: `Live Stream INS - ${planInfo.label}`,
    external_reference: key,
    payer_email: acc.email || `${key}@livestreamin.app`,
    auto_recurring: autoRecurring,
    notification_url: `${RELAY_URL}/mp/webhook`,
    back_url: `${RELAY_URL}/subscription/success`,
    status: 'pending'
  });
  if (!result.init_point) {
    console.error('[MP] Subscribe error:', JSON.stringify(result));
    return res.json({ ok: false, error: 'Erro ao criar assinatura. Tente novamente.' });
  }
  acc.mpSubscriptionId = result.id;
  await saveAccount(key, acc);
  res.json({ ok: true, url: result.init_point });
});

// Check subscription status (called after user pays)
app.post('/api/check-subscription', express.json(), async (req, res) => {
  const { username, token } = req.body || {};
  const key = (username || '').toLowerCase().trim();
  const acc = await getAccount(key);
  if (!acc || acc.token !== token) return res.json({ ok: false, error: 'Sessão inválida' });

  // If pending_payment and has a mpSubscriptionId, check MP directly
  if ((acc.subscription === 'pending_payment' || acc.subscription === 'expired') && acc.mpSubscriptionId && MP_ACCESS_TOKEN) {
    try {
      const sub = await mpRequest('GET', `/preapproval/${acc.mpSubscriptionId}`, null);
      if (sub.status === 'authorized') {
        const hasTrial = !!sub.auto_recurring?.free_trial;
        const isAnnual = sub.auto_recurring?.frequency === 12;
        const months = isAnnual ? 12 : 1;
        if (hasTrial && acc.subscription === 'pending_payment') {
          acc.subscription = 'trial';
          acc.trialEnds = Date.now() + 3 * 24 * 60 * 60 * 1000;
        } else {
          acc.subscription = 'active';
          acc.subscriptionEnd = Date.now() + months * 30 * 24 * 60 * 60 * 1000;
          acc.subscriptionPlan = isAnnual ? 'annual' : 'monthly';
        }
        await saveAccount(key, acc);
        console.log(`[MP] ✅ Manually verified subscription for ${key}: ${acc.subscription}`);
      }
    } catch(e) {
      console.error('[MP] check-subscription error:', e.message);
    }
  }

  const status = getSubscriptionStatus(acc);
  res.json({
    ok: true,
    subscription: status,
    trialEnds: acc.trialEnds,
    subscriptionEnd: acc.subscriptionEnd,
    createdAt: acc.createdAt,
    username: acc.username,
    email: acc.email,
    hasMpSubscription: !!acc.mpSubscriptionId
  });
});

// Cancelar assinatura do MercadoPago
app.post('/api/cancel-subscription', express.json(), async (req, res) => {
  const { username, token } = req.body || {};
  const key = (username || '').toLowerCase().trim();
  const acc = await getAccount(key);
  if (!acc || acc.token !== token) return res.json({ ok: false, error: 'Sessão inválida' });
  if (!acc.mpSubscriptionId) return res.json({ ok: false, error: 'Você não possui assinatura ativa no MercadoPago' });
  if (!MP_ACCESS_TOKEN) return res.json({ ok: false, error: 'MercadoPago não configurado no servidor' });

  try {
    const result = await mpRequest('PUT', `/preapproval/${acc.mpSubscriptionId}`, { status: 'cancelled' });
    if (result.status === 'cancelled' || (result.id && result.status)) {
      console.log(`[MP] Cancelamento solicitado para ${key} (${acc.mpSubscriptionId}) — status: ${result.status}`);
      // Marca conta como pendente, mas mantém o acesso até o fim do período
      // (o webhook do MP vai confirmar quando o período acabar)
      await saveAccount(key, acc);
      return res.json({ ok: true, message: 'Assinatura cancelada com sucesso. Você continua tendo acesso até o fim do período já pago.', subscriptionEnd: acc.subscriptionEnd });
    }
    return res.json({ ok: false, error: result.message || 'Erro ao cancelar no MercadoPago' });
  } catch(e) {
    console.error('[MP] Erro ao cancelar:', e.message);
    return res.json({ ok: false, error: 'Erro ao processar cancelamento: ' + e.message });
  }
});

// MercadoPago webhook — called when payment status changes
app.post('/mp/webhook', express.json(), async (req, res) => {
  res.sendStatus(200); // always respond 200 first
  const { type, data } = req.body || {};
  if (type !== 'subscription_preapproval' || !data?.id) return;
  try {
    const sub = await mpRequest('GET', `/preapproval/${data.id}`, null);
    const username = (sub.external_reference || '').toLowerCase().trim();
    if (!username) return;
    const acc = await getAccount(username);
    if (!acc) return;
    if (sub.status === 'authorized') {
      const isAnnual = sub.auto_recurring?.frequency === 12 && sub.auto_recurring?.frequency_type === 'months';
      const hasTrial = !!sub.auto_recurring?.free_trial;
      const months = isAnnual ? 12 : 1;

      if (hasTrial && acc.subscription === 'pending_payment') {
        // Card set up for trial — activate trial period
        acc.subscription = 'trial';
        acc.trialEnds = Date.now() + 3 * 24 * 60 * 60 * 1000;
        acc.mpSubscriptionId = sub.id;
        await saveAccount(username, acc);
        console.log(`[MP] ✅ Trial activated for ${username} until ${new Date(acc.trialEnds).toISOString()}`);
      } else {
        // Regular subscription activated
        acc.subscription = 'active';
        acc.subscriptionEnd = Date.now() + months * 30 * 24 * 60 * 60 * 1000;
        acc.subscriptionPlan = isAnnual ? 'annual' : 'monthly';
        acc.mpSubscriptionId = sub.id;
        await saveAccount(username, acc);
        console.log(`[MP] ✅ Subscription activated for ${username} until ${new Date(acc.subscriptionEnd).toISOString()}`);
      }
    } else if (sub.status === 'cancelled') {
      console.log(`[MP] Subscription cancelled for ${username}`);
    }
  } catch(e) { console.error('[MP] Webhook error:', e.message); }
});

// Success page after payment
app.get('/subscription/success', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Obrigado! - Live Stream INS</title>
  <style>*{margin:0;padding:0;box-sizing:border-box;}body{background:#0e1120;color:#e2e8f0;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;}
  .card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:48px 40px;max-width:420px;text-align:center;}
  .icon{font-size:72px;margin-bottom:20px;}h1{font-size:24px;color:#4ade80;margin-bottom:10px;}p{color:rgba(255,255,255,0.5);line-height:1.6;}</style></head>
  <body><div class="card"><div class="icon">✅</div><h1>Pagamento realizado!</h1>
  <p>Sua assinatura será ativada em instantes.<br>Volte ao app e clique em <strong>"Verificar acesso"</strong>.</p></div></body></html>`);
});

// ============================================
// ACCESS KEY VALIDATION
// ============================================
const ACCESS_KEY = 'LS001VINS'; // Mude aqui para revogar acesso

app.get('/validate-key', (req, res) => {
  const key = req.query.k || '';
  res.json({ valid: key === ACCESS_KEY });
});

// ============================================
// ROOMS - each user has a unique room
// ============================================
const rooms = {};

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      sseClients: {
        edits1: [], edits2: [], edits3: [],
        coins: [], likes: [], points: [], membrosAcao: [],
        characters: [],
        jar: [],
        scoreboard: [],
        timer: [],
        goalCoins: [],
        goalLikes: [],
        goalPix: [],
        membros: [],
        topScore: [],
        topGift: [],
        topCombo: [],
        alert: [],
        alertScene1: [], alertScene2: [], alertScene3: [],
        desejo: [],
        galeria: [],
        comboCarousel: [],
        translator: [],
        translatorMicControl: [],
        figurinhas: [],
        musica: []
      },
      musica: { lastTrack: null },
      coinsRanking: {},
      likesRanking: {},
      pointsRanking: {},
      coinsConfig: { bg: 'transparent', side: 'left', theme: 'clean', customColor: '' },
      likesConfig: { bg: 'transparent', side: 'left', theme: 'clean', customColor: '' },
      pointsConfig: { bg: 'transparent', side: 'left', theme: 'clean', customColor: '', label: 'points', valueColor: '#f1c40f', labelColor: '#aaaaaa', nameColor: '#ffffff' },
      jarTheme: 'clean',
      jarCustomColor: '',
      jarCapacity: 1000,
      jarVisual: 'default',
      goalCoins: { text: '', target: 2000, current: 0, theme: 'neon', customColor: '', style: 'default' },
      goalLikes: { text: '', target: 5000, current: 0, theme: 'neon', customColor: '', style: 'default' },
      goalPix: { text: '', target: 100, current: 0, theme: 'neon', customColor: '', style: 'default' },
      membros: { title: 'Membros', members: [], nameFont: '' },
      membrosAcao: { title: 'Membros Ação', members: [], giftName: 'Heart Me', giftImage: '', subText: '', subTextSize: 9, subValueSize: 9, subTextColor: '#ffdc50', subValueColor: '#ffdc50', nameFont: '', subTextFont: '', valueFont: '' },
      topScore: { title: 'TOP', desc: '', subtitle: 'PONTUAÇÃO', name: '', avatar: '', valor: 0, theme: 'dourado', customColor: '#c9a44a' },
      alertTheme: 'roxo',
      desejo: { name: 'Desejo do Streamer', giftName: '', giftImage: '', target: 1, current: 0, theme: 'neon', customColor: '', nameColor: '#ffffff', countColor: '#ffd700' },
      galeria: { league: 'D', style: 'padrao', title: 'Galeria de Presentes', progress: {}, theme: 'neon', titleColor: '#ffffff', nameColor: '#00d4ff', counterColor: '#ffd700', customColor: '', completeColor: '#ffd700', showTopName: false },
      comboCarousel: { items: [], theme: 'roxo', verbColor: '', countColor: '' },
      translator: { text: '', color: '#ffffff', bg: 'transparent', size: 36, duration: 5 },
      topGift: null,
      topCombo: null,
      topGiftConfig: { label: 'Maior Presente', labelColor: '#ffffff', nameColor: '#FFD700', valueColor: '#ffffff' },
      topComboConfig: { label: 'Maior Combo', labelColor: '#ffffff', nameColor: '#FFD700', comboColor: '#ff6464' }
    };
    // Restaurar estado persistido do Mongo (carrossel sobrevive reinício do servidor)
    const saved = persistedRooms[roomId];
    if (saved) {
      if (saved.comboCarousel) {
        rooms[roomId].comboCarousel = Object.assign(rooms[roomId].comboCarousel, saved.comboCarousel);
      }
      if (saved.galeria) {
        rooms[roomId].galeria = Object.assign(rooms[roomId].galeria, saved.galeria);
      }
    }
  }
  return rooms[roomId];
}

// ============================================
// MEDIA STORAGE (in-memory, temporary)
// ============================================
const mediaStore = {};

setInterval(() => {
  const now = Date.now();
  for (const [id, media] of Object.entries(mediaStore)) {
    if (now - media.createdAt > 10 * 60 * 1000) {
      delete mediaStore[id];
    }
  }
}, 60 * 1000);

setInterval(() => {
  for (const [id, room] of Object.entries(rooms)) {
    const s = room.sseClients;
    const hasClients = s.edits1.length > 0 || s.edits2.length > 0 || s.edits3.length > 0 ||
                       s.coins.length > 0 || s.likes.length > 0 || s.characters.length > 0 || s.jar.length > 0 || s.scoreboard.length > 0;
    const hasData = Object.keys(room.coinsRanking).length > 0 ||
                    Object.keys(room.likesRanking).length > 0;
    if (!hasClients && !hasData) delete rooms[id];
  }
}, 30 * 60 * 1000);

// ============================================
// CORS
// ============================================
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(200); return; }
  next();
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/ping', (req, res) => {
  res.json({ status: true, message: 'TikTok Live Relay is running!' });
});

// ============================================
// MEDIA ENDPOINT
// ============================================
app.get('/media/:id', (req, res) => {
  const media = mediaStore[req.params.id];
  if (!media) { res.status(404).send('Media not found'); return; }
  res.setHeader('Content-Type', media.mimeType);
  res.setHeader('Cache-Control', 'public, max-age=600');
  res.send(media.data);
});

// ============================================
// OVERLAY PAGES
// ============================================

// Edits overlay - scene 1, 2, or 3
app.get('/overlay/:roomId/edits/:scene', (req, res) => {
  const { roomId, scene } = req.params;
  const sceneNum = parseInt(scene) || 1;
  if (sceneNum < 1 || sceneNum > 3) { res.status(400).send('Scene must be 1, 2, or 3'); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getEditsHTML(roomId, sceneNum));
});

// Coins ranking overlay
app.get('/overlay/:roomId/ranking/coins', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getRankingHTML(req.params.roomId, 'coins'));
});

// Likes ranking overlay
app.get('/overlay/:roomId/ranking/likes', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getRankingHTML(req.params.roomId, 'likes'));
});

// Characters overlay
app.get('/overlay/:roomId/characters', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getCharactersHTML(req.params.roomId));
});

// Scoreboard overlay
app.get('/overlay/:roomId/scoreboard', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getScoreboardHTML(req.params.roomId));
});

// Jar overlay
app.get('/overlay/:roomId/jar', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getJarHTML(req.params.roomId));
});

app.get('/overlay/:roomId/timer', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getTimerHTML(req.params.roomId));
});

app.get('/overlay/:roomId/goal/:goalType', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getGoalHTML(req.params.roomId, req.params.goalType));
});

// Membros overlay
app.get('/overlay/:roomId/membros', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getMembrosHTML(req.params.roomId));
});

// Top Score overlay
app.get('/overlay/:roomId/top-score', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getTopScoreHTML(req.params.roomId));
});

// Top Gift overlay
app.get('/overlay/:roomId/top-gift', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getTopGiftHTML(req.params.roomId));
});

// Membros Ação overlay
app.get('/overlay/:roomId/membros-acao', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getMembrosAcaoHTML(req.params.roomId));
});

// Points ranking overlay
app.get('/overlay/:roomId/ranking/points', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getRankingPointsHTML(req.params.roomId));
});

// Top Combo overlay
app.get('/overlay/:roomId/top-combo', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getTopComboHTML(req.params.roomId));
});

// Alert overlay (legacy single scene)
app.get('/overlay/:roomId/alert', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getAlertHTML(req.params.roomId));
});

// Alert overlays per scene
app.get('/overlay/:roomId/alert/scene1', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getAlertSceneHTML(req.params.roomId, 1));
});
app.get('/overlay/:roomId/alert/scene2', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getAlertSceneHTML(req.params.roomId, 2));
});
app.get('/overlay/:roomId/alert/scene3', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getAlertSceneHTML(req.params.roomId, 3));
});

// Desejo do Streamer overlay
app.get('/overlay/:roomId/desejo', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getDesejoOverlayHTML(req.params.roomId));
});

// Galeria de Presentes overlay
app.get('/overlay/:roomId/galeria', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getGaleriaOverlayHTML(req.params.roomId));
});

app.get('/overlay/:roomId/combo-carousel', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getComboCarouselOverlayHTML(req.params.roomId));
});

app.get('/overlay/:roomId/translator', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getTranslatorOverlayHTML(req.params.roomId));
});

app.get('/overlay/:roomId/figurinhas', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getFigurinhasOverlayHTML(req.params.roomId));
});

app.get('/overlay/:roomId/musica', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getMusicaOverlayHTML(req.params.roomId));
});

// Notifica app quando vídeo do YouTube termina (overlay → relay → app via WS reverso)
app.post('/api/youtube-track-ended/:roomId', (req, res) => {
  const room = getRoom(req.params.roomId);
  if (room && room.appWs && room.appWs.readyState === 1) {
    try { room.appWs.send(JSON.stringify({ type: 'youtube-track-ended' })); } catch(e){}
  }
  res.json({ ok: true });
});

// Página do microfone (Chrome) — para Web Speech API que não funciona no Electron
app.get('/translator-mic/:roomId', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getTranslatorMicHTML(req.params.roomId));
});

// Endpoint POST que recebe texto traduzido da página do microfone e broadcasts pro overlay
app.post('/api/translator-push/:roomId', express.json(), (req, res) => {
  const room = getRoom(req.params.roomId);
  const { text, color, bg, size } = req.body || {};
  if (text != null) room.translator.text = text;
  if (color) room.translator.color = color;
  if (bg) room.translator.bg = bg;
  if (size) room.translator.size = size;
  const ev = JSON.stringify({ type: 'state', ...room.translator });
  room.sseClients.translator.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
  res.json({ ok: true });
});

// ============================================
// SSE ENDPOINTS
// ============================================

// Edits SSE per scene
app.get('/sse/:roomId/edits/:scene', (req, res) => {
  const { roomId, scene } = req.params;
  const sceneNum = parseInt(scene) || 1;
  const key = 'edits' + sceneNum;
  const room = getRoom(roomId);
  if (!room.sseClients[key]) { res.status(400).send('Invalid scene'); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('data: {"type":"connected"}\n\n');
  room.sseClients[key].push(res);
  req.on('close', () => {
    room.sseClients[key] = room.sseClients[key].filter(c => c !== res);
  });
});

app.get('/sse/:roomId/ranking/coins', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write(`data: ${JSON.stringify({ type: 'config', ...room.coinsConfig })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'full', data: room.coinsRanking })}\n\n`);
  room.sseClients.coins.push(res);
  req.on('close', () => {
    room.sseClients.coins = room.sseClients.coins.filter(c => c !== res);
  });
});

app.get('/sse/:roomId/membros-acao', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write(`data: ${JSON.stringify({ type: 'full', data: room.membrosAcao })}\n\n`);
  room.sseClients.membrosAcao.push(res);
  req.on('close', () => { room.sseClients.membrosAcao = room.sseClients.membrosAcao.filter(c => c !== res); });
});

app.get('/sse/:roomId/ranking/points', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write(`data: ${JSON.stringify({ type: 'config', ...room.pointsConfig })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'full', data: room.pointsRanking })}\n\n`);
  room.sseClients.points.push(res);
  req.on('close', () => { room.sseClients.points = room.sseClients.points.filter(c => c !== res); });
});

app.get('/sse/:roomId/ranking/likes', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write(`data: ${JSON.stringify({ type: 'config', ...room.likesConfig })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'full', data: room.likesRanking })}\n\n`);
  room.sseClients.likes.push(res);
  req.on('close', () => {
    room.sseClients.likes = room.sseClients.likes.filter(c => c !== res);
  });
});

// Scoreboard SSE
app.get('/sse/:roomId/scoreboard', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  // Send current state
  const sb = room.scoreboard || { left: 0, right: 0, leftName: 'Streamer', rightName: 'Chat', theme: 'neon', style: 'default', customColor: '' };
  res.write(`data: ${JSON.stringify({ type: 'full', ...sb })}\n\n`);
  room.sseClients.scoreboard.push(res);
  req.on('close', () => {
    room.sseClients.scoreboard = room.sseClients.scoreboard.filter(c => c !== res);
  });
});

// Jar SSE
app.get('/sse/:roomId/jar', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('data: {"type":"connected"}\n\n');
  res.write(`data: ${JSON.stringify({ type: 'config', theme: room.jarTheme || 'clean', customColor: room.jarCustomColor || '', capacity: room.jarCapacity || 1000, visual: room.jarVisual || 'default' })}\n\n`);
  room.sseClients.jar.push(res);
  req.on('close', () => {
    room.sseClients.jar = room.sseClients.jar.filter(c => c !== res);
  });
});

// Goal SSE
app.get('/sse/:roomId/goal/:goalType', (req, res) => {
  const room = getRoom(req.params.roomId);
  const gt = req.params.goalType === 'likes' ? 'goalLikes' : (req.params.goalType === 'pix' ? 'goalPix' : 'goalCoins');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('data: {"type":"connected"}\n\n');
  const goalState = room[gt] || { text: '', target: 2000, current: 0 };
  res.write(`data: ${JSON.stringify({ type: 'goal', ...goalState })}\n\n`);
  room.sseClients[gt].push(res);
  req.on('close', () => {
    room.sseClients[gt] = room.sseClients[gt].filter(c => c !== res);
  });
});

// Top Score SSE
app.get('/sse/:roomId/top-score', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write(`data: ${JSON.stringify({ type: 'full', data: room.topScore })}\n\n`);
  room.sseClients.topScore.push(res);
  req.on('close', () => {
    room.sseClients.topScore = room.sseClients.topScore.filter(c => c !== res);
  });
});

// Top Gift SSE
app.get('/sse/:roomId/top-gift', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write(`data: ${JSON.stringify({ type: 'full', data: room.topGift, config: room.topGiftConfig })}\n\n`);
  room.sseClients.topGift.push(res);
  req.on('close', () => { room.sseClients.topGift = room.sseClients.topGift.filter(c => c !== res); });
});

// Top Combo SSE
app.get('/sse/:roomId/top-combo', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write(`data: ${JSON.stringify({ type: 'full', data: room.topCombo, config: room.topComboConfig })}\n\n`);
  room.sseClients.topCombo.push(res);
  req.on('close', () => { room.sseClients.topCombo = room.sseClients.topCombo.filter(c => c !== res); });
});

// Membros SSE
app.get('/sse/:roomId/membros', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write(`data: ${JSON.stringify({ type: 'full', data: room.membros })}\n\n`);
  room.sseClients.membros.push(res);
  req.on('close', () => {
    room.sseClients.membros = room.sseClients.membros.filter(c => c !== res);
  });
});

// Characters SSE
app.get('/sse/:roomId/characters', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('data: {"type":"connected"}\n\n');
  room.sseClients.characters.push(res);
  req.on('close', () => {
    room.sseClients.characters = room.sseClients.characters.filter(c => c !== res);
  });
});

app.get('/sse/:roomId/timer', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('data: {"type":"connected"}\n\n');
  room.sseClients.timer.push(res);
  req.on('close', () => {
    room.sseClients.timer = room.sseClients.timer.filter(c => c !== res);
  });
});

// Alert SSE (legacy)
app.get('/sse/:roomId/alert', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('data: {"type":"connected"}\n\n');
  room.sseClients.alert.push(res);
  req.on('close', () => { room.sseClients.alert = room.sseClients.alert.filter(c => c !== res); });
});

// Alert scene SSE
app.get('/sse/:roomId/alert/scene1', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('data: {"type":"connected"}\n\n');
  res.write(`data: ${JSON.stringify({ type: 'config', theme: room.alertTheme || 'roxo' })}\n\n`);
  room.sseClients.alertScene1.push(res);
  req.on('close', () => { room.sseClients.alertScene1 = room.sseClients.alertScene1.filter(c => c !== res); });
});
app.get('/sse/:roomId/alert/scene2', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('data: {"type":"connected"}\n\n');
  res.write(`data: ${JSON.stringify({ type: 'config', theme: room.alertTheme || 'roxo' })}\n\n`);
  room.sseClients.alertScene2.push(res);
  req.on('close', () => { room.sseClients.alertScene2 = room.sseClients.alertScene2.filter(c => c !== res); });
});
app.get('/sse/:roomId/alert/scene3', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('data: {"type":"connected"}\n\n');
  res.write(`data: ${JSON.stringify({ type: 'config', theme: room.alertTheme || 'roxo' })}\n\n`);
  room.sseClients.alertScene3.push(res);
  req.on('close', () => { room.sseClients.alertScene3 = room.sseClients.alertScene3.filter(c => c !== res); });
});

// Desejo do Streamer SSE
app.get('/sse/:roomId/desejo', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('data: {"type":"connected"}\n\n');
  res.write(`data: ${JSON.stringify({ type: 'config', state: room.desejo })}\n\n`);
  room.sseClients.desejo.push(res);
  req.on('close', () => { room.sseClients.desejo = room.sseClients.desejo.filter(c => c !== res); });
});

// Carrossel de Combo SSE
app.get('/sse/:roomId/combo-carousel', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('data: {"type":"connected"}\n\n');
  res.write(`data: ${JSON.stringify({ type: 'config', items: room.comboCarousel.items, theme: room.comboCarousel.theme || 'roxo', verbColor: room.comboCarousel.verbColor || '', countColor: room.comboCarousel.countColor || '' })}\n\n`);
  room.sseClients.comboCarousel.push(res);
  req.on('close', () => { room.sseClients.comboCarousel = room.sseClients.comboCarousel.filter(c => c !== res); });
});

// Tradutor SSE
app.get('/sse/:roomId/translator', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('data: {"type":"connected"}\n\n');
  res.write(`data: ${JSON.stringify({ type: 'state', ...room.translator })}\n\n`);
  room.sseClients.translator.push(res);
  req.on('close', () => { room.sseClients.translator = room.sseClients.translator.filter(c => c !== res); });
});

// Figurinhas (áudio de stickers) SSE
app.get('/sse/:roomId/figurinhas', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('data: {"type":"connected"}\n\n');
  room.sseClients.figurinhas.push(res);
  req.on('close', () => { room.sseClients.figurinhas = room.sseClients.figurinhas.filter(c => c !== res); });
});

// Música (overlay tocando agora) SSE
app.get('/sse/:roomId/musica', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('data: {"type":"connected"}\n\n');
  if (room.musica && room.musica.lastTrack) {
    res.write(`data: ${JSON.stringify({ type: 'track', track: room.musica.lastTrack })}\n\n`);
  }
  room.sseClients.musica = room.sseClients.musica || [];
  room.sseClients.musica.push(res);
  req.on('close', () => { room.sseClients.musica = room.sseClients.musica.filter(c => c !== res); });
});

// Canal de controle da página do microfone (recebe toggle via tecla de atalho)
app.get('/sse/:roomId/translator-mic-control', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('data: {"type":"connected"}\n\n');
  room.sseClients.translatorMicControl.push(res);
  req.on('close', () => { room.sseClients.translatorMicControl = room.sseClients.translatorMicControl.filter(c => c !== res); });
});

// Galeria de Presentes SSE
app.get('/sse/:roomId/galeria', (req, res) => {
  const room = getRoom(req.params.roomId);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('data: {"type":"connected"}\n\n');
  res.write(`data: ${JSON.stringify({ type: 'config', ...room.galeria })}\n\n`);
  room.sseClients.galeria.push(res);
  req.on('close', () => { room.sseClients.galeria = room.sseClients.galeria.filter(c => c !== res); });
});

// ============================================
// WEBSOCKET
// ============================================
wss.on('connection', (ws) => {
  let roomId = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'join') {
        roomId = msg.roomId;
        const room = getRoom(roomId);
        room.appWs = ws;
        ws.send(JSON.stringify({ type: 'joined', roomId }));
        return;
      }

      if (!roomId) return;
      const room = getRoom(roomId);

      // Media upload
      if (msg.type === 'media') {
        const buffer = Buffer.from(msg.data, 'base64');
        mediaStore[msg.id] = { data: buffer, mimeType: msg.mimeType, createdAt: Date.now() };
        ws.send(JSON.stringify({ type: 'media-ready', id: msg.id }));
      }

      // Edit trigger - route to correct scene
      if (msg.type === 'edit') {
        const scene = msg.scene || 1;
        const key = 'edits' + scene;
        const mediaUrl = `/media/${msg.mediaId}`;
        const event = JSON.stringify({
          type: 'play',
          giftName: msg.giftName,
          mediaUrl: mediaUrl,
          duration: msg.duration,
          isGif: msg.isGif,
          senderNickname: msg.senderNickname || '',
          senderPhoto: msg.senderPhoto || '',
          volume: msg.volume !== undefined ? msg.volume : 100
        });
        if (room.sseClients[key]) {
          room.sseClients[key].forEach(client => {
            try { client.write(`data: ${event}\n\n`); } catch (e) {}
          });
        }
      }

      // Coins ranking
      if (msg.type === 'coins') {
        room.coinsRanking = msg.data;
        const event = JSON.stringify({ type: 'full', data: msg.data });
        room.sseClients.coins.forEach(client => {
          try { client.write(`data: ${event}\n\n`); } catch (e) {}
        });
      }

      // Likes ranking
      if (msg.type === 'likes') {
        room.likesRanking = msg.data;
        const event = JSON.stringify({ type: 'full', data: msg.data });
        room.sseClients.likes.forEach(client => {
          try { client.write(`data: ${event}\n\n`); } catch (e) {}
        });
      }

      // Points ranking
      if (msg.type === 'points') {
        room.pointsRanking = msg.data;
        const event = JSON.stringify({ type: 'full', data: msg.data });
        room.sseClients.points.forEach(client => {
          try { client.write(`data: ${event}\n\n`); } catch (e) {}
        });
      }

      // Ranking config update (bg color, side)
      if (msg.type === 'ranking-config') {
        const target = msg.ranking; // 'coins', 'likes' or 'points'
        const config = { bg: msg.bg || 'transparent', side: msg.side || 'left', theme: msg.theme || 'clean', customColor: msg.customColor || '' };
        if (target === 'coins') room.coinsConfig = config;
        if (target === 'likes') room.likesConfig = config;
        const event = JSON.stringify({ type: 'config', ...config });
        const clients = room.sseClients[target] || [];
        clients.forEach(client => {
          try { client.write(`data: ${event}\n\n`); } catch (e) {}
        });
      }

      // Points config update (colors, label, theme, side)
      if (msg.type === 'points-config') {
        const { type: _t, ...cfg } = msg;
        room.pointsConfig = { ...room.pointsConfig, ...cfg };
        const event = JSON.stringify({ type: 'config', ...room.pointsConfig });
        room.sseClients.points.forEach(client => {
          try { client.write(`data: ${event}\n\n`); } catch (e) {}
        });
      }

      // Scoreboard update
      if (msg.type === 'scoreboard') {
        room.scoreboard = { left: msg.left, right: msg.right, leftName: msg.leftName, rightName: msg.rightName, theme: msg.theme, customColor: msg.customColor || '', style: msg.style || 'default' };
        const event = JSON.stringify({ type: 'full', ...room.scoreboard });
        room.sseClients.scoreboard.forEach(client => {
          try { client.write(`data: ${event}\n\n`); } catch (e) {}
        });
      }

      // Jar gift event
      if (msg.type === 'jar-gift') {
        const event = JSON.stringify({ type: 'gift', giftImage: msg.giftImage, giftName: msg.giftName, count: msg.count || 1, coins: msg.coins || 0 });
        room.sseClients.jar.forEach(client => {
          try { client.write(`data: ${event}\n\n`); } catch (e) {}
        });
      }

      // Jar reset
      if (msg.type === 'jar-reset') {
        const event = JSON.stringify({ type: 'reset' });
        room.sseClients.jar.forEach(client => {
          try { client.write(`data: ${event}\n\n`); } catch (e) {}
        });
      }

      // Timer update
      if (msg.type === 'timer') {
        room.timerState = { seconds: msg.seconds, running: msg.running, theme: msg.theme };
        const event = JSON.stringify({ type: 'timer', seconds: msg.seconds, running: msg.running });
        room.sseClients.timer.forEach(client => {
          try { client.write(`data: ${event}\n\n`); } catch (e) {}
        });
      }

      // Timer config
      if (msg.type === 'timer-config') {
        room.timerTheme = msg.theme;
        room.timerCustomColor = msg.customColor || '';
        const event = JSON.stringify({ type: 'config', theme: msg.theme, customColor: msg.customColor });
        room.sseClients.timer.forEach(client => {
          try { client.write(`data: ${event}\n\n`); } catch (e) {}
        });
      }

      // Jar config
      if (msg.type === 'jar-config') {
        room.jarTheme = msg.theme || 'clean';
        room.jarCustomColor = msg.customColor || '';
        room.jarVisual = msg.visual || 'default';
        if (typeof msg.capacity === 'number' && msg.capacity > 0) {
          room.jarCapacity = msg.capacity;
        }
        const event = JSON.stringify({ type: 'config', theme: room.jarTheme, customColor: room.jarCustomColor, capacity: room.jarCapacity, visual: room.jarVisual });
        room.sseClients.jar.forEach(client => {
          try { client.write(`data: ${event}\n\n`); } catch (e) {}
        });
      }

      // Goal updates
      if (msg.type === 'goal-update') {
        const gt = msg.goalType === 'likes' ? 'goalLikes' : (msg.goalType === 'pix' ? 'goalPix' : 'goalCoins');
        room[gt] = { text: msg.text || '', target: msg.target || 2000, current: msg.current || 0, theme: msg.theme || 'neon', customColor: msg.customColor || '', style: msg.style || 'default' };
        const event = JSON.stringify({ type: 'goal', ...room[gt] });
        room.sseClients[gt].forEach(client => {
          try { client.write(`data: ${event}\n\n`); } catch (e) {}
        });
      }

      // Character events (evolution + appear)
      if (msg.type === 'character') {
        const event = JSON.stringify(msg);
        room.sseClients.characters.forEach(client => {
          try { client.write(`data: ${event}\n\n`); } catch (e) {}
        });
      }

      // Membros
      if (msg.type === 'membros-title') {
        room.membros.title = msg.title || 'Membros';
        room.membros.nameFont = msg.nameFont ?? room.membros.nameFont;
        const event = JSON.stringify({ type: 'full', data: room.membros });
        room.sseClients.membros.forEach(c => { try { c.write(`data: ${event}\n\n`); } catch(e){} });
      }
      if (msg.type === 'membros-add') {
        const exists = room.membros.members.find(m => m.userId === msg.userId);
        if (!exists) {
          room.membros.members.push({ userId: msg.userId, nickname: msg.nickname, profilePictureUrl: msg.profilePictureUrl || '' });
          const event = JSON.stringify({ type: 'full', data: room.membros });
          room.sseClients.membros.forEach(c => { try { c.write(`data: ${event}\n\n`); } catch(e){} });
        }
      }
      if (msg.type === 'top-score-update') {
        room.topScore = { title: msg.title || 'TOP', desc: msg.desc || '', subtitle: msg.subtitle || 'PONTUAÇÃO', name: msg.name || '', avatar: msg.avatar || '', valor: msg.valor || 0, theme: msg.theme || 'dourado', customColor: msg.customColor || '#c9a44a' };
        const ev = JSON.stringify({ type: 'full', data: room.topScore });
        room.sseClients.topScore.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }

      if (msg.type === 'membros-reset') {
        room.membros.members = [];
        const event = JSON.stringify({ type: 'full', data: room.membros });
        room.sseClients.membros.forEach(c => { try { c.write(`data: ${event}\n\n`); } catch(e){} });
      }

      // Membros Ação
      if (msg.type === 'membros-acao-config') {
        room.membrosAcao.title        = msg.title        ?? room.membrosAcao.title;
        room.membrosAcao.giftName     = msg.giftName     ?? room.membrosAcao.giftName;
        room.membrosAcao.giftImage    = msg.giftImage    ?? room.membrosAcao.giftImage;
        room.membrosAcao.subText      = msg.subText      ?? room.membrosAcao.subText;
        room.membrosAcao.subTextSize   = msg.subTextSize   ?? room.membrosAcao.subTextSize;
        room.membrosAcao.subValueSize  = msg.subValueSize  ?? room.membrosAcao.subValueSize;
        room.membrosAcao.subTextColor  = msg.subTextColor  ?? room.membrosAcao.subTextColor;
        room.membrosAcao.subValueColor = msg.subValueColor ?? room.membrosAcao.subValueColor;
        room.membrosAcao.nameFont      = msg.nameFont      ?? room.membrosAcao.nameFont;
        room.membrosAcao.subTextFont   = msg.subTextFont   ?? room.membrosAcao.subTextFont;
        room.membrosAcao.valueFont     = msg.valueFont     ?? room.membrosAcao.valueFont;
        const ev = JSON.stringify({ type: 'full', data: room.membrosAcao });
        room.sseClients.membrosAcao.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }
      if (msg.type === 'membros-acao-add') {
        const exists = room.membrosAcao.members.find(m => m.userId === msg.userId);
        if (exists) {
          exists.value = (exists.value || 0) + (msg.value || 0);
          exists.nickname = msg.nickname || exists.nickname;
          exists.profilePictureUrl = msg.profilePictureUrl || exists.profilePictureUrl;
        } else {
          room.membrosAcao.members.push({ userId: msg.userId, nickname: msg.nickname, profilePictureUrl: msg.profilePictureUrl || '', value: msg.value || 0 });
        }
        const ev = JSON.stringify({ type: 'full', data: room.membrosAcao });
        room.sseClients.membrosAcao.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }
      if (msg.type === 'membros-acao-reset') {
        room.membrosAcao.members = [];
        const ev = JSON.stringify({ type: 'full', data: room.membrosAcao });
        room.sseClients.membrosAcao.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }

      // Top Gift update
      if (msg.type === 'top-gift-update') {
        room.topGift = { giftName: msg.giftName, giftPictureUrl: msg.giftPictureUrl, diamonds: msg.diamonds, nickname: msg.nickname, profilePictureUrl: msg.profilePictureUrl };
        const ev = JSON.stringify({ type: 'full', data: room.topGift, config: room.topGiftConfig });
        room.sseClients.topGift.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }

      // Top Combo update
      if (msg.type === 'top-combo-update') {
        room.topCombo = { giftName: msg.giftName, giftPictureUrl: msg.giftPictureUrl, comboCount: msg.comboCount, nickname: msg.nickname, profilePictureUrl: msg.profilePictureUrl };
        const ev = JSON.stringify({ type: 'full', data: room.topCombo, config: room.topComboConfig });
        room.sseClients.topCombo.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }

      // Top Gift config
      if (msg.type === 'top-gift-config') {
        room.topGiftConfig = { label: msg.label || 'Maior Presente', labelColor: msg.labelColor || '#ffffff', nameColor: msg.nameColor || '#FFD700', valueColor: msg.valueColor || '#ffffff' };
        const ev = JSON.stringify({ type: 'full', data: room.topGift, config: room.topGiftConfig });
        room.sseClients.topGift.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }

      // Top Combo config
      if (msg.type === 'top-combo-config') {
        room.topComboConfig = { label: msg.label || 'Maior Combo', labelColor: msg.labelColor || '#ffffff', nameColor: msg.nameColor || '#FFD700', comboColor: msg.comboColor || '#ff6464' };
        const ev = JSON.stringify({ type: 'full', data: room.topCombo, config: room.topComboConfig });
        room.sseClients.topCombo.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }

      // Top Gift reset
      if (msg.type === 'top-gift-reset') {
        room.topGift = null;
        room.sseClients.topGift.forEach(c => { try { c.write(`data: ${JSON.stringify({ type: 'full', data: null, config: room.topGiftConfig })}\n\n`); } catch(e){} });
      }

      // Top Combo reset
      if (msg.type === 'top-combo-reset') {
        room.topCombo = null;
        room.sseClients.topCombo.forEach(c => { try { c.write(`data: ${JSON.stringify({ type: 'full', data: null, config: room.topComboConfig })}\n\n`); } catch(e){} });
      }

      // Alert trigger (scene-aware)
      if (msg.type === 'alert-trigger') {
        const ev = JSON.stringify({
          type: 'alert',
          alertType: msg.alertType || '',
          nickname: msg.nickname || '',
          profilePic: msg.profilePic || '',
          message: msg.message || '',
          giftImage: msg.giftImage || '',
          giftCount: msg.giftCount || 0
        });
        const scene = parseInt(msg.scene) || 1;
        const sceneKey = 'alertScene' + scene;
        (room.sseClients[sceneKey] || []).forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
        // Also legacy channel
        room.sseClients.alert.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }

      // Alert config (theme)
      if (msg.type === 'alert-config') {
        room.alertTheme = msg.theme || 'roxo';
        const ev = JSON.stringify({ type: 'config', theme: room.alertTheme });
        ['alertScene1','alertScene2','alertScene3','alert'].forEach(k => {
          (room.sseClients[k] || []).forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
        });
      }

      // Desejo config
      if (msg.type === 'desejo-config') {
        const { type: _t, ...cfg } = msg;
        Object.assign(room.desejo, cfg);
        const ev = JSON.stringify({ type: 'config', state: room.desejo });
        room.sseClients.desejo.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }

      // Desejo increment
      if (msg.type === 'desejo-increment') {
        room.desejo.current = Math.min((room.desejo.current || 0) + (msg.amount || 1), room.desejo.target || 1);
        const ev = JSON.stringify({ type: 'increment', current: room.desejo.current, target: room.desejo.target });
        room.sseClients.desejo.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }

      // Desejo reset
      if (msg.type === 'desejo-reset') {
        room.desejo.current = 0;
        const ev = JSON.stringify({ type: 'reset', target: room.desejo.target });
        room.sseClients.desejo.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }

      // Galeria config
      if (msg.type === 'galeria-config') {
        room.galeria.league        = msg.league        || 'D';
        room.galeria.style         = msg.style         || 'padrao';
        room.galeria.title         = msg.title         || 'Galeria de Presentes';
        room.galeria.progress      = msg.progress      || {};
        room.galeria.theme         = msg.theme         || 'neon';
        room.galeria.titleColor    = msg.titleColor    || '#ffffff';
        room.galeria.nameColor     = msg.nameColor     || '#00d4ff';
        room.galeria.counterColor  = msg.counterColor  || '#ffd700';
        room.galeria.customColor   = msg.customColor   || '';
        room.galeria.completeColor = msg.completeColor || '#ffd700';
        room.galeria.showTopName   = !!msg.showTopName;
        persistRoomState(roomId, 'galeria', room.galeria);
        const ev = JSON.stringify({ type: 'config', ...room.galeria });
        room.sseClients.galeria.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }

      // Galeria progress
      if (msg.type === 'galeria-progress') {
        room.galeria.progress = msg.progress || {};
        persistRoomState(roomId, 'galeria', room.galeria);
        const ev = JSON.stringify({ type: 'progress', progress: room.galeria.progress, giftName: msg.giftName });
        room.sseClients.galeria.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }

      // Galeria reset
      if (msg.type === 'galeria-reset') {
        room.galeria.progress = {};
        persistRoomState(roomId, 'galeria', room.galeria);
        const ev = JSON.stringify({ type: 'config', ...room.galeria });
        room.sseClients.galeria.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }

      // Carrossel de Combo — config
      if (msg.type === 'combo-carousel-config') {
        const newItems = msg.items || [];
        const oldItems = room.comboCarousel.items || [];
        // Preservar holders existentes nos itens auto que já existiam (relay é a fonte da verdade dos holders)
        newItems.forEach(newIt => {
          if (newIt.mode !== 'auto') return;
          const old = oldItems.find(o => o.id === newIt.id);
          if (old && old.holder) newIt.holder = old.holder;
        });
        room.comboCarousel.items = newItems;
        room.comboCarousel.theme = msg.theme || 'roxo';
        room.comboCarousel.verbColor = msg.verbColor || '';
        room.comboCarousel.countColor = msg.countColor || '';
        persistRoomState(roomId, 'comboCarousel', room.comboCarousel);
        const ev = JSON.stringify({ type: 'config', items: room.comboCarousel.items, theme: room.comboCarousel.theme, verbColor: room.comboCarousel.verbColor, countColor: room.comboCarousel.countColor });
        room.sseClients.comboCarousel.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }

      // Carrossel de Combo — gift event (atualiza holder automático OU rouba predefinido se superado)
      if (msg.type === 'combo-carousel-gift') {
        let changed = false;
        room.comboCarousel.items.forEach(item => {
          const itemGift = (item.giftName || '').toLowerCase();
          if (itemGift !== (msg.giftName || '').toLowerCase()) return;
          const count = msg.count || 0;

          if (item.mode === 'auto') {
            if (count < (item.minValue || 1)) return;
            if (!item.holder || count > item.holder.count) {
              let avatar = msg.avatar || '';
              if (!avatar && item.holder && item.holder.nickname === msg.nickname && item.holder.avatar) {
                avatar = item.holder.avatar;
              }
              item.holder = { nickname: msg.nickname, avatar, count };
              changed = true;
            }
          } else if (item.mode === 'predefined' && item.predefined) {
            // ROUBO de predefinido: se alguém enviar combo MAIOR que o predefinido, vira holder
            const predefCount = item.predefined.count || 0;
            const currentHolderCount = item.holder ? item.holder.count : 0;
            const winningCount = Math.max(predefCount, currentHolderCount);
            if (count > winningCount) {
              let avatar = msg.avatar || '';
              if (!avatar && item.holder && item.holder.nickname === msg.nickname && item.holder.avatar) {
                avatar = item.holder.avatar;
              }
              item.holder = { nickname: msg.nickname, avatar, count };
              changed = true;
            }
          }
        });
        if (changed) {
          persistRoomState(roomId, 'comboCarousel', room.comboCarousel);
          const ev = JSON.stringify({ type: 'config', items: room.comboCarousel.items, theme: room.comboCarousel.theme || 'roxo', verbColor: room.comboCarousel.verbColor || '', countColor: room.comboCarousel.countColor || '' });
          room.sseClients.comboCarousel.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
        }
      }

      // Tradutor de voz — atualização de texto
      if (msg.type === 'translator-update') {
        room.translator.text = msg.text || '';
        room.translator.color = msg.color || room.translator.color || '#ffffff';
        room.translator.bg = msg.bg || room.translator.bg || 'transparent';
        room.translator.size = msg.size || room.translator.size || 36;
        if (msg.duration != null) room.translator.duration = msg.duration;
        const ev = JSON.stringify({ type: 'state', ...room.translator });
        room.sseClients.translator.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }
      // Figurinhas — tocar áudio no overlay (usa mediaStore via HTTP)
      if (msg.type === 'figurinha-play') {
        const ev = JSON.stringify({
          type: 'play',
          mediaUrl: '/media/' + msg.mediaId,
          volume: msg.volume || 80
        });
        room.sseClients.figurinhas.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }
      // Música — atualiza overlay "tocando agora"
      if (msg.type === 'musica-now-playing') {
        room.musica = room.musica || { lastTrack: null };
        room.musica.lastTrack = msg.track || null;
        const ev = JSON.stringify({ type: 'track', track: msg.track || null });
        (room.sseClients.musica || []).forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }
      // YouTube — broadcasts state (currentTrack + queue) pro overlay
      if (msg.type === 'youtube-state') {
        room.musica = room.musica || { lastTrack: null };
        room.musica.youtubeState = { currentTrack: msg.currentTrack || null, queue: msg.queue || [], volume: msg.volume };
        const ev = JSON.stringify({ type: 'youtube-state', currentTrack: msg.currentTrack || null, queue: msg.queue || [], volume: msg.volume });
        (room.sseClients.musica || []).forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }
      if (msg.type === 'youtube-volume') {
        room.musica = room.musica || { lastTrack: null };
        if (room.musica.youtubeState) room.musica.youtubeState.volume = msg.volume;
        const ev = JSON.stringify({ type: 'youtube-volume', volume: msg.volume });
        (room.sseClients.musica || []).forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }
      if (msg.type === 'youtube-pulse') {
        const ev = JSON.stringify({ type: 'youtube-pulse' });
        (room.sseClients.musica || []).forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }
      // Tradutor de voz — comando de toggle da página do microfone (vindo da tecla de atalho)
      if (msg.type === 'translator-mic-toggle') {
        const ev = JSON.stringify({ type: 'toggle' });
        room.sseClients.translatorMicControl.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }
      // Tradutor de voz — configuração de estilo
      if (msg.type === 'translator-config') {
        if (msg.color != null) room.translator.color = msg.color;
        if (msg.bg != null) room.translator.bg = msg.bg;
        if (msg.size != null) room.translator.size = msg.size;
        if (msg.duration != null) room.translator.duration = msg.duration;
        const ev = JSON.stringify({ type: 'state', ...room.translator });
        room.sseClients.translator.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }

      // Carrossel de Combo — reset holders automáticos
      if (msg.type === 'combo-carousel-reset') {
        // Limpa holders de auto E de predefinidos roubados (volta ao valor original predefinido)
        room.comboCarousel.items.forEach(item => { item.holder = null; });
        persistRoomState(roomId, 'comboCarousel', room.comboCarousel);
        const ev = JSON.stringify({ type: 'config', items: room.comboCarousel.items, theme: room.comboCarousel.theme || 'roxo', verbColor: room.comboCarousel.verbColor || '', countColor: room.comboCarousel.countColor || '' });
        room.sseClients.comboCarousel.forEach(c => { try { c.write(`data: ${ev}\n\n`); } catch(e){} });
      }

    } catch (e) {}
  });

  ws.on('close', () => { roomId = null; });
});

// ============================================
// OVERLAY HTML GENERATORS
// ============================================

function getEditsHTML(roomId, scene) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: transparent;
    overflow: hidden;
    width: 100vw;
    height: 100vh;
  }
  #media-container {
    display: none;
    width: 100%;
    height: 100%;
  }
  #media-container.active { display: block; }
  #media-container video,
  #media-container img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .gift-toast {
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0,0,0,0.8);
    color: white;
    padding: 10px 20px;
    border-radius: 30px;
    font-family: 'Segoe UI', sans-serif;
    font-size: 16px;
    font-weight: 600;
    display: none;
    z-index: 10;
    animation: fadeInDown 0.4s ease-out;
    align-items: center;
    gap: 10px;
    border: 1px solid rgba(255,255,255,0.15);
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
  }
  .gift-toast.active { display: flex; }
  .sender-photo {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    object-fit: cover;
    border: 2px solid #ffd700;
    flex-shrink: 0;
  }
  .sender-info {
    display: flex;
    flex-direction: column;
    line-height: 1.2;
  }
  .sender-name {
    font-size: 15px;
    font-weight: 700;
    color: #ffd700;
  }
  .sender-gift {
    font-size: 12px;
    color: rgba(255,255,255,0.7);
  }
  @keyframes fadeInDown {
    from { opacity: 0; transform: translateX(-50%) translateY(-20px); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
</style>
</head>
<body>
<div class="gift-toast" id="toast"></div>
<div id="media-container">
  <video id="video" autoplay></video>
  <img id="gif" style="display:none">
</div>
<script>
  const container = document.getElementById('media-container');
  const video = document.getElementById('video');
  const gif = document.getElementById('gif');
  const toast = document.getElementById('toast');

  // Queue system — garante que cada edit toca por completo antes da próxima
  const queue = [];
  let isPlaying = false;
  let currentTimer = null; // timer da edit que está tocando agora
  let currentId = 0;       // identifica qual edit está tocando (evita callbacks antigos)

  const evtSource = new EventSource('/sse/${roomId}/edits/${scene}');

  evtSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'play') {
      queue.push(data);
      if (!isPlaying) playNext();
    }
  };

  function stopCurrent() {
    if (currentTimer) { clearTimeout(currentTimer); currentTimer = null; }
    video.onended = null;
    video.pause();
    video.src = '';
    video.style.display = 'none';
    gif.src = '';
    gif.style.display = 'none';
  }

  function finishCurrent(myId) {
    // Só processa se o callback é do current playback (evita callbacks antigos chamarem playNext)
    if (myId !== currentId) return;
    if (currentTimer) { clearTimeout(currentTimer); currentTimer = null; }
    video.onended = null;
    if (queue.length === 0) {
      isPlaying = false;
      container.classList.remove('active');
      toast.classList.remove('active');
      video.pause();
      video.src = '';
      gif.src = '';
    } else {
      playNext();
    }
  }

  function playNext() {
    if (queue.length === 0) {
      isPlaying = false;
      stopCurrent();
      container.classList.remove('active');
      toast.classList.remove('active');
      return;
    }

    isPlaying = true;
    const data = queue.shift();
    stopCurrent(); // garante limpeza do anterior
    const myId = ++currentId;

    // Show sender photo + name + gift
    let toastHTML = '';
    if (data.senderPhoto) {
      toastHTML += '<img class="sender-photo" src="' + data.senderPhoto + '" onerror="this.style.display=\\'none\\'">';
    }
    if (data.senderNickname) {
      toastHTML += '<div class="sender-info"><span class="sender-name">' + data.senderNickname + '</span><span class="sender-gift">\\u{1F381} ' + data.giftName + '</span></div>';
    } else {
      toastHTML += '<div class="sender-info"><span class="sender-name">\\u{1F381} ' + data.giftName + '</span></div>';
    }
    toast.innerHTML = toastHTML;
    toast.classList.add('active');
    container.classList.add('active');

    const src = data.mediaUrl;
    const vol = (data.volume !== undefined ? data.volume : 100) / 100;
    video.volume = Math.max(0, Math.min(1, vol));

    if (data.isGif) {
      gif.src = src;
      gif.style.display = 'block';
      // Duração escolhida pelo usuário (GIF não tem duração natural)
      currentTimer = setTimeout(() => finishCurrent(myId), data.duration * 1000);
    } else {
      video.src = src;
      video.style.display = 'block';
      video.play().catch(() => {});
      // Termina quando o vídeo acaba naturalmente
      video.onended = () => finishCurrent(myId);
      // Fallback: se vídeo travar, força fim após data.duration segundos
      currentTimer = setTimeout(() => finishCurrent(myId), data.duration * 1000);
    }
  }
</script>
</body>
</html>`;
}

function getRankingHTML(roomId, type) {
  const sseUrl = `/sse/${roomId}/ranking/${type}`;
  const valueKey = type === 'coins' ? 'coins' : 'likes';
  const valueIcon = type === 'coins' ? '\\u{1FA99}' : '\\u2764\\uFE0F';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=MedievalSharp&family=Press+Start+2P&family=Rye&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: transparent;
    font-family: 'Segoe UI', -apple-system, sans-serif;
    color: white;
    padding: 16px;
    overflow-y: auto;
    transition: background 0.3s;
  }
  .ranking-list { display: flex; flex-direction: column; gap: 6px; }
  .ranking-item {
    display: flex; align-items: center; gap: 10px;
    flex-direction: row;
    background: transparent; border-radius: 12px;
    padding: 8px 14px;
    transition: all 0.3s;
  }
  .pos {
    width: 28px; height: 28px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; font-weight: 800; flex-shrink: 0;
  }
  .pos-1 { background: linear-gradient(135deg, #f1c40f, #e67e22); color: #1a1a2e; }
  .pos-2 { background: linear-gradient(135deg, #bdc3c7, #95a5a6); color: #1a1a2e; }
  .pos-3 { background: linear-gradient(135deg, #e67e22, #d35400); color: #1a1a2e; }
  .pos-other { background: rgba(255,255,255,0.15); color: rgba(255,255,255,0.6); }
  .avatar {
    width: 42px; height: 42px; border-radius: 50%;
    background: rgba(255,255,255,0.1); overflow: hidden; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center; font-size: 16px;
  }
  .avatar img { width: 100%; height: 100%; object-fit: cover; }
  .avatar-frame-1 {
    border: 3px solid #f1c40f;
    box-shadow: 0 0 12px rgba(241, 196, 15, 0.5);
  }
  .avatar-frame-2 {
    border: 3px solid #bdc3c7;
    box-shadow: 0 0 10px rgba(189, 195, 199, 0.4);
  }
  .avatar-frame-3 {
    border: 3px solid #e67e22;
    box-shadow: 0 0 10px rgba(230, 126, 34, 0.4);
  }
  .user-info { flex: 1; min-width: 0; text-align: left; }
  .user-name {
    font-size: 14px; font-weight: 700;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    text-shadow: 0 1px 4px rgba(0,0,0,0.8);
  }
  .user-value {
    font-size: 13px; font-weight: 800;
    text-shadow: 0 1px 4px rgba(0,0,0,0.8);
  }
  .empty { text-align: center; color: rgba(255,255,255,0.55); padding: 40px; font-size: 16px; font-weight: 600; text-shadow: 0 1px 4px rgba(0,0,0,0.8); }
  .status-bar { position: fixed; top: 6px; left: 6px; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; z-index: 9999; opacity: 0.85; }
  .status-bar.ok { background: rgba(16,185,129,0.85); color: #fff; }
  .status-bar.connecting { background: rgba(245,158,11,0.85); color: #fff; }
  .status-bar.error { background: rgba(239,68,68,0.85); color: #fff; }
  .status-bar.hidden { display: none; }

  /* THEME: CLEAN */
  .theme-clean .ranking-item { background: transparent; }
  .theme-clean .user-value { color: #f1c40f; }

  /* THEME: NEON */
  .theme-neon .ranking-item {
    background: rgba(10,10,30,0.7); border: 1px solid rgba(0,212,255,0.3);
    box-shadow: 0 0 8px rgba(0,212,255,0.1);
  }
  .theme-neon .user-name { color: #00d4ff; text-shadow: 0 0 8px rgba(0,212,255,0.5); }
  .theme-neon .user-value { color: #ff3366; text-shadow: 0 0 8px rgba(255,51,102,0.5); }
  .theme-neon .avatar-frame-1 { border-color: #00d4ff; box-shadow: 0 0 15px rgba(0,212,255,0.6); }
  .theme-neon .avatar-frame-2 { border-color: #ff3366; box-shadow: 0 0 12px rgba(255,51,102,0.4); }
  .theme-neon .avatar-frame-3 { border-color: #ffd700; box-shadow: 0 0 12px rgba(255,215,0,0.4); }

  /* THEME: MEDIEVAL */
  .theme-medieval .ranking-item {
    background: rgba(30,20,10,0.8); border: 1px solid rgba(201,164,74,0.4);
  }
  .theme-medieval .ranking-item { font-family: 'MedievalSharp', cursive; }
  .theme-medieval .user-name { color: #ffd700; }
  .theme-medieval .user-value { color: #c9a44a; }
  .theme-medieval .avatar-frame-1 { border-color: #ffd700; box-shadow: 0 0 15px rgba(255,215,0,0.5); }
  .theme-medieval .avatar-frame-2 { border-color: #c0c0c0; box-shadow: 0 0 12px rgba(192,192,192,0.4); }
  .theme-medieval .avatar-frame-3 { border-color: #cd7f32; box-shadow: 0 0 12px rgba(205,127,50,0.4); }

  /* THEME: RETRO */
  .theme-retro .ranking-item {
    background: rgba(0,0,0,0.85); border: 1px solid #39ff14;
    font-family: 'Press Start 2P', monospace;
  }
  .theme-retro .user-name { color: #39ff14; font-size: 10px; text-shadow: 0 0 6px rgba(57,255,20,0.6); }
  .theme-retro .user-value { color: #39ff14; font-size: 10px; }
  .theme-retro .avatar-frame-1 { border-color: #39ff14; box-shadow: 0 0 10px rgba(57,255,20,0.6); }
  .theme-retro .avatar-frame-2 { border-color: #00ffff; box-shadow: 0 0 8px rgba(0,255,255,0.4); }
  .theme-retro .avatar-frame-3 { border-color: #ff00ff; box-shadow: 0 0 8px rgba(255,0,255,0.4); }

  /* THEME: FIRE */
  .theme-fire .ranking-item {
    background: rgba(40,10,0,0.8); border: 1px solid rgba(255,107,53,0.4);
  }
  .theme-fire .user-name { color: #fff44f; }
  .theme-fire .user-value { color: #ff6b35; text-shadow: 0 0 8px rgba(255,107,53,0.5); }
  .theme-fire .avatar-frame-1 { border-color: #ff4500; box-shadow: 0 0 15px rgba(255,69,0,0.6), 0 0 30px rgba(255,69,0,0.3); }
  .theme-fire .avatar-frame-2 { border-color: #ff6b35; box-shadow: 0 0 12px rgba(255,107,53,0.4); }
  .theme-fire .avatar-frame-3 { border-color: #ffd700; box-shadow: 0 0 10px rgba(255,215,0,0.4); }

  /* THEME: ICE */
  .theme-ice .ranking-item {
    background: rgba(10,20,40,0.8); border: 1px solid rgba(135,206,235,0.3);
  }
  .theme-ice .user-name { color: #e0f0ff; }
  .theme-ice .user-value { color: #87ceeb; text-shadow: 0 0 8px rgba(135,206,235,0.5); }
  .theme-ice .avatar-frame-1 { border-color: #87ceeb; box-shadow: 0 0 15px rgba(135,206,235,0.6); }
  .theme-ice .avatar-frame-2 { border-color: #b0e0e6; box-shadow: 0 0 12px rgba(176,224,230,0.4); }
  .theme-ice .avatar-frame-3 { border-color: #4fc3f7; box-shadow: 0 0 10px rgba(79,195,247,0.4); }

  /* THEME: ROSA */
  .theme-rosa .ranking-item {
    background: linear-gradient(135deg, rgba(60,15,40,0.85), rgba(45,10,30,0.85));
    border: 1px solid rgba(255,105,180,0.4);
    box-shadow: 0 0 12px rgba(255,105,180,0.18), inset 0 0 10px rgba(255,105,180,0.05);
  }
  .theme-rosa .user-name { color: #ffd1e7; text-shadow: 0 0 8px rgba(255,105,180,0.5); }
  .theme-rosa .user-value { color: #ff69b4; text-shadow: 0 0 8px rgba(236,72,153,0.55); }
  .theme-rosa .avatar-frame-1 { border-color: #ff69b4; box-shadow: 0 0 18px rgba(255,105,180,0.7); }
  .theme-rosa .avatar-frame-2 { border-color: #f9a8d4; box-shadow: 0 0 12px rgba(249,168,212,0.5); }
  .theme-rosa .avatar-frame-3 { border-color: #ec4899; box-shadow: 0 0 12px rgba(236,72,153,0.5); }

  /* THEME: ROYALTY */
  @keyframes royalGlow {
    0%, 100% { box-shadow: 0 0 15px rgba(255,215,0,0.4), 0 0 30px rgba(186,133,255,0.2); }
    50% { box-shadow: 0 0 25px rgba(255,215,0,0.7), 0 0 50px rgba(186,133,255,0.4); }
  }
  @keyframes crownFloat {
    0%, 100% { transform: translateY(0) rotate(-5deg); }
    50% { transform: translateY(-3px) rotate(5deg); }
  }
  .theme-royalty .ranking-item {
    background: linear-gradient(135deg, rgba(60,20,100,0.9), rgba(40,10,70,0.85), rgba(60,20,100,0.9));
    border: 1px solid rgba(255,215,0,0.35);
    box-shadow: inset 0 0 20px rgba(186,133,255,0.08), 0 2px 8px rgba(0,0,0,0.3);
    position: relative;
  }
  .theme-royalty .ranking-item:nth-child(1) {
    border: 2px solid rgba(255,215,0,0.7);
    animation: royalGlow 3s ease-in-out infinite;
    background: linear-gradient(135deg, rgba(80,30,120,0.95), rgba(50,15,80,0.9), rgba(80,30,120,0.95));
  }
  .theme-royalty .ranking-item:nth-child(1)::before {
    content: '\\1F451';
    position: absolute;
    top: -18px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 28px;
    animation: crownFloat 2s ease-in-out infinite;
    filter: drop-shadow(0 0 8px rgba(255,215,0,0.8));
    z-index: 10;
  }
  .theme-royalty .ranking-item:nth-child(1) { margin-top: 14px; }
  .theme-royalty .user-name {
    color: #f0e6ff;
    text-shadow: 0 0 6px rgba(186,133,255,0.4);
    font-weight: 800;
  }
  .theme-royalty .ranking-item:nth-child(1) .user-name {
    color: #ffd700;
    text-shadow: 0 0 10px rgba(255,215,0,0.6);
  }
  .theme-royalty .user-value {
    color: #ffd700;
    text-shadow: 0 0 10px rgba(255,215,0,0.6);
    font-weight: 900;
  }
  .theme-royalty .pos-1 {
    background: linear-gradient(135deg, #ffd700, #ffaa00, #ffd700);
    color: #3a1560;
    font-weight: 900;
    box-shadow: 0 0 12px rgba(255,215,0,0.6);
  }
  .theme-royalty .pos-2 {
    background: linear-gradient(135deg, #c0c0c0, #e8e8e8, #c0c0c0);
    color: #3a1560;
    box-shadow: 0 0 8px rgba(192,192,192,0.4);
  }
  .theme-royalty .pos-3 {
    background: linear-gradient(135deg, #cd7f32, #e8a952, #cd7f32);
    color: #3a1560;
    box-shadow: 0 0 8px rgba(205,127,50,0.4);
  }
  .theme-royalty .avatar-frame-1 {
    border: 3px solid #ffd700;
    box-shadow: 0 0 20px rgba(255,215,0,0.7), 0 0 40px rgba(255,215,0,0.3), inset 0 0 8px rgba(255,215,0,0.2);
  }
  .theme-royalty .avatar-frame-2 {
    border: 3px solid #c0c0c0;
    box-shadow: 0 0 15px rgba(192,192,192,0.5), 0 0 30px rgba(186,133,255,0.2);
  }
  .theme-royalty .avatar-frame-3 {
    border: 3px solid #cd7f32;
    box-shadow: 0 0 12px rgba(205,127,50,0.5), 0 0 25px rgba(186,133,255,0.15);
  }

  /* THEME: CUSTOM (just bg color, clean look) */
  .theme-custom .ranking-item { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); }
  .theme-custom .user-value { color: #f1c40f; }

  /* ===== THEME: VELHO-OESTE ===== */
  .theme-velho-oeste #list { display: none; }
  #vo-container { display: none; }
  .theme-velho-oeste #vo-container { display: block; }

  @keyframes voSwing {
    0%,100% { transform: rotate(-0.6deg) translateX(0); }
    50%      { transform: rotate(0.6deg)  translateX(0); }
  }
  @keyframes voEntrada {
    from { opacity:0; transform: translateX(55px) rotate(2deg); }
    to   { opacity:1; transform: translateX(0)    rotate(0deg); }
  }
  @keyframes voEntrada2 {
    from { opacity:0; transform: translateX(55px); }
    to   { opacity:1; transform: translateX(0); }
  }
  @keyframes voEntrada3 {
    from { opacity:0; transform: translateX(55px); }
    to   { opacity:1; transform: translateX(0); }
  }
  @keyframes hatBounce {
    0%,100% { transform: translateY(0)   rotate(-6deg); }
    50%      { transform: translateY(-5px) rotate(4deg);  }
  }
  @keyframes legendPulse {
    0%,100% { letter-spacing:2px; text-shadow: 0 0 6px #b8860b, 0 0 12px rgba(184,134,11,0.4); }
    50%      { letter-spacing:3px; text-shadow: 0 0 10px #ffd700, 0 0 20px rgba(255,215,0,0.5); }
  }
  @keyframes shimmerGold {
    0%   { background-position: -200% center; }
    100% { background-position:  200% center; }
  }
  @keyframes dustUp {
    0%   { opacity:0.5; transform:scale(1)   translateY(0); }
    100% { opacity:0;   transform:scale(1.8) translateY(-18px); }
  }
</style>
</head>
<body>
<div id="status-bar" class="status-bar connecting">⏳ Conectando ao servidor...</div>
<div id="theme-wrapper" class="theme-clean">
<div class="ranking-list" id="list"><div class="empty">⏳ Aguardando dados da live...</div></div>
</div>
<script>
  const list = document.getElementById('list');
  const wrapper = document.getElementById('theme-wrapper');
  const statusBar = document.getElementById('status-bar');
  let currentSide = 'left';
  let currentTheme = 'clean';
  let lastData = null;
  let lastConfig = null;

  function setStatus(state, msg) {
    statusBar.className = 'status-bar ' + state;
    statusBar.textContent = msg;
    if (state === 'ok') {
      // Esconde após 3s quando conectado
      setTimeout(() => { if (statusBar.className.indexOf('ok') >= 0) statusBar.classList.add('hidden'); }, 3000);
    }
  }

  let evtSource = null;
  function connectSSE() {
    try {
      if (evtSource) { try { evtSource.close(); } catch(e){} }
      setStatus('connecting', '⏳ Conectando...');
      evtSource = new EventSource('${sseUrl}');
      evtSource.onopen = () => { setStatus('ok', '✅ Conectado'); };
      evtSource.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'full') { lastData = msg.data; renderRanking(msg.data); }
          if (msg.type === 'config') { lastConfig = msg; applyConfig(msg); }
        } catch(err) {}
      };
      evtSource.onerror = () => {
        setStatus('error', '⚠️ Sem conexão — tentando reconectar...');
        try { evtSource.close(); } catch(e){}
        setTimeout(connectSSE, 3000);
      };
    } catch(e) {
      setStatus('error', '⚠️ Erro: ' + e.message);
      setTimeout(connectSSE, 3000);
    }
  }
  connectSSE();

  function applyConfig(cfg) {
    if (cfg.theme !== undefined) {
      currentTheme = cfg.theme;
      wrapper.className = 'theme-' + cfg.theme;
      // Reset velho-oeste container when switching away
      if (cfg.theme !== 'velho-oeste') {
        const vo = document.getElementById('vo-container');
        if (vo) vo.style.display = 'none';
      }
      if (cfg.theme === 'custom' && cfg.customColor) {
        document.body.style.background = cfg.customColor;
      } else if (cfg.theme === 'clean') {
        document.body.style.background = 'transparent';
      } else {
        document.body.style.background = 'transparent';
      }
    }
    if (cfg.bg !== undefined && currentTheme !== 'custom') {
      document.body.style.background = cfg.bg;
    }
    if (cfg.side !== undefined) {
      currentSide = cfg.side;
      const isRight = cfg.side === 'right';
      document.querySelectorAll('.ranking-item').forEach(item => {
        item.style.flexDirection = isRight ? 'row-reverse' : 'row';
      });
      document.querySelectorAll('.user-info').forEach(el => {
        el.style.textAlign = isRight ? 'right' : 'left';
      });
      // direction update handled per-element in renderRanking
    }
  }

  function mkEl(tag, css, text) {
    const el = document.createElement(tag);
    if (css) el.style.cssText = css;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function makeAvatar(url, size, borderColor, glowColor) {
    const wrap = mkEl('div',
      'position:relative;width:' + size + 'px;height:' + size + 'px;flex-shrink:0;border-radius:50%;');
    const ring = mkEl('div',
      'position:absolute;inset:-4px;border-radius:50%;' +
      'background:conic-gradient(' + borderColor + ',#3a2000,' + borderColor + ',#3a2000,' + borderColor + ');' +
      'box-shadow:0 0 10px ' + glowColor + ',0 0 22px ' + glowColor + '33;');
    const inner = mkEl('div',
      'position:absolute;inset:0;border-radius:50%;overflow:hidden;background:#1a0f00;' +
      'display:flex;align-items:center;justify-content:center;font-size:' + Math.floor(size * 0.4) + 'px;');
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      img.onerror = function() { inner.textContent = '\\u{1F464}'; };
      inner.appendChild(img);
    } else { inner.textContent = '\\u{1F464}'; }
    wrap.appendChild(ring);
    wrap.appendChild(inner);
    return wrap;
  }

  function spawnDust(parent) {
    for (let i = 0; i < 5; i++) {
      const d = mkEl('div',
        'position:absolute;bottom:4px;left:' + (10 + i * 18) + 'px;' +
        'width:6px;height:6px;border-radius:50%;' +
        'background:rgba(180,130,60,0.55);pointer-events:none;' +
        'animation:dustUp ' + (0.6 + Math.random() * 0.5) + 's ease-out forwards;');
      parent.appendChild(d);
      setTimeout(() => d.remove(), 1200);
    }
  }

  function renderVelhoOeste(data) {
    const sorted = Object.entries(data)
      .map(([id, d]) => ({ id, ...d }))
      .sort((a, b) => b.${valueKey} - a.${valueKey})
      .slice(0, 3);

    let vo = document.getElementById('vo-container');
    const isNew = !vo;
    if (isNew) {
      vo = mkEl('div', '');
      vo.id = 'vo-container';
      wrapper.insertBefore(vo, list);
    }

    // Board styles
    vo.style.cssText =
      'position:relative;width:390px;padding:18px 16px 20px;border-radius:5px;' +
      'background:linear-gradient(160deg,#2c1c0a 0%,#1a0f04 35%,#2e1e0c 65%,#1a0f04 100%);' +
      'border:2px solid #6b4218;' +
      'box-shadow:inset 0 0 50px rgba(0,0,0,0.55),inset 2px 2px 10px rgba(255,180,40,0.07),' +
      '0 10px 40px rgba(0,0,0,0.75),0 2px 8px rgba(0,0,0,0.5);' +
      'font-family:Rye,cursive;overflow:visible;' +
      'animation:voSwing 5s ease-in-out infinite;transform-origin:top center;';

    vo.innerHTML = '';

    // ── Wood grains ──
    for (let i = 0; i < 7; i++) {
      vo.appendChild(mkEl('div',
        'position:absolute;left:0;right:0;top:' + (20 + i * 62) + 'px;height:1px;pointer-events:none;' +
        'background:linear-gradient(90deg,transparent,rgba(90,55,10,0.25) 20%,rgba(90,55,10,0.12) 80%,transparent);'));
    }

    // ── Corner nails ──
    [['6px','6px'],['6px','calc(100% - 16px)'],['calc(100% - 16px)','6px'],['calc(100% - 16px)','calc(100% - 16px)']].forEach(([t,l]) => {
      vo.appendChild(mkEl('div',
        'position:absolute;top:' + t + ';left:' + l + ';width:10px;height:10px;border-radius:50%;pointer-events:none;' +
        'background:radial-gradient(circle at 35% 35%,#d4a84b,#7a5010);' +
        'box-shadow:0 1px 4px rgba(0,0,0,0.7);'));
    });

    // ── Title ──
    const typeLabel = '${type === 'coins' ? 'MOEDAS' : 'CURTIDAS'}';
    const icon = '${type === 'coins' ? '\u{1FA99}' : '❤️'}';
    vo.appendChild(mkEl('div',
      'text-align:center;font-size:11px;color:#c8943a;letter-spacing:4px;text-transform:uppercase;' +
      'text-shadow:0 2px 5px rgba(0,0,0,0.9),0 0 18px rgba(160,100,10,0.3);' +
      'margin-bottom:14px;padding-bottom:8px;' +
      'border-bottom:1px solid rgba(160,100,10,0.3);',
      '— RANKING DE ' + typeLabel + ' —'));

    if (sorted.length === 0) {
      vo.appendChild(mkEl('div',
        'text-align:center;color:rgba(190,140,50,0.45);padding:40px 20px;font-size:12px;',
        'Aguardando pistoleiros...'));
      return;
    }

    // ══════════════════════════════════════
    //  1st PLACE — WANTED POSTER STYLE
    // ══════════════════════════════════════
    if (sorted[0]) {
      const u = sorted[0];
      const s1 = mkEl('div',
        'position:relative;display:flex;align-items:center;gap:14px;' +
        'padding:14px 14px 12px;margin-bottom:10px;border-radius:4px;' +
        'background:linear-gradient(145deg,#caa96c 0%,#b8935a 25%,#d6b47a 50%,#b08040 75%,#caa96c 100%);' +
        'border:2px solid #7a5510;' +
        'box-shadow:inset 0 0 22px rgba(0,0,0,0.22),0 5px 14px rgba(0,0,0,0.6),' +
        '0 0 0 1px rgba(210,170,60,0.25);' +
        'animation:voEntrada 0.55s cubic-bezier(.22,1,.36,1);overflow:visible;');

      // Cowboy hat
      const hat = mkEl('div',
        'position:absolute;top:-30px;left:10px;font-size:38px;line-height:1;z-index:10;' +
        'animation:hatBounce 3.2s ease-in-out infinite;' +
        'filter:drop-shadow(0 3px 7px rgba(0,0,0,0.75));');
      hat.textContent = '\\u{1F920}';
      s1.appendChild(hat);

      // Avatar
      s1.appendChild(makeAvatar(u.profilePictureUrl, 72, '#d4a84b', 'rgba(180,120,10,0.8)'));

      // Right side
      const info1 = mkEl('div', 'flex:1;min-width:0;');

      // "LENDA" badge
      const badge = mkEl('div',
        'font-size:8px;color:#3d1e00;letter-spacing:2px;text-transform:uppercase;' +
        'margin-bottom:5px;animation:legendPulse 2.2s ease-in-out infinite;',
        '\\u2605 LENDA DO OESTE \\u2605');
      info1.appendChild(badge);

      // Name
      const nm1 = mkEl('div',
        'font-size:17px;color:#1e0d00;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
        'max-width:215px;text-shadow:1px 1px 2px rgba(255,255,255,0.15);margin-bottom:5px;');
      nm1.textContent = u.nickname;
      info1.appendChild(nm1);

      // Value — shimmer gold
      const vl1 = mkEl('div',
        'font-size:14px;font-weight:bold;' +
        'background:linear-gradient(90deg,#7a4800,#d4a030,#f0c040,#d4a030,#7a4800);' +
        'background-size:200% auto;-webkit-background-clip:text;-webkit-text-fill-color:transparent;' +
        'animation:shimmerGold 2.5s linear infinite;');
      vl1.textContent = icon + ' ' + u.${valueKey}.toLocaleString('pt-BR');
      info1.appendChild(vl1);

      s1.appendChild(info1);

      // Wax seal / stamp
      const seal = mkEl('div',
        'position:absolute;bottom:7px;right:9px;font-size:20px;opacity:0.3;transform:rotate(18deg);');
      seal.textContent = '\\u2605';
      s1.appendChild(seal);

      vo.appendChild(s1);
      setTimeout(() => spawnDust(s1), 200);
    }

    // ══════════════════════════════════════
    //  2nd & 3rd PLACE
    // ══════════════════════════════════════
    const rowDefs = [
      { label:'II',  medalGrad:'linear-gradient(145deg,#e8e8e8,#a8a8a8,#d0d0d0)', medalBorder:'#808080',
        rowBorder:'rgba(160,160,160,0.25)', glowColor:'rgba(180,180,180,0.4)', textColor:'#c8c8c8',
        valColor:'rgba(210,210,210,0.9)', delay:'0.72s', anim:'voEntrada2' },
      { label:'III', medalGrad:'linear-gradient(145deg,#e0a060,#cd7f32,#a05020)', medalBorder:'#8b5a1a',
        rowBorder:'rgba(150,90,20,0.28)', glowColor:'rgba(160,100,20,0.45)', textColor:'#c09060',
        valColor:'rgba(190,130,60,0.9)', delay:'0.88s', anim:'voEntrada3' },
    ];

    sorted.slice(1).forEach((u, idx) => {
      const rd = rowDefs[idx];
      const row = mkEl('div',
        'display:flex;align-items:center;gap:10px;padding:9px 11px;margin-bottom:6px;border-radius:3px;' +
        'background:linear-gradient(135deg,rgba(38,18,4,0.92),rgba(22,10,2,0.97));' +
        'border:1px solid ' + rd.rowBorder + ';' +
        'box-shadow:inset 0 0 14px rgba(0,0,0,0.45),0 3px 8px rgba(0,0,0,0.45);' +
        'animation:' + rd.anim + ' ' + rd.delay + ' cubic-bezier(.22,1,.36,1) both;');

      // Medal badge
      const medal = mkEl('div',
        'width:32px;height:32px;border-radius:50%;flex-shrink:0;' +
        'background:' + rd.medalGrad + ';border:1px solid ' + rd.medalBorder + ';' +
        'display:flex;align-items:center;justify-content:center;font-size:10px;color:#1a0a00;' +
        'box-shadow:0 2px 6px rgba(0,0,0,0.5),inset 0 1px 2px rgba(255,255,255,0.25);',
        rd.label);
      row.appendChild(medal);

      // Avatar
      row.appendChild(makeAvatar(u.profilePictureUrl, 42, rd.medalBorder, rd.glowColor));

      // Name + value
      const infoSm = mkEl('div', 'flex:1;min-width:0;');
      const nmSm = mkEl('div',
        'font-size:13px;color:' + rd.textColor + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
        'max-width:200px;text-shadow:0 1px 4px rgba(0,0,0,0.9);margin-bottom:3px;');
      nmSm.textContent = u.nickname;
      infoSm.appendChild(nmSm);
      infoSm.appendChild(mkEl('div',
        'font-size:11px;color:' + rd.valColor + ';text-shadow:0 1px 3px rgba(0,0,0,0.7);',
        icon + ' ' + u.${valueKey}.toLocaleString('pt-BR')));
      row.appendChild(infoSm);

      vo.appendChild(row);
      setTimeout(() => spawnDust(row), 300 + idx * 120);
    });
  }

  function renderRanking(data) {
    if (currentTheme === 'velho-oeste') { renderVelhoOeste(data); return; }

    const isRight = currentSide === 'right';
    const sorted = Object.entries(data)
      .map(([id, d]) => ({ id, ...d }))
      .sort((a, b) => b.${valueKey} - a.${valueKey})
      .slice(0, 20);

    if (sorted.length === 0) {
      list.innerHTML = '<div class="empty">Aguardando dados...</div>';
      return;
    }

    list.innerHTML = sorted.map((user, i) => {
      const pos = i + 1;
      const posClass = pos <= 3 ? 'pos-' + pos : 'pos-other';
      const frameClass = pos <= 3 ? 'avatar-frame-' + pos : '';
      const avatar = user.profilePictureUrl
        ? '<img src="' + user.profilePictureUrl + '" onerror="this.parentElement.innerHTML=String.fromCodePoint(128100)" style="width:100%;height:100%;object-fit:cover;">'
        : String.fromCodePoint(128100);
      const val = user.${valueKey}.toLocaleString();
      return '<div class="ranking-item" style="flex-direction:' + (isRight ? 'row-reverse' : 'row') + '">' +
        '<div class="pos ' + posClass + '">' + pos + '</div>' +
        '<div class="avatar ' + frameClass + '">' + avatar + '</div>' +
        '<div class="user-info" style="text-align:' + (isRight ? 'right' : 'left') + '">' +
        '<div class="user-name">' + esc(user.nickname) + '</div>' +
        '<div class="user-value">${valueIcon} ' + val + '</div>' +
        '</div></div>';
    }).join('');
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  const dynStyle = document.createElement('style');
  dynStyle.id = 'dynamic-style';
  document.head.appendChild(dynStyle);
</script>
</body>
</html>`;
}

function getRankingPointsHTML(roomId) {
  const sseUrl = `/sse/${roomId}/ranking/points`;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=MedievalSharp&family=Press+Start+2P&family=Rye&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:transparent; font-family:'Segoe UI',-apple-system,sans-serif; color:white; padding:16px; overflow-y:auto; transition:background 0.3s; }
  .ranking-list { display:flex; flex-direction:column; gap:6px; }
  .ranking-item { display:flex; align-items:center; gap:10px; flex-direction:row; background:transparent; border-radius:12px; padding:8px 14px; transition:all 0.3s; }
  .pos { width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:800; flex-shrink:0; }
  .pos-1 { background:linear-gradient(135deg,#f1c40f,#e67e22); color:#1a1a2e; }
  .pos-2 { background:linear-gradient(135deg,#bdc3c7,#95a5a6); color:#1a1a2e; }
  .pos-3 { background:linear-gradient(135deg,#e67e22,#d35400); color:#1a1a2e; }
  .pos-other { background:rgba(255,255,255,0.15); color:rgba(255,255,255,0.6); }
  .avatar { width:42px; height:42px; border-radius:50%; background:rgba(255,255,255,0.1); overflow:hidden; flex-shrink:0; display:flex; align-items:center; justify-content:center; font-size:16px; }
  .avatar img { width:100%; height:100%; object-fit:cover; }
  .avatar-frame-1 { border:3px solid #f1c40f; box-shadow:0 0 12px rgba(241,196,15,0.5); }
  .avatar-frame-2 { border:3px solid #bdc3c7; box-shadow:0 0 10px rgba(189,195,199,0.4); }
  .avatar-frame-3 { border:3px solid #e67e22; box-shadow:0 0 10px rgba(230,126,34,0.4); }
  .user-info { flex:1; min-width:0; text-align:left; }
  .user-name { font-size:14px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-shadow:0 1px 4px rgba(0,0,0,0.8); }
  .user-value { font-size:13px; font-weight:800; text-shadow:0 1px 4px rgba(0,0,0,0.8); }
  .val-num { }
  .val-label { font-size:11px; font-weight:600; margin-left:3px; }
  .empty { text-align:center; color:rgba(255,255,255,0.3); padding:40px; font-size:14px; }

  /* THEME: CLEAN */
  .theme-clean .ranking-item { background:transparent; }
  /* THEME: NEON */
  .theme-neon .ranking-item { background:rgba(10,10,30,0.7); border:1px solid rgba(0,212,255,0.3); box-shadow:0 0 8px rgba(0,212,255,0.1); }
  .theme-neon .user-name { color:#00d4ff; text-shadow:0 0 8px rgba(0,212,255,0.5); }
  .theme-neon .avatar-frame-1 { border-color:#00d4ff; box-shadow:0 0 15px rgba(0,212,255,0.6); }
  .theme-neon .avatar-frame-2 { border-color:#ff3366; box-shadow:0 0 12px rgba(255,51,102,0.4); }
  .theme-neon .avatar-frame-3 { border-color:#ffd700; box-shadow:0 0 12px rgba(255,215,0,0.4); }
  /* THEME: MEDIEVAL */
  .theme-medieval .ranking-item { background:rgba(30,20,10,0.8); border:1px solid rgba(201,164,74,0.4); font-family:'MedievalSharp',cursive; }
  .theme-medieval .avatar-frame-1 { border-color:#ffd700; box-shadow:0 0 15px rgba(255,215,0,0.5); }
  .theme-medieval .avatar-frame-2 { border-color:#c0c0c0; box-shadow:0 0 12px rgba(192,192,192,0.4); }
  .theme-medieval .avatar-frame-3 { border-color:#cd7f32; box-shadow:0 0 12px rgba(205,127,50,0.4); }
  /* THEME: RETRO */
  .theme-retro .ranking-item { background:rgba(0,0,0,0.85); border:1px solid #39ff14; font-family:'Press Start 2P',monospace; }
  .theme-retro .user-name { color:#39ff14; font-size:10px; text-shadow:0 0 6px rgba(57,255,20,0.6); }
  .theme-retro .avatar-frame-1 { border-color:#39ff14; box-shadow:0 0 10px rgba(57,255,20,0.6); }
  .theme-retro .avatar-frame-2 { border-color:#00ffff; }
  .theme-retro .avatar-frame-3 { border-color:#ff00ff; }
  /* THEME: FIRE */
  .theme-fire .ranking-item { background:rgba(40,10,0,0.8); border:1px solid rgba(255,107,53,0.4); }
  .theme-fire .user-name { color:#fff44f; }
  .theme-fire .avatar-frame-1 { border-color:#ff4500; box-shadow:0 0 15px rgba(255,69,0,0.6),0 0 30px rgba(255,69,0,0.3); }
  .theme-fire .avatar-frame-2 { border-color:#ff6b35; }
  .theme-fire .avatar-frame-3 { border-color:#ffd700; }
  /* THEME: ICE */
  .theme-ice .ranking-item { background:rgba(10,20,40,0.8); border:1px solid rgba(135,206,235,0.3); }
  .theme-ice .user-name { color:#e0f0ff; }
  .theme-ice .avatar-frame-1 { border-color:#87ceeb; box-shadow:0 0 15px rgba(135,206,235,0.6); }
  .theme-ice .avatar-frame-2 { border-color:#b0e0e6; }
  .theme-ice .avatar-frame-3 { border-color:#4fc3f7; }
  /* THEME: ROSA */
  .theme-rosa .ranking-item { background:linear-gradient(135deg,rgba(60,15,40,0.85),rgba(45,10,30,0.85)); border:1px solid rgba(255,105,180,0.4); box-shadow:0 0 12px rgba(255,105,180,0.18); }
  .theme-rosa .user-name { color:#ffd1e7; text-shadow:0 0 8px rgba(255,105,180,0.5); }
  .theme-rosa .avatar-frame-1 { border-color:#ff69b4; box-shadow:0 0 18px rgba(255,105,180,0.7); }
  .theme-rosa .avatar-frame-2 { border-color:#f9a8d4; box-shadow:0 0 12px rgba(249,168,212,0.5); }
  .theme-rosa .avatar-frame-3 { border-color:#ec4899; box-shadow:0 0 12px rgba(236,72,153,0.5); }
  /* THEME: ROYALTY */
  @keyframes royalGlow { 0%,100%{box-shadow:0 0 15px rgba(255,215,0,0.4),0 0 30px rgba(186,133,255,0.2);} 50%{box-shadow:0 0 25px rgba(255,215,0,0.7),0 0 50px rgba(186,133,255,0.4);} }
  @keyframes crownFloat { 0%,100%{transform:translateY(0) rotate(-5deg);} 50%{transform:translateY(-3px) rotate(5deg);} }
  .theme-royalty .ranking-item { background:linear-gradient(135deg,rgba(60,20,100,0.9),rgba(40,10,70,0.85),rgba(60,20,100,0.9)); border:1px solid rgba(255,215,0,0.35); box-shadow:inset 0 0 20px rgba(186,133,255,0.08),0 2px 8px rgba(0,0,0,0.3); position:relative; }
  .theme-royalty .ranking-item:nth-child(1) { border:2px solid rgba(255,215,0,0.7); animation:royalGlow 3s ease-in-out infinite; background:linear-gradient(135deg,rgba(80,30,120,0.95),rgba(50,15,80,0.9),rgba(80,30,120,0.95)); }
  .theme-royalty .ranking-item:nth-child(1)::before { content:'\\1F451'; position:absolute; top:-18px; left:50%; transform:translateX(-50%); font-size:28px; animation:crownFloat 2s ease-in-out infinite; filter:drop-shadow(0 0 8px rgba(255,215,0,0.8)); z-index:10; }
  .theme-royalty .ranking-item:nth-child(1) { margin-top:14px; }
  .theme-royalty .user-name { color:#f0e6ff; font-weight:800; }
  .theme-royalty .ranking-item:nth-child(1) .user-name { color:#ffd700; text-shadow:0 0 10px rgba(255,215,0,0.6); }
  .theme-royalty .pos-1 { background:linear-gradient(135deg,#ffd700,#ffaa00,#ffd700); color:#3a1560; font-weight:900; box-shadow:0 0 12px rgba(255,215,0,0.6); }
  .theme-royalty .pos-2 { background:linear-gradient(135deg,#c0c0c0,#e8e8e8,#c0c0c0); color:#3a1560; }
  .theme-royalty .pos-3 { background:linear-gradient(135deg,#cd7f32,#e8a952,#cd7f32); color:#3a1560; }
  .theme-royalty .avatar-frame-1 { border:3px solid #ffd700; box-shadow:0 0 20px rgba(255,215,0,0.7),0 0 40px rgba(255,215,0,0.3),inset 0 0 8px rgba(255,215,0,0.2); }
  .theme-royalty .avatar-frame-2 { border:3px solid #c0c0c0; box-shadow:0 0 15px rgba(192,192,192,0.5); }
  .theme-royalty .avatar-frame-3 { border:3px solid #cd7f32; box-shadow:0 0 12px rgba(205,127,50,0.5); }
  /* THEME: CUSTOM */
  .theme-custom .ranking-item { background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.1); }
</style>
</head>
<body>
<div id="theme-wrapper" class="theme-clean">
<div class="ranking-list" id="list"></div>
</div>
<script>
  const list = document.getElementById('list');
  const wrapper = document.getElementById('theme-wrapper');
  let currentSide = 'left';
  let cfg = { label:'points', valueColor:'#f1c40f', labelColor:'#aaaaaa', nameColor:'#ffffff' };

  let evtSource = null;
  function connectSSE() {
    try {
      if (evtSource) { try { evtSource.close(); } catch(e){} }
      evtSource = new EventSource('${sseUrl}');
      evtSource.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'full') renderRanking(msg.data);
          if (msg.type === 'config') applyConfig(msg);
        } catch(err) {}
      };
      evtSource.onerror = () => {
        try { evtSource.close(); } catch(e){}
        setTimeout(connectSSE, 3000);
      };
    } catch(e) {
      setTimeout(connectSSE, 3000);
    }
  }
  connectSSE();

  function applyConfig(c) {
    if (c.label !== undefined) cfg.label = c.label;
    if (c.valueColor !== undefined) cfg.valueColor = c.valueColor;
    if (c.labelColor !== undefined) cfg.labelColor = c.labelColor;
    if (c.nameColor !== undefined) cfg.nameColor = c.nameColor;
    if (c.theme !== undefined) {
      wrapper.className = 'theme-' + c.theme;
      document.body.style.background = (c.theme === 'custom' && c.customColor) ? c.customColor : 'transparent';
    }
    if (c.bg !== undefined && c.theme !== 'custom') document.body.style.background = c.bg;
    if (c.side !== undefined) {
      currentSide = c.side;
      document.querySelectorAll('.ranking-item').forEach(item => item.style.flexDirection = c.side === 'right' ? 'row-reverse' : 'row');
      document.querySelectorAll('.user-info').forEach(el => el.style.textAlign = c.side === 'right' ? 'right' : 'left');
    }
    // Re-apply colors to existing items
    document.querySelectorAll('.user-name').forEach(el => el.style.color = cfg.nameColor);
    document.querySelectorAll('.val-num').forEach(el => el.style.color = cfg.valueColor);
    document.querySelectorAll('.val-label').forEach(el => el.style.color = cfg.labelColor);
  }

  function renderRanking(data) {
    const sorted = Object.entries(data)
      .map(([id, d]) => ({ id, ...d }))
      .sort((a, b) => b.points - a.points)
      .slice(0, 20);
    list.innerHTML = '';
    if (sorted.length === 0) {
      list.innerHTML = '<div class="empty">Nenhum ponto registrado ainda</div>';
      return;
    }
    sorted.forEach((u, i) => {
      const pos = i + 1;
      const item = document.createElement('div');
      item.className = 'ranking-item';
      item.style.flexDirection = currentSide === 'right' ? 'row-reverse' : 'row';

      const posEl = document.createElement('div');
      posEl.className = 'pos ' + (pos <= 3 ? 'pos-' + pos : 'pos-other');
      posEl.textContent = pos;

      const av = document.createElement('div');
      av.className = 'avatar' + (pos <= 3 ? ' avatar-frame-' + pos : '');
      if (u.profilePictureUrl) {
        const img = document.createElement('img');
        img.src = u.profilePictureUrl;
        img.onerror = () => { av.textContent = '\\u{1F464}'; };
        av.appendChild(img);
      } else { av.textContent = '\\u{1F464}'; }

      const info = document.createElement('div');
      info.className = 'user-info';
      info.style.textAlign = currentSide === 'right' ? 'right' : 'left';

      const name = document.createElement('div');
      name.className = 'user-name';
      name.style.color = cfg.nameColor;
      name.textContent = u.nickname || u.id;

      const valWrap = document.createElement('div');
      valWrap.className = 'user-value';

      const valNum = document.createElement('span');
      valNum.className = 'val-num';
      valNum.style.color = cfg.valueColor;
      valNum.textContent = (u.points || 0).toLocaleString('pt-BR');

      const valLbl = document.createElement('span');
      valLbl.className = 'val-label';
      valLbl.style.color = cfg.labelColor;
      valLbl.textContent = ' ' + cfg.label;

      valWrap.appendChild(valNum);
      valWrap.appendChild(valLbl);
      info.appendChild(name);
      info.appendChild(valWrap);
      item.appendChild(posEl);
      item.appendChild(av);
      item.appendChild(info);
      list.appendChild(item);
    });
  }
</script>
</body>
</html>`;
}

function getCharactersHTML(roomId) {
  const sseUrl = `/sse/${roomId}/characters`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: transparent;
    overflow: hidden;
    width: 100vw;
    height: 100vh;
    font-family: 'Segoe UI', -apple-system, sans-serif;
  }

  /* Evolution overlay */
  #evolution-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    z-index: 100;
    background: rgba(0, 0, 0, 0.7);
  }
  #evolution-overlay.active { display: flex; }

  .evo-title {
    font-size: 28px;
    font-weight: 900;
    color: #f1c40f;
    text-shadow: 0 0 20px rgba(241,196,15,0.8), 0 4px 12px rgba(0,0,0,0.5);
    margin-bottom: 10px;
    animation: pulseGlow 1s ease-in-out infinite alternate;
  }
  @keyframes pulseGlow {
    from { text-shadow: 0 0 20px rgba(241,196,15,0.8); }
    to { text-shadow: 0 0 40px rgba(241,196,15,1), 0 0 60px rgba(241,196,15,0.5); }
  }

  .evo-nickname {
    font-size: 20px;
    color: white;
    margin-bottom: 20px;
    text-shadow: 0 2px 8px rgba(0,0,0,0.5);
  }

  .evo-chars {
    display: flex;
    align-items: center;
    gap: 30px;
    margin-bottom: 20px;
  }
  .evo-char {
    width: 350px;
    height: 450px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .evo-char img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    filter: drop-shadow(0 0 12px rgba(255,255,255,0.3));
  }
  .evo-char.old { opacity: 0.5; animation: fadeOut 2s forwards; }
  .evo-char.new { animation: scaleIn 0.8s ease-out; }
  .evo-arrow {
    font-size: 48px;
    color: #f1c40f;
    animation: arrowPulse 0.8s ease-in-out infinite alternate;
  }
  @keyframes fadeOut { to { opacity: 0.2; transform: scale(0.8); } }
  @keyframes scaleIn {
    from { transform: scale(0) rotate(-10deg); opacity: 0; }
    to { transform: scale(1) rotate(0deg); opacity: 1; }
  }
  @keyframes arrowPulse {
    from { transform: translateX(-5px); }
    to { transform: translateX(5px); }
  }

  .evo-level {
    font-size: 24px;
    font-weight: 800;
    color: #2ecc71;
    text-shadow: 0 0 10px rgba(46,204,113,0.5);
  }

  /* Particles */
  .particle {
    position: fixed;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    pointer-events: none;
    animation: particleFloat 2s ease-out forwards;
  }
  @keyframes particleFloat {
    0% { opacity: 1; transform: translateY(0) scale(1); }
    100% { opacity: 0; transform: translateY(-200px) scale(0); }
  }

  @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@700;900&family=Orbitron:wght@700;900&display=swap');

  /* Character appear */
  #appear-container {
    position: fixed;
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    display: none;
    flex-direction: column;
    align-items: center;
    z-index: 50;
    padding-bottom: 10px;
  }
  #appear-container.active { display: flex; }

  .appear-char {
    width: 400px;
    height: 500px;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    animation: bounceIn 0.6s ease-out;
  }
  .appear-char img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    filter: drop-shadow(0 4px 20px rgba(0,0,0,0.6));
  }
  @keyframes bounceIn {
    0% { transform: translateY(100px) scale(0); opacity: 0; }
    60% { transform: translateY(-10px) scale(1.1); opacity: 1; }
    100% { transform: translateY(0) scale(1); opacity: 1; }
  }

  .appear-info {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-top: 4px;
    gap: 3px;
  }

  .appear-name {
    font-family: 'Cinzel', serif;
    font-size: 26px;
    font-weight: 900;
    color: #fff;
    text-shadow: 0 0 15px rgba(255,215,0,0.8), 0 2px 4px rgba(0,0,0,0.8);
    letter-spacing: 2px;
    text-transform: uppercase;
  }

  .appear-health {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }
  .appear-health-label {
    font-family: 'Orbitron', sans-serif;
    font-size: 13px;
    font-weight: 700;
    color: #ff4444;
    text-shadow: 0 0 8px rgba(255,68,68,0.6);
  }
  .appear-health-bar {
    width: 180px;
    height: 14px;
    background: rgba(0,0,0,0.6);
    border-radius: 7px;
    border: 1px solid rgba(255,68,68,0.4);
    overflow: hidden;
    position: relative;
  }
  .appear-health-fill {
    height: 100%;
    border-radius: 7px;
    background: linear-gradient(90deg, #ff4444, #ff6b6b);
    box-shadow: 0 0 10px rgba(255,68,68,0.5);
    transition: width 0.5s ease;
  }
  .appear-health-text {
    font-family: 'Orbitron', sans-serif;
    font-size: 11px;
    font-weight: 700;
    color: #fff;
    text-shadow: 0 1px 2px rgba(0,0,0,0.8);
  }

  .appear-role {
    font-family: 'Cinzel', serif;
    font-size: 15px;
    font-weight: 700;
    color: #00e5ff;
    text-shadow: 0 0 12px rgba(0,229,255,0.6), 0 1px 3px rgba(0,0,0,0.6);
    letter-spacing: 3px;
    text-transform: uppercase;
    margin-top: 1px;
  }
</style>
</head>
<body>

<div id="evolution-overlay"></div>
<div id="appear-container">
  <div class="appear-char" id="appear-char"></div>
  <div class="appear-info">
    <div class="appear-name" id="appear-name"></div>
    <div class="appear-health">
      <span class="appear-health-label">HP</span>
      <div class="appear-health-bar"><div class="appear-health-fill" id="appear-hp"></div></div>
      <span class="appear-health-text" id="appear-hp-text"></span>
    </div>
    <div class="appear-role" id="appear-role"></div>
  </div>
</div>

<script>
  const evoOverlay = document.getElementById('evolution-overlay');
  const appearContainer = document.getElementById('appear-container');
  const appearChar = document.getElementById('appear-char');
  const appearName = document.getElementById('appear-name');

  const queue = [];
  let isBusy = false;

  const evtSource = new EventSource('${sseUrl}');
  evtSource.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.eventType || msg.type === 'evolution' || msg.type === 'appear' || msg.type === 'character') {
      queue.push(msg);
      if (!isBusy) processNext();
    }
  };

  function processNext() {
    if (queue.length === 0) { isBusy = false; return; }
    isBusy = true;
    const evt = queue.shift();
    const subType = evt.eventType || evt.type;

    if (subType === 'evolution' || evt.fromLevel !== undefined) {
      showEvolution(evt);
    } else if (subType === 'appear' || evt.image) {
      showAppear(evt);
    } else {
      processNext();
    }
  }

  function showEvolution(data) {
    const prevImg = data.prevImage || '';
    const newImg = data.newImage || '';

    evoOverlay.innerHTML =
      '<div class="evo-title">\\u2B50 EVOLU\\u00C7\\u00C3O! \\u2B50</div>' +
      '<div class="evo-nickname">' + esc(data.nickname) + '</div>' +
      '<div class="evo-chars">' +
        (prevImg ? '<div class="evo-char old"><img src="' + prevImg + '"></div>' : '') +
        '<div class="evo-arrow">\\u27A1\\uFE0F</div>' +
        '<div class="evo-char new"><img src="' + newImg + '"></div>' +
      '</div>' +
      '<div class="evo-level">N\\u00EDvel ' + data.toLevel + ' - ' + esc(data.charName || '') + '</div>';

    evoOverlay.classList.add('active');
    spawnParticles();

    setTimeout(() => {
      evoOverlay.classList.remove('active');
      evoOverlay.innerHTML = '';
      processNext();
    }, 6000);
  }

  function showAppear(data) {
    const img = data.image || '';
    if (!img) { processNext(); return; }

    const duration = (data.duration || 5) * 1000;

    appearChar.innerHTML = '<img src="' + img + '">';

    appearName.textContent = esc(data.nickname);

    // HP based on level: lv10=200, lv20=450, lv30=700, lv40=900, lv50=1200
    const hpMap = { 10: 200, 20: 450, 30: 700, 40: 900, 50: 1200 };
    const lvl = data.level || 10;
    const hp = hpMap[lvl] || 200;
    const maxHp = 1200;
    document.getElementById('appear-hp').style.width = ((hp / maxHp) * 100) + '%';
    document.getElementById('appear-hp-text').textContent = hp + '/' + hp;

    // Role/function
    const role = data.role || data.charName || '';
    document.getElementById('appear-role').textContent = role;
    document.getElementById('appear-role').style.display = role ? 'block' : 'none';

    appearContainer.classList.add('active');

    setTimeout(() => {
      appearContainer.classList.remove('active');
      processNext();
    }, duration);
  }

  function spawnParticles() {
    const colors = ['#f1c40f', '#e74c3c', '#3498db', '#2ecc71', '#9b59b6', '#e67e22'];
    for (let i = 0; i < 30; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      p.style.background = colors[Math.floor(Math.random() * colors.length)];
      p.style.left = (Math.random() * 100) + 'vw';
      p.style.top = (50 + Math.random() * 40) + 'vh';
      p.style.animationDelay = (Math.random() * 1) + 's';
      p.style.width = (4 + Math.random() * 8) + 'px';
      p.style.height = p.style.width;
      document.body.appendChild(p);
      setTimeout(() => p.remove(), 3000);
    }
  }

  function esc(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
</script>
</body>
</html>`;
}

// ============================================
// SCOREBOARD OVERLAY HTML
// ============================================
function getScoreboardHTML(roomId) {
  const sseUrl = `/sse/${roomId}/scoreboard`;
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Cinzel:wght@700;900&family=Press+Start+2P&family=Russo+One&family=Rajdhani:wght@700&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
  }

  .scoreboard {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    position: relative;
  }

  .sb-side {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 12px 28px;
    min-width: 180px;
    position: relative;
  }

  .sb-name {
    font-size: 18px;
    font-weight: 900;
    letter-spacing: 2px;
    text-transform: uppercase;
    margin-bottom: 4px;
  }

  .sb-score {
    font-size: 64px;
    font-weight: 900;
    line-height: 1;
  }

  .sb-vs {
    font-size: 22px;
    font-weight: 900;
    padding: 8px 14px;
    z-index: 5;
  }

  /* ===== THEME: NEON ===== */
  .theme-neon .sb-side.left {
    background: linear-gradient(135deg, rgba(0,200,255,0.15), rgba(0,100,255,0.25));
    border: 2px solid #00d4ff;
    border-radius: 16px 0 0 16px;
    box-shadow: 0 0 25px rgba(0,212,255,0.3), inset 0 0 20px rgba(0,212,255,0.1);
  }
  .theme-neon .sb-side.right {
    background: linear-gradient(135deg, rgba(255,50,50,0.25), rgba(255,0,80,0.15));
    border: 2px solid #ff3366;
    border-radius: 0 16px 16px 0;
    box-shadow: 0 0 25px rgba(255,51,102,0.3), inset 0 0 20px rgba(255,51,102,0.1);
  }
  .theme-neon .sb-name { font-family: 'Orbitron', sans-serif; }
  .theme-neon .sb-side.left .sb-name { color: #00d4ff; text-shadow: 0 0 15px rgba(0,212,255,0.8); }
  .theme-neon .sb-side.right .sb-name { color: #ff3366; text-shadow: 0 0 15px rgba(255,51,102,0.8); }
  .theme-neon .sb-score { font-family: 'Orbitron', sans-serif; color: #fff; text-shadow: 0 0 20px rgba(255,255,255,0.5); }
  .theme-neon .sb-vs {
    font-family: 'Orbitron', sans-serif;
    color: #ffd700;
    text-shadow: 0 0 15px rgba(255,215,0,0.8);
    background: rgba(0,0,0,0.6);
    border-radius: 50%;
    width: 50px; height: 50px;
    display: flex; align-items: center; justify-content: center;
    border: 2px solid #ffd700;
    box-shadow: 0 0 20px rgba(255,215,0,0.3);
  }

  /* ===== THEME: MEDIEVAL ===== */
  .theme-medieval .sb-side.left {
    background: linear-gradient(135deg, rgba(40,60,120,0.8), rgba(20,30,80,0.9));
    border: 3px solid #8b7355;
    border-radius: 12px 0 0 12px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,215,0,0.2);
  }
  .theme-medieval .sb-side.right {
    background: linear-gradient(135deg, rgba(120,30,30,0.8), rgba(80,10,10,0.9));
    border: 3px solid #8b7355;
    border-radius: 0 12px 12px 0;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,215,0,0.2);
  }
  .theme-medieval .sb-name { font-family: 'Cinzel', serif; color: #ffd700; text-shadow: 0 2px 4px rgba(0,0,0,0.8); }
  .theme-medieval .sb-score { font-family: 'Cinzel', serif; color: #fff; text-shadow: 0 3px 6px rgba(0,0,0,0.6); }
  .theme-medieval .sb-vs {
    font-family: 'Cinzel', serif;
    color: #ffd700;
    background: linear-gradient(135deg, #5c4033, #3e2723);
    border: 3px solid #8b7355;
    border-radius: 8px;
    padding: 6px 12px;
    box-shadow: 0 4px 15px rgba(0,0,0,0.5);
  }

  /* ===== THEME: RETRO/ARCADE ===== */
  .theme-retro .sb-side.left {
    background: #111;
    border: 3px solid #00ff41;
    border-radius: 4px 0 0 4px;
    box-shadow: 0 0 10px rgba(0,255,65,0.3), inset 0 0 15px rgba(0,255,65,0.05);
  }
  .theme-retro .sb-side.right {
    background: #111;
    border: 3px solid #ff00ff;
    border-radius: 0 4px 4px 0;
    box-shadow: 0 0 10px rgba(255,0,255,0.3), inset 0 0 15px rgba(255,0,255,0.05);
  }
  .theme-retro .sb-name { font-family: 'Press Start 2P', monospace; font-size: 11px; }
  .theme-retro .sb-side.left .sb-name { color: #00ff41; }
  .theme-retro .sb-side.right .sb-name { color: #ff00ff; }
  .theme-retro .sb-score { font-family: 'Press Start 2P', monospace; font-size: 48px; color: #fff; }
  .theme-retro .sb-vs {
    font-family: 'Press Start 2P', monospace;
    font-size: 14px;
    color: #ffff00;
    background: #111;
    border: 2px solid #ffff00;
    padding: 6px 10px;
  }

  /* ===== THEME: FIRE ===== */
  .theme-fire .sb-side.left {
    background: linear-gradient(180deg, rgba(255,100,0,0.3), rgba(200,50,0,0.5));
    border: 2px solid #ff6600;
    border-radius: 14px 0 0 14px;
    box-shadow: 0 0 30px rgba(255,100,0,0.3), inset 0 -10px 30px rgba(255,50,0,0.2);
  }
  .theme-fire .sb-side.right {
    background: linear-gradient(180deg, rgba(255,100,0,0.3), rgba(200,50,0,0.5));
    border: 2px solid #ff6600;
    border-radius: 0 14px 14px 0;
    box-shadow: 0 0 30px rgba(255,100,0,0.3), inset 0 -10px 30px rgba(255,50,0,0.2);
  }
  .theme-fire .sb-name { font-family: 'Russo One', sans-serif; color: #ffd700; text-shadow: 0 0 10px rgba(255,100,0,0.8), 0 2px 4px rgba(0,0,0,0.5); }
  .theme-fire .sb-score { font-family: 'Russo One', sans-serif; color: #fff; text-shadow: 0 0 15px rgba(255,150,0,0.6); }
  .theme-fire .sb-vs {
    font-family: 'Russo One', sans-serif;
    color: #ffd700;
    background: rgba(200,50,0,0.7);
    border: 2px solid #ff6600;
    border-radius: 50%;
    width: 48px; height: 48px;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 0 20px rgba(255,100,0,0.5);
  }

  /* ===== THEME: ICE ===== */
  .theme-ice .sb-side.left {
    background: linear-gradient(180deg, rgba(100,200,255,0.2), rgba(50,150,220,0.35));
    border: 2px solid rgba(150,220,255,0.6);
    border-radius: 14px 0 0 14px;
    box-shadow: 0 0 25px rgba(100,200,255,0.2), inset 0 0 20px rgba(200,240,255,0.08);
  }
  .theme-ice .sb-side.right {
    background: linear-gradient(180deg, rgba(100,200,255,0.2), rgba(50,150,220,0.35));
    border: 2px solid rgba(150,220,255,0.6);
    border-radius: 0 14px 14px 0;
    box-shadow: 0 0 25px rgba(100,200,255,0.2), inset 0 0 20px rgba(200,240,255,0.08);
  }
  .theme-ice .sb-name { font-family: 'Rajdhani', sans-serif; font-size: 20px; color: #b0e0ff; text-shadow: 0 0 12px rgba(150,220,255,0.7); }
  .theme-ice .sb-score { font-family: 'Rajdhani', sans-serif; color: #fff; text-shadow: 0 0 20px rgba(150,220,255,0.5); }
  .theme-ice .sb-vs {
    font-family: 'Rajdhani', sans-serif;
    color: #b0e0ff;
    background: rgba(30,80,120,0.7);
    border: 2px solid rgba(150,220,255,0.5);
    border-radius: 50%;
    width: 48px; height: 48px;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 0 15px rgba(100,200,255,0.3);
  }

  /* ===== THEME: ROSA ===== */
  .theme-rosa .sb-side.left {
    background: linear-gradient(180deg, rgba(75,15,50,0.85), rgba(50,10,35,0.9));
    border: 2px solid rgba(255,105,180,0.55);
    border-radius: 14px 0 0 14px;
    box-shadow: 0 0 25px rgba(255,105,180,0.3), inset 0 0 25px rgba(255,182,213,0.08);
  }
  .theme-rosa .sb-side.right {
    background: linear-gradient(180deg, rgba(95,20,55,0.85), rgba(60,10,35,0.9));
    border: 2px solid rgba(236,72,153,0.55);
    border-radius: 0 14px 14px 0;
    box-shadow: 0 0 25px rgba(236,72,153,0.3), inset 0 0 25px rgba(255,182,213,0.08);
  }
  .theme-rosa .sb-name { font-family: 'Poppins', sans-serif; font-weight: 700; }
  .theme-rosa .sb-side.left .sb-name { color: #ff69b4; text-shadow: 0 0 12px rgba(255,105,180,0.7); }
  .theme-rosa .sb-side.right .sb-name { color: #f9a8d4; text-shadow: 0 0 12px rgba(249,168,212,0.7); }
  .theme-rosa .sb-score { font-family: 'Poppins', sans-serif; font-weight: 900; color: #fff; text-shadow: 0 0 20px rgba(255,105,180,0.6); }
  .theme-rosa .sb-vs {
    font-family: 'Poppins', sans-serif;
    color: #ffd1e7;
    background: rgba(80,20,55,0.7);
    border: 2px solid rgba(255,105,180,0.55);
    border-radius: 50%;
    width: 48px; height: 48px;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 0 15px rgba(255,105,180,0.35);
  }

  /* ===== THEME: ROYALTY ===== */
  @keyframes royalPulse {
    0%, 100% { box-shadow: 0 0 20px rgba(255,215,0,0.3); }
    50% { box-shadow: 0 0 40px rgba(255,215,0,0.6); }
  }
  .theme-royalty .sb-side.left {
    background: linear-gradient(180deg, rgba(80,30,120,0.85), rgba(50,15,80,0.9));
    border: 2px solid rgba(255,215,0,0.5);
    border-radius: 14px 0 0 14px;
    box-shadow: 0 0 25px rgba(186,133,255,0.3), inset 0 0 30px rgba(255,215,0,0.05);
  }
  .theme-royalty .sb-side.right {
    background: linear-gradient(180deg, rgba(100,15,40,0.85), rgba(60,10,30,0.9));
    border: 2px solid rgba(255,215,0,0.5);
    border-radius: 0 14px 14px 0;
    box-shadow: 0 0 25px rgba(255,105,180,0.2), inset 0 0 30px rgba(255,215,0,0.05);
  }
  .theme-royalty .sb-name {
    font-family: 'Rajdhani', sans-serif;
    font-size: 20px;
    color: #ffd700;
    text-shadow: 0 0 12px rgba(255,215,0,0.6), 0 2px 4px rgba(0,0,0,0.5);
  }
  .theme-royalty .sb-score {
    font-family: 'Rajdhani', sans-serif;
    color: #fff;
    text-shadow: 0 0 20px rgba(255,215,0,0.5), 0 0 40px rgba(186,133,255,0.3);
  }
  .theme-royalty .sb-vs {
    font-family: 'Rajdhani', sans-serif;
    color: #ffd700;
    background: linear-gradient(135deg, rgba(60,20,100,0.9), rgba(40,10,70,0.95));
    border: 3px solid #ffd700;
    border-radius: 50%;
    width: 52px; height: 52px;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 0 25px rgba(255,215,0,0.5);
    animation: royalPulse 3s ease-in-out infinite;
    font-weight: 900;
  }

  /* Score change animation */
  @keyframes scorePop {
    0% { transform: scale(1); }
    50% { transform: scale(1.3); }
    100% { transform: scale(1); }
  }
  .score-pop { animation: scorePop 0.3s ease-out; }

  /* ===== ESTILO PREMIUM: Slim Esports HUD ===== */
  /* Corner accent divs — not used in slim premium, hidden */
  .sb-ca { display:none !important; }

  /* Override base layout to horizontal slim bar */
  .style-premium .sb-side {
    flex-direction: row !important;
    align-items: center !important;
    gap: 14px !important;
    padding: 7px 18px !important;
    min-width: 110px !important;
    background: rgba(5,8,18,0.80) !important;
    border: none !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    clip-path: none !important;
    position: relative;
    overflow: hidden;
  }
  /* Thin accent line on top */
  .style-premium .sb-side::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: rgba(255,255,255,0.25);
  }
  /* Right side: reverse so score appears first (inner) */
  .style-premium .sb-side.right { flex-direction: row-reverse !important; }

  /* Compact text sizes */
  .style-premium .sb-name {
    font-size: 11px !important;
    letter-spacing: 2px !important;
    margin-bottom: 0 !important;
    opacity: 0.9;
    white-space: nowrap;
  }
  .style-premium .sb-score {
    font-size: 40px !important;
    line-height: 1 !important;
  }

  /* VS separator — slim, no circle */
  .style-premium .sb-vs {
    background: rgba(5,8,18,0.80) !important;
    border: none !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    clip-path: none !important;
    animation: none !important;
    width: auto !important; height: auto !important;
    padding: 7px 10px !important;
    font-size: 12px !important;
    letter-spacing: 2px !important;
    position: relative;
    opacity: 0.7;
  }
  .style-premium .sb-vs::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: rgba(255,255,255,0.12);
  }

  /* ── Neon ── */
  .style-premium.theme-neon .sb-side.left::before  { background:#00d4ff; box-shadow:0 0 10px rgba(0,212,255,.7); }
  .style-premium.theme-neon .sb-side.right::before { background:#ff3366; box-shadow:0 0 10px rgba(255,51,102,.7); }
  .style-premium.theme-neon .sb-name.left-n  { color:#00d4ff; text-shadow:0 0 8px rgba(0,212,255,.7); }
  .style-premium.theme-neon .sb-name.right-n { color:#ff3366; text-shadow:0 0 8px rgba(255,51,102,.7); }
  .style-premium.theme-neon .sb-score { color:#fff; text-shadow:0 0 16px rgba(255,255,255,.3); }
  .style-premium.theme-neon .sb-vs { color:#ffd700; }

  /* ── Fire ── */
  .style-premium.theme-fire .sb-side::before { background:#ff6b35; box-shadow:0 0 10px rgba(255,107,53,.7); }
  .style-premium.theme-fire .sb-name  { color:#ffd700; text-shadow:0 0 8px rgba(255,107,53,.7); }
  .style-premium.theme-fire .sb-score { color:#fff; text-shadow:0 0 14px rgba(255,107,53,.4); }
  .style-premium.theme-fire .sb-vs   { color:#ffd700; }

  /* ── Ice ── */
  .style-premium.theme-ice .sb-side::before { background:#87ceeb; box-shadow:0 0 10px rgba(135,206,235,.7); }
  .style-premium.theme-ice .sb-name  { color:#b0e0ff; text-shadow:0 0 8px rgba(135,206,235,.6); }
  .style-premium.theme-ice .sb-score { color:#fff; text-shadow:0 0 14px rgba(135,206,235,.4); }
  .style-premium.theme-ice .sb-vs   { color:#b0e0ff; }

  /* ── Rosa ── */
  .style-premium.theme-rosa .sb-side::before { background:#ff69b4; box-shadow:0 0 10px rgba(255,105,180,.75); }
  .style-premium.theme-rosa .sb-name  { color:#ff69b4; text-shadow:0 0 8px rgba(255,105,180,.7); }
  .style-premium.theme-rosa .sb-score { color:#fff; text-shadow:0 0 14px rgba(255,105,180,.5); }
  .style-premium.theme-rosa .sb-vs   { color:#ff69b4; }

  /* ── Medieval ── */
  .style-premium.theme-medieval .sb-side::before { background:#c9a44a; box-shadow:0 0 10px rgba(201,164,74,.7); }
  .style-premium.theme-medieval .sb-name  { color:#ffd700; text-shadow:0 0 8px rgba(255,215,0,.6); }
  .style-premium.theme-medieval .sb-score { color:#fff; }
  .style-premium.theme-medieval .sb-vs   { color:#ffd700; }

  /* ── Retro ── */
  .style-premium.theme-retro .sb-side  { background:#090909 !important; }
  .style-premium.theme-retro .sb-side::before { background:#00ff41; box-shadow:0 0 10px rgba(0,255,65,.7); }
  .style-premium.theme-retro .sb-name  { color:#00ff41; }
  .style-premium.theme-retro .sb-score { color:#fff; }
  .style-premium.theme-retro .sb-vs   { background:#090909 !important; color:#ffff00; }

  /* ── Royalty ── */
  .style-premium.theme-royalty .sb-side::before { background:#ffd700; box-shadow:0 0 10px rgba(255,215,0,.7); }
  .style-premium.theme-royalty .sb-name  { color:#ffd700; text-shadow:0 0 8px rgba(255,215,0,.6); }
  .style-premium.theme-royalty .sb-score { color:#fff; text-shadow:0 0 16px rgba(186,133,255,.4); }
  .style-premium.theme-royalty .sb-vs   { color:#ffd700; }

  /* ── Custom ── */
  .style-premium.theme-custom .sb-side::before { background:rgba(255,255,255,.5); }
  .style-premium.theme-custom .sb-name  { color:#fff; }
  .style-premium.theme-custom .sb-score { color:#fff; }
  .style-premium.theme-custom .sb-vs   { color:#fff; }

  /* ===== THEME: CUSTOM ===== */
  .theme-custom .sb-side.left {
    background: rgba(0,0,0,0.5);
    border: 2px solid rgba(255,255,255,0.2);
    border-radius: 14px 0 0 14px;
  }
  .theme-custom .sb-side.right {
    background: rgba(0,0,0,0.5);
    border: 2px solid rgba(255,255,255,0.2);
    border-radius: 0 14px 14px 0;
  }
  .theme-custom .sb-name { font-family: 'Rajdhani', sans-serif; font-size: 20px; color: #fff; }
  .theme-custom .sb-score { font-family: 'Rajdhani', sans-serif; color: #ffd700; }
  .theme-custom .sb-vs {
    font-family: 'Rajdhani', sans-serif;
    color: #fff;
    background: rgba(0,0,0,0.6);
    border: 2px solid rgba(255,255,255,0.3);
    border-radius: 50%;
    width: 48px; height: 48px;
    display: flex; align-items: center; justify-content: center;
  }
</style>
</head>
<body>

<div class="scoreboard theme-neon" id="scoreboard">
  <div class="sb-side left">
    <div class="sb-ca sb-ca-tl"></div><div class="sb-ca sb-ca-tr"></div>
    <div class="sb-ca sb-ca-bl"></div><div class="sb-ca sb-ca-br"></div>
    <div class="sb-name left-n" id="sb-left-name">Streamer</div>
    <div class="sb-score" id="sb-left-score">0</div>
  </div>
  <div class="sb-vs" id="sb-vs">VS</div>
  <div class="sb-side right">
    <div class="sb-ca sb-ca-tl"></div><div class="sb-ca sb-ca-tr"></div>
    <div class="sb-ca sb-ca-bl"></div><div class="sb-ca sb-ca-br"></div>
    <div class="sb-name right-n" id="sb-right-name">Chat</div>
    <div class="sb-score" id="sb-right-score">0</div>
  </div>
</div>

<script>
  const board = document.getElementById('scoreboard');
  const leftName = document.getElementById('sb-left-name');
  const rightName = document.getElementById('sb-right-name');
  const leftScore = document.getElementById('sb-left-score');
  const rightScore = document.getElementById('sb-right-score');

  function popAnim(el) {
    el.classList.remove('score-pop');
    void el.offsetWidth;
    el.classList.add('score-pop');
  }

  const evtSource = new EventSource('${sseUrl}');
  evtSource.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'full') {
      const oldLeft = leftScore.textContent;
      const oldRight = rightScore.textContent;

      leftName.textContent = msg.leftName || 'Streamer';
      rightName.textContent = msg.rightName || 'Chat';
      leftScore.textContent = msg.left || 0;
      rightScore.textContent = msg.right || 0;

      if (String(msg.left) !== oldLeft) popAnim(leftScore);
      if (String(msg.right) !== oldRight) popAnim(rightScore);

      // Apply style + theme
      const theme = msg.theme || 'neon';
      const style = msg.style || 'default';
      board.className = 'scoreboard style-' + style + ' theme-' + theme;
      if (theme === 'custom' && msg.customColor) {
        document.body.style.background = msg.customColor;
      } else {
        document.body.style.background = 'transparent';
      }
    }
  };
</script>
</body>
</html>`;
}

// ============================================
// JAR OVERLAY HTML
// ============================================
function getJarHTML(roomId) {
  const sseUrl = `/sse/${roomId}/jar`;
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: transparent;
    overflow: hidden;
    width: 100vw;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .jar-scene {
    position: relative;
    width: 600px;
    height: 600px;
  }

  /* Physics gifts layer */
  .physics-container {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 12;
  }

  /* ===== VISUAL SWITCHING ===== */
  /* Default: show jar, hide chest */
  .chest-only { display: none !important; }
  .visual-chest .chest-only { display: block !important; }
  .visual-chest .default-only { display: none !important; }

  /* ===== RECTANGULAR JAR (default visual) ===== */

  /* Dark interior background — behind physics gifts */
  .jar-bg {
    position: absolute;
    left: 160px; top: 175px;
    width: 280px; height: 395px;
    background: rgba(3, 4, 10, 0.94);
    border-radius: 4px 4px 6px 6px;
    z-index: 8;
    pointer-events: none;
  }

  /* Jar body border — rendered ON TOP of gifts */
  .jar-border {
    position: absolute;
    left: 160px; top: 175px;
    width: 280px; height: 395px;
    border: 2.5px solid #c87941;
    border-radius: 4px 4px 6px 6px;
    box-shadow:
      0 0 14px rgba(200,121,65,0.85),
      0 0 30px rgba(180,100,40,0.5),
      inset 0 0 10px rgba(200,121,65,0.08);
    z-index: 20;
    pointer-events: none;
    transition: box-shadow 0.3s, border-color 0.3s;
  }

  /* Flat lid — on top of everything */
  .jar-lid {
    position: absolute;
    left: 152px; top: 143px;
    width: 296px; height: 32px;
    background: linear-gradient(180deg, #c08030 0%, #8a5520 55%, #5c3610 100%);
    border: 2.5px solid #d4813c;
    border-radius: 5px;
    box-shadow:
      0 0 16px rgba(212,129,60,0.95),
      0 0 34px rgba(180,100,30,0.55);
    z-index: 22;
    pointer-events: none;
    transition: background 0.3s, border-color 0.3s, box-shadow 0.3s;
  }

  /* Individual gift item */
  .gift-item {
    position: absolute;
    left: 0; top: 0;
    pointer-events: none;
    will-change: transform;
  }
  .gift-item img {
    width: 100%; height: 100%;
    object-fit: contain;
    filter: drop-shadow(0 1px 3px rgba(0,0,0,0.4));
  }
  .gift-item.gift-big img {
    filter: drop-shadow(0 0 8px rgba(255,215,0,0.6)) drop-shadow(0 2px 4px rgba(0,0,0,0.4));
  }

  /* Pulse on gift arrival */
  .jar-border.pulse {
    box-shadow:
      0 0 28px rgba(255,200,80,0.95),
      0 0 60px rgba(255,160,40,0.65),
      inset 0 0 18px rgba(255,200,80,0.18);
    transition: box-shadow 0s;
  }

  /* ===== THEMES ===== */

  /* CLEAN — white/silver neutral */
  .theme-clean .jar-border {
    border-color: #cccccc;
    box-shadow: 0 0 14px rgba(220,220,220,0.7), 0 0 30px rgba(200,200,200,0.35), inset 0 0 10px rgba(220,220,220,0.05);
  }
  .theme-clean .jar-lid {
    background: linear-gradient(180deg, #888888 0%, #555555 55%, #333333 100%);
    border-color: #cccccc;
    box-shadow: 0 0 16px rgba(220,220,220,0.75), 0 0 34px rgba(200,200,200,0.4);
  }
  .theme-clean .jar-border.pulse { box-shadow: 0 0 30px rgba(255,255,255,0.9), 0 0 65px rgba(220,220,220,0.55); }

  /* NEON — #00d4ff electric cyan (matches scoreboard neon theme) */
  .theme-neon .jar-bg   { background: rgba(0,5,20,0.96); }
  .theme-neon .jar-border {
    border-color: #00d4ff;
    box-shadow: 0 0 14px rgba(0,212,255,0.9), 0 0 30px rgba(0,212,255,0.5), inset 0 0 10px rgba(0,212,255,0.08);
  }
  .theme-neon .jar-lid {
    background: linear-gradient(180deg, #005f80 0%, #003050 55%, #001828 100%);
    border-color: #00d4ff;
    box-shadow: 0 0 16px rgba(0,212,255,0.95), 0 0 34px rgba(0,212,255,0.55);
  }
  .theme-neon .jar-border.pulse { box-shadow: 0 0 40px rgba(0,212,255,1.0), 0 0 80px rgba(0,212,255,0.65); }
  .theme-neon .gift-item img { filter: drop-shadow(0 0 5px rgba(0,212,255,0.45)) drop-shadow(0 1px 3px rgba(0,0,0,0.3)); }

  /* MEDIEVAL */
  .theme-medieval .jar-bg { background: rgba(5,3,0,0.96); }
  .theme-medieval .jar-border {
    border-color: #b8860b;
    box-shadow: 0 0 14px rgba(184,134,11,0.85), 0 0 30px rgba(139,90,43,0.5);
  }
  .theme-medieval .jar-lid {
    background: linear-gradient(180deg, #8b6914 0%, #5a3d08 55%, #3d2804 100%);
    border-color: #b8860b;
    box-shadow: 0 0 16px rgba(184,134,11,0.9), 0 0 34px rgba(139,90,43,0.5);
  }
  .theme-medieval .gift-item img { filter: drop-shadow(0 0 4px rgba(184,134,11,0.4)) drop-shadow(0 1px 3px rgba(0,0,0,0.4)); }

  /* RETRO */
  .theme-retro .jar-bg { background: rgba(0,5,0,0.97); }
  .theme-retro .jar-border {
    border-color: #39ff14;
    border-radius: 0;
    box-shadow: 0 0 10px rgba(57,255,20,0.8), 0 0 22px rgba(57,255,20,0.4);
  }
  .theme-retro .jar-bg { border-radius: 0; }
  .theme-retro .jar-lid {
    background: #003300;
    border-color: #39ff14;
    border-radius: 2px;
    box-shadow: 0 0 12px rgba(57,255,20,0.8);
  }

  /* FIRE */
  @keyframes fireGlowBorder {
    0%,100% { box-shadow: 0 0 14px rgba(255,107,53,0.85), 0 0 30px rgba(255,69,0,0.5), inset 0 0 10px rgba(255,107,53,0.08); }
    50%      { box-shadow: 0 0 24px rgba(255,107,53,1.0),  0 0 55px rgba(255,69,0,0.7),  inset 0 0 18px rgba(255,107,53,0.14); }
  }
  .theme-fire .jar-bg { background: rgba(5,2,0,0.96); }
  .theme-fire .jar-border {
    border-color: #ff6b35;
    animation: fireGlowBorder 2.5s ease-in-out infinite;
  }
  .theme-fire .jar-lid {
    background: linear-gradient(180deg, #cc4400 0%, #7a2000 55%, #3d0d00 100%);
    border-color: #ff6b35;
    box-shadow: 0 0 16px rgba(255,107,53,0.95), 0 0 34px rgba(255,69,0,0.55);
  }
  .theme-fire .jar-border.pulse { box-shadow: 0 0 45px rgba(255,107,53,1.0), 0 0 90px rgba(255,69,0,0.7) !important; }
  .theme-fire .gift-item img { filter: drop-shadow(0 0 5px rgba(255,107,53,0.5)) drop-shadow(0 1px 3px rgba(0,0,0,0.3)); }

  /* ICE */
  @keyframes iceGlowBorder {
    0%,100% { box-shadow: 0 0 14px rgba(135,206,235,0.85), 0 0 30px rgba(100,200,255,0.45), inset 0 0 10px rgba(135,206,235,0.08); }
    50%      { box-shadow: 0 0 24px rgba(135,206,235,1.0),  0 0 55px rgba(100,200,255,0.65), inset 0 0 18px rgba(135,206,235,0.14); }
  }
  .theme-ice .jar-bg { background: rgba(0,5,10,0.96); }
  .theme-ice .jar-border {
    border-color: #87ceeb;
    animation: iceGlowBorder 3s ease-in-out infinite;
  }
  .theme-ice .jar-lid {
    background: linear-gradient(180deg, #4fc3f7 0%, #1a7fa8 55%, #0d4f6b 100%);
    border-color: #87ceeb;
    box-shadow: 0 0 16px rgba(135,206,235,0.95), 0 0 34px rgba(100,200,255,0.55);
  }
  .theme-ice .jar-border.pulse { box-shadow: 0 0 40px rgba(135,206,235,1.0), 0 0 80px rgba(100,200,255,0.65) !important; }
  .theme-ice .gift-item img { filter: drop-shadow(0 0 5px rgba(135,206,235,0.5)) drop-shadow(0 1px 3px rgba(0,0,0,0.3)); }

  /* ROSA */
  @keyframes rosaGlowBorder {
    0%,100% { box-shadow: 0 0 14px rgba(255,105,180,0.85), 0 0 30px rgba(236,72,153,0.45), inset 0 0 10px rgba(255,105,180,0.08); }
    50%      { box-shadow: 0 0 24px rgba(255,105,180,1.0),  0 0 55px rgba(236,72,153,0.65), inset 0 0 18px rgba(255,105,180,0.14); }
  }
  .theme-rosa .jar-bg { background: rgba(20,5,15,0.96); }
  .theme-rosa .jar-border {
    border-color: #ff69b4;
    animation: rosaGlowBorder 3s ease-in-out infinite;
  }
  .theme-rosa .jar-lid {
    background: linear-gradient(180deg, #ff69b4 0%, #ec4899 55%, #831843 100%);
    border-color: #ff69b4;
    box-shadow: 0 0 16px rgba(255,105,180,0.95), 0 0 34px rgba(236,72,153,0.55);
  }
  .theme-rosa .jar-border.pulse { box-shadow: 0 0 40px rgba(255,105,180,1.0), 0 0 80px rgba(236,72,153,0.65) !important; }
  .theme-rosa .gift-item img { filter: drop-shadow(0 0 5px rgba(255,105,180,0.5)) drop-shadow(0 1px 3px rgba(0,0,0,0.3)); }

  /* ROYALTY */
  @keyframes royalGlowBorder {
    0%,100% { box-shadow: 0 0 14px rgba(255,215,0,0.7), 0 0 30px rgba(186,133,255,0.4); }
    50%      { box-shadow: 0 0 24px rgba(255,215,0,1.0), 0 0 55px rgba(186,133,255,0.65); }
  }
  .theme-royalty .jar-bg { background: rgba(5,0,10,0.96); }
  .theme-royalty .jar-border {
    border-color: #ffd700;
    animation: royalGlowBorder 3.5s ease-in-out infinite;
  }
  .theme-royalty .jar-lid {
    background: linear-gradient(180deg, #7c3aed 0%, #4c1d95 55%, #2d0f6b 100%);
    border-color: #ffd700;
    box-shadow: 0 0 16px rgba(255,215,0,0.9), 0 0 34px rgba(186,133,255,0.55);
  }
  .theme-royalty .jar-border.pulse { box-shadow: 0 0 40px rgba(255,215,0,1.0), 0 0 80px rgba(186,133,255,0.65) !important; }
  .theme-royalty .gift-item img { filter: drop-shadow(0 0 5px rgba(255,215,0,0.4)) drop-shadow(0 0 3px rgba(186,133,255,0.3)); }

  /* CUSTOM */
  .theme-custom .jar-border { border-color: rgba(255,255,255,0.35); box-shadow: 0 0 14px rgba(255,255,255,0.25); }
  .theme-custom .jar-lid { background: linear-gradient(180deg, #444, #1a1a1a); border-color: rgba(255,255,255,0.35); box-shadow: 0 0 14px rgba(255,255,255,0.2); }

  /* ===== TREASURE CHEST VISUAL ===== */

  /* CSS variables per theme (used by chest) */
  #theme-wrapper          { --ch:#d4a520; --cw:110,56,18; --cwb:85,38,10;  --cl:#2a1808; --cg:212,165,32;  --cg2:212,165,32; }
  #theme-wrapper.theme-clean    { --ch:#cccccc; --cw:80,80,80;  --cwb:50,50,50;  --cl:#2a2a2a; --cg:200,200,200; --cg2:200,200,200; }
  #theme-wrapper.theme-neon     { --ch:#00d4ff; --cw:0,28,55;   --cwb:0,16,38;   --cl:#001428; --cg:0,212,255;  --cg2:0,212,255; }
  #theme-wrapper.theme-medieval { --ch:#b8860b; --cw:90,50,10;  --cwb:60,30,5;   --cl:#5a1000; --cg:184,134,11; --cg2:184,134,11; }
  #theme-wrapper.theme-fire     { --ch:#ff6b35; --cw:100,28,0;  --cwb:65,14,0;   --cl:#3d0e00; --cg:255,107,53; --cg2:255,107,53; }
  #theme-wrapper.theme-ice      { --ch:#87ceeb; --cw:0,38,75;   --cwb:0,22,55;   --cl:#001228; --cg:135,206,235; --cg2:135,206,235; }
  #theme-wrapper.theme-rosa     { --ch:#ff69b4; --cw:75,18,50;  --cwb:50,10,32;  --cl:#3d0a28; --cg:255,105,180; --cg2:236,72,153; }
  #theme-wrapper.theme-royalty  { --ch:#ffd700; --cw:55,18,90;  --cwb:35,8,60;   --cl:#160038; --cg:255,215,0;  --cg2:186,133,255; }
  #theme-wrapper.theme-retro    { --ch:#39ff14; --cw:0,45,0;    --cwb:0,25,0;    --cl:#001800; --cg:57,255,20;  --cg2:57,255,20; }
  #theme-wrapper.theme-custom   { --ch:rgba(255,255,255,0.4); --cw:55,55,55; --cwb:35,35,35; --cl:#181818; --cg:200,200,200; --cg2:200,200,200; }

  /* Dark interior behind gifts */
  .chest-bg {
    position: absolute;
    left: 153px; top: 373px;
    width: 294px; height: 197px;
    background: rgba(4,3,2,0.96);
    border-radius: 2px 2px 4px 4px;
    z-index: 8;
    pointer-events: none;
  }

  /* Body frame: gold border + inset wood panels, transparent center */
  .chest-body {
    position: absolute;
    left: 150px; top: 370px;
    width: 300px; height: 202px;
    border: 3px solid var(--ch);
    border-radius: 2px 2px 5px 5px;
    box-shadow:
      inset 22px 0 0 0 rgb(var(--cw)),
      inset -22px 0 0 0 rgb(var(--cw)),
      inset 0 -26px 0 0 rgb(var(--cwb)),
      0 0 18px rgba(var(--cg),0.72),
      0 0 38px rgba(var(--cg2),0.36);
    z-index: 20;
    pointer-events: none;
  }

  /* Inner gold lines: right-edge of left strip, left-edge of right strip */
  .chest-body::before {
    content:'';
    position:absolute;
    top:0; bottom:26px; left:22px;
    width:2px;
    background: var(--ch);
    box-shadow: 254px 0 0 0 var(--ch);
  }

  /* Gold line above bottom strip */
  .chest-body::after {
    content:'';
    position:absolute;
    left:0; right:0; bottom:26px;
    height:2px;
    background: var(--ch);
  }

  /* Center vertical divider (splits interior into 2 panels like the photo) */
  .chest-divider {
    position: absolute;
    left: 300px; top: 370px;
    width: 2px; height: 176px;
    background: var(--ch);
    transform: translateX(-50%);
    z-index: 21;
    pointer-events: none;
  }

  /* Corner rivets (decorative) */
  .chest-rivets {
    position: absolute;
    left: 150px; top: 370px;
    width: 300px; height: 202px;
    z-index: 22;
    pointer-events: none;
  }
  .chest-rivets::before {
    content:'';
    position:absolute;
    width:10px; height:10px;
    border-radius:50%;
    background: radial-gradient(circle at 35% 35%, #ffe066, var(--ch));
    top:5px; left:5px;
    box-shadow:
      280px 0 0 0 var(--ch),
      0 177px 0 0 var(--ch),
      280px 177px 0 0 var(--ch);
  }

  /* Open lid — wood exterior */
  .chest-lid-outer {
    position: absolute;
    left: 142px; top: 215px;
    width: 316px; height: 155px;
    background: linear-gradient(180deg,
      #2d1206 0%, #6b3410 18%,
      #8b4513 35%, #7a3c12 50%,
      #8b4513 65%, #6b3410 82%,
      #2d1206 100%);
    border: 3px solid var(--ch);
    border-radius: 5px 5px 0 0;
    box-shadow:
      0 0 18px rgba(var(--cg),0.72),
      0 0 38px rgba(var(--cg2),0.36);
    z-index: 23;
    pointer-events: none;
  }

  /* Gold band on lid + keyhole */
  .chest-lid-outer::before {
    content:'';
    position:absolute;
    left:12px; right:12px; top:22px;
    height:3px;
    background: linear-gradient(90deg, transparent, var(--ch) 20%, #ffe066 50%, var(--ch) 80%, transparent);
    border-radius:2px;
    box-shadow: 0 96px 0 0 rgba(var(--cg),0.5);
  }
  .chest-lid-outer::after {
    content:'';
    position:absolute;
    left:50%; top:50%;
    transform:translate(-50%,-50%);
    width:14px; height:14px;
    border-radius:50%;
    border:3px solid var(--ch);
    background:rgba(var(--cg),0.2);
    box-shadow: 0 7px 0 2px var(--ch);
  }

  /* Lid inner lining — themed color, shows when open */
  .chest-lid-lining {
    position: absolute;
    left: 150px; top: 225px;
    width: 300px; height: 145px;
    background: var(--cl);
    border-radius: 3px 3px 0 0;
    z-index: 24;
    pointer-events: none;
    overflow: hidden;
  }

  /* Horizontal wood plank lines on lining */
  .chest-lid-lining::before {
    content:'';
    position:absolute;
    inset:0;
    background: repeating-linear-gradient(
      180deg,
      transparent 0px, transparent 27px,
      rgba(0,0,0,0.28) 27px, rgba(0,0,0,0.28) 29px
    );
  }

  /* Subtle shimmer on lining */
  .chest-lid-lining::after {
    content:'';
    position:absolute;
    inset:0;
    background: linear-gradient(135deg, rgba(255,255,255,0.06) 0%, transparent 50%, rgba(0,0,0,0.15) 100%);
  }

  /* Pulse on gift arrival (chest) */
  .chest-body.pulse {
    box-shadow:
      inset 22px 0 0 0 rgb(var(--cw)),
      inset -22px 0 0 0 rgb(var(--cw)),
      inset 0 -26px 0 0 rgb(var(--cwb)),
      0 0 35px rgba(var(--cg),0.95),
      0 0 70px rgba(var(--cg2),0.6);
    transition: box-shadow 0s;
  }
</style>
</head>
<body>

<div id="theme-wrapper" class="theme-clean visual-default">
<div class="jar-scene">
  <!-- Shared physics layer -->
  <div class="physics-container" id="physics"></div>

  <!-- DEFAULT JAR visual -->
  <div class="jar-bg default-only"></div>
  <div class="jar-border default-only" id="jar-border"></div>
  <div class="jar-lid default-only"></div>

  <!-- TREASURE CHEST visual -->
  <div class="chest-bg chest-only"></div>
  <div class="chest-body chest-only" id="chest-body"></div>
  <div class="chest-divider chest-only"></div>
  <div class="chest-rivets chest-only"></div>
  <div class="chest-lid-lining chest-only"></div>
  <div class="chest-lid-outer chest-only"></div>
</div>
</div>

<script src="https://cdn.jsdelivr.net/npm/matter-js@0.19.0/build/matter.min.js"></script>
<script>
  const { Engine, World, Bodies, Body, Events } = Matter;

  const engine = Engine.create({ enableSleeping: true });
  engine.gravity.y = 1;
  const world = engine.world;

  const physicsContainer = document.getElementById('physics');
  const jarBorder  = document.getElementById('jar-border');
  const chestBody  = document.getElementById('chest-body');
  const themeWrapper = document.getElementById('theme-wrapper');

  // Scene: 600×600px
  // jar-bg / jar-border: left=160, top=175, width=280, height=395
  //   → right=440, bottom=570
  // Left wall inner x: 160 + 2(border) + 4 = 166
  // Right wall inner x: 440 - 2(border) - 4 = 434
  // Floor y: 570 - 2(border) - 5 = 563
  const wallOpts = { isStatic: true, friction: 0.6, restitution: 0.1, render: { visible: false } };
  World.add(world, [
    Bodies.rectangle(166, 372, 12, 395, wallOpts),   // left wall
    Bodies.rectangle(434, 372, 12, 395, wallOpts),   // right wall
    Bodies.rectangle(300, 563, 274, 12, wallOpts),   // floor
    Bodies.rectangle(300, 615, 700, 14, wallOpts),   // safety net
    Bodies.rectangle(85,  590, 170, 10, wallOpts),   // ground left
    Bodies.rectangle(515, 590, 170, 10, wallOpts),   // ground right
    Bodies.rectangle(-5,  300, 10,  700, wallOpts),  // scene left
    Bodies.rectangle(605, 300, 10,  700, wallOpts),  // scene right
  ]);

  let activeGifts = [], pinnedGifts = [], totalGifts = 0, maxCapacity = 1000;

  function radiusForCoins(coins) {
    const c = Math.max(1, coins || 1);
    return Math.max(11, Math.min(46, 10 + Math.log10(c + 1) * 8.5));
  }

  function spawnOne(giftImage, coins) {
    if (totalGifts >= maxCapacity) return;
    totalGifts++;
    const radius = radiusForCoins(coins) * (0.9 + Math.random() * 0.2);
    const isBig  = coins >= 1000;
    const x = 230 + Math.random() * 140;  // inside x=166..434
    const y = -10 - Math.random() * 30;
    const body = Bodies.circle(x, y, radius, {
      friction: 0.3 + Math.random() * 0.3,
      frictionStatic: 0.2 + Math.random() * 0.3,
      restitution: 0.15 + Math.random() * 0.2,
      density: 0.001 + Math.random() * 0.003,
      sleepThreshold: 60,
    });
    Body.setVelocity(body, { x: (Math.random() - 0.5) * 3, y: 1 + Math.random() * 1.5 });
    Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.12);
    World.add(world, body);

    const el = document.createElement('div');
    el.className = 'gift-item' + (isBig ? ' gift-big' : '');
    const sz = radius * 2;
    el.style.cssText = 'width:' + sz + 'px;height:' + sz + 'px;';
    el.innerHTML = '<img src="' + giftImage + '" alt="" onerror="this.src=\\'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 36 36%22><text y=%2228%22 font-size=%2228%22>🎁</text></svg>\\'">';
    physicsContainer.appendChild(el);
    body.giftEl = el; body.giftRadius = radius; body.sleepFrames = 0;
    activeGifts.push(body);
  }

  function addGift(giftImage, giftName, count, coins) {
    const isChest = themeWrapper.classList.contains('visual-chest');
    const pulseEl = isChest ? chestBody : jarBorder;
    pulseEl.classList.add('pulse');
    setTimeout(() => pulseEl.classList.remove('pulse'), 400);
    const n = Math.min(count, 5);
    for (let i = 0; i < n; i++) setTimeout(() => spawnOne(giftImage, coins), i * 130);
  }

  function updateGiftTransform(b) {
    if (!b.giftEl) return;
    const r = b.giftRadius;
    b.giftEl.style.transform = 'translate(' + (b.position.x-r) + 'px,' + (b.position.y-r) + 'px) rotate(' + b.angle + 'rad)';
  }

  Events.on(engine, 'beforeUpdate', () => {
    for (let i = activeGifts.length - 1; i >= 0; i--) {
      const b = activeGifts[i];
      if (b.position.y > 650) { Body.setPosition(b, {x:300,y:450}); Body.setVelocity(b, {x:0,y:0}); }
      if (b.isSleeping) {
        b.sleepFrames++;
        if (b.sleepFrames > 90) {
          Body.setStatic(b, true); updateGiftTransform(b);
          pinnedGifts.push(b); activeGifts.splice(i, 1);
        }
      } else b.sleepFrames = 0;
    }
  });

  function loop() { Engine.update(engine, 1000/60); for (const b of activeGifts) updateGiftTransform(b); requestAnimationFrame(loop); }
  loop();

  function resetJar() {
    [...activeGifts, ...pinnedGifts].forEach(b => { World.remove(world,b); if(b.giftEl) b.giftEl.remove(); });
    activeGifts = []; pinnedGifts = []; totalGifts = 0;
  }

  function applyTheme(theme, customColor, visual) {
    const v = visual || 'default';
    themeWrapper.className = 'theme-' + (theme || 'clean') + ' visual-' + v;
    document.body.style.background = (theme === 'custom' && customColor) ? customColor : 'transparent';
  }

  const evtSource = new EventSource('${sseUrl}');
  evtSource.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'gift')   addGift(msg.giftImage, msg.giftName, msg.count||1, msg.coins||0);
    if (msg.type === 'reset')  resetJar();
    if (msg.type === 'config') {
      applyTheme(msg.theme, msg.customColor, msg.visual);
      if (typeof msg.capacity === 'number' && msg.capacity > 0) maxCapacity = msg.capacity;
    }
  };
</script>
</body>
</html>`;
}

// ============================================
// TIMER OVERLAY
// ============================================
function getTimerHTML(roomId) {
  const sseUrl = `/sse/${roomId}/timer`;
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=MedievalSharp&family=Press+Start+2P&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: transparent;
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100vh;
    overflow: hidden;
  }
  .timer-container {
    padding: 30px 60px;
    border-radius: 20px;
    position: relative;
    text-align: center;
  }
  .timer-time {
    font-size: 72px;
    font-weight: 900;
    letter-spacing: 6px;
    line-height: 1;
  }
  .timer-label {
    font-size: 14px;
    margin-top: 8px;
    letter-spacing: 4px;
    text-transform: uppercase;
    opacity: 0.8;
  }
  /* NEON */
  .theme-neon .timer-container {
    background: rgba(10,10,30,0.85);
    border: 2px solid #00d4ff;
    box-shadow: 0 0 30px rgba(0,212,255,0.3), inset 0 0 30px rgba(0,212,255,0.05);
  }
  .theme-neon .timer-time {
    font-family: 'Orbitron', monospace;
    color: #00d4ff;
    text-shadow: 0 0 20px rgba(0,212,255,0.8), 0 0 40px rgba(0,212,255,0.4);
  }
  .theme-neon .timer-label { font-family: 'Orbitron', monospace; color: #ff3366; text-shadow: 0 0 10px rgba(255,51,102,0.5); }
  /* MEDIEVAL */
  .theme-medieval .timer-container {
    background: linear-gradient(135deg, rgba(30,20,10,0.9), rgba(50,35,15,0.9));
    border: 3px solid #c9a44a;
    box-shadow: 0 0 20px rgba(201,164,74,0.3);
  }
  .theme-medieval .timer-time {
    font-family: 'MedievalSharp', cursive;
    color: #ffd700;
    text-shadow: 0 2px 4px rgba(0,0,0,0.8), 0 0 20px rgba(255,215,0,0.3);
  }
  .theme-medieval .timer-label { font-family: 'MedievalSharp', cursive; color: #c9a44a; }
  /* RETRO */
  .theme-retro .timer-container {
    background: rgba(0,0,0,0.9);
    border: 3px solid #39ff14;
    box-shadow: 0 0 20px rgba(57,255,20,0.3);
  }
  .theme-retro .timer-time {
    font-family: 'Press Start 2P', monospace;
    color: #39ff14;
    font-size: 48px;
    text-shadow: 0 0 10px rgba(57,255,20,0.8), 3px 3px 0 #006400;
  }
  .theme-retro .timer-label { font-family: 'Press Start 2P', monospace; color: #39ff14; font-size: 10px; }
  /* FIRE */
  .theme-fire .timer-container {
    background: linear-gradient(180deg, rgba(40,10,0,0.9), rgba(80,20,0,0.9));
    border: 2px solid #ff6b35;
    box-shadow: 0 0 30px rgba(255,107,53,0.4), 0 0 60px rgba(255,69,0,0.2);
  }
  .theme-fire .timer-time {
    font-family: 'Orbitron', monospace;
    background: linear-gradient(180deg, #fff44f, #ff6b35, #ff4500);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    filter: drop-shadow(0 0 10px rgba(255,69,0,0.6));
  }
  .theme-fire .timer-label { font-family: 'Orbitron', monospace; color: #ff6b35; }
  /* ICE */
  .theme-ice .timer-container {
    background: linear-gradient(180deg, rgba(10,20,40,0.9), rgba(20,40,80,0.9));
    border: 2px solid #87ceeb;
    box-shadow: 0 0 30px rgba(135,206,235,0.3);
  }
  .theme-ice .timer-time {
    font-family: 'Orbitron', monospace;
    background: linear-gradient(180deg, #ffffff, #87ceeb, #4fc3f7);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    filter: drop-shadow(0 0 10px rgba(135,206,235,0.5));
  }
  .theme-ice .timer-label { font-family: 'Orbitron', monospace; color: #87ceeb; }

  /* ROSA */
  .theme-rosa .timer-container {
    background: linear-gradient(180deg, rgba(60,15,40,0.9), rgba(95,20,55,0.9));
    border: 2px solid #ff69b4;
    box-shadow: 0 0 30px rgba(255,105,180,0.35), 0 0 60px rgba(236,72,153,0.15);
  }
  .theme-rosa .timer-time {
    font-family: 'Poppins', sans-serif; font-weight: 900;
    background: linear-gradient(180deg, #ffffff, #ff69b4, #ec4899);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    filter: drop-shadow(0 0 10px rgba(255,105,180,0.55));
  }
  .theme-rosa .timer-label { font-family: 'Poppins', sans-serif; color: #ff69b4; font-weight: 600; }

  /* ROYALTY THEME */
  @keyframes royalTimerGlow {
    0%, 100% { border-color: rgba(255,215,0,0.5); box-shadow: 0 0 30px rgba(255,215,0,0.2), 0 0 60px rgba(186,133,255,0.15); }
    50% { border-color: rgba(255,215,0,0.9); box-shadow: 0 0 50px rgba(255,215,0,0.5), 0 0 80px rgba(186,133,255,0.3); }
  }
  .theme-royalty .timer-container {
    background: linear-gradient(135deg, rgba(60,20,100,0.92), rgba(40,10,70,0.95), rgba(60,20,100,0.92));
    border: 3px solid #ffd700;
    box-shadow: 0 0 40px rgba(255,215,0,0.3), 0 0 80px rgba(186,133,255,0.2);
    animation: royalTimerGlow 4s ease-in-out infinite;
    position: relative;
  }
  .theme-royalty .timer-container::before {
    content: '\\1F451';
    position: absolute;
    top: -22px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 32px;
    filter: drop-shadow(0 0 10px rgba(255,215,0,0.8));
  }
  .theme-royalty .timer-time {
    font-family: 'Orbitron', monospace;
    background: linear-gradient(180deg, #fff8dc, #ffd700, #daa520, #ffd700, #fff8dc);
    background-size: 100% 200%;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    filter: drop-shadow(0 0 20px rgba(255,215,0,0.6));
    animation: royalTextShimmer 3s ease-in-out infinite;
  }
  @keyframes royalTextShimmer {
    0%, 100% { background-position: 0% 0%; }
    50% { background-position: 0% 100%; }
  }
  .theme-royalty .timer-label {
    font-family: 'Orbitron', monospace;
    color: #ffd700;
    text-shadow: 0 0 12px rgba(255,215,0,0.5);
    letter-spacing: 6px;
  }

  /* CUSTOM THEME */
  .theme-custom .timer-container {
    background: rgba(0,0,0,0.6);
    border: 2px solid rgba(255,255,255,0.3);
    box-shadow: 0 0 20px rgba(255,255,255,0.1);
  }
  .theme-custom .timer-time {
    font-family: 'Orbitron', monospace;
    color: #ffffff;
    text-shadow: 0 0 10px rgba(255,255,255,0.3);
  }
  .theme-custom .timer-label { font-family: 'Orbitron', monospace; color: rgba(255,255,255,0.7); }

  @keyframes pulse { 0% { transform: scale(1); } 50% { transform: scale(1.08); } 100% { transform: scale(1); } }
  .pulse { animation: pulse 0.5s ease-out; }
  .low-time .timer-time { animation: blink 1s infinite; }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
</style>
</head>
<body>
<div id="theme-wrapper" class="theme-neon">
  <div class="timer-container" id="timer-container">
    <div class="timer-time" id="timer-time">00:00:00</div>
    <div class="timer-label">LIVE TIMER</div>
  </div>
</div>
<script>
  const timerEl = document.getElementById('timer-time');
  const container = document.getElementById('timer-container');
  const wrapper = document.getElementById('theme-wrapper');
  let currentSeconds = 0;
  let isRunning = false;
  let localInterval = null;

  function formatTime(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  }

  function updateDisplay() {
    timerEl.textContent = formatTime(currentSeconds);
    if (currentSeconds <= 60 && currentSeconds > 0 && isRunning) {
      wrapper.classList.add('low-time');
    } else {
      wrapper.classList.remove('low-time');
    }
  }

  function startLocalCountdown() {
    if (localInterval) clearInterval(localInterval);
    localInterval = setInterval(() => {
      if (isRunning && currentSeconds > 0) {
        currentSeconds--;
        updateDisplay();
      }
    }, 1000);
  }

  startLocalCountdown();

  const evtSource = new EventSource('${sseUrl}');
  evtSource.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'timer') {
      const prevSeconds = currentSeconds;
      currentSeconds = msg.seconds;
      isRunning = msg.running;
      updateDisplay();
      if (currentSeconds > prevSeconds) {
        container.classList.add('pulse');
        setTimeout(() => container.classList.remove('pulse'), 500);
      }
    }
    if (msg.type === 'config') {
      if (msg.theme) {
        wrapper.className = 'theme-' + msg.theme;
        if (msg.theme === 'custom' && msg.customColor) {
          document.body.style.background = msg.customColor;
        } else {
          document.body.style.background = 'transparent';
        }
      }
    }
  };
</script>
</body></html>`;
}

// ============================================
// GOAL OVERLAY
// ============================================
function getGoalHTML(roomId, goalType) {
  const sseUrl = `/sse/${roomId}/goal/${goalType}`;
  const isLikes = goalType === 'likes';
  const isPix = goalType === 'pix';
  const icon = isPix ? '💰' : (isLikes ? '❤️' : '🪙');
  const valuePrefix = isPix ? 'R$ ' : '';
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=MedievalSharp&family=Press+Start+2P&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: transparent;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    font-family: 'Orbitron', sans-serif;
  }

  /* ===================================================
     ESTILO PADRAO (default)
     =================================================== */
  .style-default .goal-container {
    width: 450px;
    padding: 18px 24px;
    background: rgba(10, 10, 30, 0.85);
    border: 2px solid #00d4ff;
    border-radius: 16px;
    box-shadow: 0 0 30px rgba(0,212,255,0.3), inset 0 0 20px rgba(0,212,255,0.05);
    text-align: center;
  }
  .style-default .goal-title {
    font-size: 14px; font-weight: 700; color: #00d4ff;
    letter-spacing: 2px; margin-bottom: 10px;
    text-shadow: 0 0 10px rgba(0,212,255,0.5); word-wrap: break-word;
  }
  .style-default .goal-numbers {
    font-size: 28px; font-weight: 900; color: #fff;
    margin-bottom: 12px; text-shadow: 0 0 15px rgba(255,255,255,0.3);
  }
  .style-default .goal-numbers .current { color: #00d4ff; }
  .style-default .goal-bar-bg {
    width: 100%; height: 24px; background: rgba(255,255,255,0.1);
    border-radius: 12px; overflow: hidden; position: relative;
    border: 1px solid rgba(255,255,255,0.15);
  }
  .style-default .goal-bar-fill {
    height: 100%; border-radius: 12px;
    background: linear-gradient(90deg, #0088cc, #00d4ff);
    transition: width 0.6s ease-out; width: 0%;
    box-shadow: 0 0 15px rgba(0,212,255,0.5); position: relative;
  }
  .style-default .goal-bar-fill::after {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 50%;
    background: linear-gradient(180deg, rgba(255,255,255,0.25), transparent);
    border-radius: 12px 12px 0 0;
  }
  .style-default .goal-percent {
    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    font-size: 11px; font-weight: 700; color: #fff;
    text-shadow: 0 1px 3px rgba(0,0,0,0.7); z-index: 2;
  }

  /* ===================================================
     ESTILO PREMIUM (cyberpunk angular HUD)
     =================================================== */
  .style-premium .goal-container {
    width: 520px; position: relative; padding: 0;
    background: transparent; border: none; border-radius: 0;
    box-shadow: none; text-align: center;
  }
  .style-premium .goal-title { display: none; }
  .style-premium .goal-numbers { display: none; }
  .style-premium .goal-bar-bg { display: none; }
  .style-premium .goal-percent { display: none; }

  /* Premium custom bar */
  .premium-frame {
    display: none; position: relative; width: 520px; height: 52px;
  }
  .style-premium .premium-frame { display: block; }

  /* Main bar background */
  .pf-bar {
    position: absolute; top: 6px; left: 40px; right: 40px; height: 40px;
    background: rgba(10, 10, 30, 0.88);
    clip-path: polygon(12px 0, calc(100% - 12px) 0, 100% 12px, 100% calc(100% - 12px), calc(100% - 12px) 100%, 12px 100%, 0 calc(100% - 12px), 0 12px);
    border: none;
  }
  .pf-bar-border {
    position: absolute; top: 5px; left: 39px; right: 39px; height: 42px;
    clip-path: polygon(12px 0, calc(100% - 12px) 0, 100% 12px, 100% calc(100% - 12px), calc(100% - 12px) 100%, 12px 100%, 0 calc(100% - 12px), 0 12px);
    background: #00d4ff;
    z-index: 0;
  }
  .pf-bar { z-index: 1; }

  /* Fill bar inside */
  .pf-fill-track {
    position: absolute; top: 10px; left: 46px; right: 46px; height: 32px;
    overflow: hidden; z-index: 2;
    clip-path: polygon(8px 0, calc(100% - 8px) 0, 100% 8px, 100% calc(100% - 8px), calc(100% - 8px) 100%, 8px 100%, 0 calc(100% - 8px), 0 8px);
  }
  .pf-fill {
    height: 100%; width: 0%; transition: width 0.6s ease-out;
    background: linear-gradient(90deg, #0088cc, #00d4ff);
    box-shadow: 0 0 20px rgba(0,212,255,0.5);
    position: relative;
  }
  .pf-fill::after {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 40%;
    background: linear-gradient(180deg, rgba(255,255,255,0.3), transparent);
  }

  /* Corner accents - left */
  .pf-corner-l {
    position: absolute; top: 0; left: 0; width: 44px; height: 52px; z-index: 3;
  }
  .pf-corner-l::before {
    content: ''; position: absolute; top: 0; left: 8px; width: 3px; height: 20px;
    background: #00d4ff; box-shadow: 0 0 8px rgba(0,212,255,0.8);
  }
  .pf-corner-l::after {
    content: ''; position: absolute; top: 0; left: 8px; width: 20px; height: 3px;
    background: #00d4ff; box-shadow: 0 0 8px rgba(0,212,255,0.8);
  }
  .pf-corner-lb {
    position: absolute; bottom: 0; left: 0; width: 44px; height: 20px; z-index: 3;
  }
  .pf-corner-lb::before {
    content: ''; position: absolute; bottom: 0; left: 8px; width: 3px; height: 20px;
    background: #00d4ff; box-shadow: 0 0 8px rgba(0,212,255,0.8);
  }
  .pf-corner-lb::after {
    content: ''; position: absolute; bottom: 0; left: 8px; width: 20px; height: 3px;
    background: #00d4ff; box-shadow: 0 0 8px rgba(0,212,255,0.8);
  }
  /* Corner accents - right */
  .pf-corner-r {
    position: absolute; top: 0; right: 0; width: 44px; height: 52px; z-index: 3;
  }
  .pf-corner-r::before {
    content: ''; position: absolute; top: 0; right: 8px; width: 3px; height: 20px;
    background: #00d4ff; box-shadow: 0 0 8px rgba(0,212,255,0.8);
  }
  .pf-corner-r::after {
    content: ''; position: absolute; top: 0; right: 8px; width: 20px; height: 3px;
    background: #00d4ff; box-shadow: 0 0 8px rgba(0,212,255,0.8);
  }
  .pf-corner-rb {
    position: absolute; bottom: 0; right: 0; width: 44px; height: 20px; z-index: 3;
  }
  .pf-corner-rb::before {
    content: ''; position: absolute; bottom: 0; right: 8px; width: 3px; height: 20px;
    background: #00d4ff; box-shadow: 0 0 8px rgba(0,212,255,0.8);
  }
  .pf-corner-rb::after {
    content: ''; position: absolute; bottom: 0; right: 8px; width: 20px; height: 3px;
    background: #00d4ff; box-shadow: 0 0 8px rgba(0,212,255,0.8);
  }

  /* Side line accents */
  .pf-line-l, .pf-line-r {
    position: absolute; top: 50%; transform: translateY(-50%);
    width: 4px; height: 30px; z-index: 3;
    background: #00d4ff; box-shadow: 0 0 12px rgba(0,212,255,0.9);
  }
  .pf-line-l { left: 2px; }
  .pf-line-r { right: 2px; }

  /* Text overlay */
  .pf-text {
    position: absolute; top: 0; left: 0; right: 0; height: 52px;
    display: flex; align-items: center; justify-content: center;
    z-index: 4; font-family: 'Orbitron', sans-serif;
    font-size: 15px; font-weight: 900; color: #fff;
    letter-spacing: 3px; text-transform: uppercase;
    text-shadow: 0 0 10px rgba(0,0,0,0.8), 0 0 20px rgba(0,212,255,0.3);
  }

  /* ===== PREMIUM THEME OVERRIDES ===== */
  /* Neon */
  .style-premium.theme-neon .pf-bar-border,
  .style-premium.theme-neon .pf-corner-l::before, .style-premium.theme-neon .pf-corner-l::after,
  .style-premium.theme-neon .pf-corner-lb::before, .style-premium.theme-neon .pf-corner-lb::after,
  .style-premium.theme-neon .pf-corner-r::before, .style-premium.theme-neon .pf-corner-r::after,
  .style-premium.theme-neon .pf-corner-rb::before, .style-premium.theme-neon .pf-corner-rb::after,
  .style-premium.theme-neon .pf-line-l, .style-premium.theme-neon .pf-line-r { background: #00d4ff; }
  .style-premium.theme-neon .pf-fill { background: linear-gradient(90deg, #0088cc, #00d4ff); box-shadow: 0 0 20px rgba(0,212,255,0.5); }

  /* Fire */
  .style-premium.theme-fire .pf-bar { background: linear-gradient(180deg, rgba(40,10,0,0.92), rgba(80,20,0,0.92)); }
  .style-premium.theme-fire .pf-bar-border,
  .style-premium.theme-fire .pf-corner-l::before, .style-premium.theme-fire .pf-corner-l::after,
  .style-premium.theme-fire .pf-corner-lb::before, .style-premium.theme-fire .pf-corner-lb::after,
  .style-premium.theme-fire .pf-corner-r::before, .style-premium.theme-fire .pf-corner-r::after,
  .style-premium.theme-fire .pf-corner-rb::before, .style-premium.theme-fire .pf-corner-rb::after,
  .style-premium.theme-fire .pf-line-l, .style-premium.theme-fire .pf-line-r { background: #ff6b35; box-shadow: 0 0 12px rgba(255,107,53,0.8); }
  .style-premium.theme-fire .pf-fill { background: linear-gradient(90deg, #ff4500, #ff6b35, #ffaa00); box-shadow: 0 0 20px rgba(255,107,53,0.5); }

  /* Ice */
  .style-premium.theme-ice .pf-bar { background: linear-gradient(180deg, rgba(10,20,40,0.92), rgba(20,40,80,0.92)); }
  .style-premium.theme-ice .pf-bar-border,
  .style-premium.theme-ice .pf-corner-l::before, .style-premium.theme-ice .pf-corner-l::after,
  .style-premium.theme-ice .pf-corner-lb::before, .style-premium.theme-ice .pf-corner-lb::after,
  .style-premium.theme-ice .pf-corner-r::before, .style-premium.theme-ice .pf-corner-r::after,
  .style-premium.theme-ice .pf-corner-rb::before, .style-premium.theme-ice .pf-corner-rb::after,
  .style-premium.theme-ice .pf-line-l, .style-premium.theme-ice .pf-line-r { background: #87ceeb; box-shadow: 0 0 12px rgba(135,206,235,0.8); }
  .style-premium.theme-ice .pf-fill { background: linear-gradient(90deg, #4fc3f7, #87ceeb, #b0e0e6); box-shadow: 0 0 20px rgba(135,206,235,0.5); }

  /* Rosa */
  .style-premium.theme-rosa .pf-bar { background: linear-gradient(180deg, rgba(60,15,40,0.92), rgba(85,20,55,0.92)); }
  .style-premium.theme-rosa .pf-bar-border,
  .style-premium.theme-rosa .pf-corner-l::before, .style-premium.theme-rosa .pf-corner-l::after,
  .style-premium.theme-rosa .pf-corner-lb::before, .style-premium.theme-rosa .pf-corner-lb::after,
  .style-premium.theme-rosa .pf-corner-r::before, .style-premium.theme-rosa .pf-corner-r::after,
  .style-premium.theme-rosa .pf-corner-rb::before, .style-premium.theme-rosa .pf-corner-rb::after,
  .style-premium.theme-rosa .pf-line-l, .style-premium.theme-rosa .pf-line-r { background: #ff69b4; box-shadow: 0 0 12px rgba(255,105,180,0.85); }
  .style-premium.theme-rosa .pf-fill { background: linear-gradient(90deg, #ec4899, #ff69b4, #f9a8d4); box-shadow: 0 0 20px rgba(255,105,180,0.55); }

  /* Medieval */
  .style-premium.theme-medieval .pf-bar { background: linear-gradient(180deg, rgba(30,20,10,0.92), rgba(50,35,15,0.92)); }
  .style-premium.theme-medieval .pf-bar-border,
  .style-premium.theme-medieval .pf-corner-l::before, .style-premium.theme-medieval .pf-corner-l::after,
  .style-premium.theme-medieval .pf-corner-lb::before, .style-premium.theme-medieval .pf-corner-lb::after,
  .style-premium.theme-medieval .pf-corner-r::before, .style-premium.theme-medieval .pf-corner-r::after,
  .style-premium.theme-medieval .pf-corner-rb::before, .style-premium.theme-medieval .pf-corner-rb::after,
  .style-premium.theme-medieval .pf-line-l, .style-premium.theme-medieval .pf-line-r { background: #c9a44a; box-shadow: 0 0 12px rgba(201,164,74,0.8); }
  .style-premium.theme-medieval .pf-fill { background: linear-gradient(90deg, #8b6914, #c9a44a, #ffd700); box-shadow: 0 0 20px rgba(201,164,74,0.5); }
  .style-premium.theme-medieval .pf-text { font-family: 'MedievalSharp', cursive; letter-spacing: 2px; }

  /* Retro */
  .style-premium.theme-retro .pf-bar { background: rgba(0,0,0,0.95); }
  .style-premium.theme-retro .pf-bar-border,
  .style-premium.theme-retro .pf-corner-l::before, .style-premium.theme-retro .pf-corner-l::after,
  .style-premium.theme-retro .pf-corner-lb::before, .style-premium.theme-retro .pf-corner-lb::after,
  .style-premium.theme-retro .pf-corner-r::before, .style-premium.theme-retro .pf-corner-r::after,
  .style-premium.theme-retro .pf-corner-rb::before, .style-premium.theme-retro .pf-corner-rb::after,
  .style-premium.theme-retro .pf-line-l, .style-premium.theme-retro .pf-line-r { background: #39ff14; box-shadow: 0 0 12px rgba(57,255,20,0.8); }
  .style-premium.theme-retro .pf-fill { background: #39ff14; box-shadow: 0 0 20px rgba(57,255,20,0.5); }
  .style-premium.theme-retro .pf-text { font-family: 'Press Start 2P', monospace; font-size: 10px; letter-spacing: 1px; }

  /* Royalty */
  .style-premium.theme-royalty .pf-bar { background: linear-gradient(180deg, rgba(60,20,100,0.92), rgba(40,10,70,0.95)); }
  .style-premium.theme-royalty .pf-bar-border,
  .style-premium.theme-royalty .pf-corner-l::before, .style-premium.theme-royalty .pf-corner-l::after,
  .style-premium.theme-royalty .pf-corner-lb::before, .style-premium.theme-royalty .pf-corner-lb::after,
  .style-premium.theme-royalty .pf-corner-r::before, .style-premium.theme-royalty .pf-corner-r::after,
  .style-premium.theme-royalty .pf-corner-rb::before, .style-premium.theme-royalty .pf-corner-rb::after,
  .style-premium.theme-royalty .pf-line-l, .style-premium.theme-royalty .pf-line-r { background: #ffd700; box-shadow: 0 0 12px rgba(255,215,0,0.8); }
  .style-premium.theme-royalty .pf-fill { background: linear-gradient(90deg, #6a0dad, #ba85ff, #ffd700); box-shadow: 0 0 20px rgba(186,133,255,0.5); }

  /* Custom */
  .style-premium.theme-custom .pf-bar-border,
  .style-premium.theme-custom .pf-corner-l::before, .style-premium.theme-custom .pf-corner-l::after,
  .style-premium.theme-custom .pf-corner-lb::before, .style-premium.theme-custom .pf-corner-lb::after,
  .style-premium.theme-custom .pf-corner-r::before, .style-premium.theme-custom .pf-corner-r::after,
  .style-premium.theme-custom .pf-corner-rb::before, .style-premium.theme-custom .pf-corner-rb::after,
  .style-premium.theme-custom .pf-line-l, .style-premium.theme-custom .pf-line-r { background: rgba(255,255,255,0.5); box-shadow: 0 0 8px rgba(255,255,255,0.3); }
  .style-premium.theme-custom .pf-fill { background: linear-gradient(90deg, rgba(255,255,255,0.4), rgba(255,255,255,0.7)); }

  /* ===== DEFAULT THEME OVERRIDES (unchanged) ===== */
  .style-default.theme-neon .goal-container { border-color: #00d4ff; box-shadow: 0 0 30px rgba(0,212,255,0.3), inset 0 0 20px rgba(0,212,255,0.05); }
  .style-default.theme-neon .goal-title { color: #00d4ff; text-shadow: 0 0 10px rgba(0,212,255,0.5); }
  .style-default.theme-neon .goal-numbers .current { color: #00d4ff; }
  .style-default.theme-neon .goal-bar-fill { background: linear-gradient(90deg, #0088cc, #00d4ff); box-shadow: 0 0 15px rgba(0,212,255,0.5); }

  .style-default.theme-fire .goal-container { background: linear-gradient(180deg, rgba(40,10,0,0.9), rgba(80,20,0,0.9)); border-color: #ff6b35; box-shadow: 0 0 30px rgba(255,107,53,0.4), 0 0 60px rgba(255,69,0,0.2); }
  .style-default.theme-fire .goal-title { color: #ff6b35; text-shadow: 0 0 10px rgba(255,107,53,0.6); }
  .style-default.theme-fire .goal-numbers .current { color: #ff6b35; }
  .style-default.theme-fire .goal-bar-fill { background: linear-gradient(90deg, #ff4500, #ff6b35, #ffaa00); box-shadow: 0 0 15px rgba(255,107,53,0.5); }

  .style-default.theme-ice .goal-container { background: linear-gradient(180deg, rgba(10,20,40,0.9), rgba(20,40,80,0.9)); border-color: #87ceeb; box-shadow: 0 0 30px rgba(135,206,235,0.3); }
  .style-default.theme-ice .goal-title { color: #87ceeb; text-shadow: 0 0 10px rgba(135,206,235,0.5); }
  .style-default.theme-ice .goal-numbers .current { color: #87ceeb; }
  .style-default.theme-ice .goal-bar-fill { background: linear-gradient(90deg, #4fc3f7, #87ceeb, #b0e0e6); box-shadow: 0 0 15px rgba(135,206,235,0.5); }

  .style-default.theme-medieval .goal-container { background: linear-gradient(135deg, rgba(30,20,10,0.9), rgba(50,35,15,0.9)); border: 3px solid #c9a44a; box-shadow: 0 0 20px rgba(201,164,74,0.3); font-family: 'MedievalSharp', cursive; }
  .style-default.theme-medieval .goal-title { color: #ffd700; font-family: 'MedievalSharp', cursive; text-shadow: 0 2px 4px rgba(0,0,0,0.8); }
  .style-default.theme-medieval .goal-numbers { font-family: 'MedievalSharp', cursive; }
  .style-default.theme-medieval .goal-numbers .current { color: #ffd700; }
  .style-default.theme-medieval .goal-bar-bg { border-color: rgba(201,164,74,0.4); }
  .style-default.theme-medieval .goal-bar-fill { background: linear-gradient(90deg, #8b6914, #c9a44a, #ffd700); box-shadow: 0 0 10px rgba(201,164,74,0.4); }

  .style-default.theme-retro .goal-container { background: rgba(0,0,0,0.9); border: 3px solid #39ff14; box-shadow: 0 0 20px rgba(57,255,20,0.3); border-radius: 4px; font-family: 'Press Start 2P', monospace; }
  .style-default.theme-retro .goal-title { color: #39ff14; font-family: 'Press Start 2P', monospace; font-size: 10px; text-shadow: 0 0 10px rgba(57,255,20,0.8); }
  .style-default.theme-retro .goal-numbers { font-family: 'Press Start 2P', monospace; font-size: 18px; }
  .style-default.theme-retro .goal-numbers .current { color: #39ff14; }
  .style-default.theme-retro .goal-bar-bg { border-radius: 2px; border-color: #39ff14; }
  .style-default.theme-retro .goal-bar-fill { border-radius: 2px; background: #39ff14; box-shadow: 0 0 10px rgba(57,255,20,0.5); }
  .style-default.theme-retro .goal-percent { font-family: 'Press Start 2P', monospace; font-size: 8px; }

  @keyframes royalGoalGlow {
    0%,100% { border-color: rgba(255,215,0,0.5); box-shadow: 0 0 30px rgba(255,215,0,0.2), 0 0 60px rgba(186,133,255,0.15); }
    50% { border-color: rgba(255,215,0,0.9); box-shadow: 0 0 50px rgba(255,215,0,0.5), 0 0 80px rgba(186,133,255,0.3); }
  }
  .style-default.theme-royalty .goal-container { background: linear-gradient(135deg, rgba(60,20,100,0.92), rgba(40,10,70,0.95)); border: 3px solid #ffd700; animation: royalGoalGlow 4s ease-in-out infinite; }
  .style-default.theme-royalty .goal-title { color: #ffd700; text-shadow: 0 0 12px rgba(255,215,0,0.5); }
  .style-default.theme-royalty .goal-numbers .current { color: #ffd700; }
  .style-default.theme-royalty .goal-bar-bg { border-color: rgba(255,215,0,0.3); }
  .style-default.theme-royalty .goal-bar-fill { background: linear-gradient(90deg, #6a0dad, #ba85ff, #ffd700); box-shadow: 0 0 15px rgba(186,133,255,0.5); }

  .style-default.theme-custom .goal-container { background: rgba(0,0,0,0.6); border: 2px solid rgba(255,255,255,0.3); box-shadow: 0 0 20px rgba(255,255,255,0.1); }
  .style-default.theme-custom .goal-title { color: #fff; }
  .style-default.theme-custom .goal-numbers .current { color: #fff; }
  .style-default.theme-custom .goal-bar-fill { background: linear-gradient(90deg, rgba(255,255,255,0.5), rgba(255,255,255,0.8)); }

  /* ===== ANIMATIONS ===== */
  @keyframes goalPulse { 0% { transform: scale(1); } 50% { transform: scale(1.03); } 100% { transform: scale(1); } }
  .pulse { animation: goalPulse 0.4s ease-out; }
  @keyframes goalComplete {
    0%,100% { box-shadow: 0 0 30px rgba(255,215,0,0.3), 0 0 60px rgba(255,215,0,0.1); border-color: #ffd700; }
    50% { box-shadow: 0 0 50px rgba(255,215,0,0.6), 0 0 100px rgba(255,215,0,0.3); border-color: #ffed4a; }
  }
  .style-default .goal-complete { animation: goalComplete 2s ease-in-out infinite; }
  .style-default .goal-complete .goal-bar-fill { background: linear-gradient(90deg, #ffd700, #ffed4a, #ffd700) !important; }

  @keyframes premiumComplete {
    0%,100% { filter: brightness(1); }
    50% { filter: brightness(1.3); }
  }
  .style-premium .goal-complete .premium-frame { animation: premiumComplete 2s ease-in-out infinite; }
  .style-premium .goal-complete .pf-fill { background: linear-gradient(90deg, #ffd700, #ffed4a, #ffd700) !important; }
  .style-premium .goal-complete .pf-bar-border,
  .style-premium .goal-complete .pf-corner-l::before, .style-premium .goal-complete .pf-corner-l::after,
  .style-premium .goal-complete .pf-corner-lb::before, .style-premium .goal-complete .pf-corner-lb::after,
  .style-premium .goal-complete .pf-corner-r::before, .style-premium .goal-complete .pf-corner-r::after,
  .style-premium .goal-complete .pf-corner-rb::before, .style-premium .goal-complete .pf-corner-rb::after,
  .style-premium .goal-complete .pf-line-l, .style-premium .goal-complete .pf-line-r { background: #ffd700 !important; box-shadow: 0 0 15px rgba(255,215,0,0.8) !important; }

  @keyframes premiumPulseGlow {
    0% { filter: brightness(1); }
    50% { filter: brightness(1.4); }
    100% { filter: brightness(1); }
  }
  .style-premium .pulse .premium-frame { animation: premiumPulseGlow 0.4s ease-out; }
</style>
</head>
<body>
<div id="theme-wrapper" class="style-default theme-neon">
<div class="goal-container" id="goal-container">
  <div class="goal-title" id="goal-title">${icon} Meta</div>
  <div class="goal-numbers"><span class="current" id="goal-current">0</span> / <span id="goal-target">0</span></div>
  <div class="goal-bar-bg">
    <div class="goal-bar-fill" id="goal-fill"></div>
    <div class="goal-percent" id="goal-percent">0%</div>
  </div>
  <!-- Premium frame (hidden by default, shown when style=premium) -->
  <div class="premium-frame" id="premium-frame">
    <div class="pf-corner-l"></div>
    <div class="pf-corner-lb"></div>
    <div class="pf-corner-r"></div>
    <div class="pf-corner-rb"></div>
    <div class="pf-line-l"></div>
    <div class="pf-line-r"></div>
    <div class="pf-bar-border"></div>
    <div class="pf-bar"></div>
    <div class="pf-fill-track"><div class="pf-fill" id="pf-fill"></div></div>
    <div class="pf-text" id="pf-text">GOAL : 0 / 0 (0%)</div>
  </div>
</div>
</div>
<script>
  const wrapper = document.getElementById('theme-wrapper');
  const container = document.getElementById('goal-container');
  const titleEl = document.getElementById('goal-title');
  const currentEl = document.getElementById('goal-current');
  const targetEl = document.getElementById('goal-target');
  const fillEl = document.getElementById('goal-fill');
  const percentEl = document.getElementById('goal-percent');
  const pfFill = document.getElementById('pf-fill');
  const pfText = document.getElementById('pf-text');
  const icon = '${icon}';
  const prefix = '${valuePrefix}';
  let prevCurrent = 0;
  let currentStyle = 'default';

  function applyStyle(style, theme, customColor) {
    currentStyle = style || 'default';
    const t = theme || 'neon';
    wrapper.className = 'style-' + currentStyle + ' theme-' + t;
    document.body.style.background = (t === 'custom' && customColor) ? customColor : 'transparent';
  }

  function updateGoal(data) {
    const text = data.text || '';
    const target = data.target || 1;
    const current = data.current || 0;
    const pct = Math.min(100, Math.round((current / target) * 100));

    // Default style elements
    titleEl.textContent = text ? icon + ' ' + text : icon + ' Meta';
    currentEl.textContent = prefix + current.toLocaleString('pt-BR');
    targetEl.textContent = prefix + target.toLocaleString('pt-BR');
    fillEl.style.width = pct + '%';
    percentEl.textContent = pct + '%';

    // Premium style elements
    const label = text ? text.toUpperCase() : (icon === '❤️' ? 'LIKE GOAL' : 'GOAL');
    pfText.textContent = label + ' : ' + prefix + current.toLocaleString('pt-BR') + ' / ' + prefix + target.toLocaleString('pt-BR') + ' (' + pct + '%)';
    pfFill.style.width = pct + '%';

    if (current > prevCurrent) {
      container.classList.remove('pulse');
      void container.offsetWidth;
      container.classList.add('pulse');
    }

    if (current >= target) {
      container.classList.add('goal-complete');
    } else {
      container.classList.remove('goal-complete');
    }

    if (data.style || data.theme) {
      applyStyle(data.style, data.theme, data.customColor);
    }

    prevCurrent = current;
  }

  const evtSource = new EventSource('${sseUrl}');
  evtSource.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'goal') {
      updateGoal(msg);
    }
  };
</script>
</body></html>`;
}

// ============================================
// TOP SCORE OVERLAY HTML (Velho Oeste)
// ============================================
function getTopScoreHTML(roomId) {
  const sseUrl = `/sse/${roomId}/top-score`;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Rye&family=Orbitron:wght@700;900&family=Press+Start+2P&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:transparent; display:flex; justify-content:center; align-items:flex-start; padding:10px; font-family:'Rye',cursive; }

  .card {
    width: 270px;
    background: linear-gradient(160deg, #1c0e04 0%, #2a1506 40%, #1c0e04 100%);
    border: 3px solid #c9a44a;
    border-radius: 6px;
    outline: 2px solid rgba(201,164,74,0.25);
    outline-offset: 5px;
    box-shadow: 0 0 0 1px #3d2008, 0 12px 50px rgba(0,0,0,0.95), inset 0 0 80px rgba(80,40,5,0.08);
    overflow: hidden;
    position: relative;
  }

  /* Inner wood grain lines */
  .card::before {
    content:''; position:absolute; inset:0; pointer-events:none;
    background: repeating-linear-gradient(
      175deg,
      transparent 0px, transparent 18px,
      rgba(201,164,74,0.025) 18px, rgba(201,164,74,0.025) 19px
    );
  }

  /* ── TOP BAR ── */
  .top-bar {
    background: linear-gradient(90deg, #120800, #3a1c05 25%, #4a2408 50%, #3a1c05 75%, #120800);
    border-bottom: 2px solid #c9a44a;
    padding: 12px 14px 9px;
    text-align: center; position: relative;
  }
  .top-bar::before { content:'✦ ✦'; position:absolute; left:10px; top:50%; transform:translateY(-50%); color:rgba(201,164,74,0.6); font-size:9px; letter-spacing:4px; }
  .top-bar::after  { content:'✦ ✦'; position:absolute; right:10px; top:50%; transform:translateY(-50%); color:rgba(201,164,74,0.6); font-size:9px; letter-spacing:4px; }

  .title-txt {
    font-size:22px; color:#ffd966; letter-spacing:4px; text-transform:uppercase;
    text-shadow: 0 0 16px rgba(255,180,0,0.5), 1px 1px 3px #000;
  }
  .desc-txt {
    font-size:8px; letter-spacing:3px; color:rgba(201,164,74,0.65);
    text-transform:uppercase; margin-top:3px;
  }

  /* ── CORNER ORNAMENTS ── */
  .corner { position:absolute; color:rgba(201,164,74,0.4); font-size:13px; line-height:1; }
  .corner.tl { top:6px; left:8px; }
  .corner.tr { top:6px; right:8px; }
  .corner.bl { bottom:6px; left:8px; }
  .corner.br { bottom:6px; right:8px; }

  /* ── AVATAR ── */
  .avatar-wrap {
    display:flex; flex-direction:column; align-items:center;
    padding: 22px 20px 10px; position:relative;
  }
  .avatar-crown {
    font-size:32px; margin-bottom:-14px; z-index:2; position:relative;
    filter:
      drop-shadow(0 0 6px rgba(255,200,0,0.9))
      drop-shadow(0 0 16px rgba(255,150,0,0.55))
      drop-shadow(0 5px 14px rgba(0,0,0,0.95));
    animation: float 3s ease-in-out infinite;
  }
  .avatar-crown-DISABLED { display:none; }
  @keyframes float { 0%,100%{transform:translateY(0) scale(1)} 50%{transform:translateY(-6px) scale(1.03)} }

  .avatar-ring {
    width:116px; height:116px; border-radius:50%; overflow:hidden;
    border: 4px solid #c9a44a;
    box-shadow: 0 0 0 2px rgba(201,164,74,0.3), 0 0 0 7px rgba(201,164,74,0.07), 0 0 24px rgba(201,164,74,0.35), inset 0 0 24px rgba(0,0,0,0.4);
    background:rgba(255,255,255,0.04);
    display:flex; align-items:center; justify-content:center; font-size:50px;
  }
  .avatar-ring img { width:100%; height:100%; object-fit:cover; }

  /* Sheriff star removida */

  .name-txt {
    margin-top:12px; font-size:15px; color:#ffd966; letter-spacing:1px;
    text-transform:uppercase; text-align:center; max-width:230px;
    overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
    text-shadow:1px 1px 4px #000, 0 0 12px rgba(255,200,0,0.25);
  }

  /* ── DIVIDER ── */
  .divider { display:flex; align-items:center; gap:6px; padding:0 18px; margin:6px 0 10px; }
  .div-line { flex:1; height:1px; background:linear-gradient(90deg,transparent,#c9a44a,transparent); }
  .div-star { color:#c9a44a; font-size:11px; }

  /* ── VALUE BOX ── */
  .value-box {
    text-align:center; margin:0 14px 14px;
    padding: 10px 14px 14px;
    background: linear-gradient(180deg, rgba(201,164,74,0.05), rgba(201,164,74,0.1));
    border:1px solid rgba(201,164,74,0.25); border-radius:4px;
    position:relative;
  }
  .value-box::before { display:none; }

  .subtitle-txt {
    font-size:8px; letter-spacing:3px; color:rgba(201,164,74,0.6);
    text-transform:uppercase; margin-bottom:6px;
  }
  .value-txt {
    font-size:38px; color:#e8571a;
    text-shadow: 0 0 24px rgba(220,80,0,0.6), 1px 1px 0 #000, 2px 2px 0 rgba(0,0,0,0.5);
    letter-spacing:2px; line-height:1;
  }

  /* ── BOTTOM DECO ── */
  .bottom-deco { text-align:center; padding:2px 12px 12px; color:#c9a44a; font-size:16px; letter-spacing:10px; }

  /* ══ THEMES ══ */

  /* NEON */
  .card.t-neon{background:linear-gradient(160deg,#030810,#060f1f,#030810);border-color:#00d4ff;outline-color:rgba(0,212,255,0.2);box-shadow:0 0 0 1px #002235,0 12px 50px rgba(0,0,0,0.95),0 0 30px rgba(0,212,255,0.12),inset 0 0 80px rgba(0,50,80,0.08);}
  .card.t-neon::before{display:none;}
  .card.t-neon .top-bar{background:linear-gradient(90deg,#020810,#071828,#0a2035,#071828,#020810);border-bottom-color:#00d4ff;}
  .card.t-neon .top-bar::before,.card.t-neon .top-bar::after{color:rgba(0,212,255,0.5);}
  .card.t-neon .title-txt{font-family:'Orbitron',sans-serif;color:#00d4ff;text-shadow:0 0 18px rgba(0,212,255,0.9),0 0 40px rgba(0,212,255,0.4),1px 1px 3px #000;letter-spacing:5px;}
  .card.t-neon .desc-txt{font-family:'Orbitron',sans-serif;color:rgba(0,212,255,0.65);}
  .card.t-neon .corner{color:rgba(0,212,255,0.45);}
  .card.t-neon .avatar-crown{filter:drop-shadow(0 0 6px rgba(0,212,255,0.9)) drop-shadow(0 0 16px rgba(0,150,255,0.6));}
  .card.t-neon .avatar-ring{border-color:#00d4ff;box-shadow:0 0 0 2px rgba(0,212,255,0.3),0 0 0 7px rgba(0,212,255,0.07),0 0 24px rgba(0,212,255,0.4);}
  .card.t-neon .name-txt{font-family:'Orbitron',sans-serif;color:#00d4ff;text-shadow:0 0 12px rgba(0,212,255,0.5),1px 1px 4px #000;}
  .card.t-neon .div-line{background:linear-gradient(90deg,transparent,#00d4ff,transparent);}
  .card.t-neon .div-star{color:#00d4ff;font-family:'Orbitron',sans-serif;}
  .card.t-neon .value-box{background:linear-gradient(180deg,rgba(0,212,255,0.05),rgba(0,212,255,0.1));border-color:rgba(0,212,255,0.3);}
  .card.t-neon .subtitle-txt{font-family:'Orbitron',sans-serif;color:rgba(0,212,255,0.65);}
  .card.t-neon .value-txt{font-family:'Orbitron',sans-serif;color:#00ffcc;text-shadow:0 0 24px rgba(0,255,200,0.7),0 0 50px rgba(0,212,255,0.4);}
  .card.t-neon .bottom-deco{color:#00d4ff;}

  /* RETRO */
  .card.t-retro{background:linear-gradient(160deg,#080f08,#0f1f0f,#080f08);border-color:#00ff41;outline-color:rgba(0,255,65,0.2);box-shadow:0 0 0 1px #003010,0 12px 50px rgba(0,0,0,0.95),0 0 30px rgba(0,255,65,0.1);}
  .card.t-retro::before{display:none;}
  .card.t-retro .top-bar{background:linear-gradient(90deg,#040a04,#0a1a0a,#0d200d,#0a1a0a,#040a04);border-bottom-color:#00ff41;}
  .card.t-retro .top-bar::before,.card.t-retro .top-bar::after{color:rgba(0,255,65,0.5);}
  .card.t-retro .title-txt{font-family:'Press Start 2P',cursive;font-size:14px;color:#00ff41;text-shadow:0 0 16px rgba(0,255,65,0.9),1px 1px 0 #000;letter-spacing:2px;}
  .card.t-retro .desc-txt{font-family:'Press Start 2P',cursive;font-size:6px;color:rgba(0,255,65,0.65);}
  .card.t-retro .corner{color:rgba(0,255,65,0.45);}
  .card.t-retro .avatar-crown{filter:drop-shadow(0 0 6px rgba(0,255,65,0.9)) drop-shadow(0 0 16px rgba(0,200,50,0.6));}
  .card.t-retro .avatar-ring{border-color:#00ff41;box-shadow:0 0 0 2px rgba(0,255,65,0.3),0 0 0 7px rgba(0,255,65,0.07),0 0 24px rgba(0,255,65,0.35);}
  .card.t-retro .name-txt{font-family:'Press Start 2P',cursive;font-size:10px;color:#00ff41;text-shadow:0 0 12px rgba(0,255,65,0.5),1px 1px 0 #000;}
  .card.t-retro .div-line{background:linear-gradient(90deg,transparent,#00ff41,transparent);}
  .card.t-retro .div-star{color:#00ff41;}
  .card.t-retro .value-box{background:linear-gradient(180deg,rgba(0,255,65,0.05),rgba(0,255,65,0.1));border-color:rgba(0,255,65,0.3);}
  .card.t-retro .subtitle-txt{font-family:'Press Start 2P',cursive;font-size:6px;color:rgba(0,255,65,0.65);}
  .card.t-retro .value-txt{font-family:'Press Start 2P',cursive;font-size:28px;color:#00ff41;text-shadow:0 0 24px rgba(0,255,65,0.7),0 0 50px rgba(0,255,65,0.3);}
  .card.t-retro .bottom-deco{color:#00ff41;font-family:'Press Start 2P',cursive;font-size:8px;letter-spacing:6px;}

  /* FIRE */
  .card.t-fire{background:linear-gradient(160deg,#1a0500,#280a00,#1a0500);border-color:#ff6a00;outline-color:rgba(255,106,0,0.2);box-shadow:0 0 0 1px #3d1400,0 12px 50px rgba(0,0,0,0.95),0 0 30px rgba(255,80,0,0.15),inset 0 0 80px rgba(80,20,5,0.08);}
  .card.t-fire::before{display:none;}
  .card.t-fire .top-bar{background:linear-gradient(90deg,#0f0300,#200700,#2a0a00,#200700,#0f0300);border-bottom-color:#ff6a00;}
  .card.t-fire .top-bar::before,.card.t-fire .top-bar::after{color:rgba(255,106,0,0.5);}
  .card.t-fire .title-txt{color:#ff8800;text-shadow:0 0 18px rgba(255,100,0,0.9),0 0 40px rgba(255,50,0,0.5),1px 1px 3px #000;}
  .card.t-fire .desc-txt{color:rgba(255,106,0,0.65);}
  .card.t-fire .corner{color:rgba(255,106,0,0.4);}
  .card.t-fire .avatar-crown{filter:drop-shadow(0 0 6px rgba(255,100,0,0.9)) drop-shadow(0 0 16px rgba(255,50,0,0.6));}
  .card.t-fire .avatar-ring{border-color:#ff6a00;box-shadow:0 0 0 2px rgba(255,106,0,0.3),0 0 0 7px rgba(255,106,0,0.07),0 0 24px rgba(255,80,0,0.4);}
  .card.t-fire .name-txt{color:#ff8800;text-shadow:0 0 12px rgba(255,100,0,0.5),1px 1px 4px #000;}
  .card.t-fire .div-line{background:linear-gradient(90deg,transparent,#ff6a00,transparent);}
  .card.t-fire .div-star{color:#ff6a00;}
  .card.t-fire .value-box{background:linear-gradient(180deg,rgba(255,106,0,0.05),rgba(255,80,0,0.12));border-color:rgba(255,106,0,0.3);}
  .card.t-fire .subtitle-txt{color:rgba(255,106,0,0.65);}
  .card.t-fire .value-txt{color:#ff3300;text-shadow:0 0 24px rgba(255,50,0,0.7),0 0 50px rgba(255,100,0,0.4);}
  .card.t-fire .bottom-deco{color:#ff6a00;}

  /* ICE */
  .card.t-ice{background:linear-gradient(160deg,#040c18,#071525,#040c18);border-color:#7ecfff;outline-color:rgba(126,207,255,0.2);box-shadow:0 0 0 1px #102540,0 12px 50px rgba(0,0,0,0.95),0 0 30px rgba(100,200,255,0.12),inset 0 0 80px rgba(10,40,80,0.08);}
  .card.t-ice::before{display:none;}
  .card.t-ice .top-bar{background:linear-gradient(90deg,#020810,#061420,#081b2e,#061420,#020810);border-bottom-color:#7ecfff;}
  .card.t-ice .top-bar::before,.card.t-ice .top-bar::after{color:rgba(126,207,255,0.5);}
  .card.t-ice .title-txt{font-family:'Orbitron',sans-serif;color:#aaddff;text-shadow:0 0 18px rgba(100,200,255,0.8),0 0 40px rgba(80,180,255,0.4),1px 1px 3px #000;letter-spacing:5px;}
  .card.t-ice .desc-txt{font-family:'Orbitron',sans-serif;color:rgba(126,207,255,0.65);}
  .card.t-ice .corner{color:rgba(126,207,255,0.4);}
  .card.t-ice .avatar-crown{filter:drop-shadow(0 0 6px rgba(100,200,255,0.9)) drop-shadow(0 0 16px rgba(80,180,255,0.6));}
  .card.t-ice .avatar-ring{border-color:#7ecfff;box-shadow:0 0 0 2px rgba(126,207,255,0.3),0 0 0 7px rgba(126,207,255,0.07),0 0 24px rgba(100,200,255,0.35);}
  .card.t-ice .name-txt{font-family:'Orbitron',sans-serif;color:#aaddff;text-shadow:0 0 12px rgba(100,200,255,0.5),1px 1px 4px #000;}
  .card.t-ice .div-line{background:linear-gradient(90deg,transparent,#7ecfff,transparent);}
  .card.t-ice .div-star{color:#7ecfff;font-family:'Orbitron',sans-serif;}
  .card.t-ice .value-box{background:linear-gradient(180deg,rgba(126,207,255,0.05),rgba(100,200,255,0.12));border-color:rgba(126,207,255,0.3);}
  .card.t-ice .subtitle-txt{font-family:'Orbitron',sans-serif;color:rgba(126,207,255,0.65);}
  .card.t-ice .value-txt{font-family:'Orbitron',sans-serif;color:#00ccff;text-shadow:0 0 24px rgba(0,200,255,0.7),0 0 50px rgba(80,200,255,0.4);}
  .card.t-ice .bottom-deco{color:#7ecfff;}

  /* ROSA */
  .card.t-rosa{background:linear-gradient(160deg,#1a0612,#3d0a28,#1a0612);border-color:#ff69b4;outline-color:rgba(255,105,180,0.25);box-shadow:0 0 0 1px #500724,0 12px 50px rgba(0,0,0,0.95),0 0 30px rgba(255,105,180,0.18),inset 0 0 80px rgba(80,10,40,0.1);}
  .card.t-rosa::before{display:none;}
  .card.t-rosa .top-bar{background:linear-gradient(90deg,#100410,#2a0820,#3d0a28,#2a0820,#100410);border-bottom-color:#ff69b4;}
  .card.t-rosa .top-bar::before,.card.t-rosa .top-bar::after{color:rgba(255,105,180,0.5);}
  .card.t-rosa .title-txt{font-family:'Poppins',sans-serif;color:#ff69b4;text-shadow:0 0 18px rgba(255,105,180,0.85),0 0 40px rgba(236,72,153,0.45),1px 1px 3px #000;letter-spacing:4px;}
  .card.t-rosa .desc-txt{font-family:'Poppins',sans-serif;color:rgba(255,182,213,0.7);}
  .card.t-rosa .corner{color:rgba(255,105,180,0.4);}
  .card.t-rosa .avatar-crown{filter:drop-shadow(0 0 6px rgba(255,105,180,0.9)) drop-shadow(0 0 16px rgba(236,72,153,0.6));}
  .card.t-rosa .avatar-ring{border-color:#ff69b4;box-shadow:0 0 0 2px rgba(255,105,180,0.3),0 0 0 7px rgba(255,105,180,0.07),0 0 24px rgba(255,105,180,0.4);}
  .card.t-rosa .name-txt{font-family:'Poppins',sans-serif;color:#ff69b4;text-shadow:0 0 12px rgba(255,105,180,0.55),1px 1px 4px #000;}
  .card.t-rosa .div-line{background:linear-gradient(90deg,transparent,#ff69b4,transparent);}
  .card.t-rosa .div-star{color:#ff69b4;font-family:'Poppins',sans-serif;}
  .card.t-rosa .value-box{background:linear-gradient(180deg,rgba(255,105,180,0.05),rgba(236,72,153,0.12));border-color:rgba(255,105,180,0.3);}
  .card.t-rosa .subtitle-txt{font-family:'Poppins',sans-serif;color:rgba(255,182,213,0.7);}
  .card.t-rosa .value-txt{font-family:'Poppins',sans-serif;color:#ec4899;text-shadow:0 0 24px rgba(236,72,153,0.7),0 0 50px rgba(255,105,180,0.4);}
  .card.t-rosa .bottom-deco{color:#ff69b4;}

  /* ROXO */
  .card.t-roxo{background:linear-gradient(160deg,#0d0520,#180838,#0d0520);border-color:#9b5de5;outline-color:rgba(155,93,229,0.2);box-shadow:0 0 0 1px #2a0a50,0 12px 50px rgba(0,0,0,0.95),0 0 30px rgba(155,93,229,0.15),inset 0 0 80px rgba(50,10,80,0.08);}
  .card.t-roxo::before{display:none;}
  .card.t-roxo .top-bar{background:linear-gradient(90deg,#07021a,#10053a,#160545,#10053a,#07021a);border-bottom-color:#9b5de5;}
  .card.t-roxo .top-bar::before,.card.t-roxo .top-bar::after{color:rgba(155,93,229,0.5);}
  .card.t-roxo .title-txt{color:#c77dff;text-shadow:0 0 18px rgba(180,100,255,0.9),0 0 40px rgba(155,93,229,0.5),1px 1px 3px #000;}
  .card.t-roxo .desc-txt{color:rgba(155,93,229,0.7);}
  .card.t-roxo .corner{color:rgba(155,93,229,0.4);}
  .card.t-roxo .avatar-crown{filter:drop-shadow(0 0 6px rgba(180,100,255,0.9)) drop-shadow(0 0 16px rgba(155,93,229,0.6));}
  .card.t-roxo .avatar-ring{border-color:#9b5de5;box-shadow:0 0 0 2px rgba(155,93,229,0.3),0 0 0 7px rgba(155,93,229,0.07),0 0 24px rgba(155,93,229,0.4);}
  .card.t-roxo .name-txt{color:#c77dff;text-shadow:0 0 12px rgba(180,100,255,0.5),1px 1px 4px #000;}
  .card.t-roxo .div-line{background:linear-gradient(90deg,transparent,#9b5de5,transparent);}
  .card.t-roxo .div-star{color:#9b5de5;}
  .card.t-roxo .value-box{background:linear-gradient(180deg,rgba(155,93,229,0.05),rgba(155,93,229,0.12));border-color:rgba(155,93,229,0.3);}
  .card.t-roxo .subtitle-txt{color:rgba(155,93,229,0.7);}
  .card.t-roxo .value-txt{color:#c77dff;text-shadow:0 0 24px rgba(180,100,255,0.7),0 0 50px rgba(155,93,229,0.4);}
  .card.t-roxo .bottom-deco{color:#9b5de5;}

  /* CLEAN */
  .card.t-clean{background:transparent;border-color:rgba(255,255,255,0.12);outline-color:transparent;box-shadow:none;}
  .card.t-clean::before{display:none;}
  .card.t-clean .top-bar{background:rgba(0,0,0,0.35);border-bottom-color:rgba(255,255,255,0.15);}
  .card.t-clean .top-bar::before,.card.t-clean .top-bar::after{color:rgba(255,255,255,0.3);}
  .card.t-clean .title-txt{color:#fff;text-shadow:0 2px 8px rgba(0,0,0,0.8);}
  .card.t-clean .desc-txt{color:rgba(255,255,255,0.55);}
  .card.t-clean .corner{color:rgba(255,255,255,0.25);}
  .card.t-clean .avatar-crown{filter:none;}
  .card.t-clean .avatar-ring{border-color:rgba(255,255,255,0.4);box-shadow:none;}
  .card.t-clean .name-txt{color:#fff;text-shadow:0 2px 8px rgba(0,0,0,0.8);}
  .card.t-clean .div-line{background:linear-gradient(90deg,transparent,rgba(255,255,255,0.3),transparent);}
  .card.t-clean .div-star{color:rgba(255,255,255,0.4);}
  .card.t-clean .value-box{background:rgba(0,0,0,0.2);border-color:rgba(255,255,255,0.15);}
  .card.t-clean .subtitle-txt{color:rgba(255,255,255,0.55);}
  .card.t-clean .value-txt{color:#fff;text-shadow:0 2px 8px rgba(0,0,0,0.8);}
  .card.t-clean .bottom-deco{color:rgba(255,255,255,0.35);}

  /* CUSTOM */
  .card.t-custom{background:linear-gradient(160deg,#080808,#111,#080808);border-color:var(--ts-custom,#fff);outline-color:rgba(255,255,255,0.1);box-shadow:0 0 0 1px rgba(0,0,0,0.8),0 12px 50px rgba(0,0,0,0.95);}
  .card.t-custom::before{display:none;}
  .card.t-custom .top-bar{background:linear-gradient(90deg,#040404,#0c0c0c,#101010,#0c0c0c,#040404);border-bottom-color:var(--ts-custom,#fff);}
  .card.t-custom .top-bar::before,.card.t-custom .top-bar::after{color:var(--ts-custom,rgba(255,255,255,0.5));}
  .card.t-custom .title-txt{color:var(--ts-custom,#fff);text-shadow:0 0 18px var(--ts-custom,rgba(255,255,255,0.8)),1px 1px 3px #000;}
  .card.t-custom .desc-txt{color:var(--ts-custom,rgba(255,255,255,0.65));opacity:0.8;}
  .card.t-custom .corner{color:var(--ts-custom,rgba(255,255,255,0.4));opacity:0.7;}
  .card.t-custom .avatar-crown{filter:drop-shadow(0 0 8px var(--ts-custom,rgba(255,255,255,0.9)));}
  .card.t-custom .avatar-ring{border-color:var(--ts-custom,#fff);box-shadow:0 0 0 2px var(--ts-custom,rgba(255,255,255,0.3)),0 0 24px var(--ts-custom,rgba(255,255,255,0.3));}
  .card.t-custom .name-txt{color:var(--ts-custom,#fff);}
  .card.t-custom .div-line{background:linear-gradient(90deg,transparent,var(--ts-custom,#fff),transparent);}
  .card.t-custom .div-star{color:var(--ts-custom,#fff);}
  .card.t-custom .value-box{background:rgba(0,0,0,0.2);border-color:var(--ts-custom,rgba(255,255,255,0.3));}
  .card.t-custom .subtitle-txt{color:var(--ts-custom,rgba(255,255,255,0.65));opacity:0.8;}
  .card.t-custom .value-txt{color:var(--ts-custom,#fff);text-shadow:0 0 24px var(--ts-custom,rgba(255,255,255,0.7));}
  .card.t-custom .bottom-deco{color:var(--ts-custom,rgba(255,255,255,0.5));}
</style>
</head>
<body>
<div class="card">
  <span class="corner tl">✦</span>
  <span class="corner tr">✦</span>
  <span class="corner bl">✦</span>
  <span class="corner br">✦</span>

  <div class="top-bar">
    <div class="title-txt" id="title-el">TOP</div>
    <div class="desc-txt"  id="desc-el"> </div>
  </div>

  <div class="avatar-wrap">
    <div class="avatar-crown">👑</div>
    <div class="avatar-crown-DISABLED"><svg xmlns="http://www.w3.org/2000/svg" width="162" height="88" viewBox="0 0 200 108">
  <defs>
    <!-- Gradiente dourado para pontas (diagonal metalico) -->
    <linearGradient id="gSpk" x1="20%" y1="0%" x2="80%" y2="100%">
      <stop offset="0%"   stop-color="#fff8b0"/>
      <stop offset="18%"  stop-color="#fdd84a"/>
      <stop offset="50%"  stop-color="#c07810"/>
      <stop offset="75%"  stop-color="#e8a818"/>
      <stop offset="100%" stop-color="#7a4400"/>
    </linearGradient>
    <!-- Gradiente para pontas laterais -->
    <linearGradient id="gSpkS" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#ffe878"/>
      <stop offset="40%"  stop-color="#d09018"/>
      <stop offset="100%" stop-color="#7a4400"/>
    </linearGradient>
    <!-- Gradiente da banda (cilindro) -->
    <linearGradient id="gBnd" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%"   stop-color="#f8e050"/>
      <stop offset="22%"  stop-color="#d4a018"/>
      <stop offset="52%"  stop-color="#c08010"/>
      <stop offset="78%"  stop-color="#dca028"/>
      <stop offset="100%" stop-color="#8a4e00"/>
    </linearGradient>
    <!-- Elipse superior da banda -->
    <linearGradient id="gEllT" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%"   stop-color="#f8e060"/>
      <stop offset="100%" stop-color="#b07c10"/>
    </linearGradient>
    <!-- Esfera dourada (orb) - efeito 3D -->
    <radialGradient id="gOrb" cx="32%" cy="27%" r="68%">
      <stop offset="0%"   stop-color="#fffce0"/>
      <stop offset="22%"  stop-color="#ffe050"/>
      <stop offset="62%"  stop-color="#b07010"/>
      <stop offset="100%" stop-color="#5a3000"/>
    </radialGradient>
    <!-- Rubi vermelho -->
    <radialGradient id="gRub" cx="33%" cy="28%" r="68%">
      <stop offset="0%"   stop-color="#ffb0b0"/>
      <stop offset="32%"  stop-color="#e01818"/>
      <stop offset="100%" stop-color="#6a0000"/>
    </radialGradient>
    <!-- Esmeralda verde -->
    <radialGradient id="gEmd" cx="33%" cy="28%" r="68%">
      <stop offset="0%"   stop-color="#b0ffb8"/>
      <stop offset="32%"  stop-color="#18a030"/>
      <stop offset="100%" stop-color="#004010"/>
    </radialGradient>
    <!-- Interior inferior da banda (reflexo avermelhado) -->
    <linearGradient id="gInn" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%"   stop-color="#b85a00"/>
      <stop offset="100%" stop-color="#2a0c00"/>
    </linearGradient>
    <!-- Sombra geral -->
    <filter id="drp" x="-8%" y="-5%" width="120%" height="125%">
      <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="rgba(0,0,0,0.85)"/>
    </filter>
  </defs>

  <g filter="url(#drp)">

    <!-- ══ PONTAS (desenhadas antes da banda) ══ -->

    <!-- Ponta far-esquerda -->
    <path d="M 4,68 C 6,58 12,52 18,42 C 24,52 29,58 33,68 Z" fill="url(#gSpkS)"/>
    <path d="M 4,68 C 6,58 12,52 18,42 C 14,52 10,58 9,68 Z"  fill="rgba(255,255,160,0.28)"/>

    <!-- Ponta meio-esquerda -->
    <path d="M 36,68 C 40,52 47,34 55,18 C 63,34 70,52 74,68 Z" fill="url(#gSpk)"/>
    <path d="M 36,68 C 40,52 47,34 55,18 C 50,34 45,52 42,68 Z" fill="rgba(255,255,160,0.30)"/>
    <path d="M 74,68 C 70,52 63,34 55,18 C 59,34 65,52 68,68 Z" fill="rgba(0,0,0,0.16)"/>

    <!-- Ponta central (mais alta) -->
    <path d="M 76,68 C 80,46 88,24 100,9 C 112,24 120,46 124,68 Z" fill="url(#gSpk)"/>
    <path d="M 76,68 C 80,46 88,24 100,9 C 94,24 87,46 84,68 Z"    fill="rgba(255,255,160,0.35)"/>
    <path d="M 124,68 C 120,46 112,24 100,9 C 106,24 113,46 116,68 Z" fill="rgba(0,0,0,0.18)"/>

    <!-- Ponta meio-direita -->
    <path d="M 126,68 C 130,52 137,34 145,18 C 153,34 160,52 164,68 Z" fill="url(#gSpk)"/>
    <path d="M 126,68 C 130,52 137,34 145,18 C 140,34 135,52 132,68 Z" fill="rgba(255,255,160,0.20)"/>
    <path d="M 164,68 C 160,52 153,34 145,18 C 149,34 155,52 159,68 Z" fill="rgba(0,0,0,0.16)"/>

    <!-- Ponta far-direita -->
    <path d="M 167,68 C 171,58 177,52 182,42 C 188,52 193,58 196,68 Z" fill="url(#gSpkS)"/>
    <path d="M 196,68 C 193,58 188,52 182,42 C 186,52 190,58 191,68 Z" fill="rgba(0,0,0,0.14)"/>

    <!-- ══ BANDA CILÍNDRICA ══ -->
    <!-- Interior inferior (reflexo avermelhado) -->
    <rect x="4" y="94" width="192" height="10" rx="3" fill="url(#gInn)"/>
    <!-- Corpo principal da banda -->
    <rect x="4" y="66" width="192" height="34" fill="url(#gBnd)"/>
    <!-- Brilho superior da banda -->
    <rect x="4" y="66" width="192" height="15" fill="rgba(255,255,255,0.11)"/>
    <!-- Linha divisória horizontal -->
    <rect x="4" y="80" width="192" height="1.8" fill="rgba(255,220,60,0.32)"/>
    <!-- Elipse superior (perspectiva 3D) -->
    <ellipse cx="100" cy="66" rx="96" ry="8"   fill="url(#gEllT)"/>
    <ellipse cx="100" cy="66" rx="96" ry="8"   fill="rgba(255,255,255,0.20)"/>
    <ellipse cx="100" cy="66" rx="96" ry="8"   fill="none" stroke="#ffe050" stroke-width="1.4"/>
    <!-- Elipse inferior -->
    <ellipse cx="100" cy="100" rx="96" ry="6.5" fill="#9a5a08"/>
    <ellipse cx="100" cy="100" rx="96" ry="6.5" fill="none" stroke="#dda018" stroke-width="1" opacity="0.7"/>

    <!-- ══ PÉROLAS — borda superior ══ -->
    <circle cx="16"  cy="59" r="2.4" fill="white" opacity="0.88"/>
    <circle cx="31"  cy="56" r="2.4" fill="white" opacity="0.88"/>
    <circle cx="47"  cy="55" r="2.4" fill="white" opacity="0.88"/>
    <circle cx="63"  cy="54" r="2.4" fill="white" opacity="0.88"/>
    <circle cx="82"  cy="57" r="2.4" fill="white" opacity="0.88"/>
    <circle cx="100" cy="57" r="2.4" fill="white" opacity="0.88"/>
    <circle cx="118" cy="57" r="2.4" fill="white" opacity="0.88"/>
    <circle cx="137" cy="54" r="2.4" fill="white" opacity="0.88"/>
    <circle cx="153" cy="55" r="2.4" fill="white" opacity="0.88"/>
    <circle cx="169" cy="56" r="2.4" fill="white" opacity="0.88"/>
    <circle cx="184" cy="59" r="2.4" fill="white" opacity="0.88"/>

    <!-- ══ PÉROLAS — borda inferior ══ -->
    <circle cx="16"  cy="97"  r="2.2" fill="white" opacity="0.72"/>
    <circle cx="34"  cy="99"  r="2.2" fill="white" opacity="0.72"/>
    <circle cx="52"  cy="100" r="2.2" fill="white" opacity="0.72"/>
    <circle cx="70"  cy="101" r="2.2" fill="white" opacity="0.72"/>
    <circle cx="88"  cy="102" r="2.2" fill="white" opacity="0.72"/>
    <circle cx="100" cy="102" r="2.2" fill="white" opacity="0.72"/>
    <circle cx="112" cy="102" r="2.2" fill="white" opacity="0.72"/>
    <circle cx="130" cy="101" r="2.2" fill="white" opacity="0.72"/>
    <circle cx="148" cy="100" r="2.2" fill="white" opacity="0.72"/>
    <circle cx="166" cy="99"  r="2.2" fill="white" opacity="0.72"/>
    <circle cx="184" cy="97"  r="2.2" fill="white" opacity="0.72"/>

    <!-- ══ PEDRAS NA BANDA ══ -->
    <!-- Rubi central -->
    <circle cx="100" cy="82" r="8"   fill="#a06010" stroke="#ffe050" stroke-width="1.2"/>
    <circle cx="100" cy="82" r="6"   fill="url(#gRub)"/>
    <circle cx="98"  cy="80" r="2.2" fill="rgba(255,255,255,0.62)"/>
    <!-- Esmeralda esquerda -->
    <circle cx="66"  cy="83" r="6.5" fill="#a06010" stroke="#ffe050" stroke-width="1"/>
    <circle cx="66"  cy="83" r="4.8" fill="url(#gEmd)"/>
    <circle cx="64.5" cy="81.5" r="1.8" fill="rgba(255,255,255,0.60)"/>
    <!-- Rubi direito -->
    <circle cx="134" cy="83" r="6.5" fill="#a06010" stroke="#ffe050" stroke-width="1"/>
    <circle cx="134" cy="83" r="4.8" fill="url(#gRub)"/>
    <circle cx="132.5" cy="81.5" r="1.8" fill="rgba(255,255,255,0.60)"/>
    <!-- Esmeralda far-esquerda -->
    <circle cx="30"  cy="79" r="5.2" fill="#a06010" stroke="#ffe050" stroke-width="0.8"/>
    <circle cx="30"  cy="79" r="3.8" fill="url(#gEmd)"/>
    <circle cx="28.8" cy="77.8" r="1.4" fill="rgba(255,255,255,0.60)"/>
    <!-- Rubi far-direito -->
    <circle cx="170" cy="79" r="5.2" fill="#a06010" stroke="#ffe050" stroke-width="0.8"/>
    <circle cx="170" cy="79" r="3.8" fill="url(#gRub)"/>
    <circle cx="168.8" cy="77.8" r="1.4" fill="rgba(255,255,255,0.60)"/>

    <!-- ══ PEDRAS NAS PONTAS ══ -->
    <!-- Rubi — ponta central -->
    <circle cx="100" cy="34" r="7"   fill="#a06010" stroke="#ffe050" stroke-width="0.8"/>
    <circle cx="100" cy="34" r="5.2" fill="url(#gRub)"/>
    <circle cx="98.2" cy="32.2" r="2"  fill="rgba(255,255,255,0.62)"/>
    <!-- Rubi — ponta meio-esquerda -->
    <circle cx="55"  cy="46" r="5.5" fill="#a06010" stroke="#ffe050" stroke-width="0.8"/>
    <circle cx="55"  cy="46" r="4"   fill="url(#gRub)"/>
    <circle cx="53.5" cy="44.5" r="1.5" fill="rgba(255,255,255,0.60)"/>
    <!-- Rubi — ponta meio-direita -->
    <circle cx="145" cy="46" r="5.5" fill="#a06010" stroke="#ffe050" stroke-width="0.8"/>
    <circle cx="145" cy="46" r="4"   fill="url(#gRub)"/>
    <circle cx="143.5" cy="44.5" r="1.5" fill="rgba(255,255,255,0.60)"/>

    <!-- ══ ESFERAS DOURADAS no topo das pontas ══ -->
    <circle cx="18"  cy="42" r="6"   fill="url(#gOrb)" stroke="#c07808" stroke-width="0.6"/>
    <circle cx="55"  cy="17" r="7.5" fill="url(#gOrb)" stroke="#c07808" stroke-width="0.6"/>
    <circle cx="100" cy="8"  r="9"   fill="url(#gOrb)" stroke="#c07808" stroke-width="0.6"/>
    <circle cx="145" cy="17" r="7.5" fill="url(#gOrb)" stroke="#c07808" stroke-width="0.6"/>
    <circle cx="182" cy="42" r="6"   fill="url(#gOrb)" stroke="#c07808" stroke-width="0.6"/>

  </g>
</svg></div>
    <div class="avatar-ring" id="avatar-el">${String.fromCodePoint(128100)}</div>
    <div class="name-txt" id="name-el">—</div>
  </div>

  <div class="divider">
    <div class="div-line"></div>
    <span class="div-star">✦</span>
    <div class="div-line"></div>
  </div>

  <div class="value-box">
    <div class="subtitle-txt" id="subtitle-el">PONTUAÇÃO</div>
    <div class="value-txt"    id="value-el">0</div>
  </div>

  <div class="bottom-deco">⭐ ⭐ ⭐</div>
</div>
<script>
  const titleEl    = document.getElementById('title-el');
  const descEl     = document.getElementById('desc-el');
  const subtitleEl = document.getElementById('subtitle-el');
  const avatarEl   = document.getElementById('avatar-el');
  const nameEl     = document.getElementById('name-el');
  const valueEl    = document.getElementById('value-el');

  new EventSource('${sseUrl}').onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'full') render(msg.data);
  };

  function render(d) {
    titleEl.textContent    = d.title    || 'TOP';
    descEl.textContent     = d.desc     || '';
    subtitleEl.textContent = d.subtitle || 'PONTUAÇÃO';
    nameEl.textContent     = d.name     || '—';
    valueEl.textContent    = Number(d.valor || 0).toLocaleString('pt-BR');
    avatarEl.innerHTML     = d.avatar
      ? '<img src="' + esc(d.avatar) + '" onerror="this.parentElement.innerHTML=String.fromCodePoint(128100)">'
      : String.fromCodePoint(128100);
    applyTheme(d.theme, d.customColor);
  }

  function applyTheme(theme, customColor) {
    const card = document.querySelector('.card');
    if (!card) return;
    const t = theme || 'dourado';
    card.className = 'card' + (t !== 'dourado' ? ' t-' + t : '');
    if (t === 'custom' && customColor) {
      card.style.setProperty('--ts-custom', customColor);
    } else {
      card.style.removeProperty('--ts-custom');
    }
  }

  function esc(s) { const d=document.createElement('div'); d.textContent=String(s); return d.innerHTML; }
</script>
</body>
</html>`;
}

// ============================================
// MEMBROS OVERLAY HTML
// ============================================
function getMembrosHTML(roomId) {
  const sseUrl = `/sse/${roomId}/membros`;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@700;900&family=Orbitron:wght@700;900&family=Press+Start+2P&family=Cinzel:wght@700&family=Russo+One&family=Rajdhani:wght@700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: transparent; overflow: hidden; font-family: 'Segoe UI', sans-serif; }

  #container { display: flex; flex-direction: column; align-items: center; padding: 10px 0 8px; width: 100%; }

  #title-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }

  #heart-icon {
    width: 42px; height: 42px; object-fit: contain;
    animation: heartbeat 1.6s ease-in-out infinite;
    filter: drop-shadow(0 0 6px rgba(255,80,80,0.7)); flex-shrink: 0;
  }
  @keyframes heartbeat {
    0%   { transform: scale(1)    rotate(-3deg); }
    20%  { transform: scale(1.18) rotate(3deg);  }
    40%  { transform: scale(1)    rotate(-2deg); }
    60%  { transform: scale(1.08) rotate(2deg);  }
    80%  { transform: scale(1)    rotate(0deg);  }
    100% { transform: scale(1)    rotate(-3deg); }
  }

  #title {
    font-family: 'Orbitron', sans-serif; font-size: 16px; font-weight: 900;
    color: #fff; text-shadow: 0 0 14px rgba(255,255,255,0.5), 0 2px 4px rgba(0,0,0,0.9);
    text-transform: uppercase; letter-spacing: 2px;
    padding: 5px 22px; background: rgba(0,0,0,0.45);
    border-radius: 20px; border: 1px solid rgba(255,255,255,0.18); white-space: nowrap;
  }

  #stage {
    width: 100%; height: 88px; overflow: hidden; position: relative;
  }

  .mc {
    position: absolute; top: 4px;
    display: flex; flex-direction: column; align-items: center; gap: 5px;
    width: 130px; will-change: transform;
  }
  .ma {
    width: 58px; height: 58px; border-radius: 50%; overflow: hidden;
    border: 2px solid rgba(255,255,255,0.5); background: rgba(255,255,255,0.08);
    display: flex; align-items: center; justify-content: center; font-size: 26px;
    box-shadow: 0 0 10px rgba(0,0,0,0.5);
  }
  .ma img { width: 100%; height: 100%; object-fit: cover; }
  .mn {
    font-family: 'Poppins', sans-serif;
    font-size: 15px; font-weight: 700; color: #fff;
    text-shadow: 0 1px 3px rgba(0,0,0,0.95);
    max-width: 130px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: center;
  }
  .empty-msg { color: rgba(255,255,255,0.35); font-size: 13px; padding: 20px 16px; text-align: center; width: 100%; }
</style>
</head>
<body>
<div id="container">
  <div id="title-row">
    <img id="heart-icon" src="https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/d56945782445b0b8c8658ed44f894c7b~tplv-obj.webp" alt="">
    <div id="title">Membros</div>
  </div>
  <div id="stage">
    <div class="empty-msg" id="empty-msg">Aguardando heartmes...</div>
  </div>
</div>
<script>
  const titleEl = document.getElementById('title');
  const stage   = document.getElementById('stage');
  const emptyEl = document.getElementById('empty-msg');

  const CARD_W  = 130;
  const GAP     = 22;
  const STEP    = CARD_W + GAP; // 152px per slot
  const SPEED   = 80;           // px per second

  let cards      = [];       // [{el, x, userId}]
  let renderedIds = new Set(); // userId already on stage
  let animId     = null;
  let lastTs     = null;
  let vw         = 800;

  window.addEventListener('load', () => { vw = stage.offsetWidth || window.innerWidth || 800; });
  setTimeout(() => { vw = stage.offsetWidth || window.innerWidth || 800; }, 200);

  new EventSource('${sseUrl}').onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'full') render(msg.data);
  };

  let nameFont = '';
  function render(data) {
    titleEl.textContent = data.title || 'Membros';
    nameFont = data.nameFont || '';
    const members = data.members || [];

    // RESET: if members list is empty, clear everything
    if (members.length === 0) {
      if (animId) { cancelAnimationFrame(animId); animId = null; }
      cards.forEach(c => c.el.remove());
      cards = [];
      renderedIds.clear();
      emptyEl.style.display = '';
      return;
    }

    emptyEl.style.display = 'none';
    vw = stage.offsetWidth || window.innerWidth || 800;

    // Update font on ALL existing name elements
    cards.forEach(card => {
      const nm = card.el.querySelector('.mn');
      if (nm) nm.style.fontFamily = nameFont ? nameFont + ',sans-serif' : '';
    });

    // Only add members that aren't already on stage
    const newMembers = members.filter(m => !renderedIds.has(m.userId));

    newMembers.forEach(m => {
      renderedIds.add(m.userId);

      const el = document.createElement('div');
      el.className = 'mc';
      const av = m.profilePictureUrl
        ? '<img src="' + esc(m.profilePictureUrl) + '" onerror="this.parentElement.innerHTML=String.fromCodePoint(128100)">'
        : String.fromCodePoint(128100);
      el.innerHTML = '<div class="ma">' + av + '</div><div class="mn" style="' + (nameFont ? 'font-family:' + nameFont + ',sans-serif;' : '') + '">' + esc(m.nickname) + '</div>';
      stage.appendChild(el);

      // Place at end of queue, always past the right edge
      const maxX = cards.length > 0
        ? Math.max(...cards.map(c => c.x), vw - STEP) + STEP
        : vw;
      el.style.transform = 'translateX(' + maxX + 'px)';
      cards.push({ el, x: maxX, userId: m.userId });
    });

    // Start animation if not already running
    if (!animId && cards.length > 0) {
      lastTs = null;
      animId = requestAnimationFrame(tick);
    }
  }

  function tick(ts) {
    if (lastTs === null) lastTs = ts;
    const dt = Math.min((ts - lastTs) / 1000, 0.05);
    lastTs = ts;

    cards.forEach(card => {
      card.x -= SPEED * dt;

      // When card fully exits left, place it after the rightmost card
      // but always at least off-screen right (>= vw), so it travels the full width
      if (card.x + CARD_W < 0) {
        const maxX = Math.max(...cards.map(c => c.x), vw - STEP);
        card.x = maxX + STEP;
      }

      card.el.style.transform = 'translateX(' + card.x + 'px)';
    });

    animId = requestAnimationFrame(tick);
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
</script>
</body>
</html>`;
}

function getMembrosAcaoHTML(roomId) {
  const sseUrl = `/sse/${roomId}/membros-acao`;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@700;900&family=Orbitron:wght@700;900&family=Press+Start+2P&family=Cinzel:wght@700&family=Russo+One&family=Rajdhani:wght@700&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:transparent; overflow:hidden; font-family:'Segoe UI',sans-serif; }
  #container { display:flex; flex-direction:column; align-items:center; padding:10px 0 8px; width:100%; }
  #title-row { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
  #gift-icon {
    width:42px; height:42px; object-fit:contain; flex-shrink:0;
    animation:giftPulse 2s ease-in-out infinite;
    filter:drop-shadow(0 0 8px rgba(255,200,0,0.8));
  }
  @keyframes giftPulse {
    0%,100% { transform:scale(1) rotate(-5deg); }
    50%     { transform:scale(1.2) rotate(5deg); }
  }
  #title {
    font-family:'Orbitron',sans-serif; font-size:16px; font-weight:900;
    color:#fff; text-shadow:0 0 14px rgba(255,255,255,0.5),0 2px 4px rgba(0,0,0,0.9);
    text-transform:uppercase; letter-spacing:2px;
    padding:5px 22px; background:rgba(0,0,0,0.45);
    border-radius:20px; border:1px solid rgba(255,255,255,0.18); white-space:nowrap;
  }
  #stage { width:100%; height:130px; overflow:visible; position:relative; }
  .mc {
    position:absolute; top:4px;
    display:flex; flex-direction:column; align-items:center; gap:3px;
    width:130px; will-change:transform;
  }
  .ma {
    width:58px; height:58px; border-radius:50%; overflow:hidden;
    border:2px solid rgba(255,255,255,0.5); background:rgba(255,255,255,0.08);
    display:flex; align-items:center; justify-content:center; font-size:26px;
    box-shadow:0 0 10px rgba(0,0,0,0.5); flex-shrink:0;
  }
  .ma img { width:100%; height:100%; object-fit:cover; }
  .mn {
    font-family:'Poppins',sans-serif;
    font-size:15px; font-weight:700; color:#fff;
    text-shadow:0 1px 3px rgba(0,0,0,0.95);
    max-width:130px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; text-align:center;
    line-height:1.2;
  }
  .msub {
    font-size:9px; font-weight:600;
    text-shadow:0 1px 3px rgba(0,0,0,0.95);
    max-width:86px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; text-align:center;
    line-height:1.2;
  }
  .empty-msg { color:rgba(255,255,255,0.35); font-size:13px; padding:20px 16px; text-align:center; width:100%; }
</style>
</head>
<body>
<div id="container">
  <div id="title-row">
    <img id="gift-icon" src="" alt="" onerror="this.style.display='none'">
    <div id="title">Membros Ação</div>
  </div>
  <div id="stage">
    <div class="empty-msg" id="empty-msg">Aguardando presentes...</div>
  </div>
</div>
<script>
  const titleEl  = document.getElementById('title');
  const giftIcon = document.getElementById('gift-icon');
  const stage    = document.getElementById('stage');
  const emptyEl  = document.getElementById('empty-msg');

  const CARD_W = 130;
  const GAP    = 20;
  const STEP   = CARD_W + GAP;
  const SPEED  = 80;

  let subText       = '';
  let subTextSize   = 9;
  let subValueSize  = 9;
  let subTextColor  = '#ffdc50';
  let subValueColor = '#ffdc50';
  let acaoNameFont    = '';
  let acaoSubTextFont = '';
  let acaoValueFont   = '';
  let animId        = null;

  const evtSource = new EventSource('${sseUrl}');
  evtSource.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'full') applyFull(msg.data);
  };

  let cards      = [];
  let renderedIds = new Set();
  let lastTs     = null;
  let vw         = 800;

  window.addEventListener('load', () => { vw = stage.offsetWidth || window.innerWidth || 800; });
  setTimeout(() => { vw = stage.offsetWidth || window.innerWidth || 800; }, 200);

  function buildSubEl(member) {
    const val = member && member.value ? member.value : 0;
    if (!subText && !val) return null;
    const sub = document.createElement('div');
    sub.className = 'msub';
    if (subText) {
      const st = document.createElement('span');
      st.style.fontSize = subTextSize + 'px';
      st.style.color = subTextColor;
      if (acaoSubTextFont) st.style.fontFamily = acaoSubTextFont + ',sans-serif';
      st.textContent = subText;
      sub.appendChild(st);
    }
    if (subText && val) sub.appendChild(document.createTextNode(' '));
    if (val) {
      const sv = document.createElement('span');
      sv.style.fontSize = subValueSize + 'px';
      sv.style.color = subValueColor;
      if (acaoValueFont) sv.style.fontFamily = acaoValueFont + ',sans-serif';
      sv.textContent = val;
      sub.appendChild(sv);
    }
    return sub;
  }

  function applyFull(data) {
    if (data.title)     titleEl.textContent = data.title;
    if (data.giftImage) { giftIcon.src = data.giftImage; giftIcon.style.display = ''; }
    else giftIcon.style.display = 'none';
    subText       = data.subText       || '';
    subTextSize   = data.subTextSize   || 9;
    subValueSize  = data.subValueSize  || 9;
    subTextColor  = data.subTextColor  || '#ffdc50';
    subValueColor = data.subValueColor || '#ffdc50';
    acaoNameFont    = data.nameFont    || '';
    acaoSubTextFont = data.subTextFont || '';
    acaoValueFont   = data.valueFont   || '';

    const incoming = data.members || [];

    // If list was reset (empty), clear everything
    if (incoming.length === 0) {
      if (animId) { cancelAnimationFrame(animId); animId = null; }
      cards.forEach(c => c.el.remove());
      cards = [];
      renderedIds.clear();
      emptyEl.style.display = '';
      return;
    }

    emptyEl.style.display = 'none';
    vw = stage.offsetWidth || window.innerWidth || 800;

    // Update sub text/value AND fonts on ALL existing cards
    cards.forEach(card => {
      const member = incoming.find(m => m.userId === card.userId);
      // Update name font
      const nm = card.el.querySelector('.mn');
      if (nm) nm.style.fontFamily = acaoNameFont ? acaoNameFont + ',sans-serif' : '';
      // Rebuild sub element (picks up new fonts/colors/text)
      let old = card.el.querySelector('.msub');
      if (old) old.remove();
      const fresh = buildSubEl(member);
      if (fresh) card.el.appendChild(fresh);
    });

    // Add only members not yet on stage
    const newMembers = incoming.filter(m => !renderedIds.has(m.userId));
    newMembers.forEach(m => {
      renderedIds.add(m.userId);

      const el = document.createElement('div');
      el.className = 'mc';

      const av = document.createElement('div');
      av.className = 'ma';
      if (m.profilePictureUrl) {
        const img = document.createElement('img');
        img.src = m.profilePictureUrl;
        img.onerror = () => { av.innerHTML = ''; av.textContent = String.fromCodePoint(128100); };
        av.appendChild(img);
      } else { av.textContent = String.fromCodePoint(128100); }

      const nm = document.createElement('div');
      nm.className = 'mn';
      nm.textContent = m.nickname || m.userId;
      if (acaoNameFont) nm.style.fontFamily = acaoNameFont + ',sans-serif';

      el.appendChild(av);
      el.appendChild(nm);

      const sub = buildSubEl(m);
      if (sub) el.appendChild(sub);

      stage.appendChild(el);

      // Place at end of queue, always past the right edge
      const maxX = cards.length > 0
        ? Math.max(...cards.map(c => c.x), vw - STEP) + STEP
        : vw;
      el.style.transform = 'translateX(' + maxX + 'px)';
      cards.push({ el, x: maxX, userId: m.userId });
    });

    // Start animation if not already running
    if (!animId && cards.length > 0) {
      lastTs = null;
      animId = requestAnimationFrame(tick);
    }
  }

  function tick(ts) {
    if (lastTs === null) lastTs = ts;
    const dt = Math.min((ts - lastTs) / 1000, 0.05);
    lastTs = ts;

    cards.forEach(card => {
      card.x -= SPEED * dt;

      // When card fully exits left, place it after the rightmost card
      if (card.x + CARD_W < 0) {
        const maxX = Math.max(...cards.map(c => c.x), vw - STEP);
        card.x = maxX + STEP;
      }

      card.el.style.transform = 'translateX(' + card.x + 'px)';
    });

    animId = requestAnimationFrame(tick);
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
</script>
</body>
</html>`;
}

// ============================================
// ============================================
// TOP GIFT & TOP COMBO OVERLAYS
// ============================================
function getTopGiftHTML(roomId) {
  const sseUrl = `/sse/${roomId}/top-gift`;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@700;900&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:transparent; overflow:hidden; display:flex; justify-content:center; align-items:center; min-height:100vh; }

  @keyframes floatGift {
    0%,100% { transform: translateY(0px) rotate(-3deg); }
    50%      { transform: translateY(-12px) rotate(3deg); }
  }
  @keyframes glowPulse {
    0%,100% { filter: drop-shadow(0 0 8px rgba(255,215,0,0.6)); }
    50%      { filter: drop-shadow(0 0 20px rgba(255,215,0,1)); }
  }
  @keyframes slideIn {
    from { opacity:0; transform:translateY(30px) scale(0.85); }
    to   { opacity:1; transform:translateY(0)    scale(1); }
  }
  @keyframes namePulse {
    0%,100% { text-shadow: 0 2px 8px rgba(0,0,0,0.8); }
    50%      { text-shadow: 0 2px 16px rgba(0,0,0,0.9), 0 0 30px currentColor; }
  }
  @keyframes sparkle {
    0%   { opacity:0; transform:scale(0) rotate(0deg); }
    50%  { opacity:1; transform:scale(1.2) rotate(180deg); }
    100% { opacity:0; transform:scale(0) rotate(360deg); }
  }

  #card {
    display:none;
    flex-direction:column;
    align-items:center;
    gap:6px;
    animation: slideIn 0.5s cubic-bezier(.22,1,.36,1);
  }
  #card.visible { display:flex; }

  .gift-wrap {
    position:relative;
    width:120px; height:120px;
    display:flex; align-items:center; justify-content:center;
  }
  #gift-img {
    width:110px; height:110px;
    object-fit:contain;
    animation: floatGift 2.8s ease-in-out infinite, glowPulse 2.8s ease-in-out infinite;
    filter: drop-shadow(0 0 8px rgba(255,215,0,0.6));
  }
  .sparkle {
    position:absolute;
    font-size:14px;
    animation: sparkle 2s ease-in-out infinite;
    pointer-events:none;
  }
  .sp1 { top:5px;  left:5px;  animation-delay:0s;    }
  .sp2 { top:5px;  right:5px; animation-delay:0.7s;  }
  .sp3 { bottom:5px; left:10px; animation-delay:1.4s; }
  .sp4 { bottom:5px; right:10px; animation-delay:0.35s; }

  #name {
    font-family:'Poppins',sans-serif;
    font-size:22px;
    font-weight:900;
    color: #FFD700;
    text-shadow: 0 2px 8px rgba(0,0,0,0.8), 0 0 20px rgba(255,215,0,0.4);
    text-align:center;
    max-width:260px;
    white-space:nowrap;
    overflow:hidden;
    text-overflow:ellipsis;
    letter-spacing:0.5px;
    animation: namePulse 3s ease-in-out infinite;
  }
  #value {
    font-family:'Poppins',sans-serif;
    font-size:16px;
    font-weight:700;
    color:#fff;
    text-shadow:0 2px 6px rgba(0,0,0,0.8);
    display:flex;
    align-items:center;
    gap:5px;
  }
  .coin-icon { font-size:18px; }
  #label {
    font-family:'Poppins',sans-serif;
    font-size:11px;
    font-weight:700;
    color:rgba(255,255,255,0.6);
    text-transform:uppercase;
    letter-spacing:2px;
  }
</style>
</head>
<body>
<div id="card">
  <div id="label">🏆 MAIOR PRESENTE</div>
  <div class="gift-wrap">
    <img id="gift-img" src="" alt="">
    <span class="sparkle sp1">✦</span>
    <span class="sparkle sp2">✦</span>
    <span class="sparkle sp3">✦</span>
    <span class="sparkle sp4">✦</span>
  </div>
  <div id="name">User Name</div>
  <div id="value"><span class="coin-icon">🪙</span><span id="val-num">0</span></div>
</div>
<script>
  const card = document.getElementById('card');
  const giftImg = document.getElementById('gift-img');
  const labelEl = document.getElementById('label');
  const nameEl = document.getElementById('name');
  const valNum = document.getElementById('val-num');
  const sse = new EventSource('${sseUrl}');

  sse.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'full') {
      if (msg.config) {
        const cfg = msg.config;
        labelEl.textContent = cfg.label || 'Maior Presente';
        labelEl.style.color = cfg.labelColor || '#ffffff';
        nameEl.style.color = cfg.nameColor || '#FFD700';
        nameEl.style.textShadow = '0 2px 8px rgba(0,0,0,0.8), 0 0 20px ' + (cfg.nameColor || '#FFD700') + '44';
        valNum.parentElement.style.color = cfg.valueColor || '#ffffff';
      }
      if (!msg.data) { card.classList.remove('visible'); return; }
      const d = msg.data;
      giftImg.src = d.giftPictureUrl || '';
      nameEl.textContent = d.nickname || '';
      valNum.textContent = (d.diamonds || 0).toLocaleString('pt-BR');
      card.classList.remove('visible');
      void card.offsetWidth;
      card.classList.add('visible');
    }
  };
</script>
</body>
</html>`;
}

function getTopComboHTML(roomId) {
  const sseUrl = `/sse/${roomId}/top-combo`;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@700;900&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:transparent; overflow:hidden; display:flex; justify-content:center; align-items:center; min-height:100vh; }

  @keyframes floatGift {
    0%,100% { transform: translateY(0px) rotate(-3deg); }
    50%      { transform: translateY(-12px) rotate(3deg); }
  }
  @keyframes glowPulse {
    0%,100% { filter: drop-shadow(0 0 8px rgba(255,100,100,0.6)); }
    50%      { filter: drop-shadow(0 0 22px rgba(255,100,100,1)); }
  }
  @keyframes slideIn {
    from { opacity:0; transform:translateY(30px) scale(0.85); }
    to   { opacity:1; transform:translateY(0)    scale(1); }
  }
  @keyframes comboScale {
    0%   { transform: scale(1); }
    50%  { transform: scale(1.15); }
    100% { transform: scale(1); }
  }
  @keyframes sparkle {
    0%   { opacity:0; transform:scale(0) rotate(0deg); }
    50%  { opacity:1; transform:scale(1.2) rotate(180deg); }
    100% { opacity:0; transform:scale(0) rotate(360deg); }
  }
  @keyframes namePulse {
    0%,100% { text-shadow: 0 2px 8px rgba(0,0,0,0.8); }
    50%      { text-shadow: 0 2px 16px rgba(0,0,0,0.9), 0 0 30px currentColor; }
  }

  #card {
    display:none;
    flex-direction:column;
    align-items:center;
    gap:6px;
    animation: slideIn 0.5s cubic-bezier(.22,1,.36,1);
  }
  #card.visible { display:flex; }

  .gift-wrap {
    position:relative;
    width:120px; height:120px;
    display:flex; align-items:center; justify-content:center;
  }
  #gift-img {
    width:110px; height:110px;
    object-fit:contain;
    animation: floatGift 2.8s ease-in-out infinite, glowPulse 2.8s ease-in-out infinite;
    filter: drop-shadow(0 0 8px rgba(255,100,100,0.6));
  }
  .sparkle {
    position:absolute;
    font-size:14px;
    animation: sparkle 2s ease-in-out infinite;
    pointer-events:none;
    color:#ff6464;
  }
  .sp1 { top:5px;  left:5px;  animation-delay:0s;    }
  .sp2 { top:5px;  right:5px; animation-delay:0.7s;  }
  .sp3 { bottom:5px; left:10px; animation-delay:1.4s; }
  .sp4 { bottom:5px; right:10px; animation-delay:0.35s; }

  #name {
    font-family:'Poppins',sans-serif;
    font-size:22px;
    font-weight:900;
    color: #FFD700;
    text-shadow: 0 2px 8px rgba(0,0,0,0.8), 0 0 20px rgba(255,215,0,0.4);
    text-align:center;
    max-width:260px;
    white-space:nowrap;
    overflow:hidden;
    text-overflow:ellipsis;
    letter-spacing:0.5px;
    animation: namePulse 3s ease-in-out infinite;
  }
  #combo {
    font-family:'Poppins',sans-serif;
    font-size:20px;
    font-weight:900;
    color:#ff6464;
    text-shadow:0 2px 8px rgba(0,0,0,0.8), 0 0 16px rgba(255,100,100,0.5);
    animation: comboScale 1s ease-in-out infinite;
  }
  #label {
    font-family:'Poppins',sans-serif;
    font-size:11px;
    font-weight:700;
    color:rgba(255,255,255,0.6);
    text-transform:uppercase;
    letter-spacing:2px;
  }
</style>
</head>
<body>
<div id="card">
  <div id="label">🔥 MAIOR COMBO</div>
  <div class="gift-wrap">
    <img id="gift-img" src="" alt="">
    <span class="sparkle sp1">✦</span>
    <span class="sparkle sp2">✦</span>
    <span class="sparkle sp3">✦</span>
    <span class="sparkle sp4">✦</span>
  </div>
  <div id="name">User Name</div>
  <div id="combo">x0</div>
</div>
<script>
  const card = document.getElementById('card');
  const giftImg = document.getElementById('gift-img');
  const labelEl = document.getElementById('label');
  const nameEl = document.getElementById('name');
  const comboEl = document.getElementById('combo');
  const sse = new EventSource('${sseUrl}');

  sse.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'full') {
      if (msg.config) {
        const cfg = msg.config;
        labelEl.textContent = cfg.label || 'Maior Combo';
        labelEl.style.color = cfg.labelColor || '#ffffff';
        nameEl.style.color = cfg.nameColor || '#FFD700';
        nameEl.style.textShadow = '0 2px 8px rgba(0,0,0,0.8), 0 0 20px ' + (cfg.nameColor || '#FFD700') + '44';
        comboEl.style.color = cfg.comboColor || '#ff6464';
        comboEl.style.textShadow = '0 2px 8px rgba(0,0,0,0.8), 0 0 16px ' + (cfg.comboColor || '#ff6464') + '88';
      }
      if (!msg.data) { card.classList.remove('visible'); return; }
      const d = msg.data;
      giftImg.src = d.giftPictureUrl || '';
      nameEl.textContent = d.nickname || '';
      comboEl.textContent = 'x' + (d.comboCount || 0).toLocaleString('pt-BR');
      card.classList.remove('visible');
      void card.offsetWidth;
      card.classList.add('visible');
    }
  };
</script>
</body>
</html>`;
}

function getAlertHTML(roomId) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: transparent; overflow: hidden; width: 100vw; height: 100vh; display: flex; align-items: flex-end; justify-content: flex-start; padding: 24px; }
  #alert-box {
    display: none;
    align-items: center;
    gap: 16px;
    background: linear-gradient(135deg, rgba(15,15,30,0.92) 0%, rgba(30,15,60,0.92) 100%);
    border: 2px solid rgba(180,100,255,0.6);
    border-radius: 18px;
    padding: 16px 22px;
    box-shadow: 0 0 30px rgba(160,60,255,0.4), inset 0 0 20px rgba(160,60,255,0.1);
    min-width: 300px;
    max-width: 500px;
    animation-duration: 0.5s;
    animation-fill-mode: both;
  }
  #alert-box.show { display: flex; animation-name: slideIn; }
  #alert-box.hide { display: flex; animation-name: slideOut; }
  @keyframes slideIn {
    from { opacity: 0; transform: translateX(-60px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  @keyframes slideOut {
    from { opacity: 1; transform: translateX(0); }
    to   { opacity: 0; transform: translateX(-60px); }
  }
  #alert-avatar {
    width: 64px; height: 64px; border-radius: 50%;
    border: 3px solid rgba(200,120,255,0.8);
    object-fit: cover; flex-shrink: 0;
    background: rgba(80,50,120,0.5);
  }
  #alert-info { flex: 1; min-width: 0; }
  #alert-nickname {
    font-family: 'Segoe UI', sans-serif;
    font-size: 18px; font-weight: 700;
    color: #fff;
    text-shadow: 0 0 12px rgba(200,150,255,0.9);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #alert-message {
    font-family: 'Segoe UI', sans-serif;
    font-size: 14px; font-weight: 400;
    color: #d8b4ff;
    margin-top: 3px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #alert-gift-img {
    width: 54px; height: 54px; object-fit: contain; flex-shrink: 0;
    display: none;
  }
</style>
</head>
<body>
<div id="alert-box">
  <img id="alert-avatar" src="" alt="">
  <div id="alert-info">
    <div id="alert-nickname"></div>
    <div id="alert-message"></div>
  </div>
  <img id="alert-gift-img" src="" alt="">
</div>
<script>
  const box = document.getElementById('alert-box');
  const avatar = document.getElementById('alert-avatar');
  const nickname = document.getElementById('alert-nickname');
  const message = document.getElementById('alert-message');
  const giftImg = document.getElementById('alert-gift-img');
  let hideTimer = null;

  function showAlert(data) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    box.className = '';
    void box.offsetWidth;
    avatar.src = data.profilePic || '';
    nickname.textContent = data.nickname || '';
    message.textContent = data.message || '';
    if (data.giftImage) {
      giftImg.src = data.giftImage;
      giftImg.style.display = 'block';
    } else {
      giftImg.style.display = 'none';
    }
    box.classList.add('show');
    hideTimer = setTimeout(() => {
      box.classList.remove('show');
      box.classList.add('hide');
      setTimeout(() => { box.className = ''; }, 550);
    }, 4000);
  }

  const evtSource = new EventSource('/sse/${roomId}/alert');
  evtSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'alert') showAlert(data);
    } catch(err) {}
  };
</script>
</body>
</html>`;
}

function getAlertSceneHTML(roomId, scene) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Cinzel:wght@700;900&family=Press+Start+2P&family=Russo+One&family=Rajdhani:wght@700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: transparent; overflow: hidden; width: 100vw; height: 100vh; display: flex; align-items: flex-end; justify-content: flex-start; padding: 28px; }
  #alert-box {
    display: none; align-items: center; gap: 16px; border-radius: 18px;
    padding: 16px 22px; min-width: 300px; max-width: 520px;
    animation-duration: 0.5s; animation-fill-mode: both;
  }
  #alert-box.show { display: flex !important; animation-name: slideIn; }
  #alert-box.hide { display: flex !important; animation-name: slideOut; }
  @keyframes slideIn { from { opacity: 0; transform: translateX(-90px); } to { opacity: 1; transform: translateX(0); } }
  @keyframes slideOut { from { opacity: 1; transform: translateX(0); } to { opacity: 0; transform: translateX(-90px); } }
  #alert-avatar { width: 68px; height: 68px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
  #alert-info { flex: 1; min-width: 0; }
  #alert-nickname { font-size: 19px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #alert-message { font-size: 14px; font-weight: 400; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #alert-gift-wrap { display: none; flex-direction: column; align-items: center; flex-shrink: 0; gap: 2px; }
  #alert-gift-img { width: 58px; height: 58px; object-fit: contain; }
  #alert-gift-count { font-family: 'Segoe UI', sans-serif; font-size: 15px; font-weight: 800; color: #fff; text-shadow: 0 1px 6px rgba(0,0,0,0.8); }
  .t-roxo { background: linear-gradient(135deg, rgba(15,15,30,0.93) 0%, rgba(35,10,65,0.93) 100%); border: 2px solid rgba(190,100,255,0.65); box-shadow: 0 0 32px rgba(160,60,255,0.45), inset 0 0 20px rgba(160,60,255,0.1); }
  .t-roxo #alert-avatar { border: 3px solid rgba(210,130,255,0.9); background: rgba(80,50,120,0.5); }
  .t-roxo #alert-nickname { font-family: 'Segoe UI', sans-serif; color: #fff; text-shadow: 0 0 14px rgba(200,130,255,0.9); }
  .t-roxo #alert-message  { font-family: 'Segoe UI', sans-serif; color: #d8b4ff; }
  .t-neon { background: linear-gradient(135deg, rgba(0,10,35,0.93) 0%, rgba(0,25,55,0.93) 100%); border: 2px solid #00d4ff; box-shadow: 0 0 28px rgba(0,212,255,0.45), inset 0 0 20px rgba(0,212,255,0.08); }
  .t-neon #alert-avatar { border: 3px solid #00d4ff; background: rgba(0,50,80,0.5); }
  .t-neon #alert-nickname { font-family: 'Orbitron', sans-serif; font-size: 16px; color: #00d4ff; text-shadow: 0 0 14px rgba(0,212,255,0.9); }
  .t-neon #alert-message  { font-family: 'Orbitron', sans-serif; font-size: 11px; color: #ff3366; text-shadow: 0 0 8px rgba(255,51,102,0.7); }
  .t-medieval { background: linear-gradient(135deg, rgba(20,14,4,0.96) 0%, rgba(45,32,8,0.96) 100%); border: 3px solid #8b7355; box-shadow: 0 4px 22px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,215,0,0.18); border-radius: 12px; }
  .t-medieval #alert-avatar { border: 3px solid #8b7355; background: rgba(50,35,10,0.6); }
  .t-medieval #alert-nickname { font-family: 'Cinzel', serif; color: #ffd700; text-shadow: 0 2px 6px rgba(0,0,0,0.8); }
  .t-medieval #alert-message  { font-family: 'Cinzel', serif; font-size: 13px; color: #e8d4a0; }
  .t-retro { background: #0a0a0a; border: 3px solid #00ff41; box-shadow: 0 0 12px rgba(0,255,65,0.5), inset 0 0 14px rgba(0,255,65,0.06); border-radius: 4px; }
  .t-retro #alert-avatar { border: 3px solid #00ff41; background: #111; border-radius: 4px; }
  .t-retro #alert-nickname { font-family: 'Press Start 2P', monospace; font-size: 11px; color: #00ff41; }
  .t-retro #alert-message  { font-family: 'Press Start 2P', monospace; font-size: 9px; color: #ff00ff; margin-top: 7px; }
  .t-fire { background: linear-gradient(160deg, rgba(50,12,0,0.95) 0%, rgba(85,28,0,0.95) 100%); border: 2px solid #ff6600; box-shadow: 0 0 32px rgba(255,100,0,0.45), inset 0 -8px 28px rgba(255,50,0,0.18); }
  .t-fire #alert-avatar { border: 3px solid #ff6600; background: rgba(80,20,0,0.5); }
  .t-fire #alert-nickname { font-family: 'Russo One', sans-serif; color: #ffd700; text-shadow: 0 0 12px rgba(255,120,0,0.85); }
  .t-fire #alert-message  { font-family: 'Russo One', sans-serif; font-size: 13px; color: #ffaa44; }
  .t-ice { background: linear-gradient(160deg, rgba(5,18,38,0.93) 0%, rgba(10,38,78,0.93) 100%); border: 2px solid rgba(150,220,255,0.65); box-shadow: 0 0 26px rgba(100,200,255,0.35), inset 0 0 20px rgba(200,240,255,0.07); }
  .t-ice #alert-avatar { border: 3px solid rgba(150,220,255,0.8); background: rgba(10,50,90,0.5); }
  .t-ice #alert-nickname { font-family: 'Rajdhani', sans-serif; font-size: 21px; color: #b0e0ff; text-shadow: 0 0 14px rgba(150,220,255,0.75); }
  .t-ice #alert-message  { font-family: 'Rajdhani', sans-serif; font-size: 15px; color: #e0f4ff; }
  .t-rosa { background: linear-gradient(160deg, rgba(60,15,40,0.92) 0%, rgba(95,20,55,0.92) 100%); border: 2px solid rgba(255,105,180,0.55); box-shadow: 0 0 28px rgba(255,105,180,0.4), inset 0 0 20px rgba(255,182,213,0.08); }
  .t-rosa #alert-avatar { border: 3px solid rgba(255,105,180,0.85); background: rgba(80,20,55,0.5); box-shadow: 0 0 14px rgba(255,105,180,0.4); }
  .t-rosa #alert-nickname { font-family: 'Poppins', sans-serif; font-weight: 700; font-size: 20px; color: #ff69b4; text-shadow: 0 0 14px rgba(255,105,180,0.75); }
  .t-rosa #alert-message  { font-family: 'Poppins', sans-serif; font-size: 14px; color: #ffd1e7; }
  .t-clean { background: transparent; border: none; box-shadow: none; padding: 8px 4px; }
  .t-clean #alert-avatar { border: 3px solid rgba(255,255,255,0.85); box-shadow: 0 2px 12px rgba(0,0,0,0.7); }
  .t-clean #alert-nickname { font-family: 'Segoe UI', sans-serif; font-size: 20px; color: #fff; text-shadow: 0 2px 8px rgba(0,0,0,0.95), 0 0 20px rgba(0,0,0,0.8); }
  .t-clean #alert-message  { font-family: 'Segoe UI', sans-serif; color: rgba(255,255,255,0.92); text-shadow: 0 2px 6px rgba(0,0,0,0.95); }
</style>
</head>
<body>
<div id="alert-box" class="t-roxo">
  <img id="alert-avatar" src="" alt="">
  <div id="alert-info">
    <div id="alert-nickname"></div>
    <div id="alert-message"></div>
  </div>
  <div id="alert-gift-wrap">
    <img id="alert-gift-img" src="" alt="">
    <span id="alert-gift-count"></span>
  </div>
</div>
<script>
  var box = document.getElementById('alert-box');
  var avatarEl = document.getElementById('alert-avatar');
  var nicknameEl = document.getElementById('alert-nickname');
  var messageEl = document.getElementById('alert-message');
  var giftWrapEl = document.getElementById('alert-gift-wrap');
  var giftImgEl = document.getElementById('alert-gift-img');
  var giftCountEl = document.getElementById('alert-gift-count');
  var currentTheme = 'roxo';
  var hideTimer = null;
  var THEMES = ['roxo','neon','medieval','retro','fire','ice','rosa','clean'];
  function applyTheme(t) {
    if (THEMES.indexOf(t) === -1) t = 'roxo';
    currentTheme = t;
    THEMES.forEach(function(th) { box.classList.remove('t-' + th); });
    box.classList.add('t-' + t);
  }
  function showAlert(data) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    box.className = 't-' + currentTheme;
    void box.offsetWidth;
    avatarEl.src = data.profilePic || '';
    nicknameEl.textContent = data.nickname || '';
    messageEl.textContent = data.message || '';
    if (data.giftImage) {
      giftImgEl.src = data.giftImage;
      giftCountEl.textContent = (data.giftCount && data.giftCount > 1) ? 'x' + data.giftCount : '';
      giftWrapEl.style.display = 'flex';
    } else {
      giftWrapEl.style.display = 'none';
    }
    box.classList.add('show');
    hideTimer = setTimeout(function() {
      box.classList.remove('show');
      box.classList.add('hide');
      setTimeout(function() { box.className = 't-' + currentTheme; }, 550);
    }, 8000);
  }
  function connect() {
    var es = new EventSource('/sse/${roomId}/alert/scene${scene}');
    es.onmessage = function(e) {
      try {
        var d = JSON.parse(e.data);
        if (d.type === 'alert') showAlert(d);
        if (d.type === 'config') applyTheme(d.theme);
      } catch(err) {}
    };
    es.onerror = function() { es.close(); setTimeout(connect, 3000); };
  }
  connect();
</script>
</body>
</html>`;
}

function getDesejoOverlayHTML(roomId) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Cinzel:wght@700;900&family=Press+Start+2P&family=Russo+One&family=Rajdhani:wght@700&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:transparent; overflow:hidden; width:100vw; height:100vh; display:flex; align-items:center; justify-content:center; }
  #dw { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:20px 28px; gap:10px; border-radius:20px; min-width:190px; animation-duration:0.4s; animation-fill-mode:both; }
  #dw-title { font-size:15px; font-weight:700; text-align:center; letter-spacing:1px; }
  #dw-img-wrap { position:relative; width:110px; height:110px; display:flex; align-items:center; justify-content:center; }
  #dw-img { width:88px; height:88px; object-fit:contain; animation: floatGift 3s ease-in-out infinite; }
  @keyframes floatGift { 0%,100% { transform: translateY(0px) rotate(-3deg); } 50% { transform: translateY(-10px) rotate(3deg); } }
  .dw-sparkle { position:absolute; font-size:13px; pointer-events:none; animation: sparkleAnim 2.2s ease-in-out infinite; }
  .dw-sp1 { top:4px; left:4px; animation-delay:0s; } .dw-sp2 { top:4px; right:4px; animation-delay:0.75s; }
  .dw-sp3 { bottom:4px; left:8px; animation-delay:1.5s; } .dw-sp4 { bottom:4px; right:8px; animation-delay:0.4s; }
  @keyframes sparkleAnim { 0% { opacity:0; transform:scale(0) rotate(0deg); } 50% { opacity:1; transform:scale(1.2) rotate(180deg); } 100% { opacity:0; transform:scale(0) rotate(360deg); } }
  #dw-counter { font-size:38px; font-weight:900; letter-spacing:2px; text-align:center; transition: transform 0.1s; }
  #dw-counter.bump { animation: counterBump 0.5s ease-out; }
  @keyframes counterBump { 0% { transform: scale(1); } 30% { transform: scale(1.35); } 60% { transform: scale(0.95); } 100% { transform: scale(1); } }
  #dw-complete { font-size:14px; font-weight:800; letter-spacing:2px; text-transform:uppercase; opacity:0; transition:opacity 0.4s; }
  #dw-complete.show { opacity:1; animation: completePulse 1.2s ease-in-out infinite; }
  @keyframes completePulse { 0%,100% { opacity:0.7; } 50% { opacity:1; } }
  .t-neon { background:linear-gradient(160deg,rgba(0,10,35,0.93),rgba(0,28,60,0.93)); border:2px solid #00d4ff; box-shadow:0 0 30px rgba(0,212,255,0.45),inset 0 0 20px rgba(0,212,255,0.08); }
  .t-neon #dw-title { font-family:'Orbitron',sans-serif; font-size:13px; } .t-neon #dw-counter { font-family:'Orbitron',sans-serif; } .t-neon #dw-complete { font-family:'Orbitron',sans-serif; color:#00d4ff; } .t-neon #dw-img { filter: drop-shadow(0 0 10px rgba(0,212,255,0.5)); }
  .t-roxo { background:linear-gradient(160deg,rgba(15,10,35,0.93),rgba(35,10,65,0.93)); border:2px solid rgba(190,100,255,0.65); box-shadow:0 0 30px rgba(160,60,255,0.4),inset 0 0 20px rgba(160,60,255,0.08); }
  .t-roxo #dw-title { font-family:'Segoe UI',sans-serif; } .t-roxo #dw-counter { font-family:'Segoe UI',sans-serif; } .t-roxo #dw-complete { font-family:'Segoe UI',sans-serif; color:#d8b4ff; } .t-roxo #dw-img { filter: drop-shadow(0 0 10px rgba(180,80,255,0.5)); }
  .t-medieval { background:linear-gradient(160deg,rgba(20,14,4,0.96),rgba(45,32,8,0.96)); border:3px solid #8b7355; box-shadow:0 4px 22px rgba(0,0,0,0.65),inset 0 1px 0 rgba(255,215,0,0.15); border-radius:12px; }
  .t-medieval #dw-title { font-family:'Cinzel',serif; } .t-medieval #dw-counter { font-family:'Cinzel',serif; } .t-medieval #dw-complete { font-family:'Cinzel',serif; color:#ffd700; } .t-medieval #dw-img { filter: drop-shadow(0 0 8px rgba(255,200,0,0.4)); }
  .t-retro { background:#0a0a0a; border:3px solid #00ff41; box-shadow:0 0 12px rgba(0,255,65,0.5),inset 0 0 14px rgba(0,255,65,0.05); border-radius:4px; }
  .t-retro #dw-title { font-family:'Press Start 2P',monospace; font-size:9px; color:#00ff41 !important; } .t-retro #dw-counter { font-family:'Press Start 2P',monospace; font-size:28px; } .t-retro #dw-complete { font-family:'Press Start 2P',monospace; font-size:9px; color:#ff00ff !important; } .t-retro #dw-img { image-rendering:pixelated; filter: drop-shadow(0 0 6px rgba(0,255,65,0.4)); }
  .t-fire { background:linear-gradient(160deg,rgba(50,12,0,0.95),rgba(85,28,0,0.95)); border:2px solid #ff6600; box-shadow:0 0 32px rgba(255,100,0,0.45),inset 0 -8px 28px rgba(255,50,0,0.15); }
  .t-fire #dw-title { font-family:'Russo One',sans-serif; } .t-fire #dw-counter { font-family:'Russo One',sans-serif; } .t-fire #dw-complete { font-family:'Russo One',sans-serif; color:#ffd700; } .t-fire #dw-img { filter: drop-shadow(0 0 12px rgba(255,120,0,0.6)); }
  .t-ice { background:linear-gradient(160deg,rgba(5,18,38,0.93),rgba(10,38,78,0.93)); border:2px solid rgba(150,220,255,0.65); box-shadow:0 0 26px rgba(100,200,255,0.35),inset 0 0 20px rgba(200,240,255,0.06); }
  .t-ice #dw-title { font-family:'Rajdhani',sans-serif; font-size:17px; } .t-ice #dw-counter { font-family:'Rajdhani',sans-serif; font-size:44px; } .t-ice #dw-complete { font-family:'Rajdhani',sans-serif; color:#b0e0ff; } .t-ice #dw-img { filter: drop-shadow(0 0 10px rgba(150,220,255,0.5)); }
  .t-rosa { background:linear-gradient(160deg,rgba(60,15,40,0.92),rgba(95,20,55,0.92)); border:2px solid rgba(255,105,180,0.55); box-shadow:0 0 28px rgba(255,105,180,0.4),inset 0 0 20px rgba(255,182,213,0.08); }
  .t-rosa #dw-title { font-family:'Poppins',sans-serif; font-weight:700; color:#ff69b4; } .t-rosa #dw-counter { font-family:'Poppins',sans-serif; font-weight:900; color:#ec4899; text-shadow:0 0 12px rgba(236,72,153,0.6); } .t-rosa #dw-complete { font-family:'Poppins',sans-serif; color:#ff69b4; } .t-rosa #dw-img { filter: drop-shadow(0 0 12px rgba(255,105,180,0.55)); }
  .t-clean { background:transparent; border:none; box-shadow:none; }
  .t-clean #dw-title { font-family:'Segoe UI',sans-serif; text-shadow:0 2px 8px rgba(0,0,0,0.95); } .t-clean #dw-counter { font-family:'Segoe UI',sans-serif; text-shadow:0 2px 10px rgba(0,0,0,0.95); } .t-clean #dw-complete { font-family:'Segoe UI',sans-serif; } .t-clean #dw-img { filter: drop-shadow(0 4px 12px rgba(0,0,0,0.8)); }
  .t-custom { border:2px solid rgba(255,255,255,0.3); }
  .t-custom #dw-title { font-family:'Segoe UI',sans-serif; } .t-custom #dw-counter { font-family:'Segoe UI',sans-serif; } .t-custom #dw-complete { font-family:'Segoe UI',sans-serif; }
</style>
</head>
<body>
<div id="dw" class="t-neon">
  <div id="dw-title" style="color:#fff;">Desejo do Streamer</div>
  <div id="dw-img-wrap">
    <img id="dw-img" src="" alt="">
    <span class="dw-sparkle dw-sp1">✨</span><span class="dw-sparkle dw-sp2">⭐</span>
    <span class="dw-sparkle dw-sp3">✨</span><span class="dw-sparkle dw-sp4">⭐</span>
  </div>
  <div id="dw-counter" style="color:#ffd700;">0 / 1</div>
  <div id="dw-complete">✨ COMPLETO! ✨</div>
</div>
<script>
  var dw = document.getElementById('dw');
  var titleEl = document.getElementById('dw-title');
  var imgEl = document.getElementById('dw-img');
  var counterEl = document.getElementById('dw-counter');
  var completeEl = document.getElementById('dw-complete');
  var THEMES = ['neon','roxo','medieval','retro','fire','ice','rosa','clean','custom'];
  var state = { name:'Desejo do Streamer', giftImage:'', target:1, current:0, theme:'neon', customColor:'', nameColor:'#ffffff', countColor:'#ffd700' };
  function applyState(s) {
    state = s;
    THEMES.forEach(function(t){ dw.classList.remove('t-'+t); });
    dw.classList.add('t-' + (s.theme||'neon'));
    if (s.theme === 'custom' && s.customColor) dw.style.background = s.customColor;
    else dw.style.background = '';
    titleEl.textContent = s.name || 'Desejo do Streamer';
    titleEl.style.color = s.nameColor || '#ffffff';
    counterEl.style.color = s.countColor || '#ffd700';
    imgEl.src = s.giftImage || '';
    updateCounter(s.current, s.target, false);
  }
  function updateCounter(current, target, animate) {
    state.current = current; state.target = target;
    counterEl.textContent = current + ' / ' + target;
    if (animate) { counterEl.classList.remove('bump'); void counterEl.offsetWidth; counterEl.classList.add('bump'); }
    if (current >= target && target > 0) completeEl.classList.add('show');
    else completeEl.classList.remove('show');
  }
  function connect() {
    var es = new EventSource('/sse/${roomId}/desejo');
    es.onmessage = function(e) {
      try {
        var d = JSON.parse(e.data);
        if (d.type === 'config') applyState(d.state);
        if (d.type === 'increment') updateCounter(d.current, d.target, true);
        if (d.type === 'reset') updateCounter(0, d.target, false);
      } catch(err) {}
    };
    es.onerror = function() { es.close(); setTimeout(connect, 3000); };
  }
  connect();
</script>
</body>
</html>`;
}

function getGaleriaOverlayHTML(roomId) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Cinzel:wght@700;900&family=Press+Start+2P&family=Russo+One&family=Rajdhani:wght@700&family=Poppins:wght@700;900&display=swap" rel="stylesheet">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:transparent; overflow:hidden; width:100vw; height:100vh; }
/* ─── PADRÃO ─── */
#gw-padrao-wrap { width:100%; height:100%; display:flex; align-items:center; justify-content:center; }
#gw { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:22px 30px; gap:8px; border-radius:20px; min-width:210px; }
#gw-title { font-size:12px; font-weight:700; text-align:center; letter-spacing:1.5px; color:#fff; text-transform:uppercase; }
#gw-content { display:flex; flex-direction:column; align-items:center; gap:6px; transition:opacity 0.35s ease-in-out; }
#gw-content.fading { opacity:0; }
#gw-img-wrap { position:relative; width:110px; height:110px; display:flex; align-items:center; justify-content:center; }
#gw-img { width:88px; height:88px; object-fit:contain; animation:galeriaFloat 3s ease-in-out infinite; }
@keyframes galeriaFloat { 0%,100%{transform:translateY(0) rotate(-3deg);} 50%{transform:translateY(-10px) rotate(3deg);} }
.gw-sparkle { position:absolute; font-size:13px; pointer-events:none; animation:gSparkle 2.2s ease-in-out infinite; }
.gw-sp1{top:4px;left:4px;animation-delay:0s;} .gw-sp2{top:4px;right:4px;animation-delay:0.75s;}
.gw-sp3{bottom:4px;left:8px;animation-delay:1.5s;} .gw-sp4{bottom:4px;right:8px;animation-delay:0.4s;}
@keyframes gSparkle { 0%{opacity:0;transform:scale(0) rotate(0);} 50%{opacity:1;transform:scale(1.2) rotate(180deg);} 100%{opacity:0;transform:scale(0) rotate(360deg);} }
#gw-gift-name { font-size:13px; font-weight:700; color:#00d4ff; text-align:center; letter-spacing:0.5px; }
#gw-counter { font-size:32px; font-weight:900; color:#ffd700; letter-spacing:2px; text-align:center; }
#gw-counter.bump { animation:gBump 0.5s ease-out; }
@keyframes gBump { 0%{transform:scale(1);} 30%{transform:scale(1.35);} 60%{transform:scale(0.95);} 100%{transform:scale(1);} }
#gw-dots { display:flex; gap:5px; margin-top:4px; }
.gw-dot { width:7px; height:7px; border-radius:50%; background:rgba(255,255,255,0.2); transition:background 0.3s; }
#gw { --gw-done-color:#ffd700; }
#gw.gw-complete { border-color:var(--gw-done-color)!important; animation:gwDonePulse 1.8s ease-in-out infinite!important; }
@keyframes gwDonePulse {
  0%,100%{box-shadow:0 0 30px color-mix(in srgb,var(--gw-done-color) 50%,transparent),inset 0 0 16px color-mix(in srgb,var(--gw-done-color) 12%,transparent);}
  50%{box-shadow:0 0 65px color-mix(in srgb,var(--gw-done-color) 85%,transparent),0 0 110px color-mix(in srgb,var(--gw-done-color) 30%,transparent),inset 0 0 30px color-mix(in srgb,var(--gw-done-color) 22%,transparent);border-color:var(--gw-done-color);}
}
#gw-badge { font-size:11px; font-weight:800; letter-spacing:2.5px; text-transform:uppercase; color:var(--gw-done-color); height:16px; opacity:0; transition:opacity 0.4s; }
#gw.gw-complete #gw-badge { opacity:1; animation:gwBadgePulse 1.4s ease-in-out infinite; }
@keyframes gwBadgePulse { 0%,100%{opacity:0.75;transform:scale(1);} 50%{opacity:1;transform:scale(1.07);} }
.t-neon { background:linear-gradient(160deg,rgba(0,10,35,0.93),rgba(0,28,60,0.93)); border:2px solid #00d4ff; box-shadow:0 0 32px rgba(0,212,255,0.45),inset 0 0 20px rgba(0,212,255,0.08); }
.t-neon #gw-title,.t-neon #gw-gift-name,.t-neon #gw-counter{font-family:'Orbitron',sans-serif;} .t-neon #gw-gift-name{font-size:11px;} .t-neon #gw-img{filter:drop-shadow(0 0 12px rgba(0,212,255,0.55));} .t-neon .gw-dot.active{background:#00d4ff;box-shadow:0 0 6px rgba(0,212,255,0.8);}
.t-roxo { background:linear-gradient(160deg,rgba(15,10,35,0.93),rgba(35,10,65,0.93)); border:2px solid rgba(190,100,255,0.65); box-shadow:0 0 30px rgba(160,60,255,0.4),inset 0 0 20px rgba(160,60,255,0.08); }
.t-roxo #gw-title,.t-roxo #gw-gift-name,.t-roxo #gw-counter{font-family:'Segoe UI',sans-serif;} .t-roxo #gw-img{filter:drop-shadow(0 0 10px rgba(180,80,255,0.5));} .t-roxo .gw-dot.active{background:#d8b4ff;box-shadow:0 0 6px rgba(180,80,255,0.8);}
.t-medieval { background:linear-gradient(160deg,rgba(20,14,4,0.96),rgba(45,32,8,0.96)); border:3px solid #8b7355; box-shadow:0 4px 22px rgba(0,0,0,0.65),inset 0 1px 0 rgba(255,215,0,0.15); border-radius:12px; }
.t-medieval #gw-title,.t-medieval #gw-gift-name,.t-medieval #gw-counter{font-family:'Cinzel',serif;} .t-medieval #gw-img{filter:drop-shadow(0 0 8px rgba(255,200,0,0.4));} .t-medieval .gw-dot.active{background:#ffd700;box-shadow:0 0 6px rgba(255,215,0,0.8);}
.t-retro { background:#0a0a0a; border:3px solid #00ff41; box-shadow:0 0 12px rgba(0,255,65,0.5),inset 0 0 14px rgba(0,255,65,0.05); border-radius:4px; }
.t-retro #gw-title{font-family:'Press Start 2P',monospace;font-size:7px;} .t-retro #gw-gift-name{font-family:'Press Start 2P',monospace;font-size:8px;} .t-retro #gw-counter{font-family:'Press Start 2P',monospace;font-size:22px;} .t-retro #gw-img{image-rendering:pixelated;filter:drop-shadow(0 0 6px rgba(0,255,65,0.4));} .t-retro .gw-dot.active{background:#00ff41;}
.t-fire { background:linear-gradient(160deg,rgba(50,12,0,0.95),rgba(85,28,0,0.95)); border:2px solid #ff6600; box-shadow:0 0 32px rgba(255,100,0,0.45),inset 0 -8px 28px rgba(255,50,0,0.15); }
.t-fire #gw-title,.t-fire #gw-gift-name,.t-fire #gw-counter{font-family:'Russo One',sans-serif;} .t-fire #gw-img{filter:drop-shadow(0 0 12px rgba(255,120,0,0.6));} .t-fire .gw-dot.active{background:#ff6600;}
.t-ice { background:linear-gradient(160deg,rgba(5,18,38,0.93),rgba(10,38,78,0.93)); border:2px solid rgba(150,220,255,0.65); box-shadow:0 0 26px rgba(100,200,255,0.35),inset 0 0 20px rgba(200,240,255,0.06); }
.t-ice #gw-title,.t-ice #gw-gift-name{font-family:'Rajdhani',sans-serif;font-size:16px;} .t-ice #gw-counter{font-family:'Rajdhani',sans-serif;font-size:40px;} .t-ice #gw-img{filter:drop-shadow(0 0 10px rgba(150,220,255,0.5));} .t-ice .gw-dot.active{background:#b0e0ff;}
.t-rosa { background:linear-gradient(160deg,rgba(60,15,40,0.92),rgba(95,20,55,0.92)); border:2px solid rgba(255,105,180,0.55); box-shadow:0 0 28px rgba(255,105,180,0.4),inset 0 0 20px rgba(255,182,213,0.08); }
.t-rosa #gw-title,.t-rosa #gw-gift-name,.t-rosa #gw-counter{font-family:'Poppins',sans-serif;font-weight:700;} .t-rosa #gw-img{filter:drop-shadow(0 0 12px rgba(255,105,180,0.55));} .t-rosa .gw-dot.active{background:#ff69b4;box-shadow:0 0 6px rgba(255,105,180,0.8);}
.t-clean { background:transparent; border:none; box-shadow:none; }
.t-clean #gw-title,.t-clean #gw-gift-name,.t-clean #gw-counter{font-family:'Segoe UI',sans-serif;text-shadow:0 2px 8px rgba(0,0,0,0.95);} .t-clean #gw-img{filter:drop-shadow(0 4px 12px rgba(0,0,0,0.8));} .t-clean .gw-dot.active{background:rgba(255,255,255,0.8);}
.t-custom { border:2px solid rgba(255,255,255,0.3); }
.t-custom #gw-title,.t-custom #gw-gift-name,.t-custom #gw-counter{font-family:'Segoe UI',sans-serif;} .t-custom .gw-dot.active{background:rgba(255,255,255,0.8);}
#gw-topname { font-size:14px; font-weight:700; letter-spacing:0.4px; text-align:center; max-width:170px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:rgba(255,255,255,0.7); margin-top:3px; }
#gw.gw-complete #gw-topname { color:var(--gw-done-color); text-shadow:0 0 8px color-mix(in srgb,var(--gw-done-color) 60%,transparent); }
.pcard-topname { font-size:11px; font-weight:700; color:rgba(255,255,255,0.55); text-align:center; max-width:100px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gw-pcard.done .pcard-topname { color:var(--pcard-done-color); text-shadow:0 0 6px color-mix(in srgb,var(--pcard-done-color) 55%,transparent); }
/* ─── PREMIUM ─── */
#gw-premium-wrap { display:none; width:100vw; height:100vh; flex-direction:column; align-items:center; justify-content:center;
  --pcard-name-color:#e0e0e0; --pcard-counter-color:#ffd700; --pcard-done-color:#ffd700; --pcard-custom-bg:rgba(0,0,0,0.5);
  background:transparent!important; border:none!important; box-shadow:none!important; }
#gw-prem-title { font-size:13px; font-weight:700; letter-spacing:2px; text-transform:uppercase; color:#fff; margin-bottom:10px; text-shadow:0 2px 8px rgba(0,0,0,0.9); }
#gw-prem-stage { width:100vw; overflow:hidden; height:140px; position:relative; }
#gw-prem-track { display:flex; gap:0px; position:absolute; top:0; left:0; height:140px; }
.gw-pcard { flex-shrink:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:5px; padding:10px 8px; border-radius:16px; width:116px; margin-right:12px;
  border:2px solid rgba(255,255,255,0.2); background:rgba(0,0,0,0.5);
  transition:border-color 0.4s,box-shadow 0.4s; }
.gw-pcard.done { border-color:var(--pcard-done-color)!important; box-shadow:0 0 18px rgba(255,215,0,0.5); }
.gw-pcard img { width:58px; height:58px; object-fit:contain; animation:galeriaFloat 3s ease-in-out infinite; }
.gw-pcard .pcard-name { font-size:10px; font-weight:700; color:var(--pcard-name-color); text-align:center; line-height:1.2; max-width:100px; }
.gw-pcard .pcard-counter { font-size:15px; font-weight:900; color:var(--pcard-counter-color); }
.gw-pcard.done .pcard-counter { color:var(--pcard-done-color); }
.gw-pcard .pcard-badge { font-size:8px; font-weight:800; color:var(--pcard-done-color); text-transform:uppercase; display:none; }
.gw-pcard.done .pcard-badge { display:block; }
/* ── Premium: temas ── */
#gw-premium-wrap.t-neon .gw-pcard { background:rgba(0,10,35,0.93); border-color:#00d4ff; box-shadow:0 0 12px rgba(0,212,255,0.3),inset 0 0 8px rgba(0,212,255,0.05); }
#gw-premium-wrap.t-neon .pcard-name,#gw-premium-wrap.t-neon .pcard-counter,#gw-premium-wrap.t-neon #gw-prem-title { font-family:'Orbitron',sans-serif; }
#gw-premium-wrap.t-neon .pcard-name { font-size:9px; }
#gw-premium-wrap.t-neon .gw-pcard img { filter:drop-shadow(0 0 8px rgba(0,212,255,0.5)); }
#gw-premium-wrap.t-roxo .gw-pcard { background:rgba(15,10,35,0.93); border-color:rgba(190,100,255,0.65); box-shadow:0 0 12px rgba(160,60,255,0.3); }
#gw-premium-wrap.t-roxo .gw-pcard img { filter:drop-shadow(0 0 8px rgba(180,80,255,0.5)); }
#gw-premium-wrap.t-medieval .gw-pcard { background:rgba(20,14,4,0.96); border-color:#8b7355; border-width:3px; border-radius:8px; }
#gw-premium-wrap.t-medieval .pcard-name,#gw-premium-wrap.t-medieval .pcard-counter,#gw-premium-wrap.t-medieval #gw-prem-title { font-family:'Cinzel',serif; }
#gw-premium-wrap.t-medieval .gw-pcard img { filter:drop-shadow(0 0 6px rgba(255,200,0,0.4)); }
#gw-premium-wrap.t-retro .gw-pcard { background:#0a0a0a; border-color:#00ff41; box-shadow:0 0 10px rgba(0,255,65,0.5); border-radius:4px; }
#gw-premium-wrap.t-retro .pcard-name { font-family:'Press Start 2P',monospace; font-size:7px; }
#gw-premium-wrap.t-retro .pcard-counter { font-family:'Press Start 2P',monospace; font-size:11px; }
#gw-premium-wrap.t-retro #gw-prem-title { font-family:'Press Start 2P',monospace; font-size:9px; }
#gw-premium-wrap.t-retro .gw-pcard img { image-rendering:pixelated; filter:drop-shadow(0 0 5px rgba(0,255,65,0.4)); }
#gw-premium-wrap.t-fire .gw-pcard { background:rgba(50,12,0,0.95); border-color:#ff6600; box-shadow:0 0 12px rgba(255,100,0,0.4); }
#gw-premium-wrap.t-fire .pcard-name,#gw-premium-wrap.t-fire .pcard-counter,#gw-premium-wrap.t-fire #gw-prem-title { font-family:'Russo One',sans-serif; }
#gw-premium-wrap.t-fire .gw-pcard img { filter:drop-shadow(0 0 8px rgba(255,120,0,0.6)); }
#gw-premium-wrap.t-ice .gw-pcard { background:rgba(5,18,38,0.93); border-color:rgba(150,220,255,0.65); box-shadow:0 0 10px rgba(100,200,255,0.25); }
#gw-premium-wrap.t-ice .pcard-name,#gw-premium-wrap.t-ice .pcard-counter,#gw-premium-wrap.t-ice #gw-prem-title { font-family:'Rajdhani',sans-serif; font-size:14px; }
#gw-premium-wrap.t-ice .gw-pcard img { filter:drop-shadow(0 0 8px rgba(150,220,255,0.5)); }
#gw-premium-wrap.t-rosa .gw-pcard { background:rgba(60,15,40,0.92); border-color:rgba(255,105,180,0.55); box-shadow:0 0 12px rgba(255,105,180,0.3); }
#gw-premium-wrap.t-rosa .pcard-name,#gw-premium-wrap.t-rosa .pcard-counter,#gw-premium-wrap.t-rosa #gw-prem-title { font-family:'Poppins',sans-serif; font-weight:700; }
#gw-premium-wrap.t-rosa .gw-pcard img { filter:drop-shadow(0 0 8px rgba(255,105,180,0.55)); }
#gw-premium-wrap.t-clean .gw-pcard { background:rgba(0,0,0,0.35); border-color:rgba(255,255,255,0.12); box-shadow:none; }
#gw-premium-wrap.t-custom .gw-pcard { background:var(--pcard-custom-bg); border-color:rgba(255,255,255,0.3); }
</style></head>
<body>
<div id="gw-padrao-wrap">
  <div id="gw" class="t-neon">
    <div id="gw-title">Galeria de Presentes</div>
    <div id="gw-content">
      <div id="gw-img-wrap">
        <img id="gw-img" src="" alt="">
        <span class="gw-sparkle gw-sp1">✨</span><span class="gw-sparkle gw-sp2">⭐</span>
        <span class="gw-sparkle gw-sp3">✨</span><span class="gw-sparkle gw-sp4">⭐</span>
      </div>
      <div id="gw-gift-name"></div>
      <div id="gw-counter">0 / 10</div>
      <div id="gw-topname"></div>
    </div>
    <div id="gw-dots"></div>
    <div id="gw-badge">⭐ META BATIDA! ⭐</div>
  </div>
</div>
<div id="gw-premium-wrap">
  <div id="gw-prem-title">Galeria de Presentes</div>
  <div id="gw-prem-stage">
    <div id="gw-prem-track"></div>
  </div>
</div>
<script>
  var LIGA_D = [
    { name:'TikTok', target:10, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/802a21ae29f9fae5abe3693de9f874bd~tplv-obj.webp' },
    { name:'Rose', target:10, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/eba3a9bb85c33e017f3648eaf88d7189~tplv-obj.webp' },
    { name:'Finger Heart', target:6, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/a4c4dc437fd3a6632aba149769491f49.png~tplv-obj.webp' },
    { name:'Friendship Necklace', target:5, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/e033c3f28632e233bebac1668ff66a2f.png~tplv-obj.webp' },
    { name:'Perfume', target:3, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/20b8f61246c7b6032777bb81bf4ee055~tplv-obj.webp' },
    { name:'Doughnut', target:3, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/4e7ad6bdf0a1d860c538f38026d4e812~tplv-obj.webp' },
    { name:'Hat and Mustache', target:3, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/2f1e4f3f5c728ffbfa35705b480fdc92~tplv-obj.webp' },
    { name:'Hand Hearts', target:3, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/6cd022271dc4669d182cad856384870f~tplv-obj.webp' },
    { name:'Hearts', target:2, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/934b5a10dee8376df5870a61d2ea5cb6.png~tplv-obj.webp' },
    { name:'Corgi', target:2, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/148eef0884fdb12058d1c6897d1e02b9~tplv-obj.webp' }
  ];
  var LIGA_C = [
    { name:'Rose', target:20, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/eba3a9bb85c33e017f3648eaf88d7189~tplv-obj.webp' },
    { name:'Finger Heart', target:15, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/a4c4dc437fd3a6632aba149769491f49.png~tplv-obj.webp' },
    { name:'Rosa', target:15, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/eb77ead5c3abb6da6034d3cf6cfeb438~tplv-obj.webp' },
    { name:'Doughnut', target:10, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/4e7ad6bdf0a1d860c538f38026d4e812~tplv-obj.webp' },
    { name:'Hat and Mustache', target:6, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/2f1e4f3f5c728ffbfa35705b480fdc92~tplv-obj.webp' },
    { name:'Hand Hearts', target:6, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/6cd022271dc4669d182cad856384870f~tplv-obj.webp' },
    { name:'Hearts', target:5, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/934b5a10dee8376df5870a61d2ea5cb6.png~tplv-obj.webp' },
    { name:'Corgi', target:3, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/148eef0884fdb12058d1c6897d1e02b9~tplv-obj.webp' },
    { name:'Money Gun', target:2, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/e0589e95a2b41970f0f30f6202f5fce6~tplv-obj.webp' },
    { name:'DJ Glasses', target:2, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/d4aad726e2759e54a924fbcd628ea143.png~tplv-obj.webp' },
    { name:'Swan', target:1, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/97a26919dbf6afe262c97e22a83f4bf1~tplv-obj.webp' },
    { name:'Galaxy', target:1, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/79a02148079526539f7599150da9fd28.png~tplv-obj.webp' },
    { name:'Fireworks', target:1, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/9494c8a0bc5c03521ef65368e59cc2b8~tplv-obj.webp' },
    { name:'Whale Diving', target:1, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/46fa70966d8e931497f5289060f9a794~tplv-obj.webp' },
    { name:'Meteor Shower', target:1, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/71883933511237f7eaa1bf8cd12ed575~tplv-obj.webp' }
  ];
  var LIGA_B = [
    { name:'Rose', target:30, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/eba3a9bb85c33e017f3648eaf88d7189~tplv-obj.webp' },
    { name:'Doughnut', target:10, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/4e7ad6bdf0a1d860c538f38026d4e812~tplv-obj.webp' },
    { name:'Hat and Mustache', target:8, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/2f1e4f3f5c728ffbfa35705b480fdc92~tplv-obj.webp' },
    { name:'Hand Hearts', target:8, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/6cd022271dc4669d182cad856384870f~tplv-obj.webp' },
    { name:'Hearts', target:7, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/934b5a10dee8376df5870a61d2ea5cb6.png~tplv-obj.webp' },
    { name:'Corgi', target:6, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/148eef0884fdb12058d1c6897d1e02b9~tplv-obj.webp' },
    { name:'Money Gun', target:5, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/e0589e95a2b41970f0f30f6202f5fce6~tplv-obj.webp' },
    { name:'DJ Glasses', target:5, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/d4aad726e2759e54a924fbcd628ea143.png~tplv-obj.webp' },
    { name:'Swan', target:4, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/97a26919dbf6afe262c97e22a83f4bf1~tplv-obj.webp' },
    { name:'Galaxy', target:3, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/79a02148079526539f7599150da9fd28.png~tplv-obj.webp' },
    { name:'Fireworks', target:3, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/9494c8a0bc5c03521ef65368e59cc2b8~tplv-obj.webp' },
    { name:'Whale Diving', target:2, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/46fa70966d8e931497f5289060f9a794~tplv-obj.webp' },
    { name:'Meteor Shower', target:2, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/71883933511237f7eaa1bf8cd12ed575~tplv-obj.webp' },
    { name:'Leon the Kitten', target:1, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/a7748baba012c9e2d98a30dce7cc5a27~tplv-obj.webp' },
    { name:'Flying Jets', target:1, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/1d067d13988e8754ed6adbebd89b9ee8.png~tplv-obj.webp' },
    { name:'Future City', target:1, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/963b7c25aa2cedc0de22358342645e87.png~tplv-obj.webp' },
    { name:'Interstellar', target:1, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/8520d47b59c202a4534c1560a355ae06~tplv-obj.webp' },
    { name:'Party On&On', target:1, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/c45505ece4a91d9c43e4ba98a000b006.png~tplv-obj.webp' },
    { name:'Lion', target:1, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/4fb89af2082a290b37d704e20f4fe729~tplv-obj.webp' }
  ];
  var LIGA_A = [
    { name:'Rose', target:40, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/eba3a9bb85c33e017f3648eaf88d7189~tplv-obj.webp' },
    { name:'Doughnut', target:20, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/4e7ad6bdf0a1d860c538f38026d4e812~tplv-obj.webp' },
    { name:'Hat and Mustache', target:15, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/2f1e4f3f5c728ffbfa35705b480fdc92~tplv-obj.webp' },
    { name:'Hand Hearts', target:10, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/6cd022271dc4669d182cad856384870f~tplv-obj.webp' },
    { name:'Hearts', target:8, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/934b5a10dee8376df5870a61d2ea5cb6.png~tplv-obj.webp' },
    { name:'Corgi', target:6, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/148eef0884fdb12058d1c6897d1e02b9~tplv-obj.webp' },
    { name:'Forever Rosa', target:5, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/863e7947bc793f694acbe970d70440a1.png~tplv-obj.webp' },
    { name:'Money Gun', target:5, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/e0589e95a2b41970f0f30f6202f5fce6~tplv-obj.webp' },
    { name:'Swan', target:5, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/97a26919dbf6afe262c97e22a83f4bf1~tplv-obj.webp' },
    { name:'Galaxy', target:4, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/79a02148079526539f7599150da9fd28.png~tplv-obj.webp' },
    { name:'Fireworks', target:4, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/9494c8a0bc5c03521ef65368e59cc2b8~tplv-obj.webp' },
    { name:'Whale Diving', target:3, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/46fa70966d8e931497f5289060f9a794~tplv-obj.webp' },
    { name:'Leon the Kitten', target:2, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/a7748baba012c9e2d98a30dce7cc5a27~tplv-obj.webp' },
    { name:'Flying Jets', target:2, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/1d067d13988e8754ed6adbebd89b9ee8.png~tplv-obj.webp' },
    { name:'Future City', target:3, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/963b7c25aa2cedc0de22358342645e87.png~tplv-obj.webp' },
    { name:'Interstellar', target:2, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/8520d47b59c202a4534c1560a355ae06~tplv-obj.webp' },
    { name:'Party On&On', target:2, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/c45505ece4a91d9c43e4ba98a000b006.png~tplv-obj.webp' },
    { name:'Lion', target:1, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/4fb89af2082a290b37d704e20f4fe729~tplv-obj.webp' },
    { name:'Leon and Lion', target:1, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/a291aedacf27d22c3fd2d83575d2bee9~tplv-obj.webp' },
    { name:'TikTok Universe', target:1, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/8f471afbcebfda3841a6cc515e381f58~tplv-obj.webp' }
  ];
  var THEMES = ['neon','roxo','medieval','retro','fire','ice','rosa','clean','custom'];
  var state = { league:'D', style:'padrao', title:'Galeria de Presentes', progress:{}, theme:'neon', titleColor:'#ffffff', nameColor:'#00d4ff', counterColor:'#ffd700', customColor:'', completeColor:'#ffd700', showTopName:false };
  var currIdx = 0;
  var timer = null;

  // Padrão elements
  var gwEl      = document.getElementById('gw');
  var titleEl   = document.getElementById('gw-title');
  var contentEl = document.getElementById('gw-content');
  var imgEl     = document.getElementById('gw-img');
  var nameEl    = document.getElementById('gw-gift-name');
  var counterEl = document.getElementById('gw-counter');
  var dotsEl    = document.getElementById('gw-dots');
  var topNameEl = document.getElementById('gw-topname');

  // Premium elements
  var padWrapEl   = document.getElementById('gw-padrao-wrap');
  var premWrapEl  = document.getElementById('gw-premium-wrap');
  var premTitleEl = document.getElementById('gw-prem-title');
  var stageEl     = document.getElementById('gw-prem-stage');
  var trackEl     = document.getElementById('gw-prem-track');

  function galeriaTopCount(giftName) {
    var users = state.progress[giftName];
    if (!users || typeof users !== 'object') return 0;
    var top = 0;
    Object.keys(users).forEach(function(uid) { if (users[uid].count > top) top = users[uid].count; });
    return top;
  }
  function galeriaTopSender(giftName) {
    var users = state.progress[giftName];
    if (!users || typeof users !== 'object') return null;
    var top = null;
    Object.keys(users).forEach(function(uid) {
      if (!top || users[uid].count > top.count) top = users[uid];
    });
    return top;
  }

  function getLeague() {
    if (state.league === 'A') return LIGA_A;
    if (state.league === 'B') return LIGA_B;
    if (state.league === 'C') return LIGA_C;
    return LIGA_D;
  }

  // ── PADRÃO ──
  function applyVisual(s) {
    THEMES.forEach(function(t){ gwEl.classList.remove('t-'+t); });
    gwEl.classList.add('t-' + (s.theme || 'neon'));
    if (s.theme === 'custom' && s.customColor) gwEl.style.background = s.customColor;
    else gwEl.style.background = '';
    titleEl.style.color   = s.titleColor   || '#ffffff';
    nameEl.style.color    = s.nameColor    || '#00d4ff';
    counterEl.style.color = s.counterColor || '#ffd700';
    gwEl.style.setProperty('--gw-done-color', s.completeColor || '#ffd700');
  }
  function buildDots() {
    var gifts = getLeague();
    dotsEl.innerHTML = '';
    gifts.forEach(function(_, i) {
      var d = document.createElement('div');
      d.className = 'gw-dot' + (i === currIdx ? ' active' : '');
      dotsEl.appendChild(d);
    });
  }
  function showGift(idx) {
    var gifts = getLeague();
    var gift = gifts[idx];
    if (!gift) return;
    var topCount = galeriaTopCount(gift.name);
    var done = topCount >= gift.target;
    var topSender = galeriaTopSender(gift.name);
    contentEl.classList.add('fading');
    setTimeout(function() {
      imgEl.src = gift.image;
      nameEl.textContent = gift.name;
      counterEl.textContent = topCount + ' / ' + gift.target;
      topNameEl.textContent = (done && topSender) ? topSender.nickname : 'aguardando...';
      contentEl.classList.remove('fading');
      gwEl.classList.toggle('gw-complete', done);
      var dots = dotsEl.querySelectorAll('.gw-dot');
      dots.forEach(function(d, i) { d.classList.toggle('active', i === idx); });
    }, 350);
  }
  function startCycle() {
    if (timer) clearInterval(timer);
    buildDots();
    showGift(currIdx);
    timer = setInterval(function() {
      currIdx = (currIdx + 1) % getLeague().length;
      showGift(currIdx);
    }, 2800);
  }

  // ── PREMIUM (carrossel — track flex + setInterval) ──
  var premTimer  = null;
  var premOffset = 0;
  var singleWidth = 0;
  var CARD_STEP = 128; // 116px width + 12px margin-right

  function buildCarousel() {
    if (premTimer) { clearInterval(premTimer); premTimer = null; }
    premOffset = 0;
    trackEl.style.transform = 'translateX(0px)';
    var gifts = getLeague();
    // Duplica a lista para loop contínuo sem salto
    var html = '';
    [gifts, gifts].forEach(function(list) {
      list.forEach(function(g) {
        var topCount = galeriaTopCount(g.name);
        var done = topCount >= g.target;
        var topSender = galeriaTopSender(g.name);
        var topNameTxt = (done && topSender) ? topSender.nickname : 'aguardando...';
        html += '<div class="gw-pcard' + (done ? ' done' : '') + '" data-gift="' + g.name + '">' +
          '<img src="' + g.image + '" alt="">' +
          '<div class="pcard-name">' + g.name + '</div>' +
          '<div class="pcard-counter">' + topCount + ' / ' + g.target + '</div>' +
          '<div class="pcard-topname">' + topNameTxt + '</div>' +
          '</div>';
      });
    });
    trackEl.innerHTML = html;
    singleWidth = gifts.length * CARD_STEP;
    // setInterval é mais estável que rAF no OBS Browser Source
    premTimer = setInterval(function() {
      premOffset++;
      if (premOffset >= singleWidth) premOffset = 0;
      trackEl.style.transform = 'translateX(-' + premOffset + 'px)';
    }, 16);
  }

  function updateCarouselCard(giftName) {
    var gifts = getLeague();
    var g = gifts.find(function(x){ return x.name === giftName; });
    if (!g) return;
    var topCount = galeriaTopCount(g.name);
    var done = topCount >= g.target;
    var topSender = galeriaTopSender(g.name);
    trackEl.querySelectorAll('[data-gift="' + giftName + '"]').forEach(function(el) {
      el.querySelector('.pcard-counter').textContent = topCount + ' / ' + g.target;
      el.classList.toggle('done', done);
      var tnEl = el.querySelector('.pcard-topname');
      if (tnEl) tnEl.textContent = (done && topSender) ? topSender.nickname : 'aguardando...';
    });
  }

  function applyPremiumVisual(s) {
    // Tema
    THEMES.forEach(function(t){ premWrapEl.classList.remove('t-'+t); });
    premWrapEl.classList.add('t-' + (s.theme || 'neon'));
    // Cor customizada (fundo dos cards)
    if (s.theme === 'custom' && s.customColor) {
      premWrapEl.style.setProperty('--pcard-custom-bg', s.customColor);
    }
    // Cores dinâmicas via CSS vars (valem para todos os cards, inclusive os criados depois)
    premWrapEl.style.setProperty('--pcard-name-color',     s.nameColor     || '#e0e0e0');
    premWrapEl.style.setProperty('--pcard-counter-color',  s.counterColor  || '#ffd700');
    premWrapEl.style.setProperty('--pcard-done-color',     s.completeColor || '#ffd700');
    // Título
    premTitleEl.style.color = s.titleColor || '#ffffff';
    premTitleEl.textContent = s.title || 'Galeria de Presentes';
  }

  // ── SWITCH DE ESTILO ──
  function applyStyle(s) {
    if (s.style === 'premium') {
      padWrapEl.style.display = 'none';
      premWrapEl.style.display = 'flex';
      if (timer) { clearInterval(timer); timer = null; }
      applyPremiumVisual(s);
      buildCarousel();
    } else {
      if (premTimer) { clearInterval(premTimer); premTimer = null; }
      padWrapEl.style.display = '';
      premWrapEl.style.display = 'none';
      applyVisual(s);
      currIdx = 0;
      startCycle();
    }
  }

  function connect() {
    var es = new EventSource('/sse/${roomId}/galeria');
    es.onmessage = function(e) {
      try {
        var d = JSON.parse(e.data);
        if (d.type === 'config') {
          state.league        = d.league        || 'D';
          state.style         = d.style         || 'padrao';
          state.title         = d.title         || 'Galeria de Presentes';
          state.progress      = d.progress      || {};
          state.theme         = d.theme         || 'neon';
          state.titleColor    = d.titleColor    || '#ffffff';
          state.nameColor     = d.nameColor     || '#00d4ff';
          state.counterColor  = d.counterColor  || '#ffd700';
          state.customColor   = d.customColor   || '';
          state.completeColor = d.completeColor || '#ffd700';
          state.showTopName   = !!d.showTopName;
          applyStyle(state);
        } else if (d.type === 'progress') {
          state.progress = d.progress || {};
          if (state.style === 'premium') {
            updateCarouselCard(d.giftName);
          } else {
            var gifts = getLeague();
            var cur = gifts[currIdx];
            if (cur && d.giftName === cur.name) {
              var topCnt = galeriaTopCount(cur.name);
              var done = topCnt >= cur.target;
              var topSndr = galeriaTopSender(cur.name);
              counterEl.textContent = topCnt + ' / ' + cur.target;
              gwEl.classList.toggle('gw-complete', done);
              counterEl.classList.remove('bump'); void counterEl.offsetWidth; counterEl.classList.add('bump');
              counterEl.addEventListener('animationend', function() { counterEl.classList.remove('bump'); }, { once:true });
              topNameEl.textContent = (done && topSndr) ? topSndr.nickname : 'aguardando...';
            }
          }
        }
      } catch(err) {}
    };
    es.onerror = function() { es.close(); setTimeout(connect, 3000); };
  }
  connect();
</script>
</body>
</html>`;
}

function getComboCarouselOverlayHTML(roomId) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700;900&family=Orbitron:wght@700;900&family=Press+Start+2P&display=swap" rel="stylesheet">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  background:transparent; overflow:hidden; width:100vw; height:100vh;
  display:flex; align-items:center; justify-content:center;
  /* === TEMA PADRÃO: ROXO === */
  --cc-card-bg: rgba(18,6,46,0.88);
  --cc-card-border: rgba(140,80,255,0.4);
  --cc-card-shadow: rgba(120,60,255,0.12);
  --cc-avatar-border: rgba(160,100,255,0.6);
  --cc-avatar-ph: linear-gradient(135deg,#6b21a8,#3730a3);
  --cc-name-color: #e2d9ff;
  --cc-verb-color: rgba(255,255,255,0.45);
  --cc-gift-color: #fff;
  --cc-count-color: #ffd700;
  --cc-count-shadow: rgba(255,215,0,0.5);
  --cc-gift-glow: rgba(200,150,255,0.4);
  --cc-font: 'Poppins',sans-serif;
}
/* === TEMA NEON === */
body.t-neon {
  --cc-card-bg: rgba(0,10,30,0.90);
  --cc-card-border: rgba(0,212,255,0.45);
  --cc-card-shadow: rgba(0,212,255,0.12);
  --cc-avatar-border: #00d4ff;
  --cc-avatar-ph: linear-gradient(135deg,#003366,#001122);
  --cc-name-color: #00d4ff;
  --cc-verb-color: rgba(255,255,255,0.5);
  --cc-gift-color: #fff;
  --cc-count-color: #ff3366;
  --cc-count-shadow: rgba(255,51,102,0.65);
  --cc-gift-glow: rgba(0,212,255,0.4);
  --cc-font: 'Orbitron','Poppins',sans-serif;
}
/* === TEMA DOURADO === */
body.t-dourado {
  --cc-card-bg: rgba(20,14,0,0.92);
  --cc-card-border: rgba(255,215,0,0.45);
  --cc-card-shadow: rgba(255,215,0,0.1);
  --cc-avatar-border: #ffd700;
  --cc-avatar-ph: linear-gradient(135deg,#7a5a00,#4a3500);
  --cc-name-color: #ffd700;
  --cc-verb-color: rgba(255,230,150,0.65);
  --cc-gift-color: #fff5cc;
  --cc-count-color: #ffaa00;
  --cc-count-shadow: rgba(255,170,0,0.65);
  --cc-gift-glow: rgba(255,215,0,0.45);
  --cc-font: 'Poppins',sans-serif;
}
/* === TEMA FOGO === */
body.t-fire {
  --cc-card-bg: rgba(30,6,0,0.93);
  --cc-card-border: rgba(255,69,0,0.55);
  --cc-card-shadow: rgba(255,69,0,0.15);
  --cc-avatar-border: #ff4500;
  --cc-avatar-ph: linear-gradient(135deg,#7a1500,#3a0800);
  --cc-name-color: #fff44f;
  --cc-verb-color: rgba(255,200,100,0.7);
  --cc-gift-color: #fff;
  --cc-count-color: #ff6b35;
  --cc-count-shadow: rgba(255,107,53,0.75);
  --cc-gift-glow: rgba(255,100,0,0.5);
  --cc-font: 'Poppins',sans-serif;
}
/* === TEMA MEDIEVAL === */
body.t-medieval {
  --cc-card-bg: rgba(25,14,4,0.93);
  --cc-card-border: rgba(201,164,74,0.5);
  --cc-card-shadow: rgba(201,164,74,0.12);
  --cc-avatar-border: #c9a44a;
  --cc-avatar-ph: linear-gradient(135deg,#6b4c00,#3a2900);
  --cc-name-color: #ffd700;
  --cc-verb-color: rgba(220,190,120,0.65);
  --cc-gift-color: #fff;
  --cc-count-color: #c9a44a;
  --cc-count-shadow: rgba(201,164,74,0.65);
  --cc-gift-glow: rgba(201,164,74,0.45);
  --cc-font: 'Poppins',sans-serif;
}
/* === TEMA RETRO === */
body.t-retro {
  --cc-card-bg: rgba(0,8,0,0.93);
  --cc-card-border: rgba(57,255,20,0.45);
  --cc-card-shadow: rgba(57,255,20,0.12);
  --cc-avatar-border: #39ff14;
  --cc-avatar-ph: linear-gradient(135deg,#003300,#001a00);
  --cc-name-color: #39ff14;
  --cc-verb-color: rgba(57,255,20,0.6);
  --cc-gift-color: #00ffff;
  --cc-count-color: #ff00ff;
  --cc-count-shadow: rgba(255,0,255,0.7);
  --cc-gift-glow: rgba(0,255,255,0.45);
  --cc-font: 'Press Start 2P',monospace;
}
/* === TEMA ROSA === */
body.t-rosa {
  --cc-card-bg: rgba(60,15,40,0.92);
  --cc-card-border: rgba(255,105,180,0.5);
  --cc-card-shadow: rgba(255,105,180,0.18);
  --cc-avatar-border: #ff69b4;
  --cc-avatar-ph: linear-gradient(135deg,#831843,#500724);
  --cc-name-color: #ff69b4;
  --cc-verb-color: rgba(255,209,231,0.65);
  --cc-gift-color: #ffd1e7;
  --cc-count-color: #ec4899;
  --cc-count-shadow: rgba(236,72,153,0.65);
  --cc-gift-glow: rgba(255,105,180,0.5);
  --cc-font: 'Poppins',sans-serif;
}
/* === TEMA LIMPO === */
body.t-clean {
  --cc-card-bg: rgba(0,0,0,0.52);
  --cc-card-border: rgba(255,255,255,0.18);
  --cc-card-shadow: rgba(255,255,255,0.05);
  --cc-avatar-border: rgba(255,255,255,0.45);
  --cc-avatar-ph: linear-gradient(135deg,#555,#222);
  --cc-name-color: #fff;
  --cc-verb-color: rgba(255,255,255,0.55);
  --cc-gift-color: #fff;
  --cc-count-color: #ffd700;
  --cc-count-shadow: rgba(255,215,0,0.4);
  --cc-gift-glow: rgba(255,255,255,0.2);
  --cc-font: 'Poppins',sans-serif;
}
#cc-stage { width:100vw; overflow:hidden; height:80px; position:relative; }
#cc-track { display:flex; position:absolute; top:0; left:0; height:80px; will-change:transform; }
.cc-card {
  flex-shrink:0; display:flex; align-items:center; gap:10px;
  padding:8px 18px 8px 10px; margin-right:14px;
  border-radius:40px; height:66px;
  background:var(--cc-card-bg);
  border:1.5px solid var(--cc-card-border);
  box-shadow:0 4px 24px rgba(0,0,0,0.45),inset 0 0 14px var(--cc-card-shadow);
  white-space:nowrap;
}
.cc-av-wrap {
  position:relative; width:46px; height:46px; flex-shrink:0;
}
.cc-avatar-ph {
  position:absolute; inset:0; border-radius:50%;
  background:var(--cc-avatar-ph);
  border:2px solid var(--cc-avatar-border);
  display:flex; align-items:center; justify-content:center;
  font-size:20px;
}
.cc-avatar {
  position:absolute; inset:0; width:100%; height:100%;
  border-radius:50%; object-fit:cover;
  border:2px solid var(--cc-avatar-border);
}
.cc-info { display:flex; align-items:center; gap:6px; }
.cc-name { font-family:var(--cc-font); font-size:13px; font-weight:700; color:var(--cc-name-color); }
.cc-verb { font-family:'Poppins',sans-serif; font-size:12px; color:var(--cc-verb-color); }
.cc-gift-name { font-family:var(--cc-font); font-size:13px; font-weight:700; color:var(--cc-verb-color); }
.cc-gift-img { width:42px; height:42px; object-fit:contain; flex-shrink:0; filter:drop-shadow(0 0 6px var(--cc-gift-glow)); animation:cc-gift-float 2s ease-in-out infinite; }
@keyframes cc-gift-float {
  0%,100% { transform: translateY(0px) rotate(-6deg) scale(1); }
  25%      { transform: translateY(-5px) rotate(0deg) scale(1.08); }
  50%      { transform: translateY(-8px) rotate(6deg) scale(1.05); }
  75%      { transform: translateY(-3px) rotate(0deg) scale(1.02); }
}
.cc-count { font-family:var(--cc-font); font-size:16px; font-weight:900; color:var(--cc-count-color); margin-left:2px; text-shadow:0 0 8px var(--cc-count-shadow); }
body.t-retro .cc-name { font-size:9px; }
body.t-retro .cc-gift-name { font-size:9px; }
body.t-retro .cc-count { font-size:11px; }
</style></head>
<body>
<div id="cc-stage"><div id="cc-track"></div></div>
<script>
  var items = [];
  var track = document.getElementById('cc-track');
  var offset = 0, singleW = 0, timer = null, buildPending = null;

  function proxyImg(url) {
    if (!url) return '';
    if (url.startsWith('data:')) return url; // base64 — usar direto, sem proxy
    return '/img-proxy?url=' + encodeURIComponent(url);
  }

  function applyTheme(cfg) {
    var b = document.body;
    b.className = b.className.replace(/\\bt-\\S+/g, '').trim();
    if (cfg.theme && cfg.theme !== 'roxo') b.classList.add('t-' + cfg.theme);
    if (cfg.verbColor) b.style.setProperty('--cc-verb-color', cfg.verbColor);
    else b.style.removeProperty('--cc-verb-color');
    if (cfg.countColor) b.style.setProperty('--cc-count-color', cfg.countColor);
    else b.style.removeProperty('--cc-count-color');
  }

  function active() {
    return items.filter(function(it) {
      if (it.mode === 'predefined') {
        // Mostra se tem predefinido OU se foi roubado (holder com count > predef)
        return (it.predefined && it.predefined.nickname) || (it.holder && it.holder.nickname);
      }
      return it.holder && it.holder.nickname;
    });
  }

  function card(it) {
    var nick, av, cnt;
    if (it.mode === 'predefined') {
      // Se foi roubado (holder com count > predef.count), mostra o holder
      var predefCount = (it.predefined && it.predefined.count) || 0;
      if (it.holder && it.holder.count > predefCount) {
        nick = it.holder.nickname; av = it.holder.avatar || ''; cnt = it.holder.count;
      } else {
        nick = it.predefined.nickname; av = it.predefined.avatar || ''; cnt = it.predefined.count;
      }
    } else {
      nick = it.holder.nickname; av = it.holder.avatar || ''; cnt = it.holder.count;
    }
    var src = proxyImg(av);
    // Placeholder sempre visível atrás (CSS position:absolute).
    // Se a foto carregar, fica na frente e cobre o placeholder. Sem onerror.
    var avHTML = '<div class="cc-av-wrap"><div class="cc-avatar-ph">&#x1F381;</div>' +
      (src ? '<img class="cc-avatar" src="' + src + '">' : '') +
      '</div>';
    return '<div class="cc-card">' + avHTML +
      '<div class="cc-info">' +
        '<span class="cc-name">' + nick + '</span>' +
        '<span class="cc-verb">enviou</span>' +
        '<span class="cc-gift-name">' + it.giftName + '</span>' +
        '<img class="cc-gift-img" src="' + it.giftImage + '" alt="">' +
        '<span class="cc-count">x' + cnt + '</span>' +
      '</div></div>';
  }

  function build() {
    // Cancelar timers anteriores para não acumular setInterval
    if (timer) { clearInterval(timer); timer = null; }
    if (buildPending) { clearTimeout(buildPending); buildPending = null; }
    offset = 0; track.style.transform = 'translateX(0px)';
    var list = active();
    if (!list.length) {
      track.innerHTML = '<div style="color:rgba(255,255,255,0.3);font-family:Poppins,sans-serif;font-size:13px;padding:20px;">Aguardando combos...</div>';
      singleW = 0; return;
    }

    // Com só 1 item: mostrar centralizado, sem animação
    if (list.length === 1) {
      track.innerHTML = card(list[0]);
      track.style.cssText = 'display:flex;align-items:center;justify-content:center;position:absolute;top:0;left:0;right:0;height:80px;';
      singleW = 0; return;
    }

    // 2+ itens: renderizar cópias suficientes para preencher viewport e fazer loop seamless
    var vw = window.innerWidth || 1920;
    var html = '';
    list.concat(list).forEach(function(it) { html += card(it); });
    track.style.cssText = 'display:flex;position:absolute;top:0;left:0;height:80px;will-change:transform;';
    track.innerHTML = html;

    var measureAttempts = 0;
    function measureAndStart() {
      buildPending = null;
      var allCards = track.querySelectorAll('.cc-card');
      // Se cards ainda não foram renderizados, tentar de novo
      if (allCards.length < list.length) {
        if (++measureAttempts < 15) {
          buildPending = setTimeout(measureAndStart, 100);
        } else {
          // Fallback final: usar largura aproximada
          singleW = list.length * 280;
          startScroll();
        }
        return;
      }
      singleW = 0;
      var hasZero = false;
      for (var i = 0; i < list.length; i++) {
        var w = allCards[i].offsetWidth;
        if (!w) { hasZero = true; break; }
        singleW += w + 14;
      }
      // Se algum card ainda não tem largura, tentar novamente
      if (hasZero || !singleW) {
        if (++measureAttempts < 15) {
          buildPending = setTimeout(measureAndStart, 100);
          return;
        }
        // Fallback final: largura aproximada (280px por card)
        singleW = list.length * 280;
      }
      startScroll();
    }

    function startScroll() {
      // Adicionar cópias extras se o conteúdo não preencher a tela
      if (singleW < vw + 100) {
        var copies = Math.ceil((vw * 2) / singleW) + 1;
        var bigHtml = '';
        for (var c = 0; c < copies; c++) list.forEach(function(it) { bigHtml += card(it); });
        track.innerHTML = bigHtml;
      }
      if (timer) clearInterval(timer);
      timer = setInterval(function() {
        offset++;
        if (offset >= singleW) offset = 0;
        track.style.transform = 'translateX(-' + offset + 'px)';
      }, 16);
    }

    buildPending = setTimeout(measureAndStart, 60);
  }

  function connect() {
    var es = new EventSource('/sse/${roomId}/combo-carousel');
    es.onmessage = function(e) {
      try {
        var d = JSON.parse(e.data);
        if (d.type === 'config') { applyTheme(d); items = d.items || []; build(); }
      } catch(err) {}
    };
    es.onerror = function() { es.close(); setTimeout(connect, 3000); };
  }
  connect();
</script>
</body></html>`;
}

function getTranslatorOverlayHTML(roomId) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700;900&display=swap" rel="stylesheet">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  background:transparent; overflow:hidden; width:100vw; height:100vh;
  display:flex; align-items:center; justify-content:center;
  font-family:'Poppins',sans-serif;
}
#tr-box {
  max-width:90vw;
  padding:18px 28px;
  border-radius:18px;
  font-size:36px;
  font-weight:700;
  color:#ffffff;
  text-align:center;
  line-height:1.3;
  text-shadow:0 2px 12px rgba(0,0,0,0.75), 0 0 3px rgba(0,0,0,0.9);
  opacity:0;
  transition:opacity 0.35s ease;
  word-wrap:break-word;
}
#tr-box.visible { opacity:1; }
</style></head>
<body>
<div id="tr-box"></div>
<script>
  var box = document.getElementById('tr-box');
  var currentDuration = 5;
  var hideTimer = null;
  var lastText = '';
  function applyStyle(s) {
    if (s.color != null) box.style.color = s.color;
    if (s.bg != null) box.style.background = s.bg;
    if (s.size != null) box.style.fontSize = s.size + 'px';
    if (s.duration != null) currentDuration = parseFloat(s.duration) || 5;
  }
  function setText(t) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (!t) {
      box.classList.remove('visible');
      // limpar texto depois do fade out terminar
      setTimeout(function(){ if (!box.classList.contains('visible')) box.textContent = ''; }, 400);
      return;
    }
    // Se o texto mudou ou está reaparecendo, mostrar
    box.textContent = t;
    box.classList.add('visible');
    lastText = t;
    // Programar o fade out após X segundos
    if (currentDuration > 0) {
      hideTimer = setTimeout(function() {
        box.classList.remove('visible');
        setTimeout(function(){ if (!box.classList.contains('visible')) box.textContent = ''; }, 400);
      }, currentDuration * 1000);
    }
  }
  function connect() {
    var es = new EventSource('/sse/${roomId}/translator');
    es.onmessage = function(e) {
      try {
        var d = JSON.parse(e.data);
        if (d.type === 'state') {
          applyStyle(d);
          // Só renovar timer se o texto realmente mudou (evita re-disparar com config-only)
          if ((d.text || '') !== lastText || d.text === '') {
            setText(d.text || '');
          }
        }
      } catch(err) {}
    };
    es.onerror = function() { es.close(); setTimeout(connect, 3000); };
  }
  connect();
</script>
</body></html>`;
}

function getFigurinhasOverlayHTML(roomId) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
* { margin:0; padding:0; }
body { background:transparent; width:100vw; height:100vh; overflow:hidden; }
#status { position:fixed; bottom:6px; left:6px; padding:4px 8px; background:rgba(0,0,0,0.6); color:#fff; font-family:Arial,sans-serif; font-size:10px; border-radius:4px; opacity:0.5; }
#pulse { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:80px; height:80px; border-radius:50%; background:radial-gradient(circle, rgba(255,105,180,0.7), rgba(255,105,180,0)); opacity:0; transition:opacity 0.2s; pointer-events:none; }
#pulse.active { opacity:1; animation:pulse 0.5s ease-out; }
@keyframes pulse { 0%{transform:translate(-50%,-50%) scale(0.3);} 100%{transform:translate(-50%,-50%) scale(2.5);} }
</style></head>
<body>
<div id="status">🎵 Figurinhas (conectando...)</div>
<div id="pulse"></div>
<script>
  var statusEl = document.getElementById('status');
  var pulseEl = document.getElementById('pulse');

  // AudioContext — modo mais robusto pra OBS Browser Source com "Controlar áudio via OBS"
  var audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch(e) { console.error('AudioContext não suportado:', e); }
    }
    return audioCtx;
  }

  function showPulse() {
    pulseEl.classList.remove('active');
    void pulseEl.offsetWidth;
    pulseEl.classList.add('active');
    setTimeout(function(){ pulseEl.classList.remove('active'); }, 500);
  }

  function playSound(mediaUrl, volume) {
    showPulse();
    var vol = Math.max(0, Math.min(1, (volume || 80) / 100));

    var ctx = getAudioCtx();
    if (ctx) {
      fetch(mediaUrl)
        .then(function(r){ return r.arrayBuffer(); })
        .then(function(buf){ return ctx.decodeAudioData(buf); })
        .then(function(decoded){
          var src = ctx.createBufferSource();
          src.buffer = decoded;
          var gain = ctx.createGain();
          gain.gain.value = vol;
          src.connect(gain);
          gain.connect(ctx.destination);
          if (ctx.state === 'suspended') ctx.resume();
          src.start(0);
        })
        .catch(function(e){
          console.warn('AudioContext falhou, tentando Audio Element:', e);
          fallbackAudio(mediaUrl, vol);
        });
    } else {
      fallbackAudio(mediaUrl, vol);
    }
  }

  function fallbackAudio(mediaUrl, vol) {
    try {
      var audio = new Audio(mediaUrl);
      audio.volume = vol;
      audio.crossOrigin = 'anonymous';
      audio.play().catch(function(e){ console.error('Erro fallback:', e); });
    } catch(e) { console.error('Erro Audio Element:', e); }
  }

  function connect() {
    var es = new EventSource('/sse/${roomId}/figurinhas');
    es.onopen = function() {
      statusEl.textContent = '🎵 Figurinhas (online)';
      statusEl.style.opacity = '0.4';
      getAudioCtx();
    };
    es.onmessage = function(e) {
      try {
        var d = JSON.parse(e.data);
        if (d.type === 'play') playSound(d.mediaUrl, d.volume);
      } catch(err) { console.error('Erro SSE:', err); }
    };
    es.onerror = function() {
      statusEl.textContent = '🎵 Reconectando...';
      es.close();
      setTimeout(connect, 3000);
    };
  }
  connect();
</script>
</body></html>`;
}

function getMusicaOverlayHTML(roomId) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:transparent; overflow:hidden; font-family:'Segoe UI',Arial,sans-serif; width:100vw; height:100vh; }
#player-wrap {
  position:fixed; left:20px; top:20px;
  width:320px; height:180px; border-radius:12px; overflow:hidden;
  box-shadow:0 8px 30px rgba(0,0,0,0.5);
  background:#000;
  display:none;
}
#player-wrap.visible { display:block; }
#player { width:100%; height:100%; }
#card {
  position:fixed; left:20px; bottom:20px;
  display:flex; align-items:center; gap:14px;
  background:rgba(10,10,12,0.92);
  border:1px solid rgba(239,68,68,0.4);
  border-radius:14px; padding:12px 18px 12px 12px;
  min-width:280px; max-width:480px;
  box-shadow:0 8px 30px rgba(0,0,0,0.5), 0 0 24px rgba(239,68,68,0.15);
  opacity:0; transform:translateY(20px);
  transition:opacity 0.4s, transform 0.4s;
  pointer-events:none;
}
#card.visible { opacity:1; transform:translateY(0); }
#cover { width:96px; height:54px; border-radius:6px; object-fit:cover; background:rgba(255,255,255,0.05); flex-shrink:0; }
#info { flex:1; min-width:0; color:#fff; }
.label { font-size:10px; font-weight:700; letter-spacing:1.2px; color:#ef4444; text-transform:uppercase; margin-bottom:3px; display:flex; align-items:center; gap:6px; }
.label .dot { width:8px; height:8px; border-radius:50%; background:#ef4444; box-shadow:0 0 8px rgba(239,68,68,0.7); animation:pulse 1.5s ease-in-out infinite; }
@keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:0.4;} }
.title { font-size:14px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.channel { font-size:12px; color:rgba(255,255,255,0.6); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.req { font-size:10px; color:#ef4444; margin-top:4px; }
</style></head>
<body>
<div id="player-wrap"><div id="player"></div></div>
<div id="card">
  <img id="cover" src="">
  <div id="info">
    <div class="label"><span class="dot"></span>Tocando agora</div>
    <div class="title" id="title">—</div>
    <div class="channel" id="channel">—</div>
    <div class="req" id="req"></div>
  </div>
</div>
<script src="https://www.youtube.com/iframe_api"></script>
<script>
  var player = null;
  var playerReady = false;
  var pendingVideoId = null;
  var currentVideoId = null;
  var currentVolume = 80;
  var card = document.getElementById('card');
  var playerWrap = document.getElementById('player-wrap');
  var cover = document.getElementById('cover');
  var titleEl = document.getElementById('title');
  var channelEl = document.getElementById('channel');
  var reqEl = document.getElementById('req');
  var hideTimer = null;

  function showCard(track, ephemeral) {
    if (!track) { card.classList.remove('visible'); return; }
    cover.src = track.thumbnail || '';
    titleEl.textContent = track.title || '—';
    channelEl.textContent = track.channel || '—';
    reqEl.textContent = track.requestedBy ? 'Pedida por @' + track.requestedBy : '';
    card.classList.add('visible');
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    hideTimer = setTimeout(function(){ card.classList.remove('visible'); }, ephemeral ? 10000 : 12000);
  }

  function applyVolume(v) {
    currentVolume = Math.max(0, Math.min(100, parseInt(v) || 0));
    if (playerReady && player) { try { player.setVolume(currentVolume); } catch(e){} }
  }

  function applyState(state) {
    if (state && typeof state.volume === 'number') applyVolume(state.volume);
    var track = state && state.currentTrack;
    if (!track) {
      currentVideoId = null;
      playerWrap.classList.remove('visible');
      card.classList.remove('visible');
      if (playerReady && player) { try { player.stopVideo(); } catch(e){} }
      return;
    }
    showCard(track, false);
    if (track.id !== currentVideoId) {
      currentVideoId = track.id;
      playerWrap.classList.add('visible');
      if (playerReady && player) {
        player.loadVideoById(track.id);
      } else {
        pendingVideoId = track.id;
      }
    }
  }

  window.onYouTubeIframeAPIReady = function() {
    player = new YT.Player('player', {
      height: '180',
      width: '320',
      videoId: '',
      playerVars: { autoplay: 1, controls: 0, modestbranding: 1, rel: 0, playsinline: 1 },
      events: {
        onReady: function(e){
          playerReady = true;
          e.target.setVolume(currentVolume);
          if (pendingVideoId) { player.loadVideoById(pendingVideoId); pendingVideoId = null; }
        },
        onStateChange: function(e){
          if (e.data === YT.PlayerState.ENDED) {
            fetch('/api/youtube-track-ended/' + ROOMID, { method:'POST' }).catch(function(){});
          }
        },
        onError: function(){
          fetch('/api/youtube-track-ended/' + ROOMID, { method:'POST' }).catch(function(){});
        }
      }
    });
  };

  var ROOMID = ${JSON.stringify(roomId)};

  function connect() {
    var es = new EventSource('/sse/' + ROOMID + '/musica');
    es.onmessage = function(e) {
      try {
        var d = JSON.parse(e.data);
        if (d.type === 'youtube-state') applyState(d);
        else if (d.type === 'youtube-volume') applyVolume(d.volume);
        else if (d.type === 'youtube-pulse' && currentVideoId) {
          showCard({ id: currentVideoId, title: titleEl.textContent, channel: channelEl.textContent, requestedBy: (reqEl.textContent.replace(/^Pedida por @/,'') || null), thumbnail: cover.src }, true);
        }
      } catch(err) {}
    };
    es.onerror = function() { es.close(); setTimeout(connect, 3000); };
  }
  connect();
</script>
</body></html>`;
}
function getTranslatorMicHTML(roomId) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<title>🎙️ Microfone do Tradutor — Live Stream INS</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;900&display=swap" rel="stylesheet">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family: 'Poppins', sans-serif;
  background: linear-gradient(135deg, #0f0a23, #1a0f3a);
  color: #fff;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.container {
  width: 100%;
  max-width: 560px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(167,139,250,0.25);
  border-radius: 20px;
  padding: 28px 26px;
  box-shadow: 0 0 60px rgba(139,92,246,0.2);
}
h1 { font-size: 22px; margin-bottom: 6px; }
.subtitle { color: rgba(255,255,255,0.55); font-size: 13px; margin-bottom: 22px; }
.status {
  display: flex; align-items: center; gap: 10px;
  background: rgba(0,0,0,0.3);
  padding: 14px 16px; border-radius: 12px;
  margin-bottom: 18px;
}
.status-dot {
  width: 12px; height: 12px; border-radius: 50%;
  background: #666; transition: background 0.3s, box-shadow 0.3s;
}
.status-dot.active { background: #10b981; box-shadow: 0 0 12px rgba(16,185,129,0.6); animation: pulse 1.5s ease-in-out infinite; }
.status-dot.error { background: #ef4444; }
@keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.5; } }
.status-text { font-size: 14px; font-weight: 600; }

.lang-row {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 16px;
}
.lang-row label { font-size: 13px; color: rgba(255,255,255,0.75); }
select {
  flex: 1; padding: 10px 12px; border-radius: 10px;
  background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1);
  color: #fff; font-size: 14px; font-family: inherit;
  cursor: pointer;
}
select:focus { outline: 1px solid #a78bfa; }

.box {
  margin-bottom: 12px;
}
.box-label {
  font-size: 10px; font-weight: 700; letter-spacing: 0.7px;
  margin-bottom: 5px; color: rgba(255,255,255,0.55);
}
.box-text {
  background: rgba(0,0,0,0.25); border-radius: 10px;
  padding: 10px 12px; min-height: 42px; font-size: 14px;
  line-height: 1.4; word-wrap: break-word;
}
.box-text.spoken { color: #fff; }
.box-text.translated { color: #e9d5ff; border: 1px solid rgba(167,139,250,0.2); }

.btn {
  width: 100%; padding: 14px; border-radius: 12px;
  background: linear-gradient(135deg, #7c3aed, #a855f7);
  color: #fff; border: none; font-size: 14px; font-weight: 700;
  cursor: pointer; font-family: inherit;
  transition: opacity 0.2s, transform 0.1s;
  margin-top: 8px;
}
.btn:hover { opacity: 0.9; }
.btn:active { transform: scale(0.98); }
.btn.stop { background: linear-gradient(135deg, #ef4444, #dc2626); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }

.note {
  font-size: 11px; color: rgba(255,255,255,0.5);
  margin-top: 16px; line-height: 1.5; text-align: center;
}
.warn {
  background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.3);
  border-radius: 10px; padding: 10px 12px; font-size: 12px;
  color: #fbbf24; margin-bottom: 14px; line-height: 1.5;
}
</style></head>
<body>
<div class="container">
  <h1>🎙️ Tradutor de Voz</h1>
  <p class="subtitle">Esta página captura sua voz e envia traduzida para o overlay do OBS.</p>

  <div class="warn">
    💡 <strong>Mantenha esta aba aberta</strong> enquanto estiver fazendo a live. Pode minimizar.
  </div>

  <div class="status">
    <div id="status-dot" class="status-dot"></div>
    <div id="status-text" class="status-text">Aguardando início...</div>
  </div>

  <div class="lang-row">
    <label>Traduzir para:</label>
    <select id="target-lang">
      <option value="it">🇮🇹 Italiano</option>
      <option value="en">🇺🇸 Inglês</option>
      <option value="es">🇪🇸 Espanhol</option>
      <option value="fr">🇫🇷 Francês</option>
      <option value="de">🇩🇪 Alemão</option>
      <option value="ja">🇯🇵 Japonês</option>
      <option value="zh">🇨🇳 Chinês</option>
      <option value="ko">🇰🇷 Coreano</option>
      <option value="ru">🇷🇺 Russo</option>
      <option value="ar">🇸🇦 Árabe</option>
      <option value="nl">🇳🇱 Holandês</option>
      <option value="pl">🇵🇱 Polonês</option>
      <option value="tr">🇹🇷 Turco</option>
    </select>
  </div>

  <div class="box">
    <div class="box-label">🎤 VOCÊ DISSE</div>
    <div id="spoken" class="box-text spoken">—</div>
  </div>

  <div class="box">
    <div class="box-label">🌐 TRADUÇÃO ENVIADA AO OVERLAY</div>
    <div id="translated" class="box-text translated">—</div>
  </div>

  <button id="btn-toggle" class="btn">🎙️ Iniciar</button>

  <div class="note">Você fala em <strong>português</strong>, o overlay mostra no idioma escolhido.<br>Permite o microfone quando o navegador pedir.</div>
</div>

<script>
  const ROOM_ID = '${roomId}';
  const PUSH_URL = '/api/translator-push/' + ROOM_ID;

  // Aplicar idioma da URL se foi passado
  const params = new URLSearchParams(window.location.search);
  const urlLang = params.get('lang');
  if (urlLang) {
    const opt = document.querySelector('#target-lang option[value="' + urlLang + '"]');
    if (opt) document.getElementById('target-lang').value = urlLang;
  }

  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const spokenEl = document.getElementById('spoken');
  const translatedEl = document.getElementById('translated');
  const langSelect = document.getElementById('target-lang');
  const btnToggle = document.getElementById('btn-toggle');

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    statusDot.classList.add('error');
    statusText.textContent = 'Navegador sem suporte — use Chrome/Edge';
    btnToggle.disabled = true;
  }

  let recognition = null;
  let active = false;
  let inFlight = 0;
  let pendingTimer = null;
  let lastTranslatedSource = '';

  async function translate(text, target) {
    try {
      const target2 = (target || 'it').split('-')[0];
      // Email param extends free quota de 1000 para 10000 palavras/dia (MyMemory)
      const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=pt-BR|' + target2 + '&de=app@livestreamins.com';
      const r = await fetch(url);
      const d = await r.json();
      return (d && d.responseData && d.responseData.translatedText) || '';
    } catch(e) { console.error('translate err:', e); return ''; }
  }

  function pushToOverlay(text) {
    // Não usar await — disparar e seguir (reduz latência)
    fetch(PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      keepalive: true
    }).catch(e => console.error('push err:', e));
  }

  async function translateAndPush(text) {
    if (!text || text === lastTranslatedSource) return;
    lastTranslatedSource = text;
    const myId = ++inFlight;
    const translated = await translate(text, langSelect.value);
    if (myId !== inFlight) return;
    if (translated) {
      translatedEl.textContent = translated;
      pushToOverlay(translated);
    }
  }

  function startRecognition() {
    recognition = new SR();
    recognition.lang = 'pt-BR';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      active = true;
      statusDot.classList.add('active');
      statusDot.classList.remove('error');
      statusText.textContent = 'Ouvindo... fale em português';
      btnToggle.textContent = '⏹️ Parar';
      btnToggle.classList.add('stop');
    };

    recognition.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += t;
        else interim += t;
      }
      const displayText = (final + ' ' + interim).trim();
      spokenEl.textContent = displayText || '—';

      // Cancelar debounce anterior se houver
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }

      // Final result → tradução IMEDIATA, sem debounce
      const finalTrim = final.trim();
      if (finalTrim) {
        translateAndPush(finalTrim);
        return;
      }

      // Interim result → tradução em tempo real com debounce curto (300ms)
      const interimTrim = interim.trim();
      if (interimTrim && interimTrim.length >= 2) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          translateAndPush(interimTrim);
        }, 300);
      }
    };

    recognition.onerror = (e) => {
      console.error('SR error:', e.error);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        statusDot.classList.add('error');
        statusText.textContent = 'Permissão de microfone negada';
        stop();
      } else if (e.error === 'no-speech') {
        // silencioso — apenas continua
      } else if (e.error === 'network') {
        statusText.textContent = 'Erro de rede — verifique sua conexão';
      } else {
        statusText.textContent = 'Erro: ' + e.error;
      }
    };

    recognition.onend = () => {
      if (active) {
        try { recognition.start(); } catch(e) {
          setTimeout(() => { if (active) { try { recognition.start(); } catch(_) {} } }, 300);
        }
      }
    };

    try {
      recognition.start();
    } catch(e) {
      statusText.textContent = 'Erro: ' + e.message;
      statusDot.classList.add('error');
    }
  }

  function stop() {
    active = false;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (recognition) {
      try { recognition.stop(); } catch(e) {}
      recognition = null;
    }
    statusDot.classList.remove('active');
    statusText.textContent = 'Parado';
    btnToggle.textContent = '🎙️ Iniciar';
    btnToggle.classList.remove('stop');
    lastTranslatedSource = '';
    pushToOverlay(''); // limpa o overlay
  }

  btnToggle.addEventListener('click', () => {
    if (active) stop();
    else startRecognition();
  });

  // Canal de controle remoto — recebe toggle vindo da tecla de atalho do app
  function connectControlChannel() {
    var es = new EventSource('/sse/' + ROOM_ID + '/translator-mic-control');
    es.onmessage = function(e) {
      try {
        var d = JSON.parse(e.data);
        if (d.type === 'toggle') {
          if (active) stop(); else startRecognition();
        }
      } catch(err) {}
    };
    es.onerror = function() { es.close(); setTimeout(connectControlChannel, 3000); };
  }
  connectControlChannel();

  // Limpar overlay ao fechar a aba
  window.addEventListener('beforeunload', () => {
    if (active) {
      navigator.sendBeacon(PUSH_URL, JSON.stringify({ text: '' }));
    }
  });
</script>
</body></html>`;
}

// START SERVER
// ============================================
connectMongo().then(() => {
  server.listen(PORT, () => {
    console.log(`TikTok Live Relay running on port ${PORT}`);
  });
});
