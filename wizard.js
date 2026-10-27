'use strict';
// The setup service must explicitly advertise readiness before credentials can be submitted.
(() => {
  const service = 'https://setup.classycash.dpdns.org';
  const form = document.querySelector('#setup-form');
  const fields = document.querySelector('#setup-fields');
  const availability = document.querySelector('#availability');
  const status = document.querySelector('#setup-status');
  const password = document.querySelector('#password');
  const toggle = document.querySelector('#show-password');
  const unavailable = 'Kreator nie jest jeszcze dostępny. Wróć później — nie wysyłaj nam danych serwera w wiadomości.';
  toggle.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Ukryj' : 'Pokaż';
    toggle.setAttribute('aria-pressed', String(show));
  });
  fetch(`${service}/v1/capabilities`, {cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(8000)})
    .then(response => { if (!response.ok) throw Error('unavailable'); return response.json(); })
    .then(data => {
      if (data.ready !== true || data.protocol !== 'classycash-setup-v1') throw Error('unavailable');
      fields.disabled = false;
      availability.textContent = 'Kreator jest gotowy. Wprowadź dane otrzymane od Mikrusa.';
    })
    .catch(() => { availability.textContent = unavailable; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (fields.disabled || !form.reportValidity()) return;
    fields.disabled = true;
    status.hidden = false;
    status.className = 'wizard-notice';
    status.textContent = 'Przygotowujemy instalację. Nie zamykaj tej karty.';
    const payload = { host: form.elements.host.value.trim(), login: form.elements.login.value.trim(), password: password.value };
    password.value = '';
    try {
      const response = await fetch(`${service}/v1/operations`, { method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
      payload.password = '';
      if (!response.ok) throw Error('failed');
      const result = await response.json();
      if (!/^[a-f0-9]{32}$/.test(result.id || '') || !/^[a-f0-9]{64}$/.test(result.token || '')) throw Error('failed');
      await follow(result.id, result.token);
    } catch (_) {
      payload.password = '';
      status.className = 'wizard-notice error';
      status.textContent = 'Nie udało się potwierdzić rozpoczęcia instalacji. Nie próbuj ponownie, jeśli serwer mógł już zostać skonfigurowany; skontaktuj się z administratorem.';
    }
  });
  async function follow(id, token) {
    for (let attempts = 0; attempts < 120; attempts++) {
      const response = await fetch(`${service}/v1/operations/${id}`, {headers: {'Authorization': `Bearer ${token}`}, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10000)});
      if (!response.ok) throw Error('status unavailable');
      const data = await response.json();
      if (data.state === 'failed') throw Error('setup failed');
      if (data.state === 'complete') {
        const url = new URL(data.app_url);
        if (url.protocol !== 'https:' || !/^frog[0-9]+-[0-9]+\.wykr\.es$/.test(url.hostname) || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('bad url');
        status.textContent = 'Instalacja zakończona. ';
        const link = document.createElement('a');
        link.href = url.href; link.textContent = 'Otwórz swoją aplikację'; link.rel = 'noopener noreferrer';
        status.append(link);
        return;
      }
      if (data.state !== 'pending') throw Error('unknown state');
      status.textContent = 'Przygotowujemy instalację. Może to potrwać kilka minut.';
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    throw Error('timeout');
  }
})();
