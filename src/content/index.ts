import { matchAnyRule } from '../shared/rules';
import {
  COMPANY_LINK_SELECTORS,
  collectCompanyAnchors,
  JOB_LINK_SELECTORS,
  collectJobAnchors,
  extractCompanyFromCompanyCard,
  extractCompany,
  extractJobId,
  extractTitle,
  findCardContainer,
  findCompanyCardContainer,
  isWdDetailPath,
  isWdListPath,
  normalizeJobUrl
} from '../shared/selectors';
import { DEFAULT_SETTINGS, STORAGE_KEY, getSettings, saveSettings } from '../shared/storage';
import type {
  GetPageHiddenItemsResponse,
  GetLastHiddenCountResponse,
  HideRule,
  HiddenJobItem,
  JobCandidate,
  RuntimeRequest,
  Settings
} from '../shared/types';

declare global {
  interface Window {
    __wantedHiderHistoryPatched?: boolean;
    __wantedHiderPagePatchInjected?: boolean;
  }
}

const NAV_EVENT_NAME = 'wanted-hider:navigation';
const DETAIL_BANNER_ID = 'wanted-hider-detail-banner';
const QUICK_HIDE_BUTTON_ATTR = 'data-wanted-quick-hide-job-btn';
const QUICK_HIDE_COMPANY_BUTTON_ATTR = 'data-wanted-quick-hide-company-btn';
const QUICK_HIDE_BUTTON_GROUP_ATTR = 'data-wanted-quick-hide-group';
const QUICK_HIDE_COMPANY_BUTTON_GROUP_ATTR = 'data-wanted-quick-hide-company-group';
const QUICK_HIDE_RULE_PREFIX = 'quick-hide-';
const QUICK_HIDE_COMPANY_RULE_PREFIX = 'quick-hide-company-';

let cleanupFns: Array<() => void> = [];
let observer: MutationObserver | null = null;
const pendingNodes = new Set<Node>();
let flushScheduled = false;
let rafHandle: number | null = null;
let timerHandle: number | null = null;
let lastHiddenCount = 0;
let currentHiddenItems: HiddenJobItem[] = [];
let currentRouteKey = '';
let settingsCache: Settings = { ...DEFAULT_SETTINGS };
let routeSequence = 0;
let lastSeenPathname = location.pathname;

function debugLog(message: string, payload?: unknown): void {
  if (!settingsCache.debug) {
    return;
  }

  if (payload === undefined) {
    console.info(`[wanted-hider] ${message}`);
    return;
  }

  console.info(`[wanted-hider] ${message}`, payload);
}

function cleanupRouteMode(): void {
  cleanupFns.forEach((fn) => {
    try {
      fn();
    } catch {
      // no-op
    }
  });
  cleanupFns = [];

  if (observer) {
    observer.disconnect();
    observer = null;
  }

  pendingNodes.clear();
  flushScheduled = false;

  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }

  if (timerHandle !== null) {
    window.clearTimeout(timerHandle);
    timerHandle = null;
  }
}

function getRouteKey(): string {
  return location.pathname;
}

function shouldFilterCardsOnPath(pathname: string): boolean {
  if (isWdListPath(pathname)) {
    return true;
  }

  return isWdDetailPath(pathname).matched;
}

function maybeRestartForPathChange(trigger: string): void {
  const nextPath = getRouteKey();
  if (nextPath === lastSeenPathname) {
    return;
  }

  lastSeenPathname = nextPath;
  void restartForRoute(trigger);
}

function scheduleFlush(): void {
  if (flushScheduled) {
    return;
  }

  flushScheduled = true;

  if (typeof requestAnimationFrame === 'function') {
    rafHandle = requestAnimationFrame(() => {
      rafHandle = null;
      flushPending();
    });
    return;
  }

  timerHandle = window.setTimeout(() => {
    timerHandle = null;
    flushPending();
  }, 0);
}

function enqueueNode(node: Node): void {
  pendingNodes.add(node);
  scheduleFlush();
}

