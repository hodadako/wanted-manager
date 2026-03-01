import { extractJobId } from '../shared/selectors';
import { getSettings, saveSettings, upsertRule } from '../shared/storage';
import type {
  GetPageHiddenItemsResponse,
  GetLastHiddenCountResponse,
  HiddenJobItem,
  HideRule,
  RuleMatchMode,
  RuntimeRequest,
  Settings
} from '../shared/types';

const hiddenCountEl = document.getElementById('hidden-count') as HTMLParagraphElement;
const hiddenJobListEl = document.getElementById('hidden-job-list') as HTMLDivElement;
const detailEnabledEl = document.getElementById('detail-enabled') as HTMLInputElement;
const debugEnabledEl = document.getElementById('debug-enabled') as HTMLInputElement;
const formEl = document.getElementById('rule-form') as HTMLFormElement;
const companyInputEl = document.getElementById('company-keywords') as HTMLInputElement;
const titleInputEl = document.getElementById('title-keywords') as HTMLInputElement;
const jobRefsInputEl = document.getElementById('job-refs') as HTMLInputElement;
const matchModeEl = document.getElementById('match-mode') as HTMLSelectElement;
const ruleErrorEl = document.getElementById('rule-error') as HTMLParagraphElement;

let settingsState: Settings;
let activeTabId: number | null = null;

function safeText(value: string | null | undefined): string {
  const text = value?.trim();
  return text && text.length > 0 ? text : '-';
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function genRuleId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `rule_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function renderSettings(settings: Settings): void {
  settingsState = settings;
  detailEnabledEl.checked = settings.detailPageEnabled;
  debugEnabledEl.checked = settings.debug;
}

function queryActiveTab(): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0] ?? null);
    });
  });
}

function sendMessage<T>(tabId: number, message: RuntimeRequest): Promise<T | null> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response: T | undefined) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }

      resolve(response ?? null);
    });
  });
}

function renderHiddenJobs(items: HiddenJobItem[]): void {
  hiddenJobListEl.innerHTML = '';

  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'rule-meta';
    empty.textContent = '이 페이지에서 숨긴 공고가 없습니다.';
    hiddenJobListEl.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const row = document.createElement('article');
    row.className = 'hidden-item';

    const title = document.createElement('p');
    title.className = 'rule-title';
    title.textContent = `이름: ${safeText(item.title)}`;

    const company = document.createElement('p');
    company.className = 'rule-meta';
    company.textContent = `회사: ${safeText(item.company)}`;

    const idLine = document.createElement('p');
    idLine.className = 'rule-meta';
    idLine.textContent = `ID: ${safeText(item.jobId)}`;

    const role = document.createElement('p');
    role.className = 'rule-meta';
    role.textContent = `직무: ${safeText(item.jobRole)}`;

    const actions = document.createElement('div');
    actions.className = 'hidden-actions';

    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'restore-btn';
    restoreBtn.textContent = '다시 활성화';
    if (!item.jobId) {
      restoreBtn.disabled = true;
    } else {
      restoreBtn.dataset.jobId = item.jobId;
    }

    actions.appendChild(restoreBtn);

    row.appendChild(title);
    row.appendChild(company);
    row.appendChild(idLine);
    row.appendChild(role);
    row.appendChild(actions);
    hiddenJobListEl.appendChild(row);
  });
}

async function refreshHiddenData(): Promise<void> {
  const activeTab = await queryActiveTab();
  activeTabId = activeTab?.id ?? null;

  if (!activeTabId) {
    hiddenCountEl.textContent = '현재 페이지에서 마지막으로 숨긴 개수: -';
    renderHiddenJobs([]);
    return;
  }

  const countResponse = await sendMessage<GetLastHiddenCountResponse>(activeTabId, {
    type: 'GET_LAST_HIDDEN_COUNT'
  });

  if (!countResponse) {
    hiddenCountEl.textContent = '현재 페이지에서 마지막으로 숨긴 개수: -';
    renderHiddenJobs([]);
    return;
  }

  hiddenCountEl.textContent = `현재 페이지에서 마지막으로 숨긴 개수: ${countResponse.lastHiddenCount}`;

  const hiddenJobsResponse = await sendMessage<GetPageHiddenItemsResponse>(activeTabId, {
    type: 'GET_PAGE_HIDDEN_ITEMS'
  });

  renderHiddenJobs(hiddenJobsResponse?.items ?? []);
}

function removeJobIdFromRules(settings: Settings, jobId: string): Settings {
  const nextRules = settings.rules
    .map((rule) => {
      const filteredRefs = rule.jobRefs.filter((ref) => {
        const trimmed = ref.trim();
        if (!trimmed) {
          return false;
        }

        if (trimmed === jobId) {
          return false;
        }

        return extractJobId(trimmed) !== jobId;
      });

      if (rule.id === `quick-hide-${jobId}`) {
        return null;
      }

      return {
        ...rule,
        jobRefs: filteredRefs
      };
    })
    .filter((rule): rule is HideRule => {
      if (!rule) {
        return false;
      }

      const hasCondition =
        rule.companyKeywords.length > 0 || rule.titleKeywords.length > 0 || rule.jobRefs.length > 0;
      return hasCondition;
    });

  return {
    ...settings,
    rules: nextRules
  };
}

async function restoreHiddenJob(jobId: string): Promise<void> {
  const next = removeJobIdFromRules(settingsState, jobId);
  await saveSettings(next);
  renderSettings(next);

  if (activeTabId) {
    await sendMessage<{ restoredCount: number }>(activeTabId, {
      type: 'UNHIDE_JOB',
      jobId
    });
  }

  await refreshHiddenData();
}

async function handleAddRule(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  ruleErrorEl.textContent = '';

  const companyKeywords = parseCsv(companyInputEl.value);
  const titleKeywords = parseCsv(titleInputEl.value);
  const jobRefs = parseCsv(jobRefsInputEl.value);

  if (companyKeywords.length === 0 && titleKeywords.length === 0 && jobRefs.length === 0) {
    ruleErrorEl.textContent = '최소 하나의 조건(회사/제목/링크/ID)을 입력하세요.';
    return;
  }

  const rule: HideRule = {
    id: genRuleId(),
    enabled: true,
    companyKeywords,
    titleKeywords,
    jobRefs,
    matchMode: matchModeEl.value as RuleMatchMode,
    action: 'hide'
  };

  const next = await upsertRule(rule);
  renderSettings(next);
  await refreshHiddenData();

  formEl.reset();
  matchModeEl.value = 'AND';
}

async function handleGlobalToggle(): Promise<void> {
  const next: Settings = {
    ...settingsState,
    detailPageEnabled: detailEnabledEl.checked,
    debug: debugEnabledEl.checked
  };

  await saveSettings(next);
  renderSettings(next);
  await refreshHiddenData();
}

function bindEvents(): void {
  formEl.addEventListener('submit', (event) => {
    void handleAddRule(event);
  });

  hiddenJobListEl.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>('button.restore-btn');
    const jobId = button?.dataset.jobId;
    if (!button || !jobId) {
      return;
    }

    void restoreHiddenJob(jobId);
  });

  detailEnabledEl.addEventListener('change', () => {
    void handleGlobalToggle();
  });

  debugEnabledEl.addEventListener('change', () => {
    void handleGlobalToggle();
  });
}

async function bootstrap(): Promise<void> {
  const settings = await getSettings();
  renderSettings(settings);
  bindEvents();
  await refreshHiddenData();
}

void bootstrap();
