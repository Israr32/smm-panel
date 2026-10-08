/** routes/auth.js — signup, login, logout. */
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');

const router = express.Router();

router.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('signup', { flash: require('../middleware').flash(req) });
});

router.post('/signup', (req, res) => {
  const username = (req.body.username || '').trim();
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';

  if (username.length < 3 || username.length > 32) {
    req.session.flash = { type: 'error', text: 'Username must be 3–32 characters.' };
    return res.redirect('/signup');
  }
  if (password.length < 6) {
    req.session.flash = { type: 'error', text: 'Password must be at least 6 characters.' };
    return res.redirect('/signup');
  }
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    req.session.flash = { type: 'error', text: 'That username is already taken.' };
    return res.redirect('/signup');
  }

  // First-ever admin: if no admin exists yet, the first signup becomes admin.
  const adminExists = db.prepare('SELECT id FROM users WHERE is_admin = 1').get();
  const isAdmin = adminExists ? 0 : 1;

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (username, email, password_hash, balance, is_admin) VALUES (?, ?, ?, 0, ?)')
    .run(username, email || null, hash, isAdmin);

  req.session.userId = info.lastInsertRowid;
  req.session.flash = {
    type: 'success',
    text: isAdmin ? 'Welcome, owner! Your admin account is ready.' : 'Account created. Welcome!',
  };
  res.redirect('/dashboard');
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('login', { flash: require('../middleware').flash(req) });
});

router.post('/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    req.session.flash = { type: 'error', text: 'Invalid username or password.' };
    return res.redirect('/login');
  }
  req.session.userId = user.id;
  res.redirect(user.is_admin === 1 ? '/admin' : '/dashboard');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
