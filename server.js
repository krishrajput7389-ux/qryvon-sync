const express = require('express');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const crypto = require('crypto');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();

// PostgreSQL Connection (Secure for Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } 
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize PostgreSQL Tables
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

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: 'contact.qryvon@gmail.com', pass: process.env.EMAIL_PASS }
});

const otpStore = new Map();

// --- ALL ROUTES ---
app.get('/api/settings', async (req, res) => {
  const result = await pool.query('SELECT * FROM settings WHERE id = 1');
  res.json(result.rows[0]);
});

app.post('/api/admin/settings', async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  const { reg_deadline, scan_date } = req.body;
  await pool.query('UPDATE settings SET reg_deadline = $1, scan_date = $2 WHERE id = 1', [reg_deadline, scan_date]);
  res.json({ success: true });
});

app.get('/api/status', async (req, res) => {
  const result = await pool.query('SELECT reg_deadline FROM settings WHERE id = 1');
  const deadlineMs = new Date(result.rows[0].reg_deadline + ':00+05:30').getTime();
  res.json({ isOpen: Date.now() <= deadlineMs });
});

app.post('/api/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  
  const existing = await pool.query('SELECT id FROM attendees WHERE email = $1', [email.toLowerCase().trim()]);
  if (existing.rowCount > 0) return res.status(400).json({ error: 'Email already registered.' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore.set(email.toLowerCase().trim(), { otp, expires: Date.now() + 10 * 60000 });

  try {
    await transporter.sendMail({
      from: '"Qryvon Sync" <contact.qryvon@gmail.com>',
      to: email,
      subject: 'Qryvon Sync Registration OTP',
      text: `Your OTP is: ${otp}. It expires in 10 minutes.`,
      html: `<h3>We see you. Your Qryvon Sync '26 registration is one step away from being locked in.👾 Drop this into the portal before it expires in 10 minutes to secure your spot. See you at the hackathon!🎊<strong>${otp}</strong></p>`
    });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: 'Failed to send OTP.' }); }
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
  const registered_at = new Date().toISOString();

  try {
    await pool.query(`
      INSERT INTO attendees (ticket_id, full_name, email, phone, dob, institution, team_size, team_name, member2_name, member3_name, github_link, itchio_link, registered_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `, [ticket_id, full_name.trim(), safeEmail, phone.trim(), dob, institution.trim(), team_size, (team_name || '').trim(), (member2_name || '').trim(), (member3_name || '').trim(), (github_link || '').trim(), (itchio_link || '').trim(), registered_at]);
    
    otpStore.delete(safeEmail);
    const qrDataUrl = await QRCode.toDataURL(ticket_id, { errorCorrectionLevel: 'H', margin: 2, width: 320, color: { dark: '#0A1F18', light: '#E6E6FA' } });
    res.json({ success: true, ticket_id, qrDataUrl, attendee: { full_name, team_name } });
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/admin/login', (req, res) => {
  const user = ADMIN_USERS.find(u => u.email === req.body.email && u.password === req.body.password);
  if (user) res.json({ success: true, token: ADMIN_TOKEN });
  else res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/verify', async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Admin Login Required' });

  const setRes = await pool.query('SELECT scan_date FROM settings WHERE id = 1');
  const todayIST = new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0];
  
  if (todayIST !== setRes.rows[0].scan_date) {
    return res.status(403).json({ status: 'INVALID', message: `Scans locked. Event date is set to ${setRes.rows[0].scan_date}.` });
  }

  const attRes = await pool.query('SELECT * FROM attendees WHERE ticket_id = $1', [req.body.ticket_id?.trim().toUpperCase()]);
  if (attRes.rowCount === 0) return res.status(404).json({ status: 'INVALID', message: 'Ticket Not Found!' });
  
  const attendee = attRes.rows[0];
  if (attendee.checked_in === 1) return res.json({ status: 'ALREADY_USED', message: 'Pass already redeemed!', checked_in_at: attendee.checked_in_at, attendee });

  const checkinTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  await pool.query('UPDATE attendees SET checked_in = 1, checked_in_at = $1 WHERE ticket_id = $2', [checkinTime, attendee.ticket_id]);
  res.json({ status: 'VALID', message: 'Check-in Verified!', checked_in_at: checkinTime, attendee: { ...attendee, checked_in: 1, checked_in_at: checkinTime } });
});

app.get('/api/admin/data', async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  const result = await pool.query('SELECT * FROM attendees ORDER BY id DESC');
  const attendees = result.rows;
  res.json({ total: attendees.length, checkedIn: attendees.filter(a => a.checked_in === 1).length, pending: attendees.length - attendees.filter(a => a.checked_in === 1).length, attendees });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));