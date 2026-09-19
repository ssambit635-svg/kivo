/**
 * kivo — Interactive Digital Health Twin Visualizer
 *
 * Provides 3 super-interactive, minimalist rich visualization options:
 *   Option 1: 3D Biometric Mesh (Holographic Particle Orb & Clinical Markers)
 *   Option 2: Hex Radar Topology (Multi-Axis Baseline & Drift Vectors)
 *   Option 3: Neural LOINC Graph (Clinical Signal Pipeline & Constellation)
 */
(function () {
  'use strict';

  const MARKERS = [
    {
      id: 'hba1c',
      name: 'HbA1c',
      fullName: 'Glycated Hemoglobin',
      category: 'Metabolic Panel',
      loinc: '4548-4',
      value: '5.9 %',
      delta: '▲ 0.3% this quarter',
      status: 'Optimal Baseline',
      baseline: '5.4 – 6.0 %',
      confidence: '99.4% Verified',
      radarVal: 0.78,
      coord: [0.08, 0.48, 0.85],
    },
    {
      id: 'tsh',
      name: 'TSH',
      fullName: 'Thyroid Stimulating Hormone',
      category: 'Endocrine Panel',
      loinc: '3016-3',
      value: '2.1 µIU/mL',
      delta: '— stable for 11 mo',
      status: 'In Reference',
      baseline: '0.45 – 4.5 µIU/mL',
      confidence: '99.8% Verified',
      radarVal: 0.72,
      coord: [0.82, -0.18, 0.52],
    },
    {
      id: 'crp',
      name: 'hs-CRP',
      fullName: 'High-Sensitivity C-Reactive Protein',
      category: 'Inflammation Panel',
      loinc: '30522-7',
      value: '0.4 mg/L',
      delta: '▼ low · good',
      status: 'Optimal Baseline',
      baseline: '< 1.0 mg/L',
      confidence: '99.1% Verified',
      radarVal: 0.86,
      coord: [-0.75, 0.42, 0.48],
    },
    {
      id: 'vitd',
      name: 'Vitamin D',
      fullName: '25-Hydroxyvitamin D',
      category: 'Cellular Health',
      loinc: '1989-3',
      value: '32 ng/mL',
      delta: '▲ +2.0 winter baseline',
      status: 'In Target',
      baseline: '30 – 100 ng/mL',
      confidence: '98.7% Verified',
      radarVal: 0.65,
      coord: [0.58, 0.65, -0.45],
    },
    {
      id: 'hgb',
      name: 'Hemoglobin',
      fullName: 'Hemoglobin (Oxygen Transport)',
      category: 'Hematology Panel',
      loinc: '718-7',
      value: '14.2 g/dL',
      delta: '— stable for 8 mo',
      status: 'Optimal Target',
      baseline: '13.5 – 17.5 g/dL',
      confidence: '99.9% Verified',
      radarVal: 0.88,
      coord: [-0.52, -0.62, 0.58],
    },
    {
      id: 'ferritin',
      name: 'Ferritin',
      fullName: 'Ferritin Iron Storage',
      category: 'Iron Profile',
      loinc: '2276-4',
      value: '88 ng/mL',
      delta: '▲ +5.0 normalized',
      status: 'Normal Reserve',
      baseline: '30 – 400 ng/mL',
      confidence: '98.9% Verified',
      radarVal: 0.68,
      coord: [0.38, -0.80, -0.42],
    },
    {
      id: 'egfr',
      name: 'eGFR',
      fullName: 'Estimated Glomerular Filtration',
      category: 'Renal Function',
      loinc: '33914-3',
      value: '98 mL/min',
      delta: '— optimal baseline',
      status: 'High Function',
      baseline: '> 90 mL/min',
      confidence: '99.6% Verified',
      radarVal: 0.92,
      coord: [-0.82, -0.18, -0.52],
    },
  ];

  const RADAR_AXES = [
    { label: 'METABOLIC', markerIndex: 0 },
    { label: 'CARDIO', markerIndex: 2 },
    { label: 'THYROID', markerIndex: 1 },
    { label: 'HEMATIC', markerIndex: 4 },
    { label: 'IMMUNE', markerIndex: 3 },
    { label: 'RENAL', markerIndex: 6 },
  ];

  const NEURAL_NODES = [
    { id: 'camera', label: 'CAMERA INGEST', role: '300 DPI Optical Scan', x: -0.65, y: -0.5, vx: 0, vy: 0, markerIndex: null },
    { id: 'ocr', label: 'OCR NORMALIZER', role: 'Confidence Scored Engine', x: -0.35, y: -0.2, vx: 0, vy: 0, markerIndex: null },
    { id: 'loinc', label: 'LOINC DICT (1,226)', role: 'Verified Clinical Standards', x: -0.1, y: -0.65, vx: 0, vy: 0, markerIndex: 0 },
    { id: 'twin', label: 'TWIN CORE', role: 'Unified Patient Model', x: 0.05, y: 0.05, vx: 0, vy: 0, markerIndex: 0 },
    { id: 'bayes', label: 'BAYESIAN BASELINE', role: 'Adaptive Kalman Filter', x: 0.45, y: -0.35, vx: 0, vy: 0, markerIndex: 1 },
    { id: 'drift', label: 'DRIFT MONITOR', role: 'Context Drift Warning', x: 0.6, y: 0.25, vx: 0, vy: 0, markerIndex: 2 },
    { id: 'audit', label: 'DOCTOR VERIFY', role: 'Human-in-the-Loop Co-Pilot', x: 0.15, y: 0.65, vx: 0, vy: 0, markerIndex: 4 },
    { id: 'sat1', label: 'HbA1c', role: 'LOINC 4548-4 · 5.9%', x: -0.55, y: 0.35, vx: 0, vy: 0, markerIndex: 0 },
    { id: 'sat2', label: 'eGFR', role: 'LOINC 33914-3 · 98mL', x: 0.7, y: -0.1, vx: 0, vy: 0, markerIndex: 6 },
  ];

  const NEURAL_LINKS = [
    ['camera', 'ocr'],
    ['ocr', 'loinc'],
    ['loinc', 'twin'],
    ['ocr', 'twin'],
    ['twin', 'bayes'],
    ['twin', 'drift'],
    ['bayes', 'drift'],
    ['drift', 'audit'],
    ['twin', 'audit'],
    ['camera', 'sat1'],
    ['sat1', 'twin'],
    ['bayes', 'sat2'],
    ['sat2', 'drift'],
  ];

  function init() {
    const canvas = document.getElementById('twinVisualizerCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // HUD Elements
    const hudCard = document.getElementById('twinHudCard');
    const hudLoinc = document.getElementById('twinHudLoinc');
    const hudBadge = document.getElementById('twinHudBadge');
    const hudTitle = document.getElementById('twinHudTitle');
    const hudValue = document.getElementById('twinHudValue');
    const hudDelta = document.getElementById('twinHudDelta');
    const hudRange = document.getElementById('twinHudRange');
    const statusText = document.getElementById('twinStatusText');

    // Controls
    const tabMesh = document.getElementById('tabMesh');
    const tabRadar = document.getElementById('tabRadar');
    const tabNeural = document.getElementById('tabNeural');
    const btnPulse = document.getElementById('twinBtnPulse');
    const btnOrbit = document.getElementById('twinBtnOrbit');
    const btnRecalibrate = document.getElementById('twinBtnRecalibrate');

    // State
    let mode = 'mesh'; // 'mesh' | 'radar' | 'neural'
    let modeAlpha = 1;
    let targetMode = 'mesh';
    let isOrbiting = true;
    let hoveredNode = null;
    let selectedMarker = MARKERS[0];
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let rotX = 0.25;
    let rotY = 0.45;
    let targetRotX = 0.25;
    let targetRotY = 0.45;
    let rotVelX = 0;
    let rotVelY = 0;
    let pulseRadius = 0;
    let pulseActive = false;
    let morphT = 0;
    let morphDirection = 1;
    let radarSweep = 0;
    let mouse = { x: -9999, y: -9999, rawX: -9999, rawY: -9999 };
    let draggedNeuralNode = null;
    let time = 0;

    // Resize handling
    let width = 0;
    let height = 0;
    let dpr = 1;
    let center = { x: 0, y: 0 };
    let radius = 220;

    function resize() {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      center = { x: width / 2, y: height / 2 };
      radius = Math.min(width, height) * 0.38;
    }
    resize();
    window.addEventListener('resize', resize, { passive: true });

    // Floating background particles for 3D sphere
    const bgParticles = [];
    for (let i = 0; i < 50; i++) {
      const u = Math.random();
      const v = Math.random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);
      const r = 0.88 + Math.random() * 0.24;
      bgParticles.push({
        x: r * Math.sin(phi) * Math.cos(theta),
        y: r * Math.sin(phi) * Math.sin(theta),
        z: r * Math.cos(phi),
        size: 1 + Math.random() * 2,
        speed: 0.001 + Math.random() * 0.002,
        phase: Math.random() * Math.PI * 2,
      });
    }

    // 3D rotation projection helper
    function project3D(x, y, z, rx, ry, r) {
      // Rotate Y
      const cosY = Math.cos(ry);
      const sinY = Math.sin(ry);
      const x1 = x * cosY - z * sinY;
      const z1 = z * cosY + x * sinY;

      // Rotate X
      const cosX = Math.cos(rx);
      const sinX = Math.sin(rx);
      const y2 = y * cosX - z1 * sinX;
      const z2 = z1 * cosX + y * sinX;

      // Perspective
      const fov = 3.2;
      const scale = fov / (fov + z2);
      return {
        screenX: center.x + x1 * r * scale,
        screenY: center.y + y2 * r * scale,
        z: z2,
        scale: scale,
        visible: z2 > -fov,
      };
    }

    // Update HUD
    function updateHUD(marker) {
      if (!marker) return;
      selectedMarker = marker;
      if (hudLoinc) hudLoinc.textContent = 'LOINC ' + marker.loinc;
      if (hudBadge) hudBadge.textContent = marker.confidence;
      if (hudTitle) hudTitle.textContent = marker.name + ' · ' + marker.fullName;
      if (hudValue) hudValue.textContent = marker.value;
      if (hudDelta) hudDelta.textContent = marker.status + ' · ' + marker.delta;
      if (hudRange) hudRange.textContent = 'Personal Baseline: ' + marker.baseline + ' · ' + marker.category;
      if (hudCard) hudCard.classList.remove('twin-hudCard--hidden');
    }
    updateHUD(MARKERS[0]);

    // Mode Switcher handler
    function setMode(newMode) {
      if (newMode === mode) return;
      targetMode = newMode;
      mode = newMode;

      // Update tabs
      [tabMesh, tabRadar, tabNeural].forEach((btn) => {
        if (!btn) return;
        const isActive = btn.dataset.mode === newMode;
        btn.classList.toggle('twin-switchBtn--active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });

      // Update status text
      if (statusText) {
        if (newMode === 'mesh') statusText.textContent = 'BIO-TWIN ENGINE // OPTION 01';
        else if (newMode === 'radar') statusText.textContent = 'HEX RADAR TOPOLOGY // OPTION 02';
        else if (newMode === 'neural') statusText.textContent = 'LOINC NEURAL GRAPH // OPTION 03';
      }

      // Trigger pulse scan upon mode switch
      triggerPulse();
    }

    if (tabMesh) tabMesh.addEventListener('click', () => setMode('mesh'));
    if (tabRadar) tabRadar.addEventListener('click', () => setMode('radar'));
    if (tabNeural) tabNeural.addEventListener('click', () => setMode('neural'));

    function triggerPulse() {
      pulseActive = true;
      pulseRadius = 0;
    }

    if (btnPulse) btnPulse.addEventListener('click', triggerPulse);

    if (btnOrbit) {
      btnOrbit.addEventListener('click', () => {
        isOrbiting = !isOrbiting;
        const lbl = btnOrbit.querySelector('span');
        if (lbl) lbl.textContent = 'auto-orbit: ' + (isOrbiting ? 'on' : 'off');
      });
    }

    if (btnRecalibrate) {
      btnRecalibrate.addEventListener('click', () => {
        morphT = 0;
        morphDirection = 1;
        triggerPulse();
      });
    }

    // Pointer events
    function getCanvasCoords(e) {
      const rect = canvas.getBoundingClientRect();
      const clientX = e.touches && e.touches.length > 0 ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches && e.touches.length > 0 ? e.touches[0].clientY : e.clientY;
      return {
        x: clientX - rect.left,
        y: clientY - rect.top,
        rawX: clientX,
        rawY: clientY,
      };
    }

    canvas.addEventListener('mousedown', (e) => {
      const pos = getCanvasCoords(e);
      isDragging = true;
      dragStartX = pos.x;
      dragStartY = pos.y;

      if (mode === 'neural') {
        // Check if clicked a neural node
        draggedNeuralNode = null;
        NEURAL_NODES.forEach((n) => {
          const nx = center.x + n.x * radius * 1.35;
          const ny = center.y + n.y * radius * 1.35;
          const dist = Math.hypot(pos.x - nx, pos.y - ny);
          if (dist < 26) {
            draggedNeuralNode = n;
          }
        });
      }
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
      draggedNeuralNode = null;
    });

    canvas.addEventListener('mousemove', (e) => {
      const pos = getCanvasCoords(e);
      mouse.x = pos.x;
      mouse.y = pos.y;
      mouse.rawX = pos.rawX;
      mouse.rawY = pos.rawY;

      if (isDragging) {
        if (draggedNeuralNode && mode === 'neural') {
          draggedNeuralNode.x = (pos.x - center.x) / (radius * 1.35);
          draggedNeuralNode.y = (pos.y - center.y) / (radius * 1.35);
          draggedNeuralNode.vx = 0;
          draggedNeuralNode.vy = 0;
        } else {
          const dx = pos.x - dragStartX;
          const dy = pos.y - dragStartY;
          dragStartX = pos.x;
          dragStartY = pos.y;
          rotVelY = dx * 0.008;
          rotVelX = -dy * 0.008;
          targetRotY += rotVelY;
          targetRotX += rotVelX;
        }
      }
    });

    canvas.addEventListener('click', (e) => {
      const pos = getCanvasCoords(e);
      triggerPulse();

      // Check hit marker
      if (mode === 'mesh') {
        MARKERS.forEach((m) => {
          const p = project3D(m.coord[0], m.coord[1], m.coord[2], rotX, rotY, radius);
          if (p.visible) {
            const dist = Math.hypot(pos.x - p.screenX, pos.y - p.screenY);
            if (dist < 22) {
              updateHUD(m);
            }
          }
        });
      } else if (mode === 'radar') {
        RADAR_AXES.forEach((axis, i) => {
          const angle = i * (Math.PI / 3) - Math.PI / 2;
          const ax = center.x + Math.cos(angle) * radius * 0.95;
          const ay = center.y + Math.sin(angle) * radius * 0.95;
          if (Math.hypot(pos.x - ax, pos.y - ay) < 32) {
            updateHUD(MARKERS[axis.markerIndex]);
          }
        });
      }
    });

    // Touch support
    canvas.addEventListener(
      'touchstart',
      (e) => {
        const pos = getCanvasCoords(e);
        isDragging = true;
        dragStartX = pos.x;
        dragStartY = pos.y;
        mouse.x = pos.x;
        mouse.y = pos.y;
      },
      { passive: true }
    );

    canvas.addEventListener(
      'touchmove',
      (e) => {
        const pos = getCanvasCoords(e);
        mouse.x = pos.x;
        mouse.y = pos.y;
        if (isDragging) {
          const dx = pos.x - dragStartX;
          const dy = pos.y - dragStartY;
          dragStartX = pos.x;
          dragStartY = pos.y;
          targetRotY += dx * 0.009;
          targetRotX -= dy * 0.009;
        }
      },
      { passive: true }
    );

    canvas.addEventListener('touchend', () => {
      isDragging = false;
    });

    // Render Option 1: 3D Biometric Mesh
    function renderMesh() {
      // Background latitude rings
      const rings = [-0.65, -0.3, 0, 0.3, 0.65];
      ctx.lineWidth = 1;
      rings.forEach((lat) => {
        const ringR = Math.sqrt(Math.max(0, 1 - lat * lat));
        ctx.beginPath();
        const steps = 64;
        let first = true;
        for (let i = 0; i <= steps; i++) {
          const theta = (i / steps) * Math.PI * 2;
          const px = ringR * Math.cos(theta);
          const py = lat;
          const pz = ringR * Math.sin(theta);
          const p = project3D(px, py, pz, rotX, rotY, radius);
          if (p.visible) {
            const alpha = 0.12 + Math.max(0, p.z) * 0.22;
            ctx.strokeStyle = `rgba(18, 18, 18, ${alpha})`;
            if (first) {
              ctx.moveTo(p.screenX, p.screenY);
              first = false;
            } else {
              ctx.lineTo(p.screenX, p.screenY);
            }
          }
        }
        ctx.stroke();
      });

      // Longitude rings
      const longitudes = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4];
      longitudes.forEach((lon) => {
        ctx.beginPath();
        const steps = 64;
        let first = true;
        for (let i = 0; i <= steps; i++) {
          const theta = (i / steps) * Math.PI * 2;
          const px = Math.cos(theta) * Math.cos(lon);
          const py = Math.sin(theta);
          const pz = Math.cos(theta) * Math.sin(lon);
          const p = project3D(px, py, pz, rotX, rotY, radius);
          if (p.visible) {
            const alpha = 0.1 + Math.max(0, p.z) * 0.18;
            ctx.strokeStyle = `rgba(18, 18, 18, ${alpha})`;
            if (first) {
              ctx.moveTo(p.screenX, p.screenY);
              first = false;
            } else {
              ctx.lineTo(p.screenX, p.screenY);
            }
          }
        }
        ctx.stroke();
      });

      // Background particles
      bgParticles.forEach((pt) => {
        const p = project3D(pt.x, pt.y, pt.z, rotX, rotY, radius);
        if (p.visible) {
          const alpha = 0.15 + (p.z + 1) * 0.25;
          ctx.fillStyle = `rgba(18, 18, 18, ${alpha})`;
          ctx.beginPath();
          ctx.arc(p.screenX, p.screenY, pt.size * p.scale, 0, Math.PI * 2);
          ctx.fill();
        }
      });

      // Connections between markers
      ctx.lineWidth = 1;
      for (let i = 0; i < MARKERS.length; i++) {
        for (let j = i + 1; j < MARKERS.length; j++) {
          const m1 = MARKERS[i];
          const m2 = MARKERS[j];
          const p1 = project3D(m1.coord[0], m1.coord[1], m1.coord[2], rotX, rotY, radius);
          const p2 = project3D(m2.coord[0], m2.coord[1], m2.coord[2], rotX, rotY, radius);
          if (p1.visible && p2.visible) {
            const avgZ = (p1.z + p2.z) / 2;
            const alpha = 0.15 + Math.max(0, avgZ) * 0.35;
            ctx.strokeStyle = `rgba(18, 18, 18, ${alpha})`;
            ctx.beginPath();
            ctx.moveTo(p1.screenX, p1.screenY);
            ctx.lineTo(p2.screenX, p2.screenY);
            ctx.stroke();

            // Photon pulse along arc
            const packetT = (time * 0.6 + i * 0.3 + j * 0.2) % 1;
            const px = p1.screenX + (p2.screenX - p1.screenX) * packetT;
            const py = p1.screenY + (p2.screenY - p1.screenY) * packetT;
            ctx.fillStyle = `rgba(18, 18, 18, ${alpha * 1.5})`;
            ctx.beginPath();
            ctx.arc(px, py, 1.8 * p1.scale, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // Marker Nodes
      hoveredNode = null;
      MARKERS.forEach((m) => {
        const p = project3D(m.coord[0], m.coord[1], m.coord[2], rotX, rotY, radius);
        if (!p.visible) return;

        const dist = Math.hypot(mouse.x - p.screenX, mouse.y - p.screenY);
        const isHovered = dist < 22;
        const isSelected = selectedMarker && selectedMarker.id === m.id;

        if (isHovered) {
          hoveredNode = m;
          updateHUD(m);
        }

        const baseR = (isHovered ? 8 : 5.5) * p.scale;
        const alpha = 0.35 + (p.z + 1) * 0.35;

        // Outer halo / reticle
        if (isHovered || isSelected) {
          ctx.strokeStyle = '#121212';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(p.screenX, p.screenY, baseR + 6, 0, Math.PI * 2);
          ctx.stroke();

          // Reticle corners
          const rSize = baseR + 10;
          ctx.beginPath();
          ctx.moveTo(p.screenX - rSize, p.screenY - 4);
          ctx.lineTo(p.screenX - rSize, p.screenY - rSize);
          ctx.lineTo(p.screenX - 4, p.screenY - rSize);

          ctx.moveTo(p.screenX + rSize, p.screenY - 4);
          ctx.lineTo(p.screenX + rSize, p.screenY - rSize);
          ctx.lineTo(p.screenX + 4, p.screenY - rSize);

          ctx.moveTo(p.screenX - rSize, p.screenY + 4);
          ctx.lineTo(p.screenX - rSize, p.screenY + rSize);
          ctx.lineTo(p.screenX - 4, p.screenY + rSize);

          ctx.moveTo(p.screenX + rSize, p.screenY + 4);
          ctx.lineTo(p.screenX + rSize, p.screenY + rSize);
          ctx.lineTo(p.screenX + 4, p.screenY + rSize);
          ctx.stroke();
        }

        // Node circle
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = `rgba(18, 18, 18, ${alpha})`;
        ctx.lineWidth = isHovered || isSelected ? 2 : 1.5;
        ctx.beginPath();
        ctx.arc(p.screenX, p.screenY, baseR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Inner dot
        ctx.fillStyle = isHovered || isSelected ? '#121212' : `rgba(18, 18, 18, ${alpha})`;
        ctx.beginPath();
        ctx.arc(p.screenX, p.screenY, baseR * 0.45, 0, Math.PI * 2);
        ctx.fill();

        // Label
        if (p.z > -0.2 || isHovered || isSelected) {
          ctx.font = `${Math.round(11 * p.scale)}px Inter, sans-serif`;
          ctx.fillStyle = isHovered || isSelected ? '#121212' : `rgba(18, 18, 18, 0.7)`;
          ctx.textAlign = 'center';
          ctx.fillText(m.name, p.screenX, p.screenY + baseR + 14 * p.scale);
        }
      });
    }

    // Render Option 2: Hex Radar Topology
    function renderRadar() {
      radarSweep = (radarSweep + 0.02) % (Math.PI * 2);

      // Radar Concentric Hexagons
      const levels = [0.25, 0.5, 0.75, 1.0];
      levels.forEach((lvl, idx) => {
        ctx.strokeStyle = idx === 3 ? 'rgba(18, 18, 18, 0.35)' : 'rgba(18, 18, 18, 0.12)';
        ctx.lineWidth = idx === 3 ? 1.5 : 1;
        ctx.setLineDash(idx === 1 ? [4, 4] : []);
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const angle = i * (Math.PI / 3) - Math.PI / 2;
          const x = center.x + Math.cos(angle) * radius * lvl;
          const y = center.y + Math.sin(angle) * radius * lvl;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
      });
      ctx.setLineDash([]);

      // Axis lines & Labels
      RADAR_AXES.forEach((axis, i) => {
        const angle = i * (Math.PI / 3) - Math.PI / 2;
        const endX = center.x + Math.cos(angle) * radius;
        const endY = center.y + Math.sin(angle) * radius;

        ctx.strokeStyle = 'rgba(18, 18, 18, 0.18)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(center.x, center.y);
        ctx.lineTo(endX, endY);
        ctx.stroke();

        // Label
        const labelX = center.x + Math.cos(angle) * (radius + 26);
        const labelY = center.y + Math.sin(angle) * (radius + 26);
        ctx.font = '500 11px Inter, sans-serif';
        ctx.fillStyle = '#121212';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(axis.label, labelX, labelY);

        // Marker code sub-label
        const marker = MARKERS[axis.markerIndex];
        ctx.font = '10px monospace';
        ctx.fillStyle = 'rgba(18, 18, 18, 0.5)';
        ctx.fillText(marker.value, labelX, labelY + 13);
      });

      // Rotating Radar Beam
      ctx.save();
      ctx.translate(center.x, center.y);
      const sweepGrad = ctx.createConicGradient(radarSweep, 0, 0);
      sweepGrad.addColorStop(0, 'rgba(18, 18, 18, 0.15)');
      sweepGrad.addColorStop(0.12, 'rgba(18, 18, 18, 0)');
      sweepGrad.addColorStop(1, 'rgba(18, 18, 18, 0)');
      ctx.fillStyle = sweepGrad;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Population Reference Polygon (Neutral silver)
      ctx.strokeStyle = 'rgba(18, 18, 18, 0.28)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = i * (Math.PI / 3) - Math.PI / 2;
        const refVal = 0.7;
        const x = center.x + Math.cos(angle) * radius * refVal;
        const y = center.y + Math.sin(angle) * radius * refVal;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      // Patient Twin Polygon (Verified values)
      ctx.fillStyle = 'rgba(18, 18, 18, 0.08)';
      ctx.strokeStyle = '#121212';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const morphFactor = Math.sin(time * 2) * 0.03;
      RADAR_AXES.forEach((axis, i) => {
        const angle = i * (Math.PI / 3) - Math.PI / 2;
        const marker = MARKERS[axis.markerIndex];
        const val = Math.min(1.0, Math.max(0.2, marker.radarVal + morphFactor));
        const x = center.x + Math.cos(angle) * radius * val;
        const y = center.y + Math.sin(angle) * radius * val;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Vertices & Interaction
      RADAR_AXES.forEach((axis, i) => {
        const angle = i * (Math.PI / 3) - Math.PI / 2;
        const marker = MARKERS[axis.markerIndex];
        const val = Math.min(1.0, Math.max(0.2, marker.radarVal + morphFactor));
        const vx = center.x + Math.cos(angle) * radius * val;
        const vy = center.y + Math.sin(angle) * radius * val;

        const dist = Math.hypot(mouse.x - vx, mouse.y - vy);
        const isHovered = dist < 22;

        if (isHovered) {
          updateHUD(marker);
          ctx.strokeStyle = '#121212';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(vx, vy, 12, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#121212';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(vx, vy, isHovered ? 6 : 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
    }

    // Render Option 3: Neural LOINC Graph
    function renderNeural() {
      // Spring force physics update
      NEURAL_NODES.forEach((node) => {
        if (node === draggedNeuralNode) return;
        // Restoring force to home (x, y)
        const targetX = node.id === 'twin' ? 0 : node.x;
        const targetY = node.id === 'twin' ? 0 : node.y;
        node.vx += (targetX - node.x) * 0.04;
        node.vy += (targetY - node.y) * 0.04;
        node.vx *= 0.88;
        node.vy *= 0.88;
        node.x += node.vx;
        node.y += node.vy;
      });

      // Draw Links
      NEURAL_LINKS.forEach(([id1, id2], linkIdx) => {
        const n1 = NEURAL_NODES.find((n) => n.id === id1);
        const n2 = NEURAL_NODES.find((n) => n.id === id2);
        if (!n1 || !n2) return;

        const x1 = center.x + n1.x * radius * 1.35;
        const y1 = center.y + n1.y * radius * 1.35;
        const x2 = center.x + n2.x * radius * 1.35;
        const y2 = center.y + n2.y * radius * 1.35;

        ctx.strokeStyle = 'rgba(18, 18, 18, 0.2)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        // Animated Signal Packet
        const packetT = (time * 0.8 + linkIdx * 0.22) % 1;
        const px = x1 + (x2 - x1) * packetT;
        const py = y1 + (y2 - y1) * packetT;
        ctx.fillStyle = '#121212';
        ctx.beginPath();
        ctx.arc(px, py, 2.2, 0, Math.PI * 2);
        ctx.fill();
      });

      // Draw Nodes
      NEURAL_NODES.forEach((node) => {
        const nx = center.x + node.x * radius * 1.35;
        const ny = center.y + node.y * radius * 1.35;
        const dist = Math.hypot(mouse.x - nx, mouse.y - ny);
        const isHovered = dist < 24;
        const isCore = node.id === 'twin';
        const nodeR = isCore ? 14 : isHovered ? 9 : 7;

        if (isHovered && node.markerIndex !== null) {
          updateHUD(MARKERS[node.markerIndex]);
        }

        // Outer halo
        if (isHovered || isCore) {
          ctx.strokeStyle = 'rgba(18, 18, 18, 0.25)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(nx, ny, nodeR + 6, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#121212';
        ctx.lineWidth = isCore ? 2.5 : 1.8;
        ctx.beginPath();
        ctx.arc(nx, ny, nodeR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#121212';
        ctx.beginPath();
        ctx.arc(nx, ny, isCore ? 5 : 2.5, 0, Math.PI * 2);
        ctx.fill();

        // Label
        ctx.font = isCore ? '600 12px Inter, sans-serif' : '500 10px Inter, sans-serif';
        ctx.fillStyle = '#121212';
        ctx.textAlign = 'center';
        ctx.fillText(node.label, nx, ny + nodeR + 13);
      });
    }

    // Render Shockwave Scan Pulse
    function renderPulse() {
      if (!pulseActive) return;
      pulseRadius += 6;
      const maxR = radius * 1.6;
      const alpha = Math.max(0, 1 - pulseRadius / maxR) * 0.45;

      ctx.strokeStyle = `rgba(18, 18, 18, ${alpha})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(center.x, center.y, pulseRadius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = `rgba(18, 18, 18, ${alpha * 0.5})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(center.x, center.y, Math.max(0, pulseRadius - 20), 0, Math.PI * 2);
      ctx.stroke();

      if (pulseRadius > maxR) {
        pulseActive = false;
      }
    }

    // Main animation loop
    function animate() {
      requestAnimationFrame(animate);
      time += 0.016;

      // Auto orbit inertia
      if (isOrbiting && !isDragging) {
        targetRotY += 0.0035;
      }
      rotX += (targetRotX - rotX) * 0.08;
      rotY += (targetRotY - rotY) * 0.08;

      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(dpr, dpr);

      // Render Active Mode
      if (mode === 'mesh') {
        renderMesh();
      } else if (mode === 'radar') {
        renderRadar();
      } else if (mode === 'neural') {
        renderNeural();
      }

      // Render pulse waves
      renderPulse();

      ctx.restore();
    }

    animate();
  }

  // Self-init when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
