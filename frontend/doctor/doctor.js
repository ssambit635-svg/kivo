/* kivo — Doctor console (vanilla JS, mobile-first redesign 2026)
   Persistent login until sign-out, easy sign-in, create account flow improved.
*/
(function(){
  'use strict';
  var Icons=window.MtIcons;
  var TOKEN_KEY='mt.doctor.tokens';
  var state={
    tokens:null, user:null, doctor:null,
    certificatePolicy:null, view:'dashboard',
    overview:null, consultations:[], consultation:null,
    library:null, recommendable:[], earnings:null,
    specialties:[], filter:'',
  };
  function $(id){ return document.getElementById(id); }
  function el(tag,attrs,children){
    var node=document.createElement(tag);
    if(attrs){
      for(var k in attrs){
        if(k==='class') node.className=attrs[k];
        else if(k==='text') node.textContent=attrs[k];
        else if(k==='html') node.innerHTML=attrs[k];
        else if(k==='value') node.value=attrs[k];
        else if(k==='style') node.style.cssText=attrs[k];
        else node.setAttribute(k,attrs[k]);
      }
    }
    (children||[]).forEach(function(c){ if(c==null) return; node.appendChild(typeof c==='string'?document.createTextNode(c):c); });
    return node;
  }
  function icon(name,size,cls){ return el('span',{class:'btn-ic'+(cls?' '+cls:''), html:Icons.svg(name,size||18)}); }
  var toastTimer=null;
  function toast(msg){
    var t=$('doc-toast'); if(!t) return;
    t.textContent=msg; t.classList.remove('hidden');
    if(toastTimer) clearTimeout(toastTimer);
    toastTimer=setTimeout(function(){ t.classList.add('hidden'); }, 3800);
  }
  function rs(n){ return '₹'+Number(n||0).toLocaleString('en-IN'); }
  function rsFromPaise(p){ return rs((Number(p||0)/100).toFixed(2)); }
  function shortDate(iso){
    if(!iso) return '—';
    var d=new Date(iso); if(isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-IN',{day:'numeric', month:'short', year:'numeric'});
  }
  var STATUS_LABEL={payment_pending:'awaiting payment', requested:'new request', in_review:'in review', answered:'answered', closed:'closed', cancelled:'cancelled'};
  function statusChip(status){
    var tone={requested:'indigo', in_review:'teal', answered:'green', closed:'grey', payment_pending:'amber', cancelled:'red'}[status]||'grey';
    return el('span',{class:'chip '+tone, text:STATUS_LABEL[status]||status});
  }

  /* API + persistent */
  function saveTokens(tokens){
    state.tokens=tokens;
    try{ localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens)); localStorage.setItem(TOKEN_KEY+'.ts', String(Date.now())); }catch(e){}
  }
  function loadTokens(){
    try{
      var raw=localStorage.getItem(TOKEN_KEY);
      if(raw) state.tokens=JSON.parse(raw);
    }catch(e){}
  }
  function clearTokens(){
    state.tokens=null;
    try{ localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY+'.ts'); }catch(e){}
  }
  function api(path,opts){
    opts=opts||{};
    var headers={};
    if(state.tokens && state.tokens.accessToken) headers.Authorization='Bearer '+state.tokens.accessToken;
    if(opts.body && !(opts.body instanceof FormData)) headers['Content-Type']='application/json';
    return fetch('/api'+path,{
      method:opts.method||'GET',
      headers:headers,
      body:opts.body?(opts.body instanceof FormData?opts.body:JSON.stringify(opts.body)):undefined,
    }).then(function(res){
      return res.json().then(function(body){
        if(!res.ok){
          var err=new Error((body && body.error && body.error.message)||'Request failed ('+res.status+')');
          err.status=res.status; err.code=body && body.error?body.error.code:null; err.body=body; throw err;
        }
        return body;
      });
    });
  }
  function apiWithRefresh(path,opts,allowRetry){
    opts=opts||{};
    var headers={};
    if(state.tokens && state.tokens.accessToken) headers.Authorization='Bearer '+state.tokens.accessToken;
    if(opts.body && !(opts.body instanceof FormData)) headers['Content-Type']='application/json';
    return fetch('/api'+path,{
      method:opts.method||'GET',
      headers:headers,
      body:opts.body?(opts.body instanceof FormData?opts.body:JSON.stringify(opts.body)):undefined,
    }).then(function(res){
      if(res.status===401 && allowRetry!==false && state.tokens && state.tokens.refreshToken){
        return refreshSession().then(function(ok){
          if(!ok){ clearTokens(); showAuth(); throw new Error('Session expired'); }
          return apiWithRefresh(path,opts,false);
        });
      }
      return res.json().then(function(body){
        if(!res.ok){
          var err=new Error((body && body.error && body.error.message)||'Request failed');
          err.status=res.status; err.code=body && body.error?body.error.code:null; throw err;
        }
        return body;
      });
    });
  }
  function refreshSession(){
    if(!state.tokens || !state.tokens.refreshToken) return Promise.resolve(false);
    return fetch('/api/auth/refresh',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({refreshToken:state.tokens.refreshToken}),
    }).then(function(res){
      if(!res.ok) return false;
      return res.json().then(function(body){
        saveTokens({accessToken:body.accessToken, refreshToken:body.refreshToken});
        return true;
      });
    }).catch(function(){ return false; });
  }

  /* Auth */
  function showAuth(){
    var dc=$('doc-console'), ub=$('doc-userbox'), da=$('doc-auth');
    if(dc) dc.classList.add('hidden');
    if(ub) ub.classList.add('hidden');
    if(da) da.classList.remove('hidden');
  }
  function showConsole(){
    var da=$('doc-auth'), ub=$('doc-userbox'), dc=$('doc-console');
    if(da) da.classList.add('hidden');
    if(ub) ub.classList.remove('hidden');
    if(dc) dc.classList.remove('hidden');
    var un=$('doc-user-name');
    if(un) un.textContent=state.doctor?state.doctor.fullName:'';
  }
  function setAuthTab(mode){
    var login=mode==='login';
    var tl=$('doc-tab-login'), ta=$('doc-tab-apply'), lf=$('doc-login-form'), af=$('doc-apply-form'), hd=$('doc-auth-heading');
    if(tl) tl.classList.toggle('active', login);
    if(ta) ta.classList.toggle('active', !login);
    if(lf) lf.classList.toggle('hidden', !login);
    if(af) af.classList.toggle('hidden', login);
    if(hd) hd.textContent=login?'Doctor sign in':'Join the doctor network';
    var le=$('doc-login-error'), ae=$('doc-apply-error');
    if(le) le.classList.add('hidden');
    if(ae) ae.classList.add('hidden');
  }

  function onLogin(ev){
    ev.preventDefault();
    var err=$('doc-login-error'); if(err) err.classList.add('hidden');
    var regno=$('doc-regno').value.trim();
    if(!regno){
      if(err){ err.textContent='Enter registration number (e.g. MCI-123456 or MCI-DEMO-4471 for demo).'; err.classList.remove('hidden'); }
      return;
    }
    var btn=$('doc-login-submit'); if(btn) btn.disabled=true;
    api('/auth/doctor-login',{
      method:'POST',
      body:{email:$('doc-email').value.trim(), password:$('doc-password').value, registrationNo:regno},
    }).then(function(session){
      saveTokens({accessToken:session.accessToken, refreshToken:session.refreshToken});
      state.user=session.user;
      state.certificatePolicy=session.certificatePolicy||state.certificatePolicy;
      try{ localStorage.setItem('mt.doctor.remember.email', $('doc-email').value.trim()); }catch(e){}
      return boot();
    }).catch(function(e){
      if(err){ err.textContent=e.message; err.classList.remove('hidden'); }
    }).then(function(){ if(btn) btn.disabled=false; });
  }

  function onApply(ev){
    ev.preventDefault();
    var err=$('doc-apply-error'); if(err) err.classList.add('hidden');
    var btn=$('doc-apply-submit'); if(btn) btn.disabled=true;
    var split=function(id){
      var v=$(id); if(!v) return [];
      return v.value.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    };
    var form=new FormData();
    var put=function(key,value){ if(value===undefined||value===null||value==='') return; form.append(key,value); };
    put('email',$('ap-email').value.trim());
    put('displayName',$('ap-name').value.trim());
    put('password',$('ap-password').value);
    put('specialty',$('ap-specialty').value);
    put('headline',$('ap-headline').value.trim());
    put('registrationNo',$('ap-regno').value.trim());
    put('experienceYears',Number($('ap-years').value||0));
    put('city',$('ap-city').value.trim());
    put('consultFeeInr',Number($('ap-fee').value||0));
    var quals=split('ap-quals'), langs=split('ap-langs');
    if(quals.length) form.append('qualifications', JSON.stringify(quals));
    if(langs.length) form.append('languages', JSON.stringify(langs));
    put('bio',$('ap-bio').value.trim());
    var cert=$('ap-certificate').files && $('ap-certificate').files[0];
    if(cert) form.append('certificate', cert);

    api('/doctor/apply',{method:'POST', body:form}).then(function(session){
      saveTokens({accessToken:session.accessToken, refreshToken:session.refreshToken});
      state.user=session.user; state.doctor=session.doctor;
      state.certificatePolicy=session.certificatePolicy||state.certificatePolicy;
      var certResult=session.certificate||(session.doctor&&session.doctor.certificate);
      if(certResult && certResult.status==='rejected'){
        toast('Certificate check failed — fix and upload again.');
      }else{
        toast(session.doctor.status==='active'?'Welcome — certificate checked!':'Application submitted.');
      }
      return boot();
    }).catch(function(e){
      if(err){ err.textContent=e.message; err.classList.remove('hidden'); }
    }).then(function(){ if(btn) btn.disabled=false; });
  }

  function logout(){
    var rt=state.tokens && state.tokens.refreshToken;
    clearTokens(); state.user=null; state.doctor=null;
    showAuth(); toast('Signed out — see you soon!');
    if(rt){ api('/auth/logout',{method:'POST', body:{refreshToken:rt}}).catch(function(){}); }
  }

  /* Boot */
  function boot(){
    return apiWithRefresh('/doctor/me').then(function(res){
      state.doctor=res.doctor;
      state.certificatePolicy=res.certificatePolicy||state.certificatePolicy;
      if(!state.doctor){
        showAuth(); setAuthTab('apply');
        var ae=$('doc-apply-error'); if(ae){ ae.textContent='This account is not a doctor account. Use "Create account" to join.'; ae.classList.remove('hidden'); }
        return null;
      }
      showConsole(); renderVerificationBanner(); renderCertificatePanel();
      if(state.doctor.status!=='active'){
        state.view='profile'; setView('profile'); return null;
      }
      return refreshAll();
    }).catch(function(e){
      if(e.status===401||e.status===403){ clearTokens(); showAuth(); if(e.code==='DOCTOR_ROLE_REQUIRED') setAuthTab('apply'); return null; }
      toast(e.message);
    });
  }

  function refreshAll(){
    return Promise.all([
      apiWithRefresh('/doctor/overview').catch(function(){ return null; }),
      apiWithRefresh('/doctor/consultations?pageSize=30').catch(function(){ return null; }),
      apiWithRefresh('/doctor/videos').catch(function(){ return null; }),
      apiWithRefresh('/doctor/videos/recommendable').catch(function(){ return null; }),
      apiWithRefresh('/doctor/earnings').catch(function(){ return null; }),
    ]).then(function(r){
      state.overview=r[0]; if(state.overview&&state.overview.doctor) state.doctor=state.overview.doctor;
      state.consultations=r[1]?r[1].items:[]; state.library=r[2]; state.recommendable=r[3]?r[3].videos:[]; state.earnings=r[4];
      if(state.consultation){
        var fresh=state.consultations.find(function(c){ return c.id===state.consultation.consultation.id; });
        if(fresh) state.consultation.consultation=fresh;
      }
      var badge=$('nav-consults-badge'); var queue=state.overview?state.overview.queue.requested:0;
      if(badge){ badge.textContent=String(queue); badge.classList.toggle('hidden', !queue); }
      renderVerificationBanner(); renderCertificatePanel(); render();
    });
  }

  function renderVerificationBanner(){
    var host=$('doc-verification-banner'); if(!host) return; host.innerHTML='';
    if(!state.doctor) return;
    if(state.doctor.status==='active'){
      var cert=state.doctor.certificate||{};
      var row=el('div',{class:'doc-card doc-row doc-verified'});
      var left=el('div');
      left.appendChild(el('strong',{text:'Verified — '+state.doctor.identityCardNo}));
      left.appendChild(el('span',{class:'muted', text:' Patients see "'+state.doctor.headline+'" and demo badge. '+(cert.verified?'Certificate '+ (cert.ref||'')+' checked.':'')}));
      row.appendChild(left); return host.appendChild(row);
    }
    var pending=el('div',{class:'doc-card'});
    pending.appendChild(el('h3',{text:'Verification pending'}));
    pending.appendChild(el('p',{class:'muted', text:'Your registration not registry-checked yet, so patients see demo badge. Charts stay closed until patient shares.'}));
    var cert=state.doctor.certificate||{};
    if(!cert.verified){
      pending.appendChild(el('p',{class:'muted', text:'Upload certificate below — reg number and name read from it, that check opens console.'}));
      host.appendChild(pending); return;
    }
    var btn=el('button',{class:'btn primary', type:'button'},['Complete verification']);
    btn.addEventListener('click',function(){
      api('/doctor/kyc/mock',{method:'POST', body:{}}).then(function(res){ state.doctor=res.doctor; toast('Verification complete — live!'); return boot(); }).catch(function(e){ toast(e.message); });
    });
    pending.appendChild(btn); host.appendChild(pending);
  }

  function renderCertificatePanel(){
    var card=$('doc-cert-card'); if(!card) return;
    var cert=(state.doctor&&state.doctor.certificate)||null;
    if(!state.doctor||(cert&&cert.verified)){ card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    var STATUS_COPY={not_submitted:'No certificate on file yet. Upload and check runs immediately.', rejected:'Last certificate did not pass. Fix below and upload again.', verified:'Certificate checked.'};
    var st=$('doc-cert-status'); if(st) st.textContent=STATUS_COPY[(cert&&cert.status)||'not_submitted']||'';
    var checksHost=$('doc-cert-checks'); if(checksHost){ checksHost.innerHTML=''; if(cert&&cert.checks&&cert.checks.length){ cert.checks.forEach(function(c){ var chip=el('span',{class:'chip '+(c.passed?'green':(c.blocking?'red':'amber')), text:(c.passed?'✓ ':(c.blocking?'✕ ':'! '))+c.label, title:c.detail||''}); checksHost.appendChild(chip); }); } if(cert&&cert.reason){ checksHost.appendChild(el('p',{class:'muted', text:cert.reason})); } }
    var policy=state.certificatePolicy; var note=$('doc-cert-note');
    if(policy&&note){ note.textContent=policy.note+' Accepted: '+policy.accept+' · up to '+Math.round(policy.maxBytes/1024/1024)+' MB.'; }
    var regInput=$('doc-cert-regno'); if(regInput&&!regInput.value&&state.doctor.registrationNo){ regInput.value=state.doctor.registrationNo; }
  }

  function onCertificateUpload(){
    var err=$('doc-cert-error'); if(err) err.classList.add('hidden');
    var file=$('doc-cert-file').files&&$('doc-cert-file').files[0];
    if(!file){ if(err){ err.textContent='Choose certificate file first.'; err.classList.remove('hidden'); } return; }
    var form=new FormData(); form.append('certificate',file);
    var regno=$('doc-cert-regno').value.trim(); if(regno) form.append('registrationNo',regno);
    var btn=$('doc-cert-submit'); if(btn) btn.disabled=true;
    api('/doctor/certificate',{method:'POST', body:form}).then(function(res){
      state.doctor=res.doctor; state.certificatePolicy=res.policy||state.certificatePolicy;
      renderVerificationBanner(); renderCertificatePanel();
      if(res.certificate&&res.certificate.verified){ toast(res.activated?'Certificate checked — console open.':'Certificate checked — waiting review.'); return boot(); }
      if(err){ err.textContent=(res.certificate&&res.certificate.reason)||'That certificate did not pass.'; err.classList.remove('hidden'); }
      return null;
    }).catch(function(e){ if(err){ err.textContent=e.message; err.classList.remove('hidden'); } }).then(function(){ if(btn) btn.disabled=false; });
  }

  function setView(view){
    state.view=view;
    document.querySelectorAll('.doc-nav-item').forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-view')===view); });
    document.querySelectorAll('.bottom-nav .nav-item').forEach(function(b){ var v=b.getAttribute('data-view')||b.getAttribute('data-bottom'); b.classList.toggle('active', v===view); });
    render();
  }
  function render(){
    var host=$('doc-view'); if(!host) return; host.innerHTML='';
    if(!state.doctor) return;
    if(state.doctor.status!=='active'){ host.appendChild(renderProfile()); return; }
    if(state.view==='dashboard') host.appendChild(renderDashboard());
    else if(state.view==='consults') host.appendChild(renderConsults());
    else if(state.view==='studio') host.appendChild(renderStudio());
    else if(state.view==='earnings') host.appendChild(renderEarnings());
    else host.appendChild(renderProfile());
  }
  function renderDashboard(){
    var wrap=el('div'); var o=state.overview||{queue:{}, reach:{}, topVideos:[]};
    var tiles=el('div',{class:'doc-tiles'});
    var tile=function(value,label){ var t=el('div',{class:'doc-tile'}); t.appendChild(el('strong',{text:String(value)})); t.appendChild(el('span',{text:label})); return t; };
    tiles.appendChild(tile(o.queue.requested||0,'consults waiting')); tiles.appendChild(tile(o.queue.answered||0,'answered')); tiles.appendChild(tile(o.reach.views||0,'short views')); tiles.appendChild(tile(Math.round((o.reach.watchSeconds||0)/60)+'m','watched')); wrap.appendChild(tiles);
    var money=el('div',{class:'doc-card'}); var earnings=state.earnings;
    money.appendChild(el('h3',{text:'This month'}));
    if(earnings){
      money.appendChild(el('p',{class:'muted', text:'Consultations '+rsFromPaise(earnings.totals.consultationSharePaise)+' · Shorts pool '+rsFromPaise(earnings.totals.videoPoolSharePaise)+' · Total '+rsFromPaise(earnings.totals.totalPaise)}));
      var why=el('ul',{class:'doc-explain'}); (earnings.revenueModel.explainer||[]).forEach(function(line){ why.appendChild(el('li',{text:line})); }); money.appendChild(why); money.appendChild(el('p',{class:'muted', text:earnings.payoutNote}));
    }else{ money.appendChild(el('p',{class:'muted', text:'Earnings appear once patient subscribes or consults.'})); }
    wrap.appendChild(money);
    if(o.topVideos&&o.topVideos.length){
      var top=el('div',{class:'doc-card'}); top.appendChild(el('h3',{text:'Best performing shorts'}));
      o.topVideos.forEach(function(v){ var row=el('div',{class:'doc-video-row'}); row.appendChild(el('span',{class:'doc-video-thumb'})); var main=el('div',{class:'doc-video-main'}); main.appendChild(el('strong',{text:v.title})); main.appendChild(el('span',{class:'doc-video-stats', text:v.viewCount+' views · '+Math.round(v.watchSeconds/60)+' min watched'})); row.appendChild(main); top.appendChild(row); }); wrap.appendChild(top);
    }
    var queue=el('div',{class:'doc-card'}); queue.appendChild(el('h3',{text:'Waiting for you'}));
    var pending=state.consultations.filter(function(c){ return ['requested','in_review'].indexOf(c.status)>=0; }).slice(0,4);
    if(!pending.length) queue.appendChild(el('p',{class:'doc-empty', text:'No open consultations right now.'}));
    pending.forEach(function(c){ queue.appendChild(consultRow(c)); }); wrap.appendChild(queue); return wrap;
  }
  function consultRow(c){
    var row=el('button',{class:'doc-consult', type:'button'});
    var main=el('div',{class:'doc-consult-main'});
    main.appendChild(el('strong',{text:c.subject}));
    main.appendChild(el('span',{class:'muted', text:(c.member?c.member.name+(c.member.age?', '+c.member.age:''):'Patient')+' · '+shortDate(c.createdAt)}));
    main.appendChild(el('span',{class:'muted', text:c.includedInPlan?'Covered by Care+ plan':'Paid · '+rs(c.feeInr)}));
    row.appendChild(main);
    var side=el('div',{class:'doc-consult-side'});
    side.appendChild(statusChip(c.status));
    side.appendChild(el('span',{class:'chip '+(c.chartAccess&&c.chartAccess.granted?'green':'grey'), text:c.chartAccess&&c.chartAccess.granted?'chart shared':'no chart'}));
    side.appendChild(icon('chevron-right',18)); row.appendChild(side);
    row.addEventListener('click',function(){ openConsultation(c.id); }); return row;
  }
  function renderConsults(){
    var wrap=el('div'); var head=el('div',{class:'doc-card doc-row'}); head.appendChild(el('h3',{text:'Consultation queue'}));
    var chips=el('div',{class:'doc-chips'});
    [['','All'],['requested','New'],['in_review','In review'],['answered','Answered'],['closed','Closed']].forEach(function(pair){
      var b=el('button',{class:'chip-btn'+(state.filter===pair[0]?' active':''), type:'button'},[pair[1]]);
      b.addEventListener('click',function(){ state.filter=pair[0]; render(); }); chips.appendChild(b);
    });
    head.appendChild(chips); wrap.appendChild(head);
    var list=el('div',{class:'doc-card'}); var items=state.consultations.filter(function(c){ return !state.filter||c.status===state.filter; });
    if(!items.length) list.appendChild(el('p',{class:'doc-empty', text:'Nothing here yet.'}));
    items.forEach(function(c){ list.appendChild(consultRow(c)); }); wrap.appendChild(list); return wrap;
  }
  function openConsultation(id){
    apiWithRefresh('/doctor/consultations/'+id).then(function(detail){ state.consultation=detail; renderOverlay(); }).catch(function(e){ toast(e.message); });
  }
  function closeOverlay(){ var ov=$('doc-overlay'); if(ov){ ov.classList.add('hidden'); ov.innerHTML=''; } state.consultation=null; }
  function renderOverlay(){
    var d=state.consultation; if(!d) return; var overlay=$('doc-overlay'); if(!overlay) return; overlay.innerHTML=''; overlay.classList.remove('hidden');
    var card=el('div',{class:'doc-overlay-card'}); var head=el('div',{class:'doc-row'}); var left=el('div');
    left.appendChild(el('h2',{text:d.consultation.subject})); left.appendChild(el('span',{class:'muted', text:(d.member?d.member.name:'Patient')+' · '+shortDate(d.consultation.createdAt)})); head.appendChild(left);
    var actions=el('div',{class:'doc-actions'}); actions.appendChild(statusChip(d.consultation.status));
    if(d.consultation.status==='requested'){
      var accept=el('button',{class:'btn primary sm', type:'button'},['Accept case']);
      accept.addEventListener('click',function(){ api('/doctor/consultations/'+d.consultation.id+'/accept',{method:'POST'}).then(function(){ toast('Case accepted.'); openConsultation(d.consultation.id); refreshAll(); }).catch(function(e){ toast(e.message); }); });
      actions.appendChild(accept);
    }
    var closeBtn=el('button',{class:'btn ghost sm', type:'button'},['Close']); closeBtn.addEventListener('click',closeOverlay); actions.appendChild(closeBtn); head.appendChild(actions); card.appendChild(head);
    var q=el('div',{class:'brief-block'}); q.appendChild(el('h4',{text:'What the patient asked'})); q.appendChild(el('p',{text:d.consultation.question})); card.appendChild(q);
    if(!d.chartAccess.granted){ var noChart=el('div',{class:'doc-card doc-note'}); noChart.appendChild(el('strong',{text:'No chart access'})); noChart.appendChild(el('p',{class:'muted', text:d.chartAccess.reason+' You can still read question, but clinical reply needs chart.'})); card.appendChild(noChart); }
    else if(d.brief){ card.appendChild(renderBrief(d.brief,d.summaryLine)); }
    card.appendChild(renderMedicinePanel(d)); card.appendChild(renderReplyPanel(d)); card.appendChild(renderThread(d)); overlay.appendChild(card);
  }
  function renderBrief(brief,summaryLine){
    var wrap=el('div'); var head=el('div',{class:'doc-row'}); head.appendChild(el('h3',{text:'One-screen brief'})); head.appendChild(el('span',{class:'chip teal', text:'verified records only'})); wrap.appendChild(head);
    if(summaryLine){ wrap.appendChild(el('p',{class:'muted', text:summaryLine.problemCount+' out-of-range · '+summaryLine.changedCount+' changes · '+(summaryLine.riskBand?summaryLine.riskBand+' risk band':'risk n/a')})); }
    var grid=el('div',{class:'brief-grid'}); var leftCol=el('div');
    var problems=el('div',{class:'brief-block'}); problems.appendChild(el('h4',{text:'Active problems'}));
    if(!brief.activeProblems.length) problems.appendChild(el('p',{class:'muted', text:'Everything inside range.'}));
    else{ var table=el('table',{class:'brief-table'}); brief.activeProblems.slice(0,12).forEach(function(p){ var tr=el('tr'); tr.appendChild(el('td',{},[el('strong',{text:p.name})])); tr.appendChild(el('td',{},[el('span',{class:p.status==='high'?'brief-high':'brief-low', text:p.value+(p.unit?' '+p.unit:'')+' '+p.status}), el('span',{class:'muted', text:' vs '+(p.reference.low!=null?p.reference.low:'—')+'–'+(p.reference.high!=null?p.reference.high:'—')})])); table.appendChild(tr); }); problems.appendChild(table); }
    leftCol.appendChild(problems);
    var changed=el('div',{class:'brief-block'}); changed.appendChild(el('h4',{text:'Changed since first report'}));
    if(!brief.changedSinceLastReport.length) changed.appendChild(el('p',{class:'muted', text:'No meaningful movement yet.'}));
    else{ var ct=el('table',{class:'brief-table'}); brief.changedSinceLastReport.slice(0,8).forEach(function(c){ var tr=el('tr'); tr.appendChild(el('td',{},[el('strong',{text:c.name})])); tr.appendChild(el('td',{},[el('span',{class:c.direction==='rising'?'brief-high':'brief-low', text:c.direction}), el('span',{class:'muted', text:' '+(c.deltaPct!=null?(c.deltaPct>0?'+':'')+c.deltaPct+'%':'')+' · now '+c.to.value+(c.to.unit?' '+c.to.unit:'')})])); ct.appendChild(tr); }); changed.appendChild(ct); }
    leftCol.appendChild(changed);
    var vitals=el('div',{class:'brief-block'}); vitals.appendChild(el('h4',{text:'Vitals & lifestyle'})); var vt=el('table',{class:'brief-table'}); var push=function(label,value){ var tr=el('tr'); tr.appendChild(el('td',{text:label})); tr.appendChild(el('td',{text:value==null?'—':String(value)})); vt.appendChild(tr); };
    push('Blood pressure', brief.vitals.bp&&brief.vitals.bp.systolic?brief.vitals.bp.systolic+'/'+(brief.vitals.bp.diastolic||'—')+' mmHg':null); push('Weight', brief.vitals.weightKg!=null?brief.vitals.weightKg+' kg':null); push('BMI', brief.vitals.bmi); push('Activity', brief.vitals.activityMinutesPerWeek!=null?brief.vitals.activityMinutesPerWeek+' min/week':null); push('Sleep', brief.vitals.sleepHours!=null?brief.vitals.sleepHours+' h/night':null); vitals.appendChild(vt); leftCol.appendChild(vitals); grid.appendChild(leftCol);
    var rightCol=el('div'); var meds=el('div',{class:'brief-block'}); meds.appendChild(el('h4',{text:'Current medicines'})); if(!brief.medications.length) meds.appendChild(el('p',{class:'muted', text:'None recorded — ask (see gap list).'})); else brief.medications.forEach(function(m){ meds.appendChild(el('p',{text:m.name+(m.dose?' · '+m.dose:'')})); }); rightCol.appendChild(meds);
    var risk=el('div',{class:'brief-block'}); risk.appendChild(el('h4',{text:'Risk flag (not clinically validated)'})); if(!brief.riskFlags.length) risk.appendChild(el('p',{class:'muted', text:'Not computable from current data.'})); else{ brief.riskFlags.forEach(function(r){ risk.appendChild(el('p',{},[el('strong',{text:r.percent+'% — '+r.band})])); risk.appendChild(el('p',{class:'muted', text:r.confidenceNote})); if(r.topFactors.length) risk.appendChild(el('p',{class:'muted', text:'Top factors: '+r.topFactors.join(', ')})); }); } rightCol.appendChild(risk);
    var gaps=el('div',{class:'brief-block'}); gaps.appendChild(el('h4',{text:'What chart cannot tell you'})); var ul=el('ul',{class:'gap-list'}); brief.gapsToAsk.forEach(function(g){ var li=el('li'); li.appendChild(document.createTextNode(g.ask)); li.appendChild(el('span',{class:'gap-why', text:g.why})); ul.appendChild(li); }); gaps.appendChild(ul); rightCol.appendChild(gaps);
    var prov=el('div',{class:'brief-block'}); prov.appendChild(el('h4',{text:'Data provenance'})); prov.appendChild(el('p',{class:'muted', text:brief.provenance.source+' · '+brief.provenance.rule})); rightCol.appendChild(prov); grid.appendChild(rightCol); wrap.appendChild(grid); return wrap;
  }
  function renderMedicinePanel(d){
    var wrap=el('div',{class:'doc-card'}); var head=el('div',{class:'doc-row'}); var title=el('h3'); title.appendChild(document.createTextNode('Medicine preview ')); title.appendChild(el('span',{class:'ai-tag', text:'AI draft'})); head.appendChild(title);
    var actions=el('div',{class:'doc-actions'}); var gen=el('button',{class:'btn secondary sm', type:'button'},[d.medicinePlan?'Refresh draft':'Generate draft']);
    gen.addEventListener('click',function(){ api('/doctor/consultations/'+d.consultation.id+'/medicine-draft',{method:'POST', body:{}}).then(function(){ toast('Draft ready.'); openConsultation(d.consultation.id); }).catch(function(e){ toast(e.message); }); }); actions.appendChild(gen); head.appendChild(actions); wrap.appendChild(head);
    if(!d.medicinePlan){ wrap.appendChild(el('p',{class:'muted', text:'No draft yet. Draft lists therapy CLASSES — never doses.'})); return wrap; }
    var plan=d.medicinePlan;
    if(plan.status==='approved'){
      wrap.appendChild(el('p',{class:'chip green', text:'Approved and shared'}));
      plan.finalItems.forEach(function(item){ var row=el('div',{class:'med-suggest'}); row.appendChild(el('h5',{text:(item.product||item.name||item.code)})); if(item.instructions) row.appendChild(el('p',{class:'why', text:item.instructions})); wrap.appendChild(row); });
      if(plan.doctorNote) wrap.appendChild(el('p',{class:'muted', text:'Note: '+plan.doctorNote}));
      return wrap;
    }
    var draft=plan.aiDraft;
    if(draft&&draft.skipped&&draft.skipped.suspiciousOcrValues.length){ wrap.appendChild(el('p',{class:'doc-note', text:'Excluded as probable OCR misreads: '+draft.skipped.suspiciousOcrValues.map(function(s){ return s.name; }).join(', ')})); }
    var controls=[];
    (draft?draft.items:[]).forEach(function(item){
      var box=el('div',{class:'med-suggest'}); var h=el('h5'); h.appendChild(document.createTextNode(item.label+' ')); h.appendChild(el('span',{class:'chip '+(item.severity==='attention'?'amber':'grey'), text:item.markerName+' '+item.latestValue+(item.unit?' '+item.unit:'')})); box.appendChild(h);
      box.appendChild(el('p',{class:'why', text:item.suggestedClass})); box.appendChild(el('p',{class:'why', text:item.rationale}));
      var ul=el('ul'); item.cautions.forEach(function(c){ ul.appendChild(el('li',{text:c})); }); box.appendChild(ul);
      var edit=el('div',{class:'med-edit'}); var product=el('input',{type:'text', placeholder:'What you actually want to give'}); var instructions=el('input',{type:'text', placeholder:'Your instructions'}); var decision=el('select'); [['edit','Edit & include'],['keep','Accept class'],['skip','Skip']].forEach(function(pair){ var opt=el('option',{value:pair[0], text:pair[1]}); decision.appendChild(opt); }); edit.appendChild(product); edit.appendChild(instructions); edit.appendChild(decision); box.appendChild(edit);
      controls.push({item:item, product:product, instructions:instructions, decision:decision}); wrap.appendChild(box);
    });
    if(!controls.length){ wrap.appendChild(el('p',{class:'muted', text:'No medicine suggestions for this chart.'})); }
    var ackBox=el('div',{class:'med-ack'}); ackBox.appendChild(el('strong',{text:'Safety checklist (all four required)'})); var ackInputs={};
    (draft&&draft.acknowledgementsRequired?draft.acknowledgementsRequired:[]).forEach(function(ack){ var input=el('input',{type:'checkbox'}); var label=el('label',{},[input, el('span',{text:ack.label})]); ackInputs[ack.key]=input; ackBox.appendChild(label); }); wrap.appendChild(ackBox);
    var note=el('input',{type:'text', placeholder:'Note to patient (optional)'}); wrap.appendChild(note);
    var row=el('div',{class:'doc-actions'}); var approve=el('button',{class:'btn primary sm', type:'button'},['Approve & share']); approve.addEventListener('click',function(){
      var items=controls.map(function(c){ return {code:c.item.markerCode, name:c.item.markerName, decision:c.decision.value, product:c.product.value.trim()||null, instructions:c.instructions.value.trim()||null}; });
      var acks=Object.keys(ackInputs).filter(function(k){ return ackInputs[k].checked; });
      api('/doctor/consultations/'+d.consultation.id+'/medicine-plan/approve',{method:'POST', body:{items:items, doctorNote:note.value.trim()||null, acknowledgements:acks}}).then(function(){ toast('Plan approved.'); openConsultation(d.consultation.id); }).catch(function(e){ if(e.code==='VALIDATION_ERROR') toast('Tick all four safety checks first.'); else toast(e.message); });
    }); row.appendChild(approve);
    var reject=el('button',{class:'btn ghost sm', type:'button'},['Reject draft']); reject.addEventListener('click',function(){ api('/doctor/consultations/'+d.consultation.id+'/medicine-plan/reject',{method:'POST', body:{}}).then(function(){ toast('Draft rejected.'); openConsultation(d.consultation.id); }).catch(function(e){ toast(e.message); }); }); row.appendChild(reject); wrap.appendChild(row);
    wrap.appendChild(el('p',{class:'muted', text:(draft&&draft.disclaimers?draft.disclaimers[0]:'')})); return wrap;
  }
  function renderReplyPanel(d){
    var wrap=el('div',{class:'doc-card'}); wrap.appendChild(el('h3',{text:'Reply to patient'}));
    if(!d.chartAccess.granted){ wrap.appendChild(el('p',{class:'muted', text:'Chart access off, so clinical reply cannot be sent.'})); return wrap; }
    var body=el('textarea',{rows:'4', placeholder:'Explain what you see, what to do next and when to come in.'}); wrap.appendChild(body);
    var picks=el('div',{class:'doc-chips'}); var selected=[];
    if(!state.recommendable.length) picks.appendChild(el('span',{class:'muted', text:'No published shorts yet.'}));
    state.recommendable.forEach(function(v){
      var b=el('button',{class:'chip-btn', type:'button'},[v.title+' · '+v.durationSec+'s']);
      b.addEventListener('click',function(){ var i=selected.indexOf(v.id); if(i>=0){ selected.splice(i,1); b.classList.remove('active'); }else if(selected.length<3){ selected.push(v.id); b.classList.add('active'); }else toast('Up to three shorts per reply.'); });
      picks.appendChild(b);
    });
    wrap.appendChild(picks);
    var send=el('button',{class:'btn primary', type:'button'},['Send reply']);
    send.addEventListener('click',function(){
      if(body.value.trim().length<5) return toast('Write reply first.');
      if(d.consultation.status==='payment_pending') return toast('This consultation still awaiting payment.');
      api('/doctor/consultations/'+d.consultation.id+'/reply',{method:'POST', body:{body:body.value.trim(), videoIds:selected}}).then(function(){ toast('Reply sent.'); openConsultation(d.consultation.id); refreshAll(); }).catch(function(e){ if(e.code==='CONSENT_REQUIRED') toast('Patient revoked chart access — nothing sent.'); else toast(e.message); });
    });
    wrap.appendChild(send); return wrap;
  }
  function renderThread(d){
    var wrap=el('div',{class:'doc-card'}); wrap.appendChild(el('h3',{text:'Thread'}));
    (d.messages||[]).forEach(function(m){ var row=el('div',{class:'brief-block'}); row.appendChild(el('span',{class:'muted', text:(m.authorRole==='doctor'?'You':m.authorRole==='patient'?'Patient':'System')+' · '+shortDate(m.createdAt)+(m.kind!=='text'?' · '+m.kind.replace('_',' '):'') })); row.appendChild(el('p',{text:m.body})); wrap.appendChild(row); });
    if(d.consultation.status==='answered'||d.consultation.status==='in_review'){
      var close=el('button',{class:'btn ghost sm', type:'button'},['Close consultation']); close.addEventListener('click',function(){ api('/doctor/consultations/'+d.consultation.id+'/close',{method:'POST', body:{}}).then(function(){ toast('Closed.'); closeOverlay(); refreshAll(); }).catch(function(e){ toast(e.message); }); }); wrap.appendChild(close);
    }
    return wrap;
  }
  function renderStudio(){
    var wrap=el('div'); var form=el('div',{class:'doc-card'}); form.appendChild(el('h3',{text:'Record a short'}));
    form.appendChild(el('p',{class:'muted', text:'Answer ONE recurring doubt in under a minute. Claim language ("cure", "guaranteed") rejected automatically.'}));
    var g1=el('div',{class:'doc-grid-2'}); var title=el('input',{type:'text', placeholder:'Knee pain: three red flags'}); var topic=el('select');
    (state.specialties||[]).forEach(function(s){ topic.appendChild(el('option',{value:s.key, text:s.label})); }); if(!topic.options.length&&state.doctor) topic.appendChild(el('option',{value:state.doctor.specialty, text:state.doctor.specialty})); if(state.doctor) topic.value=state.doctor.specialty;
    g1.appendChild(el('label',{class:'field'},[el('span',{text:'Title'}), title])); g1.appendChild(el('label',{class:'field'},[el('span',{text:'Topic'}), topic])); form.appendChild(g1);
    var g2=el('div',{class:'doc-grid-3'}); var duration=el('input',{type:'number', min:'5', max:'600', value:'45'}); var language=el('input',{type:'text', value:'en'}); var preview=el('select'); [['true','Free preview'],['false','Care+ only']].forEach(function(pair){ preview.appendChild(el('option',{value:pair[0], text:pair[1]})); });
    g2.appendChild(el('label',{class:'field'},[el('span',{text:'Duration (s)'}), duration])); g2.appendChild(el('label',{class:'field'},[el('span',{text:'Language'}), language])); g2.appendChild(el('label',{class:'field'},[el('span',{text:'Visibility'}), preview])); form.appendChild(g2);
    var summary=el('input',{type:'text', placeholder:'One line on what this short answers'}); form.appendChild(el('label',{class:'field'},[el('span',{text:'Summary'}), summary]));
    var points=el('textarea',{rows:'3', placeholder:'One key point per line'}); form.appendChild(el('label',{class:'field'},[el('span',{text:'Key points'}), points]));
    var tags=el('input',{type:'text', placeholder:'knee, stairs, pain'}); form.appendChild(el('label',{class:'field'},[el('span',{text:'Tags'}), tags]));
    var fileRow=el('div',{class:'doc-file-row'}); var file=el('input',{type:'file', accept:'video/mp4,video/webm,video/quicktime'}); fileRow.appendChild(icon('video',16)); fileRow.appendChild(file); form.appendChild(fileRow);
    form.appendChild(el('p',{class:'muted', text:'Optional. Without file, short published as caption short.'}));
    var err=el('p',{class:'error hidden'}); form.appendChild(err);
    var publish=el('button',{class:'btn primary', type:'button'},['Publish short']);
    publish.addEventListener('click',function(){
      err.classList.add('hidden'); publish.disabled=true;
      var fd=new FormData(); fd.append('title',title.value.trim()); fd.append('topic',topic.value); fd.append('summary',summary.value.trim()); fd.append('durationSec',String(Number(duration.value||45))); fd.append('language',language.value.trim()||'en'); fd.append('isPreview',preview.value);
      fd.append('keyPoints', JSON.stringify(points.value.split('\n').map(function(s){ return s.trim(); }).filter(Boolean))); fd.append('tags',tags.value);
      if(file.files&&file.files[0]) fd.append('file',file.files[0]);
      api('/doctor/videos',{method:'POST', body:fd}).then(function(){ toast('Short published.'); title.value=''; summary.value=''; points.value=''; tags.value=''; file.value=''; return refreshAll(); }).catch(function(e){ err.textContent=e.message; err.classList.remove('hidden'); }).then(function(){ publish.disabled=false; });
    });
    form.appendChild(publish); wrap.appendChild(form);
    var lib=el('div',{class:'doc-card'}); lib.appendChild(el('h3',{text:'Your shorts'}));
    if(!state.library||!state.library.items.length){ lib.appendChild(el('p',{class:'doc-empty', text:'Nothing published yet.'})); }
    else{
      lib.appendChild(el('p',{class:'muted', text:state.library.stats.published+' published · '+state.library.stats.views+' views · '+Math.round(state.library.stats.watchSeconds/60)+' min watched'}));
      state.library.items.forEach(function(v){
        var row=el('div',{class:'doc-video-row'}); row.appendChild(el('span',{class:'doc-video-thumb'}));
        var main=el('div',{class:'doc-video-main'}); main.appendChild(el('strong',{text:v.title})); main.appendChild(el('span',{class:'doc-video-stats', text:v.durationSec+'s · '+(v.isPreview?'free preview':'Care+')+' · '+v.status+' · '+v.viewCount+' views'})); row.appendChild(main);
        if(v.status!=='archived'){ var arch=el('button',{class:'btn ghost sm', type:'button'},['Archive']); arch.addEventListener('click',function(){ api('/doctor/videos/'+v.id,{method:'DELETE'}).then(function(){ toast('Archived.'); refreshAll(); }).catch(function(e){ toast(e.message); }); }); row.appendChild(arch); }
        lib.appendChild(row);
      });
    }
    wrap.appendChild(lib); return wrap;
  }
  function renderEarnings(){
    var wrap=el('div'); var e=state.earnings;
    if(!e){ wrap.appendChild(el('p',{class:'doc-empty', text:'No earnings data yet.'})); return wrap; }
    var head=el('div',{class:'doc-card doc-row'}); head.appendChild(el('h3',{text:'Earnings — '+e.period}));
    var periods=el('select'); (e.availablePeriods||[e.period]).forEach(function(p){ var opt=el('option',{value:p, text:p}); if(p===e.period) opt.selected=true; periods.appendChild(opt); });
    periods.addEventListener('change',function(){ api('/doctor/earnings?period='+periods.value).then(function(res){ state.earnings=res; render(); }).catch(function(err){ toast(err.message); }); });
    head.appendChild(periods); wrap.appendChild(head);
    var tiles=el('div',{class:'doc-tiles'}); var tile=function(value,label){ var t=el('div',{class:'doc-tile'}); t.appendChild(el('strong',{text:value})); t.appendChild(el('span',{text:label})); return t; };
    tiles.appendChild(tile(rsFromPaise(e.totals.totalPaise),'total this month')); tiles.appendChild(tile(rsFromPaise(e.totals.consultationSharePaise),'consultations (70%)')); tiles.appendChild(tile(rsFromPaise(e.totals.videoPoolSharePaise),'shorts pool')); tiles.appendChild(tile(e.activity.watchSeconds+'s','watched this month')); wrap.appendChild(tiles);
    var pools=el('div',{class:'doc-card'}); pools.appendChild(el('h3',{text:'How pools look'}));
    pools.appendChild(el('p',{class:'muted', text:'Shorts pool: '+rsFromPaise(e.pools.shorts.accrualPaise)+' accrued, '+rsFromPaise(e.pools.shorts.distributedPaise)+' distributed ('+e.pools.shorts.yourSharePercent+'% to you).'}));
    var ul=el('ul',{class:'doc-explain'}); (e.revenueModel.explainer||[]).forEach(function(line){ ul.appendChild(el('li',{text:line})); }); pools.appendChild(ul); pools.appendChild(el('p',{class:'muted', text:e.payoutNote})); wrap.appendChild(pools);
    var ledger=el('div',{class:'doc-card'}); ledger.appendChild(el('h3',{text:'Ledger'}));
    if(!e.entries.length) ledger.appendChild(el('p',{class:'doc-empty', text:'No entries for this month.'}));
    else{ var table=el('table',{class:'doc-ledger'}); var thead=el('tr'); ['When','Entry','Description','Amount'].forEach(function(h){ thead.appendChild(el('th',{text:h})); }); table.appendChild(thead); e.entries.forEach(function(entry){ var tr=el('tr'); tr.appendChild(el('td',{text:shortDate(entry.createdAt)})); tr.appendChild(el('td',{text:entry.entryType.replace(/_/g,' ')})); tr.appendChild(el('td',{text:entry.description||'—'})); tr.appendChild(el('td',{text:rsFromPaise(entry.amountPaise)})); table.appendChild(tr); }); ledger.appendChild(table); }
    wrap.appendChild(ledger); return wrap;
  }
  function renderProfile(){
    var wrap=el('div'); var d=state.doctor; var grid=el('div',{class:'brief-grid'});
    var form=el('div',{class:'doc-card'}); form.appendChild(el('h3',{text:'Public profile'})); form.appendChild(el('p',{class:'muted', text:'This is identity patients see — "Dr '+d.fullName+' · '+d.headline+'".'}));
    var g1=el('div',{class:'doc-grid-2'}); var headline=el('input',{type:'text', value:d.headline}); var fee=el('input',{type:'number', min:'0', max:'100000', value:String(d.consultFeeInr)});
    g1.appendChild(el('label',{class:'field'},[el('span',{text:'Headline'}), headline])); g1.appendChild(el('label',{class:'field'},[el('span',{text:'Consult fee (₹)'}), fee])); form.appendChild(g1);
    var g2=el('div',{class:'doc-grid-2'}); var city=el('input',{type:'text', value:d.city||''}); var clinic=el('input',{type:'text', value:d.clinicName||''});
    g2.appendChild(el('label',{class:'field'},[el('span',{text:'City'}), city])); g2.appendChild(el('label',{class:'field'},[el('span',{text:'Clinic'}), clinic])); form.appendChild(g2);
    var bio=el('textarea',{rows:'4'}); bio.value=d.bio||''; form.appendChild(el('label',{class:'field'},[el('span',{text:'Bio'}), bio]));
    var save=el('button',{class:'btn primary', type:'button'},['Save profile']);
    save.addEventListener('click',function(){
      api('/doctor/profile',{method:'PATCH', body:{headline:headline.value.trim()||undefined, consultFeeInr:Number(fee.value||0), city:city.value.trim()||undefined, clinicName:clinic.value.trim()||undefined, bio:bio.value.trim()||undefined}}).then(function(res){ state.doctor=res.doctor; toast('Profile updated.'); renderVerificationBanner(); refreshAll(); }).catch(function(e){ toast(e.message); });
    });
    form.appendChild(save);
    if(d.status!=='active'){
      var kyc=el('button',{class:'btn secondary', type:'button'},['Complete verification']); kyc.addEventListener('click',function(){ api('/doctor/kyc/mock',{method:'POST', body:{}}).then(function(res){ state.doctor=res.doctor; toast('Verification complete — live!'); boot(); }).catch(function(e){ toast(e.message); }); }); form.appendChild(kyc);
    }
    grid.appendChild(form);
    var cardWrap=el('div',{class:'doc-card'}); cardWrap.appendChild(el('h3',{text:'Identity card'})); cardWrap.appendChild(renderIdCard(d)); cardWrap.appendChild(el('p',{class:'muted', text:'Share this card in clinic or WhatsApp. Verification link resolves to public profile.'})); grid.appendChild(cardWrap);
    wrap.appendChild(grid); return wrap;
  }
  function renderIdCard(d){
    var card=el('div',{class:'id-card'}); card.appendChild(el('span',{class:'id-strip'})); card.appendChild(el('h3',{text:d.fullName})); card.appendChild(el('span',{class:'id-headline', text:d.headline}));
    var meta=el('div',{class:'id-meta'}); meta.appendChild(el('span',{text:d.specialty.replace(/_/g,' ')})); meta.appendChild(el('span',{text:(d.experienceYears||0)+' yrs'})); if(d.city) meta.appendChild(el('span',{text:d.city})); meta.appendChild(el('span',{text:d.consultFeeInr?rs(d.consultFeeInr)+' consult':'free consult'})); card.appendChild(meta);
    card.appendChild(el('div',{class:'id-code', text:d.identityCardNo})); card.appendChild(el('div',{class:'id-verify', text:d.verified?'Demo verification · registry pending':'Verification pending'})); return card;
  }

  /* Easy sign-in helpers for doctor */
  function setupEasyDoctor(){
    var pwToggle=$('doc-toggle-pw'), pwInput=$('doc-password');
    if(pwToggle&&pwInput){
      pwToggle.addEventListener('click',function(){
        var isPw=pwInput.type==='password'; pwInput.type=isPw?'text':'password'; pwToggle.textContent=isPw?'🙈':'👁';
      });
    }
    var apToggle=$('ap-toggle-pw'), apPw=$('ap-password');
    if(apToggle&&apPw){
      apToggle.addEventListener('click',function(){
        var isPw=apPw.type==='password'; apPw.type=isPw?'text':'password'; apToggle.textContent=isPw?'🙈':'👁';
      });
    }
    var demoFill=$('doc-demo-fill');
    if(demoFill){
      demoFill.addEventListener('click',function(){
        var em=$('doc-email'), pw=$('doc-password'), rn=$('doc-regno');
        if(em) em.value='dr.mohan@kivo.dev';
        if(pw) pw.value='Kivo!Doctor#2026';
        if(rn) rn.value='MCI-DEMO-4471';
        setAuthTab('login');
        toast('Demo doctor filled — signing in…');
        setTimeout(function(){ var f=$('doc-login-form'); if(f) f.dispatchEvent(new Event('submit',{cancelable:true})); }, 300);
      });
    }
    var goLogin=$('doc-go-login');
    if(goLogin){ goLogin.addEventListener('click',function(ev){ ev.preventDefault(); setAuthTab('login'); }); }
    var demoPat=$('doc-demo-patient');
    if(demoPat){ demoPat.addEventListener('click',function(){ location.href='/app/'; }); }

    // remembered email
    try{
      var rem=localStorage.getItem('mt.doctor.remember.email');
      if(rem){ var em2=$('doc-email'); if(em2&&!em2.value) em2.value=rem; var apEm=$('ap-email'); if(apEm&&!apEm.value) apEm.value=rem; }
    }catch(e){}

    // bottom nav
    document.querySelectorAll('.doc-bottom-nav .nav-item').forEach(function(b){
      b.addEventListener('click',function(){ setView(b.getAttribute('data-view')||b.getAttribute('data-bottom')); });
    });
  }

  /* Persistent refresh for doctor */
  var refreshInterval=null;
  function startPersistent(){
    if(refreshInterval) clearInterval(refreshInterval);
    refreshInterval=setInterval(function(){
      if(state.tokens&&state.tokens.refreshToken){ refreshSession(); }
    }, 10*60*1000);
    document.addEventListener('visibilitychange',function(){
      if(document.visibilityState==='visible'&&state.tokens){
        var ts=0; try{ ts=Number(localStorage.getItem(TOKEN_KEY+'.ts')||0); }catch(e){}
        if(Date.now()-ts>5*60*1000) refreshSession();
      }
    });
  }

  function init(){
    try{
      Icons.set($('doc-logo'),'stethoscope',22);
      Icons.set($('doc-user-icon'),'user',16);
      Icons.set($('doc-logout-icon'),'log-out',15);
      var nd=$('nav-dashboard'); if(nd){ var ic=nd.querySelector('.nav-ic'); if(ic) Icons.set(ic,'activity',18); }
      var nc=$('nav-consults'); if(nc){ var ic2=nc.querySelector('.nav-ic'); if(ic2) Icons.set(ic2,'message-square',18); }
      var ns=$('nav-studio'); if(ns){ var ic3=ns.querySelector('.nav-ic'); if(ic3) Icons.set(ic3,'video',18); }
      var ne=$('nav-earnings'); if(ne){ var ic4=ne.querySelector('.nav-ic'); if(ic4) Icons.set(ic4,'wallet',18); }
      var np=$('nav-profile'); if(np){ var ic5=np.querySelector('.nav-ic'); if(ic5) Icons.set(ic5,'id-card',18); }
    }catch(e){}

    var tl=$('doc-tab-login'), ta=$('doc-tab-apply');
    if(tl) tl.addEventListener('click',function(){ setAuthTab('login'); });
    if(ta) ta.addEventListener('click',function(){ setAuthTab('apply'); });
    var lf=$('doc-login-form'); if(lf) lf.addEventListener('submit', onLogin);
    var af=$('doc-apply-form'); if(af) af.addEventListener('submit', onApply);
    var cs=$('doc-cert-submit'); if(cs) cs.addEventListener('click', onCertificateUpload);
    var lo=$('doc-logout'); if(lo) lo.addEventListener('click', logout);
    document.querySelectorAll('.doc-nav-item').forEach(function(b){ b.addEventListener('click',function(){ setView(b.getAttribute('data-view')); }); });

    api('/public/doctors/specialties').then(function(res){
      state.specialties=res.specialties;
      var sel=$('ap-specialty'); if(sel){ res.specialties.forEach(function(s){ sel.appendChild(el('option',{value:s.key, text:s.label})); }); sel.value='general_physician'; }
    }).catch(function(){});

    try{
      var handoff=sessionStorage.getItem('kivo.role-handoff');
      sessionStorage.removeItem('kivo.role-handoff');
      var raw=handoff||localStorage.getItem(TOKEN_KEY);
      if(raw){ var parsed=JSON.parse(raw); if(parsed.accessToken) saveTokens(parsed); else if(raw) saveTokens(JSON.parse(raw)); }
    }catch(e){}

    var wantsApply=location.hash==='#apply';
    loadTokens();
    setupEasyDoctor();
    startPersistent();

    if(state.tokens&&state.tokens.accessToken){
      boot().then(function(){
        if(!state.doctor){ /* keep auth */ if(wantsApply) setAuthTab('apply'); }
      });
    }else{
      showAuth(); if(wantsApply) setAuthTab('apply');
    }
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
