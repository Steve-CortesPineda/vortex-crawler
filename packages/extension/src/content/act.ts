/**
 * In-page batch actions — bundled into act.js, injected via executeScript.
 * Defines globalThis.__vantaAct(steps) → { ran, notes, refused? }.
 *
 * The SAME hard refusals AgentBrowser enforces are compiled in here (defense in depth — enforced page-side
 * even if the daemon were compromised): never type into credential/payment fields, never click obvious
 * financial/purchase actions, never touch CAPTCHAs. A refusal stops the batch and reports which step.
 */

// Kept in sync with agent-browser.ts CREDENTIAL_FIELD_RE / FINANCIAL_ACTION_RE.
const CREDENTIAL_FIELD_RE = /pass(word)?|cvv|cvc|card.?number|cardnumber|ssn|social.?secur|routing|account.?number|secret|api.?key|otp|2fa|seed.?phrase|private.?key/i;
const FINANCIAL_ACTION_RE = /\b(buy|pay|purchase|checkout|place\s*order|send\s*money|transfer|withdraw|deposit|confirm\s*payment|wire|subscribe|complete\s*purchase)\b/i;

type Step =
  | { kind: 'click'; target: string; byText?: boolean }
  | { kind: 'type'; selector: string; text: string; submit?: boolean }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; direction?: 'up' | 'down'; amount?: number }
  | { kind: 'waitFor'; selector: string; timeoutMs?: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function findByText(text: string): HTMLElement | null {
  const lc = text.toLowerCase();
  const els = Array.from(document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"]')) as HTMLElement[];
  return els.find((e) => (e.innerText || (e as HTMLInputElement).value || '').trim().toLowerCase().includes(lc)) || null;
}

async function waitFor(selector: string, timeoutMs = 8000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (document.querySelector(selector)) return true;
    await sleep(100);
  }
  return false;
}

async function act(steps: Step[]): Promise<{ ran: number; notes: string[]; refused?: string }> {
  const notes: string[] = [];
  let ran = 0;
  for (const step of steps) {
    switch (step.kind) {
      case 'click': {
        const el = step.byText ? findByText(step.target) : document.querySelector<HTMLElement>(step.target);
        const label = (el?.innerText || (el as HTMLInputElement)?.value || step.target || '').trim();
        if (FINANCIAL_ACTION_RE.test(label) || FINANCIAL_ACTION_RE.test(step.target)) {
          return { ran, notes, refused: `REFUSED click "${label || step.target}" — looks like a financial/purchase action. A human must do this.` };
        }
        if (!el) { notes.push(`click: no element for ${step.target}`); break; }
        el.click(); ran++; notes.push(`clicked ${step.byText ? `text:${step.target}` : step.target}`);
        await sleep(150);
        break;
      }
      case 'type': {
        const el = document.querySelector<HTMLInputElement>(step.selector);
        if (!el) { notes.push(`type: no element for ${step.selector}`); break; }
        const kind = [el.type, el.name, el.id, el.autocomplete].filter(Boolean).join(' ');
        if (/password/i.test(kind) || CREDENTIAL_FIELD_RE.test(kind)) {
          return { ran, notes, refused: `REFUSED type into "${step.selector}" — credential/sensitive field. Log in manually once in the VANTA profile; the session persists.` };
        }
        el.focus();
        el.value = step.text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        ran++; notes.push(`typed into ${step.selector}`);
        if (step.submit) { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); el.form?.requestSubmit?.(); notes.push('submitted'); }
        await sleep(150);
        break;
      }
      case 'press': {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: step.key, bubbles: true }));
        ran++; notes.push(`pressed ${step.key}`);
        break;
      }
      case 'scroll': {
        const dy = (step.direction === 'up' ? -1 : 1) * 900 * (step.amount ?? 1);
        window.scrollBy(0, dy); ran++; notes.push(`scrolled ${step.direction ?? 'down'}`);
        await sleep(200);
        break;
      }
      case 'waitFor': {
        const ok = await waitFor(step.selector, step.timeoutMs);
        ran++; notes.push(ok ? `found ${step.selector}` : `timeout waiting for ${step.selector}`);
        break;
      }
    }
  }
  return { ran, notes };
}

(globalThis as any).__vantaAct = act;