function applyAction(cardEl: HTMLElement, action: 'remove' | 'hide'): boolean {
  if (cardEl.dataset.wantedHidden === '1') {
    return false;
  }

  if (action === 'remove') {
    cardEl.remove();
    return true;
  }

  cardEl.style.display = 'none';
  cardEl.dataset.wantedHidden = '1';
  return true;
}

function pushHiddenItem(item: HiddenJobItem): void {
  const key = `${item.jobId ?? ''}::${item.url}`;
  const exists = currentHiddenItems.some((entry) => `${entry.jobId ?? ''}::${entry.url}` === key);
  if (exists) {
    return;
  }
  currentHiddenItems.push(item);
}

function removeHiddenItemByJobId(jobId: string): void {
  currentHiddenItems = currentHiddenItems.filter((item) => item.jobId !== jobId);
}

function unhideJobOnPage(jobId: string): number {
  const hiddenCards = document.querySelectorAll<HTMLElement>('[data-wanted-hidden="1"]');
  let restoredCount = 0;

  hiddenCards.forEach((card) => {
    const anchors = card.querySelectorAll<HTMLAnchorElement>(JOB_LINK_SELECTORS.join(','));
    const matched = Array.from(anchors).some((anchor) => {
      const url = normalizeJobUrl(anchor.getAttribute('href'), location.origin) ?? anchor.href;
      return extractJobId(url) === jobId;
    });

    if (!matched) {
      return;
    }

    card.style.removeProperty('display');
    delete card.dataset.wantedHidden;
    restoredCount += 1;
  });

  if (restoredCount > 0) {
    removeHiddenItemByJobId(jobId);
    lastHiddenCount = Math.max(0, lastHiddenCount - restoredCount);
  }

  return restoredCount;
}

function createQuickHideRule(jobId: string): HideRule {
  return {
    id: `${QUICK_HIDE_RULE_PREFIX}${jobId}`,
    enabled: true,
    name: `빠른 숨김: ${jobId}`,
    companyKeywords: [],
    titleKeywords: [],
    jobRefs: [jobId],
    matchMode: 'OR',
    action: 'hide'
  };
}

function normalizeKeyword(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function createCompanyRuleId(company: string): string {
  const normalized = normalizeKeyword(company);
  const slug = normalized
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return `${QUICK_HIDE_COMPANY_RULE_PREFIX}${slug || 'company'}`;
}

function createQuickHideCompanyRule(company: string): HideRule {
  return {
    id: createCompanyRuleId(company),
    enabled: true,
    name: `빠른 숨김(회사): ${company}`,
    companyKeywords: [company],
    titleKeywords: [],
    jobRefs: [],
    matchMode: 'OR',
    action: 'hide'
  };
}

function showQuickToast(message: string): void {
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText = [
    'position: fixed',
    'right: 16px',
    'bottom: 16px',
    'z-index: 100000',
    'padding: 8px 10px',
    'border-radius: 8px',
    'background: rgba(17, 24, 39, 0.92)',
    'color: #fff',
    'font-size: 12px',
    'font-weight: 600'
  ].join(';');
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), 1500);
}

async function addQuickHideRuleAndApply(
  jobId: string,
  cardEl: HTMLElement,
  meta: { title: string | null; company: string | null; jobRole: string | null; url: string }
): Promise<void> {
  const exists = settingsCache.rules.some(
    (rule) => rule.enabled && rule.jobRefs.some((ref) => ref.trim() === jobId)
  );
  if (!exists) {
    const next: Settings = {
      ...settingsCache,
      rules: [...settingsCache.rules, createQuickHideRule(jobId)]
    };
    await saveSettings(next);
    settingsCache = next;
  }

  if (applyAction(cardEl, 'hide')) {
    lastHiddenCount += 1;
    pushHiddenItem({
      title: meta.title,
      company: meta.company,
      jobId,
      jobRole: meta.jobRole ?? meta.title,
      url: meta.url
    });
  }
}

