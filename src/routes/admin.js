/** routes/admin.js — owner-only: provider integration, services, orders, funds, tickets. */
const express = require('express');
const { db } = require('../db');
const { requireAdmin, flash } = require('../middleware');
const { clientFromSettings } = require('../provider');

const router = express.Router();
router.use(requireAdmin);

/** Active = still needs provider status polling. */
const ACTIVE_STATUSES = ['pending', 'processing', 'in_progress'];

/**
 * Poll the provider for current statuses of active orders and update the DB.
 * Shared by the manual button and the background interval in server.js.
 * Returns { updated, errors }.
 */
async function syncOrderStatuses() {
  const settings = db.prepare('SELECT * FROM provider_settings WHERE id = 1').get();
  const client = clientFromSettings(settings);
  if (!client) return { updated: 0, errors: ['Provider not configured'] };

  const orders = db
    .prepare(`SELECT id, provider_order_id FROM orders WHERE provider_order_id IS NOT NULL AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`)
    .all(...ACTIVE_STATUSES);
  if (orders.length === 0) return { updated: 0, errors: [] };

  const statuses = await client.multiStatus(orders.map((o) => o.provider_order_id));
  let updated = 0;
  const errors = [];
  const update = db.prepare(
    `UPDATE orders SET status = ?, provider_status = ?, updated_at = datetime('now') WHERE id = ?`
  );
  for (const o of orders) {
    const s = statuses[String(o.provider_order_id)];
    if (!s || s._error) {
      errors.push(`#${o.id}: ${(s && s._error) || 'no data'}`);
      continue;
    }
    // Provider statuses are usually: Pending | In progress | Processing | Partial | Completed | Canceled
    const mapped = String(s.status || '').toLowerCase().replace(/\s+/g, '_');
    update.run(mapped || 'processing', String(s.status || ''), o.id);
    updated++;
  }
  return { updated, errors };
}

/* ---------------- Admin dashboard ---------------- */
router.get('/', (req, res) => {
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const orders = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(charge),0) AS revenue FROM orders').get();
  const pendingFunds = db.prepare(`SELECT COUNT(*) AS c FROM fund_requests WHERE status = 'pending'`).get().c;
  const openTickets = db.prepare(`SELECT COUNT(*) AS c FROM tickets WHERE status != 'closed'`).get().c;
  const settings = db.prepare('SELECT * FROM provider_settings WHERE id = 1').get();
  const syncedServices = db.prepare('SELECT COUNT(*) AS c FROM provider_services').get().c;
  res.render('admin/dashboard', {
    flash: flash(req), users, orders, pendingFunds, openTickets,
    providerConfigured: !!(settings && settings.api_url && settings.api_key),
    providerUrl: settings ? settings.api_url : null, // key NEVER sent to the view
    syncedServices,
  });
});

/* ---------------- Provider settings ---------------- */
router.get('/settings', (req, res) => {
  const settings = db.prepare('SELECT * FROM provider_settings WHERE id = 1').get();
  const syncedCount = db.prepare('SELECT COUNT(*) AS c FROM provider_services').get().c;
  const syncedAt = db.prepare('SELECT MAX(synced_at) AS t FROM provider_services').get().t;
  res.render('admin/settings', {
    flash: flash(req),
    // Only the URL is shown back; the key is write-only in the UI.
    apiUrl: settings ? settings.api_url : '',
    keySet: !!(settings && settings.api_key),
    syncedCount, syncedAt,
  });
});

router.post('/settings', (req, res) => {
  const apiUrl = (req.body.api_url || '').trim().replace(/\/$/, '');
  const apiKey = (req.body.api_key || '').trim();
  const existing = db.prepare('SELECT * FROM provider_settings WHERE id = 1').get();

  if (!apiUrl) {
    req.session.flash = { type: 'error', text: 'API URL is required.' };
    return res.redirect('/admin/settings');
  }
  // Keep the old key when the field is left blank (write-only UI).
  const keyToStore = apiKey || (existing ? existing.api_key : '');
  db.prepare(
    `INSERT INTO provider_settings (id, api_url, api_key, updated_at)
     VALUES (1, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET api_url = excluded.api_url, api_key = excluded.api_key, updated_at = datetime('now')`
  ).run(apiUrl, keyToStore);
  req.session.flash = { type: 'success', text: 'Provider settings saved.' };
  res.redirect('/admin/settings');
});

