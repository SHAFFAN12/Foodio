/*!
 * AI Automation SDK v1.0.0
 * https://github.com/ai-automation/sdk
 * MIT License
 */
(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
    typeof define === 'function' && define.amd ? define(['exports'], factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.AI = {}));
})(this, (function (exports) { 'use strict';

    /**
     * Error handling utilities
     */

    const ErrorCodes = Object.freeze({
      NOT_SUPPORTED: 'NOT_SUPPORTED',
      PERMISSION_DENIED: 'PERMISSION_DENIED',
      VOICE_ERROR: 'VOICE_ERROR',
      ELEMENT_NOT_FOUND: 'ELEMENT_NOT_FOUND',
      EXECUTION_ERROR: 'EXECUTION_ERROR',
      INVALID_CONFIG: 'INVALID_CONFIG'
    });
    class AISDKError extends Error {
      /**
       * @param {string} message
       * @param {string} code  One of ErrorCodes
       * @param {Error} [cause]
       */
      constructor(message, code = ErrorCodes.EXECUTION_ERROR, cause) {
        super(message);
        this.name = 'AISDKError';
        this.code = code;
        if (cause) this.cause = cause;
      }
    }

    /**
     * Show an unobtrusive toast notification in the page (if allowed).
     * Falls back to console.warn if the DOM is not available.
     * @param {string} message
     * @param {'info'|'warn'|'error'} [level]
     */
    function showToast(message, level = 'info') {
      if (typeof document === 'undefined') {
        console[level === 'error' ? 'error' : 'warn']('[AI SDK]', message);
        return;
      }
      const existing = document.getElementById('__ai-sdk-toast');
      if (existing) existing.remove();
      const toast = document.createElement('div');
      toast.id = '__ai-sdk-toast';
      const colors = {
        info: '#3b82f6',
        warn: '#f59e0b',
        error: '#ef4444'
      };
      Object.assign(toast.style, {
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        zIndex: '999999',
        background: colors[level] || colors.info,
        color: '#fff',
        padding: '12px 20px',
        borderRadius: '10px',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '14px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
        transition: 'opacity 0.4s ease',
        opacity: '1',
        maxWidth: '340px',
        lineHeight: '1.4'
      });
      toast.textContent = `🤖 ${message}`;
      document.body.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 500);
      }, 3500);
    }

    /**
     * VoiceEngine — wraps the Web Speech API (SpeechRecognition) with:
     *   • continuous and push-to-talk modes
     *   • robust browser fallback detection
     *   • permission management
     *   • parsed intent events ({ action, target, value })
     */


    // ─── Intent / command grammar ─────────────────────────────────────────────────
    // Patterns are evaluated in order; first match wins.
    const COMMAND_PATTERNS = [
    // Form fill: "fill name John Doe" / "enter email foo@bar.com"
    {
      regex: /^(?:fill|enter|type|set|put)\s+(?:the\s+)?(\w[\w\s]*?)\s+(?:field\s+)?(?:with\s+|to\s+|as\s+)?(.+)$/i,
      action: 'form.fill',
      parse: m => ({
        target: m[1].trim(),
        value: m[2].trim()
      })
    },
    // Scroll: "scroll to pricing" / "go to footer" / "scroll up|down"
    {
      regex: /^(?:scroll|go|navigate)\s+(?:to\s+)?(?:the\s+)?(up|down|top|bottom|[\w\s]+)$/i,
      action: 'scroll.to',
      parse: m => ({
        target: m[1].trim(),
        value: null
      })
    },
    // Search: "search for machine learning" / "look up neural networks"
    {
      regex: /^(?:search|look up|find|query)\s+(?:for\s+)?(.+)$/i,
      action: 'search.query',
      parse: m => ({
        target: null,
        value: m[1].trim()
      })
    },
    // Click / navigation: "click sign up" / "open menu" / "press submit"
    {
      regex: /^(?:click|press|open|tap|activate|close|toggle)\s+(?:the\s+)?(.+)$/i,
      action: 'nav.click',
      parse: m => ({
        target: m[1].trim(),
        value: null
      })
    },
    // History: "go back" / "go forward"
    {
      regex: /^go\s+(back|forward)$/i,
      action: 'nav.history',
      parse: m => ({
        target: m[1].toLowerCase(),
        value: null
      })
    },
    // Submit form
    {
      regex: /^(?:submit|send)\s+(?:the\s+)?(?:form)?(.*)$/i,
      action: 'form.submit',
      parse: m => ({
        target: m[1].trim() || 'form',
        value: null
      })
    },
    // Stop / cancel listening
    {
      regex: /^(?:stop|cancel|quit|exit)\s*(?:listening)?$/i,
      action: 'voice.stop',
      parse: () => ({
        target: null,
        value: null
      })
    }];

    /**
     * Parse a raw transcript string into a structured intent object.
     * @param {string} transcript
     * @returns {{ action: string, target: string|null, value: string|null, raw: string } | null}
     */
    function parseIntent(transcript) {
      const text = transcript.trim().replace(/\s+/g, ' ');
      for (const pattern of COMMAND_PATTERNS) {
        const m = text.match(pattern.regex);
        if (m) {
          const parsed = pattern.parse(m);
          return {
            action: pattern.action,
            ...parsed,
            raw: text
          };
        }
      }
      return {
        action: 'unknown',
        target: null,
        value: null,
        raw: text
      };
    }

    // ─── VoiceEngine class ────────────────────────────────────────────────────────

    class VoiceEngine extends EventTarget {
      /**
       * @param {{ mode?: 'continuous'|'push-to-talk', language?: string, debug?: boolean }} options
       */
      constructor(options = {}) {
        super();
        this.mode = options.mode || 'push-to-talk';
        this.language = options.language || navigator.language || 'en-US';
        this.debug = options.debug || false;
        this._recognition = null;
        this._isListening = false;
        this._supported = false;
        this._init();
      }

      // ── Initialisation ──────────────────────────────────────────────────────────

      _init() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
          this._log('warn', 'SpeechRecognition API not available in this browser.');
          this._dispatchError(new AISDKError('SpeechRecognition is not supported in this browser.', ErrorCodes.NOT_SUPPORTED));
          return;
        }
        this._supported = true;
        const r = new SpeechRecognition();
        r.lang = this.language;
        r.interimResults = false;
        r.maxAlternatives = 1;
        r.continuous = this.mode === 'continuous';
        r.onstart = () => {
          this._isListening = true;
          this._log('info', 'Voice recognition started.');
          this.dispatchEvent(new CustomEvent('start'));
        };
        r.onend = () => {
          this._isListening = false;
          this._log('info', 'Voice recognition ended.');
          this.dispatchEvent(new CustomEvent('end'));

          // In continuous mode, auto-restart unless explicitly stopped
          if (this.mode === 'continuous' && this._continuousActive) {
            setTimeout(() => {
              try {
                r.start();
              } catch (_) {}
            }, 300);
          }
        };
        r.onresult = event => {
          const transcript = event.results[event.results.length - 1][0].transcript;
          const confidence = event.results[event.results.length - 1][0].confidence;
          this._log('info', `Heard: "${transcript}" (confidence: ${(confidence * 100).toFixed(0)}%)`);
          const intent = parseIntent(transcript);
          this._log('info', 'Parsed intent:', intent);
          this.dispatchEvent(new CustomEvent('command', {
            detail: {
              intent,
              transcript,
              confidence
            }
          }));
        };
        r.onerror = event => {
          this._isListening = false;
          this._log('warn', 'Recognition error:', event.error);
          const err = new AISDKError(`Speech recognition error: ${event.error}`, ErrorCodes.VOICE_ERROR);
          this.dispatchEvent(new CustomEvent('error', {
            detail: {
              error: err,
              native: event.error
            }
          }));
          // Auto-restart on recoverable errors in continuous mode
          if (this.mode === 'continuous' && this._continuousActive && ['no-speech', 'audio-capture'].includes(event.error)) {
            setTimeout(() => {
              try {
                r.start();
              } catch (_) {}
            }, 1000);
          }
        };
        r.onnomatch = () => {
          this._log('warn', 'No speech match.');
          this.dispatchEvent(new CustomEvent('nomatch'));
        };
        this._recognition = r;
      }

      // ── Public API ──────────────────────────────────────────────────────────────

      /** Start listening (one-shot for push-to-talk, or persistent for continuous). */
      async start() {
        if (!this._supported) throw new AISDKError('Voice not supported.', ErrorCodes.NOT_SUPPORTED);
        if (this._isListening) return;
        try {
          // Request microphone permission explicitly so we can give a friendly error
          await navigator.mediaDevices.getUserMedia({
            audio: true
          });
        } catch (e) {
          const err = new AISDKError('Microphone access denied. Please allow microphone permission and try again.', ErrorCodes.PERMISSION_DENIED);
          this.dispatchEvent(new CustomEvent('error', {
            detail: {
              error: err
            }
          }));
          throw err;
        }
        if (this.mode === 'continuous') this._continuousActive = true;
        try {
          this._recognition.start();
        } catch (e) {
          // May throw if already started — safe to ignore
        }
      }

      /** Stop listening. */
      stop() {
        this._continuousActive = false;
        if (this._recognition && this._isListening) {
          this._recognition.stop();
        }
      }

      /** Toggle listening state. */
      toggle() {
        if (this._isListening) {
          this.stop();
        } else {
          this.start();
        }
      }
      get isListening() {
        return this._isListening;
      }
      get isSupported() {
        return this._supported;
      }

      // ── Helpers ─────────────────────────────────────────────────────────────────

      _log(level, ...args) {
        if (this.debug) console[level]('[VoiceEngine]', ...args);
      }
      _dispatchError(err) {
        this.dispatchEvent(new CustomEvent('error', {
          detail: {
            error: err
          }
        }));
      }
    }

    var voiceEngine = /*#__PURE__*/Object.freeze({
        __proto__: null,
        VoiceEngine: VoiceEngine,
        parseIntent: parseIntent
    });

    /**
     * DOMAnalyzer — discovers and tracks all SDK-managed elements.
     *
     * It scans the document for elements carrying ai-* utility classes,
     * categorises them, and maintains a live registry via MutationObserver
     * so dynamically-added elements are automatically registered.
     */

    // ─── Utility class categories ─────────────────────────────────────────────────

    const CATEGORY_MATCHERS = [{
      category: 'form',
      classes: ['ai-autofill', 'ai-autofill-personal', 'ai-autofill-address', 'ai-autofill-payment', 'ai-form-voice', 'ai-field-smart']
    }, {
      category: 'scroll',
      classes: ['ai-scroll-target', 'ai-scroll-voice', 'ai-scroll-smooth']
    }, {
      category: 'search',
      classes: ['ai-search-voice', 'ai-search-auto', 'ai-results-nav']
    }, {
      category: 'nav',
      classes: ['ai-nav-voice', 'ai-link-clickable', 'ai-menu-voice', 'ai-clickable-voice', 'ai-voice-activate']
    }];

    /** All recognised SDK class names as a flat Set for quick O(1) lookup. */
    const ALL_SDK_CLASSES = new Set(CATEGORY_MATCHERS.flatMap(m => m.classes));

    // ─── Helpers ──────────────────────────────────────────────────────────────────

    /**
     * Determine which SDK classes an element has.
     * @param {Element} el
     * @returns {string[]}
     */
    function getSdkClasses(el) {
      if (!el.classList) return [];
      return [...el.classList].filter(c => ALL_SDK_CLASSES.has(c));
    }

    /**
     * Derive the element category from its SDK classes.
     * @param {string[]} sdkClasses
     * @returns {string|null}
     */
    function getCategory(sdkClasses) {
      for (const matcher of CATEGORY_MATCHERS) {
        if (sdkClasses.some(c => matcher.classes.includes(c))) {
          return matcher.category;
        }
      }
      return null;
    }

    /**
     * Extract a human-readable label from an element for fuzzy command matching.
     * Priority: aria-label > data-ai-label > placeholder > name > id > textContent
     * @param {Element} el
     * @returns {string}
     */
    function extractLabel(el) {
      return (el.getAttribute('aria-label') || el.getAttribute('data-ai-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('id') || el.textContent.trim().slice(0, 60)).toLowerCase().trim();
    }

    /**
     * Build a registry entry for a DOM element.
     * @param {Element} el
     * @returns {{ el: Element, category: string, sdkClasses: string[], label: string } | null}
     */
    function buildEntry(el) {
      const sdkClasses = getSdkClasses(el);
      if (!sdkClasses.length) return null;
      const category = getCategory(sdkClasses);
      if (!category) return null;
      return {
        el,
        category,
        sdkClasses,
        label: extractLabel(el)
      };
    }

    // ─── DOMAnalyzer class ────────────────────────────────────────────────────────

    class DOMAnalyzer {
      constructor() {
        /** @type {Map<Element, { el: Element, category: string, sdkClasses: string[], label: string }>} */
        this._registry = new Map();
        this._observer = null;
      }

      // ── Lifecycle ───────────────────────────────────────────────────────────────

      /** Scan the document and start watching for DOM changes. */
      init() {
        this._scanAll();
        this._startObserver();
      }

      /** Stop observing (call when tearing down the SDK). */
      destroy() {
        if (this._observer) {
          this._observer.disconnect();
          this._observer = null;
        }
        this._registry.clear();
      }

      // ── Query API ───────────────────────────────────────────────────────────────

      /** All registered entries. @returns {Array} */
      get all() {
        return [...this._registry.values()];
      }

      /** Entries filtered by category. @param {string} category @returns {Array} */
      byCategory(category) {
        return this.all.filter(e => e.category === category);
      }

      /**
       * Find entries whose label fuzzy-matches the given query string.
       * @param {string} query
       * @param {string} [category]
       * @returns {Array}
       */
      fuzzyFind(query, category) {
        const pool = category ? this.byCategory(category) : this.all;
        const q = query.toLowerCase().trim();
        // Exact substring match first
        const exact = pool.filter(e => e.label.includes(q));
        if (exact.length) return exact;
        // Token overlap fallback
        const tokens = q.split(/\s+/);
        return pool.filter(e => tokens.some(t => e.label.includes(t)));
      }

      /**
       * Force a re-scan of the entire document.
       * Useful after bulk dynamic DOM updates.
       */
      refresh() {
        this._registry.clear();
        this._scanAll();
      }

      // ── Private ─────────────────────────────────────────────────────────────────

      _scanAll() {
        // Select all elements that carry at least one ai-* class
        const aiSelector = [...ALL_SDK_CLASSES].map(c => `.${c}`).join(',');
        document.querySelectorAll(aiSelector).forEach(el => this._register(el));
      }
      _register(el) {
        const entry = buildEntry(el);
        if (entry) this._registry.set(el, entry);
      }
      _unregister(el) {
        this._registry.delete(el);
      }
      _startObserver() {
        this._observer = new MutationObserver(mutations => {
          for (const mutation of mutations) {
            // Added nodes
            mutation.addedNodes.forEach(node => {
              if (node.nodeType !== Node.ELEMENT_NODE) return;
              // Register the node itself if it has SDK classes
              if (getSdkClasses(node).length) this._register(node);
              // Also scan its subtree
              node.querySelectorAll && node.querySelectorAll([...ALL_SDK_CLASSES].map(c => `.${c}`).join(',')).forEach(el => this._register(el));
            });
            // Removed nodes
            mutation.removedNodes.forEach(node => {
              if (node.nodeType !== Node.ELEMENT_NODE) return;
              this._unregister(node);
            });
            // Class attribute changes
            if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
              const el = mutation.target;
              if (getSdkClasses(el).length) {
                this._register(el);
              } else {
                this._unregister(el);
              }
            }
          }
        });
        this._observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class']
        });
      }
    }

    /**
     * AutomationProcessor — the central command router.
     *
     * Receives parsed intent objects from VoiceEngine and dispatches
     * them to the appropriate module (form, scroll, search, nav).
     * Provides lifecycle hooks: onCommand, onSuccess, onError.
     */

    class AutomationProcessor extends EventTarget {
      /**
       * @param {{ debug?: boolean }} options
       */
      constructor(options = {}) {
        super();
        this.debug = options.debug || false;
        /** @type {Map<string, Function>} */
        this._handlers = new Map();
      }

      // ── Module registration ─────────────────────────────────────────────────────

      /**
       * Register a handler for one or more action prefixes.
       * @param {string|string[]} actions  e.g. 'form.fill' or ['form.fill','form.submit']
       * @param {Function} handler         async (intent, domAnalyzer) => void
       */
      register(actions, handler) {
        const list = Array.isArray(actions) ? actions : [actions];
        list.forEach(a => this._handlers.set(a, handler));
      }

      // ── Command dispatch ────────────────────────────────────────────────────────

      /**
       * Process a parsed intent.
       * @param {{ action: string, target: string|null, value: string|null, raw: string }} intent
       * @param {import('../core/dom-analyzer.js').DOMAnalyzer} domAnalyzer
       */
      async process(intent, domAnalyzer) {
        this._log('info', 'Processing intent:', intent);
        this.dispatchEvent(new CustomEvent('command', {
          detail: {
            intent
          }
        }));
        if (intent.action === 'unknown') {
          this._log('warn', `Unrecognised command: "${intent.raw}"`);
          this.dispatchEvent(new CustomEvent('unrecognized', {
            detail: {
              intent
            }
          }));
          return;
        }
        if (intent.action === 'voice.stop') {
          this.dispatchEvent(new CustomEvent('stop-voice'));
          return;
        }

        // Find exact handler, then try prefix match
        let handler = this._handlers.get(intent.action);
        if (!handler) {
          // e.g. 'form.fill.personal' → try 'form.fill' → try 'form'
          const parts = intent.action.split('.');
          while (parts.length && !handler) {
            parts.pop();
            handler = this._handlers.get(parts.join('.'));
          }
        }
        if (!handler) {
          this._log('warn', `No handler registered for action: ${intent.action}`);
          this.dispatchEvent(new CustomEvent('unhandled', {
            detail: {
              intent
            }
          }));
          return;
        }
        try {
          await handler(intent, domAnalyzer);
          this._log('info', 'Command executed successfully:', intent.action);
          this.dispatchEvent(new CustomEvent('success', {
            detail: {
              intent
            }
          }));
        } catch (err) {
          this._log('warn', 'Command failed:', err.message);
          const sdkErr = err instanceof AISDKError ? err : new AISDKError(err.message, ErrorCodes.EXECUTION_ERROR);
          this.dispatchEvent(new CustomEvent('error', {
            detail: {
              error: sdkErr,
              intent
            }
          }));
        }
      }
      _log(level, ...args) {
        if (this.debug) console[level]('[AutomationProcessor]', ...args);
      }
    }

    /**
     * General helper utilities
     */

    // ─── String / fuzzy matching ──────────────────────────────────────────────────

    /**
     * Levenshtein edit distance between two strings (case-insensitive).
     * @param {string} a
     * @param {string} b
     * @returns {number}
     */
    function levenshtein(a, b) {
      a = a.toLowerCase();
      b = b.toLowerCase();
      const m = a.length,
        n = b.length;
      const dp = Array.from({
        length: m + 1
      }, (_, i) => Array.from({
        length: n + 1
      }, (__, j) => i === 0 ? j : j === 0 ? i : 0));
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
      }
      return dp[m][n];
    }

    /**
     * Fuzzy match score between query and candidate (0–1, higher = better match).
     * @param {string} query
     * @param {string} candidate
     * @returns {number}
     */
    function fuzzyScore(query, candidate) {
      query = query.toLowerCase().trim();
      candidate = candidate.toLowerCase().trim();
      if (candidate.includes(query)) return 1;
      const maxLen = Math.max(query.length, candidate.length);
      if (maxLen === 0) return 1;
      const dist = levenshtein(query, candidate);
      return Math.max(0, 1 - dist / maxLen);
    }

    /**
     * Pick the best-matching entry from an array.
     * @template T
     * @param {string} query
     * @param {T[]} candidates
     * @param {(item: T) => string} getLabelFn
     * @param {number} [threshold=0.4]
     * @returns {T | null}
     */
    function bestMatch(query, candidates, getLabelFn, threshold = 0.4) {
      let best = null;
      let bestScore = -1;
      for (const candidate of candidates) {
        const score = fuzzyScore(query, getLabelFn(candidate));
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
      return bestScore >= threshold ? best : null;
    }

    // ─── DOM helpers ──────────────────────────────────────────────────────────────

    /**
     * Dispatch a native browser `input` + `change` event on an element.
     * Frameworks like React and Vue listen to these synthetic events.
     * @param {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} el
     * @param {string} value
     */
    function dispatchNativeEvent(el, value) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (nativeInputValueSetter) {
        nativeInputValueSetter.set.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event('input', {
        bubbles: true
      }));
      el.dispatchEvent(new Event('change', {
        bubbles: true
      }));
    }

    /**
     * Pause execution for `ms` milliseconds.
     * @param {number} ms
     * @returns {Promise<void>}
     */
    function sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * FormAutofill Module
     *
     * Handles voice-driven form field population.
     * Utility classes: ai-autofill, ai-autofill-personal, ai-autofill-address,
     *                  ai-autofill-payment, ai-form-voice, ai-field-smart
     */


    /**
     * Find a form field element in the document that best matches the spoken target label.
     * @param {string} targetLabel  Raw voice target string, e.g. "email address"
     * @param {import('../core/dom-analyzer.js').DOMAnalyzer} domAnalyzer
     * @returns {HTMLElement | null}
     */
    function findField(targetLabel, domAnalyzer) {
      // 1) Look in the SDK registry first
      const formEntries = domAnalyzer.byCategory('form');
      if (formEntries.length) {
        const match = bestMatch(targetLabel, formEntries, e => e.label);
        if (match) return match.el;
      }

      // 2) Fallback: scan all input/textarea/select elements
      const allFields = [...document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]), textarea, select')];

      // Build label strings for each
      const labeled = allFields.map(el => {
        const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('id') || '';
        return {
          el,
          label: label.toLowerCase()
        };
      });
      const best = bestMatch(targetLabel, labeled, e => e.label, 0.3);
      return best ? best.el : null;
    }

    // ─── FormAutofill handler factory ─────────────────────────────────────────────

    /**
     * Returns the handler function to register with AutomationProcessor.
     * @returns {Function}
     */
    function createFormAutofillHandler() {
      /**
       * @param {{ action: string, target: string|null, value: string|null, raw: string }} intent
       * @param {import('../core/dom-analyzer.js').DOMAnalyzer} domAnalyzer
       */
      return async function formAutofillHandler(intent, domAnalyzer) {
        const {
          target,
          value
        } = intent;
        if (!target) {
          throw new AISDKError('No field target specified in voice command.', ErrorCodes.ELEMENT_NOT_FOUND);
        }
        if (value === null || value === undefined) {
          throw new AISDKError('No value specified to fill into the field.', ErrorCodes.ELEMENT_NOT_FOUND);
        }
        const field = findField(target, domAnalyzer);
        if (!field) {
          throw new AISDKError(`Could not find a field matching "${target}".`, ErrorCodes.ELEMENT_NOT_FOUND);
        }

        // Smoothly focus the field, then fill with a tiny delay for visual feedback
        field.focus();
        await sleep(80);
        fillField(field, value);
      };
    }

    /**
     * Fill a single form field with a value, dispatching framework-compatible events.
     * @param {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} field
     * @param {string} value
     */
    function fillField(field, value) {
      const tag = field.tagName.toLowerCase();
      if (tag === 'select') {
        const options = [...field.options];
        const match = bestMatch(value, options, o => o.text, 0.3);
        if (match) {
          field.value = match.value;
        } else {
          field.value = value;
        }
      } else {
        dispatchNativeEvent(field, value);
      }

      // Visual feedback pulse
      field.style.transition = 'box-shadow 0.3s ease';
      field.style.boxShadow = '0 0 0 3px rgba(59, 130, 246, 0.5)';
      setTimeout(() => {
        field.style.boxShadow = '';
      }, 1200);
    }

    /**
     * Handler for form submit commands.
     * @returns {Function}
     */
    function createFormSubmitHandler() {
      return async function formSubmitHandler(intent, domAnalyzer) {
        // Find the nearest form to the first ai-autofill field, or just the first form
        const formEntries = domAnalyzer.byCategory('form');
        let form = null;
        if (formEntries.length) {
          form = formEntries[0].el.closest('form');
        }
        if (!form) form = document.querySelector('form');
        if (!form) throw new AISDKError('No form found on the page.', ErrorCodes.ELEMENT_NOT_FOUND);
        const submitBtn = form.querySelector('[type="submit"], button:not([type="button"])');
        if (submitBtn) {
          submitBtn.click();
        } else {
          form.dispatchEvent(new Event('submit', {
            bubbles: true,
            cancelable: true
          }));
        }
      };
    }

    /**
     * SmartScroll Module
     *
     * Voice-controlled scrolling to named page sections.
     * Utility classes: ai-scroll-target, ai-scroll-voice, ai-scroll-smooth
     */


    // ─── Direction shortcuts ──────────────────────────────────────────────────────

    const DIRECTION_MAP = {
      up: () => window.scrollBy({
        top: -window.innerHeight * 0.7,
        behavior: 'smooth'
      }),
      down: () => window.scrollBy({
        top: window.innerHeight * 0.7,
        behavior: 'smooth'
      }),
      top: () => window.scrollTo({
        top: 0,
        behavior: 'smooth'
      }),
      bottom: () => window.scrollTo({
        top: document.body.scrollHeight,
        behavior: 'smooth'
      })
    };

    /**
     * Collect all candidate scroll targets from the DOM, combining SDK-registered
     * elements with semantic section/landmark elements.
     * @param {import('../core/dom-analyzer.js').DOMAnalyzer} domAnalyzer
     * @returns {{ el: Element, label: string }[]}
     */
    function collectTargets(domAnalyzer) {
      const seen = new Set();
      const targets = [];
      const addEl = el => {
        if (seen.has(el)) return;
        seen.add(el);
        const label = (el.getAttribute('aria-label') || el.getAttribute('data-ai-label') || el.getAttribute('id') || el.querySelector('h1,h2,h3,h4,h5,h6')?.textContent?.trim() || el.textContent?.trim().slice(0, 60) || '').toLowerCase();
        if (label) targets.push({
          el,
          label
        });
      };

      // SDK-registered scroll targets first
      domAnalyzer.byCategory('scroll').forEach(e => addEl(e.el));

      // Semantic fallbacks
      document.querySelectorAll('section, article, main, header, footer, nav, [id]').forEach(addEl);
      return targets;
    }

    /**
     * Returns the SmartScroll handler function for AutomationProcessor.
     * @returns {Function}
     */
    function createSmartScrollHandler() {
      /**
       * @param {{ action: string, target: string|null }} intent
       * @param {import('../core/dom-analyzer.js').DOMAnalyzer} domAnalyzer
       */
      return async function smartScrollHandler(intent, domAnalyzer) {
        const target = (intent.target || '').trim().toLowerCase();
        if (!target) {
          throw new AISDKError('No scroll target specified.', ErrorCodes.ELEMENT_NOT_FOUND);
        }

        // Direction shortcuts
        if (DIRECTION_MAP[target]) {
          DIRECTION_MAP[target]();
          return;
        }
        const candidates = collectTargets(domAnalyzer);
        if (!candidates.length) {
          throw new AISDKError('No scroll targets found on the page.', ErrorCodes.ELEMENT_NOT_FOUND);
        }
        const match = bestMatch(target, candidates, c => c.label, 0.3);
        if (!match) {
          throw new AISDKError(`Could not find a section matching "${target}".`, ErrorCodes.ELEMENT_NOT_FOUND);
        }
        scrollToElement(match.el);
      };
    }

    /**
     * Scroll the viewport to bring an element into view.
     * Highlights it briefly for visual confirmation.
     * @param {Element} el
     */
    function scrollToElement(el) {
      el.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });

      // Brief highlight ring
      const prev = el.style.outline;
      const prevTrans = el.style.transition;
      el.style.transition = 'outline 0.2s ease';
      el.style.outline = '3px solid rgba(99, 102, 241, 0.7)';
      setTimeout(() => {
        el.style.outline = prev;
        el.style.transition = prevTrans;
      }, 1500);
    }

    /**
     * SearchAutomation Module
     *
     * Voice-powered search query population and submission.
     * Utility classes: ai-search-voice, ai-search-auto, ai-results-nav
     */


    /**
     * Find the best search input on the page.
     * Priority: SDK-registered > type="search" > name/id hints > first text input.
     * @param {import('../core/dom-analyzer.js').DOMAnalyzer} domAnalyzer
     * @returns {HTMLInputElement | null}
     */
    function findSearchInput(domAnalyzer) {
      // SDK registered
      const searchEntries = domAnalyzer.byCategory('search');
      const sdkInput = searchEntries.find(e => ['INPUT', 'TEXTAREA'].includes(e.el.tagName));
      if (sdkInput) return sdkInput.el;

      // type="search"
      const typeSearch = document.querySelector('input[type="search"]');
      if (typeSearch) return typeSearch;

      // Name / id / placeholder hints
      const hinted = document.querySelector('input[name*="search"], input[name*="query"], input[name*="q"],' + 'input[id*="search"], input[id*="query"],' + 'input[placeholder*="search" i], input[placeholder*="find" i]');
      if (hinted) return hinted;

      // Fallback: role="search" container's first input
      const searchRole = document.querySelector('[role="search"] input');
      if (searchRole) return searchRole;
      return null;
    }

    /**
     * Returns the search handler for AutomationProcessor.
     * @returns {Function}
     */
    function createSearchHandler() {
      /**
       * @param {{ action: string, value: string|null }} intent
       * @param {import('../core/dom-analyzer.js').DOMAnalyzer} domAnalyzer
       */
      return async function searchHandler(intent, domAnalyzer) {
        const query = (intent.value || '').trim();
        if (!query) {
          throw new AISDKError('No search query provided.', ErrorCodes.ELEMENT_NOT_FOUND);
        }
        const input = findSearchInput(domAnalyzer);
        if (!input) {
          throw new AISDKError('No search input found on the page.', ErrorCodes.ELEMENT_NOT_FOUND);
        }
        input.focus();
        await sleep(80);
        dispatchNativeEvent(input, query);

        // Visual feedback
        input.style.transition = 'box-shadow 0.3s ease';
        input.style.boxShadow = '0 0 0 3px rgba(99, 102, 241, 0.5)';
        setTimeout(() => {
          input.style.boxShadow = '';
        }, 1200);

        // Auto-submit if the element has ai-search-auto class
        const autoSubmit = input.classList.contains('ai-search-auto') || input.closest('[class*="ai-search-auto"]');
        if (autoSubmit || intent.action === 'search.auto') {
          await sleep(150);
          submitSearch(input);
        }
      };
    }

    /**
     * Submit a search — tries form submission, then Enter key event.
     * @param {HTMLInputElement} input
     */
    function submitSearch(input) {
      const form = input.closest('form');
      if (form) {
        form.dispatchEvent(new Event('submit', {
          bubbles: true,
          cancelable: true
        }));
        return;
      }
      // Synthesise Enter keypress
      ['keydown', 'keypress', 'keyup'].forEach(type => {
        input.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          bubbles: true,
          cancelable: true
        }));
      });
    }

    /**
     * WebNavigation Module
     *
     * Voice-controlled link clicking, menu interaction, and browser history.
     * Utility classes: ai-nav-voice, ai-link-clickable, ai-menu-voice, ai-clickable-voice
     */


    /**
     * Collect all voice-clickable elements, combining SDK registry and page links/buttons.
     * @param {import('../core/dom-analyzer.js').DOMAnalyzer} domAnalyzer
     * @returns {{ el: Element, label: string }[]}
     */
    function collectClickTargets(domAnalyzer) {
      const seen = new Set();
      const targets = [];
      const addEl = el => {
        if (seen.has(el)) return;
        seen.add(el);
        const label = (el.getAttribute('aria-label') || el.getAttribute('data-ai-label') || el.getAttribute('title') || el.textContent?.trim().slice(0, 80) || '').toLowerCase().trim();
        if (label) targets.push({
          el,
          label
        });
      };

      // SDK-registered nav elements first
      domAnalyzer.byCategory('nav').forEach(e => addEl(e.el));

      // All links and buttons
      document.querySelectorAll('a[href], button, [role="button"], [role="link"], input[type="button"], input[type="submit"]').forEach(addEl);
      return targets;
    }

    /**
     * Returns the navigation click handler.
     * @returns {Function}
     */
    function createNavClickHandler() {
      /**
       * @param {{ action: string, target: string|null }} intent
       * @param {import('../core/dom-analyzer.js').DOMAnalyzer} domAnalyzer
       */
      return async function navClickHandler(intent, domAnalyzer) {
        const target = (intent.target || '').trim().toLowerCase();
        if (!target) {
          throw new AISDKError('No click target specified.', ErrorCodes.ELEMENT_NOT_FOUND);
        }
        const candidates = collectClickTargets(domAnalyzer);
        if (!candidates.length) {
          throw new AISDKError('No clickable elements found.', ErrorCodes.ELEMENT_NOT_FOUND);
        }
        const match = bestMatch(target, candidates, c => c.label, 0.3);
        if (!match) {
          throw new AISDKError(`Could not find a clickable element matching "${target}".`, ErrorCodes.ELEMENT_NOT_FOUND);
        }
        clickElement(match.el);
      };
    }

    /**
     * Returns the history navigation handler (back/forward).
     * @returns {Function}
     */
    function createNavHistoryHandler() {
      return async function navHistoryHandler(intent) {
        const dir = (intent.target || '').toLowerCase();
        if (dir === 'back') {
          window.history.back();
        } else if (dir === 'forward') {
          window.history.forward();
        } else {
          throw new AISDKError(`Unknown history direction: "${dir}".`, ErrorCodes.ELEMENT_NOT_FOUND);
        }
      };
    }

    /**
     * Programmatically click an element with visual feedback.
     * @param {Element} el
     */
    function clickElement(el) {
      // Scroll into view first
      el.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest'
      });

      // Brief highlight
      const prev = el.style.outline;
      el.style.outline = '3px solid rgba(99, 102, 241, 0.8)';
      el.style.borderRadius = el.style.borderRadius || '4px';
      setTimeout(() => {
        el.style.outline = prev;
        el.click();
      }, 300);
    }

    /**
     * Utility Classes Registry
     *
     * Single source of truth for all SDK utility class names,
     * their categories, and metadata describing what they enable.
     */

    /** @typedef {{ name: string, category: string, description: string, action: string }} UtilityClassDef */

    /** @type {UtilityClassDef[]} */
    const UTILITY_CLASSES = [
    // ── Voice activation ────────────────────────────────────────────────────────
    {
      name: 'ai-voice-activate',
      category: 'voice',
      action: 'voice.activate',
      description: 'Enables voice control for this element.'
    }, {
      name: 'ai-voice-continuous',
      category: 'voice',
      action: 'voice.continuous',
      description: 'Enables continuous listening mode on this element.'
    }, {
      name: 'ai-voice-push-talk',
      category: 'voice',
      action: 'voice.push-talk',
      description: 'Enables push-to-talk activation on this element.'
    },
    // ── Form autofill ───────────────────────────────────────────────────────────
    {
      name: 'ai-autofill',
      category: 'form',
      action: 'form.fill',
      description: 'Enable smart voice form filling for this field/form.'
    }, {
      name: 'ai-autofill-personal',
      category: 'form',
      action: 'form.fill.personal',
      description: 'Autofill personal info (name, phone, email).'
    }, {
      name: 'ai-autofill-address',
      category: 'form',
      action: 'form.fill.address',
      description: 'Autofill address fields.'
    }, {
      name: 'ai-autofill-payment',
      category: 'form',
      action: 'form.fill.payment',
      description: 'Autofill payment information fields.'
    }, {
      name: 'ai-form-voice',
      category: 'form',
      action: 'form.voice',
      description: 'Voice-controlled multi-step form.'
    }, {
      name: 'ai-field-smart',
      category: 'form',
      action: 'form.field.smart',
      description: 'Smart field detection — auto-detects field type from context.'
    },
    // ── Smart scroll ────────────────────────────────────────────────────────────
    {
      name: 'ai-scroll-target',
      category: 'scroll',
      action: 'scroll.to',
      description: 'Marks this element as a voice-scrollable target.'
    }, {
      name: 'ai-scroll-voice',
      category: 'scroll',
      action: 'scroll.voice',
      description: 'Enables global voice-scroll commands on this section.'
    }, {
      name: 'ai-scroll-smooth',
      category: 'scroll',
      action: 'scroll.smooth',
      description: 'Applies smooth scroll animation.'
    },
    // ── Search automation ───────────────────────────────────────────────────────
    {
      name: 'ai-search-voice',
      category: 'search',
      action: 'search.query',
      description: 'Voice-enabled search input.'
    }, {
      name: 'ai-search-auto',
      category: 'search',
      action: 'search.auto',
      description: 'Auto-submits search after voice input.'
    }, {
      name: 'ai-results-nav',
      category: 'search',
      action: 'search.results.nav',
      description: 'Voice navigation of search results list.'
    },
    // ── Web navigation ──────────────────────────────────────────────────────────
    {
      name: 'ai-nav-voice',
      category: 'nav',
      action: 'nav.voice',
      description: 'Voice-enabled navigation element.'
    }, {
      name: 'ai-link-clickable',
      category: 'nav',
      action: 'nav.click',
      description: 'Voice-clickable link.'
    }, {
      name: 'ai-menu-voice',
      category: 'nav',
      action: 'nav.menu',
      description: 'Voice-controlled menu.'
    }, {
      name: 'ai-clickable-voice',
      category: 'nav',
      action: 'nav.click',
      description: 'Voice-clickable button or element.'
    }];

    /** Map of class name → definition for O(1) lookup */
    const UTILITY_CLASS_MAP = Object.fromEntries(UTILITY_CLASSES.map(u => [u.name, u]));

    /** Returns the definition for a given class name, or null. */
    function getClassDef(className) {
      return UTILITY_CLASS_MAP[className] || null;
    }

    /**
     * AI Automation SDK — Main Entry Point
     *
     * Usage (CDN):
     *   <script src="dist/ai-automation.umd.js"></script>
     *   <script>AI.init();</script>
     *
     * Usage (ESM):
     *   import { AIAutomationSDK } from '@ai-automation/sdk';
     *   const sdk = new AIAutomationSDK({ debug: true });
     *   sdk.init();
     *
     * Utility classes work automatically after init():
     *   <input class="ai-autofill" name="email" placeholder="Email">
     *   <section class="ai-scroll-target" id="features">...</section>
     */


    // ─── AIAutomationSDK ──────────────────────────────────────────────────────────

    class AIAutomationSDK extends EventTarget {
      /**
       * @param {{
       *   mode?: 'continuous' | 'push-to-talk',
       *   language?: string,
       *   debug?: boolean,
       *   toast?: boolean,
       *   onCommand?: (intent: object) => void,
       *   onSuccess?: (intent: object) => void,
       *   onError?: (error: Error, intent: object) => void,
       * }} options
       */
      constructor(options = {}) {
        super();
        this.options = {
          mode: 'push-to-talk',
          language: 'en-US',
          debug: false,
          toast: true,
          ...options
        };
        this._voice = new VoiceEngine({
          mode: this.options.mode,
          language: this.options.language,
          debug: this.options.debug
        });
        this._dom = new DOMAnalyzer();
        this._processor = new AutomationProcessor({
          debug: this.options.debug
        });
        this._initialized = false;
      }

      // ── Lifecycle ───────────────────────────────────────────────────────────────

      /**
       * Initialise the SDK: scan DOM, register handlers, wire up events.
       * Call this once the DOM is ready.
       */
      init() {
        if (this._initialized) return this;
        this._initialized = true;

        // 1. Scan DOM
        this._dom.init();

        // 2. Register module handlers
        this._processor.register(['form.fill', 'form.fill.personal', 'form.fill.address', 'form.fill.payment', 'form.voice', 'form.field.smart'], createFormAutofillHandler());
        this._processor.register(['form.submit'], createFormSubmitHandler());
        this._processor.register(['scroll.to', 'scroll.voice'], createSmartScrollHandler());
        this._processor.register(['search.query', 'search.auto'], createSearchHandler());
        this._processor.register(['nav.click', 'nav.voice', 'nav.menu'], createNavClickHandler());
        this._processor.register(['nav.history'], createNavHistoryHandler());

        // 3. Wire voice → processor
        this._voice.addEventListener('command', e => {
          const {
            intent
          } = e.detail;
          if (this.options.onCommand) this.options.onCommand(intent);
          this.dispatchEvent(new CustomEvent('command', {
            detail: e.detail
          }));
          this._processor.process(intent, this._dom);
        });

        // 4. Processor feedback → callbacks & toasts
        this._processor.addEventListener('success', e => {
          const {
            intent
          } = e.detail;
          if (this.options.onSuccess) this.options.onSuccess(intent);
          this.dispatchEvent(new CustomEvent('success', {
            detail: e.detail
          }));
          if (this.options.toast) {
            showToast(`✅ Done: ${intent.raw}`, 'info');
          }
        });
        this._processor.addEventListener('error', e => {
          const {
            error,
            intent
          } = e.detail;
          if (this.options.onError) this.options.onError(error, intent);
          this.dispatchEvent(new CustomEvent('error', {
            detail: e.detail
          }));
          if (this.options.toast) {
            showToast(`⚠️ ${error.message}`, 'warn');
          }
        });
        this._processor.addEventListener('stop-voice', () => this._voice.stop());

        // 5. Voice state events
        this._voice.addEventListener('start', () => this.dispatchEvent(new CustomEvent('listening-start')));
        this._voice.addEventListener('end', () => this.dispatchEvent(new CustomEvent('listening-end')));
        this._voice.addEventListener('error', e => {
          this.dispatchEvent(new CustomEvent('voice-error', {
            detail: e.detail
          }));
          if (this.options.toast) showToast(e.detail?.error?.message || 'Voice error', 'warn');
        });
        this._log('info', 'AI Automation SDK initialised.');
        return this;
      }

      // ── Voice control ───────────────────────────────────────────────────────────

      /** Start listening for voice commands. Returns a Promise. */
      startListening() {
        return this._voice.start();
      }

      /** Stop listening. */
      stopListening() {
        this._voice.stop();
      }

      /** Toggle listening state. */
      toggleListening() {
        this._voice.toggle();
      }

      /** Whether the SDK is currently listening. @type {boolean} */
      get isListening() {
        return this._voice.isListening;
      }

      /** Whether the browser supports the Web Speech API. @type {boolean} */
      get isVoiceSupported() {
        return this._voice.isSupported;
      }

      // ── DOM management ──────────────────────────────────────────────────────────

      /** Force a re-scan of the DOM (useful after large dynamic updates). */
      refreshDOM() {
        this._dom.refresh();
        return this;
      }

      /** Get the live registry of all SDK-managed elements. */
      getRegistry() {
        return this._dom.all;
      }

      // ── Programmatic command execution (no voice needed) ────────────────────────

      /**
       * Execute a plain-text command programmatically.
       * @param {string} commandText  e.g. "fill email user@example.com"
       * @returns {Promise<void>}
       */
      async execute(commandText) {
        const {
          parseIntent
        } = await Promise.resolve().then(function () { return voiceEngine; });
        const intent = parseIntent(commandText);
        return this._processor.process(intent, this._dom);
      }

      // ── Teardown ────────────────────────────────────────────────────────────────

      /** Destroy the SDK instance, removing all observers and listeners. */
      destroy() {
        this._voice.stop();
        this._dom.destroy();
        this._initialized = false;
      }
      _log(level, ...args) {
        if (this.options.debug) console[level]('[AI SDK]', ...args);
      }
    }

    // ─── Auto-init support ────────────────────────────────────────────────────────

    let _defaultInstance = null;

    /**
     * Convenience factory — creates and initialises a default SDK instance.
     * @param {object} [options]
     * @returns {AIAutomationSDK}
     */
    function init(options = {}) {
      _defaultInstance = new AIAutomationSDK(options).init();
      return _defaultInstance;
    }

    /** Returns the default instance created by init(). */
    function getInstance() {
      return _defaultInstance;
    }

    // Auto-init: if data-ai-auto-init is NOT explicitly "false", init on DOMContentLoaded
    if (typeof document !== 'undefined') {
      const autoInit = () => {
        const script = document.currentScript || document.querySelector('script[data-ai-auto-init]');
        if (script && script.dataset.aiAutoInit === 'false') return;
        // Only if there are any ai-* classed elements on the page
        if (document.querySelector('[class*="ai-"]')) {
          _defaultInstance = new AIAutomationSDK({
            toast: true
          }).init();
        }
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInit);
      } else {
        autoInit();
      }
    }

    exports.AIAutomationSDK = AIAutomationSDK;
    exports.AISDKError = AISDKError;
    exports.AutomationProcessor = AutomationProcessor;
    exports.DOMAnalyzer = DOMAnalyzer;
    exports.ErrorCodes = ErrorCodes;
    exports.UTILITY_CLASSES = UTILITY_CLASSES;
    exports.VoiceEngine = VoiceEngine;
    exports.bestMatch = bestMatch;
    exports.createFormAutofillHandler = createFormAutofillHandler;
    exports.createNavClickHandler = createNavClickHandler;
    exports.createNavHistoryHandler = createNavHistoryHandler;
    exports.createSearchHandler = createSearchHandler;
    exports.createSmartScrollHandler = createSmartScrollHandler;
    exports.fillField = fillField;
    exports.fuzzyScore = fuzzyScore;
    exports.getClassDef = getClassDef;
    exports.getInstance = getInstance;
    exports.init = init;
    exports.levenshtein = levenshtein;
    exports.scrollToElement = scrollToElement;

}));
//# sourceMappingURL=ai-automation.umd.js.map