async function addQuickHideCompanyRuleAndApply(
  company: string,
  cardEl: HTMLElement,
  meta: { title: string | null; company: string | null; jobRole: string | null; jobId: string | null; url: string }
): Promise<void> {
  const normalizedCompany = normalizeKeyword(company);
  const exists = settingsCache.rules.some((rule) => {
    if (!rule.enabled) {
      return false;
    }

    return rule.companyKeywords.some((keyword) => normalizeKeyword(keyword) === normalizedCompany);
  });

  if (!exists) {
    const next: Settings = {
      ...settingsCache,
      rules: [...settingsCache.rules, createQuickHideCompanyRule(company)]
    };
    await saveSettings(next);
    settingsCache = next;
  }

  if (applyAction(cardEl, 'hide')) {
    lastHiddenCount += 1;
    pushHiddenItem({
      title: meta.title,
      company: meta.company ?? company,
      jobId: meta.jobId,
      jobRole: meta.jobRole ?? meta.title,
      url: meta.url
    });
  }
}

function ensureCardPositioning(cardEl: HTMLElement): void {
  if (!cardEl.dataset.wantedQuickHidePosFixed) {
    const computed = window.getComputedStyle(cardEl);
    if (computed.position === 'static') {
      cardEl.style.position = 'relative';
      cardEl.dataset.wantedQuickHidePosFixed = '1';
    }
  }
}

function ensureButtonGroup(cardEl: HTMLElement): HTMLDivElement {
  const existing = cardEl.querySelector<HTMLDivElement>(`div[${QUICK_HIDE_BUTTON_GROUP_ATTR}="1"]`);
  if (existing) {
    return existing;
  }

  const group = document.createElement('div');
  group.setAttribute(QUICK_HIDE_BUTTON_GROUP_ATTR, '1');
  group.style.cssText = [
    'position: absolute',
    'top: 8px',
    'right: 8px',
    'z-index: 0',
    'display: flex',
    'flex-direction: column',
    'gap: 4px',
    'align-items: flex-end'
  ].join(';');
  cardEl.appendChild(group);
  return group;
}

function ensureCompanyButtonGroup(cardEl: HTMLElement): HTMLDivElement {
  const existing = cardEl.querySelector<HTMLDivElement>(
    `div[${QUICK_HIDE_COMPANY_BUTTON_GROUP_ATTR}="1"]`
  );
  if (existing) {
    return existing;
  }

  const group = document.createElement('div');
  group.setAttribute(QUICK_HIDE_COMPANY_BUTTON_GROUP_ATTR, '1');
  group.style.cssText = [
    'position: absolute',
    'top: 8px',
    'left: 8px',
    'z-index: 0',
    'display: flex',
    'flex-direction: column',
    'gap: 4px',
    'align-items: flex-start'
  ].join(';');
  cardEl.appendChild(group);
  return group;
}

function buildQuickHideButton(label: string, background: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.style.cssText = [
    'border: 0',
    'border-radius: 8px',
    'padding: 4px 8px',
    `background: ${background}`,
    'color: #fff',
    'font-size: 11px',
    'font-weight: 700',
    'cursor: pointer'
  ].join(';');
  return button;
}

function isQuickHideButtonTarget(cardEl: HTMLElement, jobId: string): boolean {
  const dataCy = cardEl.getAttribute('data-cy')?.toLowerCase() ?? '';
  const hasJobCardMarker = dataCy.includes('job-card');
  const hasPositionMarker =
    Boolean(cardEl.querySelector('[data-position-id]')) ||
    Boolean(cardEl.querySelector(`[data-position-id="${jobId}"]`));

  return hasJobCardMarker || hasPositionMarker;
}

