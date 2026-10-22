const express = require('express');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const crypto = require('crypto');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } 
});

app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/scanner.html', (req, res) => res.sendFile(path.join(__dirname, 'scanner.html')));
app.get('/volunteer.html', (req, res) => res.sendFile(path.join(__dirname, 'volunteer.html')));
app.get('/tracker.html', (req, res) => res.sendFile(path.join(__dirname, 'tracker.html')));
app.get('/display.html', (req, res) => res.sendFile(path.join(__dirname, 'display.html')));

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendees (
      id SERIAL PRIMARY KEY,
      ticket_id TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      dob TEXT NOT NULL,
      institution TEXT NOT NULL,
      team_size TEXT NOT NULL,
      team_name TEXT,
      member2_name TEXT,
      member3_name TEXT,
      github_link TEXT,
      itchio_link TEXT,
      registered_at TEXT NOT NULL,
      checked_in INTEGER DEFAULT 0,
      checked_in_at TEXT
    );
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS volunteers (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      department TEXT NOT NULL,
      registered_at TEXT NOT NULL
    );
  `);

  try { await pool.query('ALTER TABLE volunteers ADD COLUMN address TEXT'); } catch(e){}
  try { await pool.query('ALTER TABLE volunteers ADD COLUMN github_link TEXT'); } catch(e){}
  try { await pool.query('ALTER TABLE volunteers ADD COLUMN itchio_link TEXT'); } catch(e){}
  try { await pool.query('ALTER TABLE volunteers ADD COLUMN checked_in INTEGER DEFAULT 0'); } catch(e){}
  try { await pool.query('ALTER TABLE volunteers ADD COLUMN checked_in_at TEXT'); } catch(e){}
  try { await pool.query("ALTER TABLE volunteers ADD COLUMN status TEXT DEFAULT 'ACTIVE'"); } catch(e){}
  try { await pool.query("ALTER TABLE volunteers ADD COLUMN cancel_reason TEXT"); } catch(e){}
  try { await pool.query("ALTER TABLE attendees ADD COLUMN status TEXT DEFAULT 'ACTIVE'"); } catch(e){}
  try { await pool.query("ALTER TABLE attendees ADD COLUMN cancel_reason TEXT"); } catch(e){}
  try { await pool.query("ALTER TABLE attendees ADD COLUMN timer_state TEXT DEFAULT 'STOPPED'"); } catch(e){}
  try { await pool.query("ALTER TABLE attendees ADD COLUMN elapsed_time INTEGER DEFAULT 0"); } catch(e){}
  try { await pool.query("ALTER TABLE attendees ADD COLUMN timer_last_updated TEXT"); } catch(e){}
  try { await pool.query('ALTER TABLE attendees ADD COLUMN checked_out INTEGER DEFAULT 0'); } catch(e){}
  try { await pool.query('ALTER TABLE attendees ADD COLUMN checked_out_at TEXT'); } catch(e){}
  try { await pool.query('ALTER TABLE attendees ADD COLUMN checkout_remark TEXT'); } catch(e){}
  try { await pool.query('ALTER TABLE volunteers ADD COLUMN checked_out INTEGER DEFAULT 0'); } catch(e){}
  try { await pool.query('ALTER TABLE volunteers ADD COLUMN checked_out_at TEXT'); } catch(e){}
  try { await pool.query('ALTER TABLE volunteers ADD COLUMN checkout_remark TEXT'); } catch(e){}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY,
      reg_deadline TEXT NOT NULL,
      scan_date TEXT NOT NULL
    );
  `);

  const hasSettings = await pool.query('SELECT * FROM settings WHERE id = 1');
  if (hasSettings.rowCount === 0) {
    await pool.query('INSERT INTO settings (id, reg_deadline, scan_date) VALUES (1, $1, $2)', ['2026-10-13T23:59', '2026-10-23']);
  }
}
initDB();

const ADMIN_USERS = [
  { email: 'admin@qryvon.com', password: 'sync2026admin' },
  { email: 'nikunj@qryvon.com', password: 'sync2026nikunj' },
  { email: 'aditya@qryvon.com', password: 'sync2026aditya' }
];
const ADMIN_TOKEN = 'qryvon-secure-token-2026';
const otpStore = new Map();

