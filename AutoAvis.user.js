// ==UserScript==
// @name         Vine Auto Avis (brouillon IA - relecture obligatoire)
// @namespace    vine-auto-avis
// @version      1.0
// @description  Genere un brouillon d'avis via ChatGPT et le colle dans le champ d'avis Amazon Vine. Ne coche jamais les etoiles, ne clique jamais sur Envoyer.
// @match        https://www.amazon.fr/vine/vine-reviews*
// @match        https://www.amazon.fr/review/create-review*
// @match        https://chatgpt.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @grant        GM_addValueChangeListener
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const LOG = (...args) => console.log('[VineAutoAvis]', ...args);

  function draftKey(asin) {
    return `vine_draft_${asin}`;
  }

  function buildPrompt(title) {
    return [
      `Redige un avis client en francais pour le produit suivant, comme si je l'avais reellement teste.`,
      `Titre du produit : "${title}"`,
      ``,
      `Contraintes :`,
      `- 80 a 150 mots, ton naturel et credible.`,
      `- Mentionne au moins un point positif et un point negatif ou nuance plausibles.`,
      `- Pas de note chiffree, pas d'etoiles, pas de mention d'IA ou de programme Vine.`,
      `- Juste le texte de l'avis, sans titre ni guillemets.`,
    ].join('\n');
  }

  // ---------------------------------------------------------------------
  // PART A: https://www.amazon.fr/vine/vine-reviews
  // ---------------------------------------------------------------------
  function initVineReviewsPage() {
    LOG('Vine reviews page detected');

    function findReviewLinks() {
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
      // Try a few common ancestor patterns for the product title near the review link.
      const container =
        link.closest('[class*="item"], [class*="product"], li, tr, div[role="listitem"]') ||
        link.closest('div');
      if (container) {
        const img = container.querySelector('img[alt]');
        if (img && img.alt && img.alt.trim().length > 3) return img.alt.trim();

        const heading = container.querySelector('h1, h2, h3, [class*="title"]');
        if (heading && heading.textContent.trim().length > 3) return heading.textContent.trim();

        const anyLink = container.querySelector('a[title]');
        if (anyLink && anyLink.title) return anyLink.title.trim();
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
      btn.textContent = '🤖 Auto avis (brouillon)';
      btn.type = 'button';
      btn.style.marginLeft = '8px';
      btn.style.padding = '4px 8px';
      btn.style.fontSize = '12px';
      btn.style.cursor = 'pointer';
      btn.style.border = '1px solid #888';
      btn.style.borderRadius = '4px';
      btn.style.background = '#fff';

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const title = guessTitle(link);
        const reviewUrl = new URL(link.href, location.origin).href;

        LOG('Starting draft flow for', asin, title);

        GM_setValue(draftKey(asin), {
          asin,
          title,
          reviewUrl,
          prompt: buildPrompt(title),
          status: 'pending',
          text: '',
          ts: Date.now(),
        });
        GM_setValue('vine_active_asin', asin);

        btn.textContent = '⏳ Generation en cours...';
        btn.disabled = true;

        GM_openInTab('https://chatgpt.com/', { active: true, insert: true });
      });

      link.insertAdjacentElement('afterend', btn);
    }

    function scan() {
      findReviewLinks().forEach(addButton);
    }

    scan();
    const observer = new MutationObserver(() => scan());
    observer.observe(document.body, { childList: true, subtree: true });

    // Feedback when a draft becomes ready (in case user stays on this tab).
    GM_addValueChangeListener('vine_active_asin', () => {}); // keep listener alive if needed later
  }

  // ---------------------------------------------------------------------
  // PART B: https://chatgpt.com/
  // ---------------------------------------------------------------------
  function initChatGptPage() {
    const asin = GM_getValue('vine_active_asin', null);
    if (!asin) return;

    const draft = GM_getValue(draftKey(asin), null);
    if (!draft || draft.status !== 'pending') return;

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

    async function run() {
      try {
        const box = await waitFor(getPromptBox);
        box.focus();

        // ProseMirror contenteditable: set text via execCommand/insertText for compatibility.
        document.execCommand('insertText', false, draft.prompt);
        box.dispatchEvent(new Event('input', { bubbles: true }));

        await new Promise((r) => setTimeout(r, 400));

        const sendBtn = await waitFor(getSendButton, 8000);
        sendBtn.click();

        GM_setValue(draftKey(asin), { ...draft, status: 'awaiting_response' });
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

        const updated = { ...draft, status: 'ready', text: lastText };
        GM_setValue(draftKey(asin), updated);
        GM_deleteValue('vine_active_asin');

        GM_notification({
          title: 'Brouillon Vine pret',
          text: `Brouillon genere pour "${draft.title}". Ouverture de la page d'avis...`,
          timeout: 4000,
        });

        GM_openInTab(draft.reviewUrl, { active: true, insert: true });
      } catch (err) {
        LOG('Error in ChatGPT flow:', err);
        GM_setValue(draftKey(asin), { ...draft, status: 'error', error: String(err) });
      }
    }

    run();
  }

  // ---------------------------------------------------------------------
  // PART C: https://www.amazon.fr/review/create-review
  // ---------------------------------------------------------------------
  function initCreateReviewPage() {
    const url = new URL(location.href);
    const asin = url.searchParams.get('asin');
    if (!asin) {
      LOG('No asin in create-review URL, skipping');
      return;
    }

    function insertDraftIfReady() {
      const draft = GM_getValue(draftKey(asin), null);
      if (!draft) return false;
      if (draft.status === 'error') {
        LOG('Draft generation failed:', draft.error);
        return false;
      }
      if (draft.status !== 'ready' || !draft.text) return false;

      const textarea = document.querySelector('#reviewText');
      if (!textarea) return false;
      if (textarea.value.trim().length > 0) {
        LOG('reviewText already has content, not overwriting automatically');
        return true;
      }

      textarea.value = draft.text;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      textarea.focus();

      showBanner();
      LOG('Draft inserted into #reviewText for asin', asin);
      return true;
    }

    function showBanner() {
      if (document.getElementById('vine-auto-avis-banner')) return;
      const banner = document.createElement('div');
      banner.id = 'vine-auto-avis-banner';
      banner.textContent =
        '⚠️ Brouillon genere par IA inseré ci-dessous. Relisez, corrigez selon votre experience reelle, et choisissez vous-meme la note en etoiles avant d\'envoyer.';
      banner.style.background = '#fff3cd';
      banner.style.border = '1px solid #ffc107';
      banner.style.color = '#664d03';
      banner.style.padding = '10px 14px';
      banner.style.margin = '10px 0';
      banner.style.borderRadius = '6px';
      banner.style.fontSize = '13px';
      banner.style.fontWeight = 'bold';

      const textarea = document.querySelector('#reviewText');
      if (textarea && textarea.parentNode) {
        textarea.parentNode.insertBefore(banner, textarea);
      } else {
        document.body.insertBefore(banner, document.body.firstChild);
      }
    }

    function addManualButton() {
      const textarea = document.querySelector('#reviewText');
      if (!textarea || document.getElementById('vine-auto-avis-manual-btn')) return;

      const btn = document.createElement('button');
      btn.id = 'vine-auto-avis-manual-btn';
      btn.type = 'button';
      btn.textContent = '📋 Coller le brouillon IA';
      btn.style.margin = '6px 0';
      btn.style.padding = '4px 8px';
      btn.style.fontSize = '12px';
      btn.style.cursor = 'pointer';

      btn.addEventListener('click', () => {
        const inserted = insertDraftIfReady();
        if (!inserted) {
          alert('Aucun brouillon pret pour ce produit. Lancez "Auto avis" depuis la page Vine reviews.');
        }
      });

      textarea.parentNode.insertBefore(btn, textarea);
    }

    // Try immediately, then react to draft becoming ready if we arrived early.
    if (!insertDraftIfReady()) {
      GM_addValueChangeListener(draftKey(asin), (name, oldVal, newVal) => {
        if (newVal && newVal.status === 'ready') {
          insertDraftIfReady();
        }
      });
    }

    addManualButton();
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