function ensureQuickHideButton(candidate: JobCandidate): void {
  const { cardEl, jobId } = candidate;
  if (!jobId || cardEl.dataset.wantedHidden === '1') {
    return;
  }

  if (!isQuickHideButtonTarget(cardEl, jobId)) {
    return;
  }

  const existing = cardEl.querySelector<HTMLButtonElement>(`button[${QUICK_HIDE_BUTTON_ATTR}="1"]`);
  if (existing) {
    return;
  }

  const hasJobLink = cardEl.querySelector<HTMLAnchorElement>(JOB_LINK_SELECTORS.join(','));
  if (!hasJobLink) {
    return;
  }

  ensureCardPositioning(cardEl);
  const group = ensureButtonGroup(cardEl);
  const button = buildQuickHideButton('이 공고 숨기기', 'rgba(17,24,39,0.85)');
  button.setAttribute(QUICK_HIDE_BUTTON_ATTR, '1');

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const meta = resolveCandidateMeta(candidate);
    void addQuickHideRuleAndApply(jobId, cardEl, {
      title: meta.title,
      company: meta.company,
      jobRole: meta.jobRole,
      url: meta.url
    }).then(() => {
      showQuickToast(`공고 ${jobId} 숨김 규칙이 추가되었습니다.`);
    });
  });

  group.appendChild(button);
}

function ensureQuickHideCompanyButton(candidate: JobCandidate): void {
  const { cardEl, company, jobId } = candidate;
  if (!company || cardEl.dataset.wantedHidden === '1') {
    return;
  }

  if (!jobId || !isQuickHideButtonTarget(cardEl, jobId)) {
    return;
  }

  const existing = cardEl.querySelector<HTMLButtonElement>(
    `button[${QUICK_HIDE_COMPANY_BUTTON_ATTR}="1"]`
  );
  if (existing) {
    return;
  }

  ensureCardPositioning(cardEl);
  const group = ensureCompanyButtonGroup(cardEl);
  const button = buildQuickHideButton('이 회사 숨기기', 'rgba(17,24,39,0.85)');
  button.setAttribute(QUICK_HIDE_COMPANY_BUTTON_ATTR, '1');

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const meta = resolveCandidateMeta(candidate);
    void addQuickHideCompanyRuleAndApply(company, cardEl, {
      title: meta.title,
      company: meta.company,
      jobRole: meta.jobRole,
      jobId: meta.jobId,
      url: meta.url
    }).then(() => {
      showQuickToast(`회사 ${company} 숨김 규칙이 추가되었습니다.`);
    });
  });

  group.appendChild(button);
}

function resolveCompanyHideTarget(cardEl: HTMLElement): HTMLElement {
  const companySelector = COMPANY_LINK_SELECTORS.join(',');

  let cursor: HTMLElement | null = cardEl;
  let depth = 0;
  while (cursor && depth < 8) {
    const parent = cursor.parentElement;
    if (!parent) {
      break;
    }

    const siblingItems: HTMLElement[] = [];
    // DOM typing can degrade to any in some environments; guarded by instance checks below.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    let child: Element | null = parent.firstElementChild;
    while (child) {
      if (child instanceof HTMLElement && child.querySelector(companySelector)) {
        siblingItems.push(child);
      }
      child = child.nextElementSibling;
    }

    if (siblingItems.length >= 2 && siblingItems.includes(cursor)) {
      return cursor;
    }

    cursor = parent instanceof HTMLElement ? parent : null;
    depth += 1;
  }

  const outer = cardEl.closest<HTMLElement>('[role="listitem"], li, article');
  return outer ?? cardEl;
}

function resolveCandidateMeta(candidate: JobCandidate): {
  title: string | null;
  company: string | null;
  jobRole: string | null;
  jobId: string | null;
  url: string;
} {
  const { cardEl, title, company, jobId, url } = candidate;
  const dataEl = cardEl.querySelector<HTMLElement>(
    '[data-position-name], [data-company-name], [data-job-category]'
  );

  const positionName = dataEl?.getAttribute('data-position-name')?.trim() || null;
  const companyName = dataEl?.getAttribute('data-company-name')?.trim() || null;
  const jobCategory = dataEl?.getAttribute('data-job-category')?.trim() || null;

  const resolvedTitle = positionName ?? title;
  const resolvedCompany = companyName ?? company;
  const resolvedJobRole = jobCategory ?? resolvedTitle;

  return {
    title: resolvedTitle,
    company: resolvedCompany,
    jobRole: resolvedJobRole,
    jobId,
    url
  };
}