/** Pull the wholesale catalog (action=services) into provider_services. */
router.post('/provider/sync-services', async (req, res) => {
  const settings = db.prepare('SELECT * FROM provider_settings WHERE id = 1').get();
  const client = clientFromSettings(settings);
  if (!client) {
    req.session.flash = { type: 'error', text: 'Configure the provider API URL and key first.' };
    return res.redirect('/admin/settings');
  }
  try {
    const list = await client.services();
    const rows = Array.isArray(list) ? list : [];
    const upsert = db.prepare(
      `INSERT INTO provider_services (provider_service_id, name, type, category, rate, min_qty, max_qty, status, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(provider_service_id) DO UPDATE SET
         name = excluded.name, type = excluded.type, category = excluded.category,
         rate = excluded.rate, min_qty = excluded.min_qty, max_qty = excluded.max_qty,
         status = excluded.status, synced_at = datetime('now')`
    );
    const tx = db.transaction((items) => {
      for (const s of items) {
        upsert.run(
          String(s.service ?? s.id ?? ''),
          s.name ?? '',
          s.type ?? '',
          s.category ?? '',
          parseFloat(s.rate) || 0,
          parseInt(s.min, 10) || 0,
          parseInt(s.max, 10) || 0,
          s.status ?? ''
        );
      }
    });
    tx(rows);
    req.session.flash = { type: 'success', text: `Synced ${rows.length} provider services.` };
  } catch (err) {
    req.session.flash = { type: 'error', text: `Sync failed: ${err.message}` };
  }
  res.redirect('/admin/settings');
});

/** Check the provider balance (action=balance). */
router.post('/provider/check-balance', async (req, res) => {
  const settings = db.prepare('SELECT * FROM provider_settings WHERE id = 1').get();
  const client = clientFromSettings(settings);
  if (!client) {
    req.session.flash = { type: 'error', text: 'Configure the provider API URL and key first.' };
    return res.redirect('/admin/settings');
  }
  try {
    const data = await client.balance();
    req.session.flash = {
      type: 'success',
      text: `Provider balance: ${data.balance} ${data.currency || ''}`.trim(),
    };
  } catch (err) {
    req.session.flash = { type: 'error', text: `Balance check failed: ${err.message}` };
  }
  res.redirect('/admin/settings');
});

/** Poll provider for active order statuses (also runs automatically). */
router.post('/provider/sync-status', async (req, res) => {
  try {
    const { updated, errors } = await syncOrderStatuses();
    req.session.flash = {
      type: errors.length && !updated ? 'error' : 'success',
      text: `Status sync done: ${updated} order(s) updated.` + (errors.length ? ` Issues: ${errors.slice(0, 3).join('; ')}` : ''),
    };
  } catch (err) {
    req.session.flash = { type: 'error', text: `Sync failed: ${err.message}` };
  }
  res.redirect('/admin/orders');
});

/* ---------------- Services management ---------------- */
router.get('/services', (req, res) => {
  const services = db.prepare('SELECT * FROM services ORDER BY id DESC').all();
  const providerServices = db.prepare('SELECT provider_service_id, name, rate FROM provider_services ORDER BY name LIMIT 500').all();
  res.render('admin/services', { flash: flash(req), services, providerServices });
});

