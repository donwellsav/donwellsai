import {
  DESIGN_CAPTURE_BUDGET,
  DESIGN_CAPTURE_STYLE_NAMES,
  clampDesignCapture,
  type DesignCapture,
  type DesignCaptureScreenshot
} from '@shared/design-capture'

export type DesignCaptureImage = {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  toDataURL(): string
}

export type DesignCaptureWebview = {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<DesignCaptureImage>
}

/** Cancels the pending guest promise, removes listeners, and restores the page cursor. */
export const DESIGN_CAPTURE_CANCEL_SCRIPT = `(() => {
  const session = window.__donwellsDesignCapture;
  if (!session || typeof session.cancel !== 'function') return false;
  session.cancel();
  return true;
})()`

/**
 * Runs inside the untrusted top-level guest only. Cross-origin frame documents are never queried.
 * It installs a closed-shadow overlay and resolves once a safe, bounded element is selected.
 */
export const DESIGN_CAPTURE_BEGIN_SCRIPT = `(() => {
  if (window.__donwellsDesignCapture && typeof window.__donwellsDesignCapture.cancel === 'function') {
    window.__donwellsDesignCapture.cancel();
  }

  const { promise, resolve } = Promise.withResolvers();
    const FORBIDDEN_TAGS = {
      BODY: true, EMBED: true, FORM: true, HEAD: true, HTML: true, IFRAME: true,
      INPUT: true, NOSCRIPT: true, OBJECT: true, OPTION: true, SCRIPT: true,
      SELECT: true, STYLE: true, TEXTAREA: true
    };
    const ROLE_BY_TAG = {
      A: 'link', BUTTON: 'button', IMG: 'img', NAV: 'navigation', MAIN: 'main',
      HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary', ARTICLE: 'article',
      SECTION: 'region', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading',
      H5: 'heading', H6: 'heading', UL: 'list', OL: 'list', LI: 'listitem', TABLE: 'table'
    };
    const SAFE_ATTRIBUTES = {
      id: true, class: true, role: true, href: true, src: true, alt: true, title: true,
      'aria-label': true, 'aria-labelledby': true, 'aria-describedby': true,
      'aria-expanded': true, 'aria-pressed': true, 'aria-selected': true, 'aria-current': true
    };
    const STYLE_NAMES = [
      'display', 'position', 'width', 'height', 'margin', 'padding', 'gap', 'color',
      'backgroundColor', 'border', 'borderRadius', 'boxShadow', 'fontFamily', 'fontSize',
      'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign', 'opacity', 'zIndex'
    ];
    const MAX_DESCENDANTS = 240;
    const MAX_DOM_NODES = 36;
    const MAX_DOM_DEPTH = 4;
    const MAX_DOM_CHARS = 3600;
    const MAX_TEXT_CHARS = 600;
    const priorCursor = document.documentElement.style.getPropertyValue('cursor');
    const priorCursorPriority = document.documentElement.style.getPropertyPriority('cursor');
    let hovered = null;
    let animationFrame = 0;
    let settled = false;

    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = [
      ':host{all:initial}',
      '.box{position:fixed;display:none;box-sizing:border-box;border:2px solid #7c83ff;',
      'background:rgba(124,131,255,.12);box-shadow:0 0 0 1px rgba(6,8,14,.5),0 8px 28px rgba(6,8,14,.18)}',
      '.box.blocked{border-color:#e76060;background:rgba(231,96,96,.12)}',
      '.label{position:absolute;left:-2px;bottom:calc(100% + 6px);max-width:min(520px,90vw);',
      'overflow:hidden;padding:5px 8px;border-radius:5px;background:#11141d;color:#f6f7fb;',
      'font:600 11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;text-overflow:ellipsis;',
      'box-shadow:0 6px 18px rgba(6,8,14,.28)}',
      '.hint{position:fixed;top:12px;left:50%;transform:translateX(-50%);padding:7px 11px;',
      'border:1px solid rgba(255,255,255,.16);border-radius:7px;background:#11141d;color:#f6f7fb;',
      'font:600 11px/1.35 ui-sans-serif,system-ui,sans-serif;box-shadow:0 8px 28px rgba(6,8,14,.24)}',
      '@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}'
    ].join('');
    const box = document.createElement('div');
    box.className = 'box';
    const label = document.createElement('div');
    label.className = 'label';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Design Mode · Select an element · Esc to cancel';
    box.append(label);
    shadow.append(style, box, hint);
    (document.documentElement || document.body).append(host);
    document.documentElement.style.setProperty('cursor', 'crosshair', 'important');

    const cleanText = (value, max) => {
      const withoutControls = String(value || '').replace(/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]/g, '');
      const redacted = withoutControls
        .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]')
        .replace(/\\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|authorization|cookie|session(?:id|[_-]?token)?|private[_-]?key)\\s*[:=]\\s*)("[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;]+)/gi, '$1[redacted]')
        .replace(/\\b(?:sk-(?:live|test|proj)?-?[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,})\\b/g, '[redacted token]');
      if (redacted.length <= max) return redacted;
      return redacted.slice(0, Math.max(0, max - 14)).trimEnd() + '… [truncated]';
    };

    const safeUrl = (value) => {
      try {
        const url = new URL(String(value || ''), document.baseURI);
        if (!['http:', 'https:', 'file:'].includes(url.protocol)) return '';
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
      } catch {
        return '';
      }
    };

    const escapeHtml = (value) => String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const blockedReason = (element) => {
      if (!(element instanceof Element)) return 'Select a rendered element';
      if (FORBIDDEN_TAGS[element.tagName]) return 'This element is excluded';
      let ancestor = element;
      while (ancestor) {
        if (ancestor instanceof HTMLElement && ancestor.isContentEditable) return 'Editable content is excluded';
        ancestor = ancestor.parentElement;
      }
      if (element.matches('input, textarea, select, option, [contenteditable]')) return 'Editable content is excluded';
      if (element.querySelector('input[type="password"], [contenteditable]:not([contenteditable="false"])')) {
        return 'Sensitive or editable content is excluded';
      }
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT);
      let descendants = 0;
      while (walker.nextNode()) {
        descendants += 1;
        if (descendants > MAX_DESCENDANTS) return 'Select a more specific component';
      }
      if ((element.textContent || '').length > 8000) return 'Select a more specific component';
      return '';
    };

    const selectorFor = (element) => {
      const parts = [];
      let current = element;
      while (current && current !== document.documentElement && parts.length < 6) {
        let part = current.tagName.toLowerCase();
        const id = cleanText(current.getAttribute('id') || '', 100);
        if (id && id.indexOf('[redacted') === -1) {
          const escapedId = window.CSS && typeof window.CSS.escape === 'function' ? window.CSS.escape(id) : id.replace(/[^A-Za-z0-9_-]/g, '\\$&');
          parts.unshift('#' + escapedId);
          break;
        }
        const classes = Array.from(current.classList)
          .filter((name) => /^[A-Za-z_-][A-Za-z0-9_-]{0,39}$/.test(name) && cleanText(name, 80).indexOf('[redacted') === -1)
          .slice(0, 2);
        if (classes.length) part += '.' + classes.join('.');
        const parent = current.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
          if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(current) + 1) + ')';
        }
        parts.unshift(part);
        current = parent;
      }
      return cleanText(parts.join(' > '), 700);
    };

    const serialize = (element) => {
      const state = { nodes: 0, chars: 0, truncated: false };
      const append = (chunk) => {
        if (state.chars >= MAX_DOM_CHARS) {
          state.truncated = true;
          return '';
        }
        const room = MAX_DOM_CHARS - state.chars;
        const bounded = chunk.length <= room ? chunk : chunk.slice(0, room);
        state.chars += bounded.length;
        if (bounded.length < chunk.length) state.truncated = true;
        return bounded;
      };
      const visit = (node, depth) => {
        if (state.nodes >= MAX_DOM_NODES || depth > MAX_DOM_DEPTH) {
          state.truncated = true;
          return '';
        }
        if (node.nodeType === Node.TEXT_NODE) {
          const text = cleanText((node.textContent || '').replace(/\\s+/g, ' ').trim(), 240);
          return text ? append(escapeHtml(text)) : '';
        }
        if (!(node instanceof Element) || FORBIDDEN_TAGS[node.tagName]) return '';
        if (node instanceof HTMLElement && node.isContentEditable) return '';
        state.nodes += 1;
        const tag = /^[a-z][a-z0-9-]*$/.test(node.tagName.toLowerCase()) ? node.tagName.toLowerCase() : 'div';
        const attributes = [];
        for (const attribute of Array.from(node.attributes)) {
          const name = attribute.name.toLowerCase();
          if (!SAFE_ATTRIBUTES[name]) continue;
          let value = cleanText(attribute.value, name === 'class' ? 180 : 300);
          if ((name === 'href' || name === 'src') && value) value = safeUrl(value);
          if (value) attributes.push(' ' + name + '="' + escapeHtml(value) + '"');
        }
        let output = append('<' + tag + attributes.join('') + '>');
        for (const child of Array.from(node.childNodes)) {
          output += visit(child, depth + 1);
          if (state.truncated) break;
        }
        output += append('</' + tag + '>');
        return output;
      };
      let result = visit(element, 0);
      if (state.truncated) result += '<!-- truncated -->';
      return cleanText(result, MAX_DOM_CHARS);
    };

    const targetFromEvent = (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      for (const candidate of path) {
        if (candidate instanceof Element && candidate !== host) return candidate;
      }
      return event.target instanceof Element ? event.target : null;
    };

    const showHover = (element) => {
      if (!(element instanceof Element)) {
        box.style.display = 'none';
        hovered = null;
        return;
      }
      hovered = element;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        box.style.display = 'none';
        return;
      }
      const reason = blockedReason(element);
      box.className = reason ? 'box blocked' : 'box';
      box.style.display = 'block';
      box.style.left = Math.max(0, rect.left) + 'px';
      box.style.top = Math.max(0, rect.top) + 'px';
      box.style.width = Math.max(1, Math.min(window.innerWidth - Math.max(0, rect.left), rect.width)) + 'px';
      box.style.height = Math.max(1, Math.min(window.innerHeight - Math.max(0, rect.top), rect.height)) + 'px';
      label.textContent = reason ? reason : '<' + element.tagName.toLowerCase() + '> · ' + selectorFor(element);
    };

    const onPointerMove = (event) => {
      const target = targetFromEvent(event);
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        animationFrame = 0;
        showHover(target);
      });
    };

    const blockPageAction = (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const target = targetFromEvent(event);
      if (target) showHover(target);
    };

    const cleanup = () => {
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerdown', blockPageAction, true);
      document.removeEventListener('mousedown', blockPageAction, true);
      document.removeEventListener('mouseup', blockPageAction, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('contextmenu', blockPageAction, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onBlur, true);
      if (animationFrame) cancelAnimationFrame(animationFrame);
      host.remove();
      if (priorCursor) document.documentElement.style.setProperty('cursor', priorCursor, priorCursorPriority);
      else document.documentElement.style.removeProperty('cursor');
    };

    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      delete window.__donwellsDesignCapture;
      resolve(value);
    };

    const extract = (element) => {
      const rect = element.getBoundingClientRect();
      const computed = getComputedStyle(element);
      const styles = {};
      for (const name of STYLE_NAMES) styles[name] = cleanText(computed[name], 180);
      return {
        version: 1,
        url: safeUrl(location.href),
        title: cleanText(document.title, 240),
        selector: selectorFor(element),
        tag: element.tagName.toLowerCase(),
        role: cleanText(element.getAttribute('role') || ROLE_BY_TAG[element.tagName] || '', 80),
        text: cleanText(element instanceof HTMLElement ? element.innerText : element.textContent, MAX_TEXT_CHARS),
        bounds: {
          viewport: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          page: { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height }
        },
        viewport: { width: innerWidth, height: innerHeight },
        styles,
        domSnippet: serialize(element)
      };
    };

    const onClick = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const target = targetFromEvent(event) || hovered;
      const reason = target ? blockedReason(target) : 'Select a rendered element';
      if (reason) {
        if (target) showHover(target);
        return;
      }
      finish(extract(target));
    };

    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      finish(null);
    };

    const onBlur = () => {
      if (hovered && !hovered.isConnected) showHover(null);
    };

    window.__donwellsDesignCapture = { cancel: () => finish(null), host };
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerdown', blockPageAction, { capture: true, passive: false });
    document.addEventListener('mousedown', blockPageAction, { capture: true, passive: false });
    document.addEventListener('mouseup', blockPageAction, { capture: true, passive: false });
    document.addEventListener('click', onClick, { capture: true, passive: false });
    document.addEventListener('contextmenu', blockPageAction, { capture: true, passive: false });
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onBlur, true);
  return promise;
})()`

