// Sliding indicator under the active tab. Purely visual: errors here must never disturb the app.
const reduce = matchMedia('(prefers-reduced-motion: reduce)');

function tabInk() {
  const host = document.getElementById('topbar');
  const tabs = document.getElementById('tabs');
  if (!host || !tabs) return;
  const bar = document.createElement('i');
  bar.className = 'tab-ink';
  bar.setAttribute('aria-hidden', 'true');
  host.append(bar);
  document.body.classList.add('has-tab-ink');
  let first = true;
  const place = () => {
    try {
      const a = tabs.querySelector('.tab.active');
      if (!a || !a.offsetParent) { bar.style.opacity = '0'; first = true; return; }
      const hr = host.getBoundingClientRect(); const r = a.getBoundingClientRect();
      // Take the visible part into account in case many tabs fill the bar.
      const tr = tabs.getBoundingClientRect();
      const left = Math.max(r.left, tr.left); const right = Math.min(r.right, tr.right);
      if (first || reduce.matches) bar.style.transition = 'none';
      bar.style.opacity = right > left ? '1' : '0';
      bar.style.width = `${Math.max(0, right - left)}px`;
      bar.style.transform = `translateX(${left - hr.left}px)`;
      if (first || reduce.matches) { void bar.offsetWidth; bar.style.transition = ''; first = false; }
    } catch { /* purely visual */ }
  };
  let raf = 0;
  const later = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };
  new MutationObserver(later).observe(tabs, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  new ResizeObserver(later).observe(host);
  later();
}

tabInk();
