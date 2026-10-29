// Sign-in page (login.html): POST /auth/login sets the session cookie, then
// the dashboard opens. Same behaviour as the OTA console's sign-in dialog.
(() => {
  const dlg = document.getElementById('dlg');
  const form = document.getElementById('form');
  const err = document.getElementById('err');
  const btn = document.getElementById('btn');
  const pw = form.password;
  let lockTimer = null;

  dlg.showModal();
  // Escape must not close the dialog: there is nothing behind it. Browsers
  // may ignore preventDefault on cancel, so reopen it if it closes anyway.
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  dlg.addEventListener('close', () => {
    dlg.showModal();
    form.username.focus();
  });

  // Already signed in (or no password set)? Go straight to the dashboard.
  fetch('auth/me').then((r) => { if (r.ok) location.replace('./'); }).catch(() => {});

  document.getElementById('toggle').addEventListener('click', (e) => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Hide' : 'Show';
    e.currentTarget.setAttribute('aria-pressed', String(show));
    pw.focus();
  });
  const caps = document.getElementById('caps');
  for (const type of ['keydown', 'keyup']) {
    pw.addEventListener(type, (e) => caps.classList.toggle('hidden', !e.getModifierState?.('CapsLock')));
  }
  pw.addEventListener('blur', () => caps.classList.add('hidden'));

  function showError(text) {
    err.textContent = text;
    err.classList.remove('hidden', 'shake');
    void err.offsetWidth;   // restart the shake animation
    err.classList.add('shake');
  }

  function busy(on) {
    btn.disabled = on;
    btn.innerHTML = on ? '<span class="spinner" aria-hidden="true"></span>Signing in…' : 'Sign in';
  }

  // Locked out: count down and keep the button disabled until it ends.
  function lockout(seconds) {
    clearInterval(lockTimer);
    let left = seconds;
    const tick = () => {
      if (left <= 0) {
        clearInterval(lockTimer);
        err.classList.add('hidden');
        btn.disabled = false;
        return;
      }
      const m = Math.floor(left / 60), s = left % 60;
      err.textContent = `Too many failed attempts. Try again in ${m ? `${m} min ` : ''}${s} s.`;
      btn.disabled = true;
      left--;
    };
    showError('');
    tick();
    lockTimer = setInterval(tick, 1000);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = form.username.value.trim();
    if (!username || !pw.value) {
      showError('Enter your username and password.');
      (username ? pw : form.username).focus();
      return;
    }
    err.classList.add('hidden');
    busy(true);
    let locked = false;
    try {
      const res = await fetch('auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AMR-Data': '1' },
        body: JSON.stringify({ username, password: pw.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        btn.textContent = 'Signed in';
        return location.replace('./');
      }
      if (data.error === 'locked') {
        locked = true;
        lockout(data.retry_after_s || 60);
      } else {
        showError('Wrong username or password.');
      }
      pw.value = '';
      pw.focus();
    } catch (_) {
      showError('Server not reachable. Check the connection and try again.');
    } finally {
      if (!locked) busy(false);
      else btn.innerHTML = 'Sign in';
    }
  });
})();
