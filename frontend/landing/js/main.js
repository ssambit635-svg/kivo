/* kivo landing — animation engine (gsap + scrolltrigger + lenis) */
(() => {
  'use strict';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- the page's data layer --------------------------------------
   * Every figure, name, LOINC code and reference range on this page comes from
   * the two public knowledge catalogues:
   *
   *   knowledge   — what the catalogue contains, its sources, and how well the
   *                 extraction confidence is calibrated
   *   dictionary  — the markers themselves (names, units, panels,
   *                 hand-checked ranges, LOINC codes)
   *
   * Nothing is typed in by hand, so the page can never drift from the product.
   * If the data cannot be reached the placeholders stay as "—" — we would
   * rather show nothing than invent a number.
   */
  const num = (n) => Number(n).toLocaleString('en-US');
  const patch = (key, val) =>
    document.querySelectorAll('[data-kivo="' + key + '"]').forEach((el) => { el.textContent = val; });

  /** "HbA1c (Glycated Hemoglobin)" → "HbA1c" */
  const shortName = (name) => String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  /** "LDL Cholesterol" → "ldl" — the label style this page is set in. */
  const markerLabel = (name) => shortName(name).split(/\s+/)[0].toLowerCase();

  /** A dictionary entry's reference range, phrased the way a person would say it. */
  function rangeText(entry) {
    const r = entry && entry.typicalRange;
    const unit = (r && r.unit) || (entry && entry.defaultUnit) || '';
    if (!r || (r.low == null && r.high == null)) return null;
    if (r.low == null) return 'up to ' + num(r.high) + ' ' + unit;
    if (r.high == null) return 'at least ' + num(r.low) + ' ' + unit;
    return num(r.low) + ' – ' + num(r.high) + ' ' + unit;
  }

  function panelNames(knowledge) {
    const out = {};
    const panels = knowledge && knowledge.panels;
    if (panels) Object.keys(panels).forEach((k) => { if (panels[k]) out[panels[k].key] = panels[k].name; });
    return out;
  }

  /** Catalogue size, coverage and calibration — the "numbers" section. */
  function applyKnowledge(knowledge) {
    const s = knowledge && knowledge.stats;
    if (!s) return;
    patch('markers', num(s.markers));
    patch('panels', num(s.panels));
    patch('aliases', num(s.matchableAliases));
    patch('core', num(s.coreMarkers));
    if (Number.isFinite(s.loincCoverage)) {
      patch('loinc', (Math.round(s.loincCoverage * 1000) / 10).toFixed(1).replace(/\.0$/, '') + '%');
    }
    const heldOut = knowledge.calibration && knowledge.calibration.metrics && knowledge.calibration.metrics.heldOut;
    if (heldOut && Number.isFinite(heldOut.brier)) patch('calibration', Number(heldOut.brier).toFixed(2));
  }

  /** Marker cards + the twin's value strip, straight from the dictionary. */
  function applyDictionary(dictionary, knowledge) {
    const markers = dictionary && dictionary.markers;
    if (!markers) return;
    const names = panelNames(knowledge);
    const panel = (key) => names[key] || String(key || '').replace(/_/g, ' ');

    document.querySelectorAll('.markerCard').forEach((card) => {
      const entry = markers[card.getAttribute('data-marker')];
      if (!entry) return;
      const set = (sel, text) => {
        const node = card.querySelector(sel);
        if (node && text) node.textContent = text;
      };
      set('[data-marker-name]', markerLabel(entry.name));
      set('[data-marker-loinc]', entry.loinc ? 'loinc// ' + entry.loinc : 'no loinc code');
      set('[data-marker-panel]', panel(entry.panel).toLowerCase());
      set('[data-marker-range]', rangeText(entry) || 'as printed on your report');
      set('[data-marker-direction]', entry.betterDirection
        ? entry.betterDirection + ' is better'
        : 'read against your own report');
    });

    // The two mock phone screens show the SAME dictionary entries: a reference
    // range the catalogue actually holds, never an invented patient value.
    document.querySelectorAll('[data-ph-name]').forEach((node) => {
      const entry = markers[node.getAttribute('data-ph-name')];
      if (entry) node.textContent = markerLabel(entry.name);
    });
    document.querySelectorAll('[data-ph-value]').forEach((node) => {
      const entry = markers[node.getAttribute('data-ph-value')];
      if (entry) node.textContent = rangeText(entry) || 'as printed on your report';
    });
    document.querySelectorAll('[data-ph-note]').forEach((node) => {
      const entry = markers[node.getAttribute('data-ph-note')];
      if (entry) {
        node.textContent = entry.rangeSource === 'curated-prototype' ? 'hand-checked range' : "your report's range";
      }
    });

    document.querySelectorAll('[data-strip]').forEach((row) => {
      const entry = markers[row.getAttribute('data-strip')];
      if (!entry) return;
      const set = (sel, text) => {
        const node = row.querySelector(sel);
        if (node && text) node.textContent = text;
      };
      set('[data-strip-name]', markerLabel(entry.name));
      set('[data-strip-range]', rangeText(entry) || "your report's range");
      set('[data-strip-loinc]', entry.loinc || '—');
    });
  }

  function loadProductData() {
    const knowledge = fetch('/api/meta/knowledge')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const dictionary = fetch('/api/meta/lab-dictionary')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    return Promise.all([knowledge, dictionary]).then(([k, d]) => {
      if (k) applyKnowledge(k);
      if (d) applyDictionary(d, k);
      document.dispatchEvent(new CustomEvent('kivo:data', { detail: { knowledge: k, dictionary: d } }));
    });
  }
  loadProductData();

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

  const isDesktop = () => window.innerWidth >= 600;

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
  /* Opening brand film: flips the loader to its dark palette while it plays,
     fades back when it ends. Reduced-motion users never see it (the loader
     itself is removed below), and every failure path keeps it harmless. */
  const film = document.querySelector('.loader-video');
  if (loader && film && !reduced) {
    film.addEventListener('playing', () => loader.classList.add('has-film'));
    const filmOver = () => loader.classList.add('film-done');
    film.addEventListener('ended', filmOver);
    film.addEventListener('error', filmOver);
    const fp = film.play && film.play();
    if (fp && fp.catch) fp.catch(filmOver);
    setTimeout(filmOver, 6000); // the film never outstays the word timeline
  }
  const heroTitle = gsap.utils.toArray('.hero-titleCarousel, .hero-titleBetter');
  const heroText = document.getElementById('heroText');
  // Both hero buttons live in .hero-ctaGroup: the primary CTA and the APK
  // download button. Animating them as one set keeps the intro (and the
  // hero parallax below) in sync — animating .hero-cta alone left the APK
  // button sitting at full opacity while everything else faded in.
  const heroCta = document.querySelectorAll('.hero-cta, .hero-apkBtn');
  const heroHand = document.querySelector('.hero-hand');
  const topNav = document.getElementById('topNav');
  const bottomBar = document.getElementById('bottomBar');

  /** Length of the intro timeline, so the fail-safe can never cut it short. */
  let loaderDuration = null;

  let heroStarted = false;
  function startHero() {
    if (heroStarted) return;
    heroStarted = true;
    if (reduced) {
      loader && loader.remove();
      gsap.set([...heroTitle, heroText, ...heroCta, topNav, bottomBar], { opacity: 1, y: 0, yPercent: 0, xPercent: 0, transform: 'none' });
      gsap.set(heroHand, { opacity: 1 });
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
      .set(heroHand, { opacity: 0, y: sm ? 120 : md ? 140 : 240 })
      .to(heroTitle, { yPercent: 0, duration: 1.1, ease: 'power4', stagger: 0.12 })
      .to(heroText, { opacity: 1, y: 0, duration: 0.9, ease: 'power3' }, '-=0.55')
      .to(heroCta, { opacity: 1, scale: 1, duration: 0.7, ease: 'power3' }, '-=0.45')
      .to(heroHand, { opacity: 1, y: sm ? 50 : md ? 60 : 100, rotation: 0, duration: 1.4, ease: 'power3' }, '-=0.8')
      .to(topNav, { yPercent: 0, duration: 0.9, ease: 'power3' }, '-=0.7')
      .to(bottomBar, { yPercent: 0, duration: 0.9, ease: 'power3' }, '-=0.8');
    const isMob = window.innerWidth <= 767;
    const heroCarEl = document.getElementById('heroCarousel');
    if (isMob && heroCarEl) heroCarEl.textContent = 'see';
    makeCycler(heroCarEl, isMob ? ['see', 'know', 'trust'] : ['know', 'see', 'trust'], 2600, 0.5);
    makeCycler(document.getElementById('bottomBarQuote'), ['verify', 'twin', 'trend', 'risk', 'care'], 3200, 0.45);
  }

  if (reduced) {
    startHero();
    gsap.set('.community-list', { opacity: 1, transform: 'none' });
    gsap.set('#quoteList .quote:first-child', { opacity: 1, transform: 'none' });
    gsap.set('.markerCard, .stats-block, .ctaLink', { opacity: 1, transform: 'none' });
    gsap.set('.footer-col a, .footer-title-sm, .footer-copyright, .appScreen-cta, .appSection-text--two', { opacity: 1, transform: 'none' });
  } else if (loader) {
    // Tap, click, or scroll instantly lifts preloader so previewers never wait
    const dismissLoader = () => {
      if (!heroStarted) startHero();
      loader.style.display = 'none';
    };
    loader.addEventListener('click', dismissLoader);
    window.addEventListener('wheel', dismissLoader, { once: true, passive: true });
    window.addEventListener('touchstart', dismissLoader, { once: true, passive: true });

    if (window.innerWidth <= 767) {
      startHero();
      loader.style.display = 'none';
    } else {
      loaderDuration = runLoader();
    }
  } else {
    startHero();
  }

  /**
   * Preloader — paced to be read, not blinked through.
   *
   * Each beat is deliberate: a short hold on the closed covers (which also
   * covers webfont settling), the covers split, then one word at a time slides
   * up through the mask and rests long enough to actually be read (~1.4s per
   * word), the index counts 001 → 003, and the whole overlay lifts away as the
   * hero starts underneath it.
   *
   * The words share a single grid cell (see .loader-textHolder), so swapping
   * them can neither resize nor clip the mask.
   */
  function runLoader() {
    const words = gsap.utils.toArray('.loader-word');
    const count = document.getElementById('loaderCount');
    const numbers = ['001', '002', '003'];

    // Pacing, in seconds. Tuned slow + smooth on purpose.
    const BEAT = 0.45;       // hold on the closed covers before they split
    const OPEN = 0.85;       // covers split apart
    const FIRST = 2.1;       // first word starts leaving (word 1 rests before)
    const STEP = 2.0;        // one full word cycle
    const OUT = 0.55;        // masked slide-out
    const IN = 0.75;         // masked slide-in
    const LEAD = 0.3;        // next word starts rising before the old one is gone
    const REST = 0.7;        // last word rests before the covers close
    const CLOSE = 0.9;       // covers close again
    const LIFT = 0.85;       // overlay lifts off the hero

    gsap.set(words, { opacity: 0, yPercent: 46 });
    gsap.set(words[0], { opacity: 1, yPercent: 0 });

    const tl = gsap.timeline({
      delay: 0.1,
      onComplete: () => {
        loader.style.display = 'none';
      },
    });

    tl.to('.loader-coverTop', { yPercent: -101, duration: OPEN, ease: 'power2.inOut' }, BEAT)
      .to('.loader-coverBot', { yPercent: 101, duration: OPEN, ease: 'power2.inOut' }, BEAT)
      .to('.loader-numberIndicator, .loader-year', { opacity: 1, duration: 0.6, ease: 'power1.out' }, BEAT + OPEN * 0.6);

    for (let i = 0; i < words.length - 1; i += 1) {
      const at = FIRST + i * STEP;
      tl.to(words[i], { opacity: 0, yPercent: -46, duration: OUT, ease: 'power2.in' }, at)
        .fromTo(
          words[i + 1],
          { opacity: 0, yPercent: 46 },
          { opacity: 1, yPercent: 0, duration: IN, ease: 'power3.out' },
          at + LEAD,
        )
        .add(() => {
          if (count) count.textContent = numbers[i + 1] || numbers[numbers.length - 1];
        }, at + LEAD);
    }

    // When the last word has fully arrived, hold it for a beat, then close.
    const settled = FIRST + STEP * (words.length - 2) + LEAD + IN;
    const closing = settled + REST;

    tl.to('.loader-numberIndicator, .loader-year', { opacity: 0, duration: 0.45, ease: 'power1.in' }, closing - 0.2)
      .to('.loader-coverTop', { yPercent: 0, duration: CLOSE, ease: 'power2.inOut' }, closing)
      .to('.loader-coverBot', { yPercent: 0, duration: CLOSE, ease: 'power2.inOut' }, closing)
      .add(startHero, closing + 0.15)
      .to(loader, { yPercent: -100, duration: LIFT, ease: 'power2.inOut' }, closing + CLOSE * 0.85);

    return tl.duration();
  }

  /* fail-safe: never leave the page behind the loader (js error, slow device…).
     Derived from the real timeline length +2s, so slowing the intro down can
     never make this fire in the middle of it. */
  const loaderBudget = (typeof loaderDuration === 'number' ? loaderDuration + 2 : 9) * 1000;
  setTimeout(() => {
    if (!heroStarted) startHero();
    const l = document.getElementById('loader');
    if (l && getComputedStyle(l).display !== 'none') l.remove();
  }, loaderBudget);

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

  /* ---------- mobile drawer navigation ---------- */
  const menuToggle = document.getElementById('menuToggle');
  const menuClose = document.getElementById('menuClose');
  const mobileDrawer = document.getElementById('mobileDrawer');
  const mobileDrawerBackdrop = document.getElementById('mobileDrawerBackdrop');

  function openMobileMenu() {
    if (!mobileDrawer) return;
    mobileDrawer.classList.add('is-open');
    mobileDrawer.setAttribute('aria-hidden', 'false');
    if (menuToggle) {
      menuToggle.classList.add('is-active');
      menuToggle.setAttribute('aria-expanded', 'true');
    }
    document.body.style.overflow = 'hidden';
  }

  function closeMobileMenu() {
    if (!mobileDrawer) return;
    mobileDrawer.classList.remove('is-open');
    mobileDrawer.setAttribute('aria-hidden', 'true');
    if (menuToggle) {
      menuToggle.classList.remove('is-active');
      menuToggle.setAttribute('aria-expanded', 'false');
    }
    document.body.style.overflow = '';
  }

  if (menuToggle) {
    menuToggle.addEventListener('click', () => {
      const isOpen = mobileDrawer && mobileDrawer.classList.contains('is-open');
      if (isOpen) closeMobileMenu();
      else openMobileMenu();
    });
  }
  if (menuClose) menuClose.addEventListener('click', closeMobileMenu);
  if (mobileDrawerBackdrop) mobileDrawerBackdrop.addEventListener('click', closeMobileMenu);
  document.querySelectorAll('.mobileDrawer-link, .mobileDrawer-ctaBtn').forEach((el) => {
    el.addEventListener('click', closeMobileMenu);
  });

  /* ---------- responsive GSAP ScrollTrigger engine ---------- */
  ScrollTrigger.matchMedia({
    // Desktop, Laptop & Sandbox Preview (>= 600px):
    // Pinned weave (live threads) right after the home page + pinned twin
    "(min-width: 600px)": function() {
      if (!reduced) {
        // Hero parallax depth as user scrolls
        gsap.to('#heroHand', {
          yPercent: 18,
          ease: 'none',
          scrollTrigger: {
            trigger: '#hero',
            start: 'top top',
            end: 'bottom top',
            scrub: 1,
          },
        });

        // 1. The weave — pinned glowing-threads interlude (was the circle
        //    opening), pure lines: no copy, no chips. The live canvas runs
        //    itself (threads.js); scroll only morphs the weave via
        //    KivoThreads.setScroll — strands rise, multiply and tighten
        //    while the section is held.
        ScrollTrigger.create({
          trigger: '#weaveSection',
          start: 'top top',
          end: '+=150%',
          pin: true,
          anticipatePin: 1,
          onUpdate: (self) => {
            const weave = window.KivoThreads && window.KivoThreads.get();
            if (weave) weave.setScroll(Math.max(0, (self.progress - 0.18) / 0.82));
          },
        });
      }

      // 2. Pinned twin section right after the weave
      gsap.set('#twinCircle', { xPercent: -50, yPercent: -50, scale: 0, display: 'block' });
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
        const right = idx % 2 === 1;
        const div = document.querySelector(sel + ' .twin-featureDivider');
        const dist = () => Math.max(0, div ? div.clientWidth - 5 : 100);
        tl.to(sel + ' .twin-featureDivider', { scaleX: 1, ease: 'power2.inOut', duration: 0.5 }, at)
          .fromTo(sel + ' .twin-featureDot', { x: 0 }, { x: () => (right ? -1 : 1) * dist(), ease: 'power2.inOut', duration: 0.5 }, at)
          .fromTo(sel + ' .twin-iconHolder', { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, ease: 'back.out(1.6)', duration: 0.35 }, at + 0.15)
          .fromTo(sel + ' h2', { y: 24, opacity: 0 }, { y: 0, opacity: 1, ease: 'power2.out', duration: 0.35 }, at + 0.2)
          .fromTo(sel + ' p', { y: 16, opacity: 0 }, { y: 0, opacity: 1, ease: 'power2.out', duration: 0.35 }, at + 0.28);
      });
    },

    // Mobile (< 600px): pinned weave + unpinned readable cards
    "(max-width: 599px)": function() {
      if (reduced) return;

      // Section 2: Mobile Hero Intro Entrance
      gsap.fromTo('.mobileHero-headline span',
        { opacity: 0, y: 24 },
        { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out', stagger: 0.12, delay: 0.15 }
      );
      gsap.fromTo('.mobileHero-sub, .mobileHero-meta, .mobileHero-footer',
        { opacity: 0 },
        { opacity: 1, duration: 0.6, ease: 'power2.out', delay: 0.5 }
      );

      // Section 3: Mobile SCAN Section Entrance
      gsap.fromTo('.mobileScan-title',
        { opacity: 0, scale: 0.92 },
        {
          opacity: 1, scale: 1, duration: 0.85, ease: 'power3.out',
          scrollTrigger: { trigger: '#mobileScan', start: 'top 75%' }
        }
      );
      gsap.fromTo('.mobileScan-metaTop, .mobileScan-metaBot, .mobileScan-caption',
        { opacity: 0 },
        {
          opacity: 1, duration: 0.6, ease: 'power2.out',
          scrollTrigger: { trigger: '#mobileScan', start: 'top 75%' }
        }
      );

      // Section 4: The weave — pinned threads interlude, pure lines: no
      // copy, no chips. On touch the finger itself steers the pinch point
      // (threads.js pointer events).
      ScrollTrigger.create({
        trigger: '#weaveSection',
        start: 'top top',
        end: '+=120%',
        pin: true,
        anticipatePin: 1,
        onUpdate: (self) => {
          const weave = window.KivoThreads && window.KivoThreads.get();
          if (weave) weave.setScroll(Math.max(0, (self.progress - 0.2) / 0.8));
        },
      });

      // Section 5: Mobile Intelligence Twin Section
      gsap.utils.toArray('.twin-para p, .twin-featureElements').forEach((el) => {
        gsap.fromTo(el, { opacity: 0, y: 20 }, {
          opacity: 1, y: 0, duration: 0.6, ease: 'power2.out',
          scrollTrigger: { trigger: el, start: 'top 88%' },
        });
      });
      gsap.fromTo('.twin-strip', { opacity: 0, y: 30 }, {
        opacity: 1, y: 0, duration: 0.7, ease: 'power2.out',
        scrollTrigger: { trigger: '.twin-videoHolder', start: 'top 85%' }
      });
    }
  });

  /* ---------- twin story ---------- */
  if (!reduced) {
    gsap.fromTo('.twinStory-illustrationText p', { opacity: 0, y: 24 }, {
      opacity: 1, y: 0, duration: 0.8, ease: 'power3',
      scrollTrigger: { trigger: '#twinStory', start: 'top 60%' },
    });
    // Horizontal background text moving right to left
    gsap.fromTo('#twinStoryTitleHolder', { x: '12vw' }, {
      x: '-12vw',
      ease: 'none',
      scrollTrigger: {
        trigger: '#twinStory',
        start: 'top bottom',
        end: 'bottom top',
        scrub: 0.8,
      },
    });
    gsap.fromTo('.twinStory-illustration', { opacity: 0, scale: 0.94 }, {
      opacity: 1, scale: 1, duration: 1.2, ease: 'power3.out',
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
