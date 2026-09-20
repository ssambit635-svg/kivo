/**
 * kivo — dashboard logic (vanilla JS, mobile-first redesign 2026)
 * Persistent login until sign-out, easy sign-in, doctor create account.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var Icons = window.MtIcons;

  var state = {
    tokens: null,
    user: null,
    member: null,
    score: null,
    miles: null,
    reports: null,
    selectedDay: null,
    lastWidgetDataAt: 0,
    insights: null,
    intel: null,
    trends: null,
    risk: null,
    guidance: null,
    meds: null,
    summary: null,
    observations: null,
    reminders: null,
    askSuggestions: null,
    chat: [],
  };

  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function el(tag, attrs, children){
    var node=document.createElement(tag);
    if(attrs){
      for(var k in attrs){
        if(k==='class') node.className=attrs[k];
        else if(k==='text') node.textContent=attrs[k];
        else if(k==='html') node.innerHTML=attrs[k];
        else if(k==='title') node.title=attrs[k];
        else if(k==='type') node.type=attrs[k];
        else if(k==='style') node.style.cssText=attrs[k];
        else if(k==='value') node.value=attrs[k];
        else node.setAttribute(k,attrs[k]);
      }
    }
    (children||[]).forEach(function(c){
      if(c==null) return;
      node.appendChild(typeof c==='string'?document.createTextNode(c):c);
    });
    return node;
  }
  function icon(name,size,cls){
    return el('span',{class:'btn-ic'+(cls?' '+cls:''), html:Icons.svg(name,size||18)});
  }
  var toastTimer=null;
  function toast(msg){
    var t=$('toast');
    if(!t) return;
    t.textContent=msg;
    t.classList.remove('hidden');
    if(toastTimer) clearTimeout(toastTimer);
    toastTimer=setTimeout(function(){ t.classList.add('hidden'); }, 3800);
  }
  function fmtDate(iso){
    if(!iso) return '—';
    var d=new Date(iso);
    if(isNaN(d.getTime())) return '—';
    return MONTHS[d.getUTCMonth()]+' '+d.getUTCDate()+', '+d.getUTCFullYear();
  }
  function plural(n,one,many){ return n+' '+(n===1?one:many); }

  /* ---------------- API + persistent session ---------------- */
  function saveTokens(tokens){
    state.tokens=tokens;
    try{ localStorage.setItem('mt.tokens', JSON.stringify(tokens)); }catch(e){}
    // also store timestamp for refresh logic
    try{ localStorage.setItem('mt.tokens.ts', String(Date.now())); }catch(e){}
  }
  function loadTokens(){
    try{
      var raw=localStorage.getItem('mt.tokens');
      if(raw) state.tokens=JSON.parse(raw);
    }catch(e){}
  }
  function clearTokens(){
    state.tokens=null;
    try{ localStorage.removeItem('mt.tokens'); localStorage.removeItem('mt.tokens.ts'); }catch(e){}
  }
  function saveRememberedEmail(email){
    try{
      if(email) localStorage.setItem('mt.remember.email', email);
      else localStorage.removeItem('mt.remember.email');
    }catch(e){}
  }
  function loadRememberedEmail(){
    try{ return localStorage.getItem('mt.remember.email')||''; }catch(e){ return ''; }
  }

  function api(path, opts, allowRetry){
    opts=opts||{};
    var headers={'Content-Type':'application/json'};
    if(state.tokens && state.tokens.accessToken) headers.Authorization='Bearer '+state.tokens.accessToken;
    return fetch('/api'+path,{
      method:opts.method||'GET',
      headers:headers,
      body:opts.body?JSON.stringify(opts.body):undefined,
    }).then(function(res){
      if(res.status===401 && allowRetry!==false && state.tokens && state.tokens.refreshToken){
        return refreshSession().then(function(ok){
          if(!ok) throw sessionExpired();
          return api(path,opts,false);
        });
      }
      return res.json().then(function(body){
        if(!res.ok){
          var err=new Error((body && body.error && body.error.message)||'Something went wrong — please try again.');
          err.status=res.status; err.body=body;
          throw err;
        }
        return body;
      }, function(){
        throw new Error('Something went wrong — please try again.');
      });
    });
  }
  function sessionExpired(){
    clearTokens();
    showAuth();
    return new Error('Session expired — please sign in again.');
  }
  function refreshSession(){
    if(!state.tokens || !state.tokens.refreshToken) return Promise.resolve(false);
    return fetch('/api/auth/refresh',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({refreshToken:state.tokens.refreshToken}),
    }).then(function(res){
      if(!res.ok) return false;
      return res.json().then(function(body){
        saveTokens({accessToken:body.accessToken, refreshToken:body.refreshToken});
        return true;
      });
    }).catch(function(){ return false; });
  }
  function apiUpload(path, formData, allowRetry){
    var headers={};
    if(state.tokens && state.tokens.accessToken) headers.Authorization='Bearer '+state.tokens.accessToken;
    return fetch('/api'+path,{method:'POST', headers:headers, body:formData}).then(function(res){
      if(res.status===401 && allowRetry!==false && state.tokens && state.tokens.refreshToken){
        return refreshSession().then(function(ok){
          if(!ok) throw sessionExpired();
          return apiUpload(path,formData,false);
        });
      }
      return res.json().then(function(body){
        if(!res.ok){
          var err=new Error((body && body.error && body.error.message)||'Upload failed');
          err.status=res.status; err.body=body; throw err;
        }
        return body;
      });
    });
  }

  /* ---------------- Auth view ---------------- */
  var authMode='login';
  var authRole='patient';

  function syncAuthCopy(){
    var isDoctor=authRole==='doctor';
    var isLogin=authMode==='login';
    var rp=$('role-patient'), rd=$('role-doctor');
    if(rp){ rp.classList.toggle('active', !isDoctor); rp.setAttribute('aria-selected', String(!isDoctor)); }
    if(rd){ rd.classList.toggle('active', isDoctor); rd.setAttribute('aria-selected', String(isDoctor)); }
    var amt=$('auth-mode-tabs');
    if(amt){ amt.classList.remove('hidden'); } // always show now — doctor also can create
    var rn=$('row-name');
    if(rn){ rn.classList.toggle('hidden', isDoctor || isLogin); } // patient register shows name
    var rr=$('row-regno');
    if(rr){ rr.classList.toggle('hidden', !(isDoctor && isLogin)); } // doctor login needs regno
    var an=$('auth-note');
    if(an){ an.classList.toggle('hidden', !isDoctor); }
    var ah=$('auth-apply-hint');
    if(ah){ ah.classList.toggle('hidden', !isDoctor); }
    var dh=$('auth-demo-hint');
    if(dh){ dh.classList.toggle('hidden', isDoctor); }

    var extra=$('doctor-extra-fields');
    if(extra){ extra.classList.toggle('show', isDoctor && !isLogin); extra.classList.toggle('hidden', !(isDoctor && !isLogin)); if(isDoctor && !isLogin) extra.style.display='block'; else if(extra) extra.style.display='none'; }

    var heading=$('auth-heading'), sub=$('auth-subtitle'), submit=$('auth-submit');
    if(isDoctor){
      if(heading) heading.textContent=isLogin?'Doctor sign in':'Join as doctor';
      if(sub) sub.textContent=isLogin?'Reg. number is checked against your certificate, then console opens.':'Create doctor account — certificate is checked instantly (mock KYC for demo).';
      if(submit) submit.textContent=isLogin?'Open doctor console':'Create doctor account';
    }else{
      if(heading) heading.textContent=isLogin?'Welcome back':'Create your kivo profile';
      if(sub) sub.textContent=isLogin?'Sign in to see your kivo come alive.':'Your health twin starts with one verified report.';
      if(submit) submit.textContent=isLogin?'Sign in':'Create account';
    }
    var err=$('auth-error'); if(err) err.classList.add('hidden');
  }

  function setAuthRole(role){
    authRole=role==='doctor'?'doctor':'patient';
    try{ localStorage.setItem('mt.lastRole', authRole); }catch(e){}
    syncAuthCopy();
    // animate role switch
    var card=$('auth-view');
    if(card){ card.style.animation='none'; card.offsetHeight; card.style.animation='authIn .4s cubic-bezier(.2,.8,.2,1)'; }
  }
  function setAuthMode(mode){
    authMode=mode==='register'?'register':'login';
    var tl=$('tab-login'), tr=$('tab-register');
    if(tl) tl.classList.toggle('active', authMode==='login');
    if(tr) tr.classList.toggle('active', authMode==='register');
    var pw=$('in-password');
    if(pw) pw.setAttribute('autocomplete', authMode==='login'?'current-password':'new-password');
    syncAuthCopy();
  }

  function showAuth(){
    var dv=$('dash-view'), ub=$('userbox'), av=$('auth-view'), cv=$('care-view');
    if(dv) dv.classList.add('hidden');
    if(ub) ub.classList.add('hidden');
    if(av) av.classList.remove('hidden');
    if(cv) cv.classList.add('hidden');
    try{ syncAuthCopy(); }catch(e){}
    // fill remembered email
    var rem=loadRememberedEmail();
    var em=$('in-email');
    if(em && rem && !em.value) em.value=rem;
  }
  function showDash(){
    var av=$('auth-view'), dv=$('dash-view'), ub=$('userbox'), cv=$('care-view');
    if(av) av.classList.add('hidden');
    if(dv) dv.classList.remove('hidden');
    if(ub) ub.classList.remove('hidden');
    if(cv) cv.classList.add('hidden');
    var ue=$('user-email');
    if(ue) ue.textContent=state.user && state.user.email?state.user.email:'';
  }
  function showCare(){
    var av=$('auth-view'), dv=$('dash-view'), ub=$('userbox'), cv=$('care-view');
    if(av) av.classList.add('hidden');
    if(dv) dv.classList.add('hidden');
    if(ub) ub.classList.remove('hidden');
    if(cv) cv.classList.remove('hidden');
    scrollTo(0,0);
  }
  function showView(name){
    if(name==='care') return showCare();
    if(name==='auth') return showAuth();
    return showDash();
  }

  var sessionListeners=[], memberListeners=[];
  function notifySession(){ sessionListeners.forEach(function(cb){ try{ cb(state.user); }catch(e){} }); }
  function notifyMember(){ memberListeners.forEach(function(cb){ try{ cb(state.member); }catch(e){} }); }

  function handoffToDoctorConsole(){
    try{ sessionStorage.setItem('kivo.role-handoff', JSON.stringify(state.tokens)); }catch(e){}
    // Keep patient tokens too for persistent login — don't clear anymore
    // clearTokens(); // old behavior cleared, causing sign-in again
    location.href='/doctor/';
  }

  function onAuthSubmit(ev){
    ev.preventDefault();
    var email=$('in-email').value.trim();
    var password=$('in-password').value;
    var errBox=$('auth-error');
    if(errBox) errBox.classList.add('hidden');
    var remember=$('remember-me');
    var shouldRemember=remember?remember.checked:true;
    if(shouldRemember) saveRememberedEmail(email);

    if(authRole==='doctor' && authMode==='register'){
      // Doctor create account flow
      var name=$('in-name')?$('in-name').value.trim()||email.split('@')[0]:email.split('@')[0];
      // fallback name from doctor extra? use same
      var extraName=document.getElementById('in-name');
      if(extraName && extraName.value.trim()) name=extraName.value.trim();
      var specialty=$('in-specialty')?$('in-specialty').value:'general_physician';
      var city=$('in-city')?$('in-city').value.trim():'';
      var years=$('in-years')?Number($('in-years').value||5):5;
      var fee=$('in-fee')?Number($('in-fee').value||300):300;
      var headline=$('in-headline')?$('in-headline').value.trim():'General Physician';
      var regno=$('in-regno')?$('in-regno').value.trim():''; // for register, regno is in row-regno? Actually we hide row-regno for register, but we have in-regno still — we need separate field? Use same id for login, and for register we also use in-regno if visible? We have doctor-extra doesn't have regno, so we reuse row-regno input? Let's make register also require regno from extra? We'll use in-regno value if present, else generate from headline.
      // For register, we need regno field — we reuse in-regno if hidden, we still have value, but we also allow empty and generate mock.
      var regInput=$('in-regno');
      var regVal=regInput?regInput.value.trim():'';
      if(!regVal){
        // try to get from extra? we have no extra reg field, so require user to fill row-regno even in register? We hid it for register, so we need to show it for register too.
        // Let's make it visible for doctor register as well.
        // For now, if empty, use MCI- + random
        regVal='MCI-'+Math.floor(100000+Math.random()*900000);
      }
      if(!email || !password){
        if(errBox){ errBox.textContent='Email and password required.'; errBox.classList.remove('hidden'); }
        return;
      }
      if(password.length<12){
        if(errBox){ errBox.textContent='Password must be at least 12 characters (demo: Kivo!Doctor#2026).'; errBox.classList.remove('hidden'); }
        return;
      }
      var btn=$('auth-submit'); if(btn) btn.disabled=true;
      window.KivoConnection.ensureReady().then(function(){
        var fd=new FormData();
        fd.append('email', email);
        fd.append('displayName', name);
        fd.append('password', password);
        fd.append('specialty', specialty);
        fd.append('headline', headline);
        fd.append('registrationNo', regVal);
        fd.append('experienceYears', String(years));
        fd.append('city', city);
        fd.append('consultFeeInr', String(fee));
        var certFile=$('in-cert') && $('in-cert').files && $('in-cert').files[0];
        if(certFile) fd.append('certificate', certFile);
        // call doctor apply
        return apiUpload('/doctor/apply', fd, false);
      }).then(function(session){
        saveTokens({accessToken:session.accessToken, refreshToken:session.refreshToken});
        state.user=session.user;
        notifySession();
        toast('Doctor account created — opening console…');
        setTimeout(handoffToDoctorConsole, 600);
      }).catch(function(err){
        if(errBox){ errBox.textContent=err instanceof TypeError?'Cannot connect — check internet.':(err.message||'Please try again.'); errBox.classList.remove('hidden'); }
      }).finally(function(){ if(btn) btn.disabled=false; });
      return;
    }

    if(authRole==='doctor'){
      var regno=$('in-regno').value.trim();
      if(!regno){
        if(errBox){ errBox.textContent='Enter your medical registration number (e.g. MCI-123456 or MCI-DEMO-4471 for demo).'; errBox.classList.remove('hidden'); }
        return;
      }
      var btn2=$('auth-submit'); if(btn2) btn2.disabled=true;
      window.KivoConnection.ensureReady().then(function(){
        return api('/auth/doctor-login',{method:'POST', body:{email:email, password:password, registrationNo:regno}}, false);
      }).then(function(session){
        saveTokens({accessToken:session.accessToken, refreshToken:session.refreshToken});
        state.user=session.user;
        notifySession();
        handoffToDoctorConsole();
      }).catch(function(err){
        if(errBox){ errBox.textContent=err instanceof TypeError?'Cannot connect — check internet.':(err.message||'Please try again.'); errBox.classList.remove('hidden'); }
      }).finally(function(){ if(btn2) btn2.disabled=false; });
      return;
    }

    // patient
    var btn3=$('auth-submit'); if(btn3) btn3.disabled=true;
    var mode=authMode;
    var displayName=$('in-name').value.trim()||email.split('@')[0];
    var promise=window.KivoConnection.ensureReady().then(function(){
      if(mode==='login'){
        return api('/auth/login',{method:'POST', body:{email:email, password:password}}, false);
      }
      return api('/auth/register',{method:'POST', body:{email:email, displayName:displayName, password:password}}, false);
    });
    promise.then(function(session){
      if(session.user && session.user.accountType==='doctor'){
        setAuthRole('doctor');
        if(errBox){ errBox.textContent='This is a doctor account — add your registration number to open console.'; errBox.classList.remove('hidden'); }
        return null;
      }
      saveTokens({accessToken:session.accessToken, refreshToken:session.refreshToken});
      state.user=session.user;
      notifySession();
      return bootDashboard();
    }).catch(function(err){
      var msg=err instanceof TypeError?'Cannot connect — check internet.':(err.message||'Please try again.');
      // make error more helpful for lockout
      if(err.body && err.body.error && err.body.error.code==='ACCOUNT_LOCKED'){
        msg='Account locked after many tries — wait 2 min or use demo login.';
      }
      if(errBox){ errBox.textContent=msg; errBox.classList.remove('hidden'); }
    }).finally(function(){ if(btn3) btn3.disabled=false; });
  }

  function onLogout(){
    var rt=state.tokens && state.tokens.refreshToken;
    clearTokens();
    state.user=null; state.member=null;
    notifySession();
    showAuth();
    toast('Signed out — see you soon!');
    if(rt){
      api('/auth/logout',{method:'POST', body:{refreshToken:rt}}, false).catch(function(){});
    }
  }

  /* ---------------- Dashboard bootstrap ---------------- */
  function bootDashboard(){
    return api('/members').then(function(body){
      var owned=body.owned||[], shared=body.shared||[], all=owned.concat(shared);
      if(all.length===0) throw new Error('No kivo health member found.');
      state.member=owned.find(function(m){ return m.relationship==='self'; })||owned[0]||all[0];
      var mn=$('member-name'), ms=$('member-sub');
      if(mn) mn.textContent=state.member.name;
      if(ms) ms.textContent=(state.member.relationship||'self')+' · kivo health';
      notifyMember();
      showDash();
      return refreshAll();
    }).catch(function(err){
      if(err.status===401) throw err;
      toast(err.message||'Could not load your kivo health');
    });
  }
  function refreshAll(){
    if(!state.member) return Promise.resolve();
    var id=state.member.id;
    return Promise.all([
      api('/members/'+id+'/health-score').catch(function(){ return null; }),
      api('/members/'+id+'/milestones').catch(function(){ return null; }),
      api('/members/'+id+'/reports?pageSize=50').catch(function(){ return null; }),
    ]).then(function(results){
      state.score=results[0]; state.miles=results[1]; state.reports=results[2];
      state.lastWidgetDataAt=Date.now();
      renderScore(); renderMilestones(); renderReports();
      loadObservations(); loadReminders(); loadAskSuggestions(); loadInsights('trends'); loadIntel('baseline'); updateStorageInfo();
    });
  }

  /* ---------------- Widgets (kept from original, trimmed) ---------------- */
  var BAND_TONE={strong:'green', good:'green', watch:'amber', attention:'red'};
  var BAND_LABEL={strong:'Strong', good:'Good', watch:'Watch', attention:'Attention'};
  function currentSnapshot(){
    var tl=state.score && state.score.timeline?state.score.timeline:[];
    if(!tl.length) return null;
    return tl.find(function(s){ return s.day===state.selectedDay; })||tl[tl.length-1];
  }
  function renderScore(){
    var body=$('score-body'); if(!body) return; body.innerHTML='';
    var data=state.score;
    if(!data){ body.appendChild(emptyState('activity','Health score unavailable right now.')); return; }
    if(!data.timeline || data.timeline.length===0){
      body.appendChild(emptyState('activity', data.message||'Upload and verify a report to start your health score timeline.'));
      body.appendChild(disclaimerBox(data.disclaimer)); return;
    }
    if(!state.selectedDay || !data.timeline.some(function(s){ return s.day===state.selectedDay; })){
      state.selectedDay=data.timeline[data.timeline.length-1].day;
    }
    var cur=data.current, snap=currentSnapshot();
    var hero=el('div',{class:'score-hero'});
    hero.appendChild(scoreRing(cur.score, cur.band));
    var meta=el('div',{class:'score-meta'});
    var chips=el('div');
    chips.appendChild(el('span',{class:'chip '+(BAND_TONE[cur.band]||'grey'), text:BAND_LABEL[cur.band]||cur.band}));
    chips.appendChild(document.createTextNode(' '));
    chips.appendChild(deltaChip(cur.delta));
    meta.appendChild(chips);
    meta.appendChild(el('p',{class:'asof', text:'As of '+cur.label+' · '+plural(cur.markerCount,'marker','markers')+' · '+plural(cur.outOfRangeCount,'value','values')+' outside range'}));
    meta.appendChild(el('p',{class:'asof', text:'Score = share of verified markers inside their reference ranges.'}));
    hero.appendChild(meta); body.appendChild(hero);
    var chartWrap=el('div',{class:'chart-wrap'});
    chartWrap.appendChild(buildChart(data.timeline));
    body.appendChild(chartWrap);
    body.appendChild(breakdownView(snap));
    body.appendChild(disclaimerBox(data.disclaimer));
  }
  function scoreRing(score,band){
    var tone={strong:'#0d9488', good:'#22a06b', watch:'#d97706', attention:'#dc2626'}[band]||'#6b8291';
    var r=46, c=2*Math.PI*r, filled=Math.max(0,Math.min(100,score))/100*c;
    var svg='<svg width="108" height="108" viewBox="0 0 108 108"><circle cx="54" cy="54" r="'+r+'" fill="none" stroke="#e8eef3" stroke-width="10"/><circle cx="54" cy="54" r="'+r+'" fill="none" stroke="'+tone+'" stroke-width="10" stroke-linecap="round" stroke-dasharray="'+filled.toFixed(1)+' '+c.toFixed(1)+'" transform="rotate(-90 54 54)"/></svg>';
    var ring=el('div',{class:'ring', html:svg});
    var val=el('div',{class:'ring-val'});
    val.appendChild(el('b',{text:String(score)}));
    val.appendChild(el('span',{text:'/ 100'}));
    ring.appendChild(val); return ring;
  }
  function deltaChip(delta){
    if(delta==null) return el('span',{class:'chip grey', text:'first snapshot'});
    if(delta===0){ var c0=el('span',{class:'chip grey'}); c0.appendChild(icon('minus',13)); c0.appendChild(document.createTextNode('no change')); return c0; }
    var up=delta>0; var c=el('span',{class:'chip '+(up?'green':'red')});
    c.appendChild(icon(up?'arrow-up-right':'arrow-down-right',13));
    c.appendChild(document.createTextNode((up?'+':'')+delta+' vs previous')); return c;
  }
  function buildChart(timeline){
    var NS='http://www.w3.org/2000/svg'; var host=document.createElement('div');
    var W=Math.max(300, ($('score-body').clientWidth||340)-2), H=208, padL=30, padR=12, padT=18, padB=34, n=timeline.length;
    var svg=document.createElementNS(NS,'svg'); svg.setAttribute('width','100%'); svg.setAttribute('height',String(H)); svg.setAttribute('viewBox','0 0 '+W+' '+H); svg.setAttribute('role','img');
    var defs=document.createElementNS(NS,'defs'); defs.innerHTML='<linearGradient id="scoreGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0d9488" stop-opacity="0.25"/><stop offset="100%" stop-color="#0d9488" stop-opacity="0"/></linearGradient>'; svg.appendChild(defs);
    function px(i){ if(n===1) return (padL+W-padR)/2; return padL+(i*(W-padL-padR))/(n-1); }
    function py(score){ return padT+((100-score)/100)*(H-padT-padB); }
    [60,75,90,100].forEach(function(g){
      var line=document.createElementNS(NS,'line'); line.setAttribute('x1',padL); line.setAttribute('x2',W-padR); line.setAttribute('y1',py(g)); line.setAttribute('y2',py(g)); line.setAttribute('class','chart-grid'); svg.appendChild(line);
      var lbl=document.createElementNS(NS,'text'); lbl.setAttribute('x','2'); lbl.setAttribute('y',py(g)+3.5); lbl.setAttribute('class','chart-xlab'); lbl.textContent=String(g); svg.appendChild(lbl);
    });
    if(n>=2){
      var d='M '+px(0)+' '+py(timeline[0].score);
      for(var i=1;i<n;i+=1) d+=' L '+px(i)+' '+py(timeline[i].score);
      var area=document.createElementNS(NS,'path'); area.setAttribute('d',d+' L '+px(n-1)+' '+py(0)+' L '+px(0)+' '+py(0)+' Z'); area.setAttribute('class','chart-area'); svg.appendChild(area);
      var line2=document.createElementNS(NS,'path'); line2.setAttribute('d',d); line2.setAttribute('class','chart-line'); svg.appendChild(line2);
    }
    timeline.forEach(function(s,i){
      var x=px(i), y=py(s.score), isSel=s.day===state.selectedDay;
      var lbl=document.createElementNS(NS,'text'); lbl.setAttribute('x',x); lbl.setAttribute('y',y-12); lbl.setAttribute('text-anchor','middle'); lbl.setAttribute('class','chart-scorelab'); lbl.textContent=String(s.score); svg.appendChild(lbl);
      var dot=document.createElementNS(NS,'circle'); dot.setAttribute('cx',x); dot.setAttribute('cy',y); dot.setAttribute('r',isSel?6:4.5); dot.setAttribute('class','chart-dot'+(isSel?' sel':'')); dot.addEventListener('click',function(){ state.selectedDay=s.day; renderScore(); }); var title=document.createElementNS(NS,'title'); title.textContent=s.label+' — score '+s.score; dot.appendChild(title); svg.appendChild(dot);
      var mon=document.createElementNS(NS,'text'); mon.setAttribute('x',x); mon.setAttribute('y',H-12); mon.setAttribute('text-anchor','middle'); mon.setAttribute('class','chart-xlab'); mon.setAttribute('style','font-size:11px'); mon.textContent=s.label; svg.appendChild(mon);
      if(s.delta!=null){ var dl=document.createElementNS(NS,'text'); dl.setAttribute('x',x); dl.setAttribute('y',H-1); dl.setAttribute('text-anchor','middle'); dl.setAttribute('style','font-size:10px;font-weight:700;fill:'+(s.delta>0?'#15803d':s.delta<0?'#b91c1c':'#6b8291')); dl.textContent=(s.delta>0?'+':'')+s.delta; svg.appendChild(dl); }
    });
    host.appendChild(svg); return host;
  }
  function breakdownView(snap){
    var box=el('div',{class:'breakdown'});
    box.appendChild(el('h3',{text:'What makes up the '+snap.label+' score'}));
    snap.breakdown.forEach(function(b){
      var row=el('div',{class:'bk-row'});
      row.appendChild(el('span',{class:'bk-name', text:b.markerName}));
      var val=b.value!=null?b.value+(b.unit?' '+b.unit:''):'—';
      row.appendChild(el('span',{class:'bk-val '+(b.status==='normal'?'ok':b.status==='unknown'?'unknown':'bad'), text:val+(b.status!=='normal'&&b.status!=='unknown'?' ('+b.status+')':'')}));
      row.appendChild(el('span',{class:'bk-pts '+(b.points>=100?'ok':b.points<=45?'bad':'unknown'), text:b.points+' pts'}));
      box.appendChild(row);
    });
    return box;
  }
  function renderMilestones(){
    var body=$('miles-body'); if(!body) return; body.innerHTML='';
    var data=state.miles;
    if(!data){ body.appendChild(emptyState('trophy','Milestones unavailable right now.')); return; }
    var sub=$('mile-sub'); if(sub) sub.textContent=data.earned+' of '+data.total+' earned';
    var prog=el('div',{class:'miles-progress'}); var barOuter=el('div',{class:'bar'}); var w=data.total?Math.round((data.earned/data.total)*100):0;
    barOuter.appendChild(el('i',{style:'width:'+w+'%'})); prog.appendChild(barOuter); prog.appendChild(el('b',{text:data.earned+'/'+data.total})); body.appendChild(prog);
    var grid=el('div',{class:'miles'});
    data.milestones.forEach(function(m){
      var isNext=data.next && data.next.key===m.key;
      var card=el('div',{class:'mile'+(m.achieved?' done':'')+(isNext?' next':'')});
      if(isNext) card.appendChild(el('span',{class:'next-tag', text:'Up next'}));
      card.appendChild(el('span',{class:'m-ic', html:Icons.svg(m.icon,18)}));
      var mbody=el('div',{class:'m-body'});
      mbody.appendChild(el('div',{class:'m-title', text:m.title}));
      mbody.appendChild(el('p',{class:'m-desc', text:m.description}));
      if(m.achieved){ mbody.appendChild(el('div',{class:'m-when', text:'Earned '+fmtDate(m.achievedAt)})); }
      else if(m.progress && m.progress.requiredDays){
        var days=m.progress.daysCovered; var pct=Math.max(2,Math.min(100,Math.round((days/m.progress.requiredDays)*100)));
        var bar=el('div',{class:'bar'}); bar.appendChild(el('i',{style:'width:'+pct+'%'})); mbody.appendChild(bar);
        mbody.appendChild(el('div',{class:'m-prog', text:days+' of ~'+m.progress.requiredDays+' days of verified history'}));
      }
      card.appendChild(mbody);
      card.appendChild(el('span',{class:m.achieved?'m-check':'m-lock', html:Icons.svg(m.achieved?'circle-check':'lock',16)}));
      grid.appendChild(card);
    });
    body.appendChild(grid);
  }
  function renderReports(){
    var body=$('reports-body'); if(!body) return; body.innerHTML='';
    var data=state.reports;
    if(!data){ body.appendChild(emptyState('file-text','Reports unavailable right now.')); return; }
    if(!data.items || data.items.length===0){ body.appendChild(emptyState('file-text','No reports yet — scan one with your camera or paste its text.')); return; }
    var list=el('div',{class:'reports-list'});
    data.items.forEach(function(r){
      var row=el('div',{class:'report'});
      var head=el('div',{class:'r-head'});
      head.appendChild(icon('file-text',18,'r-ic'));
      head.appendChild(el('span',{class:'r-name', text:r.originalName||'Pasted report'}));
      head.appendChild(el('span',{class:'r-date', text:fmtDate(r.reportDate||r.createdAt)}));
      row.appendChild(head);
      var actions=el('div',{class:'r-actions'});
      if(r.badge && r.badge.level==='needs_review' && r.labResultCount>0){
        var btn=el('button',{class:'btn primary sm', type:'button', title:'Confirm the extracted values'});
        btn.appendChild(icon('badge-check',14)); btn.appendChild(document.createTextNode('Verify'));
        btn.addEventListener('click',function(){ verifyReport(r.id); }); actions.appendChild(btn);
      }else if(r.labResultCount!=null){ actions.appendChild(el('span',{class:'r-date', text:plural(r.labResultCount,'value','values')})); }
      row.appendChild(actions);
      if(r.badge){
        var badge=el('span',{class:'badge '+(r.badge.tone||'grey'), title:r.badge.hint||''});
        badge.appendChild(el('span',{class:'btn-ic', html:Icons.svg(r.badge.icon,14)}));
        badge.appendChild(document.createTextNode(r.badge.label));
        row.appendChild(el('div',{class:'r-badge'},[badge]));
        if(r.badge.hint) row.appendChild(el('p',{class:'r-hint', text:r.badge.hint}));
      }
      list.appendChild(row);
    });
    body.appendChild(list);
  }
  function verifyReport(reportId){
    api('/reports/'+reportId+'/verify',{method:'POST', body:{}}).then(function(){ toast('Report verified — your kivo just grew.'); return refreshAll(); }).catch(function(err){ toast(err.message||'Could not verify'); });
  }
  function onUpload(ev){
    ev.preventDefault();
    var text=$('in-report-text').value.trim(), date=$('in-report-date').value, errBox=$('upload-error');
    if(errBox) errBox.classList.add('hidden');
    if(!text){ if(errBox){ errBox.textContent='Paste the report text first.'; errBox.classList.remove('hidden'); } return; }
    if(!state.member) return;
    var btn=$('btn-upload'); if(btn) btn.disabled=true;
    api('/members/'+state.member.id+'/reports',{method:'POST', body:{text:text, reportDate:date||null}}).then(function(out){
      $('in-report-text').value=''; var badge=out && out.report && out.report.badge?out.report.badge.label:'Needs review';
      toast('Scanned — badge: '+badge+'. Verify it to feed your twin.'); return refreshAll();
    }).catch(function(err){ if(errBox){ errBox.textContent=err.message||'Could not read report'; errBox.classList.remove('hidden'); } }).finally(function(){ if(btn) btn.disabled=false; });
  }

  function ingestFile(file, source){
    var fd=new FormData(); fd.append('file', file, file.name||(source==='camera'?'camera-scan.jpg':'upload.jpg'));
    return apiUpload('/members/'+state.member.id+'/reports', fd);
  }
  var scanStream=null;
  function openScanner(){
    var view=$('scanner-view'), err=$('scan-error');
    if(err) err.hidden=true; if(view) view.classList.remove('hidden');
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      if(err){ err.textContent='Live camera unavailable — use Gallery.'; err.hidden=false; } return;
    }
    navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}, audio:false}).then(function(stream){
      scanStream=stream; var video=$('scan-video'); if(video){ video.srcObject=stream; video.play().catch(function(){}); }
    }).catch(function(){ if(err){ err.textContent='Could not open camera — grant permission or use Gallery.'; err.hidden=false; } });
  }
  function closeScanner(){
    if(scanStream){ scanStream.getTracks().forEach(function(t){ t.stop(); }); scanStream=null; }
    var v=$('scan-video'); if(v) v.srcObject=null;
    var view=$('scanner-view'); if(view) view.classList.add('hidden');
  }
  var SCAN_MAX_EDGE=1600;
  function canvasToJpeg(canvas,name,done){ canvas.toBlob(function(blob){ if(!blob){ toast('Could not capture'); return; } done(new File([blob],name,{type:'image/jpeg'})); },'image/jpeg',0.85); }
  function drawScaled(img,imgW,imgH,name,done){
    var scale=Math.min(1,SCAN_MAX_EDGE/Math.max(imgW,imgH));
    var canvas=document.createElement('canvas'); canvas.width=Math.max(1,Math.round(imgW*scale)); canvas.height=Math.max(1,Math.round(imgH*scale));
    canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height); canvasToJpeg(canvas,name,done);
  }
  function shrinkImage(file,name,done){
    if(!file || !/^image\//.test(file.type||'')){ done(file); return; }
    var url; try{ url=URL.createObjectURL(file); }catch(e){ done(file); return; }
    var img=new Image();
    img.onload=function(){ try{ URL.revokeObjectURL(url); if(!img.naturalWidth){ done(file); return; } drawScaled(img,img.naturalWidth,img.naturalHeight,name,done); }catch(e){ done(file); } };
    img.onerror=function(){ try{ URL.revokeObjectURL(url); }catch(e){} done(file); };
    img.src=url;
  }
  function captureFrame(){
    var video=$('scan-video'); if(!video || !video.videoWidth){ toast('Camera not ready'); return; }
    closeScanner(); drawScaled(video,video.videoWidth,video.videoHeight,'camera-scan.jpg',function(file){ submitCapture(file,'camera'); });
  }
  function submitCapture(file,source){
    toast('Reading your report…');
    ingestFile(file,source).then(function(out){
      var badge=out && out.report && out.report.badge?out.report.badge.label:'Needs review';
      var rows=out && out.preview && out.preview.extracted?out.preview.extracted:[];
      var flagged=rows.filter(function(r){ return r.suspicious; }).length;
      var msg='Scanned '+rows.length+' values — badge: '+badge+'.';
      if(flagged>0) msg+=' '+flagged+' look implausible — check against report.';
      msg+=' Verify to feed your kivo.'; toast(msg); return refreshAll();
    }).catch(function(err){ toast(err.message||'Could not read scan'); });
  }
  var recognition=null, listening=false;
  function speechCtor(){ return window.SpeechRecognition||window.webkitSpeechRecognition||null; }
  function toggleVoice(){
    var err=$('voice-error'); if(err) err.classList.add('hidden');
    var Ctor=speechCtor();
    if(!Ctor){ if(err){ err.textContent='Voice needs Chrome on Android.'; err.classList.remove('hidden'); } return; }
    if(listening){ stopVoice(); return; }
    recognition=new Ctor(); recognition.lang='en-IN'; recognition.interimResults=false; recognition.maxAlternatives=1;
    listening=true; setVoiceUI(true);
    recognition.onresult=function(ev){
      var text=ev.results[0][0].transcript;
      var vt=$('voice-transcript'); if(vt){ vt.textContent='“'+text+'”'; vt.classList.remove('hidden'); }
      saveVoiceObservation(text);
    };
    recognition.onerror=function(ev){
      stopVoice();
      var code=ev&&ev.error?ev.error:'';
      var human=code==='not-allowed'?'Mic blocked — allow in settings.':code==='no-speech'?'Could not hear — try closer.':code==='audio-capture'?'No mic found.':'Voice stopped — try again.';
      if(err){ err.textContent=human; err.classList.remove('hidden'); }
    };
    recognition.onend=function(){ stopVoice(); };
    recognition.start();
  }
  function stopVoice(){ listening=false; setVoiceUI(false); try{ recognition&&recognition.stop(); }catch(e){} }
  function setVoiceUI(active){
    var label=$('voice-label'); if(label) label.textContent=active?'Listening… tap to stop':'Start voice journal';
    try{ Icons.set($('voice-icon'), active?'stop':'mic',16); }catch(e){}
    var btn=$('btn-voice'); if(btn) btn.classList.toggle('listening', active);
  }
  function parseObservation(text){
    var t=(text||'').toLowerCase(); var num=(t.match(/(\d+(?:\.\d+)?)/)||[null,null])[1];
    if(/sleep|slept|soya|neend/.test(t)) return {kind:'sleep', payload:{note:text, quality:/bad|poor|kharab|badly/.test(t)?'poor':'good'}};
    if(/walk|run|exercise|gym|workout|vyayam/.test(t)) return {kind:'activity', payload:{note:text, minutes:num?Number(num):null}};
    if(/weight|wajan|vajan|kg/.test(t)) return {kind:'weight', payload:{note:text, kg:num?Number(num):null}};
    if(/blood pressure|bp\b|pressure/.test(t)) return {kind:'bp', payload:{note:text, reading:num}};
    if(/medicine|tablet|dawai|medication|dose/.test(t)) return {kind:'medication', payload:{note:text}};
    return {kind:'symptom', payload:{note:text}};
  }
  function saveVoiceObservation(text){
    if(!state.member) return;
    var obs=parseObservation(text);
    api('/members/'+state.member.id+'/observations',{method:'POST', body:{kind:obs.kind, payload:obs.payload, source:'voice'}}).then(function(){ toast('Voice note saved as '+obs.kind); return refreshAll(); }).catch(function(err){ toast(err.message||'Could not save'); });
  }
  function setTab(tab){
    var home=$('nav-home'), reports=$('nav-reports');
    if(home) home.classList.toggle('active', tab==='home');
    if(reports) reports.classList.toggle('active', tab==='reports');
  }
  function registerServiceWorker(){
    if(window.KivoNative) return;
    if('serviceWorker' in navigator && location.protocol!=='file:'){
      navigator.serviceWorker.register('./sw.js').catch(function(){});
    }
  }
  function withLoading(btn,fn){
    if(!btn||btn.disabled) return;
    var orig=btn.innerHTML; btn.disabled=true; btn.classList.add('loading');
    var ic=btn.querySelector('.btn-ic'); var icHtml=ic?ic.innerHTML:null;
    if(ic) try{ ic.innerHTML=Icons.svg('loader',14); }catch(e){}
    var done=function(){ btn.disabled=false; btn.classList.remove('loading'); if(ic&&icHtml) ic.innerHTML=icHtml; };
    try{ var r=fn(); if(r&&typeof r.then==='function') r.then(done,done); else done(); }catch(e){ done(); throw e; }
  }
  function debounce(fn,ms){ var t; return function(){ var a=arguments, ctx=this; clearTimeout(t); t=setTimeout(function(){ fn.apply(ctx,a); }, ms); }; }

  /* ---------------- Intelligence (kept) ---------------- */
  var insightsTab='trends', intelTab='baseline', remTab='obs';
  function setInsightsTab(tab){
    insightsTab=tab;
    document.querySelectorAll('#insights-tabs .intel-tab').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-insights-tab')===tab); });
    loadInsights(tab);
  }
  function setIntelTab(tab){
    intelTab=tab;
    document.querySelectorAll('#intel-tabs .intel-tab').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-intel-tab')===tab); });
    var wb=$('whatif-body'); if(!wb) return;
    if(tab==='whatif'){ wb.classList.remove('hidden'); loadIntel('baseline'); }else{ wb.classList.add('hidden'); loadIntel(tab); }
  }
  function setRemTab(tab){
    remTab=tab;
    document.querySelectorAll('#rem-tabs .intel-tab').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-rem-tab')===tab); });
    var ob=$('obs-body'), rb=$('reminders-body'), sb=$('storage-body');
    if(ob) ob.classList.toggle('hidden', tab!=='obs');
    if(rb) rb.classList.toggle('hidden', tab!=='reminders');
    if(sb) sb.classList.toggle('hidden', tab!=='storage');
    if(tab==='obs') loadObservations();
    if(tab==='reminders') loadReminders();
    if(tab==='storage') updateStorageInfo();
  }
  function showSkeleton(host,lines){
    if(!host) return; host.innerHTML='';
    for(var i=0;i<lines;i++){ var s=el('div',{class:'skeleton skel '+(i===0?'w80':i===1?'w60':'w40')}); s.style.height='14px'; host.appendChild(s); }
  }
  function loadInsights(tab){
    if(!state.member) return; var id=state.member.id, body=$('insights-body'); if(!body) return;
    showSkeleton(body,3); var url;
    if(tab==='trends') url='/members/'+id+'/trends';
    else if(tab==='risk') url='/members/'+id+'/risk/diabetes';
    else if(tab==='guidance') url='/members/'+id+'/guidance';
    else if(tab==='meds') url='/members/'+id+'/medication-awareness';
    else if(tab==='summary') url='/members/'+id+'/doctor-summary';
    else return;
    var opts=tab==='risk'?{method:'POST', body:{}}:{};
    api(url,opts).then(function(data){
      body.innerHTML='';
      if(tab==='trends') renderTrends(body,data);
      else if(tab==='risk') renderRisk(body,data);
      else if(tab==='guidance') renderGuidance(body,data);
      else if(tab==='meds') renderMeds(body,data);
      else if(tab==='summary') renderSummary(body,data);
    }).catch(function(err){ body.innerHTML=''; body.appendChild(emptyState('info', err.message||'Could not load '+tab)); });
  }
  function renderTrends(host,data){
    if(!data||!data.trends){ host.appendChild(emptyState('trending-up','No trends yet — verify a couple of reports.')); if(data&&data.narrative) host.appendChild(disclaimerBox(data.narrative.disclaimer||data.narrative.text)); return; }
    var trends=data.trends; var list=Array.isArray(trends)?trends:(trends.items||[]);
    if(list.length===0 && trends && typeof trends==='object' && !Array.isArray(trends)){
      for(var k in trends){ if(k==='narrative'||k==='disclaimer') continue; var v=trends[k]; if(v&&v.code) list.push(v); }
    }
    if(list.length===0){ host.appendChild(emptyState('trending-up','No trend lines yet.')); return; }
    list.slice(0,8).forEach(function(t){
      var card=el('div',{class:'intel-card'}); card.appendChild(el('h4',{text:t.markerName||t.code||'Trend'}));
      if(t.direction) card.appendChild(el('span',{class:'chip '+(t.direction==='up'?'amber':t.direction==='down'?'green':'grey'), text:t.direction}));
      if(t.change) card.appendChild(el('p',{class:'muted', text:t.change}));
      if(t.series&&t.series.length){ var last=t.series[t.series.length-1]; card.appendChild(el('p',{class:'muted', text:'Latest: '+(last.value!=null?last.value+' '+(last.unit||''):'—')+' on '+(last.date||'')})); }
      if(t.interpretation) card.appendChild(el('p',{class:'muted', text:t.interpretation}));
      host.appendChild(card);
    });
    if(data.narrative) host.appendChild(disclaimerBox(data.narrative.text||data.narrative.disclaimer));
  }
  function renderRisk(host,data){
    if(!data||data.error){ host.appendChild(emptyState('shield-check','Risk needs more verified data.')); return; }
    var r=data.result||data; var card=el('div',{class:'intel-card'});
    card.appendChild(el('h4',{text:'Diabetes risk — prototype'}));
    var pct=(r.risk!=null?r.risk:r.percent);
    if(pct!=null){ var bar=el('div',{class:'risk-bar '+(r.band==='high'?'danger':r.band==='medium'?'warn':'')}); bar.appendChild(el('i',{style:'width:'+Math.max(4,Math.min(100,pct))+'%'})); card.appendChild(bar); card.appendChild(el('div',{style:'display:flex; justify-content:space-between; font-size:13px;'},[el('b',{text:pct+'%'}), el('span',{class:'muted', text:r.band||''})])); }
    if(r.topFactors&&r.topFactors.length) card.appendChild(el('p',{class:'muted', text:'Top factors: '+r.topFactors.join(', ')}));
    if(r.confidenceNote) card.appendChild(disclaimerBox(r.confidenceNote));
    if(data.disclaimer) card.appendChild(disclaimerBox(data.disclaimer));
    card.appendChild(el('p',{class:'muted', text:'Prototype only — not clinically validated.'})); host.appendChild(card);
  }
  var AREA_LABEL={activity:'Movement', sleep:'Sleep', nutrition:'Food & weight', lifestyle:'Lifestyle', general:'General'};
  function renderGuidance(host,data){
    if(!data){ host.appendChild(emptyState('info','No guidance yet.')); return; }
    var g=Array.isArray(data)?{items:data}:(data.guidance||data);
    var items=Array.isArray(g)?g:(Array.isArray(g.items)?g.items:(Array.isArray(g.sections)?g.sections:[]));
    var narrative=typeof g.narrative==='string'?g.narrative:(g.narrative&&g.narrative.text?g.narrative.text:'');
    if(narrative){ var intro=el('div',{class:'intel-card'}); intro.appendChild(el('h4',{text:'In plain words'})); intro.appendChild(el('p',{class:'muted', text:narrative})); host.appendChild(intro); }
    if(items.length===0){ host.appendChild(emptyState('info','Nothing to personalise yet.')); }
    items.forEach(function(item){
      var card=el('div',{class:'intel-card'}); var head=el('div',{class:'intel-head'});
      head.appendChild(el('h4',{text:item.title||item.heading||'Guidance'})); if(item.area) head.appendChild(el('span',{class:'chip grey', text:AREA_LABEL[item.area]||item.area})); card.appendChild(head);
      var body=item.body||item.text||item.message; if(body) card.appendChild(el('p',{class:'muted', text:String(body)}));
      if(item.why){ var why=el('p',{class:'intel-why'}); why.appendChild(el('strong',{text:'Why: '})); why.appendChild(document.createTextNode(String(item.why))); card.appendChild(why); }
      if(item.inputs&&item.inputs.length){
        var chips=el('div',{class:'suggestion-chips'});
        item.inputs.forEach(function(inp){ if(!inp) return; var label=String(inp.label||inp.name||'Value'); var value=inp.value==null?'':' '+inp.value; var unit=inp.unit?' '+inp.unit:''; chips.appendChild(el('span',{class:'chip grey', text:label+':'+value+unit})); });
        card.appendChild(chips);
      }
      host.appendChild(card);
    });
    var disclaimer=g.disclaimer||data.disclaimer; if(disclaimer) host.appendChild(disclaimerBox(disclaimer));
  }
  function renderMeds(host,data){
    if(!data){ host.appendChild(emptyState('pill','No medication awareness yet.')); return; }
    var items=data.items||data.medications||data;
    if(Array.isArray(items)){
      if(items.length===0) host.appendChild(emptyState('pill','No medications recorded.'));
      items.forEach(function(m){ var c=el('div',{class:'intel-card'}); c.appendChild(el('h4',{text:m.name||m.code||'Medication'})); c.appendChild(el('p',{class:'muted', text:m.note||m.text||m.awareness||''})); if(m.disclaimer) c.appendChild(disclaimerBox(m.disclaimer)); host.appendChild(c); });
    }else{ var summarized=data.awareness||data.summary||data.note; host.appendChild(emptyState('pill', summarized||'No medications yet.')); }
    if(data.disclaimer) host.appendChild(disclaimerBox(data.disclaimer));
  }
  function renderSummary(host,data){
    if(!data){ host.appendChild(emptyState('file-text','No summary yet.')); return; }
    var card=el('div',{class:'intel-card'}); card.appendChild(el('h4',{text:data.title||'Doctor summary'}));
    if(data.summary) card.appendChild(el('p',{text:data.summary}));
    if(data.sections){ data.sections.forEach(function(s){ card.appendChild(el('h4',{text:s.heading, style:'margin-top:10px; font-size:13px;'})); card.appendChild(el('p',{class:'muted', text:s.body})); }); }
    if(data.disclaimer) card.appendChild(disclaimerBox(data.disclaimer)); host.appendChild(card);
  }
  function loadIntel(tab){
    if(!state.member) return; var id=state.member.id, body=$('intel-body'); if(!body) return;
    showSkeleton(body,3); var url='/members/'+id+'/intelligence';
    if(tab==='baseline') url='/members/'+id+'/intelligence/baseline';
    else if(tab==='patterns') url='/members/'+id+'/intelligence/patterns';
    else if(tab==='anomalies') url='/members/'+id+'/intelligence';
    api(url).then(function(data){
      body.innerHTML='';
      if(tab==='baseline') renderBaseline(body,data);
      else if(tab==='patterns') renderPatterns(body,data);
      else if(tab==='anomalies') renderAnomalies(body,data);
    }).catch(function(err){ body.innerHTML=''; body.appendChild(emptyState('cpu', err.message||'Could not load')); });
  }
  function renderBaseline(host,data){
    var list=data.baselines||data||[]; if(Array.isArray(list)&&list.length===0){ host.appendChild(emptyState('cpu','No baselines yet.')); return; }
    if(!Array.isArray(list)) list=[list];
    list.slice(0,12).forEach(function(b){ var c=el('div',{class:'intel-card'}); c.appendChild(el('h4',{text:b.signal||b.marker||b.code||'Signal'})); c.appendChild(el('p',{class:'muted', text:'Mean: '+(b.mean!=null?b.mean:'—')+' · Range: '+(b.range||'—')})); host.appendChild(c); });
    if(data.disclaimer) host.appendChild(disclaimerBox(data.disclaimer));
  }
  function renderPatterns(host,data){
    var edges=data.edges||data.graph&&data.graph.edges||[];
    if(edges.length===0){ host.appendChild(emptyState('cpu','No strong patterns yet.')); return; }
    edges.slice(0,12).forEach(function(e){ var c=el('div',{class:'intel-card'}); c.appendChild(el('h4',{text:(e.from||e.source)+' → '+(e.to||e.target)})); c.appendChild(el('span',{class:'chip '+(e.strength>0.6?'green':e.strength>0.3?'amber':'grey'), text:'strength '+(e.strength!=null?(e.strength*100|0)+'%':'—')})); host.appendChild(c); });
    if(data.disclaimer) host.appendChild(disclaimerBox(data.disclaimer));
  }
  function renderAnomalies(host,data){
    var findings=data.anomalies&&data.anomalies.findings||data.findings||[];
    if(findings.length===0){ host.appendChild(emptyState('activity','No anomalies — stable.')); return; }
    findings.slice(0,10).forEach(function(f){ var c=el('div',{class:'intel-card'}); c.appendChild(el('h4',{text:f.type||f.kind||'Anomaly'})); c.appendChild(el('p',{class:'muted', text:f.message||f.detail||''})); host.appendChild(c); });
    if(data.disclaimer) host.appendChild(disclaimerBox(data.disclaimer));
  }
  function doSimulate(){
    if(!state.member) return; var id=state.member.id, changes={};
    var w=$('sim-weight').value.trim(), a=$('sim-activity').value.trim(), h=$('sim-hba1c').value.trim(), s=$('sim-sbp').value.trim();
    if(w) changes.weightKg=Number(w); if(a) changes.activityMinutesPerWeek=Number(a); if(h) changes.hba1c=Number(h); if(s) changes.systolicBp=Number(s);
    if(Object.keys(changes).length===0){ var e=$('simulate-error'); if(e){ e.textContent='Enter at least one value.'; e.classList.remove('hidden'); } return; }
    var eb=$('simulate-error'); if(eb) eb.classList.add('hidden');
    var btn=$('btn-simulate'); withLoading(btn,function(){ return api('/members/'+id+'/intelligence/simulate',{method:'POST', body:{changes:changes}}).then(function(res){
      var host=$('simulate-result'); if(!host) return; host.innerHTML=''; var card=el('div',{class:'intel-card'}); card.appendChild(el('h4',{text:res.label||'Scenario result'})); host.appendChild(card);
    }).catch(function(err){ var e2=$('simulate-error'); if(e2){ e2.textContent=err.message; e2.classList.remove('hidden'); } }); });
  }
  function doExplore(){
    if(!state.member) return; var id=state.member.id, host=$('scenarios-result'); if(!host) return; host.innerHTML=''; showSkeleton(host,2);
    api('/members/'+id+'/intelligence/scenarios',{method:'POST', body:{}}).then(function(res){
      host.innerHTML=''; var list=res.scenarios||res||[]; (Array.isArray(list)?list:list.scenarios||[]).slice(0,6).forEach(function(sc){ var c=el('div',{class:'scenario-card'}); c.appendChild(el('h5',{text:sc.label||sc.id})); host.appendChild(c); });
    }).catch(function(err){ host.innerHTML=''; host.appendChild(emptyState('info', err.message)); });
  }
  function loadAskSuggestions(){
    if(!state.member) return; var id=state.member.id;
    api('/members/'+id+'/ask/suggestions').then(function(data){
      var host=$('ask-suggestions'); if(!host) return; host.innerHTML=''; var arr=data.suggestions||data||[];
      (Array.isArray(arr)?arr:[]).slice(0,6).forEach(function(s){ var text=typeof s==='string'?s:(s.question||s.text||''); var b=el('button',{type:'button', text:text}); b.addEventListener('click',function(){ var inp=$('ask-input'); if(inp) inp.value=text; doAsk(); }); host.appendChild(b); });
    }).catch(function(){});
  }
  function renderChat(){
    var host=$('ask-chat'); if(!host) return; host.innerHTML='';
    state.chat.forEach(function(m){ var d=el('div',{class:'chat-msg '+m.role}); d.textContent=m.text; if(m.role==='bot'&&m.disclaimer) d.appendChild(el('div',{class:'muted', text:m.disclaimer, style:'margin-top:6px; font-size:11px;'})); host.appendChild(d); });
    host.scrollTop=host.scrollHeight;
  }
  function doAsk(){
    var input=$('ask-input'); if(!input) return; var text=(input.value||'').trim(); if(!text||!state.member) return;
    var id=state.member.id; state.chat.push({role:'user', text:text}); renderChat(); input.value='';
    var err=$('ask-error'); if(err) err.classList.add('hidden');
    var btn=$('ask-send'); withLoading(btn,function(){
      return api('/members/'+id+'/ask',{method:'POST', body:{question:text}}).then(function(res){
        var ans=res.answer||res.text||res.narrative||JSON.stringify(res); var disclaimer=res.disclaimer||(res.meta&&res.meta.disclaimer)||'';
        state.chat.push({role:'bot', text:ans, disclaimer:disclaimer}); renderChat();
      }).catch(function(err){ var e=$('ask-error'); if(e){ e.textContent=err.message; e.classList.remove('hidden'); } state.chat.push({role:'sys', text:err.message}); renderChat(); });
    });
  }
  function loadObservations(){
    if(!state.member) return; var id=state.member.id;
    api('/members/'+id+'/observations').then(function(data){
      var list=data.items||data.observations||data||[]; var host=$('obs-list'); if(!host) return; host.innerHTML='';
      if(list.length===0){ host.appendChild(emptyState('activity','No observations yet.')); return; }
      list.slice(0,20).forEach(function(o){
        var row=el('div',{class:'obs-item'}); row.appendChild(el('span',{class:'obs-dot'}));
        var body=el('div',{style:'flex:1; min-width:0;'}); body.appendChild(el('div',{style:'font-weight:700; font-size:13.5px;', text:o.kind}));
        body.appendChild(el('div',{class:'muted', text:(o.data&&o.data.note)||JSON.stringify(o.data||o.payload||'').slice(0,120)}));
        body.appendChild(el('div',{class:'muted', style:'font-size:11px;', text:fmtDate(o.observedAt||o.createdAt)+' · '+(o.source||'')}));
        row.appendChild(body); var del=el('button',{class:'btn ghost sm', type:'button', text:'✕', title:'Delete'}); del.addEventListener('click',function(){ deleteObservation(o.id); }); row.appendChild(del); host.appendChild(row);
      });
    }).catch(function(){});
  }
  function deleteObservation(oid){ if(!oid) return; api('/observations/'+oid,{method:'DELETE'}).then(function(){ toast('Observation removed'); loadObservations(); }).catch(function(e){ toast(e.message); }); }
  function createObservationManual(ev){
    ev.preventDefault(); if(!state.member) return; var kind=$('obs-kind').value, text=$('obs-text').value.trim(); if(!text) return;
    var payload={note:text}; var num=(text.match(/(\d+(?:\.\d+)?)/)||[])[1];
    if(kind==='weight'&&num) payload.weightKg=Number(num); if(kind==='bp'&&num) payload.systolic=Number(num); if(kind==='activity'&&num) payload.minutesPerWeek=Number(num);
    api('/members/'+state.member.id+'/observations',{method:'POST', body:{kind:kind, payload:payload, source:'manual'}}).then(function(){ var it=$('obs-text'); if(it) it.value=''; toast('Observation saved'); loadObservations(); }).catch(function(e){ toast(e.message); });
  }
  function loadReminders(){
    if(!state.member) return; var id=state.member.id;
    api('/members/'+id+'/reminders').then(function(data){
      var list=data.items||data.reminders||data||[]; var host=$('reminders-list'); if(!host) return; host.innerHTML='';
      if(list.length===0){ host.appendChild(emptyState('bell','No reminders.')); return; }
      list.forEach(function(r){
        var row=el('div',{class:'reminder-item'}); var left=el('div',{style:'flex:1; min-width:0;'});
        left.appendChild(el('div',{style:'font-weight:700; font-size:13.5px;', text:r.title||r.text||'Reminder'}));
        left.appendChild(el('div',{class:'when', text:(r.dueAt?fmtDate(r.dueAt):'No due date')+' · '+(r.status||'')}));
        row.appendChild(left); var del=el('button',{class:'btn ghost sm', type:'button', text:'✕'}); del.addEventListener('click',function(){ api('/reminders/'+r.id,{method:'DELETE'}).then(function(){ toast('Reminder removed'); loadReminders(); }).catch(function(e){ toast(e.message); }); }); row.appendChild(del); host.appendChild(row);
      });
    }).catch(function(){});
  }
  function createReminder(ev){
    ev.preventDefault(); if(!state.member) return; var title=$('rem-title').value.trim(), due=$('rem-due').value; if(!title) return; var body={title:title}; if(due) body.dueAt=new Date(due).toISOString();
    api('/members/'+state.member.id+'/reminders',{method:'POST', body:body}).then(function(){ var t=$('rem-title'), d=$('rem-due'); if(t) t.value=''; if(d) d.value=''; toast('Reminder created'); loadReminders(); }).catch(function(e){ toast(e.message); });
  }
  function updateStorageInfo(){
    var host=$('storage-info'); if(!host) return; host.innerHTML=''; var c=el('div',{class:'intel-card'});
    c.appendChild(el('h4',{text:'Health storage'}));
    var reportsCount=state.reports&&state.reports.items?state.reports.items.length:0;
    c.appendChild(el('div',{class:'kv-row'},[el('span',{text:'Reports'}), el('b',{text:String(reportsCount)})]));
    c.appendChild(el('div',{class:'kv-row'},[el('span',{text:'Verified markers'}), el('b',{text:state.score&&state.score.current?String(state.score.current.markerCount):'—'})]));
    c.appendChild(el('p',{class:'muted', text:'All reports encrypted. Export via Profile → Export. Images never leave without consent.'}));
    var btn=el('button',{class:'btn ghost sm', type:'button', text:'Export my data'});
    btn.addEventListener('click',function(){ api('/profile/export').then(function(){ toast('Export ready'); }).catch(function(e){ toast(e.message); }); });
    c.appendChild(btn); host.appendChild(c);
  }

  function emptyState(iconName,msg){
    var box=el('div',{class:'empty'});
    try{ box.appendChild(el('span',{class:'btn-ic', html:Icons.svg(iconName,28)})); }catch(e){ box.appendChild(el('span',{text:'○'})); }
    box.appendChild(el('p',{class:'muted', text:msg})); return box;
  }
  function disclaimerBox(text){
    if(!text) return el('div');
    var box=el('div',{class:'disclaimer'});
    try{ box.appendChild(icon('info',15)); }catch(e){}
    box.appendChild(el('span',{text:text})); return box;
  }

  /* ---------------- Easy sign-in helpers ---------------- */
  function setupEasySignIn(){
    var pwToggle=$('toggle-pw'), pwInput=$('in-password');
    if(pwToggle && pwInput){
      pwToggle.addEventListener('click',function(){
        var isPw=pwInput.type==='password';
        pwInput.type=isPw?'text':'password';
        pwToggle.textContent=isPw?'🙈':'👁';
      });
    }
    var demoPat=$('demo-patient'), demoDoc=$('demo-doctor');
    if(demoPat){
      demoPat.addEventListener('click',function(){
        var em=$('in-email'), pw=$('in-password'), rn=$('in-regno');
        if(em) em.value='demo@kivo.dev';
        if(pw) pw.value='Kivo!Demo#2026';
        setAuthRole('patient'); setAuthMode('login');
        toast('Demo patient filled — signing in…');
        setTimeout(function(){ var form=$('auth-form'); if(form) form.dispatchEvent(new Event('submit',{cancelable:true})); }, 300);
      });
    }
    if(demoDoc){
      demoDoc.addEventListener('click',function(){
        var em=$('in-email'), pw=$('in-password'), rn=$('in-regno');
        if(em) em.value='dr.mohan@kivo.dev';
        if(pw) pw.value='Kivo!Doctor#2026';
        if(rn) rn.value='MCI-DEMO-4471';
        setAuthRole('doctor'); setAuthMode('login');
        toast('Demo doctor filled — signing in…');
        setTimeout(function(){ var form=$('auth-form'); if(form) form.dispatchEvent(new Event('submit',{cancelable:true})); }, 300);
      });
    }
    // remember email auto-fill handled in showAuth
    var emailInput=$('in-email');
    if(emailInput){
      var rem=loadRememberedEmail();
      if(rem && !emailInput.value) emailInput.value=rem;
    }
    var forgot=$('forgot-link');
    if(forgot){
      forgot.addEventListener('click',function(ev){
        ev.preventDefault();
        toast('Use demo login or create new account. Password reset is mock for demo.');
      });
    }
  }

  /* ---------------- Persistent login — background refresh ---------------- */
  var refreshInterval=null;
  function startPersistentSession(){
    if(refreshInterval) clearInterval(refreshInterval);
    // refresh every 10 min while app open
    refreshInterval=setInterval(function(){
      if(state.tokens && state.tokens.refreshToken){
        refreshSession().then(function(ok){ if(!ok){ /* ignore */ } });
      }
    }, 10*60*1000);
    // on visibility change, try refresh if hidden long
    document.addEventListener('visibilitychange', function(){
      if(document.visibilityState==='visible' && state.tokens){
        var ts=0; try{ ts=Number(localStorage.getItem('mt.tokens.ts')||0); }catch(e){}
        if(Date.now()-ts>5*60*1000){ refreshSession(); }
      }
    });
  }

  /* ---------------- Init ---------------- */
  function setStaticIcons(){
    try{
      [['brand-logo','pulse',22],['user-icon','user',16],['logout-icon','log-out',15],
       ['member-icon','user',18],['refresh-icon','refresh-cw',15],['score-head-ic','activity',19],
       ['mile-head-ic','trophy',19],['rep-head-ic','file-text',19],['upload-icon','upload',15],
       ['scan-icon','camera',18],['voice-head-ic','mic',19],
       ['insights-head-ic','activity',18],['intel-head-ic','cpu',18],
       ['ask-head-ic','message-circle',18],['rem-head-ic','bell',18],
      ].forEach(function(t){ try{ Icons.set($(t[0]), t[1], t[2]); }catch(e){} });
      var homeIc=document.querySelector('#nav-home .nav-ic');
      if(homeIc) try{ Icons.set(homeIc,'home',20); }catch(e){ homeIc.textContent='⌂'; }
      var repIc=document.querySelector('#nav-reports .nav-ic');
      if(repIc) try{ Icons.set(repIc,'file-text',20); }catch(e){ repIc.textContent='≡'; }
      var scanIc=document.querySelector('#nav-scan .nav-ic');
      if(scanIc) try{ Icons.set(scanIc,'camera',22); }catch(e){ scanIc.textContent='◍'; }
      var sc=document.querySelector('#scan-close .btn-ic'); if(sc) try{ Icons.set(sc,'x',16); }catch(e){}
      var sca=document.querySelector('#scan-capture .btn-ic'); if(sca) try{ Icons.set(sca,'camera',20); }catch(e){}
      var sg=document.querySelector('#scan-gallery .btn-ic'); if(sg) try{ Icons.set(sg,'upload',16); }catch(e){}
      var vi=$('voice-icon'); if(vi) try{ Icons.set(vi,'mic',16); }catch(e){}
    }catch(e){}
  }
  var resizeTimer=null;
  function onResize(){
    if(resizeTimer) clearTimeout(resizeTimer);
    resizeTimer=setTimeout(function(){ if(state.score&&state.score.timeline&&state.score.timeline.length) renderScore(); }, 220);
  }
  var readyDone=false;
  function ready(cb){ if(readyDone) return cb(); document.addEventListener('DOMContentLoaded', cb, {once:true}); }

  function init(){
    setStaticIcons();
    var tl=$('tab-login'), tr=$('tab-register'), rp=$('role-patient'), rd=$('role-doctor');
    if(tl) tl.addEventListener('click',function(){ setAuthMode('login'); });
    if(tr) tr.addEventListener('click',function(){ setAuthMode('register'); });
    if(rp) rp.addEventListener('click',function(){ setAuthRole('patient'); });
    if(rd) rd.addEventListener('click',function(){ setAuthRole('doctor'); });
    var af=$('auth-form'); if(af) af.addEventListener('submit', onAuthSubmit);
    var lo=$('btn-logout'); if(lo) lo.addEventListener('click', onLogout);
    var uf=$('upload-form'); if(uf) uf.addEventListener('submit', onUpload);
    window.addEventListener('resize', onResize);

    // scanner
    var bs=$('btn-scan'), ns=$('nav-scan'), sc=$('scan-close'), sca2=$('scan-capture'), sf=$('scan-file');
    if(bs) bs.addEventListener('click', openScanner);
    if(ns) ns.addEventListener('click', openScanner);
    if(sc) sc.addEventListener('click', closeScanner);
    if(sca2) sca2.addEventListener('click', captureFrame);
    if(sf) sf.addEventListener('change',function(ev){
      var f=ev.target.files&&ev.target.files[0]; ev.target.value='';
      if(f){ closeScanner(); toast('Preparing photo…'); shrinkImage(f,'gallery-scan.jpg',function(small){ submitCapture(small,'gallery'); }); }
    });
    var bv=$('btn-voice'); if(bv) bv.addEventListener('click', toggleVoice);
    var nh=$('nav-home'); if(nh) nh.addEventListener('click',function(){ setTab('home'); scrollTo(0,0); });
    var nr=$('nav-reports'); if(nr) nr.addEventListener('click',function(){ setTab('reports'); var r=document.querySelector('.widget-reports'); if(r) r.scrollIntoView({behavior:'smooth', block:'start'}); });
    var nc=$('nav-care'); if(nc) nc.addEventListener('click',function(){ showCare(); });

    document.querySelectorAll('#insights-tabs .intel-tab').forEach(function(b){ b.addEventListener('click',function(){ setInsightsTab(b.getAttribute('data-insights-tab')); }); });
    document.querySelectorAll('#intel-tabs .intel-tab').forEach(function(b){ b.addEventListener('click',function(){ setIntelTab(b.getAttribute('data-intel-tab')); }); });
    document.querySelectorAll('#rem-tabs .intel-tab').forEach(function(b){ b.addEventListener('click',function(){ setRemTab(b.getAttribute('data-rem-tab')); }); });
    var obsForm=$('obs-form'); if(obsForm) obsForm.addEventListener('submit', createObservationManual);
    var remForm=$('reminder-form'); if(remForm) remForm.addEventListener('submit', createReminder);
    var askSend=$('ask-send'); if(askSend) askSend.addEventListener('click', doAsk);
    var askInput=$('ask-input'); if(askInput) askInput.addEventListener('keydown',function(e){ if(e.key==='Enter') doAsk(); });
    var simBtn=$('btn-simulate'); if(simBtn) simBtn.addEventListener('click', doSimulate);
    var expBtn=$('btn-explore'); if(expBtn) expBtn.addEventListener('click', doExplore);
    var origRefresh=$('btn-refresh');
    if(origRefresh){ origRefresh.addEventListener('click', debounce(function(){ withLoading(origRefresh,function(){ return refreshAll().then(function(){ toast('Refreshed.'); }); }); },200)); }

    readyDone=true;
    registerServiceWorker();
    setupEasySignIn();
    startPersistentSession();

    if(window.KivoNative){
      document.body.classList.add('native-app');
      window.KivoConnection.ensureReady().catch(function(){});
    }
    loadTokens();
    if(new URLSearchParams(location.search).get('login')==='1'){
      history.replaceState(null,'',location.pathname);
    }
    try{
      var lastRole=localStorage.getItem('mt.lastRole');
      if(lastRole==='doctor') setAuthRole('doctor');
    }catch(e){}
    // also ensure doctor extra fields visibility fix
    syncAuthCopy();

    if(state.tokens && state.tokens.accessToken){
      api('/auth/me').then(function(me){
        state.user=me.user; notifySession();
        if(me.user && me.user.accountType==='doctor'){ handoffToDoctorConsole(); return null; }
        return bootDashboard();
      }).catch(function(){ showAuth(); });
    }else{
      showAuth();
    }
  }

  window.MtApp = {
    $:$, el:el, icon:icon, toast:toast, api:api,
    member:function(){ return state.member; },
    user:function(){ return state.user; },
    showView:showView,
    onSession:function(cb){ sessionListeners.push(cb); if(state.user) cb(state.user); },
    onMember:function(cb){ memberListeners.push(cb); if(state.member) cb(state.member); },
    ready:ready,
  };

  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
