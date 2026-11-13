import { createHash, createHmac } from 'node:crypto';
import { sklandSecrets, sklandBinding, sklandInfo, sklandCultivate } from './skland-data.ts';

// Test-only stand-in for the Skland and Hypergryph account services. It knows only the endpoints the
// reader may use, checks request signatures with an independent implementation, and records every
// request so tests can prove the reader stayed read-only. Unknown endpoints are recorded and refused.
//
// A scenario lists, per endpoint, the answers to give in order (the last one repeats):
//   'ok' | 'network' | 'not-json' | { http: 500 } | { code: 10000 } | { status: 1 } | { data: {...} }
export function createSklandDouble(scenario = {}) {
  const trace = [];
  const steps = { grant: ['ok'], cred: ['ok'], refresh: ['ok'], binding: ['ok'], info: ['ok'], cultivate: ['ok'], ...scenario.steps };
  const used = Object.fromEntries(Object.keys(steps).map(key => [key, 0]));
  let exchanges = 0, refreshes = 0;
  let currentKey = null, currentCred = null;
  const next = (kind) => { const list = steps[kind]; const step = list[Math.min(used[kind], list.length - 1)]; used[kind] += 1; return step; };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const answer = (step, success) => {
    if (step === 'network') throw new TypeError('fetch failed');
    if (step === 'not-json') return new Response('<html>gateway</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    if (step && typeof step === 'object' && 'http' in step) return new Response('', { status: step.http });
    if (step && typeof step === 'object' && 'code' in step) return json({ code: step.code, message: 'synthetic refusal', timestamp: '0' });
    if (step && typeof step === 'object' && 'status' in step) return json({ status: step.status, type: 'A', msg: 'synthetic refusal' });
    return success(step && typeof step === 'object' && 'data' in step ? step.data : undefined);
  };
  const signed = (url, headers) => {
    const timestamp = headers.get('timestamp') ?? '';
    const header = JSON.stringify({ platform: headers.get('platform') ?? '', timestamp, dId: headers.get('dId') ?? '', vName: headers.get('vName') ?? '' });
    const hex = createHmac('sha256', currentKey ?? '').update(`${url.pathname}${url.search.replace(/^\?/, '')}${timestamp}${header}`).digest('hex');
    const sign = createHash('md5').update(hex).digest('hex');
    const skew = Math.abs(Date.now() / 1000 - Number(timestamp));
    return headers.get('cred') === currentCred && headers.get('sign') === sign && /^\d+$/.test(timestamp) && skew < 120;
  };
  async function fetch(input, init = {}) {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const route = `${method} ${url.host}${url.pathname}`;
    const record = (kind, extra = {}) => trace.push({ kind, method, host: url.host, path: url.pathname, redirect: init.redirect ?? null, ...extra });
    if (route === 'POST as.hypergryph.com/user/oauth2/v2/grant') {
      const body = JSON.parse(String(init.body));
      record('grant', { body: { appCode: body.appCode, type: body.type, tokenMatches: body.token === sklandSecrets.userValue } });
      return answer(next('grant'), () => body.token === sklandSecrets.userValue
        ? json({ status: 0, type: 'A', msg: 'OK', data: { code: sklandSecrets.grantCode, ['uid']: sklandSecrets.userId } })
        : json({ status: 3, type: 'A', msg: 'synthetic invalid token' }));
    }
    if (route === 'POST zonai.skland.com/api/v1/user/auth/generate_cred_by_code') {
      const body = JSON.parse(String(init.body));
      record('cred', { body: { kind: body.kind, codeMatches: body.code === sklandSecrets.grantCode } });
      return answer(next('cred'), () => {
        exchanges += 1; currentCred = `${sklandSecrets.cred}-${exchanges}`; currentKey = `${sklandSecrets.signKey}-${exchanges}`;
        return json({ code: 0, message: 'OK', data: { cred: currentCred, userId: sklandSecrets.userId, ['token']: currentKey } });
      });
    }
    if (route === 'GET zonai.skland.com/api/v1/auth/refresh') {
      record('refresh', { credMatches: headers.get('cred') === currentCred });
      return answer(next('refresh'), () => {
        refreshes += 1; currentKey = `${sklandSecrets.signKey}-refreshed-${refreshes}`;
        return json({ code: 0, message: 'OK', data: { ['token']: currentKey } });
      });
    }
    const data = { 'GET zonai.skland.com/api/v1/game/player/binding': ['binding', () => sklandBinding()],
      'GET zonai.skland.com/api/v1/game/player/info': ['info', () => sklandInfo()],
      'GET zonai.skland.com/api/v1/game/cultivate/player': ['cultivate', () => sklandCultivate()] }[route];
    if (data) {
      const [kind, payload] = data;
      const valid = signed(url, headers);
      record(kind, { signed: valid, query: [...url.searchParams.keys()], accountMatches: url.searchParams.get('uid') === sklandSecrets.account });
      if (!valid) return json({ code: 10000, message: 'synthetic signature mismatch' });
      return answer(next(kind), custom => json({ code: 0, message: 'OK', timestamp: String(Math.floor(Date.now() / 1000)), data: custom ?? payload() }));
    }
    record('refused');
    return new Response('', { status: 404 });
  }
  return { fetch, trace };
}
