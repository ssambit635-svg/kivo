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
    const mobile = window.innerWidth <= 767;
    const tl = gsap.timeline();
    tl.set(heroTitle, { yPercent: 120 })
      .set(heroText, { opacity: 0, y: 30 })
      .set(heroCta, { opacity: 0, scale: 0.9 })
      // the stylesheet parks both bars off-screen with translateY(±100%);
      // gsap reads that as a pixel offset, so zero it before tweening yPercent
      // or the bars animate "in" yet stay hidden.
      .set(topNav, { y: 0, yPercent: -100 })
      .set(bottomBar, { y: 0, yPercent: 100 })
      .set(heroHand, { opacity: 0, y: mobile ? 90 : sm ? 120 : md ? 140 : 240 })
      .to(heroTitle, { yPercent: 0, duration: 1.1, ease: 'power4', stagger: 0.12 })
      .to(heroText, { opacity: 1, y: 0, duration: 0.9, ease: 'power3' }, '-=0.55')
      .to(heroCta, { opacity: 1, scale: 1, duration: 0.7, ease: 'power3' }, '-=0.45')
      // on mobile the hand rests exactly on its CSS position (it sits in flow
      // below the title); desktop keeps its composed offset.
      .to(heroHand, { opacity: 1, y: mobile ? 0 : sm ? 50 : md ? 60 : 100, rotation: 0, duration: 1.4, ease: 'power3' }, '-=0.8')
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
    gsap.set('.footer-col a, .footer-title-sm, .footer-copyright, .appScreen-cta, .appSection-text--two', { opacity: 1, transform: 'none' });
  } else if (loader) {
    loaderDuration = runLoader();
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

  /* ---------- scroll progress (bottom bar) ----------
     Desktop-only: on the phone the bar is replaced by the minimal
     .scrollCue ("scroll ↓"), so the percentage trigger is never created. */
  const fill = document.getElementById('scrollFill');
  const pct = document.getElementById('scrollPct');
  const mm = gsap.matchMedia();
  mm.add('(min-width: 768px)', () => {
    if (!(fill && pct)) return;
    const st = ScrollTrigger.create({
      start: 0,
      end: 'max',
      onUpdate: (self) => {
        gsap.set(fill, { scaleX: self.progress });
        pct.textContent = Math.round(self.progress * 100) + '%';
      },
    });
    return () => st.kill();
  });

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

  /* ---------- mobile menu (burger) ---------- */
  const burger = document.getElementById('navBurger');
  const mobileMenu = document.getElementById('mobileMenu');
  if (burger && mobileMenu) {
    const menuLinks = mobileMenu.querySelectorAll('.mobileMenu-link');
    let menuOpen = false;
    const setMenu = (open) => {
      menuOpen = open;
      burger.classList.toggle('is-open', open);
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? 'close menu' : 'open menu');
      mobileMenu.classList.toggle('is-open', open);
      mobileMenu.setAttribute('aria-hidden', String(!open));
      document.documentElement.classList.toggle('menu-open', open);
      if (lenis) (open ? lenis.stop() : lenis.start());
      if (open && !reduced) {
        gsap.fromTo(menuLinks, { y: 34, opacity: 0 }, {
          y: 0, opacity: 1, duration: 0.55, ease: 'power3', stagger: 0.07, delay: 0.05, overwrite: true,
        });
      } else if (!open) {
        gsap.killTweensOf(menuLinks);
        gsap.set(menuLinks, { clearProps: 'all' });
      }
    };
    burger.addEventListener('click', () => setMenu(!menuOpen));
    menuLinks.forEach((a) => a.addEventListener('click', () => setMenu(false)));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menuOpen) setMenu(false);
    });
  }

  /* ---------- mobile scroll cue: fades once the hero is left ---------- */
  const scrollCue = document.getElementById('scrollCue');
  if (scrollCue) {
    const updateCue = () => {
      scrollCue.classList.toggle('is-hidden', window.scrollY > window.innerHeight * 0.55);
    };
    window.addEventListener('scroll', updateCue, { passive: true });
    updateCue();
  }

  /* ---------- sticky hero (sofihealth-style pinned intro) ----------
     The hero stays stuck at the top while the page keeps scrolling — the
     next section (waterStick) slides up over it and takes the screen,
     exactly like sofihealth.com. A slow parallax on the hand + title
     sells the depth while it is pinned. */
  gsap.set('#waterStick', { position: 'relative', zIndex: 3 });
  ScrollTrigger.create({
    trigger: '#hero',
    start: 'top top',
    end: '+=100%',
    pin: true,
    anticipatePin: 1,
  });
  if (!reduced) {
    // Softer depth on the phone: the hand sits in flow below the title, so a
    // desktop-sized parallax would tear the composition apart.
    mm.add({ isMobile: '(max-width: 767px)', isDesktop: '(min-width: 768px)' }, (ctx) => {
      const { isMobile } = ctx.conditions;
      const heroPin = {
        trigger: '#hero',
        start: 'top top',
        end: '+=100%',
        scrub: true,
        ease: 'none',
      };
      gsap.to('#heroHand', { yPercent: isMobile ? 10 : 26, scrollTrigger: { ...heroPin } });
      gsap.to('.hero-title', { yPercent: isMobile ? -6 : -14, scrollTrigger: { ...heroPin } });
      gsap.to('.hero-text, .hero-cta, .hero-apkBtn', { yPercent: isMobile ? -4 : -8, scrollTrigger: { ...heroPin } });
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
    // The resting capsule is sized by CSS per breakpoint. We start it at a tiny
    // dot scale, grow it to its natural resting size for the text-fill portion
    // of the scroll, then expand to cover the viewport and hand off cleanly to
    // the next section which is already on the same #f7f7f7 background.
    const scaleToFullY = () => {
      const h = waterShape.offsetHeight;
      // need to reach (at minimum) the viewport diagonal so corners never show
      return Math.max((window.innerHeight * 1.8) / h, 8);
    };
    const scaleToFullX = () => {
      const w = waterShape.offsetWidth;
      return Math.max((window.innerWidth * 2.2) / w, 12);
    };
    // mobile: one proportional blow-out — portrait screens read a vertical
    // pill stretching to the corners far better than a two-step tall→wide grow
    const scaleToCover = () => Math.max(scaleToFullX(), scaleToFullY());

    // Start state. Desktop: a tiny centered dot that blooms into the capsule.
    // Mobile: the capsule already rests at its composed size — the section
    // slides into view as a finished composition (small white vertical
    // capsule + statement), then scroll grows it over the viewport.
    // GSAP owns the translate + scale so the element stays perfectly centered.
    const armCapsule = (asDot) => {
      gsap.set(waterShape, {
        // the stylesheet centres the shape with translate(-50%,-50%), which
        // GSAP reads as pixel offsets — zero them and own the centring with
        // xPercent/yPercent only, or the capsule lands half off-screen
        x: 0,
        y: 0,
        xPercent: -50,
        yPercent: -50,
        scaleX: asDot ? 0.04 : 1,
        scaleY: asDot ? 0.04 : 1,
        transformOrigin: 'center center',
        borderRadius: 2000,
      });
      gsap.set('.waterStick-icon', { opacity: 1, scale: 1 });
      gsap.set('.waterStick-title', { opacity: 1, y: 0 });
      gsap.set('.waterStick-splitedText', { opacity: 1 });
    };

    mm.add({ isMobile: '(max-width: 767px)', isDesktop: '(min-width: 768px)' }, (ctx) => {
      const { isMobile } = ctx.conditions;
      armCapsule(!isMobile);

      // Single pinned timeline covering the whole dark→light transition.
      const wsTl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: {
          trigger: '#waterStick',
          start: 'top top',
          end: isMobile ? '+=120%' : '+=180%',
          scrub: 1,
          pin: true,
          anticipatePin: 1,
          invalidateOnRefresh: true,
        },
      });

      if (!isMobile) {
        // ---------- desktop: the original composition, untouched ----------
        // Phase 1 (0 → 20%): dot grows to its natural resting capsule size.
        wsTl.to(waterShape, { scaleX: 1, scaleY: 1, ease: 'power2.out', duration: 0.2 }, 0);
        // Phase 2 (15% → 55%): icon arrives while the capsule rests.
        wsTl.fromTo('.waterStick-icon',
          { opacity: 0, scale: 0.4 },
          { opacity: 1, scale: 1, duration: 0.2, ease: 'power2.out' },
          0.12
        );
        // Phase 3 (55% → 78%): grow TALL first.
        wsTl.to(waterShape, { scaleY: scaleToFullY, ease: 'power2.inOut', duration: 0.23 }, 0.55);
        // Phase 4 (73% → 95%): grow WIDE, text + icon fade out.
        wsTl.to(waterShape, { scaleX: scaleToFullX, ease: 'power3.inOut', duration: 0.22 }, 0.73);
        wsTl.to(['.waterStick-icon', '.waterStick-splitedText'], {
          opacity: 0, duration: 0.18, ease: 'power2.inOut',
        }, 0.75);
        // Phase 5 (92% → 100%): flatten the radius for a seamless hand-off.
        wsTl.to(waterShape, { borderRadius: 0, duration: 0.08, ease: 'power2.inOut' }, 0.92);
      } else {
        // ---------- mobile: recomposed for the portrait viewport ----------
        // The capsule + statement rest fully composed (armCapsule above);
        // the scroll grows that capsule over the viewport:
        wsTl.to({}, { duration: 0.3 }); // hold — time to read
        // (30% → 62%): the capsule grows proportionally past the viewport
        // diagonal — corners never show, and there is no intermediate state
        // where the text sits half on white and half on black.
        wsTl.to(waterShape, { scale: scaleToCover, ease: 'power2.inOut', duration: 0.32 }, 0.3);
        // The tiny chrome (index line + glyph) leaves as the white takes over.
        wsTl.to(['.waterStick-icon', '.waterStick-meta'], {
          opacity: 0, duration: 0.12, ease: 'power2.inOut',
        }, 0.58);
        // The statement is dark-on-white, so it stays readable straight
        // through the wipe and rides the white all the way to the hand-off —
        // when the pin releases it simply scrolls up into the twin headline.
        // (No fade-out: a blank white beat would read as a broken section.)
        // (90% → 97%): flatten the pill edges — seamless hand-off.
        wsTl.to(waterShape, { borderRadius: 0, duration: 0.07, ease: 'power2.inOut' }, 0.9);
      }

      return () => {
        wsTl.scrollTrigger && wsTl.scrollTrigger.kill();
        wsTl.kill();
      };
    });
  }

  /* ---------- pinned twin section (desktop) / flowing story (mobile) ---------- */
  mm.add('(min-width: 1051px)', () => {
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
      const right = idx % 2 === 1; // connect & plain sit on the right edge
      const div = document.querySelector(sel + ' .twin-featureDivider');
      const dist = () => Math.max(0, div.clientWidth - 5);
      tl.to(sel + ' .twin-featureDivider', { scaleX: 1, ease: 'power2.inOut', duration: 0.5 }, at)
        .fromTo(sel + ' .twin-featureDot', { x: 0 }, { x: () => (right ? -1 : 1) * dist(), ease: 'power2.inOut', duration: 0.5 }, at)
        .fromTo(sel + ' .twin-iconHolder', { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, ease: 'back.out(1.6)', duration: 0.35 }, at + 0.15)
        .fromTo(sel + ' h2', { y: 24, opacity: 0 }, { y: 0, opacity: 1, ease: 'power2.out', duration: 0.35 }, at + 0.2)
        .fromTo(sel + ' p', { y: 16, opacity: 0 }, { y: 0, opacity: 1, ease: 'power2.out', duration: 0.35 }, at + 0.28);
    });
    return () => {
      tl.scrollTrigger && tl.scrollTrigger.kill();
      tl.kill();
    };
  });

  mm.add('(max-width: 1050px)', () => {
    // the giant desktop circle needs the wide stage — the phone reads the
    // black features band instead
    gsap.set('#twinCircle', { display: 'none' });
    // reduced motion: everything simply visible, nothing animates on scroll
    if (reduced) {
      gsap.set('.twin-para p, .twin-featureElements, .twin-strip', { opacity: 1, transform: 'none' });
      return undefined;
    }
    const revs = [];
    gsap.utils.toArray('.twin-para p, .twin-featureElements').forEach((el) => {
      revs.push(gsap.fromTo(el, { opacity: 0, y: 24 }, {
        opacity: 1, y: 0, duration: 0.7, ease: 'power2.out',
        scrollTrigger: { trigger: el, start: 'top 85%' },
      }));
    });
    // the dictionary strip is real content — reveal it with the band
    const strip = document.querySelector('.twin-strip');
    let stripRev = null;
    if (strip) {
      stripRev = gsap.fromTo(strip, { opacity: 0, y: 48 }, {
        opacity: 1, y: 0, duration: 0.9, ease: 'power2.out',
        scrollTrigger: { trigger: '.twin-videoHolder', start: 'top 88%' },
      });
    }
    return () => {
      revs.forEach((r) => { r.scrollTrigger && r.scrollTrigger.kill(); r.kill(); });
      if (stripRev) { stripRev.scrollTrigger && stripRev.scrollTrigger.kill(); stripRev.kill(); }
    };
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
    gsap.fromTo('.twinStory-visualizer', { opacity: 0, scale: 0.94 }, {
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
