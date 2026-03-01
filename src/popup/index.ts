import { deleteRule, getSettings, saveSettings, toggleRule, upsertRule } from '../shared/storage';
import type {
  GetLastHiddenCountResponse,
  HideRule,
  RuleMatchMode,
  RuntimeRequest,
  Settings
} from '../shared/types';

const hiddenCountEl = document.getElementById('hidden-count') as HTMLParagraphElement;
const detailEnabledEl = document.getElementById('detail-enabled') as HTMLInputElement;
const debugEnabledEl = document.getElementById('debug-enabled') as HTMLInputElement;
const formEl = document.getElementById('rule-form') as HTMLFormElement;
const companyInputEl = document.getElementById('company-keywords') as HTMLInputElement;
const titleInputEl = document.getElementById('title-keywords') as HTMLInputElement;
const jobRefsInputEl = document.getElementById('job-refs') as HTMLInputElement;
const matchModeEl = document.getElementById('match-mode') as HTMLSelectElement;
const actionModeEl = document.getElementById('action-mode') as HTMLSelectElement;
const ruleListEl = document.getElementById('rule-list') as HTMLDivElement;
const ruleErrorEl = document.getElementById('rule-error') as HTMLParagraphElement;

let settingsState: Settings;

function actionLabel(action: HideRule['action']): string {
  return action === 'remove' ? '제거 (remove)' : '숨김 (hide)';
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function makeRuleName(rule: HideRule): string {
  if (rule.name?.trim()) {
    return rule.name;
  }

  if (rule.companyKeywords.length > 0) {
    return `회사: ${rule.companyKeywords[0]}`;
  }

  if (rule.titleKeywords.length > 0) {
    return `제목: ${rule.titleKeywords[0]}`;
  }

  if (rule.jobRefs.length > 0) {
    return `ID/링크: ${rule.jobRefs[0]}`;
  }

  return '이름 없는 규칙';
}

function summarizeRule(rule: HideRule): string {
  const sections: string[] = [];
  if (rule.companyKeywords.length > 0) {
    sections.push(`회사(${rule.companyKeywords.join(', ')})`);
  }
  if (rule.titleKeywords.length > 0) {
    sections.push(`제목(${rule.titleKeywords.join(', ')})`);
  }
  if (rule.jobRefs.length > 0) {
    sections.push(`ID/링크(${rule.jobRefs.join(', ')})`);
  }

  return `${rule.matchMode} / ${sections.join(' + ') || '조건 없음'}`;
}

function genRuleId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `rule_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function renderRules(settings: Settings): void {
  ruleListEl.innerHTML = '';

  if (settings.rules.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'rule-meta';
    empty.textContent = '등록된 규칙이 없습니다.';
    ruleListEl.appendChild(empty);
    return;
  }

  settings.rules.forEach((rule) => {
    const item = document.createElement('article');
    item.className = 'rule-item';
    item.dataset.ruleId = rule.id;

    const head = document.createElement('div');
    head.className = 'rule-head';

    const title = document.createElement('p');
    title.className = 'rule-title';
    title.textContent = makeRuleName(rule);

    const badge = document.createElement('span');
    badge.className = `badge ${rule.action}`;
    badge.textContent = actionLabel(rule.action);

    head.appendChild(title);
    head.appendChild(badge);

    const meta = document.createElement('p');
    meta.className = 'rule-meta';
    meta.textContent = summarizeRule(rule);

    const actions = document.createElement('div');
    actions.className = 'rule-actions';

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'toggle-row';
    toggleLabel.textContent = '활성';

    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.checked = rule.enabled;
    toggleInput.dataset.action = 'toggle';
    toggleInput.dataset.ruleId = rule.id;
    toggleLabel.appendChild(toggleInput);

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'delete-btn';
    deleteButton.dataset.action = 'delete';
    deleteButton.dataset.ruleId = rule.id;
    deleteButton.textContent = '삭제';

    actions.appendChild(toggleLabel);
    actions.appendChild(deleteButton);

    item.appendChild(head);
    item.appendChild(meta);
    item.appendChild(actions);
    ruleListEl.appendChild(item);
  });
}

function renderSettings(settings: Settings): void {
  settingsState = settings;
  detailEnabledEl.checked = settings.detailPageEnabled;
  debugEnabledEl.checked = settings.debug;
  renderRules(settings);
}

function queryActiveTab(): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0] ?? null);
    });
  });
}

function requestHiddenCount(tabId: number): Promise<GetLastHiddenCountResponse | null> {
  return new Promise((resolve) => {
    const message: RuntimeRequest = { type: 'GET_LAST_HIDDEN_COUNT' };
    chrome.tabs.sendMessage(tabId, message, (response: GetLastHiddenCountResponse | undefined) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }

      resolve(response ?? null);
    });
  });
}

async function refreshHiddenCount(): Promise<void> {
  const activeTab = await queryActiveTab();
  if (!activeTab?.id) {
    hiddenCountEl.textContent = '현재 페이지에서 마지막으로 숨긴 개수: -';
    return;
  }

  const response = await requestHiddenCount(activeTab.id);
  if (!response) {
    hiddenCountEl.textContent = '현재 페이지에서 마지막으로 숨긴 개수: -';
    return;
  }

  hiddenCountEl.textContent = `현재 페이지에서 마지막으로 숨긴 개수: ${response.lastHiddenCount}`;
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
    action: actionModeEl.value as 'remove' | 'hide'
  };

  const next = await upsertRule(rule);
  renderSettings(next);
  await refreshHiddenCount();

  formEl.reset();
  matchModeEl.value = 'AND';
  actionModeEl.value = 'remove';
}

async function handleRuleListClick(event: Event): Promise<void> {
  const target = event.target as HTMLElement;
  const action = target.dataset.action;
  const ruleId = target.dataset.ruleId;

  if (!action || !ruleId) {
    return;
  }

  if (action === 'delete') {
    const next = await deleteRule(ruleId);
    renderSettings(next);
    await refreshHiddenCount();
  }
}

async function handleRuleToggle(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement;
  if (target.dataset.action !== 'toggle' || !target.dataset.ruleId) {
    return;
  }

  const next = await toggleRule(target.dataset.ruleId, target.checked);
  renderSettings(next);
  await refreshHiddenCount();
}

async function handleGlobalToggle(): Promise<void> {
  const next: Settings = {
    ...settingsState,
    detailPageEnabled: detailEnabledEl.checked,
    debug: debugEnabledEl.checked
  };

  await saveSettings(next);
  renderSettings(next);
  await refreshHiddenCount();
}

async function bootstrap(): Promise<void> {
  const settings = await getSettings();
  renderSettings(settings);
  await refreshHiddenCount();

  formEl.addEventListener('submit', (event) => {
    void handleAddRule(event);
  });

  ruleListEl.addEventListener('click', (event) => {
    void handleRuleListClick(event);
  });

  ruleListEl.addEventListener('change', (event) => {
    void handleRuleToggle(event);
  });

  detailEnabledEl.addEventListener('change', () => {
    void handleGlobalToggle();
  });

  debugEnabledEl.addEventListener('change', () => {
    void handleGlobalToggle();
  });
}

void bootstrap();
