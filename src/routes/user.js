/** routes/user.js — customer-facing pages: dashboard, services, orders, funds, tickets. */
const express = require('express');
const { db } = require('../db');
const { requireLogin, flash } = require('../middleware');
const { clientFromSettings } = require('../provider');

const router = express.Router();
router.use(requireLogin);

/** Helper: fresh balance from DB (never trust a cached copy). */
function balanceOf(userId) {
  return db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;
}

/* ---------------- Dashboard ---------------- */
router.get('/dashboard', (req, res) => {
  const stats = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status IN ('pending','processing','in_progress') THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
       FROM orders WHERE user_id = ?`
    )
    .get(req.user.id);
  const spent = db
    .prepare(`SELECT COALESCE(SUM(-amount), 0) AS spent FROM transactions WHERE user_id = ? AND type = 'order'`)
    .get(req.user.id).spent;
  const recent = db
    .prepare(
      `SELECT o.*, s.name AS service_name FROM orders o
       JOIN services s ON s.id = o.service_id
       WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 5`
    )
    .all(req.user.id);
  res.render('dashboard', { flash: flash(req), stats, spent, recent, balance: balanceOf(req.user.id) });
});

/* ---------------- Services catalog ---------------- */
router.get('/services', (req, res) => {
  const services = db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY platform, name').all();
  res.render('services', { flash: flash(req), services, balance: balanceOf(req.user.id) });
});

/* ---------------- New order ---------------- */
router.get('/order/new', (req, res) => {
  const services = db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY platform, name').all();
  const preselected = parseInt(req.query.service, 10) || null;
  res.render('new-order', { flash: flash(req), services, preselected, balance: balanceOf(req.user.id) });
});

router.post('/order/new', async (req, res) => {
  const serviceId = parseInt(req.body.service_id, 10);
  const link = (req.body.link || '').trim();
  const quantity = parseInt(req.body.quantity, 10);

  const service = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(serviceId);
  if (!service) {
    req.session.flash = { type: 'error', text: 'Please choose a valid service.' };
    return res.redirect('/order/new');
  }
  if (!/^https?:\/\/.+\..+/.test(link)) {
    req.session.flash = { type: 'error', text: 'Please enter a valid link starting with http(s)://.' };
    return res.redirect('/order/new');
  }
  if (!Number.isInteger(quantity) || quantity < service.min_qty || quantity > service.max_qty) {
    req.session.flash = { type: 'error', text: `Quantity must be between ${service.min_qty} and ${service.max_qty}.` };
    return res.redirect('/order/new');
  }

  const charge = Math.round((service.rate * quantity) / 1000 * 100) / 100;
  const currentBalance = balanceOf(req.user.id);
  if (currentBalance < charge) {
    req.session.flash = { type: 'error', text: `Insufficient balance. Need $${charge.toFixed(2)}, you have $${currentBalance.toFixed(2)}.` };
    return res.redirect('/order/new');
  }

  // Deduct balance + create order atomically.
  const orderId = db.transaction(() => {
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(charge, req.user.id);
    const newBalance = balanceOf(req.user.id);
    db.prepare(
      `INSERT INTO transactions (user_id, type, amount, balance_after, note)
       VALUES (?, 'order', ?, ?, ?)`
    ).run(req.user.id, -charge, newBalance, `Order for ${service.name} x${quantity}`);
    return db
      .prepare(
        `INSERT INTO orders (user_id, service_id, link, quantity, charge)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(req.user.id, service.id, link, quantity, charge).lastInsertRowid;
  })();

  // Forward to the wholesale provider (if this service is linked and provider is configured).
  let forwarded = false;
  let forwardError = null;
  if (service.provider_service_id) {
    const settings = db.prepare('SELECT * FROM provider_settings WHERE id = 1').get();
    const client = clientFromSettings(settings);
    if (client) {
      try {
        const result = await client.addOrder(service.provider_service_id, link, quantity);
        db.prepare(
          `UPDATE orders SET provider_order_id = ?, status = 'processing', updated_at = datetime('now') WHERE id = ?`
        ).run(String(result.order), orderId);
        forwarded = true;
      } catch (err) {
        forwardError = err.message;
        db.prepare(`UPDATE orders SET last_error = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(forwardError, orderId);
      }
    } else {
      forwardError = 'Provider not configured';
      db.prepare(`UPDATE orders SET last_error = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(forwardError, orderId);
    }
  }

  req.session.flash = {
    type: 'success',
    text: forwarded
      ? `Order #${orderId} placed and sent to provider. Charge: $${charge.toFixed(2)}.`
      : `Order #${orderId} placed. Charge: $${charge.toFixed(2)}.${forwardError ? ' Provider forwarding pending (' + forwardError + ').' : ''}`,
  };
  res.redirect('/orders');
});