function captureHasRedactedContent(capture: DesignCapture): boolean {
  if (
    capture.title.includes('[redacted]') ||
    capture.selector.includes('[redacted]') ||
    capture.role.includes('[redacted]') ||
    capture.text.includes('[redacted]') ||
    capture.domSnippet.includes('[redacted]')
  ) {
    return true
  }
  for (const name of DESIGN_CAPTURE_STYLE_NAMES) {
    if (capture.styles[name].includes('[redacted]')) return true
  }
  return false
}
/** Captures a bounded intersection of the selected element with the visible guest viewport. */
export async function captureDesignPreview(
  webview: DesignCaptureWebview,
  capture: DesignCapture
): Promise<DesignCaptureScreenshot | null> {
  const safeCapture = clampDesignCapture(capture)
  if (!safeCapture) return null
  if (captureHasRedactedContent(safeCapture)) return null

  const bounds = safeCapture.bounds.viewport
  const left = Math.max(0, bounds.x)
  const top = Math.max(0, bounds.y)
  const right = Math.min(safeCapture.viewport.width, bounds.x + bounds.width)
  const bottom = Math.min(safeCapture.viewport.height, bounds.y + bounds.height)
  const width = Math.floor(Math.min(DESIGN_CAPTURE_BUDGET.screenshotWidth, right - left))
  const height = Math.floor(Math.min(DESIGN_CAPTURE_BUDGET.screenshotHeight, bottom - top))
  if (width < 2 || height < 2) return null

  try {
    const image = await webview.capturePage({ x: Math.floor(left), y: Math.floor(top), width, height })
    if (image.isEmpty()) return null
    const dataUrl = image.toDataURL()
    if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > DESIGN_CAPTURE_BUDGET.screenshotDataUrl) {
      return null
    }
    const size = image.getSize()
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) {
      return null
    }
    return {
      mimeType: 'image/png',
      dataUrl,
      width: size.width,
      height: size.height,
      previewOnly: true
    }
  } catch {
    // capturePage can race navigation or compositor teardown; text context remains usable.
    return null
  }
}
