/**
 * A small semantic accessibility audit, run inside the page.
 *
 * Not a replacement for axe or a screen reader. It checks the handful of rules
 * that are objective, cheap and have bitten this UI before, on the rendered
 * DOM of a real browser:
 *
 *   - every control (button, link, field) has an accessible name;
 *   - no id is used twice (aria-labelledby and label[for] depend on it);
 *   - one h1, and heading levels never skip on the way down;
 *   - no positive tabindex (it reorders the page for keyboard users);
 *   - nothing focusable inside aria-hidden (focus would land somewhere silent);
 *   - no interactive element nested inside another;
 *   - every image has alt text (possibly empty).
 *
 * xterm.js's own DOM is excluded except for its input, which must be named.
 */
import type { Page } from '@playwright/test';

export async function auditPage(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const visible = (el: Element) => {
      const box = (el as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && (box.width > 0 || box.height > 0 || el.classList.contains('visually-hidden'));
    };
    const inTerminal = (el: Element) => el.closest('.terminal-surface') !== null && !el.matches('textarea');
    const describe = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`;

    const textOf = (el: Element): string => {
      let text = '';
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? '';
        else if (node instanceof Element && node.getAttribute('aria-hidden') !== 'true') {
          text += node.matches('img') ? (node.getAttribute('alt') ?? '') : textOf(node);
        }
      }
      return text;
    };
    const nameOf = (el: Element): string => {
      const labelledby = el.getAttribute('aria-labelledby');
      if (labelledby) {
        return labelledby
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .trim();
      }
      const label = el.getAttribute('aria-label');
      if (label?.trim()) return label.trim();
      if (el.matches('input, select, textarea')) {
        const id = el.getAttribute('id');
        const forLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        const wrapping = el.closest('label');
        return (forLabel?.textContent ?? wrapping?.textContent ?? el.getAttribute('title') ?? '').trim();
      }
      return (textOf(el) || el.getAttribute('title') || '').trim();
    };

    const controls = document.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"]');
    for (const el of controls) {
      if (inTerminal(el) || !visible(el)) continue;
      if (!nameOf(el)) problems.push(`no accessible name: ${describe(el)}`);
    }

    const ids = new Map<string, number>();
    for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
    for (const [id, count] of ids) if (count > 1) problems.push(`id used ${count} times: ${id}`);

    const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(visible);
    const h1s = headings.filter((h) => h.tagName === 'H1');
    if (h1s.length !== 1) problems.push(`${h1s.length} h1 elements: ${h1s.map((h) => h.textContent?.trim()).join(' | ')}`);
    let previous = 0;
    for (const heading of headings) {
      const level = Number(heading.tagName[1]);
      if (previous && level > previous + 1) problems.push(`heading skips from h${previous} to h${level}: "${heading.textContent?.trim()}"`);
      previous = level;
    }

    for (const el of document.querySelectorAll('[tabindex]')) {
      if (Number(el.getAttribute('tabindex')) > 0) problems.push(`positive tabindex: ${describe(el)}`);
    }

    const focusable = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    for (const hidden of document.querySelectorAll('[aria-hidden="true"]')) {
      for (const el of hidden.querySelectorAll(focusable)) problems.push(`focusable inside aria-hidden: ${describe(el)}`);
      if (hidden.matches(focusable)) problems.push(`aria-hidden element is focusable: ${describe(hidden)}`);
    }

    for (const el of document.querySelectorAll('button a[href], button button, a[href] button, a[href] a[href]')) {
      problems.push(`interactive element nested in another: ${describe(el)}`);
    }

    for (const img of document.querySelectorAll('img')) {
      if (!img.hasAttribute('alt')) problems.push(`img without alt: ${img.getAttribute('src')}`);
    }

    return problems;
  });
}
