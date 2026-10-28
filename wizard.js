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
  const checkAgain = document.querySelector('#check-again');
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
    const humanToken = globalThis.turnstile.getResponse(widget);
    if (!humanToken) {
      status.hidden = false;
      status.className = 'wizard-notice error';
      status.textContent = 'Potwierdź, że nie jesteś robotem, i wyślij formularz ponownie.';
      fields.disabled = false;
      return;
    }
    const payload = { host: form.elements.host.value.trim(), login: form.elements.login.value.trim(), password: password.value, turnstile_token: humanToken };
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
        status.textContent = response.status === 403 ? 'Weryfikacja nie powiodła się. Spróbuj ponownie.' : response.status === 400 ? 'Sprawdź adres, port i dane logowania, a następnie spróbuj ponownie.' : 'Zbyt wiele prób. Odczekaj chwilę i spróbuj ponownie.';
        return;
      }
      if (!response.ok) throw Error('failed');
      const result = await response.json();
      if (!/^[a-f0-9]{32}$/.test(result.id || '') || !/^[a-f0-9]{64}$/.test(result.token || '') || !/^[a-f0-9]{64}$/.test(result.claim_token || '')) throw Error('failed');
      claimCode.textContent = result.claim_token;
      claimNotice.hidden = false;
      await watch(result.id, result.token);
    } catch (error) {
      payload.password = '';
      payload.turnstile_token = '';
      resetHumanCheck();
      status.className = 'wizard-notice error';
      status.textContent = 'Nie udało się potwierdzić rozpoczęcia instalacji. Nie próbuj ponownie, jeśli serwer mógł już zostać skonfigurowany; skontaktuj się z administratorem.';
    }
  });
  // The installation job may run for up to 30 minutes (plus readiness checks), so the wizard watches for
  // 45 minutes and treats "still running" and "cannot reach the status" as waiting, never as failure.
  // Only the service saying `failed` is reported as a failure.
  const WATCH_MS = 45 * 60 * 1000;
  const MAX_MISSES = 20;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const leaving = event => { event.preventDefault(); event.returnValue = ''; };
  let current = null;
  async function watch(id, token) {
    current = {id, token};
    checkAgain.hidden = true;
    if (typeof globalThis.addEventListener === 'function') globalThis.addEventListener('beforeunload', leaving);
    try {
      if (await follow(id, token) === 'waiting') {
        status.className = 'wizard-notice';
        status.textContent = 'Instalacja nadal trwa albo chwilowo nie możemy sprawdzić jej stanu — to nie oznacza błędu. Nie zamykaj tej karty i nie wysyłaj formularza ponownie; kod pierwszego uruchomienia jest powyżej.';
        checkAgain.hidden = false;
      }
    } catch (error) {
      claimNotice.hidden = !!(error && error.retrySafe);
      status.className = 'wizard-notice error';
      if (error && error.retrySafe) {
        // The service stopped before touching anything (typically an unreachable host or inconsistent host keys).
        fields.disabled = false;
        current = null;
        status.textContent = 'Nie udało się połączyć z serwerem, a nic nie zostało zmienione. Sprawdź adres, port i dane logowania, wpisz hasło ponownie i spróbuj jeszcze raz.';
      } else {
        status.textContent = error && error.setupFailed
          ? 'Instalacja zatrzymała się w trakcie i mogła zostawić częściowo skonfigurowany serwer. Nie próbuj ponownie — skontaktuj się z administratorem.'
          : 'Instalacja mogła się zakończyć, ale nie możemy potwierdzić adresu aplikacji. Nie próbuj ponownie — skontaktuj się z administratorem.';
      }
    } finally {
      if (typeof globalThis.removeEventListener === 'function') globalThis.removeEventListener('beforeunload', leaving);
    }
  }
  checkAgain.addEventListener('click', () => { if (current) watch(current.id, current.token); });
  async function follow(id, token) {
    let waited = 0;
    let misses = 0;
    while (waited < WATCH_MS) {
      let data = null;
      try {
        const response = await fetch(`${service}/v1/operations/${id}`, {headers: {'Authorization': `Bearer ${token}`}, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10000)});
        if (response.ok) data = await response.json();
      } catch (_) { /* a failed check is not a failed installation */ }
      if (data === null || !['pending', 'failed', 'complete'].includes(data.state)) {
        if (++misses >= MAX_MISSES) return 'waiting';
      } else {
        misses = 0;
        if (data.state === 'failed') { const failure = Error('setup failed'); failure.setupFailed = true; failure.retrySafe = data.retry_safe === true; throw failure; }
        if (data.state === 'complete') {
          const url = new URL(data.app_url);
          if (url.protocol !== 'https:' || !/^frog[0-9]+-[0-9]+\.wykr\.es$/.test(url.hostname) || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('bad url');
          status.className = 'wizard-notice';
          status.textContent = 'Instalacja zakończona. ';
          const link = document.createElement('a');
          link.href = url.href; link.textContent = 'Otwórz swoją aplikację'; link.rel = 'noopener noreferrer';
          status.append(link);
          return 'complete';
        }
        status.className = 'wizard-notice';
        status.textContent = 'Przygotowujemy instalację. Może to potrwać do kilkudziesięciu minut — nie zamykaj tej karty.';
      }
      const delay = waited < 120000 ? 3000 : 10000;
      await wait(delay);
      waited += delay;
    }
    return 'waiting';
  }
})();