router.post('/services', (req, res) => {
  const name = (req.body.name || '').trim();
  const rate = parseFloat(req.body.rate);
  const minQty = parseInt(req.body.min_qty, 10) || 100;
  const maxQty = parseInt(req.body.max_qty, 10) || 100000;
  if (!name || !Number.isFinite(rate) || rate < 0) {
    req.session.flash = { type: 'error', text: 'Name and a valid rate are required.' };
    return res.redirect('/admin/services');
  }
  db.prepare(
    `INSERT INTO services (name, platform, type, rate, min_qty, max_qty, provider_service_id, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(
    name,
    (req.body.platform || '').trim().slice(0, 60),
    (req.body.type || '').trim().slice(0, 60),
    rate, minQty, maxQty,
    (req.body.provider_service_id || '').trim() || null
  );
  req.session.flash = { type: 'success', text: 'Service added.' };
  res.redirect('/admin/services');
});

router.post('/services/:id', (req, res) => {
  // Delete (or deactivate when orders exist) via the row's Delete button.
  if (req.body.action === 'delete') {
    const hasOrders = db.prepare('SELECT id FROM orders WHERE service_id = ? LIMIT 1').get(req.params.id);
    if (hasOrders) {
      // Keep history intact: deactivate instead of deleting.
      db.prepare('UPDATE services SET active = 0 WHERE id = ?').run(req.params.id);
      req.session.flash = { type: 'success', text: 'Service has orders — deactivated instead of deleted.' };
    } else {
      db.prepare('DELETE FROM services WHERE id = ?').run(req.params.id);
      req.session.flash = { type: 'success', text: 'Service deleted.' };
    }
    return res.redirect('/admin/services');
  }
  // Edit existing service (rate, min/max, active toggle, provider link).
  const id = parseInt(req.params.id, 10);
  const rate = parseFloat(req.body.rate);
  if (!Number.isFinite(rate) || rate < 0) {
    req.session.flash = { type: 'error', text: 'Invalid rate.' };
    return res.redirect('/admin/services');
  }
  db.prepare(
    `UPDATE services SET name = ?, platform = ?, type = ?, rate = ?, min_qty = ?, max_qty = ?,
     provider_service_id = ?, active = ? WHERE id = ?`
  ).run(
    (req.body.name || '').trim(),
    (req.body.platform || '').trim().slice(0, 60),
    (req.body.type || '').trim().slice(0, 60),
    rate,
    parseInt(req.body.min_qty, 10) || 100,
    parseInt(req.body.max_qty, 10) || 100000,
    (req.body.provider_service_id || '').trim() || null,
    req.body.active ? 1 : 0,
    id
  );
  req.session.flash = { type: 'success', text: 'Service updated.' };
  res.redirect('/admin/services');
});

/* ---------------- Orders management ---------------- */
router.get('/orders', (req, res) => {
  const orders = db
    .prepare(
      `SELECT o.*, s.name AS service_name, u.username FROM orders o
       JOIN services s ON s.id = o.service_id
       JOIN users u ON u.id = o.user_id
       ORDER BY o.id DESC LIMIT 200`
    )
    .all();
  res.render('admin/orders', { flash: flash(req), orders });
});

/** Retry forwarding a stuck order to the provider (action=add). */
router.post('/orders/:id/retry', async (req, res) => {
  const order = db
    .prepare(`SELECT o.*, s.provider_service_id FROM orders o JOIN services s ON s.id = o.service_id WHERE o.id = ?`)
    .get(req.params.id);
  if (!order || order.provider_order_id) return res.redirect('/admin/orders');
  const settings = db.prepare('SELECT * FROM provider_settings WHERE id = 1').get();
  const client = clientFromSettings(settings);
  if (!client || !order.provider_service_id) {
    req.session.flash = { type: 'error', text: 'Provider not configured or service not linked.' };
    return res.redirect('/admin/orders');
  }
  try {
    const result = await client.addOrder(order.provider_service_id, order.link, order.quantity);
    db.prepare(`UPDATE orders SET provider_order_id = ?, status = 'processing', last_error = NULL, updated_at = datetime('now') WHERE id = ?`)
      .run(String(result.order), order.id);
    req.session.flash = { type: 'success', text: `Order #${order.id} forwarded. Provider ID: ${result.order}.` };
  } catch (err) {
    db.prepare(`UPDATE orders SET last_error = ?, updated_at = datetime('now') WHERE id = ?`).run(err.message, order.id);
    req.session.flash = { type: 'error', text: `Retry failed: ${err.message}` };
  }
  res.redirect('/admin/orders');
});

/** Request a refill for a provider order (action=refill). */
router.post('/orders/:id/refill', async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  const settings = db.prepare('SELECT * FROM provider_settings WHERE id = 1').get();
  const client = clientFromSettings(settings);
  if (!order || !order.provider_order_id || !client) {
    req.session.flash = { type: 'error', text: 'Refill not possible (no provider order).' };
    return res.redirect('/admin/orders');
  }
  try {
    const result = await client.refill(order.provider_order_id);
    req.session.flash = { type: 'success', text: `Refill requested. Refill ID: ${result.refill}.` };
  } catch (err) {
    req.session.flash = { type: 'error', text: `Refill failed: ${err.message}` };
  }
  res.redirect('/admin/orders');
});

/** Mark an order complete/canceled manually (no provider call). */
router.post('/orders/:id/status', (req, res) => {
  const status = (req.body.status || '').trim();
  if (!['completed', 'partial', 'canceled'].includes(status)) return res.redirect('/admin/orders');
  db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, req.params.id);
  req.session.flash = { type: 'success', text: `Order #${req.params.id} marked as ${status}.` };
  res.redirect('/admin/orders');
});