app.get('/api/public/display', async (req, res) => {
  try {
    const attRes = await pool.query("SELECT team_name, full_name, team_size FROM attendees WHERE checked_in = 1 AND checked_out = 0 AND status != 'CANCELLED' ORDER BY id DESC");
    const volRes = await pool.query("SELECT COUNT(*) FROM volunteers WHERE checked_in = 1 AND checked_out = 0 AND status != 'CANCELLED'");
    const setRes = await pool.query('SELECT reg_deadline FROM settings WHERE id = 1');
    let rawDeadline = setRes.rows[0].reg_deadline;
    if (!rawDeadline.includes('+') && !rawDeadline.includes('Z')) rawDeadline = (rawDeadline.length === 16 ? rawDeadline + ':00' : rawDeadline) + '+05:30';
    const teams = attRes.rows.map(a => a.team_size === 'solo' ? a.full_name : a.team_name);
    const totalActive = attRes.rowCount + parseInt(volRes.rows[0].count);
    res.json({ teams, totalActive, deadline: rawDeadline });
  } catch(err) { res.status(500).json({ error: 'Display data fetch failed' }); }
});

app.get('/api/settings', async (req, res) => {
  const result = await pool.query('SELECT * FROM settings WHERE id = 1');
  res.json(result.rows[0]);
});

app.post('/api/admin/settings', async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  const { reg_deadline, scan_date } = req.body;
  if (!reg_deadline || !scan_date) return res.status(400).json({ error: 'Missing date values' });
  try {
    await pool.query(`INSERT INTO settings (id, reg_deadline, scan_date) VALUES (1, $1, $2) ON CONFLICT (id) DO UPDATE SET reg_deadline = EXCLUDED.reg_deadline, scan_date = EXCLUDED.scan_date;`, [reg_deadline, scan_date]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Database update failed' }); }
});

app.post('/api/send-otp', async (req, res) => {
  const { email, role } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const safeEmail = email.toLowerCase().trim();
  let existing = role === 'volunteer' ? await pool.query('SELECT id FROM volunteers WHERE email = $1', [safeEmail]) : await pool.query('SELECT id FROM attendees WHERE email = $1', [safeEmail]);
  if (existing.rowCount > 0) return res.status(400).json({ error: 'Email already registered.' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore.set(safeEmail, { otp, expires: Date.now() + 10 * 60000 });

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'accept': 'application/json', 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: "Qryvon Sync", email: "contact.qryvon@gmail.com" },
        to: [{ email: email }],
        subject: "Qryvon Sync Registration OTP",
        htmlContent: `<h3>Welcome to Qryvon Sync '26!</h3><p>Your verification OTP is: <strong>${otp}</strong>. It expires in 10 minutes.</p>`
      })
    });
    if (response.ok) res.json({ success: true });
    else throw new Error('API Failed');
  } catch (error) { res.status(500).json({ error: 'Failed to send OTP.' }); }
});

app.get('/api/status', async (req, res) => {
  try {
    const result = await pool.query('SELECT reg_deadline FROM settings WHERE id = 1');
    if (result.rowCount === 0) return res.json({ isOpen: true });
    let rawDeadline = result.rows[0].reg_deadline;
    if (!rawDeadline.includes('+') && !rawDeadline.includes('Z')) rawDeadline = (rawDeadline.length === 16 ? rawDeadline + ':00' : rawDeadline) + '+05:30';
    res.json({ isOpen: Date.now() <= new Date(rawDeadline).getTime() });
  } catch (err) { res.status(500).json({ error: 'Status check failed' }); }
});

