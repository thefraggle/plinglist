import {
  getAllOpenTasks,
  getDueReminderTasks,
  getListTasks,
  getMyDaySuggestions,
  getMyDayTasks,
  getPlannedTasks,
  getStarredTasks,
  sortTasksForView,
  type RecurrencePattern,
  type SmartViewId,
  type TaskItem,
} from '../../packages/core/src/index.ts';
import { CC0_CHIME_NOTES, CHIME_MASTER_GAIN } from './audio.ts';
import { t, type TranslationKey } from './i18n.ts';
import { PlinglistStore, getLocalIsoDate } from './store.ts';

let audioContext: AudioContext | null = null;
let brandPlingBuffer: AudioBuffer | null = null;
let brandPlingLoaded = false;
let supportsDisplayTransition: boolean | undefined;

function canTransitionDisplay(): boolean {
  if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
  if (!window.CSS?.supports?.('transition-behavior', 'allow-discrete') || !document.body) {
    return false;
  }
  const probe = document.createElement('div');
  probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = 'none';
  supportsDisplayTransition = getComputedStyle(probe).display === 'block';
  probe.remove();
  return supportsDisplayTransition;
}

function supportsTopLayerExit(): boolean {
  return Boolean(window.CSS?.supports?.('overlay', 'auto') && canTransitionDisplay());
}

async function closeTopLayer(dialog: HTMLDialogElement): Promise<void> {
  if (!dialog.open) return;
  if (!supportsTopLayerExit()) {
    dialog.setAttribute('data-closing', '');
    const animations = dialog.getAnimations({ subtree: true });
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise((resolve) => setTimeout(resolve, 400)),
      ]);
    }
    if (!dialog.hasAttribute('data-closing')) return;
    dialog.removeAttribute('data-closing');
  }
  dialog.close();
}

function wireDialogLightDismiss(dialog: HTMLDialogElement): void {
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    void closeTopLayer(dialog);
  });

  if (!('closedBy' in HTMLDialogElement.prototype)) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (!inside) {
        void closeTopLayer(dialog);
      }
    });
  }
}

async function ensureBrandPlingLoaded(ctx: AudioContext): Promise<AudioBuffer | null> {
  if (brandPlingLoaded) return brandPlingBuffer;
  brandPlingLoaded = true;
  try {
    const response = await fetch('./audio/pling.wav');
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || contentType.includes('text/html')) {
      return null;
    }
    const bytes = await response.arrayBuffer();
    brandPlingBuffer = await ctx.decodeAudioData(bytes);
    return brandPlingBuffer;
  } catch {
    return null;
  }
}

function playSynthChime(ctx: AudioContext): void {
  let startTime = ctx.currentTime;
  for (const note of CC0_CHIME_NOTES) {
    const osc = ctx.createOscillator();
    const harmonic = ctx.createOscillator();
    const gain = ctx.createGain();
    const harmonicGain = ctx.createGain();
    osc.type = 'sine';
    harmonic.type = 'triangle';
    osc.frequency.setValueAtTime(note.frequencyHz, startTime);
    harmonic.frequency.setValueAtTime(note.frequencyHz * 2, startTime);
    gain.gain.setValueAtTime(0.001, startTime);
    gain.gain.exponentialRampToValueAtTime(note.gain, startTime + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + note.durationMs / 1000);
    harmonicGain.gain.setValueAtTime(0.001, startTime);
    harmonicGain.gain.exponentialRampToValueAtTime(note.gain * 0.25, startTime + 0.006);
    harmonicGain.gain.exponentialRampToValueAtTime(0.0001, startTime + (note.durationMs * 0.65) / 1000);
    osc.connect(gain);
    harmonic.connect(harmonicGain);
    gain.connect(ctx.destination);
    harmonicGain.connect(ctx.destination);
    osc.start(startTime);
    harmonic.start(startTime);
    osc.stop(startTime + note.durationMs / 1000);
    harmonic.stop(startTime + note.durationMs / 1000);
    startTime += 0.055;
  }
}

function playBufferChime(ctx: AudioContext, buffer: AudioBuffer): void {
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(CHIME_MASTER_GAIN, ctx.currentTime);
  source.buffer = buffer;
  source.connect(gain);
  gain.connect(ctx.destination);
  source.start();
}

function playPlingChime(): void {
  const AudioCtx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return;
  if (!audioContext) {
    audioContext = new AudioCtx();
  }
  if (audioContext.state === 'suspended') {
    void audioContext.resume();
  }
  const ctx = audioContext;

  if (brandPlingBuffer) {
    playBufferChime(ctx, brandPlingBuffer);
    return;
  }

  if (!brandPlingLoaded) {
    void ensureBrandPlingLoaded(ctx).then((buffer) => {
      if (buffer) {
        playBufferChime(ctx, buffer);
      } else {
        playSynthChime(ctx);
      }
    });
    return;
  }

  playSynthChime(ctx);
}

const SAMPLE_WUNDERLIST_JSON = JSON.stringify(
  {
    data: {
      lists: [{ id: 501, title: 'Wochenende / Weekend' }],
      tasks: [
        {
          id: 9001,
          list_id: 501,
          title: 'Kaffeebohnen rösten lassen',
          starred: true,
          due_date: getLocalIsoDate(),
          recurrence_type: 'week',
        },
        {
          id: 9002,
          list_id: 501,
          title: 'MS To Do Export sichern',
          starred: false,
        },
      ],
      subtasks: [
        { id: 1, task_id: 9001, title: 'Espresso-Mahlgrad prüfen', completed: false },
      ],
      notes: [{ task_id: 9001, content: 'Importiert per 1-Klick-Migration' }],
    },
  },
  null,
  2,
);

