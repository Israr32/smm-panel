/** middleware.js — auth guards + shared view locals. */
const { db } = require('./db');

/** Load the logged-in user (if any) onto req/res for every request. */
function loadUser(req, res, next) {
  res.locals.user = null;
  res.locals.isAdmin = false;
  if (req.session && req.session.userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (user) {
      req.user = user;
      res.locals.user = user;
      res.locals.isAdmin = user.is_admin === 1;
    } else {
      delete req.session.userId; // stale session
    }
  }
  next();
}

/** Redirect anonymous visitors to the login page. */
function requireLogin(req, res, next) {
  if (!req.user) {
    req.session.flash = { type: 'error', text: 'Please log in first.' };
    return res.redirect('/login');
  }
  next();
}

/** Admin-only pages. Assumes requireLogin ran first (or checks itself). */
function requireAdmin(req, res, next) {
  if (!req.user) {
    req.session.flash = { type: 'error', text: 'Please log in first.' };
    return res.redirect('/login');
  }
  if (req.user.is_admin !== 1) {
    req.session.flash = { type: 'error', text: 'Admin access required.' };
    return res.redirect('/dashboard');
  }
  next();
}

/** One-time flash message shown on the next rendered page. */
function flash(req) {
  const f = req.session.flash || null;
  delete req.session.flash;
  return f;
}

module.exports = { loadUser, requireLogin, requireAdmin, flash };