function flushPending(): void {
  flushScheduled = false;

  if (!shouldFilterCardsOnPath(location.pathname)) {
    return;
  }

  if (pendingNodes.size === 0) {
    return;
  }

  const nodes = Array.from(pendingNodes);
  pendingNodes.clear();

  const anchorSet = new Set<HTMLAnchorElement>();
  nodes.forEach((node) => {
    collectJobAnchors(node).forEach((anchor) => anchorSet.add(anchor));
  });

  const anchors = Array.from(anchorSet);

  let foundLinks = 0;
  let cardSuccess = 0;
  let titleSuccess = 0;
  let companySuccess = 0;
  let hiddenApplied = 0;

  const processedCards = new Set<HTMLElement>();

  for (const anchor of anchors) {
    foundLinks += 1;

    if (!anchor.isConnected) {
      continue;
    }

    const cardEl = findCardContainer(anchor);
    if (!cardEl) {
      continue;
    }

    cardSuccess += 1;

    if (processedCards.has(cardEl) || cardEl.dataset.wantedHidden === '1') {
      continue;
    }

    processedCards.add(cardEl);

    const url = normalizeJobUrl(anchor.getAttribute('href'), location.origin) ?? anchor.href;
    if (!url) {
      continue;
    }

    const jobId = extractJobId(url);
    const title = extractTitle(cardEl, anchor);
    const company = extractCompany(cardEl, title);

    if (title) {
      titleSuccess += 1;
    }

    if (company) {
      companySuccess += 1;
    }

    const baseCandidate: JobCandidate = {
      anchor,
      cardEl,
      url,
      jobId,
      title,
      company
    };

    const resolved = resolveCandidateMeta(baseCandidate);
    const candidate: JobCandidate = {
      anchor,
      cardEl,
      url: resolved.url,
      jobId: resolved.jobId,
      title: resolved.title,
      company: resolved.company
    };

    ensureQuickHideButton(candidate);
    ensureQuickHideCompanyButton(candidate);

    const matched = matchAnyRule(candidate, settingsCache.rules);
    if (!matched.matched) {
      continue;
    }

    if (applyAction(cardEl, 'hide')) {
      hiddenApplied += 1;
      lastHiddenCount += 1;
      pushHiddenItem({
        title: resolved.title,
        company: resolved.company,
        jobId: resolved.jobId,
        jobRole: resolved.jobRole,
        url: resolved.url
      });
    }
  }

  const companyAnchorSet = new Set<HTMLAnchorElement>();
  nodes.forEach((node) => {
    collectCompanyAnchors(node).forEach((anchor) => companyAnchorSet.add(anchor));
  });

  for (const anchor of companyAnchorSet) {
    if (!anchor.isConnected) {
      continue;
    }

    const cardEl = findCompanyCardContainer(anchor);
    if (!cardEl) {
      continue;
    }

    const hideTarget = resolveCompanyHideTarget(cardEl);
    if (processedCards.has(hideTarget) || hideTarget.dataset.wantedHidden === '1') {
      continue;
    }
    processedCards.add(hideTarget);

    const url = normalizeJobUrl(anchor.getAttribute('href'), location.origin) ?? anchor.href;
    if (!url) {
      continue;
    }

    const company = extractCompanyFromCompanyCard(cardEl, anchor);
    const candidate: JobCandidate = {
      anchor,
      cardEl: hideTarget,
      url,
      jobId: extractJobId(url),
      title: null,
      company
    };

    const matched = matchAnyRule(candidate, settingsCache.rules);
    if (!matched.matched) {
      continue;
    }

    if (applyAction(hideTarget, 'hide')) {
      hiddenApplied += 1;
      lastHiddenCount += 1;
      pushHiddenItem({
        title: null,
        company,
        jobId: candidate.jobId,
        jobRole: null,
        url
      });
    }
  }

  if (settingsCache.debug) {
    const cardRatio = foundLinks > 0 ? ((cardSuccess / foundLinks) * 100).toFixed(1) : '0.0';
    const titleRatio = cardSuccess > 0 ? ((titleSuccess / cardSuccess) * 100).toFixed(1) : '0.0';
    const companyRatio = cardSuccess > 0 ? ((companySuccess / cardSuccess) * 100).toFixed(1) : '0.0';

    debugLog('scan stats', {
      route: location.pathname,
      foundLinks,
      cardSuccess,
      cardSuccessRate: `${cardRatio}%`,
      titleSuccess,
      titleSuccessRate: `${titleRatio}%`,
      companySuccess,
      companySuccessRate: `${companyRatio}%`,
      hiddenApplied,
      totalHiddenForPage: lastHiddenCount
    });
  }

  if (pendingNodes.size > 0) {
    scheduleFlush();
  }
}

