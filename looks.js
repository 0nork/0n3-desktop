// THE LOOK (0.9.0, Mike 2026-11-25): the colour themes and the corner-icon choices, shared by the app window (app.html)
// and the corner bubble (bubble.html). ONE list of each: Settings draws its choices from here and both windows paint from
// here, so a theme or an icon is added in this file and nowhere else. The choice itself is kept by the main process
// (~/.0n/desk/look.json) and sent to both windows; localStorage only holds a copy so the first paint is already right.
(() => {
  // bg = the window, rgb = the accent, rgb2 = the second glow behind the glass, deep = the accent's dark partner.
  const THEMES = {
    green: { name: '0n3 Green', bg: '#0a0d0a', rgb: '126,217,87', rgb2: '31,181,160', deep: '#408b1f', mut: '#93a093' },
    ember: { name: 'Ember', bg: '#0f0b09', rgb: '255,107,53', rgb2: '255,179,71', deep: '#b8431a', mut: '#a39a94' },
    ocean: { name: 'Ocean', bg: '#070c12', rgb: '56,189,248', rgb2: '99,102,241', deep: '#0b78b8', mut: '#8f9bab' },
    violet: { name: 'Violet', bg: '#0c0912', rgb: '167,139,250', rgb2: '236,72,153', deep: '#6d3fd6', mut: '#9c95ab' },
    rose: { name: 'Rose', bg: '#110a0d', rgb: '251,113,133', rgb2: '245,158,11', deep: '#c0304d', mut: '#a8969b' },
    gold: { name: 'Gold', bg: '#0e0c07', rgb: '250,204,21', rgb2: '249,115,22', deep: '#a8820a', mut: '#a39f90' },
    graphite: { name: 'Graphite', bg: '#0b0b0c', rgb: '229,231,235', rgb2: '100,116,139', deep: '#8b8f98', mut: '#9a9ca3' },
  };
  // 24 × 24, drawn with the accent colour. `grid` is the 0n3 mark itself (assets/bubble.png), so it has no drawing here.
  const S = 'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"';
  const ICONS = {
    grid: { name: '0n3', svg: '' },
    spark: { name: 'Spark', svg: '<path fill="currentColor" d="M12 2l2.3 7.7L22 12l-7.7 2.3L12 22l-2.3-7.7L2 12l7.7-2.3z"/>' },
    bolt: { name: 'Bolt', svg: '<path fill="currentColor" d="M13.5 2L4.5 13.5h6L9.5 22l10-12.5h-6.5z"/>' },
    chat: { name: 'Chat', svg: `<path ${S} d="M20.5 11.5a8 8 0 0 1-11.7 7.1L4 20l1.4-4.4A8 8 0 1 1 20.5 11.5z"/><path ${S} d="M9 11.5h.01M12.5 11.5h.01M16 11.5h.01"/>` },
    prompt: { name: 'Prompt', svg: `<path ${S} d="M5 7.5l5 4.5-5 4.5M12.5 17h6.5"/>` },
    rocket: { name: 'Rocket', svg: `<path ${S} d="M12 2.5c3 2.4 4.5 5.7 4.5 9.6l2 3.1-2.3.6-.9 3.2H8.7l-.9-3.2-2.3-.6 2-3.1c0-3.9 1.500-7.200 4.500-9.600z"/><circle ${S} cx="12" cy="10" r="1.7"/><path ${S} d="M10.5 21.500h3"/>` },
    orbit: { name: 'Orbit', svg: `<circle cx="12" cy="12" r="2.4" fill="currentColor"/><ellipse ${S} cx="12" cy="12" rx="9.5" ry="4" transform="rotate(-35 12 12)"/><ellipse ${S} cx="12" cy="12" rx="9.5" ry="4" transform="rotate(35 12 12)"/>` },
    robot: { name: 'Robot', svg: `<rect ${S} x="4.500" y="8" width="15" height="11" rx="3.200"/><path ${S} d="M12 8V4.800M9.300 13.200v1.100M14.700 13.200v1.100M2.500 12.500v3M21.500 12.500v3"/><circle cx="12" cy="3.600" r="1.400" fill="currentColor"/>` },
    hex: { name: 'Hex', svg: `<path ${S} d="M12 2.500l8.200 4.750v9.500L12 21.500l-8.200-4.750v-9.500z"/><circle cx="12" cy="12" r="2.600" fill="currentColor"/>` },
  };
  const DEFAULT = { theme: 'green', icon: 'grid' };
  const KEY = '0n3.look';
  const clean = (o) => ({ theme: THEMES[o && o.theme] ? o.theme : DEFAULT.theme, icon: ICONS[o && o.icon] ? o.icon : DEFAULT.icon });
  const read = () => { try { return clean(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch (e) { return { ...DEFAULT }; } };
  const hex = (rgb) => `#${rgb.split(',').map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  /** Paint this window with a look. Returns the cleaned look (an unknown theme or icon falls back to the default). */
  function apply(o) {
    const look = clean(o); const t = THEMES[look.theme]; const r = document.documentElement.style;
    r.setProperty('--bg', t.bg); r.setProperty('--rgb', t.rgb); r.setProperty('--rgb2', t.rgb2);
    r.setProperty('--neon', hex(t.rgb)); r.setProperty('--deep', t.deep); r.setProperty('--mut', t.mut);
    document.documentElement.dataset.theme = look.theme;
    try { localStorage.setItem(KEY, JSON.stringify(look)); } catch (e) { /* a private window: the main process still has it */ }
    return look;
  }
  const icon = (id) => (ICONS[id] && ICONS[id].svg ? `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[id].svg}</svg>` : '');
  /** The small picture of a theme on its Settings card: the same two glows the window gets. */
  const preview = (id) => { const t = THEMES[id]; return `background:radial-gradient(90% 120% at 0% 0%,rgba(${t.rgb},.55),transparent 60%),radial-gradient(90% 120% at 100% 100%,rgba(${t.rgb2},.45),transparent 62%),${t.bg}`; };
  window.LOOKS = { THEMES, ICONS, DEFAULT, clean, read, apply, icon, preview, hex };
  apply(read());
})();