/* ---------------- Orders ---------------- */
router.get('/orders', (req, res) => {
  const orders = db
    .prepare(
      `SELECT o.*, s.name AS service_name FROM orders o
       JOIN services s ON s.id = o.service_id
       WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 200`
    )
    .all(req.user.id);
  res.render('orders', { flash: flash(req), orders });
});

/* ---------------- Funds ---------------- */
router.get('/funds', (req, res) => {
  const requests = db
    .prepare('SELECT * FROM fund_requests WHERE user_id = ? ORDER BY id DESC LIMIT 50')
    .all(req.user.id);
  const transactions = db
    .prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 50')
    .all(req.user.id);
  res.render('funds', { flash: flash(req), requests, transactions, balance: balanceOf(req.user.id) });
});

router.post('/funds/request', (req, res) => {
  const amount = Math.round(parseFloat(req.body.amount) * 100) / 100;
  const method = (req.body.method || '').trim().slice(0, 60);
  const note = (req.body.note || '').trim().slice(0, 300);
  if (!Number.isFinite(amount) || amount <= 0) {
    req.session.flash = { type: 'error', text: 'Enter a valid amount.' };
    return res.redirect('/funds');
  }
  db.prepare('INSERT INTO fund_requests (user_id, amount, method, note) VALUES (?, ?, ?, ?)')
    .run(req.user.id, amount, method || null, note || null);
  req.session.flash = { type: 'success', text: `Fund request for $${amount.toFixed(2)} submitted. Admin will review it.` };
  res.redirect('/funds');
});

/* ---------------- Support tickets ---------------- */
router.get('/tickets', (req, res) => {
  const tickets = db
    .prepare('SELECT * FROM tickets WHERE user_id = ? ORDER BY updated_at DESC')
    .all(req.user.id);
  res.render('tickets', { flash: flash(req), tickets });
});

router.post('/tickets', (req, res) => {
  const subject = (req.body.subject || '').trim().slice(0, 120);
  const message = (req.body.message || '').trim();
  if (!subject || !message) {
    req.session.flash = { type: 'error', text: 'Subject and message are required.' };
    return res.redirect('/tickets');
  }
  const info = db.prepare('INSERT INTO tickets (user_id, subject) VALUES (?, ?)').run(req.user.id, subject);
  db.prepare('INSERT INTO ticket_messages (ticket_id, user_id, message) VALUES (?, ?, ?)')
    .run(info.lastInsertRowid, req.user.id, message);
  req.session.flash = { type: 'success', text: 'Ticket created. We will reply soon.' };
  res.redirect(`/tickets/${info.lastInsertRowid}`);
});

router.get('/tickets/:id', (req, res) => {
  const ticket = db
    .prepare('SELECT * FROM tickets WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!ticket) {
    req.session.flash = { type: 'error', text: 'Ticket not found.' };
    return res.redirect('/tickets');
  }
  const messages = db
    .prepare(
      `SELECT m.*, u.username, u.is_admin FROM ticket_messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.ticket_id = ? ORDER BY m.id ASC`
    )
    .all(ticket.id);
  res.render('ticket-view', { flash: flash(req), ticket, messages });
});

router.post('/tickets/:id/reply', (req, res) => {
  const ticket = db
    .prepare('SELECT * FROM tickets WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!ticket || ticket.status === 'closed') {
    req.session.flash = { type: 'error', text: 'Cannot reply to this ticket.' };
    return res.redirect('/tickets');
  }
  const message = (req.body.message || '').trim();
  if (!message) return res.redirect(`/tickets/${ticket.id}`);
  db.transaction(() => {
    db.prepare('INSERT INTO ticket_messages (ticket_id, user_id, message) VALUES (?, ?, ?)')
      .run(ticket.id, req.user.id, message);
    db.prepare(`UPDATE tickets SET status = 'open', updated_at = datetime('now') WHERE id = ?`).run(ticket.id);
  })();
  res.redirect(`/tickets/${ticket.id}`);
});

module.exports = router;
