'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const script = fs.readFileSync('wizard.js', 'utf8');

const SITE_KEY = '0x4AAAAAAABBBBccccDDDD';
function page(fetch, human = {}) {
  const nodes = {};
  for (const id of ['setup-form', 'setup-fields', 'availability', 'setup-status', 'password', 'show-password', 'claim-notice', 'claim-code', 'turnstile']) {
    nodes[id] = { disabled: id === 'setup-fields', hidden: false, type: 'password', value: '', textContent: '',
      addEventListener(name, handler) { this[name] = handler; }, setAttribute() {}, append(node) { this.link = node; } };
  }
  nodes['setup-form'].elements = {host: {value: 'frog03.mikr.us:10001'}, login: {value: 'frog'}, fingerprint: {value: 'SHA256:' + 'A'.repeat(43)}};
  nodes['setup-form'].reportValidity = () => true;
  nodes.password.value = 'test-password';
  const widget = {rendered: null, resets: 0, token: human.token === undefined ? 'human-token' : human.token};
  const turnstile = {render(box, options) { widget.rendered = options; return 'w1'; }, getResponse() { return widget.token; }, reset() { widget.resets++; }};
  const head = {append(node) { head.script = node; if (human.load !== false) { context.turnstile = turnstile; node.onload(); } else node.onerror(); }};
  const document = {head, querySelector(selector) { return nodes[selector.slice(1)]; }, createElement() { return {}; }};
  const context = {document, fetch, URL, AbortSignal, setTimeout};
  vm.runInNewContext(script, context, {timeout: 2000});
  nodes.widget = widget; nodes.head = head;
  return nodes;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('keeps the credential form closed when the service is unavailable', async () => {
  const nodes = page(async () => { throw Error('offline'); });
  await tick();
  assert.equal(nodes['setup-fields'].disabled, true);
  assert.match(nodes.availability.textContent, /nie jest jeszcze dostępny/);
});

test('submits only after readiness and clears the password before completion', async () => {
  const calls = [];
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const nodes = page(async (url, options) => {
    calls.push({url, options});
    if (url.endsWith('/capabilities')) return {ok: true, json: async () => ({ready: true, protocol: 'classycash-setup-v1', turnstile_site_key: SITE_KEY})};
    if (url.endsWith('/operations') && options.method === 'POST') {
      await waiting;
      return {ok: true, json: async () => ({id: 'a'.repeat(32), token: 'b'.repeat(64), claim_token: 'c'.repeat(64)})};
    }
    return {ok: true, json: async () => ({state: 'complete', app_url: 'https://frog03-20001.wykr.es'})};
  });
  await tick();
  assert.equal(nodes['setup-fields'].disabled, false);
  const submitted = nodes['setup-form'].submit({preventDefault() {}});
  assert.equal(nodes.password.value, '');
  assert.equal(nodes['setup-fields'].disabled, true);
  finish();
  await submitted;
  assert.equal(nodes['claim-code'].textContent, 'c'.repeat(64));
  assert.equal(nodes['claim-notice'].hidden, false);
  assert.equal(nodes['setup-status'].link.href, 'https://frog03-20001.wykr.es/');
  assert.match(calls[1].options.body, /test-password/);
  assert.equal(JSON.parse(calls[1].options.body).host_key_fingerprint, 'SHA256:' + 'A'.repeat(43));
  assert.equal(calls[2].options.headers.Authorization, 'Bearer ' + 'b'.repeat(64));
});


test('lets a user correct a rejected request without keeping the password', async () => {
  const nodes = page(async url => url.endsWith('/capabilities')
    ? {ok: true, json: async () => ({ready: true, protocol: 'classycash-setup-v1', turnstile_site_key: SITE_KEY})}
    : {ok: false, status: 400});
  await tick();
  await nodes['setup-form'].submit({preventDefault() {}});
  assert.equal(nodes['setup-fields'].disabled, false);
  assert.equal(nodes.password.value, '');
  assert.match(nodes['setup-status'].textContent, /Sprawdź adres/);
});

test('refuses to send anything without a well-formed host key fingerprint', async () => {
  const calls = [];
  const nodes = page(async (url, options) => {
    calls.push(url);
    return {ok: true, json: async () => ({ready: true, protocol: 'classycash-setup-v1', turnstile_site_key: SITE_KEY})};
  });
  await tick();
  nodes['setup-form'].elements.fingerprint.value = 'MD5:aa:bb';
  await nodes['setup-form'].submit({preventDefault() {}});
  assert.equal(nodes['setup-fields'].disabled, false);
  assert.match(nodes['setup-status'].textContent, /SHA256/);
  assert.equal(calls.filter(url => url.endsWith('/operations')).length, 0);
  assert.equal(nodes.password.value, 'test-password');
});

test('lets the owner retry when the service failed before touching anything', async () => {
  const nodes = page(async (url, options) => {
    if (url.endsWith('/capabilities')) return {ok: true, json: async () => ({ready: true, protocol: 'classycash-setup-v1', turnstile_site_key: SITE_KEY})};
    if (options && options.method === 'POST') return {ok: true, json: async () => ({id: 'a'.repeat(32), token: 'b'.repeat(64), claim_token: 'c'.repeat(64)})};
    return {ok: true, json: async () => ({state: 'failed', retry_safe: true})};
  });
  await tick();
  await nodes['setup-form'].submit({preventDefault() {}});
  assert.equal(nodes['setup-fields'].disabled, false);
  assert.equal(nodes['claim-notice'].hidden, true);
  assert.match(nodes['setup-status'].textContent, /nic nie zostało zmienione/);
  assert.equal(nodes.password.value, '');
});

test('keeps the form closed and warns when a later failure may have left resources behind', async () => {
  const nodes = page(async (url, options) => {
    if (url.endsWith('/capabilities')) return {ok: true, json: async () => ({ready: true, protocol: 'classycash-setup-v1', turnstile_site_key: SITE_KEY})};
    if (options && options.method === 'POST') return {ok: true, json: async () => ({id: 'a'.repeat(32), token: 'b'.repeat(64), claim_token: 'c'.repeat(64)})};
    return {ok: true, json: async () => ({state: 'failed', retry_safe: false})};
  });
  await tick();
  await nodes['setup-form'].submit({preventDefault() {}});
  assert.equal(nodes['setup-fields'].disabled, true);
  assert.match(nodes['setup-status'].textContent, /Nie próbuj ponownie/);
});

test('loads Turnstile only after the service is ready and sends the token once', async () => {
  const calls = [];
  const nodes = page(async (url, options) => {
    calls.push({url, options});
    if (url.endsWith('/capabilities')) return {ok: true, json: async () => ({ready: true, protocol: 'classycash-setup-v1', turnstile_site_key: SITE_KEY})};
    if (options && options.method === 'POST') return {ok: true, json: async () => ({id: 'a'.repeat(32), token: 'b'.repeat(64), claim_token: 'c'.repeat(64)})};
    return {ok: true, json: async () => ({state: 'complete', app_url: 'https://frog03-20001.wykr.es'})};
  });
  await tick();
  assert.equal(nodes.head.script.src, 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
  assert.equal(JSON.stringify(nodes.widget.rendered), JSON.stringify({sitekey: SITE_KEY, action: 'setup', language: 'pl'}));
  assert.equal(nodes['setup-fields'].disabled, false);
  await nodes['setup-form'].submit({preventDefault() {}});
  assert.equal(JSON.parse(calls[1].options.body).turnstile_token, 'human-token');
  assert.equal(nodes.widget.resets, 1);
});

test('stays closed without a site key or when the widget cannot load', async () => {
  const noKey = page(async () => ({ok: true, json: async () => ({ready: true, protocol: 'classycash-setup-v1'})}));
  await tick();
  assert.equal(noKey['setup-fields'].disabled, true);
  assert.equal(noKey.head.script, undefined);
  const noWidget = page(async () => ({ok: true, json: async () => ({ready: true, protocol: 'classycash-setup-v1', turnstile_site_key: SITE_KEY})}), {load: false});
  await tick();
  assert.equal(noWidget['setup-fields'].disabled, true);
  assert.match(noWidget.availability.textContent, /nie jest jeszcze dostępny/);
});

test('does not submit without a completed human check', async () => {
  const calls = [];
  const nodes = page(async url => { calls.push(url); return {ok: true, json: async () => ({ready: true, protocol: 'classycash-setup-v1', turnstile_site_key: SITE_KEY})}; }, {token: ''});
  await tick();
  await nodes['setup-form'].submit({preventDefault() {}});
  assert.equal(calls.filter(url => url.endsWith('/operations')).length, 0);
  assert.equal(nodes['setup-fields'].disabled, false);
  assert.match(nodes['setup-status'].textContent, /nie jesteś robotem/);
  assert.equal(nodes.password.value, 'test-password');
});

test('lets the owner retry after a failed verification', async () => {
  const nodes = page(async (url, options) => {
    if (url.endsWith('/capabilities')) return {ok: true, json: async () => ({ready: true, protocol: 'classycash-setup-v1', turnstile_site_key: SITE_KEY})};
    return {ok: false, status: 403, json: async () => ({error: 'verification failed'})};
  });
  await tick();
  await nodes['setup-form'].submit({preventDefault() {}});
  assert.equal(nodes['setup-fields'].disabled, false);
  assert.match(nodes['setup-status'].textContent, /Weryfikacja nie powiodła się/);
  assert.equal(nodes.widget.resets, 1);
});
