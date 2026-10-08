/**
 * server.js — SMM Panel entry point.
 *
 * Run locally:   npm install && npm start
 * Deploy:        see README.md (Render free tier via GitHub).
 *
 * Env vars:
 *   PORT            (Render sets this automatically)
 *   SESSION_SECRET  (required in production — long random string)
 *   DB_PATH         (default ./data/panel.db)
 *   ADMIN_USERNAME / ADMIN_PASSWORD  (seed owner account on first boot)
 *   SYNC_INTERVAL_MINUTES            (background provider status sync; default 10, 0 = off)
 */
require('dotenv').config();

const path = require('path');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const { db, ensureAdminFromEnv, seedDemoServices } = require('./db');
const { loadUser } = require('./middleware');
const { flash } = require('./middleware');

const app = express();

// ---- view engine & static files -------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(expressLayouts); // enables layout.ejs with <%- body %>
app.set('layout', 'layout');
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: false }));

// Trust Render's proxy so secure cookies work behind HTTPS.
app.set('trust proxy', 1);

// ---- sessions --------------------------------------------------------------
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';
if (!process.env.SESSION_SECRET) {
  console.warn('[warn] SESSION_SECRET not set — using insecure dev default. Set it in production!');
}
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
    // NOTE: default MemoryStore is fine for a small panel, but sessions are
    // lost on restart. On Render free tier the whole DB is ephemeral anyway.
  })
);

app.use(loadUser);

// ---- routes ----------------------------------------------------------------
// Health check FIRST: must stay public (Render pings it). The user router
// below redirects anonymous traffic to /login, so /health must precede it.
app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/user'));
const { router: adminRouter, syncOrderStatuses } = require('./routes/admin');
app.use('/admin', adminRouter);

app.get('/', (req, res) => {
  if (req.user) return res.redirect(req.user.is_admin === 1 ? '/admin' : '/dashboard');
  res.redirect('/login');
});

// 404
app.use((req, res) => {
  res.status(404).render('404', { flash: flash(req) });
});

// ---- boot ------------------------------------------------------------------
ensureAdminFromEnv();
seedDemoServices();

// Background provider status sync: keeps order statuses fresh without clicks.
const SYNC_MIN = parseInt(process.env.SYNC_INTERVAL_MINUTES || '10', 10);
if (SYNC_MIN > 0) {
  setInterval(async () => {
    try {
      const r = await syncOrderStatuses();
      if (r.updated > 0) console.log(`[sync] updated ${r.updated} order(s)`);
    } catch (err) {
      console.error('[sync] failed:', err.message);
    }
  }, SYNC_MIN * 60 * 1000);
  console.log(`[info] provider status sync every ${SYNC_MIN} min`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[info] SMM panel listening on port ${PORT}`);
});

module.exports = app; // exported for tests
