import { matchAnyRule } from '../shared/rules';
import {
  JOB_LINK_SELECTORS,
  collectJobAnchors,
  extractCompany,
  extractJobId,
  extractTitle,
  findCardContainer,
  isWdDetailPath,
  isWdListPath,
  normalizeJobUrl
} from '../shared/selectors';
import { DEFAULT_SETTINGS, STORAGE_KEY, getSettings, saveSettings } from '../shared/storage';
import type {
  GetLastHiddenCountResponse,
  HideRule,
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
const MAX_ANCHORS_PER_FLUSH = 500;
const QUICK_HIDE_BUTTON_ATTR = 'data-wanted-quick-hide-btn';
const QUICK_HIDE_RULE_PREFIX = 'quick-hide-';

let cleanupFns: Array<() => void> = [];
let observer: MutationObserver | null = null;
const pendingNodes = new Set<Node>();
let flushScheduled = false;
let rafHandle: number | null = null;
let timerHandle: number | null = null;
let lastHiddenCount = 0;
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

async function addQuickHideRuleAndApply(jobId: string, cardEl: HTMLElement): Promise<void> {
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

function ensureQuickHideButton(cardEl: HTMLElement, jobId: string | null): void {
  if (!jobId || cardEl.dataset.wantedHidden === '1') {
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

  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute(QUICK_HIDE_BUTTON_ATTR, '1');
  button.textContent = '이 공고 숨기기';
  button.style.cssText = [
    'position: absolute',
    'top: 8px',
    'right: 8px',
    'z-index: 1000',
    'border: 0',
    'border-radius: 8px',
    'padding: 4px 8px',
    'background: rgba(17,24,39,0.85)',
    'color: #fff',
    'font-size: 11px',
    'font-weight: 700',
    'cursor: pointer'
  ].join(';');

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void addQuickHideRuleAndApply(jobId, cardEl).then(() => {
      showQuickToast(`공고 ${jobId} 숨김 규칙이 추가되었습니다.`);
    });
  });

  cardEl.appendChild(button);
}

function flushPending(): void {
  flushScheduled = false;

  if (!isWdListPath(location.pathname)) {
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

  const anchors = Array.from(anchorSet).slice(0, MAX_ANCHORS_PER_FLUSH);

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

    const candidate: JobCandidate = {
      anchor,
      cardEl,
      url,
      jobId,
      title,
      company
    };

    ensureQuickHideButton(cardEl, jobId);

    const matched = matchAnyRule(candidate, settingsCache.rules);
    if (!matched.matched || !matched.action) {
      continue;
    }

    if (applyAction(cardEl, matched.action)) {
      hiddenApplied += 1;
      lastHiddenCount += 1;
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

  const root = findDetailRoot();
  const heading = root.querySelector<HTMLElement>('h1, h2, [role="heading"], strong');
  const title = heading?.textContent?.trim() ?? document.title;

  const candidate: JobCandidate = {
    anchor: document.createElement('a'),
    cardEl: root,
    url: location.href,
    jobId: detailJobId,
    title,
    company: null
  };

  const matched = matchAnyRule(candidate, settingsCache.rules);
  if (matched.matched) {
    insertDetailBanner(matched.ruleId);
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
    if (areaName !== 'sync' || !changes[STORAGE_KEY]) {
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
    if (request?.type !== 'GET_LAST_HIDDEN_COUNT') {
      return;
    }

    const response: GetLastHiddenCountResponse = {
      lastHiddenCount,
      route: currentRouteKey || location.pathname
    };

    sendResponse(response);
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
