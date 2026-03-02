import { extractJobId } from '../shared/selectors';
import { deleteRule, getSettings, saveSettings, toggleRule, upsertRule } from '../shared/storage';
import type {
  GetPageHiddenItemsResponse,
  HiddenJobItem,
  HideRule,
  RuntimeRequest,
  Settings
} from '../shared/types';

const hiddenJobListEl = document.getElementById('hidden-job-list') as HTMLDivElement;
const ruleListEl = document.getElementById('rule-list') as HTMLDivElement;
const formEl = document.getElementById('rule-form') as HTMLFormElement;
const companyInputEl = document.getElementById('company-keywords') as HTMLInputElement;
const titleInputEl = document.getElementById('title-keywords') as HTMLInputElement;
const jobRefsInputEl = document.getElementById('job-refs') as HTMLInputElement;
const ruleErrorEl = document.getElementById('rule-error') as HTMLParagraphElement;
const exportSettingsBtnEl = document.getElementById('export-settings-btn') as HTMLButtonElement;
const importSettingsBtnEl = document.getElementById('import-settings-btn') as HTMLButtonElement;
const importSettingsFileEl = document.getElementById('import-settings-file') as HTMLInputElement;

let settingsState: Settings;
let activeTabId: number | null = null;
const QUICK_HIDE_RULE_PREFIX = 'quick-hide-';

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

function isQuickHideRule(rule: HideRule): boolean {
  return rule.id.startsWith(QUICK_HIDE_RULE_PREFIX);
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

  return `OR / ${sections.join(' + ') || '조건 없음'}`;
}

function renderRules(settings: Settings): void {
  ruleListEl.innerHTML = '';

  const visibleRules = settings.rules.filter((rule) => !isQuickHideRule(rule));
  if (visibleRules.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'rule-meta';
    empty.textContent = '설정한 규칙이 없습니다.';
    ruleListEl.appendChild(empty);
    return;
  }

  visibleRules.forEach((rule) => {
    const item = document.createElement('article');
    item.className = 'rule-item';
    item.dataset.ruleId = rule.id;

    const title = document.createElement('p');
    title.className = 'rule-title';
    title.textContent = rule.name?.trim() || `규칙 ${rule.id.slice(0, 8)}`;

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
    toggleInput.dataset.action = 'toggle-rule';
    toggleInput.dataset.ruleId = rule.id;
    toggleLabel.appendChild(toggleInput);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = '삭제';
    deleteBtn.dataset.action = 'delete-rule';
    deleteBtn.dataset.ruleId = rule.id;

    actions.appendChild(toggleLabel);
    actions.appendChild(deleteBtn);

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(actions);
    ruleListEl.appendChild(item);
  });
}

function renderSettings(settings: Settings): void {
  settingsState = settings;
  renderRules(settings);
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

async function triggerApplyRulesNow(): Promise<void> {
  const activeTab = await queryActiveTab();
  const tabId = activeTab?.id;
  if (!tabId) {
    return;
  }

  await sendMessage<{ ok: boolean }>(tabId, { type: 'APPLY_RULES_NOW' });
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
    renderHiddenJobs([]);
    return;
  }

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
  try {
    ruleErrorEl.textContent = '';
    const next = removeJobIdFromRules(settingsState, jobId);
    await saveSettings(next);
    renderSettings(next);

    if (activeTabId) {
      await sendMessage<{ restoredCount: number }>(activeTabId, {
        type: 'UNHIDE_JOB',
        jobId
      });
    }
    await triggerApplyRulesNow();

    await refreshHiddenData();
  } catch {
    ruleErrorEl.textContent = '다시 활성화 처리 중 오류가 발생했습니다.';
  }
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
    matchMode: 'OR',
    action: 'hide'
  };

  try {
    const next = await upsertRule(rule);
    renderSettings(next);
    await triggerApplyRulesNow();
    await refreshHiddenData();

    formEl.reset();
  } catch {
    ruleErrorEl.textContent = '규칙 저장 중 오류가 발생했습니다.';
  }
}

async function handleRuleListInteraction(event: Event): Promise<void> {
  const target = event.target as HTMLElement;
  const ruleId = target.dataset.ruleId;
  const action = target.dataset.action;
  if (!ruleId || !action) {
    return;
  }

  try {
    ruleErrorEl.textContent = '';
    if (action === 'delete-rule') {
      const next = await deleteRule(ruleId);
      renderSettings(next);
      await triggerApplyRulesNow();
      await refreshHiddenData();
      return;
    }

    if (action === 'toggle-rule' && target instanceof HTMLInputElement) {
      const next = await toggleRule(ruleId, target.checked);
      renderSettings(next);
      await triggerApplyRulesNow();
      await refreshHiddenData();
    }
  } catch {
    ruleErrorEl.textContent = '규칙 처리 중 오류가 발생했습니다.';
  }
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

  ruleListEl.addEventListener('click', (event) => {
    void handleRuleListInteraction(event);
  });

  ruleListEl.addEventListener('change', (event) => {
    void handleRuleListInteraction(event);
  });

  exportSettingsBtnEl.addEventListener('click', () => {
    void (async () => {
      try {
        ruleErrorEl.textContent = '';
        const settings = await getSettings();
        const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `wanted-manager-settings-${Date.now()}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      } catch {
        ruleErrorEl.textContent = '내보내기 중 오류가 발생했습니다.';
      }
    })();
  });

  importSettingsBtnEl.addEventListener('click', () => {
    importSettingsFileEl.click();
  });

  importSettingsFileEl.addEventListener('change', () => {
    void (async () => {
      const file = importSettingsFileEl.files?.[0];
      if (!file) {
        return;
      }

      try {
        ruleErrorEl.textContent = '';
        const text = await file.text();
        const parsed = JSON.parse(text) as Partial<Settings>;
        const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
        const next: Settings = {
          rules: rules,
          detailPageEnabled: Boolean(parsed.detailPageEnabled),
          debug: Boolean(parsed.debug)
        };

        await saveSettings(next);
        renderSettings(next);
        await triggerApplyRulesNow();
        await refreshHiddenData();
      } catch {
        ruleErrorEl.textContent = '가져오기 실패: JSON 형식을 확인하세요.';
      } finally {
        importSettingsFileEl.value = '';
      }
    })();
  });
}

async function bootstrap(): Promise<void> {
  const settings = await getSettings();
  renderSettings(settings);
  bindEvents();
  await refreshHiddenData();
}

void bootstrap();