function initApp(): void {
  let scheduleBackgroundSync = (): void => {};
  const browserLocale = navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en';
  const initialPairKey = new URLSearchParams(window.location.search).get('pair')?.trim();
  const store = new PlinglistStore({
    storage: window.localStorage,
    locale: browserLocale,
    syncKey: initialPairKey && initialPairKey.length >= 8 ? initialPairKey : undefined,
    onLocalMutation: () => scheduleBackgroundSync(),
  });

  let activeView: SmartViewId = 'my-day';
  let activeListId = store.getDefaultTasksListId();
  let quickAddStarred = false;
  let editingTaskId: string | null = null;
  let hasSyncedOnce = false;
  let syncInFlight = false;
  let syncDebounceTimer: number | undefined;

  const sidebar = document.getElementById('appSidebar') as HTMLElement;
  const sidebarBackdrop = document.getElementById('sidebarBackdrop') as HTMLElement;
  const openSidebarBtn = document.getElementById('openSidebarBtn') as HTMLButtonElement;

  function openMobileDrawer(): void {
    sidebar.classList.add('is-open');
    sidebarBackdrop.hidden = false;
    openSidebarBtn.setAttribute('aria-expanded', 'true');
  }

  function closeMobileDrawer(): void {
    sidebar.classList.remove('is-open');
    sidebarBackdrop.hidden = true;
    openSidebarBtn.setAttribute('aria-expanded', 'false');
  }

  openSidebarBtn.addEventListener('click', openMobileDrawer);
  document.getElementById('closeSidebarBtn')?.addEventListener('click', closeMobileDrawer);
  document.getElementById('mobileListsBtn')?.addEventListener('click', openMobileDrawer);
  sidebarBackdrop.addEventListener('click', closeMobileDrawer);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && sidebar.classList.contains('is-open')) {
      closeMobileDrawer();
    }
  });

  function updateSyncLabels(): void {
    const statusText = !navigator.onLine
      ? t(store.locale, 'sync.offline')
      : hasSyncedOnce
        ? t(store.locale, 'sync.synced')
        : t(store.locale, 'sync.localReady');

    const syncLabel = document.getElementById('syncStatusText');
    if (syncLabel) {
      syncLabel.hidden = navigator.onLine;
      syncLabel.textContent = statusText;
    }

    const settingsSyncLabel = document.getElementById('settingsSyncStatusText');
    if (settingsSyncLabel) {
      settingsSyncLabel.textContent = statusText;
    }
  }

  async function runSyncNow(): Promise<void> {
    if (!navigator.onLine || syncInFlight) return;
    syncInFlight = true;
    try {
      const result = await store.syncWithServer();
      if (result.synced) {
        hasSyncedOnce = true;
        if (result.revokedLists > 0) {
          if (
            activeView === 'list' &&
            !store.getActiveLists().some((l) => l.id === activeListId)
          ) {
            activeView = 'my-day';
            activeListId = store.getDefaultTasksListId();
          }
          if (
            editingTaskId &&
            !store.tasks.some((task) => task.id === editingTaskId && task.deletedAt === null)
          ) {
            editingTaskId = null;
            void closeTopLayer(taskDialog);
          }
          showToast(t(store.locale, 'toast.shareRevoked'));
        }
        if (result.pulledLists > 0 || result.pulledTasks > 0 || result.revokedLists > 0) {
          render();
        } else {
          updateSyncLabels();
        }
      }
    } finally {
      syncInFlight = false;
    }
  }

  scheduleBackgroundSync = (): void => {
    window.clearTimeout(syncDebounceTimer);
    syncDebounceTimer = window.setTimeout(() => {
      void runSyncNow();
    }, 350);
  };

  const shareDialog = document.getElementById('shareDialog') as HTMLDialogElement;
  const renameListDialog = document.getElementById('renameListDialog') as HTMLDialogElement;
  const taskDialog = document.getElementById('taskDetailDialog') as HTMLDialogElement;
  const importDialog = document.getElementById('importDialog') as HTMLDialogElement;
  const settingsDialog = document.getElementById('settingsDialog') as HTMLDialogElement;
  const confirmDeleteDialog = document.getElementById('confirmDeleteDialog') as HTMLDialogElement;
  [
    shareDialog,
    renameListDialog,
    taskDialog,
    importDialog,
    settingsDialog,
    confirmDeleteDialog,
  ].forEach(wireDialogLightDismiss);
  const firedReminderKeys = new Set<string>();
  let pendingDeleteAction: (() => void) | null = null;

  function requestDeleteConfirmation(message: string, onConfirm: () => void): void {
    if (!store.preferences.confirmBeforeDelete) {
      onConfirm();
      return;
    }
    pendingDeleteAction = onConfirm;
    (document.getElementById('confirmDeleteMessage') as HTMLElement).textContent = message;
    confirmDeleteDialog.showModal();
  }

  document.getElementById('confirmDeleteSubmitBtn')?.addEventListener('click', () => {
    const action = pendingDeleteAction;
    pendingDeleteAction = null;
    void closeTopLayer(confirmDeleteDialog);
    action?.();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-close-dialog]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.closeDialog;
      const target = targetId
        ? (document.getElementById(targetId) as HTMLDialogElement | null)
        : null;
      if (target) void closeTopLayer(target);
    });
  });

  function showToast(message: string): void {
    const region = document.getElementById('toastRegion');
    if (!region) return;
    const item = document.createElement('div');
    item.className = 'toast';
    item.textContent = message;
    region.appendChild(item);
    window.setTimeout(() => item.remove(), 2600);
  }

  function applyTranslations(): void {
    document.documentElement.lang = store.locale;
    document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
      const key = el.dataset.i18n as TranslationKey;
      el.textContent = t(store.locale, key);
    });
    document
      .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-i18n-placeholder]')
      .forEach((el) => {
        const key = el.dataset.i18nPlaceholder as TranslationKey;
        el.placeholder = t(store.locale, key);
      });
    document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => {
      const key = el.dataset.i18nAria as TranslationKey;
      const label = t(store.locale, key);
      el.setAttribute('aria-label', label);
      el.title = label;
    });

    updateSyncLabels();
  }

  function createTaskElement(task: TaskItem, isSuggestion = false): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `task-row${task.completed ? ' is-completed' : ''}`;

    const leftBtn = document.createElement('button');
    leftBtn.type = 'button';
    if (isSuggestion) {
      leftBtn.className = 'btn-secondary btn-compact';
      leftBtn.textContent = '+';
      leftBtn.title = t(store.locale, 'myDay.addToMyDay');
      leftBtn.setAttribute('aria-label', t(store.locale, 'myDay.addToMyDay'));
      leftBtn.addEventListener('click', () => {
        store.toggleTaskMyDay(task.id, getLocalIsoDate());
        render();
      });
    } else {
      leftBtn.className = 'task-check-btn';
      leftBtn.setAttribute('aria-label', t(store.locale, 'task.completeAria'));
      const circle = document.createElement('span');
      circle.className = 'task-check-circle';
      circle.setAttribute('aria-hidden', 'true');
      circle.textContent = task.completed ? '✓' : '';
      leftBtn.appendChild(circle);

      leftBtn.addEventListener('click', () => {
        const wasCompleted = task.completed;
        const { nextRecurringTask } = store.toggleTaskCompleted(task.id, getLocalIsoDate());
        if (!wasCompleted) {
          if (store.soundEnabled) playPlingChime();
          navigator.vibrate?.(15);
          showToast(
            nextRecurringTask
              ? `${t(store.locale, 'toast.plingDone')} (${t(store.locale, 'toast.nextRecurring')})`
              : t(store.locale, 'toast.plingDone'),
          );
        }
        render();
      });
    }

    const mainBtn = document.createElement('button');
    mainBtn.type = 'button';
    mainBtn.className = 'task-main-btn';
    mainBtn.addEventListener('click', () => openTaskDetail(task.id));

    const titleSpan = document.createElement('span');
    titleSpan.className = 'task-title';
    titleSpan.textContent = task.title;
    mainBtn.appendChild(titleSpan);

    const metaParts: string[] = [];
    if (task.steps.length > 0) {
      const doneSteps = task.steps.filter((s) => s.completed).length;
      metaParts.push(`${doneSteps}/${task.steps.length} ${t(store.locale, 'task.steps')}`);
    }
    if (task.dueDate) metaParts.push(task.dueDate);
    if (task.recurrence) metaParts.push(`↻ ${task.recurrence}`);
    if (task.note.trim()) metaParts.push('📝');

    if (metaParts.length > 0) {
      const metaDiv = document.createElement('div');
      metaDiv.className = 'task-meta';
      metaDiv.textContent = metaParts.join(' · ');
      mainBtn.appendChild(metaDiv);
    }

    const starBtn = document.createElement('button');
    starBtn.type = 'button';
    starBtn.className = 'task-star-btn';
    starBtn.setAttribute('aria-pressed', String(task.starred));
    starBtn.setAttribute('aria-label', t(store.locale, 'task.starAria'));
    starBtn.textContent = task.starred ? '★' : '☆';
    starBtn.addEventListener('click', () => {
      store.toggleTaskStarred(task.id);
      render();
    });

    li.append(leftBtn, mainBtn, starBtn);
    return li;
  }

  function render(): void {
    applyTranslations();
    const today = getLocalIsoDate();
    const activeLists = store.getActiveLists();
    const customLists = store.getCustomLists();
    const defaultTasksId = store.getDefaultTasksListId();
    if (!activeLists.some((l) => l.id === activeListId)) {
      activeListId = customLists[0]?.id ?? defaultTasksId;
    }

    const myDayItems = getMyDayTasks(
      store.tasks,
      today,
      store.preferences.autoAddDueTodayToMyDay,
    );
    const starredItems = getStarredTasks(store.tasks);
    const plannedItems = getPlannedTasks(store.tasks);
    const allItems = getAllOpenTasks(store.tasks);
    const systemTasksItems = getListTasks(store.tasks, defaultTasksId);
    const suggestions = getMyDaySuggestions(
      store.tasks,
      today,
      store.preferences.autoAddDueTodayToMyDay,
    );

    const openStarredCount = starredItems.length;
    const openPlannedCount = plannedItems.length;
    const openAllCount = allItems.length;
    const openSystemTasksCount = systemTasksItems.filter((item) => !item.completed).length;

    (document.getElementById('countMyDay') as HTMLElement).textContent = String(
      myDayItems.filter((item) => !item.completed).length,
    );
    (document.getElementById('countStarred') as HTMLElement).textContent = String(openStarredCount);
    (document.getElementById('countPlanned') as HTMLElement).textContent = String(openPlannedCount);
    (document.getElementById('countAll') as HTMLElement).textContent = String(openAllCount);
    (document.getElementById('countTasks') as HTMLElement).textContent = String(openSystemTasksCount);

    const navStarred = document.getElementById('navSmartStarred') as HTMLButtonElement | null;
    const navPlanned = document.getElementById('navSmartPlanned') as HTMLButtonElement | null;
    const navAll = document.getElementById('navSmartAll') as HTMLButtonElement | null;
    if (navStarred) {
      navStarred.hidden =
        store.preferences.autoHideEmptySmartLists &&
        openStarredCount === 0 &&
        activeView !== 'starred';
    }
    if (navPlanned) {
      navPlanned.hidden =
        store.preferences.autoHideEmptySmartLists &&
        openPlannedCount === 0 &&
        activeView !== 'planned';
    }
    if (navAll) {
      const hiddenByPref = !store.preferences.showAllSmartList;
      const hiddenByEmpty = store.preferences.autoHideEmptySmartLists && openAllCount === 0;
      navAll.hidden = (hiddenByPref || hiddenByEmpty) && activeView !== 'all';
    }

    document.querySelectorAll<HTMLButtonElement>('.sidebar .nav-item[data-view]').forEach((btn) => {
      const isCurrent = btn.dataset.view === activeView;
      btn.setAttribute('aria-current', isCurrent ? 'page' : 'false');
    });

    document.querySelectorAll<HTMLButtonElement>('[data-mobile-view]').forEach((btn) => {
      const isCurrent = btn.dataset.mobileView === activeView;
      btn.setAttribute('aria-current', isCurrent ? 'page' : 'false');
    });
    const mobileListsBtn = document.getElementById('mobileListsBtn');
    mobileListsBtn?.setAttribute(
      'aria-current',
      activeView === 'lists' || activeView === 'tasks' || activeView === 'all' ? 'page' : 'false',
    );

    const listsNav = document.getElementById('customListsNav') as HTMLElement;
    listsNav.replaceChildren();
    for (const list of customLists) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-item';
      btn.setAttribute(
        'aria-current',
        activeView === 'lists' && activeListId === list.id ? 'page' : 'false',
      );

      const labelSpan = document.createElement('span');
      labelSpan.textContent = list.shared
        ? `${list.title} (${t(store.locale, 'list.sharedBadge')})`
        : list.title;
      const countSpan = document.createElement('span');
      countSpan.className = 'nav-count';
      countSpan.textContent = String(
        getListTasks(store.tasks, list.id).filter((item) => !item.completed).length,
      );

      btn.append(labelSpan, countSpan);
      btn.addEventListener('click', () => {
        activeView = 'lists';
        activeListId = list.id;
        closeMobileDrawer();
        render();
      });
      listsNav.appendChild(btn);
    }

    const viewTitle = document.getElementById('viewTitle') as HTMLElement;
    const viewSubtitle = document.getElementById('viewSubtitle') as HTMLElement;
    const suggestionsSection = document.getElementById('suggestionsSection') as HTMLElement;
    const currentList =
      activeView === 'lists' ? customLists.find((l) => l.id === activeListId) : undefined;
    const isCustomList = Boolean(currentList);
    const renameListBtn = document.getElementById('renameListBtn') as HTMLButtonElement | null;
    const deleteListBtn = document.getElementById('deleteListBtn') as HTMLButtonElement | null;
    const shareListBtn = document.getElementById('shareListBtn') as HTMLButtonElement | null;
    if (renameListBtn) {
      renameListBtn.hidden = !isCustomList;
    }
    if (shareListBtn) {
      shareListBtn.hidden = !isCustomList;
    }
    if (deleteListBtn) {
      deleteListBtn.hidden = !isCustomList || Boolean(currentList?.shared);
    }

    let visibleTasks: TaskItem[] = [];
    suggestionsSection.hidden = activeView !== 'my-day' || suggestions.length === 0;

    if (activeView === 'my-day') {
      viewTitle.textContent = t(store.locale, 'nav.myDay');
      viewSubtitle.textContent = `${today} · ${t(store.locale, 'myDay.resetHint')}`;
      visibleTasks = myDayItems;
    } else if (activeView === 'starred') {
      viewTitle.textContent = t(store.locale, 'nav.starred');
      viewSubtitle.textContent = '';
      visibleTasks = starredItems;
    } else if (activeView === 'planned') {
      viewTitle.textContent = t(store.locale, 'nav.planned');
      viewSubtitle.textContent = '';
      visibleTasks = plannedItems;
    } else if (activeView === 'all') {
      viewTitle.textContent = t(store.locale, 'nav.all');
      viewSubtitle.textContent = '';
      visibleTasks = allItems;
    } else if (activeView === 'tasks') {
      viewTitle.textContent = t(store.locale, 'nav.tasks');
      viewSubtitle.textContent = '';
      visibleTasks = systemTasksItems;
    } else {
      viewTitle.textContent = currentList?.title ?? t(store.locale, 'nav.lists');
      viewSubtitle.textContent = currentList?.shared ? t(store.locale, 'list.sharedBadge') : '';
      visibleTasks = currentList ? getListTasks(store.tasks, currentList.id) : [];
    }

    const suggestionsList = document.getElementById('suggestionsList') as HTMLUListElement;
    suggestionsList.replaceChildren(...suggestions.map((item) => createTaskElement(item, true)));
    (document.getElementById('suggestionsCount') as HTMLElement).textContent = String(
      suggestions.length,
    );

    const openTasks = sortTasksForView(
      visibleTasks.filter((item) => !item.completed),
      store.preferences.moveStarredToTop,
    );
    const doneTasks = visibleTasks.filter((item) => item.completed);

    const activeListEl = document.getElementById('activeTasksList') as HTMLUListElement;
    activeListEl.replaceChildren(...openTasks.map((item) => createTaskElement(item)));

    const emptyEl = document.getElementById('emptyStateText') as HTMLElement;
    emptyEl.hidden = openTasks.length > 0;

    const completedSection = document.getElementById('completedSection') as HTMLElement;
    const completedListEl = document.getElementById('completedTasksList') as HTMLUListElement;
    completedSection.hidden = doneTasks.length === 0;
    (document.getElementById('completedCount') as HTMLElement).textContent = String(doneTasks.length);
    completedListEl.replaceChildren(...doneTasks.map((item) => createTaskElement(item)));
  }

  function refreshShareDialogState(listId: string): void {
    const urlInput = document.getElementById('shareInviteUrlInput') as HTMLInputElement;
    const unshareBtn = document.getElementById('unshareListBtn') as HTMLButtonElement;
    const existingUrl = store.getInviteUrl(listId, window.location.origin);
    if (existingUrl) {
      urlInput.value = existingUrl;
      urlInput.placeholder = '';
      unshareBtn.hidden = false;
    } else {
      urlInput.value = '';
      urlInput.placeholder = t(store.locale, 'share.notSharedYet');
      unshareBtn.hidden = true;
    }
  }

  function openShareModal(): void {
    const shareableLists = store
      .getActiveLists()
      .filter((list) => !store.isSystemTasksList(list.id));
    const selectEl = document.getElementById('shareListSelect') as HTMLSelectElement;
    selectEl.replaceChildren();
    for (const list of shareableLists) {
      const opt = document.createElement('option');
      opt.value = list.id;
      opt.textContent = list.title;
      selectEl.appendChild(opt);
    }

    const initialListId =
      activeView === 'lists' && shareableLists.some((l) => l.id === activeListId)
        ? activeListId
        : (shareableLists[0]?.id ?? '');
    if (initialListId) {
      selectEl.value = initialListId;
      refreshShareDialogState(initialListId);
    } else {
      (document.getElementById('shareInviteUrlInput') as HTMLInputElement).value = '';
      (document.getElementById('unshareListBtn') as HTMLButtonElement).hidden = true;
    }
    (document.getElementById('sharePairUrlInput') as HTMLInputElement).value =
      store.getPairingUrl(window.location.origin);
    (document.getElementById('shareSyncKeyCode') as HTMLElement).textContent = store.syncKey;

    const canNativeShare = typeof navigator.share === 'function';
    (document.getElementById('nativeShareInviteBtn') as HTMLButtonElement).hidden = !canNativeShare;
    (document.getElementById('nativeSharePairBtn') as HTMLButtonElement).hidden = !canNativeShare;

    shareDialog.showModal();
  }

  function renderDetailSteps(task: TaskItem): void {
    const stepsList = document.getElementById('detailStepsList') as HTMLUListElement;
    stepsList.replaceChildren();
    for (const step of task.steps) {
      const li = document.createElement('li');
      li.className = 'step-row';

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'btn-secondary btn-compact';
      toggleBtn.textContent = step.completed ? '✓' : '○';
      toggleBtn.addEventListener('click', () => {
        const updated = store.toggleTaskStep(task.id, step.id);
        renderDetailSteps(updated);
        render();
      });

      const title = document.createElement('span');
      title.className = step.completed ? 'step-title is-completed' : 'step-title';
      title.textContent = step.title;

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-ghost btn-compact';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        const updated = store.deleteTaskStep(task.id, step.id);
        renderDetailSteps(updated);
        render();
      });

      li.append(toggleBtn, title, removeBtn);
      stepsList.appendChild(li);
    }
  }

  function openTaskDetail(taskId: string): void {
    const task = store.tasks.find((item) => item.id === taskId && item.deletedAt === null);
    if (!task) return;
    editingTaskId = task.id;
    const today = getLocalIsoDate();

    (document.getElementById('detailTitleInput') as HTMLInputElement).value = task.title;
    (document.getElementById('detailDueDateInput') as HTMLInputElement).value = task.dueDate ?? '';
    (document.getElementById('detailReminderInput') as HTMLInputElement).value =
      task.reminderAt ?? '';
    (document.getElementById('detailRecurrenceSelect') as HTMLSelectElement).value =
      task.recurrence ?? '';
    (document.getElementById('detailNoteInput') as HTMLTextAreaElement).value = task.note;

    const myDayBtn = document.getElementById('detailMyDayBtn') as HTMLButtonElement;
    myDayBtn.textContent =
      task.myDayDate === today
        ? t(store.locale, 'myDay.removeFromMyDay')
        : t(store.locale, 'myDay.addToMyDay');

    const starBtn = document.getElementById('detailStarBtn') as HTMLButtonElement;
    starBtn.textContent = `${task.starred ? '★' : '☆'} ${t(store.locale, 'nav.starred')}`;

    renderDetailSteps(task);
    taskDialog.showModal();
  }

  document.querySelectorAll<HTMLButtonElement>('.sidebar .nav-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeView = btn.dataset.view as SmartViewId;
      closeMobileDrawer();
      render();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-mobile-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeView = btn.dataset.mobileView as SmartViewId;
      render();
    });
  });

  document.getElementById('newListForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('newListInput') as HTMLInputElement;
    if (!input.value.trim()) return;
    const created = store.addList(input.value);
    input.value = '';
    activeView = 'lists';
    activeListId = created.id;
    closeMobileDrawer();
    render();
  });

  const newTaskStarBtn = document.getElementById('newTaskStarBtn') as HTMLButtonElement;
  newTaskStarBtn.addEventListener('click', () => {
    quickAddStarred = !quickAddStarred;
    newTaskStarBtn.setAttribute('aria-pressed', String(quickAddStarred));
    newTaskStarBtn.textContent = quickAddStarred ? '★' : '☆';
  });

  document.getElementById('addTaskForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const titleInput = document.getElementById('newTaskTitle') as HTMLInputElement;
    const dueInput = document.getElementById('newTaskDueDate') as HTMLInputElement;
    if (!titleInput.value.trim()) return;

    const targetListId =
      activeView === 'lists' ? activeListId : store.getDefaultTasksListId();

    store.addTask({
      title: titleInput.value,
      listId: targetListId,
      starred: quickAddStarred || activeView === 'starred',
      myDayDate: activeView === 'my-day' ? getLocalIsoDate() : null,
      dueDate: dueInput.value || (activeView === 'planned' ? getLocalIsoDate() : null),
    });

    titleInput.value = '';
    dueInput.value = '';
    quickAddStarred = false;
    newTaskStarBtn.setAttribute('aria-pressed', 'false');
    newTaskStarBtn.textContent = '☆';
    render();
  });

  document.getElementById('renameListBtn')?.addEventListener('click', () => {
    const currentList = store.getActiveLists().find((l) => l.id === activeListId);
    if (!currentList) return;
    (document.getElementById('renameListInput') as HTMLInputElement).value = currentList.title;
    renameListDialog.showModal();
  });

  document.getElementById('renameListForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('renameListInput') as HTMLInputElement;
    if (!input.value.trim()) return;
    store.renameList(activeListId, input.value);
    void closeTopLayer(renameListDialog);
    showToast(t(store.locale, 'list.renamedToast'));
    render();
  });

  document.getElementById('deleteListBtn')?.addEventListener('click', () => {
    const currentList = store.getActiveLists().find((l) => l.id === activeListId);
    if (
      !currentList ||
      currentList.shared ||
      store.isSystemTasksList(activeListId) ||
      store.getActiveLists().length <= 1
    ) {
      return;
    }
    requestDeleteConfirmation(t(store.locale, 'confirm.deleteListPrompt'), () => {
      store.deleteList(currentList.id);
      activeView = 'my-day';
      activeListId = store.getDefaultTasksListId();
      showToast(t(store.locale, 'list.deletedToast'));
      render();
    });
  });

  document.getElementById('copySettingsPairUrlBtn')?.addEventListener('click', async () => {
    const pairUrl = store.getPairingUrl(window.location.origin);
    await navigator.clipboard?.writeText(pairUrl).catch(() => undefined);
    showToast(t(store.locale, 'share.pairCopied'));
  });

  document.getElementById('shareListBtn')?.addEventListener('click', openShareModal);
  document.getElementById('shareListSelect')?.addEventListener('change', (event) => {
    refreshShareDialogState((event.target as HTMLSelectElement).value);
  });

  document.getElementById('copyInviteUrlBtn')?.addEventListener('click', async () => {
    const listId = (document.getElementById('shareListSelect') as HTMLSelectElement).value;
    const { inviteUrl } = store.shareList(listId, window.location.origin);
    refreshShareDialogState(listId);
    render();
    void runSyncNow();
    await navigator.clipboard?.writeText(inviteUrl).catch(() => undefined);
    showToast(t(store.locale, 'list.inviteCopied'));
  });

  document.getElementById('copyPairUrlBtn')?.addEventListener('click', async () => {
    const val = (document.getElementById('sharePairUrlInput') as HTMLInputElement).value;
    await navigator.clipboard?.writeText(val).catch(() => undefined);
    showToast(t(store.locale, 'share.pairCopied'));
  });

  document.getElementById('nativeShareInviteBtn')?.addEventListener('click', async () => {
    const listId = (document.getElementById('shareListSelect') as HTMLSelectElement).value;
    const { inviteUrl } = store.shareList(listId, window.location.origin);
    refreshShareDialogState(listId);
    render();
    void runSyncNow();
    await navigator
      .share?.({ title: 'Plinglist', text: t(store.locale, 'share.listSectionTitle'), url: inviteUrl })
      .catch(() => undefined);
  });

  document.getElementById('unshareListBtn')?.addEventListener('click', () => {
    const listId = (document.getElementById('shareListSelect') as HTMLSelectElement).value;
    store.unshareList(listId);
    refreshShareDialogState(listId);
    render();
    void runSyncNow();
    showToast(t(store.locale, 'list.unsharedToast'));
  });

  document.getElementById('nativeSharePairBtn')?.addEventListener('click', async () => {
    const url = (document.getElementById('sharePairUrlInput') as HTMLInputElement).value;
    await navigator
      .share?.({ title: 'Plinglist Sync', text: t(store.locale, 'share.pairSectionTitle'), url })
      .catch(() => undefined);
  });

  document.getElementById('detailMyDayBtn')?.addEventListener('click', () => {
    if (!editingTaskId) return;
    store.toggleTaskMyDay(editingTaskId, getLocalIsoDate());
    openTaskDetail(editingTaskId);
    render();
  });

  document.getElementById('detailStarBtn')?.addEventListener('click', () => {
    if (!editingTaskId) return;
    store.toggleTaskStarred(editingTaskId);
    openTaskDetail(editingTaskId);
    render();
  });

  document.getElementById('detailAddStepBtn')?.addEventListener('click', () => {
    if (!editingTaskId) return;
    const input = document.getElementById('detailNewStepInput') as HTMLInputElement;
    if (!input.value.trim()) return;
    const updated = store.addTaskStep(editingTaskId, input.value);
    input.value = '';
    renderDetailSteps(updated);
    render();
  });

  document.getElementById('detailDeleteBtn')?.addEventListener('click', () => {
    if (!editingTaskId) return;
    const taskIdToDelete = editingTaskId;
    requestDeleteConfirmation(t(store.locale, 'confirm.deleteTaskPrompt'), () => {
      store.deleteTask(taskIdToDelete);
      editingTaskId = null;
      void closeTopLayer(taskDialog);
      render();
    });
  });

  document.getElementById('taskDetailForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!editingTaskId) return;
    const recurrenceVal = (
      document.getElementById('detailRecurrenceSelect') as HTMLSelectElement
    ).value;
    const reminderAt =
      (document.getElementById('detailReminderInput') as HTMLInputElement).value || null;
    if (reminderAt && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => undefined);
    }
    store.updateTask(editingTaskId, {
      title: (document.getElementById('detailTitleInput') as HTMLInputElement).value,
      dueDate: (document.getElementById('detailDueDateInput') as HTMLInputElement).value || null,
      reminderAt,
      recurrence: (recurrenceVal || null) as RecurrencePattern | null,
      note: (document.getElementById('detailNoteInput') as HTMLTextAreaElement).value,
    });
    void closeTopLayer(taskDialog);
    render();
  });

  document.getElementById('openImportBtn')?.addEventListener('click', () => {
    closeMobileDrawer();
    if (settingsDialog.open) {
      settingsDialog.close();
    }
    (document.getElementById('importErrorText') as HTMLElement).hidden = true;
    importDialog.showModal();
  });

  document.getElementById('importFileInput')?.addEventListener('change', async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    (document.getElementById('importJsonInput') as HTMLTextAreaElement).value = await file.text();
  });

  document.getElementById('loadSampleImportBtn')?.addEventListener('click', () => {
    (document.getElementById('importJsonInput') as HTMLTextAreaElement).value =
      SAMPLE_WUNDERLIST_JSON;
  });

  document.getElementById('importForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const textarea = document.getElementById('importJsonInput') as HTMLTextAreaElement;
    const errEl = document.getElementById('importErrorText') as HTMLElement;
    try {
      const stats = store.importJson(textarea.value);
      errEl.hidden = true;
      textarea.value = '';
      void closeTopLayer(importDialog);
      showToast(
        `${t(store.locale, 'importer.success')}: +${stats.importedLists} / +${stats.importedTasks}`,
      );
      render();
    } catch {
      errEl.textContent = t(store.locale, 'importer.error');
      errEl.hidden = false;
    }
  });

  function selectSettingsTab(tabName: 'general' | 'lists' | 'sync'): void {
    document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]').forEach((tab) => {
      tab.setAttribute('aria-selected', String(tab.dataset.settingsTab === tabName));
    });
    document.querySelectorAll<HTMLElement>('[data-settings-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.settingsPanel !== tabName;
    });
  }

  document.querySelectorAll<HTMLButtonElement>('[data-settings-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.settingsTab as 'general' | 'lists' | 'sync' | undefined;
      if (target) selectSettingsTab(target);
    });
  });

  document.getElementById('openSettingsBtn')?.addEventListener('click', () => {
    closeMobileDrawer();
    selectSettingsTab('general');
    (document.getElementById('settingsLocaleSelect') as HTMLSelectElement).value = store.locale;
    const syncKeyInput = document.getElementById('settingsSyncKeyInput') as HTMLInputElement;
    syncKeyInput.value = store.syncKey;
    syncKeyInput.readOnly = true;
    const editSyncKeyBtn = document.getElementById('editSettingsSyncKeyBtn') as HTMLButtonElement | null;
    if (editSyncKeyBtn) editSyncKeyBtn.hidden = false;
    (document.getElementById('settingsServerUrlInput') as HTMLInputElement).value = store.serverUrl;
    (document.getElementById('settingsSoundCheckbox') as HTMLInputElement).checked =
      store.soundEnabled;
    (document.getElementById('settingsAddNewOnTopCheckbox') as HTMLInputElement).checked =
      store.preferences.addNewTasksOnTop;
    (document.getElementById('settingsMoveStarredToTopCheckbox') as HTMLInputElement).checked =
      store.preferences.moveStarredToTop;
    (document.getElementById('settingsConfirmDeleteCheckbox') as HTMLInputElement).checked =
      store.preferences.confirmBeforeDelete;
    (document.getElementById('settingsAutoDueTodayCheckbox') as HTMLInputElement).checked =
      store.preferences.autoAddDueTodayToMyDay;
    (document.getElementById('settingsAutoHideEmptyCheckbox') as HTMLInputElement).checked =
      store.preferences.autoHideEmptySmartLists;
    (document.getElementById('settingsShowAllListCheckbox') as HTMLInputElement).checked =
      store.preferences.showAllSmartList;
    updateSyncLabels();
    (document.getElementById('settingsErrorText') as HTMLElement).hidden = true;
    settingsDialog.showModal();
  });

  document.getElementById('editSettingsSyncKeyBtn')?.addEventListener('click', () => {
    const syncKeyInput = document.getElementById('settingsSyncKeyInput') as HTMLInputElement | null;
    const editBtn = document.getElementById('editSettingsSyncKeyBtn') as HTMLButtonElement | null;
    if (!syncKeyInput) return;
    syncKeyInput.readOnly = false;
    if (editBtn) editBtn.hidden = true;
    syncKeyInput.focus();
    syncKeyInput.select();
  });

  document.getElementById('manualSyncBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('manualSyncBtn') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try {
      await runSyncNow();
      updateSyncLabels();
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.getElementById('settingsForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const errEl = document.getElementById('settingsErrorText') as HTMLElement;
    const nextLocale = (document.getElementById('settingsLocaleSelect') as HTMLSelectElement)
      .value as 'de' | 'en';
    const nextSyncKey = (document.getElementById('settingsSyncKeyInput') as HTMLInputElement).value;
    const nextUrl = (document.getElementById('settingsServerUrlInput') as HTMLInputElement).value;
    const nextSound = (document.getElementById('settingsSoundCheckbox') as HTMLInputElement)
      .checked;
    const nextPrefs = {
      addNewTasksOnTop: (
        document.getElementById('settingsAddNewOnTopCheckbox') as HTMLInputElement
      ).checked,
      moveStarredToTop: (
        document.getElementById('settingsMoveStarredToTopCheckbox') as HTMLInputElement
      ).checked,
      confirmBeforeDelete: (
        document.getElementById('settingsConfirmDeleteCheckbox') as HTMLInputElement
      ).checked,
      autoAddDueTodayToMyDay: (
        document.getElementById('settingsAutoDueTodayCheckbox') as HTMLInputElement
      ).checked,
      autoHideEmptySmartLists: (
        document.getElementById('settingsAutoHideEmptyCheckbox') as HTMLInputElement
      ).checked,
      showAllSmartList: (
        document.getElementById('settingsShowAllListCheckbox') as HTMLInputElement
      ).checked,
    };

    try {
      store.setSyncKey(nextSyncKey);
    } catch {
      selectSettingsTab('sync');
      errEl.textContent = t(store.locale, 'settings.syncKeyInvalid');
      errEl.hidden = false;
      return;
    }

    try {
      store.setServerUrl(nextUrl);
      store.setLocale(nextLocale);
      store.setSoundEnabled(nextSound);
      store.setPreferences(nextPrefs);
      errEl.hidden = true;
      void closeTopLayer(settingsDialog);
      showToast(t(store.locale, 'toast.settingsSaved'));
      render();
      void runSyncNow();
    } catch {
      selectSettingsTab('sync');
      errEl.textContent = t(store.locale, 'settings.serverUrlInvalid');
      errEl.hidden = false;
    }
  });

  function checkDueReminders(): void {
    const dueTasks = getDueReminderTasks(store.tasks, Date.now(), firedReminderKeys);
    for (const task of dueTasks) {
      if (task.reminderAt) {
        firedReminderKeys.add(`${task.id}:${task.reminderAt}`);
      }
      if (store.soundEnabled) playPlingChime();
      showToast(`⏰ ${t(store.locale, 'task.reminderToastPrefix')}: ${task.title}`);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification('Plinglist', { body: task.title });
        } catch {
          // Ignore environments where Notification constructor is restricted
        }
      }
    }
  }

  window.addEventListener('online', () => {
    render();
    void runSyncNow();
  });
  window.addEventListener('offline', render);
  window.addEventListener('focus', () => {
    checkDueReminders();
    void runSyncNow();
  });
  window.addEventListener('storage', () => {
    scheduleBackgroundSync();
  });
  window.setInterval(() => {
    checkDueReminders();
    void runSyncNow();
  }, 15_000);

  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  }

  async function handleJoinParamOnStartup(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const pairKey = params.get('pair');
    if (pairKey) {
      try {
        store.setSyncKey(pairKey);
        params.delete('pair');
        const cleanQuery = params.toString();
        const cleanUrl = `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}${window.location.hash}`;
        window.history.replaceState({}, '', cleanUrl);
        await store.syncWithServer();
        hasSyncedOnce = true;
        showToast(t(store.locale, 'toast.devicePaired'));
        render();
      } catch {
        // Ignore invalid pairing key and proceed normally
      }
    }

    const joinToken = params.get('join');
    if (!joinToken) {
      void runSyncNow();
      return;
    }
    try {
      const joinedList = await store.joinSharedListByToken(joinToken);
      hasSyncedOnce = true;
      activeView = 'lists';
      activeListId = joinedList.id;
      params.delete('join');
      const cleanQuery = params.toString();
      const cleanUrl = `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', cleanUrl);
      showToast(`${joinedList.title} (${t(store.locale, 'list.sharedBadge')})`);
      render();
    } catch {
      void runSyncNow();
    }
  }

  render();
  checkDueReminders();
  void handleJoinParamOnStartup();
}

initApp();