function observeListMode(): void {
  lastHiddenCount = 0;
  currentHiddenItems = [];
  const target = document.querySelector('main') ?? document.body;

  enqueueNode(target);

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        enqueueNode(node);
      });
    }
  });

  observer.observe(target, {
    childList: true,
    subtree: true
  });

  cleanupFns.push(() => {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  });
}

function findDetailRoot(): HTMLElement {
  const preferred = document.querySelector<HTMLElement>('main, article, [role="main"]');
  if (preferred) {
    return preferred;
  }

  return document.body;
}

function removeDetailBanner(): void {
  const existing = document.getElementById(DETAIL_BANNER_ID);
  if (existing) {
    existing.remove();
  }
}

function insertDetailBanner(ruleId?: string): void {
  removeDetailBanner();

  const banner = document.createElement('div');
  banner.id = DETAIL_BANNER_ID;
  banner.textContent = ruleId
    ? `Wanted Manager: 숨김 처리된 공고입니다. (rule: ${ruleId})`
    : 'Wanted Manager: 숨김 처리된 공고입니다.';
  banner.setAttribute('role', 'status');
  banner.style.cssText = [
    'position: sticky',
    'top: 0',
    'z-index: 9999',
    'padding: 10px 14px',
    'background: #fff7cc',
    'color: #4a3a00',
    'font-size: 14px',
    'font-weight: 600',
    'border: 1px solid #f3dd8b'
  ].join(';');

  const root = findDetailRoot();
  root.prepend(banner);
}

function handleDetailMode(detailJobId: string): void {
  removeDetailBanner();

  if (!settingsCache.detailPageEnabled) {
    return;
  }

  const matchedRule = settingsCache.rules.find((rule) => {
    if (!rule.enabled) {
      return false;
    }

    const refs = rule.jobRefs.map((ref) => ref.trim()).filter(Boolean);
    if (refs.length === 0) {
      return false;
    }

    return refs.some((ref) => {
      if (/^\d+$/.test(ref)) {
        return ref === detailJobId;
      }

      const refJobId = extractJobId(ref);
      if (refJobId) {
        return refJobId === detailJobId;
      }

      return ref.includes(`/wd/${detailJobId}`);
    });
  });

  if (matchedRule) {
    insertDetailBanner(matchedRule.id);
  }
}

function patchHistoryOnce(): void {
  if (window.__wantedHiderHistoryPatched) {
    return;
  }

  window.__wantedHiderHistoryPatched = true;

  const pushState = history.pushState.bind(history);
  const replaceState = history.replaceState.bind(history);

  history.pushState = function patchedPushState(
    data: unknown,
    unused: string,
    url?: string | URL | null
  ) {
    const result = pushState(data, unused, url);
    window.dispatchEvent(new CustomEvent(NAV_EVENT_NAME));
    return result;
  };

  history.replaceState = function patchedReplaceState(
    data: unknown,
    unused: string,
    url?: string | URL | null
  ) {
    const result = replaceState(data, unused, url);
    window.dispatchEvent(new CustomEvent(NAV_EVENT_NAME));
    return result;
  };
}

