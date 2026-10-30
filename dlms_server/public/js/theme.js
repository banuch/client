// Theme: "system" (follow the OS), "light" or "dark", kept in this browser.
// Loaded as a plain script in <head> so the page is drawn in the right theme
// from the start. Sets <html data-theme="light|dark"> and fires "themechange".
(function () {
  var KEY = 'amr-theme';
  var media = window.matchMedia('(prefers-color-scheme: dark)');

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch (e) {
      return 'system';
    }
  }

  function apply() {
    var pref = stored();
    var theme = pref === 'system' ? (media.matches ? 'dark' : 'light') : pref;
    if (document.documentElement.dataset.theme === theme) return;
    document.documentElement.dataset.theme = theme;
    document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: theme, pref: pref } }));
  }

  window.amrTheme = {
    get: stored,
    set: function (pref) {
      try {
        if (pref === 'system') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, pref);
      } catch (e) {
        // Private windows may block storage; the choice then lasts for this page only.
      }
      var theme = pref === 'system' ? (media.matches ? 'dark' : 'light') : pref;
      document.documentElement.dataset.theme = theme;
      document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: theme, pref: pref } }));
    },
  };
  media.addEventListener('change', function () { if (stored() === 'system') apply(); });
  apply();
}());
