import { matchAnyRule } from '../shared/rules';
import {
  collectJobAnchors,
  extractCompany,
  extractJobId,
  extractTitle,
  findCardContainer,
  isWdDetailPath,
  isWdListPath,
  normalizeJobUrl
} from '../shared/selectors';
import { DEFAULT_SETTINGS, STORAGE_KEY, getSettings } from '../shared/storage';
import type {
  GetLastHiddenCountResponse,
  JobCandidate,
  RuntimeRequest,
  Settings
} from '../shared/types';

declare global {
  interface Window {
    __wantedHiderHistoryPatched?: boolean;
  }
}

const NAV_EVENT_NAME = 'wanted-hider:navigation';
const DETAIL_BANNER_ID = 'wanted-hider-detail-banner';
const MAX_ANCHORS_PER_FLUSH = 500;

let cleanupFns: Array<() => void> = [];
let observer: MutationObserver | null = null;
let pendingNodes = new Set<Node>();
let flushScheduled = false;
let rafHandle: number | null = null;
let timerHandle: number | null = null;
let lastHiddenCount = 0;
let currentRouteKey = '';
let settingsCache: Settings = { ...DEFAULT_SETTINGS };
let routeSequence = 0;

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

function scheduleFlush(): void {
  if (flushScheduled) {
    return;
  }

  flushScheduled = true;

  if (typeof requestAnimationFrame === 'function') {
    rafHandle = requestAnimationFrame(() => {
      rafHandle = null;
      void flushPending();
    });
    return;
  }

  timerHandle = window.setTimeout(() => {
    timerHandle = null;
    void flushPending();
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

async function flushPending(): Promise<void> {
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

  const { pushState, replaceState } = history;

  history.pushState = function patchedPushState(
    data: unknown,
    unused: string,
    url?: string | URL | null
  ) {
    const result = pushState.call(this, data, unused, url);
    window.dispatchEvent(new CustomEvent(NAV_EVENT_NAME));
    return result;
  };

  history.replaceState = function patchedReplaceState(
    data: unknown,
    unused: string,
    url?: string | URL | null
  ) {
    const result = replaceState.call(this, data, unused, url);
    window.dispatchEvent(new CustomEvent(NAV_EVENT_NAME));
    return result;
  };
}

async function restartForRoute(trigger: string): Promise<void> {
  const seq = ++routeSequence;
  cleanupRouteMode();
  removeDetailBanner();

  settingsCache = await getSettings();
  if (seq !== routeSequence) {
    return;
  }

  currentRouteKey = location.pathname;
  debugLog(`route restart (${trigger})`, { route: currentRouteKey });

  if (isWdListPath(location.pathname)) {
    observeListMode();
    return;
  }

  const detailInfo = isWdDetailPath(location.pathname);
  if (detailInfo.matched && detailInfo.jobId) {
    handleDetailMode(detailInfo.jobId);
    return;
  }
}

function bindGlobalEvents(): void {
  window.addEventListener(NAV_EVENT_NAME, () => {
    void restartForRoute('history');
  });

  window.addEventListener('popstate', () => {
    void restartForRoute('popstate');
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
}

async function bootstrap(): Promise<void> {
  patchHistoryOnce();
  bindGlobalEvents();
  await restartForRoute('bootstrap');
}

void bootstrap();