function injectPageHistoryPatchOnce(): void {
  if (window.__wantedHiderPagePatchInjected) {
    return;
  }

  window.__wantedHiderPagePatchInjected = true;

  const script = document.createElement('script');
  script.dataset.wantedHiderPatch = '1';
  script.textContent = `
    (() => {
      if (window.__wantedHiderPageHistoryPatched) return;
      window.__wantedHiderPageHistoryPatched = true;
      const eventName = ${JSON.stringify(NAV_EVENT_NAME)};
      const rawPush = history.pushState.bind(history);
      const rawReplace = history.replaceState.bind(history);
      history.pushState = function(...args) {
        const result = rawPush(...args);
        window.dispatchEvent(new CustomEvent(eventName));
        return result;
      };
      history.replaceState = function(...args) {
        const result = rawReplace(...args);
        window.dispatchEvent(new CustomEvent(eventName));
        return result;
      };
    })();
  `;

  (document.head ?? document.documentElement).appendChild(script);
  script.remove();
}

async function restartForRoute(trigger: string): Promise<void> {
  const seq = ++routeSequence;
  cleanupRouteMode();
  removeDetailBanner();

  settingsCache = await getSettings();
  if (seq !== routeSequence) {
    return;
  }

  currentRouteKey = getRouteKey();
  debugLog(`route restart (${trigger})`, { route: currentRouteKey });

  if (isWdListPath(currentRouteKey)) {
    observeListMode();
    return;
  }

  const detailInfo = isWdDetailPath(currentRouteKey);
  if (detailInfo.matched && detailInfo.jobId) {
    // Apply list filtering on detail pages as well (recommended positions, related cards).
    observeListMode();
    handleDetailMode(detailInfo.jobId);
    return;
  }
}

function bindGlobalEvents(): void {
  window.addEventListener(NAV_EVENT_NAME, () => {
    maybeRestartForPathChange('history');
  });

  window.addEventListener('popstate', () => {
    maybeRestartForPathChange('popstate');
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if ((areaName !== 'sync' && areaName !== 'local') || !changes[STORAGE_KEY]) {
      return;
    }

    const newValue = changes[STORAGE_KEY].newValue as Settings | undefined;
    settingsCache = {
      ...DEFAULT_SETTINGS,
      ...(newValue ?? {})
    };

    void restartForRoute('settings_changed');
  });

  chrome.runtime.onMessage.addListener((request: RuntimeRequest, _sender, sendResponse) => {
    if (request?.type === 'GET_LAST_HIDDEN_COUNT') {
      const response: GetLastHiddenCountResponse = {
        lastHiddenCount,
        route: currentRouteKey || location.pathname
      };

      sendResponse(response);
      return;
    }

    if (request?.type === 'GET_PAGE_HIDDEN_ITEMS') {
      const response: GetPageHiddenItemsResponse = {
        route: currentRouteKey || location.pathname,
        items: currentHiddenItems
      };
      sendResponse(response);
      return;
    }

    if (request?.type === 'UNHIDE_JOB') {
      const restoredCount = unhideJobOnPage(request.jobId);
      sendResponse({ restoredCount });
      return;
    }

    if (request?.type === 'APPLY_RULES_NOW') {
      void restartForRoute('manual_apply');
      sendResponse({ ok: true });
    }
  });

  window.setInterval(() => {
    maybeRestartForPathChange('poll');
  }, 500);
}

async function bootstrap(): Promise<void> {
  patchHistoryOnce();
  injectPageHistoryPatchOnce();
  bindGlobalEvents();
  lastSeenPathname = getRouteKey();
  await restartForRoute('bootstrap');
}

void bootstrap();
