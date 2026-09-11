// ==UserScript==
// @name         Vine Auto Avis 2.0
// @namespace    vine-auto-avis
// @version      2.1
// @description  Genere un brouillon d'avis via ChatGPT et le colle dans le champ d'avis Amazon Vine. Ne coche jamais les etoiles, ne clique jamais sur Envoyer.
// @match        https://www.amazon.fr/vine/vine-reviews*
// @match        https://www.amazon.fr/review/create-review*
// @match        https://chatgpt.com/*
// @grant        GM_openInTab
// @grant        GM_addStyle
// @run-at       document-idle
// @updateURL    https://github.com/Alexis21110/AutoAvis/raw/refs/heads/main/AutoAvis.user.js
// @downloadURL  https://github.com/Alexis21110/AutoAvis/raw/refs/heads/main/AutoAvis.user.js
// ==/UserScript==

(function () {
  'use strict';

  // Data is passed between pages entirely via URL query params instead of
  // GM_setValue/GM_getValue: cross-domain shared storage between Tampermonkey
  // and GM_addValueChangeListener are not reliably supported on every
  // userscript engine (notably Safari on iOS), so the URL is the one channel
  // guaranteed to work everywhere.
  const PARAM_PROMPT = 'vinePrompt';
  const PARAM_ASIN = 'vineAsin';
  const PARAM_PRODUCT_TITLE = 'vineProductTitle';
  const PARAM_REVIEW_URL = 'vineReviewUrl';
  const PARAM_REVIEW_TITLE = 'vineReviewTitle';
  const PARAM_REVIEW_TEXT = 'vineReviewText';

  const LOG = (...args) => console.log('[VineAutoAvis]', ...args);

  function injectStyles() {
    if (document.getElementById('vine-auto-avis-styles')) return;
    const style = document.createElement('style');
    style.id = 'vine-auto-avis-styles';
    style.textContent = `
      .vine-auto-avis-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-top: 8px;
        padding: 8px 14px;
        font-size: 13px;
        font-weight: 600;
        line-height: 1.2;
        color: #fff;
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
        border: none;
        border-radius: 20px;
        box-shadow: 0 2px 6px rgba(99, 102, 241, 0.35);
        cursor: pointer;
        transition: transform 0.12s ease, box-shadow 0.12s ease, opacity 0.12s ease;
        white-space: nowrap;
      }
      .vine-auto-avis-btn:hover:not(:disabled) {
        transform: translateY(-1px);
        box-shadow: 0 4px 10px rgba(99, 102, 241, 0.45);
      }
      .vine-auto-avis-btn:active:not(:disabled) {
        transform: translateY(0);
        box-shadow: 0 1px 3px rgba(99, 102, 241, 0.4);
      }
      .vine-auto-avis-btn:disabled {
        opacity: 0.6;
        cursor: default;
        transform: none;
      }
      .vine-auto-avis-btn.vine-auto-avis-btn--secondary {
        background: #fff;
        color: #6366f1;
        border: 1.5px solid #6366f1;
        box-shadow: none;
      }
      .vine-auto-avis-btn.vine-auto-avis-btn--secondary:hover:not(:disabled) {
        background: #f5f3ff;
        box-shadow: 0 2px 6px rgba(99, 102, 241, 0.2);
      }
      @media (max-width: 600px) {
        .vine-auto-avis-btn {
          display: flex;
          width: 100%;
          justify-content: center;
          margin-top: 10px;
          padding: 12px 14px;
          font-size: 14px;
          border-radius: 12px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function buildPrompt(title) {
    return [
      `Redige un avis client en francais pour le produit suivant, comme si je l'avais reellement teste.`,
      `Titre du produit : "${title}"`,
      ``,
      `Contraintes :`,
      `- Le corps de l'avis fait 80 a 150 mots, ton naturel et credible.`,
      `- Mentionne au moins un point positif et un point negatif ou nuance plausibles.`,
      `- Pas de note chiffree, pas d'etoiles, pas de mention d'IA ou de programme Vine.`,
      `- Reponds immediatement et directement, sans reflexion longue ni raisonnement etendu : va droit au but, pas de plan ni de brouillon intermediaire.`,
      ``,
      `Reponds EXACTEMENT dans ce format, sans rien ajouter avant ou apres :`,
      `TITRE: <titre court de l'avis, 5 a 8 mots, sans guillemets>`,
      `AVIS: <texte du corps de l'avis>`,
    ].join('\n');
  }

  // Parses the "TITRE: ... / AVIS: ..." format requested in the prompt.
  // Falls back gracefully if the model didn't follow the format exactly.
  function stripLeadingLabel(text) {
    return text.replace(/^\s*avis\s+client\s*:?\s*/i, '').trim();
  }

  function parseGeneratedReview(rawTextInput, productTitle) {
    const rawText = stripLeadingLabel(rawTextInput);
    const avisIdx = rawText.search(/AVIS\s*:/i);
    const titreIdx = rawText.search(/TITRE\s*:/i);

    if (avisIdx === -1) {
      return { reviewTitle: (productTitle || '').slice(0, 60), reviewText: stripLeadingLabel(rawText) };
    }

    const body = stripLeadingLabel(rawText.slice(avisIdx).replace(/^AVIS\s*:/i, ''));
    let title = '';
    if (titreIdx !== -1 && titreIdx < avisIdx) {
      title = rawText.slice(titreIdx, avisIdx).replace(/^TITRE\s*:/i, '').trim();
    }
    if (!title) title = (productTitle || '').slice(0, 60);

    return { reviewTitle: title, reviewText: body };
  }

  // ---------------------------------------------------------------------
  // PART A: https://www.amazon.fr/vine/vine-reviews
  // ---------------------------------------------------------------------
  function initVineReviewsPage() {
    LOG('Vine reviews page detected');
    injectStyles();

    function findReviewLinks() {
      const byName = Array.from(
        document.querySelectorAll('a[name="vvp-reviews-table--review-item-btn"]')
      );
      if (byName.length) return byName;
      return Array.from(document.querySelectorAll('a[href*="/review/create-review"]'));
    }

    function extractAsin(href) {
      try {
        const url = new URL(href, location.origin);
        return url.searchParams.get('asin');
      } catch (e) {
        return null;
      }
    }

    function guessTitle(link) {
      const row = link.closest('tr.vvp-reviews-table--row') || link.closest('tr');
      if (row) {
        const full = row.querySelector('.a-truncate-full.a-offscreen');
        if (full && full.textContent.trim().length > 3) return full.textContent.trim();

        const anchor = row.querySelector('#vvp-reviews-product-detail-page-link');
        if (anchor && anchor.textContent.trim().length > 3) return anchor.textContent.trim();

        const img = row.querySelector('img[alt]');
        if (img && img.alt && img.alt.trim().length > 3) return img.alt.trim();
      }
      // Fallback: use the link's own accessible text/title.
      return (link.title || link.textContent || 'Produit inconnu').trim();
    }

    function addButton(link) {
      if (link.dataset.vineAutoAvisAdded) return;
      link.dataset.vineAutoAvisAdded = '1';

      const asin = extractAsin(link.href);
      if (!asin) return;

      const btn = document.createElement('button');
      btn.textContent = '✨ Auto avis';
      btn.type = 'button';
      btn.className = 'vine-auto-avis-btn';

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const title = guessTitle(link);
        const reviewUrl = new URL(link.href, location.origin).href;
        const prompt = buildPrompt(title);

        LOG('Starting draft flow for', asin, title);

        const chatUrl = new URL('https://chatgpt.com/');
        chatUrl.searchParams.set(PARAM_PROMPT, prompt);
        chatUrl.searchParams.set(PARAM_ASIN, asin);
        chatUrl.searchParams.set(PARAM_PRODUCT_TITLE, title);
        chatUrl.searchParams.set(PARAM_REVIEW_URL, reviewUrl);

        btn.textContent = '⏳ Génération en cours…';
        btn.disabled = true;
        setTimeout(() => {
          btn.textContent = '✨ Auto avis';
          btn.disabled = false;
        }, 4000);

        GM_openInTab(chatUrl.href, { active: true, insert: true });
      });

      // Insert outside the Amazon .a-button widget (which clips extra children),
      // directly in the actions cell so the button is actually visible.
      const actionsCell =
        link.closest('td.vvp-reviews-table--actions-col') ||
        link.closest('.a-button')?.parentElement ||
        link.parentElement;
      actionsCell.appendChild(btn);
    }

    function scan() {
      findReviewLinks().forEach(addButton);
    }

    scan();
    const observer = new MutationObserver(() => scan());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------
  // PART B: https://chatgpt.com/
  // ---------------------------------------------------------------------
  function initChatGptPage() {
    const params = new URL(location.href).searchParams;
    const prompt = params.get(PARAM_PROMPT);
    const asin = params.get(PARAM_ASIN);
    const productTitle = params.get(PARAM_PRODUCT_TITLE) || '';
    const reviewUrl = params.get(PARAM_REVIEW_URL);

    if (!prompt || !asin || !reviewUrl) return; // Not our flow, do nothing.

    LOG('ChatGPT page: sending prompt for', asin);

    function waitFor(selectorFn, timeoutMs = 20000, intervalMs = 300) {
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
          const el = selectorFn();
          if (el) return resolve(el);
          if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for element'));
          setTimeout(tick, intervalMs);
        };
        tick();
      });
    }

    function getPromptBox() {
      return document.querySelector('#prompt-textarea');
    }

    function getSendButton() {
      return document.querySelector('button[data-testid="send-button"]');
    }

    function getStopButton() {
      return document.querySelector('button[data-testid="stop-button"]');
    }

    function getLastAssistantMessage() {
      const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
      return nodes.length ? nodes[nodes.length - 1] : null;
    }

    // Best-effort: if a model switcher is present, try to pick the fast/instant
    // variant (as opposed to a "Thinking"/"Reasoning" mode) so generation is quicker.
    // Silently does nothing if the UI doesn't match (menu labels change often).
    async function trySelectFastModel() {
      try {
        const switcherBtn = document.querySelector(
          'button[data-testid="model-switcher-dropdown-button"], button[aria-label*="modele" i], button[aria-label*="model" i]'
        );
        if (!switcherBtn) return;

        switcherBtn.click();
        await new Promise((r) => setTimeout(r, 400));

        const options = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'));
        const fastOption = options.find((el) => {
          const t = el.textContent.toLowerCase();
          return (t.includes('instant') || t.includes('rapide') || t.includes('flash')) &&
            !t.includes('thinking') && !t.includes('reflex') && !t.includes('raisonnement');
        });

        if (fastOption) {
          fastOption.click();
          LOG('Fast model option selected:', fastOption.textContent.trim());
        } else {
          // Close the menu if we opened it but found nothing usable.
          document.body.click();
        }
        await new Promise((r) => setTimeout(r, 300));
      } catch (e) {
        LOG('trySelectFastModel failed (non-blocking):', e);
      }
    }

    async function run() {
      try {
        await trySelectFastModel();

        const box = await waitFor(getPromptBox);
        box.focus();

        // ProseMirror contenteditable: set text via execCommand/insertText for compatibility.
        document.execCommand('insertText', false, prompt);
        box.dispatchEvent(new Event('input', { bubbles: true }));

        await new Promise((r) => setTimeout(r, 400));

        const sendBtn = await waitFor(getSendButton, 8000);
        sendBtn.click();

        LOG('Prompt sent, waiting for response...');

        // Wait for streaming to start then finish.
        await waitFor(getStopButton, 10000).catch(() => LOG('Stop button not seen (fast answer?)'));

        // Poll until stop button disappears and text stops changing.
        let lastText = '';
        let stableCount = 0;
        while (stableCount < 4) {
          await new Promise((r) => setTimeout(r, 700));
          const msg = getLastAssistantMessage();
          const text = msg ? msg.innerText.trim() : '';
          const stillGenerating = !!getStopButton();
          if (text === lastText && !stillGenerating) {
            stableCount++;
          } else {
            stableCount = 0;
          }
          lastText = text;
        }

        if (!lastText) throw new Error('empty response text');

        LOG('Response captured, length', lastText.length);

        const { reviewTitle, reviewText } = parseGeneratedReview(lastText, productTitle);

        const targetUrl = new URL(reviewUrl);
        targetUrl.searchParams.set(PARAM_REVIEW_TITLE, reviewTitle);
        targetUrl.searchParams.set(PARAM_REVIEW_TEXT, reviewText);

        GM_openInTab(targetUrl.href, { active: true, insert: true });

        // Close this ChatGPT tab now that the result has been captured.
        // Only works on tabs without further navigation history (browser restriction).
        setTimeout(() => {
          try {
            window.close();
          } catch (e) {
            LOG('Could not auto-close ChatGPT tab (browser restriction):', e);
          }
        }, 500);
      } catch (err) {
        LOG('Error in ChatGPT flow:', err);
      }
    }

    run();
  }

  // ---------------------------------------------------------------------
  // PART C: https://www.amazon.fr/review/create-review
  // ---------------------------------------------------------------------
  function initCreateReviewPage() {
    injectStyles();
    const params = new URL(location.href).searchParams;
    const reviewTitle = params.get(PARAM_REVIEW_TITLE);
    const reviewText = params.get(PARAM_REVIEW_TEXT);

    function insertDraftIfReady() {
      if (!reviewText) return false;

      const textarea = document.querySelector('#reviewText');
      if (!textarea) return false;
      if (textarea.value.trim().length > 0) {
        LOG('reviewText already has content, not overwriting automatically');
        return true;
      }

      // This form is a React app: setting .value directly is ignored because
      // React wraps the native setter. Call the native setter explicitly so
      // React's change detection (which compares against it) still fires.
      const nativeTextareaSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      ).set;
      nativeTextareaSetter.call(textarea, reviewText);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      textarea.focus();
      textarea.blur();
      textarea.focus();

      const titleInput = document.querySelector('#reviewTitle');
      if (titleInput && !titleInput.value.trim() && reviewTitle) {
        const nativeInputSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        ).set;
        nativeInputSetter.call(titleInput, reviewTitle);
        titleInput.dispatchEvent(new Event('input', { bubbles: true }));
        titleInput.dispatchEvent(new Event('change', { bubbles: true }));
      }

      LOG('Draft inserted into #reviewText/#reviewTitle');
      return true;
    }

    function addManualButton() {
      const textarea = document.querySelector('#reviewText');
      if (!textarea || document.getElementById('vine-auto-avis-manual-btn')) return;

      const btn = document.createElement('button');
      btn.id = 'vine-auto-avis-manual-btn';
      btn.type = 'button';
      btn.textContent = '📋 Coller le brouillon IA';
      btn.className = 'vine-auto-avis-btn vine-auto-avis-btn--secondary';

      btn.addEventListener('click', () => {
        const inserted = insertDraftIfReady();
        if (!inserted) {
          alert('Aucun brouillon disponible dans cette page. Lancez "Auto avis" depuis la page Vine reviews.');
        }
      });

      textarea.parentNode.insertBefore(btn, textarea);
    }

    if (!reviewText) return; // Page opened directly, not via our flow: nothing to do.

    // The review form is a React SPA that can render #reviewText well after
    // document-idle. Poll for a while instead of trying only once.
    let attempts = 0;
    const maxAttempts = 40; // ~20s at 500ms
    const poller = setInterval(() => {
      attempts++;
      addManualButton();
      const done = insertDraftIfReady();
      if (done || attempts >= maxAttempts) {
        clearInterval(poller);
        if (!done) LOG('Gave up polling for #reviewText after', attempts, 'attempts');
      }
    }, 500);
  }

  // ---------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------
  if (location.hostname === 'www.amazon.fr' && location.pathname.startsWith('/vine/vine-reviews')) {
    initVineReviewsPage();
  } else if (location.hostname === 'www.amazon.fr' && location.pathname.startsWith('/review/create-review')) {
    initCreateReviewPage();
  } else if (location.hostname === 'chatgpt.com') {
    initChatGptPage();
  }
})();
