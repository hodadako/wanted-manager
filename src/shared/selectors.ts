export const JOB_LINK_PATTERNS: RegExp[] = [
  /^\/wd\/\d+/,
  /^https?:\/\/www\.wanted\.co\.kr\/wd\/\d+/,
  /\/wd\/\d+/
];

export const JOB_ID_REGEX = /^(?:https?:\/\/www\.wanted\.co\.kr)?\/wd\/(\d+)/;

export const CARD_CONTAINER_CANDIDATES = ['article', '[role="listitem"]', 'li'] as const;

export const TITLE_CANDIDATE_SELECTORS = [
  'h1',
  'h2',
  'h3',
  '[role="heading"]',
  'strong',
  'a span',
  'a'
] as const;

export const COMPANY_CANDIDATE_SELECTORS = ['p', 'span', 'small', 'strong', '[aria-label]'] as const;
export const JOB_LINK_SELECTORS = [
  'a[href^="/wd/"]',
  'a[href*="/wd/"]',
  'a[href^="https://www.wanted.co.kr/wd/"]'
] as const;

const MAX_CARD_FALLBACK_DEPTH = 8;
const MAX_JOB_LINKS_IN_CARD = 6;
const MAX_CARD_HEIGHT = 900;

function normalizeWhitespace(value: string | null | undefined): string {
  if (!value) {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim();
}

function textLengthInRange(text: string, min: number, max: number): boolean {
  return text.length >= min && text.length <= max;
}

function isMeaningfulTitle(text: string): boolean {
  return textLengthInRange(text, 4, 60);
}

function isLikelyCompany(text: string): boolean {
  return textLengthInRange(text, 2, 30);
}

function hasVisibleRect(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function isWdListPath(pathname: string): boolean {
  return pathname === '/' || pathname === '/wdlist' || pathname.startsWith('/wdlist');
}

export function isWdDetailPath(pathname: string): { matched: boolean; jobId: string | null } {
  const match = pathname.match(/^\/wd\/(\d+)$/);
  if (!match) {
    return { matched: false, jobId: null };
  }

  return { matched: true, jobId: match[1] };
}

export function normalizeJobUrl(rawHref: string | null, origin: string): string | null {
  if (!rawHref) {
    return null;
  }

  try {
    const full = new URL(rawHref, origin);
    return full.href;
  } catch {
    return null;
  }
}

export function extractJobId(urlOrPath: string | null | undefined): string | null {
  if (!urlOrPath) {
    return null;
  }

  let target = urlOrPath;
  if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
    try {
      const parsed = new URL(urlOrPath);
      target = `${parsed.origin}${parsed.pathname}`;
    } catch {
      return null;
    }
  }

  const pathOnly = target.replace(/^https?:\/\/www\.wanted\.co\.kr/, '');
  const match = pathOnly.match(JOB_ID_REGEX);
  return match ? match[1] : null;
}

function isJobHref(href: string | null): boolean {
  if (!href) {
    return false;
  }

  return JOB_LINK_PATTERNS.some((pattern) => pattern.test(href));
}

function collectFromNode(node: Node, found: Set<HTMLAnchorElement>): void {
  if (!(node instanceof Element)) {
    return;
  }

  if (node instanceof HTMLAnchorElement && isJobHref(node.getAttribute('href'))) {
    found.add(node);
  }

  const anchors = node.querySelectorAll<HTMLAnchorElement>(JOB_LINK_SELECTORS.join(','));
  anchors.forEach((anchor) => {
    if (isJobHref(anchor.getAttribute('href'))) {
      found.add(anchor);
    }
  });
}

export function collectJobAnchors(root: ParentNode | Node): HTMLAnchorElement[] {
  const found = new Set<HTMLAnchorElement>();

  collectFromNode(root as Node, found);
  if (root instanceof Document || root instanceof Element) {
    const anchors = root.querySelectorAll<HTMLAnchorElement>(JOB_LINK_SELECTORS.join(','));
    anchors.forEach((anchor) => {
      if (isJobHref(anchor.getAttribute('href'))) {
        found.add(anchor);
      }
    });
  }

  return Array.from(found);
}

function getTextCandidates(container: HTMLElement, selectors: readonly string[]): string[] {
  const values: string[] = [];

  selectors.forEach((selector) => {
    const elements = container.querySelectorAll<HTMLElement>(selector);
    elements.forEach((el) => {
      const text = normalizeWhitespace(el.textContent);
      if (text) {
        values.push(text);
      }
    });
  });

  return values;
}

export function isCardLike(el: HTMLElement): boolean {
  if (!el.isConnected || !hasVisibleRect(el)) {
    return false;
  }

  const rect = el.getBoundingClientRect();
  const sizeSignal = rect.height >= 80 && rect.width >= 120;

  const titleSignal = getTextCandidates(el, TITLE_CANDIDATE_SELECTORS).some((text) => isMeaningfulTitle(text));
  const companySignal = getTextCandidates(el, COMPANY_CANDIDATE_SELECTORS).some((text) => isLikelyCompany(text));
  const imageSignal = Boolean(el.querySelector('img, figure, [style*="background-image"]'));

  const signals = [titleSignal, companySignal, imageSignal, sizeSignal].filter(Boolean).length;
  return signals >= 2;
}

function hasReasonableCardScope(container: HTMLElement, anchor: HTMLAnchorElement): boolean {
  if (!container.contains(anchor)) {
    return false;
  }

  const rect = container.getBoundingClientRect();
  if (rect.height > MAX_CARD_HEIGHT) {
    return false;
  }

  const linkCount = container.querySelectorAll<HTMLAnchorElement>(JOB_LINK_SELECTORS.join(',')).length;
  if (linkCount < 1 || linkCount > MAX_JOB_LINKS_IN_CARD) {
    return false;
  }

  const nestedCardCount = container.querySelectorAll('article, [role="listitem"], li').length;
  if (nestedCardCount >= 3) {
    return false;
  }

  return true;
}

export function findCardContainer(anchor: HTMLAnchorElement): HTMLElement | null {
  if (!anchor.isConnected || !hasVisibleRect(anchor)) {
    return null;
  }

  for (const selector of CARD_CONTAINER_CANDIDATES) {
    const matched = anchor.closest(selector);
    if (
      matched instanceof HTMLElement &&
      isCardLike(matched) &&
      hasReasonableCardScope(matched, anchor)
    ) {
      matched.dataset.wantedCard = '1';
      return matched;
    }
  }

  let cursor: HTMLElement | null = anchor;
  let depth = 0;

  while (cursor && depth < MAX_CARD_FALLBACK_DEPTH) {
    cursor = cursor.parentElement;
    depth += 1;

    if (!cursor) {
      break;
    }

    if (cursor.tagName.toLowerCase() !== 'div') {
      continue;
    }

    if (isCardLike(cursor) && hasReasonableCardScope(cursor, anchor)) {
      cursor.dataset.wantedCard = '1';
      return cursor;
    }
  }

  return null;
}

export function extractTitle(card: HTMLElement, anchor: HTMLAnchorElement): string | null {
  let best: string | null = null;

  TITLE_CANDIDATE_SELECTORS.forEach((selector) => {
    const nodes = card.querySelectorAll<HTMLElement>(selector);
    nodes.forEach((node) => {
      const text = normalizeWhitespace(node.textContent);
      if (!isMeaningfulTitle(text)) {
        return;
      }

      if (!best || text.length > best.length) {
        best = text;
      }
    });
  });

  if (best) {
    return best;
  }

  const anchorText = normalizeWhitespace(anchor.textContent);
  if (isMeaningfulTitle(anchorText)) {
    return anchorText;
  }

  const lines = (card.textContent ?? '')
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);

  const fallback = lines.find((line) => isMeaningfulTitle(line));
  return fallback ?? null;
}

export function extractCompany(card: HTMLElement, title: string | null): string | null {
  const normalizedTitle = normalizeWhitespace(title);

  const candidates = getTextCandidates(card, COMPANY_CANDIDATE_SELECTORS)
    .filter((text) => isLikelyCompany(text))
    .filter((text) => !normalizedTitle || normalizeWhitespace(text) !== normalizedTitle);

  if (candidates.length > 0) {
    const counts = new Map<string, number>();
    candidates.forEach((entry) => {
      counts.set(entry, (counts.get(entry) ?? 0) + 1);
    });

    const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    return ranked[0][0] ?? null;
  }

  const lines = (card.textContent ?? '')
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .filter((line) => isLikelyCompany(line));

  const fallback = lines.find((line) => !normalizedTitle || line !== normalizedTitle);
  return fallback ?? null;
}
