/* kivo landing — animation engine (gsap + scrolltrigger + lenis) */
(() => {
  'use strict';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- live numbers from the backend ---------- */
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const patch = (key, val) =>
    document.querySelectorAll('[data-kivo="' + key + '"]').forEach((el) => (el.textContent = val));
  fetch('/api/meta/knowledge')
    .then((r) => (r.ok ? r.json() : null))
    .then((json) => {
      const s = json && json.stats;
      if (!s) return;
      patch('markers', fmt(s.markers));
      patch('panels', fmt(s.panels));
      patch('aliases', fmt(s.matchableAliases));
      patch('narratives', fmt(s.withCuratedNarrative != null ? s.withCuratedNarrative : s.curatedNarratives));
      patch('curated', fmt(s.curatedMarkers));
    })
    .catch(() => {});

  if (!window.gsap || !window.ScrollTrigger) {
    // vendor failed (offline/blocked): never trap the page behind the loader.
    document.documentElement.classList.add('no-motion');
    const dead = document.getElementById('loader');
    if (dead) dead.remove();
    return;
  }
  gsap.registerPlugin(ScrollTrigger);

  /* ---------- lenis smooth scroll ---------- */
  let lenis = null;
  if (!reduced && window.Lenis) {
    lenis = new Lenis({ duration: 1.15, smoothWheel: true });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((time) => lenis.raf(time * 1000));
    gsap.ticker.lagSmoothing(0);
  }

  const isDesktop = () => window.innerWidth > 1050;

  /* ---------- word swap helper ---------- */
  function makeCycler(el, words, hold, exit) {
    if (!el || reduced) return;
    let i = 0;
    const tick = () => {
      if (document.hidden) return;
      gsap.to(el, {
        yPercent: -120,
        opacity: 0,
        duration: exit,
        ease: 'power2.in',
        onComplete: () => {
          i = (i + 1) % words.length;
          el.textContent = words[i];
          gsap.set(el, { yPercent: 120, opacity: 0 });
          gsap.to(el, { yPercent: 0, opacity: 1, duration: exit + 0.2, ease: 'power3' });
        },
      });
    };
    setInterval(tick, hold);
  }

  /* ---------- preloader ---------- */
  const loader = document.getElementById('loader');
  const heroTitle = gsap.utils.toArray('.hero-titleCarousel, .hero-titleBetter');
  const heroText = document.getElementById('heroText');
  const heroCta = document.querySelector('.hero-cta');
  const heroPhone = document.querySelector('.phone--hero');
  const topNav = document.getElementById('topNav');
  const bottomBar = document.getElementById('bottomBar');

  let heroStarted = false;
  function startHero() {
    if (heroStarted) return;
    heroStarted = true;
    if (reduced) {
      loader && loader.remove();
      gsap.set([...heroTitle, heroText, heroCta, topNav, bottomBar], { opacity: 1, y: 0, yPercent: 0, xPercent: 0, transform: 'none' });
      gsap.set(heroPhone, { opacity: 1 });
      return;
    }
    const sm = window.innerWidth <= 500;
    const md = window.innerWidth <= 650;
    const tl = gsap.timeline();
    tl.set(heroTitle, { yPercent: 120 })
      .set(heroText, { opacity: 0, y: 30 })
      .set(heroCta, { opacity: 0, scale: 0.9 })
      // the stylesheet parks both bars off-screen with translateY(±100%);
      // gsap reads that as a pixel offset, so zero it before tweening yPercent
      // or the bars animate "in" yet stay hidden.
      .set(topNav, { y: 0, yPercent: -100 })
      .set(bottomBar, { y: 0, yPercent: 100 })
      .set(heroPhone, { opacity: 0, y: sm ? 120 : md ? 140 : 240 })
      .to(heroTitle, { yPercent: 0, duration: 1.1, ease: 'power4', stagger: 0.12 })
      .to(heroText, { opacity: 1, y: 0, duration: 0.9, ease: 'power3' }, '-=0.55')
      .to(heroCta, { opacity: 1, scale: 1, duration: 0.7, ease: 'power3' }, '-=0.45')
      .to(heroPhone, { opacity: 1, y: sm ? 50 : md ? 60 : 100, rotation: 0, duration: 1.4, ease: 'power3' }, '-=0.8')
      .to(topNav, { yPercent: 0, duration: 0.9, ease: 'power3' }, '-=0.7')
      .to(bottomBar, { yPercent: 0, duration: 0.9, ease: 'power3' }, '-=0.8');
    makeCycler(document.getElementById('heroCarousel'), ['know', 'see', 'trust'], 2600, 0.5);
    makeCycler(document.getElementById('bottomBarQuote'), ['verify', 'twin', 'trend', 'risk', 'care'], 3200, 0.45);
  }

  if (reduced) {
    startHero();
    gsap.set('.community-list', { opacity: 1, transform: 'none' });
    gsap.set('#quoteList .quote:first-child', { opacity: 1, transform: 'none' });
    gsap.set('.markerCard, .stats-block, .ctaLink', { opacity: 1, transform: 'none' });
    gsap.set('.footer-title span, .footer-col a, .footer-title-sm, .footer-copyright, .appScreen-cta, .appSection-text--two', { opacity: 1, transform: 'none' });
  } else if (loader) {
    const lt = gsap.timeline({ delay: 0.15 });
    const lwords = gsap.utils.toArray('.loader-word');
    lwords.forEach((w, idx) => { if (idx > 0) gsap.set(w, { opacity: 0 }); });
    lt.to('.loader-coverTop', { yPercent: -101, duration: 0.85, ease: 'power4.inOut' }, 0.15)
      .to('.loader-coverBot', { yPercent: 101, duration: 0.85, ease: 'power4.inOut' }, 0.15)
      .to('.loader-numberIndicator, .loader-year', { opacity: 1, duration: 0.35 }, 0.8)
      .to(lwords[0], { opacity: 0, yPercent: -40, duration: 0.3, ease: 'power2.in' }, 1.25)
      .set(lwords[1], { opacity: 1, yPercent: 40 })
      .to(lwords[1], { yPercent: 0, duration: 0.35, ease: 'power2' }, '<')
      .to(lwords[1], { opacity: 0, yPercent: -40, duration: 0.3, ease: 'power2.in' }, 1.8)
      .set(lwords[2], { opacity: 1, yPercent: 40 })
      .to(lwords[2], { yPercent: 0, duration: 0.35, ease: 'power2' }, '<')
      .to('.loader-numberIndicator, .loader-year', { opacity: 0, duration: 0.25 }, 2.35)
      .to('.loader-coverTop', { yPercent: 0, duration: 0.8, ease: 'power4.inOut' }, 2.6)
      .to('.loader-coverBot', { yPercent: 0, duration: 0.8, ease: 'power4.inOut' }, 2.6)
      .to(loader, { yPercent: -100, duration: 0.7, ease: 'power4.in' }, 3.5)
      .add(startHero, 3.6)
      .set(loader, { display: 'none' });
  } else {
    startHero();
  }

  /* fail-safe: never leave the page behind the loader (js error, slow device…) */
  setTimeout(() => {
    if (!heroStarted) startHero();
    const l = document.getElementById('loader');
    if (l && getComputedStyle(l).display !== 'none') l.remove();
  }, 6000);

  /* ---------- scroll progress (bottom bar) ---------- */
  const fill = document.getElementById('scrollFill');
  const pct = document.getElementById('scrollPct');
  if (fill && pct) {
    ScrollTrigger.create({
      start: 0,
      end: 'max',
      onUpdate: (self) => {
        gsap.set(fill, { scaleX: self.progress });
        pct.textContent = Math.round(self.progress * 100) + '%';
      },
    });
  }

  /* ---------- floating cta ---------- */
  const floatCta = document.getElementById('floatingCta');
  if (floatCta) {
    ScrollTrigger.create({
      trigger: '#hero',
      start: 'bottom 40%',
      onEnter: () => floatCta.classList.add('visible'),
      onLeaveBack: () => floatCta.classList.remove('visible'),
    });
  }

  /* ---------- water stick: title fill + capsule white wipe ---------- */
  const waterSection = document.getElementById('waterStick');
  const waterShape = document.querySelector('.waterStick-shape');
  const waterCanvas = document.getElementById('waterCanvas');
  // Hide the canvas wave animation entirely — the capsule itself is the hero
  // of this transition now, expanding into the full-screen white wipe.
  if (waterCanvas) waterCanvas.style.display = 'none';

  if (!reduced && waterSection && waterShape) {
    // The resting capsule is sized by CSS (width ~280px, height ~380px on desktop,
    // smaller on mobile). We start it at a tiny dot scale, grow it to its natural
    // resting capsule size for the text-fill portion of the scroll, then expand
    // vertically → horizontally to cover the viewport and hand off cleanly to the
    // next section which is already on the same #f7f7f7 background.
    const scaleToFullY = () => {
      const h = waterShape.offsetHeight;
      // need to reach (at minimum) the viewport diagonal so corners never show
      return Math.max((window.innerHeight * 1.8) / h, 8);
    };
    const scaleToFullX = () => {
      const w = waterShape.offsetWidth;
      return Math.max((window.innerWidth * 2.2) / w, 12);
    };

    // Start state: tiny centered dot. We let GSAP own the translate + scale so
    // the element is perfectly centered and scaleX/scaleY animate from a known
    // baseline — letting us grow vertically first, then horizontally (SoFi-
    // style pill wipe).
    gsap.set(waterShape, {
      xPercent: -50,
      yPercent: -50,
      scaleX: 0.04,
      scaleY: 0.04,
      transformOrigin: 'center center',
    });

    // Single pinned timeline covering the whole dark→light transition.
    const wsTl = gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: {
        trigger: '#waterStick',
        start: 'top top',
        end: '+=180%',
        scrub: 1,
        pin: true,
        anticipatePin: 1,
        invalidateOnRefresh: true,
      },
    });

    // Phase 1 (0 → 20%): dot grows to its natural resting capsule size
    // (scaleX and scaleY together → rounded capsule, matching the original
    // resting shape the user saw before waves were removed).
    wsTl.to(waterShape, {
      scaleX: 1,
      scaleY: 1,
      ease: 'power2.out',
      duration: 0.2,
    }, 0);

    // Phase 2 (15% → 55%): the statement deliberately stays grey while the
    // icon arrives and the capsule rests behind it.
    wsTl.fromTo('.waterStick-icon',
      { opacity: 0, scale: 0.4 },
      { opacity: 1, scale: 1, duration: 0.2, ease: 'power2.out' },
      0.12
    );

    // Phase 3 (55% → 78%): grow TALL first — capsule stretches vertically past
    // the top and bottom of the viewport while staying narrow.
    wsTl.to(waterShape, {
      scaleY: () => scaleToFullY(),
      ease: 'power2.inOut',
      duration: 0.23,
    }, 0.55);

    // Phase 4 (73% → 95%): grow WIDE — capsule blows out horizontally, covering
    // the viewport completely. Simultaneously fade the text + icon out so the
    // wipe feels clean rather than cutting hard.
    wsTl.to(waterShape, {
      scaleX: () => scaleToFullX(),
      ease: 'power3.inOut',
      duration: 0.22,
    }, 0.73);
    wsTl.to(['.waterStick-icon', '.waterStick-splitedText'], {
      opacity: 0,
      duration: 0.18,
      ease: 'power2.inOut',
    }, 0.75);

    // Phase 5 (92% → 100%): flatten border-radius to 0 so there are no pill
    // edges left once full-screen — seamless hand-off to the next section.
    wsTl.to(waterShape, {
      borderRadius: 0,
      duration: 0.08,
      ease: 'power2.inOut',
    }, 0.92);
  }

  /* ---------- pinned twin section ---------- */
  if (isDesktop()) {
    gsap.set('#twinCircle', { xPercent: -50, yPercent: -50, scale: 0 });
    const featOrder = [
      '.twin-feature--long',
      '.twin-feature--connect',
      '.twin-feature--personal',
      '.twin-feature--plain',
    ];
    const tl = gsap.timeline({
      defaults: { ease: 'none' },
      scrollTrigger: {
        trigger: '#stickWrap',
        start: 'top top',
        end: '+=250%',
        scrub: 1,
        pin: '.twin',
        anticipatePin: 1,
      },
    });
    tl.to('#twinBlackTitle', { x: '-100vw', duration: 1.1 }, 0)
      .to('#twinCircle', { scale: 1, ease: 'power2.inOut', duration: 1.5 }, 0.2)
      .fromTo('.twin-para--one p', { opacity: 0, y: 30 }, { opacity: 1, y: 0, ease: 'power2.out', duration: 0.4 }, 0.55)
      .fromTo('.twin-para--two p', { opacity: 0, y: 30 }, { opacity: 1, y: 0, ease: 'power2.out', duration: 0.4 }, 0.65)
      .to('.twin-para p', { opacity: 0, duration: 0.5, ease: 'power2.in' }, 1.35)
      .fromTo('.twin-strip', { opacity: 0, y: 80 }, { opacity: 1, y: 0, ease: 'power2.out', duration: 0.6 }, 0.85);
    featOrder.forEach((sel, idx) => {
      const at = 0.95 + idx * 0.22;
      const right = idx % 2 === 1; // connect & plain sit on the right edge
      const div = document.querySelector(sel + ' .twin-featureDivider');
      const dist = () => Math.max(0, div.clientWidth - 5);
      tl.to(sel + ' .twin-featureDivider', { scaleX: 1, ease: 'power2.inOut', duration: 0.5 }, at)
        .fromTo(sel + ' .twin-featureDot', { x: 0 }, { x: () => (right ? -1 : 1) * dist(), ease: 'power2.inOut', duration: 0.5 }, at)
        .fromTo(sel + ' .twin-iconHolder', { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, ease: 'back.out(1.6)', duration: 0.35 }, at + 0.15)
        .fromTo(sel + ' h2', { y: 24, opacity: 0 }, { y: 0, opacity: 1, ease: 'power2.out', duration: 0.35 }, at + 0.2)
        .fromTo(sel + ' p', { y: 16, opacity: 0 }, { y: 0, opacity: 1, ease: 'power2.out', duration: 0.35 }, at + 0.28);
    });
  } else {
    gsap.utils.toArray('.twin-para p, .twin-featureElements').forEach((el) => {
      gsap.fromTo(el, { opacity: 0, y: 24 }, {
        opacity: 1, y: 0, duration: 0.7, ease: 'power2.out',
        scrollTrigger: { trigger: el, start: 'top 85%' },
      });
    });
    gsap.set('#twinCircle', { display: 'none' });
  }

  /* ---------- twin story ---------- */
  if (!reduced) {
    gsap.fromTo('.twinStory-illustrationText p', { opacity: 0, y: 24 }, {
      opacity: 1, y: 0, duration: 0.8, ease: 'power3',
      scrollTrigger: { trigger: '#twinStory', start: 'top 60%' },
    });
    gsap.fromTo('.twinStory-titleHolder h2', { yPercent: 110 }, {
      yPercent: 0, duration: 1.3, ease: 'power4',
      scrollTrigger: { trigger: '#twinStory', start: 'top 55%', end: 'top 10%', scrub: 1 },
    });
    gsap.fromTo('.twinStory-illustration', { opacity: 0, scale: 1.12 }, {
      opacity: 1, scale: 1, duration: 1.2, ease: 'power3',
      scrollTrigger: { trigger: '#twinStory', start: 'top 60%' },
    });
    gsap.to('.twinStory-divider', {
      scaleX: 1, duration: 1.1, ease: 'power3.inOut',
      scrollTrigger: { trigger: '.twinStory-information', start: 'top 80%' },
    });
    gsap.fromTo('.twinStory-informationTitle p, .twinStory-informationText p, .twinStory-informationText .ctaLink',
      { opacity: 0, y: 24 },
      { opacity: 1, y: 0, duration: 0.8, ease: 'power3', stagger: 0.12,
        scrollTrigger: { trigger: '.twinStory-information', start: 'top 75%' } });
  }

  /* ---------- marker cards ---------- */
  if (!reduced) {
    gsap.fromTo('.markers-text h2', { yPercent: 110 }, {
      yPercent: 0, duration: 1.1, ease: 'power4',
      scrollTrigger: { trigger: '#markers', start: 'top 70%' },
    });
    gsap.fromTo('.markers-cta p, .markers-cta .ctaLink', { opacity: 0, y: 24 }, {
      opacity: 1, y: 0, duration: 0.8, ease: 'power3', stagger: 0.1,
      scrollTrigger: { trigger: '#markers', start: 'top 65%' },
    });
    gsap.fromTo('.markerCard', { opacity: 0, y: 60 }, {
      opacity: 1, y: 0, duration: 1, ease: 'power3', stagger: 0.14,
      scrollTrigger: { trigger: '.markers-cardHolder', start: 'top 78%' },
    });
  }

  /* ---------- application ---------- */
  if (!reduced) {
    gsap.fromTo('.appSection-title h2', { yPercent: 110 }, {
      yPercent: 0, duration: 1.2, ease: 'power4',
      scrollTrigger: { trigger: '#appSection', start: 'top 65%' },
    });
    gsap.fromTo('.appScreen .phone', { y: 80, opacity: 0 }, {
      y: 0, opacity: 1, duration: 1.1, ease: 'power3',
      scrollTrigger: { trigger: '#appScreensHolder', start: 'top 70%' },
    });
    gsap.fromTo('.appScreen-cta', { y: 40, opacity: 0 }, {
      y: 0, opacity: 1, duration: 0.9, ease: 'power3',
      scrollTrigger: { trigger: '#appScreensHolder', start: 'top 60%' },
    });
    gsap.fromTo('.appSection-text--two', { y: 40, opacity: 0 }, {
      y: 0, opacity: 1, duration: 0.9, ease: 'power3',
      scrollTrigger: { trigger: '#appScreensHolder', start: 'top 55%' },
    });
  }

  /* ---------- learn (title break) ---------- */
  if (!reduced) {
    gsap.fromTo('.learn-wrapper h2', { opacity: 0, scale: 0.92 }, {
      opacity: 1, scale: 1, duration: 1.2, ease: 'power3',
      scrollTrigger: { trigger: '#learnSection', start: 'top 70%' },
    });
    gsap.fromTo('.learn-wrapper p', { opacity: 0, y: 20 }, {
      opacity: 1, y: 0, duration: 0.8, ease: 'power3',
      scrollTrigger: { trigger: '#learnSection', start: 'top 65%' },
    });
  }

  /* ---------- stats grid ---------- */
  if (!reduced) {
    gsap.fromTo('.stats-block', { opacity: 0, y: 44 }, {
      opacity: 1, y: 0, duration: 0.9, ease: 'power3', stagger: 0.09,
      scrollTrigger: { trigger: '#statsSection', start: 'top 75%' },
    });
    gsap.to('.stats-marquee', { xPercent: -50, duration: 22, ease: 'none', repeat: -1 });
  }

  /* ---------- community / quotes ---------- */
  const quotes = gsap.utils.toArray('#quoteList .quote');
  if (quotes.length) {
    let qi = 0;
    let qTimer = null;
    const showQuote = (idx) => {
      qi = (idx + quotes.length) % quotes.length;
      quotes.forEach((q, i) => {
        if (i === qi) gsap.to(q, { scale: 1, opacity: 1, duration: 0.6, ease: 'power3' });
        else gsap.to(q, { scale: 0.8, opacity: 0, duration: 0.4, ease: 'power2.in' });
      });
      if (qTimer) clearInterval(qTimer);
      if (!reduced) qTimer = setInterval(() => showQuote(qi + 1), 4600);
    };
    const startCommunity = () => {
      gsap.to('.community-list', { opacity: 1, scale: 1, duration: 1.1, ease: 'power3', delay: 0.25 });
      showQuote(0);
    };
    if (reduced) {
      gsap.set('.community-list', { opacity: 1, transform: 'none' });
      gsap.set(quotes[0], { opacity: 1, transform: 'none' });
    } else {
      gsap.fromTo('.community-headline h2', { yPercent: 110 }, {
        yPercent: 0, duration: 1.2, ease: 'power4',
        scrollTrigger: { trigger: '#community', start: 'top 70%' },
      });
      gsap.fromTo('.community-headline p', { opacity: 0, y: 20 }, {
        opacity: 1, y: 0, duration: 0.8, ease: 'power3',
        scrollTrigger: { trigger: '#community', start: 'top 65%' },
      });
      ScrollTrigger.create({
        trigger: '#community',
        start: 'top 65%',
        once: true,
        onEnter: startCommunity,
      });
    }
    document.getElementById('quoteNext').addEventListener('click', () => showQuote(qi + 1));
    document.getElementById('quotePrev').addEventListener('click', () => showQuote(qi - 1));
  }

  /* ---------- footer ---------- */
  if (!reduced) {
    gsap.utils.toArray('.footer-title p').forEach((el, i) => {
      gsap.fromTo(el, { yPercent: 115, opacity: 0 }, {
        yPercent: 0, opacity: 1, duration: 1.2, ease: 'power3.out',
        scrollTrigger: {
          trigger: el,
          start: 'top 94%',
          end: 'top 58%',
          scrub: 0.65,
        },
      });
    });
    gsap.fromTo('.footer-title span', { opacity: 0, y: 10 }, {
      opacity: 1, y: 0, duration: 0.8, ease: 'power2.out', stagger: 0.08,
      scrollTrigger: { trigger: '.footer-titles', start: 'top 78%', toggleActions: 'play none none reverse' },
    });
    gsap.to('.footer-divider--one', {
      scaleX: 1, duration: 1.1, ease: 'power3.inOut',
      scrollTrigger: { trigger: '.footer-bottom', start: 'top 80%' },
    });
    gsap.to('.footer-divider--two', {
      scaleX: 1, duration: 1.1, ease: 'power3.inOut',
      scrollTrigger: { trigger: '.footer-bottom', start: 'top 55%' },
    });
    gsap.fromTo('.footer-col .footer-title-sm, .footer-col a', { opacity: 0, y: 20 }, {
      opacity: 1, y: 0, duration: 0.7, ease: 'power3', stagger: 0.05,
      scrollTrigger: { trigger: '.footer-bottom', start: 'top 75%' },
    });
    gsap.fromTo('.footer-copyright', { opacity: 0 }, {
      opacity: 1, duration: 0.8,
      scrollTrigger: { trigger: '.footer-bottom', start: 'top 60%' },
    });
  }

  /* ---------- refresh after assets ---------- */
  window.addEventListener('load', () => ScrollTrigger.refresh());
})();
