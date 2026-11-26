const { createHmac, randomBytes } = require('node:crypto');
const fetch = require('node-fetch');

const validPirepId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);

function createPirepBridge({
  baseUrl = process.env.PIREP_BRIDGE_URL,
  secret = process.env.PIREP_BRIDGE_SECRET,
  fetchImpl = fetch,
  timeout = 5000,
} = {}) {
  async function request(operation, payload) {
    let url;
    try {
      url = new URL(baseUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
          !/^[a-f0-9]{64}$/.test(secret ?? '')) throw new Error();
    } catch {
      return { code: 'unconfigured' };
    }

    url.pathname = url.pathname.replace(/\/$/, '') + '/api/vuscgcustom/pirep-review/' + operation;
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const signature = createHmac('sha256', secret)
      .update(['POST', url.pathname, timestamp, nonce, body].join('\n')).digest('hex');
    const signal = AbortSignal.timeout(timeout);
    try {
      const response = await fetchImpl(url.toString(), {
        method: 'POST', body, signal, redirect: 'error', size: 4096,
        headers: {
          'Content-Type': 'application/json', Accept: 'application/json',
          'X-VUSCG-Timestamp': timestamp, 'X-VUSCG-Nonce': nonce, 'X-VUSCG-Signature': signature,
        },
      });
      if ([401, 403].includes(response.status)) return { code: 'unauthorized' };
      if (response.status === 429) return { code: 'busy' };
      const result = await response.json();
      if (result.pirep_id !== payload.pirep_id) return { code: 'uncertain' };
      if (response.status === 404 && result.code === 'not_found') return { code: 'not_found' };
      if (response.status === 422 && result.code === 'invalid') return { code: 'invalid' };
      if (response.status === 503 && result.code === 'disabled') return { code: 'disabled' };
      if (!Number.isInteger(result.state) || result.state < 0 || result.state > 7) return { code: 'uncertain' };
      if (operation === 'status' && response.ok && result.code === 'status') return result;
      if (operation === 'decision' && response.status === 409 && result.code === 'not_pending' &&
          result.state !== 1) return result;
      const expected = payload.action === 'approve' ? 2 : 6;
      if (operation === 'decision' && response.ok && result.code === 'changed' &&
          result.state === expected) return result;
      return { code: 'uncertain' };
    } catch {
      return { code: 'uncertain' };
    }
  }

  return {
    async decide(pirepId, action, reviewer) {
      if (!validPirepId(pirepId) || !['approve', 'reject'].includes(action)) return { code: 'invalid' };
      const decision = await request('decision', { pirep_id: pirepId, action, reviewer });
      if (decision.code !== 'uncertain') return decision;
      const status = await request('status', { pirep_id: pirepId });
      if (status.code === 'status') return { code: 'reconciled', state: status.state };
      if (status.code === 'not_found') return status;
      return decision;
    },
  };
}

module.exports = { createPirepBridge, validPirepId };
