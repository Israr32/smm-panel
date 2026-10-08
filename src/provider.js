/**
 * provider.js — Generic wholesale SMM provider API client (standard v2).
 *
 * Almost every wholesale panel (Peakerr, JustAnotherPanel, FollowersMore,
 * …) speaks the same API format: POST https://<provider>/api/v2 with
 * form-encoded fields: key, action, + action-specific params.
 * Switching providers = changing only the API URL and key. No code changes.
 *
 * Actions used:
 *   services      -> list wholesale service catalog
 *   balance       -> provider account balance
 *   add           -> place order {service, link, quantity}
 *   status        -> order status {order} or {orders: "1,2,3"}
 *   refill        -> request refill {order}
 *   refill_status -> refill state {refill}
 */
class ProviderClient {
  /**
   * @param {string} apiUrl  e.g. "https://peakerr.com/api/v2"
   * @param {string} apiKey  provider API key (secret — never send to browser)
   * @param {number} timeoutMs request timeout (default 30s)
   */
  constructor(apiUrl, apiKey, timeoutMs = 30000) {
    this.apiUrl = (apiUrl || '').trim().replace(/\/$/, '');
    this.apiKey = (apiKey || '').trim();
    this.timeoutMs = timeoutMs;
    if (!this.apiUrl) throw new Error('Provider API URL is not configured.');
    if (!this.apiKey) throw new Error('Provider API key is not configured.');
  }

  /** Low-level call. Throws on network errors, bad JSON, or provider errors. */
  async call(action, params = {}) {
    const body = new URLSearchParams({ key: this.apiKey, action, ...params });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(this.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new Error(`Provider request failed (${action}): ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Provider returned non-JSON (${action}): ${text.slice(0, 120)}`);
    }
    if (data && typeof data === 'object' && data.error) {
      throw new Error(`Provider error (${action}): ${data.error}`);
    }
    return data;
  }

  /** Full wholesale catalog. Returns array of service objects. */
  services() {
    return this.call('services');
  }

  /** Provider balance. Returns { balance, currency }. */
  balance() {
    return this.call('balance');
  }

  /**
   * Place an order. Returns { order: "<provider order id>" }.
   * @param {string|number} serviceId wholesale service id
   * @param {string} link  target link
   * @param {number} quantity
   */
  addOrder(serviceId, link, quantity) {
    return this.call('add', {
      service: String(serviceId),
      link: String(link),
      quantity: String(quantity),
    });
  }

  /** Status of one order. Returns { charge, status, remains, start_count, currency }. */
  orderStatus(providerOrderId) {
    return this.call('status', { order: String(providerOrderId) });
  }

  /**
   * Status of many orders in one call. Returns { "<id>": {status...}, ... }.
   * Falls back to individual calls if the provider rejects the batch form.
   */
  async multiStatus(providerOrderIds) {
    const ids = [...new Set(providerOrderIds.map(String))];
    if (ids.length === 0) return {};
    try {
      return await this.call('status', { orders: ids.join(',') });
    } catch {
      const out = {};
      for (const id of ids) {
        try { out[id] = await this.orderStatus(id); }
        catch (err) { out[id] = { _error: err.message }; }
      }
      return out;
    }
  }

  /** Request a refill for a provider order. Returns { refill: "<refill id>" }. */
  refill(providerOrderId) {
    return this.call('refill', { order: String(providerOrderId) });
  }

  /** Check a refill request. Returns { status }. */
  refillStatus(refillId) {
    return this.call('refill_status', { refill: String(refillId) });
  }
}

/** Build a client from the DB-stored settings row, or null if not configured. */
function clientFromSettings(row) {
  if (!row || !row.api_url || !row.api_key) return null;
  try {
    return new ProviderClient(row.api_url, row.api_key);
  } catch {
    return null;
  }
}

module.exports = { ProviderClient, clientFromSettings };
