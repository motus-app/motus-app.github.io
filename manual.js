// User manual: contents highlight, mobile contents toggle, copy buttons, screenshot zoom.
(() => {
  const nav = document.querySelector('.nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Highlight the section being read.
  const links = [...document.querySelectorAll('.toc a')];
  const byId = new Map(links.map(a => [a.getAttribute('href').slice(1), a]));
  const secs = [...document.querySelectorAll('.doc section[id]')];
  const spy = () => {
    let cur = secs[0];
    for (const s of secs) if (s.getBoundingClientRect().top < 140) cur = s;
    links.forEach(a => a.classList.remove('on'));
    const a = cur && byId.get(cur.id);
    if (a) a.classList.add('on');
  };
  window.addEventListener('scroll', spy, { passive: true });
  spy();

  const toc = document.querySelector('.toc');
  const tog = document.querySelector('.toc-toggle');
  tog.addEventListener('click', () => {
    toc.classList.toggle('open');
    tog.setAttribute('aria-expanded', toc.classList.contains('open'));
  });
  links.forEach(a => a.addEventListener('click', () => toc.classList.remove('open')));

  // Copy buttons.
  const toast = document.getElementById('toast');
  let tt;
  const say = msg => {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(tt);
    tt = setTimeout(() => toast.classList.remove('show'), 1800);
  };
  document.querySelectorAll('.copy').forEach(b => b.addEventListener('click', async () => {
    const text = b.closest('.snip').querySelector('code').textContent;
    try {
      await navigator.clipboard.writeText(text);
      say('Copied to the clipboard');
    } catch {
      say('Copy failed: select the text and copy it by hand');
    }
  }));

  // Click a screenshot to see it full size.
  const box = document.getElementById('lightbox');
  const big = box.querySelector('img');
  document.querySelectorAll('figure.fig .frame').forEach(f => f.addEventListener('click', () => {
    const img = f.querySelector('img');
    big.src = img.src;
    big.alt = img.alt;
    box.classList.add('show');
  }));
  box.addEventListener('click', () => box.classList.remove('show'));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') box.classList.remove('show'); });
})();
