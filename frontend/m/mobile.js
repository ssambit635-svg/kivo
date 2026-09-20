/**
 * kivo mobile app logic — stitch ai design system implementation
 */
(function() {
  'use strict';

  // State
  var state = {
    user: { email: 'demo@kivo.dev', name: 'Demo User' },
    member: { id: 'mem-demo', name: 'Demo Profile' },
    tokens: null,
    score: 88,
    activeTab: 'home',
    reports: [
      { id: 'rep-1', name: 'Complete Blood Count (CBC)', date: 'Sep 18, 2026', badge: 'verified', markers: 14 },
      { id: 'rep-2', name: 'Comprehensive Metabolic Panel', date: 'Aug 24, 2026', badge: 'verified', markers: 18 },
      { id: 'rep-3', name: 'Lipid & Thyroid Profile', date: 'Jul 15, 2026', badge: 'verified', markers: 9 }
    ],
    markers: [
      { name: 'HbA1c', loinc: '4548-4', value: '5.4 %', status: 'normal', range: '4.0 - 5.6' },
      { name: 'Fasting Blood Glucose', loinc: '1558-6', value: '92 mg/dL', status: 'normal', range: '70 - 99' },
      { name: 'Total Cholesterol', loinc: '2093-3', value: '184 mg/dL', status: 'normal', range: '< 200' },
      { name: 'LDL Cholesterol', loinc: '13457-7', value: '112 mg/dL', status: 'borderline', range: '< 100' },
      { name: 'HDL Cholesterol', loinc: '2085-9', value: '58 mg/dL', status: 'normal', range: '> 40' },
      { name: 'TSH (Thyroid)', loinc: '3016-3', value: '2.1 mIU/L', status: 'normal', range: '0.4 - 4.0' },
      { name: 'Hemoglobin', loinc: '718-7', value: '14.8 g/dL', status: 'normal', range: '13.5 - 17.5' }
    ]
  };

  function $(id) { return document.getElementById(id); }

  function showToast(msg) {
    var t = $('kivo-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('visible');
    setTimeout(function() {
      t.classList.remove('visible');
    }, 3000);
  }
  function loadTokens(){ try{ var raw=localStorage.getItem('mt.tokens'); if(raw) state.tokens=JSON.parse(raw);}catch(e){} }
  function api(path, opts){
    opts=opts||{};
    var headers={'Content-Type':'application/json'};
    if(state.tokens && state.tokens.accessToken) headers.Authorization='Bearer '+state.tokens.accessToken;
    return fetch('/api'+path,{method:opts.method||'GET', headers:headers, body: opts.body? JSON.stringify(opts.body): undefined})
      .then(function(res){ return res.json().then(function(body){ if(!res.ok) throw new Error((body && body.error && body.error.message)||'Request failed'); return body; }); });
  }
  function withLoading(btn, fn){
    if(!btn || btn.disabled) return;
    btn.disabled=true; var p=fn(); var done=function(){ btn.disabled=false; }; if(p && p.then) p.then(done,done); else done();
  }

  // Tab switching
  function switchTab(tabId) {
    state.activeTab = tabId;
    var screens = document.querySelectorAll('.screen');
    screens.forEach(function(s) { s.classList.remove('active'); });

    var targetScreen = $('screen-' + tabId);
    if (targetScreen) targetScreen.classList.add('active');

    var navTabs = document.querySelectorAll('.nav-tab');
    navTabs.forEach(function(btn) {
      if (btn.getAttribute('data-tab') === tabId) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Scroll to top
    var content = $('app-content');
    if (content) content.scrollTop = 0;
  }

  // Render markers
  function renderMarkers() {
    var container = $('markers-container');
    if (!container) return;
    container.innerHTML = '';

    state.markers.forEach(function(m) {
      var card = document.createElement('div');
      card.className = 'marker-card-item';
      
      var badgeClass = 'badge-normal';
      if (m.status === 'borderline') badgeClass = 'badge-borderline';
      if (m.status === 'high') badgeClass = 'badge-high';

      card.innerHTML = 
        '<div class="marker-meta">' +
          '<strong>' + m.name + '</strong>' +
          '<span>LOINC ' + m.loinc + ' · Range: ' + m.range + '</span>' +
        '</div>' +
        '<div class="marker-val">' +
          '<div class="val-text">' + m.value + '</div>' +
          '<span class="badge ' + badgeClass + '">' + m.status + '</span>' +
        '</div>';
      container.appendChild(card);
    });
  }

  // Render reports
  function renderReports() {
    var container = $('reports-list-container');
    if (!container) return;
    container.innerHTML = '';

    state.reports.forEach(function(r) {
      var item = document.createElement('div');
      item.className = 'report-item';
      item.innerHTML = 
        '<div class="report-item-top">' +
          '<span class="report-name">' + r.name + '</span>' +
          '<span class="report-date">' + r.date + '</span>' +
        '</div>' +
        '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">' +
          '<span style="font-size:12px; color:var(--kivo-ink-muted);">' + r.markers + ' markers extracted</span>' +
          '<span class="report-badge badge-verified">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>' +
            'Verified' +
          '</span>' +
        '</div>';
      container.appendChild(item);
    });
  }

  // Wire events
  function init() {
    loadTokens();
    if(state.tokens && state.tokens.accessToken){ api('/members').then(function(body){ var owned=body.owned||[]; var all=owned.concat(body.shared||[]); if(all.length){ state.member = owned.find(function(m){return m.relationship==='self';}) || all[0]; } }).catch(function(){}); }
    // Navigation tabs
    var navTabs = document.querySelectorAll('.nav-tab');
    navTabs.forEach(function(tab) {
      tab.addEventListener('click', function() {
        var tabId = tab.getAttribute('data-tab');
        if (tabId) switchTab(tabId);
      });
    });

    // In-page jump links ("All Reports →", "Back"). These are wired here — and
    // never with an inline onclick attribute — because the server sends
    // `Content-Security-Policy: script-src-attr 'none'`, which makes the
    // browser drop inline handlers silently. data-goto-tab names the screen.
    document.querySelectorAll('[data-goto-tab]').forEach(function(link) {
      link.addEventListener('click', function() {
        var tabId = link.getAttribute('data-goto-tab');
        if (tabId) switchTab(tabId);
      });
    });

    // FAB Scan button
    var fabScan = $('fab-scan');
    if (fabScan) {
      fabScan.addEventListener('click', function() {
        switchTab('scan');
      });
    }

    // Quick Action Scan
    var quickScan = $('quick-scan');
    if (quickScan) {
      quickScan.addEventListener('click', function() {
        switchTab('scan');
      });
    }

    // Quick Action Voice
    var quickVoice = $('quick-voice');
    if (quickVoice) {
      quickVoice.addEventListener('click', function() {
        switchTab('voice');
      });
    }

    // Quick Action Ask
    var quickAsk = $('quick-ask');
    if (quickAsk) {
      quickAsk.addEventListener('click', function() {
        switchTab('ask');
      });
    }

    // Camera Scan Trigger
    var btnStartCamera = $('btn-start-camera');
    var cameraPreview = $('camera-preview');
    if (btnStartCamera && cameraPreview) {
      btnStartCamera.addEventListener('click', function() {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
            .then(function(stream) {
              cameraPreview.srcObject = stream;
              cameraPreview.style.display = 'block';
              showToast('Camera active. Fit report in box.');
            })
            .catch(function(e) {
              showToast('Camera access denied or unavailable in sandbox');
            });
        } else {
          showToast('Camera not supported in this browser');
        }
      });
    }

    // Voice Recording Trigger
    var btnVoiceRecord = $('btn-voice-record');
    var voiceStatus = $('voice-status');
    if (btnVoiceRecord && voiceStatus) {
      btnVoiceRecord.addEventListener('click', function() {
        var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SpeechRec) {
          var rec = new SpeechRec();
          rec.lang = 'en-US';
          rec.start();
          btnVoiceRecord.style.background = '#f43f5e';
          voiceStatus.textContent = 'Listening... Say your health update.';
          rec.onresult = function(ev) {
            var speechText = ev.results[0][0].transcript;
            voiceStatus.textContent = 'Noted: "' + speechText + '"';
            showToast('Voice entry recorded to health record');
            btnVoiceRecord.style.background = '';
          };
          rec.onerror = function() {
            voiceStatus.textContent = 'Microphone error or stopped.';
            btnVoiceRecord.style.background = '';
          };
        } else {
          showToast('Speech recognition not available on this browser');
        }
      });
    }

    // Chat / Assistant Ask Twin
    var chatSend = $('chat-send');
    var chatInput = $('chat-input');
    var chatBox = $('chat-messages');
    if (chatSend && chatInput && chatBox) {
      function sendChat() {
        var text = chatInput.value.trim();
        if (!text) return;
        
        // Add user msg
        var userMsg = document.createElement('div');
        userMsg.className = 'chat-msg user';
        userMsg.textContent = text;
        chatBox.appendChild(userMsg);
        chatInput.value = '';

        var memberId = state.member && state.member.id && state.member.id!=='mem-demo' ? state.member.id : null;
        if(!memberId){
          setTimeout(function(){
            var botMsg=document.createElement('div'); botMsg.className='chat-msg bot';
            botMsg.innerHTML='<strong>kivo:</strong> Please sign in on the main app for grounded answers. Demo insight: HbA1c 5.4% optimal, LDL 112 slightly above target.';
            chatBox.appendChild(botMsg); chatBox.scrollTop=chatBox.scrollHeight;
          },400);
          return;
        }
        api('/members/'+memberId+'/ask',{method:'POST', body:{question:text}}).then(function(res){
          var botMsg=document.createElement('div'); botMsg.className='chat-msg bot';
          botMsg.innerHTML='<strong>kivo:</strong> '+(res.answer||res.text||JSON.stringify(res).slice(0,300));
          if(res.disclaimer) botMsg.innerHTML+='<div style="font-size:11px; color:#6b8291; margin-top:6px;">'+res.disclaimer+'</div>';
          chatBox.appendChild(botMsg); chatBox.scrollTop=chatBox.scrollHeight;
        }).catch(function(err){
          var botMsg=document.createElement('div'); botMsg.className='chat-msg bot';
          botMsg.innerHTML='<strong>kivo:</strong> '+(err.message||'Could not answer — try again.');
          chatBox.appendChild(botMsg); chatBox.scrollTop=chatBox.scrollHeight;
        });
      }

      chatSend.addEventListener('click', sendChat);
      chatInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') sendChat();
      });
    }

    // APK Download Toast feedback
    var apkBtns = document.querySelectorAll('.apk-download-trigger');
    apkBtns.forEach(function(btn) {
      btn.addEventListener('click', function() {
withLoading(btn, function(){ showToast('Downloading kivo.apk…'); return Promise.resolve(); });
      });
    });

    renderMarkers();
    renderReports();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