app.post('/api/register', async (req, res) => {
  const setRes = await pool.query('SELECT reg_deadline FROM settings WHERE id = 1');
  const deadlineMs = new Date(setRes.rows[0].reg_deadline + ':00+05:30').getTime();
  if (Date.now() > deadlineMs) return res.status(403).json({ error: 'Registrations are closed.' });

  const { full_name, email, phone, dob, institution, team_size, team_name, member2_name, member3_name, github_link, itchio_link, otp } = req.body;
  const safeEmail = email.trim().toLowerCase();
  const record = otpStore.get(safeEmail);
  if (!record || record.otp !== otp || Date.now() > record.expires) return res.status(400).json({ error: 'Invalid or expired OTP.' });

  const ticket_id = 'SYNC-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  try {
    await pool.query(`INSERT INTO attendees (ticket_id, full_name, email, phone, dob, institution, team_size, team_name, member2_name, member3_name, github_link, itchio_link, registered_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`, [ticket_id, full_name.trim(), safeEmail, phone.trim(), dob, institution.trim(), team_size, (team_name || '').trim(), (member2_name || '').trim(), (member3_name || '').trim(), (github_link || '').trim(), (itchio_link || '').trim(), new Date().toISOString()]);
    otpStore.delete(safeEmail);
    const qrDataUrl = await QRCode.toDataURL(ticket_id, { errorCorrectionLevel: 'H', margin: 2, width: 320, color: { dark: '#0A1F18', light: '#E6E6FA' } });
    res.json({ success: true, ticket_id, qrDataUrl, attendee: { full_name, team_name } });
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/volunteer/register', async (req, res) => {
  const { full_name, email, phone, department, address, github_link, itchio_link, otp } = req.body;
  const safeEmail = email.trim().toLowerCase();
  const record = otpStore.get(safeEmail);
  if (!record || record.otp !== otp || Date.now() > record.expires) return res.status(400).json({ error: 'Invalid or expired OTP.' });

  try {
    const existing = await pool.query('SELECT id FROM volunteers WHERE email = $1', [safeEmail]);
    if (existing.rowCount > 0) return res.status(400).json({ error: 'Email already registered as volunteer.' });

    await pool.query(`INSERT INTO volunteers (full_name, email, phone, department, address, github_link, itchio_link, registered_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [full_name.trim(), safeEmail, phone.trim(), department.trim(), (address || '').trim(), (github_link || '').trim(), (itchio_link || '').trim(), new Date().toISOString()]);
    otpStore.delete(safeEmail);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/admin/login', (req, res) => {
  const user = ADMIN_USERS.find(u => u.email === req.body.email && u.password === req.body.password);
  if (user) res.json({ success: true, token: ADMIN_TOKEN });
  else res.status(401).json({ error: 'Invalid credentials' });
});

// NEW: Broadcast Announcment Route
app.post('/api/admin/broadcast', async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  const { target, subject, message } = req.body;

  try {
    let emails = [];
    if (target === 'all' || target === 'attendees') {
      const att = await pool.query("SELECT email FROM attendees WHERE status != 'CANCELLED'");
      emails = emails.concat(att.rows.map(r => ({ email: r.email })));
    }
    if (target === 'all' || target === 'volunteers') {
      const vol = await pool.query("SELECT email FROM volunteers WHERE status != 'CANCELLED'");
      emails = emails.concat(vol.rows.map(r => ({ email: r.email })));
    }

    if (emails.length === 0) return res.status(400).json({ error: 'No active users found.' });

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'accept': 'application/json', 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: "Qryvon Sync Team", email: "contact.qryvon@gmail.com" },
        to: [{ email: "contact.qryvon@gmail.com", name: "Qryvon Participants" }],
        bcc: emails,
        subject: subject,
        htmlContent: `<div style="font-family:sans-serif; padding:20px; color:#333;">
          <h2 style="color:#0A1F18;">Qryvon Sync '26 Update</h2>
          <div style="font-size:16px; line-height:1.5;">${message.replace(/\n/g, '<br>')}</div>
        </div>`
      })
    });

    if (response.ok) res.json({ success: true, count: emails.length });
    else throw new Error('Brevo API Failed');
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Broadcast dispatch failed' });
  }
});

app.post('/api/admin/manual-checkin', async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  const { ticket_id } = req.body;
  try {
    const checkinTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    await pool.query('UPDATE attendees SET checked_in = 1, checked_in_at = $1 WHERE ticket_id = $2', [checkinTime, ticket_id.trim().toUpperCase()]);
    res.json({ success: true, checked_in_at: checkinTime });
  } catch(err) { res.status(500).json({ error: 'Check-in failed' }); }
});

app.post('/api/admin/attendee-checkout', async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  const { ticket_id, remark } = req.body;
  try {
    const checkoutTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    await pool.query('UPDATE attendees SET checked_out = 1, checked_out_at = $1, checkout_remark = $2 WHERE ticket_id = $3', [checkoutTime, remark, ticket_id.trim().toUpperCase()]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: 'Checkout failed' }); }
});

app.post('/api/admin/cancel', async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  const { ticket_id, reason } = req.body;
  try {
    await pool.query("UPDATE attendees SET status = 'CANCELLED', cancel_reason = $1 WHERE ticket_id = $2", [reason, ticket_id.trim().toUpperCase()]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: 'Cancellation failed' }); }
});

app.post('/api/admin/volunteer-checkin', async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  const { email } = req.body;
  try {
    const checkinTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    await pool.query('UPDATE volunteers SET checked_in = 1, checked_in_at = $1 WHERE email = $2', [checkinTime, email.trim().toLowerCase()]);
    res.json({ success: true, checked_in_at: checkinTime });
  } catch(err) { res.status(500).json({ error: 'Check-in failed' }); }
});

app.post('/api/admin/volunteer-checkout', async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  const { email, remark } = req.body;
  try {
    const checkoutTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    await pool.query('UPDATE volunteers SET checked_out = 1, checked_out_at = $1, checkout_remark = $2 WHERE email = $3', [checkoutTime, remark, email.trim().toLowerCase()]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: 'Checkout failed' }); }
});

app.post('/api/admin/volunteer-cancel', async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  const { email, reason } = req.body;
  try {
    await pool.query("UPDATE volunteers SET status = 'CANCELLED', cancel_reason = $1 WHERE email = $2", [reason, email.trim().toLowerCase()]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: 'Cancellation failed' }); }
});

app.post('/api/admin/timer', async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  const { ticket_id, action } = req.body; 
  try {
    const att = await pool.query('SELECT timer_state, elapsed_time, timer_last_updated FROM attendees WHERE ticket_id = $1', [ticket_id]);
    if (att.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    let { timer_state, elapsed_time, timer_last_updated } = att.rows[0];
    const now = Date.now();
    if ((action === 'start' || action === 'resume') && (timer_state === 'STOPPED' || timer_state === 'PAUSED')) {
      await pool.query("UPDATE attendees SET timer_state = 'RUNNING', timer_last_updated = $1 WHERE ticket_id = $2", [now.toString(), ticket_id]);
    } else if ((action === 'pause' || action === 'stop') && timer_state === 'RUNNING') {
      const timePassed = Math.floor((now - parseInt(timer_last_updated)) / 1000);
      const newElapsed = (elapsed_time || 0) + timePassed;
      const newState = action === 'pause' ? 'PAUSED' : 'STOPPED';
      await pool.query("UPDATE attendees SET timer_state = $1, elapsed_time = $2, timer_last_updated = $3 WHERE ticket_id = $4", [newState, newElapsed, now.toString(), ticket_id]);
    }
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: 'Timer error' }); }
});

app.post('/api/verify', async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Admin Login Required' });
  const setRes = await pool.query('SELECT scan_date FROM settings WHERE id = 1');
  const todayIST = new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0];
  if (todayIST !== setRes.rows[0].scan_date) return res.status(403).json({ status: 'INVALID', message: `Scans locked. Event date is set to ${setRes.rows[0].scan_date}.` });

  const attRes = await pool.query('SELECT * FROM attendees WHERE ticket_id = $1', [req.body.ticket_id?.trim().toUpperCase()]);
  if (attRes.rowCount === 0) return res.status(404).json({ status: 'INVALID', message: 'Ticket Not Found!' });
  const attendee = attRes.rows[0];
  if (attendee.status === 'CANCELLED') return res.status(403).json({ status: 'INVALID', message: 'This ticket has been cancelled.' });
  if (attendee.checked_out === 1) return res.status(403).json({ status: 'INVALID', message: 'Pass already checked out.' });
  if (attendee.checked_in === 1) return res.json({ status: 'ALREADY_USED', message: 'Pass already redeemed!', checked_in_at: attendee.checked_in_at, attendee });

  const checkinTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  await pool.query('UPDATE attendees SET checked_in = 1, checked_in_at = $1 WHERE ticket_id = $2', [checkinTime, attendee.ticket_id]);
  res.json({ status: 'VALID', message: 'Check-in Verified!', checked_in_at: checkinTime, attendee: { ...attendee, checked_in: 1, checked_in_at: checkinTime } });
});

app.get('/api/admin/data', async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  const result = await pool.query('SELECT * FROM attendees ORDER BY id DESC');
  res.json({ attendees: result.rows });
});

app.get('/api/admin/volunteers', async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  const result = await pool.query('SELECT * FROM volunteers ORDER BY id DESC');
  res.json({ volunteers: result.rows });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
