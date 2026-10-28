'use strict';
// The setup service must explicitly advertise readiness before credentials can be submitted.
(() => {
  const service = 'https://setup.classycash.dpdns.org';
  const form = document.querySelector('#setup-form');
  const fields = document.querySelector('#setup-fields');
  const availability = document.querySelector('#availability');
  const status = document.querySelector('#setup-status');
  const password = document.querySelector('#password');
  const claimNotice = document.querySelector('#claim-notice');
  const claimCode = document.querySelector('#claim-code');
  const toggle = document.querySelector('#show-password');
  const humanBox = document.querySelector('#turnstile');
  let widget;
  const unavailable = 'Kreator nie jest jeszcze dostępny. Wróć później — nie wysyłaj nam danych serwera w wiadomości.';
  toggle.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Ukryj' : 'Pokaż';
    toggle.setAttribute('aria-pressed', String(show));
  });
  // Cloudflare Turnstile is loaded only after the service reports it is ready and names its public site key.
  function loadTurnstile(siteKey) {
    return new Promise((resolve, reject) => {
      const render = () => { widget = globalThis.turnstile.render(humanBox, {sitekey: siteKey, action: 'setup', language: 'pl'}); resolve(); };
      if (globalThis.turnstile) return render();
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = () => globalThis.turnstile ? render() : reject(Error('turnstile'));
      script.onerror = () => reject(Error('turnstile'));
      document.head.append(script);
    });
  }
  function resetHumanCheck() { try { globalThis.turnstile.reset(widget); } catch (_) {} }
  fetch(`${service}/v1/capabilities`, {cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(8000)})
    .then(response => { if (!response.ok) throw Error('unavailable'); return response.json(); })
    .then(data => {
      if (data.ready !== true || data.protocol !== 'classycash-setup-v1') throw Error('unavailable');
      if (!/^[A-Za-z0-9_-]{10,64}$/.test(data.turnstile_site_key || '')) throw Error('unavailable');
      return loadTurnstile(data.turnstile_site_key);
    })
    .then(() => {
      fields.disabled = false;
      availability.textContent = 'Kreator jest gotowy. Wprowadź dane otrzymane od Mikrusa.';
    })
    .catch(() => { availability.textContent = unavailable; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (fields.disabled || !form.reportValidity()) return;
    fields.disabled = true;
    const fingerprint = form.elements.fingerprint.value.trim();
    if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(fingerprint)) {
      status.hidden = false;
      status.className = 'wizard-notice error';
      status.textContent = 'Odcisk klucza ma postać SHA256:… (43 znaki po dwukropku). Skopiuj go dokładnie z komunikatu programu SSH.';
      fields.disabled = false;
      return;
    }
    const humanToken = globalThis.turnstile.getResponse(widget);
    if (!humanToken) {
      status.hidden = false;
      status.className = 'wizard-notice error';
      status.textContent = 'Potwierdź, że nie jesteś robotem, i wyślij formularz ponownie.';
      fields.disabled = false;
      return;
    }
    const payload = { host: form.elements.host.value.trim(), login: form.elements.login.value.trim(), password: password.value, host_key_fingerprint: fingerprint, turnstile_token: humanToken };
    status.hidden = false;
    status.className = 'wizard-notice';
    status.textContent = 'Przygotowujemy instalację. Nie zamykaj tej karty.';
    password.value = '';
    try {
      const response = await fetch(`${service}/v1/operations`, { method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
      payload.password = '';
      payload.turnstile_token = '';
      resetHumanCheck();
      if (response.status === 400 || response.status === 403 || response.status === 429) {
        fields.disabled = false;
        status.className = 'wizard-notice error';
        status.textContent = response.status === 403 ? 'Weryfikacja nie powiodła się. Spróbuj ponownie.' : response.status === 400 ? 'Sprawdź adres, port, dane logowania i odcisk klucza, a następnie spróbuj ponownie.' : 'Zbyt wiele prób. Odczekaj chwilę i spróbuj ponownie.';
        return;
      }
      if (!response.ok) throw Error('failed');
      const result = await response.json();
      if (!/^[a-f0-9]{32}$/.test(result.id || '') || !/^[a-f0-9]{64}$/.test(result.token || '') || !/^[a-f0-9]{64}$/.test(result.claim_token || '')) throw Error('failed');
      claimCode.textContent = result.claim_token;
      claimNotice.hidden = false;
      await follow(result.id, result.token);
    } catch (error) {
      payload.password = '';
      payload.turnstile_token = '';
      resetHumanCheck();
      if (error && error.retrySafe) {
        // The service stopped before touching anything (typically a fingerprint that does not match the server).
        claimNotice.hidden = true;
        fields.disabled = false;
        status.className = 'wizard-notice error';
        status.textContent = 'Nie udało się zweryfikować serwera, a nic nie zostało zmienione. Sprawdź odcisk klucza, adres i port, wpisz hasło ponownie i spróbuj jeszcze raz.';
        return;
      }
      status.className = 'wizard-notice error';
      status.textContent = 'Nie udało się potwierdzić rozpoczęcia instalacji. Nie próbuj ponownie, jeśli serwer mógł już zostać skonfigurowany; skontaktuj się z administratorem.';
    }
  });
  async function follow(id, token) {
    for (let attempts = 0; attempts < 120; attempts++) {
      const response = await fetch(`${service}/v1/operations/${id}`, {headers: {'Authorization': `Bearer ${token}`}, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10000)});
      if (!response.ok) throw Error('status unavailable');
      const data = await response.json();
      if (data.state === 'failed') { const failure = Error('setup failed'); failure.retrySafe = data.retry_safe === true; throw failure; }
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
