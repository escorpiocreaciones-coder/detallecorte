(() => {
  const valid = ['auto', 'light', 'dark'];
  let mode = 'auto';
  try {
    const stored = localStorage.getItem('control-cortes.theme');
    if (valid.includes(stored)) {
      mode = stored;
    } else {
      const raw = localStorage.getItem('control-cortes.v1');
      if (raw) {
        const data = JSON.parse(raw);
        if (valid.includes(data?.settings?.theme)) mode = data.settings.theme;
      }
    }
  } catch {
    mode = 'auto';
  }
  const dark = mode === 'dark' || (mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
