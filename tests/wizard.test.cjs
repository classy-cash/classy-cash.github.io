'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const script = fs.readFileSync('wizard.js', 'utf8');

function page(fetch) {
  const nodes = {};
  for (const id of ['setup-form', 'setup-fields', 'availability', 'setup-status', 'password', 'show-password']) {
    nodes[id] = { disabled: id === 'setup-fields', hidden: false, type: 'password', value: '', textContent: '',
      addEventListener(name, handler) { this[name] = handler; }, setAttribute() {}, append(node) { this.link = node; } };
  }
  nodes['setup-form'].elements = {host: {value: 'frog03.mikr.us:10001'}, login: {value: 'frog'}};
  nodes['setup-form'].reportValidity = () => true;
  nodes.password.value = 'test-password';
  const document = {querySelector(selector) { return nodes[selector.slice(1)]; }, createElement() { return {}; }};
  vm.runInNewContext(script, {document, fetch, URL, AbortSignal, setTimeout}, {timeout: 2000});
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
    if (url.endsWith('/capabilities')) return {ok: true, json: async () => ({ready: true, protocol: 'classycash-setup-v1'})};
    if (url.endsWith('/operations') && options.method === 'POST') {
      await waiting;
      return {ok: true, json: async () => ({id: 'a'.repeat(32), token: 'b'.repeat(64)})};
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
  assert.equal(nodes['setup-status'].link.href, 'https://frog03-20001.wykr.es/');
  assert.match(calls[1].options.body, /test-password/);
  assert.equal(calls[2].options.headers.Authorization, 'Bearer ' + 'b'.repeat(64));
});