/* ---------------- Fund requests ---------------- */
router.get('/funds', (req, res) => {
  const requests = db
    .prepare(
      `SELECT f.*, u.username FROM fund_requests f
       JOIN users u ON u.id = f.user_id ORDER BY f.id DESC LIMIT 100`
    )
    .all();
  res.render('admin/funds', { flash: flash(req), requests });
});

router.post('/funds/:id/approve', (req, res) => {
  const fr = db.prepare('SELECT * FROM fund_requests WHERE id = ? AND status = ?').get(req.params.id, 'pending');
  if (!fr) return res.redirect('/admin/funds');
  db.transaction(() => {
    db.prepare(`UPDATE fund_requests SET status = 'approved', decided_at = datetime('now') WHERE id = ?`).run(fr.id);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(fr.amount, fr.user_id);
    const bal = db.prepare('SELECT balance FROM users WHERE id = ?').get(fr.user_id).balance;
    db.prepare(`INSERT INTO transactions (user_id, type, amount, balance_after, note) VALUES (?, 'deposit', ?, ?, ?)`)
      .run(fr.user_id, fr.amount, bal, `Fund request #${fr.id} approved`);
  })();
  req.session.flash = { type: 'success', text: `Approved $${fr.amount.toFixed(2)}.` };
  res.redirect('/admin/funds');
});

router.post('/funds/:id/reject', (req, res) => {
  db.prepare(`UPDATE fund_requests SET status = 'rejected', decided_at = datetime('now') WHERE id = ? AND status = 'pending'`)
    .run(req.params.id);
  req.session.flash = { type: 'success', text: 'Request rejected.' };
  res.redirect('/admin/funds');
});

/* ---------------- Support tickets ---------------- */
router.get('/tickets', (req, res) => {
  const tickets = db
    .prepare(
      `SELECT t.*, u.username FROM tickets t
       JOIN users u ON u.id = t.user_id ORDER BY t.updated_at DESC`
    )
    .all();
  res.render('admin/tickets', { flash: flash(req), tickets });
});

router.get('/tickets/:id', (req, res) => {
  const ticket = db
    .prepare(`SELECT t.*, u.username FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?`)
    .get(req.params.id);
  if (!ticket) return res.redirect('/admin/tickets');
  const messages = db
    .prepare(
      `SELECT m.*, u.username, u.is_admin FROM ticket_messages m
       JOIN users u ON u.id = m.user_id WHERE m.ticket_id = ? ORDER BY m.id ASC`
    )
    .all(ticket.id);
  res.render('admin/ticket-view', { flash: flash(req), ticket, messages });
});

router.post('/tickets/:id/reply', (req, res) => {
  const message = (req.body.message || '').trim();
  if (!message) return res.redirect(`/admin/tickets/${req.params.id}`);
  db.transaction(() => {
    db.prepare('INSERT INTO ticket_messages (ticket_id, user_id, message) VALUES (?, ?, ?)')
      .run(req.params.id, req.user.id, message);
    db.prepare(`UPDATE tickets SET status = 'answered', updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  })();
  res.redirect(`/admin/tickets/${req.params.id}`);
});

router.post('/tickets/:id/close', (req, res) => {
  db.prepare(`UPDATE tickets SET status = 'closed', updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  res.redirect('/admin/tickets');
});

/* ---------------- Users ---------------- */
router.get('/users', (req, res) => {
  const users = db
    .prepare('SELECT id, username, email, balance, is_admin, created_at FROM users ORDER BY id ASC')
    .all();
  res.render('admin/users', { flash: flash(req), users });
});

router.post('/users/:id/balance', (req, res) => {
  const amount = Math.round(parseFloat(req.body.amount) * 100) / 100;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target || !Number.isFinite(amount) || amount === 0) {
    req.session.flash = { type: 'error', text: 'Invalid amount or user.' };
    return res.redirect('/admin/users');
  }
  db.transaction(() => {
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, target.id);
    const bal = db.prepare('SELECT balance FROM users WHERE id = ?').get(target.id).balance;
    db.prepare(`INSERT INTO transactions (user_id, type, amount, balance_after, note) VALUES (?, 'adjustment', ?, ?, ?)`)
      .run(target.id, amount, bal, `Manual adjustment by admin`);
  })();
  req.session.flash = { type: 'success', text: `Balance adjusted by $${amount.toFixed(2)}.` };
  res.redirect('/admin/users');
});

module.exports = { router, syncOrderStatuses };
