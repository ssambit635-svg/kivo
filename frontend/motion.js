/* kivo — motion.js — tiny anime.js inspired helper, self-hosted, CSP-safe
   No external deps, vanilla JS. Used for mobile app feel: entrance, bouncy buttons, etc.
*/
(function(){
  'use strict';
  function animate(el, keyframes, opts){
    if(!el || !el.animate) return {finished:Promise.resolve()};
    opts=opts||{};
    var anim=el.animate(keyframes, {
      duration:opts.duration||360,
      delay:opts.delay||0,
      easing:opts.easing||'cubic-bezier(.2,.8,.2,1)',
      fill:opts.fill||'both',
    });
    return anim;
  }
  function stagger(container, selector, opts){
    var els=container.querySelectorAll(selector);
    var delay=opts&&opts.stagger?opts.stagger:60;
    els.forEach(function(el,i){
      el.style.opacity='0'; el.style.transform='translateY(10px)';
      setTimeout(function(){
        animate(el, [
          {opacity:0, transform:'translateY(12px) scale(.98)'},
          {opacity:1, transform:'translateY(0) scale(1)'}
        ], {duration:420, delay:i*delay, easing:'cubic-bezier(.2,.8,.2,1)'});
      }, 30);
    });
  }
  function entrance(){
    var auth=document.getElementById('auth-view');
    if(auth && !auth.classList.contains('hidden')){
      var card=auth;
      animate(card, [
        {opacity:0, transform:'translateY(18px) scale(.97)'},
        {opacity:1, transform:'translateY(0) scale(1)'}
      ], {duration:560, easing:'cubic-bezier(.2,.8,.2,1)'});
      stagger(auth, '.field, .btn, .demo-btn, .tabs', {stagger:40});
    }
    var dash=document.getElementById('dash-view');
    if(dash && !dash.classList.contains('hidden')){
      stagger(dash, '.widget, .member-strip', {stagger:70});
    }
    var docAuth=document.getElementById('doc-auth');
    if(docAuth && !docAuth.classList.contains('hidden')){
      animate(docAuth, [
        {opacity:0, transform:'translateY(16px) scale(.98)'},
        {opacity:1, transform:'translateY(0) scale(1)'}
      ], {duration:500});
    }
  }
  function bouncyButton(btn){
    if(!btn) return;
    btn.addEventListener('touchstart', function(){ btn.style.transform='scale(.96)'; }, {passive:true});
    btn.addEventListener('touchend', function(){ btn.style.transform=''; }, {passive:true});
    btn.addEventListener('mousedown', function(){ btn.style.transform='scale(.97)'; });
    btn.addEventListener('mouseup', function(){ btn.style.transform=''; });
    btn.addEventListener('mouseleave', function(){ btn.style.transform=''; });
    // ripple position for ::after
    btn.addEventListener('mousemove', function(e){
      var r=btn.getBoundingClientRect();
      btn.style.setProperty('--x', (e.clientX-r.left)+'px');
      btn.style.setProperty('--y', (e.clientY-r.top)+'px');
    });
  }
  function init(){
    entrance();
    document.querySelectorAll('.btn').forEach(bouncyButton);
    // observe widgets entering viewport
    if('IntersectionObserver' in window){
      var io=new IntersectionObserver(function(entries){
        entries.forEach(function(entry){
          if(entry.isIntersecting){
            animate(entry.target, [
              {opacity:0, transform:'translateY(14px)'},
              {opacity:1, transform:'translateY(0)'}
            ], {duration:400, easing:'cubic-bezier(.2,.8,.2,1)'});
            io.unobserve(entry.target);
          }
        });
      }, {threshold:.12});
      document.querySelectorAll('.widget, .doc-card, .report, .mile').forEach(function(el){ io.observe(el); });
    }
    // re-run entrance when auth view shown
    var origShowAuth=window.MtApp && window.MtApp.showView;
    // also watch for view changes via mutation
    var authView=document.getElementById('auth-view');
    if(authView){
      var mo=new MutationObserver(function(){
        if(!authView.classList.contains('hidden')) setTimeout(entrance, 60);
      });
      mo.observe(authView, {attributes:true, attributeFilter:['class']});
    }
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  window.KivoMotion={animate:animate, stagger:stagger, entrance:entrance};
})();
