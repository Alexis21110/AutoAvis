// ==UserScript==
// @name         Amazon Vine: Auto-avis (liste + page avis) v8.1.1
// @namespace    https://vine-local/
// @version      8.1.1
// @description  Liste: bouton "⚡ Auto-avis" ; Page avis: "Générer via ChatGPT" + étoiles 3–5 cohérentes (sans note chiffrée). Ouvre ChatGPT avec handle TM, ferme ChatGPT depuis Amazon et refocus. Titre uniquement dans #reviewTitle. Debug masqué par défaut.
// @updateURL    https://raw.githubusercontent.com/Alexis21110/AutoAvis/refs/heads/main/AutoAvis.user.js
// @downloadURL  https://raw.githubusercontent.com/Alexis21110/AutoAvis/refs/heads/main/AutoAvis.user.js
// @match        https://www.amazon.fr/vine/*
// @match        https://www.amazon.fr/review/create-review*
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @grant        GM_addValueChangeListener
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ===== CONFIG =====
  const DEBUG = false;               // <- passe à true si tu veux revoir les panneaux debug
  const STAR_MIN = 3, STAR_MAX = 5;  // étoiles aléatoires 3..5
  // ===================

  const pickStars = () => Math.floor(Math.random() * (STAR_MAX - STAR_MIN + 1)) + STAR_MIN;
  const isVineList = location.pathname.startsWith('/vine/vine-reviews');
  const isCreate   = location.pathname.startsWith('/review/create-review');
  const isChatGPT  = location.host.includes('chatgpt.com') || location.host.includes('chat.openai.com');

  const wait = (ms)=>new Promise(r=>setTimeout(r,ms));
  const visible = el => {
    if (!el) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const onlyText = s => (s||'').replace(/\s+/g,' ').trim();

  // ---------- mini log (no-op si DEBUG=false) ----------
  function logBox(title, id='vine-log') {
    if (!DEBUG) return () => {};
    let box = document.getElementById(id);
    if (!box) {
      box = document.createElement('div');
      box.id = id;
      box.style.cssText = 'position:fixed;top:10px;right:10px;z-index:999999;background:rgba(0,0,0,.7);color:#fff;padding:8px 10px;border-radius:10px;font:12px system-ui;max-width:420px;box-shadow:0 8px 24px rgba(0,0,0,.25)';
      box.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${title}</div><div id="${id}-in" style="max-height:220px;overflow:auto;white-space:pre-line"></div>`;
      document.documentElement.appendChild(box);
    }
    const el = box.querySelector(`#${id}-in`);
    return (m)=>{ const t=new Date().toLocaleTimeString(); el.textContent+=`• [${t}] ${m}\n`; el.scrollTop=el.scrollHeight; };
  }
  const copy = async (txt)=>{
    try{ if(typeof GM_setClipboard === 'function'){ GM_setClipboard(txt, 'text'); return true; } }catch{}
    try{ await navigator.clipboard.writeText(txt); return true; }catch{}
    return false;
  };

  // ---------- parse JSON robuste ----------
  function parseJSONLoose(text){
    try{ return JSON.parse(text); }catch{}
    const cleaned = text.replace(/^[^{]*({[\s\S]*})[^}]*$/,'$1').trim();
    try{ return JSON.parse(cleaned); }catch{}
    const m = text.match(/{[^{}]*(?:(?:{[^{}]*})|[^{}])*}/);
    if (m){ try{ return JSON.parse(m[0]); }catch{} }
    return null;
  }
  function parseJSONStrict(raw){
    const obj = parseJSONLoose(raw);
    if (!obj || !obj.title || !obj.body) return null;
    const t = String(obj.title).trim();
    const b = String(obj.body).trim();
    if (t==='...' || b==='...' || t.length<6 || b.length<30) return null;
    return { title: t.slice(0,150), body: b };
  }

  // ---------- helpers champs Amazon ----------
  function setNativeValue(el, value){
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto,'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
  }
  function reactCommit(el, value){
    try{
      setNativeValue(el, value);
      const vt = el._valueTracker || el.__valueTracker;
      if (vt && typeof vt.setValue === 'function') vt.setValue(String(value));
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
    }catch{}
  }
  async function typeLike(el, text){
    el.focus();
    setNativeValue(el,''); el.dispatchEvent(new Event('input',{bubbles:true}));
    const chunks = text.match(/.{1,28}/g) || [''];
    for (const ch of chunks){
      setNativeValue(el, (el.value||'')+ch);
      el.dispatchEvent(new InputEvent('input',{bubbles:true,data:ch}));
      await wait(35+Math.random()*55);
    }
    reactCommit(el, text);
  }

  // Sélection stricte du champ titre (jamais la barre de recherche)
  function titleElStrict(){
    const sels = [
      '#reviewTitle[name="reviewTitle"]',
      '[data-testid="in-context-ryp-form"] #reviewTitle',
      'form#in-context-ryp-form input#reviewTitle',
      'input.in-context-ryp__form-field--reviewTitle#reviewTitle',
      'input[name="reviewTitle"].in-context-ryp__form-field--reviewTitle'
    ];
    for (const s of sels){
      const el = document.querySelector(s);
      if (el && visible(el)) return el;
    }
    const alt = [...document.querySelectorAll('input[name="reviewTitle"]')]
      .filter(e => e.id !== 'twotabsearchtextbox' && visible(e));
    return alt[0] || null;
  }

  function bodyElStrict(){
    const sels = [
      '#reviewText',
      'textarea[name="reviewText"]',
      '[data-testid="review-text-textarea"] textarea'
    ];
    for (const s of sels){
      const el = document.querySelector(s);
      if (el && visible(el)) return el;
    }
    const alt = [...document.querySelectorAll('textarea')].find(visible);
    return alt || null;
  }

  async function clickStars(n){
    for(let i=0;i<20;i++){
      const stars = Array.from(document.querySelectorAll('[data-testid="in-context-ryp__form-field--starRating-single"]'));
      if (stars.length>=n){ stars[n-1].click(); return true; }
      await wait(200);
    }
    return false;
  }

  // =========================
  // LISTE /vine/vine-reviews
  // =========================
  if (isVineList){
    const log = logBox('Vine Helper (Liste)');

    function buildPrompt(productTitle, stars){
      const tone = stars>=5
        ? "ton enthousiaste, plusieurs points forts ; limites mineures si besoin"
        : stars===4
          ? "ton positif mais nuancé : 2–3 atouts clairs, 1–2 améliorations possibles"
          : "ton mitigé mais factuel : autant de qualités que de limites, utile et honnête";
      return `
Tu es un testeur Amazon Vine. Rédige un avis honnête en français pour: "${productTitle}".

Consignes:
- Réponds UNIQUEMENT par un objet JSON valide avec exactement deux clés:
  "title": string (≤110 caractères), percutant et informatif.
  "body" : string (5–7 phrases; usage réel, 2–3 points forts, 1–2 limites/points à savoir, conclusion claire).
- Important: adapte le ton au niveau de satisfaction (${stars}★) → ${tone}.
- Interdiction: ne mentionne aucune note chiffrée ("x/5", "cinq étoiles", etc.) dans le texte.

{"title":"...", "body":"..."}
`.trim();
    }

    function findReviewLink(scope){
      const links = [...scope.querySelectorAll('a[href]')];
      return links.find(a =>
        /\/review\/create-review/i.test(a.href || '') ||
        /create-review/i.test(a.getAttribute('href') || '') ||
        a.name === 'vvp-reviews-table--review-item-btn' ||
        /rediger|ecrire|review|avis/i.test((a.textContent || '').normalize('NFD').replace(/[\u0300-\u036f]/g,''))
      ) || null;
    }

    function productTitleFromRow(row){
      const sels = [
        '.a-truncate-full.a-offscreen',
        '.a-truncate-cut',
        '[data-testid*="product-title"]',
        '[class*="product-title"]',
        'h1','h2','h3',
        'img[alt]'
      ];
      for (const s of sels){
        const el = row.querySelector(s);
        const txt = s === 'img[alt]' ? el?.getAttribute('alt') : el?.textContent;
        if (txt && txt.trim()) return txt.trim();
      }
      return 'Produit';
    }

    function addBtn(row){
      if (!row || row.querySelector('.vine-auto-avis-btn')) return;
      const act = findReviewLink(row);
      if(!act) return;

      const btn = document.createElement('span');
      btn.className = 'a-button a-button-base vine-auto-avis-btn';
      btn.style.cssText = 'margin-left:6px;vertical-align:middle';
      btn.innerHTML = `<span class="a-button-inner"><a href="javascript:void(0)" class="a-button-text">⚡ Auto-avis</a></span>`;
      const host = act.closest('.a-button')?.parentElement || act.parentElement || row;
      host.appendChild(btn);

      btn.addEventListener('click', ()=>{
        const productTitle = productTitleFromRow(row);

        const href = act.getAttribute('href') || '';
        let asin = (href.match(/asin=([A-Z0-9]{10})/)||[])[1];
        if(!asin){
          const pdp = row.querySelector('#vvp-reviews-product-detail-page-link')?.getAttribute('href') || '';
          asin = (pdp.match(/\/dp\/([A-Z0-9]{10})/)||[])[1] || '';
        }

        const stars = pickStars();
        GM_setValue('vine_stars', String(stars));
        GM_setValue('vine_prompt', buildPrompt(productTitle, stars));
        GM_setValue('vine_result',''); GM_setValue('vine_raw','');
        GM_setValue('vine_from_list','1');
        GM_setValue('vine_context', JSON.stringify({ productTitle, asin }));

        const url = href || `https://www.amazon.fr/review/create-review?encoding=UTF&asin=${asin}`;
        GM_openInTab(url, {active:true,insert:true});
        log(`⏩ create-review pour « ${productTitle.slice(0,80)}… » (${stars}★)`);
      });
    }

    function scan(){
      const strictRows = [...document.querySelectorAll('table.vvp-reviews-table tr.vvp-reviews-table--row')];
      const linkRows = [...document.querySelectorAll('a[href*="/review/create-review"], a[href*="create-review"], a[name="vvp-reviews-table--review-item-btn"]')]
        .map(a => a.closest('tr, li, [data-asin], [data-testid*="item"], .a-section, .vvp-reviews-table--row') || a.parentElement)
        .filter(Boolean);
      const rows = [...new Set([...strictRows, ...linkRows])];
      rows.forEach(addBtn);
      log(`scan: ${rows.length} lignes/carte(s), ${document.querySelectorAll('.vine-auto-avis-btn').length} bouton(s)`);
      return rows.length;
    }

    scan();
    setTimeout(scan, 1000);
    setTimeout(scan, 3000);
    const table = document.querySelector('table.vvp-reviews-table') || document.body;
    new MutationObserver(()=>scan()).observe(table, {childList:true,subtree:true});
    return;
  }

  // =========================
  // PAGE AVIS /review/create-review
  // =========================
  if (isCreate){
    const log = logBox('Vine Helper (Avis)');

    function productNameFromCreate(){
      const sel = [
        '[data-testid="in-context-ryp__product-header"] .in-context-ryp__product-title',
        '#productTitle', 'h1', 'h2'
      ];
      for (const s of sel){
        const el = document.querySelector(s);
        if (el && el.textContent.trim()){
          return el.textContent.replace(/Comment était l'article\s*\?/i,'').trim();
        }
      }
      const asin = new URL(location.href).searchParams.get('asin');
      return asin ? `Produit ${asin}` : 'Produit';
    }

    async function clickStarsSafe(){
      const saved = parseInt(GM_getValue('vine_stars','0')||'0',10);
      const n = (saved>=3 && saved<=5) ? saved : pickStars();
      GM_setValue('vine_stars', String(n));
      await clickStars(n);
      return n;
    }

    // Ouverture ChatGPT avec handle pour pouvoir le fermer depuis Amazon
    function openChat(){
      try{ if(window.__vineChatTab && !window.__vineChatTab.closed) window.__vineChatTab.close(); }catch{}
      GM_setValue('vine_chat_active', String(Date.now()));
      window.__vineChatTab = GM_openInTab('https://chatgpt.com/?vine=1', {active:true,insert:true,setParent:true});
      try{ if(window.__vineChatTab) window.__vineChatTab.onclose = ()=> window.focus(); }catch{}
    }

    // UI flottante
    (function addFloatingUI(){
      if (document.getElementById('vine-tools')) return;
      const box = document.createElement('div');
      box.id='vine-tools';
      box.style.cssText='position:fixed;right:18px;bottom:18px;z-index:999999;display:flex;flex-direction:column;gap:8px';
      box.innerHTML = `
        <button id="vt-gen" class="a-button a-button-primary" style="background:#ffd814;border-color:#fcd200;border-radius:10px;padding:8px 12px;cursor:pointer">
          ⚡ Générer via ChatGPT (auto)
        </button>
        <button id="vt-stars" class="a-button" style="background:#fff;border:1px solid #d5d9d9;border-radius:10px;padding:8px 12px;cursor:pointer">
          ⭐ Sélection aléatoire (3–5)
        </button>
      `;
      document.documentElement.appendChild(box);
      box.querySelector('#vt-stars').onclick=()=>clickStarsSafe();
      box.querySelector('#vt-gen').onclick=async ()=>{
        const n = await clickStarsSafe();
        const productTitle = productNameFromCreate();
        const asin = new URL(location.href).searchParams.get('asin')||'';
        const tone = n>=5
          ? "ton enthousiaste, plusieurs points forts ; limites mineures si besoin"
          : n===4
            ? "ton positif mais nuancé : 2–3 atouts clairs, 1–2 améliorations possibles"
            : "ton mitigé mais factuel : autant de qualités que de limites, utile et honnête";
        const prompt = `
Tu es un testeur Amazon Vine. Rédige un avis honnête en français pour: "${productTitle}".

Consignes:
- Réponds UNIQUEMENT par un objet JSON valide avec exactement deux clés:
  "title": string (≤110 caractères), percutant et informatif.
  "body" : string (5–7 phrases; usage réel, 2–3 points forts, 1–2 limites/points à savoir, conclusion claire).
- Important: adapte le ton au niveau de satisfaction (${n}★) → ${tone}.
- Interdiction: ne mentionne aucune note chiffrée ("x/5", "cinq étoiles", etc.) dans le texte.

{"title":"...", "body":"..."}
`.trim();
        GM_setValue('vine_prompt', prompt);
        GM_setValue('vine_result',''); GM_setValue('vine_raw','');
        GM_setValue('vine_from_list','1');
        GM_setValue('vine_context', JSON.stringify({ productTitle, asin, stars:n }));
        openChat(); // focus ChatGPT (sera fermé plus tard)
      };
    })();

    // Debug panel (masqué si DEBUG=false)
    function showDebug({raw, parsed, context}){
      if (!DEBUG) return;
      let p=document.getElementById('vine-debug');
      if(!p){
        p=document.createElement('div');
        p.id='vine-debug';
        p.style.cssText='position:fixed;left:12px;bottom:12px;z-index:999999;background:#111;color:#fff;border-radius:10px;max-width:560px;box-shadow:0 8px 24px rgba(0,0,0,.3);';
        p.innerHTML=`
          <div style="padding:8px 10px;border-bottom:1px solid #333;display:flex;gap:8px;align-items:center">
            <b>Vine DEBUG</b><span id="vd-stat" style="opacity:.8"></span>
            <div style="margin-left:auto;display:flex;gap:6px">
              <button id="vd-copy" class="vd-btn">Copier JSON</button>
              <button id="vd-close" class="vd-btn">✕</button>
            </div>
          </div>
          <div style="padding:8px 10px;display:grid;gap:6px">
            <div><b>Produit</b> : <span id="vd-prod"></span> <span style="opacity:.7">[ASIN:<span id="vd-asin"></span> · <span id="vd-stars"></span>★]</span></div>
            <div><b>Title</b> (<span id="vd-tl"></span>) : <span id="vd-title"></span></div>
            <div><b>Body</b> (<span id="vd-bl"></span>) :</div>
            <textarea id="vd-body" style="width:100%;height:120px;background:#181818;color:#fff;border:1px solid #333;border-radius:8px;padding:8px"></textarea>
            <details><summary style="cursor:pointer;padding:6px 8px;background:#0c0c0c;border:1px solid #222;border-radius:8px">RAW utilisé</summary>
              <textarea id="vd-raw" style="width:100%;height:160px;background:#0a0a0a;color:#ddd;border:0;padding:8px"></textarea>
            </details>
          </div>
          <style>
            #vine-debug .vd-btn{background:#222;border:1px solid #444;color:#fff;border-radius:8px;padding:4px 8px;cursor:pointer}
            #vine-debug .vd-btn:hover{background:#2a2a2a}
          </style>
        `;
        document.documentElement.appendChild(p);
      }
      const ctx=context||{};
      const t = parsed?.title||'', b=parsed?.body||'';
      p.querySelector('#vd-prod').textContent = ctx.productTitle||'(?)';
      p.querySelector('#vd-asin').textContent = ctx.asin||'(?)';
      p.querySelector('#vd-stars').textContent = ctx.stars||GM_getValue('vine_stars','?');
      p.querySelector('#vd-title').textContent= t;
      p.querySelector('#vd-tl').textContent   = t.length;
      p.querySelector('#vd-body').value       = b;
      p.querySelector('#vd-bl').textContent   = b.length;
      p.querySelector('#vd-raw').value        = raw||'';
      p.querySelector('#vd-copy').onclick     = ()=> copy(JSON.stringify(parsed||{},null,2));
      p.querySelector('#vd-close').onclick    = ()=> p.remove();

      const status = p.querySelector('#vd-stat');
      const refresh=()=>{
        const tVal=(document.querySelector('#reviewTitle[name="reviewTitle"]')?.value||'').trim();
        const bVal=(document.querySelector('#reviewText, textarea[name="reviewText"]')?.value||'').trim();
        status.textContent = `title:${tVal===t?'OK':'KO'} · body:${bVal===b?'OK':'KO'}`;
        status.style.color = (tVal===t && bVal===b)?'#4cd964':'#ffcc00';
      };
      setInterval(refresh,700);
    }

    async function fillFromResult(raw){
      const parsed = parseJSONStrict(raw);
      const ctx    = JSON.parse(GM_getValue('vine_context','{}')||'{}');
      const usedRaw= GM_getValue('vine_raw','');
      showDebug({raw:usedRaw||raw, parsed, context:ctx});
      if(!parsed) return;

      const n = parseInt(GM_getValue('vine_stars','0')||'0',10);
      if (n>=3 && n<=5){ await clickStars(n); }

      const tEl = titleElStrict();
      const bEl = bodyElStrict();
      if (tEl && bEl){
        await typeLike(tEl, parsed.title);
        await typeLike(bEl, parsed.body);
        reactCommit(tEl, parsed.title);
        reactCommit(bEl, parsed.body);
      }

      // ferme l’onglet ChatGPT (handle GM_openInTab) et refocus Amazon
      try{
        if(window.__vineChatTab && !window.__vineChatTab.closed){
          window.__vineChatTab.close();
        }
      }catch{}
      setTimeout(()=>{ try{ window.focus(); }catch{} }, 200);
      GM_setValue('vine_result','');
    }

    try{
      GM_addValueChangeListener('vine_result', (_n,_o,val,remote)=>{ if(remote && val){ fillFromResult(val); }});
    }catch{}

    (async function boot(){
      const from = GM_getValue('vine_from_list','');
      if (from){
        GM_setValue('vine_from_list','');
        await clickStarsSafe();
        // ouvre ChatGPT (focus) ; il sera fermé quand la réponse arrivera
        try{ if(window.__vineChatTab && !window.__vineChatTab.closed){ window.__vineChatTab.close(); } }catch{}
        GM_setValue('vine_chat_active', String(Date.now()));
        window.__vineChatTab = GM_openInTab('https://chatgpt.com/?vine=1', {active:true,insert:true,setParent:true});
        try{ if(window.__vineChatTab) window.__vineChatTab.onclose = ()=> window.focus(); }catch{}
      }
    })();

    return;
  }

  // =========================
  // CHATGPT
  // =========================
  if (isChatGPT){
    if (window.__vineAutoAvisStarted) return;
    const chatToken = GM_getValue('vine_chat_active','');
    if(!location.search.includes('vine=1') && !chatToken) return;
    window.__vineAutoAvisStarted = true;
    const log = logBox('Vine Helper (ChatGPT)');
    const waitEl = async (fn, tries=40)=>{ for(let i=0;i<tries;i++){ const v=fn(); if(v) return v; await wait(100); } return null; };
    let lastPrompt = '';

    function chatStatus(msg){
      let box = document.getElementById('vine-chat-status');
      if(!box){
        box = document.createElement('div');
        box.id = 'vine-chat-status';
        box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;background:#111;color:#fff;border:1px solid #444;border-radius:10px;padding:10px 12px;font:13px system-ui;max-width:380px;box-shadow:0 8px 24px rgba(0,0,0,.35)';
        box.innerHTML = `
          <div style="font-weight:700;margin-bottom:6px">Vine Auto-avis</div>
          <div id="vcs-msg" style="line-height:1.35"></div>
          <div style="display:flex;gap:6px;margin-top:8px">
            <button id="vcs-copy" style="background:#fff;color:#111;border:0;border-radius:7px;padding:6px 8px;cursor:pointer">Copier prompt</button>
            <button id="vcs-hide" style="background:#222;color:#fff;border:1px solid #555;border-radius:7px;padding:6px 8px;cursor:pointer">Masquer</button>
          </div>
        `;
        document.documentElement.appendChild(box);
        box.querySelector('#vcs-copy').onclick = ()=> copy(lastPrompt);
        box.querySelector('#vcs-hide').onclick = ()=> box.remove();
      }
      box.querySelector('#vcs-msg').textContent = msg;
    }

    function waitPageInsert(prompt, timeout=25000){
      return new Promise(resolve=>{
        const done = (ev)=>{
          document.removeEventListener('vine-auto-avis-page-status', done);
          resolve(ev.detail || {ok:false, step:'unknown'});
        };
        document.addEventListener('vine-auto-avis-page-status', done);
        setTimeout(()=>{
          document.removeEventListener('vine-auto-avis-page-status', done);
          resolve({ok:false, step:'timeout'});
        }, timeout);

        const script = document.createElement('script');
        script.textContent = `
          (async function(prompt){
            const sendStatus = detail => document.dispatchEvent(new CustomEvent('vine-auto-avis-page-status', { detail }));
            const sleep = ms => new Promise(r => setTimeout(r, ms));
            const isVisible = el => {
              if (!el) return false;
              const st = getComputedStyle(el);
              return st.display !== 'none' && st.visibility !== 'hidden' && el.getClientRects().length > 0;
            };
            const findComposer = () => {
              const sels = [
                'div#prompt-textarea.ProseMirror[contenteditable="true"]',
                '#prompt-textarea[contenteditable="true"]',
                '.ProseMirror[contenteditable="true"]',
                'div[role="textbox"][contenteditable="true"]',
                'main form [contenteditable="true"]',
                'textarea[name="prompt-textarea"]',
                'main form textarea'
              ];
              for (const s of sels){
                const el = [...document.querySelectorAll(s)].find(isVisible);
                if (el) return el;
              }
              return null;
            };
            const getText = el => el.tagName === 'TEXTAREA' ? (el.value || '') : (el.innerText || el.textContent || '');
            const selectAll = el => {
              el.focus();
              el.click();
              if (el.tagName === 'TEXTAREA'){
                el.value = '';
                return;
              }
              const range = document.createRange();
              range.selectNodeContents(el);
              const sel = getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            };
            const setDomFallback = (el, text) => {
              if (el.tagName === 'TEXTAREA'){
                el.value = text;
                return;
              }
              el.innerHTML = '';
              text.split('\\n').forEach(line => {
                const p = document.createElement('p');
                p.setAttribute('dir', 'auto');
                if (line) p.textContent = line;
                else p.appendChild(document.createElement('br'));
                el.appendChild(p);
              });
            };
            const fire = (el, text) => {
              try{ el.dispatchEvent(new InputEvent('beforeinput', {bubbles:true, composed:true, inputType:'insertText', data:text})); }catch{}
              try{ el.dispatchEvent(new InputEvent('input', {bubbles:true, composed:true, inputType:'insertText', data:text})); }catch{}
              try{ el.dispatchEvent(new Event('change', {bubbles:true})); }catch{}
              try{ el.closest('form')?.dispatchEvent(new Event('input', {bubbles:true})); }catch{}
            };

            let el = null;
            for (let i=0; i<200; i++){
              el = findComposer();
              if (el) break;
              await sleep(100);
            }
            if (!el) return sendStatus({ok:false, step:'composer-not-found'});

            selectAll(el);
            await sleep(80);
            let inserted = false;
            if (el.tagName !== 'TEXTAREA'){
              try{ document.execCommand('delete', false, null); }catch{}
              try{ inserted = document.execCommand('insertText', false, prompt); }catch{}
            }
            if (!inserted) setDomFallback(el, prompt);
            fire(el, prompt);
            await sleep(250);

            const ok = getText(el).includes(prompt.slice(0, 40));
            sendStatus({ok, step:ok?'inserted':'not-in-dom', textLength:getText(el).length, tag:el.tagName, id:el.id || '', cls:el.className || ''});
          })(${JSON.stringify(prompt)});
        `;
        document.documentElement.appendChild(script);
        script.remove();
      });
    }
    function clickSend(){
      const btns=[...document.querySelectorAll('button')].filter(b=>{
        if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
        const a=(b.getAttribute('aria-label')||'').toLowerCase();
        const t=(b.innerText||'').toLowerCase();
        const id=(b.id||'').toLowerCase();
        const test=(b.dataset?.testid||'').toLowerCase();
        return test==='send-button' || test==='composer-submit-button' || id==='composer-submit-button' ||
          /envoyer|send|submit|soumettre/.test(a) || /envoyer|send/.test(t);
      });
      if(btns[0]){ btns[0].click(); return true; }
      return false;
    }
    async function waitSendAndClick(){
      for(let i=0;i<40;i++){
        if(clickSend()) return true;
        await wait(250);
      }
      return false;
    }
    function pressEnter(cmp){
      cmp.el.focus();
      for (const type of ['keydown','keypress','keyup']){
        cmp.el.dispatchEvent(new KeyboardEvent(type,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,composed:true}));
      }
    }
    function getCandidates(){
      const arr=[]; const add=(s)=>{ if(s && s.includes('{') && s.includes('}')) arr.push(s.trim()); };
      document.querySelectorAll('pre, code, [data-message-author-role="assistant"], .markdown, article').forEach(n=>add(n.innerText||n.textContent||''));
      return arr.reverse();
    }
    function findGood(){
      const cands=getCandidates();
      for(const t of cands){
        const o=parseJSONLoose(t);
        if(o && o.title && o.body){
          const tt=onlyText(o.title), bb=onlyText(o.body);
          if(tt!=='...' && bb!=='...' && tt.length>5 && bb.length>20){
            return {obj:o, raw:t};
          }
        }
      }
      return null;
    }

    (async function run(){
      const prompt=GM_getValue('vine_prompt','');
      lastPrompt = prompt;
      if(!prompt){
        GM_setValue('vine_chat_active','');
        chatStatus('Aucun prompt reçu depuis Amazon. Relance depuis le bouton Auto-avis.');
        return;
      }
      chatStatus('Prompt reçu. Attente du chargement complet de ChatGPT...');
      await wait(3500);

      chatStatus('Insertion du prompt dans ChatGPT...');
      const insertResult = await waitPageInsert(prompt);
      if(!insertResult.ok){
        await copy(prompt);
        GM_setValue('vine_chat_active','');
        chatStatus(`Insertion échouée (${insertResult.step}). Prompt copié: colle-le avec Ctrl+V puis envoie.`);
        return;
      }
      chatStatus('Prompt inséré. Tentative d’envoi...');
      if (!await waitSendAndClick()){
        const el = document.querySelector('div#prompt-textarea.ProseMirror[contenteditable="true"], #prompt-textarea[contenteditable="true"], textarea[name="prompt-textarea"]');
        if(el) pressEnter({el});
      }
      chatStatus('Prompt envoyé. Attente de la réponse JSON...');

      let done=false;
      const check=()=>{
        if(done) return;
        const hit=findGood();
        if(hit){
          done=true;
          chatStatus('Réponse détectée. Retour vers Amazon...');
          GM_setValue('vine_raw', hit.raw);
          GM_setValue('vine_result', JSON.stringify(hit.obj)); // Amazon fermera l’onglet et reprendra le focus
          GM_setValue('vine_chat_active','');
        }
      };
      const obs=new MutationObserver(()=>{
        check();
      });
      obs.observe(document.body,{childList:true,subtree:true});
      const timer=setInterval(check,1500);
      setTimeout(()=>{
        obs.disconnect();
        clearInterval(timer);
        check();
        if(!done){
          GM_setValue('vine_chat_active','');
          chatStatus('Aucun JSON détecté après 2 minutes. Copie la réponse ChatGPT en JSON ou relance depuis Amazon.');
        }
      },120000);
    })();
  }
})();
