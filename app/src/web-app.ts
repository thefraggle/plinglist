import {
  filterTasksByQuery,
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
import {
  UMAMI_APP_WEBSITE_ID,
  UMAMI_SCRIPT_URL,
  extractInviteTokenFromInput,
  extractSyncKeyFromInput,
  getShareBaseOrigin,
  isNativeShellOrigin,
} from './config.ts';
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
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(note.frequencyHz, startTime);
    gain.gain.setValueAtTime(0.001, startTime);
    gain.gain.exponentialRampToValueAtTime(note.gain, startTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + note.durationMs / 1000);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + note.durationMs / 1000);
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
  const startupParams = new URLSearchParams(window.location.search);
  const store = new PlinglistStore({
    storage: window.localStorage,
    locale: browserLocale,
    onLocalMutation: () => scheduleBackgroundSync(),
  });

  const VALID_VIEWS: ReadonlySet<SmartViewId> = new Set([
    'my-day',
    'starred',
    'planned',
    'all',
    'tasks',
    'lists',
  ]);
  const initialViewParam = startupParams.get('view') as SmartViewId | null;
  let activeView: SmartViewId =
    initialViewParam && VALID_VIEWS.has(initialViewParam) ? initialViewParam : 'my-day';
  const initialListParam = startupParams.get('list')?.trim();
  let activeListId =
    initialListParam && store.getActiveLists().some((l) => l.id === initialListParam)
      ? initialListParam
      : store.getDefaultTasksListId();
  let searchQuery = startupParams.get('q') ?? '';
  let quickAddStarred = false;
  let editingTaskId: string | null = null;
  let hasSyncedOnce = false;
  let syncInFlight = false;
  let syncQueued = false;
  let syncDebounceTimer: number | undefined;
  let searchDebounceTimer: number | undefined;
  let lastAppliedLocale: string | null = null;
  let lastDrawerTrigger: HTMLElement | null = null;

  const sidebar = document.getElementById('appSidebar') as HTMLElement;
  const sidebarBackdrop = document.getElementById('sidebarBackdrop') as HTMLElement;
  const openSidebarBtn = document.getElementById('openSidebarBtn') as HTMLButtonElement;
  const mobileListsBtn = document.getElementById('mobileListsBtn') as HTMLButtonElement | null;
  const mainViewEl = document.querySelector<HTMLElement>('.main-view');
  const mobileBarEl = document.querySelector<HTMLElement>('.mobile-tab-bar');
  const searchInput = document.getElementById('taskSearchInput') as HTMLInputElement | null;
  const clearSearchBtn = document.getElementById('clearSearchBtn') as HTMLButtonElement | null;
  const nativeAppHandoffBanner = document.getElementById('nativeAppHandoffBanner') as HTMLElement | null;
  const nativeAppHandoffText = document.getElementById('nativeAppHandoffText') as HTMLElement | null;
  const nativeAppHandoffLink = document.getElementById('nativeAppHandoffLink') as HTMLAnchorElement | null;
  const closeAppHandoffBtn = document.getElementById('closeAppHandoffBtn') as HTMLButtonElement | null;
  closeAppHandoffBtn?.addEventListener('click', () => {
    if (nativeAppHandoffBanner) nativeAppHandoffBanner.hidden = true;
  });
  if (searchInput && searchQuery) {
    searchInput.value = searchQuery;
  }

  function syncUrlState(): void {
    const params = new URLSearchParams(window.location.search);
    if (activeView === 'my-day') {
      params.delete('view');
    } else {
      params.set('view', activeView);
    }
    if (activeView === 'lists' && activeListId) {
      params.set('list', activeListId);
    } else {
      params.delete('list');
    }
    const cleanQ = searchQuery.trim();
    if (cleanQ) {
      params.set('q', cleanQ);
    } else {
      params.delete('q');
    }
    const queryStr = params.toString();
    const nextUrl = `${window.location.pathname}${queryStr ? `?${queryStr}` : ''}${window.location.hash}`;
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== nextUrl) {
      window.history.replaceState({}, '', nextUrl);
    }
  }

  function openMobileDrawer(trigger: HTMLElement = openSidebarBtn): void {
    lastDrawerTrigger = trigger;
    sidebar.classList.add('is-open');
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-modal', 'true');
    sidebarBackdrop.hidden = false;
    if (mainViewEl) mainViewEl.inert = true;
    if (mobileBarEl) mobileBarEl.inert = true;
    openSidebarBtn.setAttribute('aria-expanded', 'true');
    mobileListsBtn?.setAttribute('aria-expanded', 'true');
    document.getElementById('closeSidebarBtn')?.focus();
  }

  function closeMobileDrawer(): void {
    const wasOpen = sidebar.classList.contains('is-open');
    sidebar.classList.remove('is-open');
    sidebar.removeAttribute('role');
    sidebar.removeAttribute('aria-modal');
    sidebarBackdrop.hidden = true;
    if (mainViewEl) mainViewEl.inert = false;
    if (mobileBarEl) mobileBarEl.inert = false;
    openSidebarBtn.setAttribute('aria-expanded', 'false');
    mobileListsBtn?.setAttribute('aria-expanded', 'false');
    if (wasOpen) {
      lastDrawerTrigger?.focus();
    }
    lastDrawerTrigger = null;
  }

  openSidebarBtn.addEventListener('click', () => openMobileDrawer(openSidebarBtn));
  document.getElementById('closeSidebarBtn')?.addEventListener('click', closeMobileDrawer);
  mobileListsBtn?.addEventListener('click', () => {
    if (sidebar.classList.contains('is-open')) {
      closeMobileDrawer();
    } else {
      openMobileDrawer(mobileListsBtn);
    }
  });
  sidebarBackdrop.addEventListener('click', closeMobileDrawer);
  let drawerSwipeStartX: number | null = null;
  let drawerSwipeStartY: number | null = null;
  const onDrawerTouchStart = (event: TouchEvent): void => {
    if (!sidebar.classList.contains('is-open') || event.touches.length !== 1) return;
    drawerSwipeStartX = event.touches[0].clientX;
    drawerSwipeStartY = event.touches[0].clientY;
  };
  const onDrawerTouchEnd = (event: TouchEvent): void => {
    if (
      drawerSwipeStartX === null ||
      drawerSwipeStartY === null ||
      !sidebar.classList.contains('is-open') ||
      event.changedTouches.length !== 1
    ) {
      drawerSwipeStartX = null;
      drawerSwipeStartY = null;
      return;
    }
    const deltaX = event.changedTouches[0].clientX - drawerSwipeStartX;
    const deltaY = event.changedTouches[0].clientY - drawerSwipeStartY;
    drawerSwipeStartX = null;
    drawerSwipeStartY = null;
    if (deltaX < -45 && Math.abs(deltaX) > Math.abs(deltaY) * 1.4) {
      closeMobileDrawer();
    }
  };
  sidebar.addEventListener('touchstart', onDrawerTouchStart, { passive: true });
  sidebar.addEventListener('touchend', onDrawerTouchEnd, { passive: true });
  sidebarBackdrop.addEventListener('touchstart', onDrawerTouchStart, { passive: true });
  sidebarBackdrop.addEventListener('touchend', onDrawerTouchEnd, { passive: true });
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

  function selectBestViewAfterPairing(): void {
    const activeMyDay = getMyDayTasks(
      store.tasks,
      getLocalIsoDate(),
      store.preferences.autoAddDueTodayToMyDay,
    );
    if (activeView === 'my-day' && activeMyDay.length === 0) {
      const openTasks = store.tasks.filter((task) => task.deletedAt === null && !task.completed);
      if (openTasks.length > 0) {
        const defaultId = store.getDefaultTasksListId();
        if (openTasks.some((task) => task.listId === defaultId)) {
          activeView = 'tasks';
          return;
        }
        const firstCustomWithTasks = store
          .getCustomLists()
          .find((list) => openTasks.some((task) => task.listId === list.id));
        if (firstCustomWithTasks) {
          activeView = 'lists';
          activeListId = firstCustomWithTasks.id;
          return;
        }
      }
    }
    if (!store.getActiveLists().some((l) => l.id === activeListId)) {
      activeListId = store.getDefaultTasksListId();
    }
  }

  async function runSyncNow(): Promise<void> {
    if (!navigator.onLine) return;
    if (syncInFlight) {
      syncQueued = true;
      return;
    }
    syncInFlight = true;
    try {
      const result = await store.syncWithServer();
      if (result.synced) {
        hasSyncedOnce = true;
        if (result.revokedLists > 0) {
          if (
            activeView === 'lists' &&
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
      if (syncQueued) {
        syncQueued = false;
        void runSyncNow();
      }
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
  const helpDialog = document.getElementById('helpDialog') as HTMLDialogElement;
  const legalDialog = document.getElementById('legalDialog') as HTMLDialogElement;
  const confirmDeleteDialog = document.getElementById('confirmDeleteDialog') as HTMLDialogElement;
  [
    shareDialog,
    renameListDialog,
    taskDialog,
    importDialog,
    settingsDialog,
    helpDialog,
    legalDialog,
    confirmDeleteDialog,
  ].forEach(wireDialogLightDismiss);

  let umamiInitialPageTracked = false;

  function syncTelemetryRuntime(): void {
    const existingScript = document.getElementById('plinglist-umami-script');
    if (!store.isTelemetryActive()) {
      existingScript?.remove();
      try {
        window.localStorage.setItem('umami.disabled', '1');
      } catch {
        // Ignore storage restrictions
      }
      return;
    }

    try {
      window.localStorage.removeItem('umami.disabled');
    } catch {
      // Ignore storage restrictions
    }

    const trackCleanPageview = (): void => {
      if (umamiInitialPageTracked) return;
      const umami = (window as { umami?: { track: (...args: unknown[]) => void } }).umami;
      if (!umami) return;
      umamiInitialPageTracked = true;
      umami.track((props: Record<string, unknown>) => ({
        ...props,
        url: '/',
        referrer: '',
      }));
    };

    if (!existingScript) {
      const script = document.createElement('script');
      script.id = 'plinglist-umami-script';
      script.async = true;
      script.src = UMAMI_SCRIPT_URL;
      script.dataset.websiteId = UMAMI_APP_WEBSITE_ID;
      script.dataset.autoTrack = 'false';
      script.addEventListener('load', trackCleanPageview, { once: true });
      document.head.appendChild(script);
    } else {
      trackCleanPageview();
    }
  }

  function trackDiagnostic(eventName: string): void {
    if (!store.isTelemetryActive()) return;
    const umami = (window as { umami?: { track: (...args: unknown[]) => void } }).umami;
    if (!umami) return;
    umami.track(eventName, { locale: store.locale });
  }
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
    if (lastAppliedLocale !== store.locale) {
      lastAppliedLocale = store.locale;
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
    }

    updateSyncLabels();
  }

  const RECURRENCE_LABEL_KEYS: Record<RecurrencePattern, TranslationKey> = {
    daily: 'task.recurrenceDaily',
    weekdays: 'task.recurrenceWeekdays',
    weekly: 'task.recurrenceWeekly',
    monthly: 'task.recurrenceMonthly',
    yearly: 'task.recurrenceYearly',
  };

  function createTaskElement(
    task: TaskItem,
    isSuggestion = false,
    listTitleById?: ReadonlyMap<string, string>,
  ): HTMLLIElement {
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
      leftBtn.setAttribute('aria-pressed', String(task.completed));
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
          trackDiagnostic('task_completed');
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
    if (listTitleById && activeView !== 'lists') {
      const listName = listTitleById.get(task.listId);
      if (listName) metaParts.push(listName);
    }
    if (task.steps.length > 0) {
      const doneSteps = task.steps.filter((s) => s.completed).length;
      metaParts.push(`${doneSteps}/${task.steps.length} ${t(store.locale, 'task.steps')}`);
    }
    if (task.dueDate) metaParts.push(task.dueDate);
    if (task.reminderAt) metaParts.push('⏰');
    if (task.recurrence) metaParts.push(`↻ ${t(store.locale, RECURRENCE_LABEL_KEYS[task.recurrence])}`);
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
    const listTitleById = new Map(activeLists.map((l) => [l.id, l.title]));
    syncUrlState();

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
    const hideStarred =
      store.preferences.autoHideEmptySmartLists &&
      openStarredCount === 0 &&
      activeView !== 'starred';
    const hidePlanned =
      store.preferences.autoHideEmptySmartLists &&
      openPlannedCount === 0 &&
      activeView !== 'planned';
    if (navStarred) {
      navStarred.hidden = hideStarred;
    }
    if (navPlanned) {
      navPlanned.hidden = hidePlanned;
    }
    if (navAll) {
      const hiddenByPref = !store.preferences.showAllSmartList;
      const hiddenByEmpty = store.preferences.autoHideEmptySmartLists && openAllCount === 0;
      navAll.hidden = (hiddenByPref || hiddenByEmpty) && activeView !== 'all';
    }

    const mobileStarredTab = document.querySelector<HTMLButtonElement>('[data-mobile-view="starred"]');
    const mobilePlannedTab = document.querySelector<HTMLButtonElement>('[data-mobile-view="planned"]');
    if (mobileStarredTab) mobileStarredTab.hidden = hideStarred;
    if (mobilePlannedTab) mobilePlannedTab.hidden = hidePlanned;

    document.querySelectorAll<HTMLButtonElement>('.sidebar .nav-item[data-view]').forEach((btn) => {
      const isCurrent = btn.dataset.view === activeView;
      btn.setAttribute('aria-current', isCurrent ? 'page' : 'false');
    });

    document.querySelectorAll<HTMLButtonElement>('[data-mobile-view]').forEach((btn) => {
      const isCurrent = btn.dataset.mobileView === activeView;
      btn.setAttribute('aria-current', isCurrent ? 'page' : 'false');
    });
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
    suggestionsList.replaceChildren(
      ...suggestions.map((item) => createTaskElement(item, true, listTitleById)),
    );
    (document.getElementById('suggestionsCount') as HTMLElement).textContent = String(
      suggestions.length,
    );

    const hasSearch = searchQuery.trim().length > 0;
    if (clearSearchBtn) clearSearchBtn.hidden = !hasSearch;
    const filteredVisible = filterTasksByQuery(visibleTasks, searchQuery);

    const openTasks = sortTasksForView(
      filteredVisible.filter((item) => !item.completed),
      store.preferences.moveStarredToTop,
    );
    const doneTasks = filteredVisible.filter((item) => item.completed);

    const activeListEl = document.getElementById('activeTasksList') as HTMLUListElement;
    activeListEl.replaceChildren(
      ...openTasks.map((item) => createTaskElement(item, false, listTitleById)),
    );

    const emptyEl = document.getElementById('emptyStateText') as HTMLElement;
    emptyEl.hidden = openTasks.length > 0;
    emptyEl.textContent = hasSearch
      ? t(store.locale, 'task.emptySearch')
      : t(store.locale, 'task.emptyView');

    const completedSection = document.getElementById('completedSection') as HTMLElement;
    const completedListEl = document.getElementById('completedTasksList') as HTMLUListElement;
    completedSection.hidden = doneTasks.length === 0;
    (document.getElementById('completedCount') as HTMLElement).textContent = String(doneTasks.length);
    completedListEl.replaceChildren(
      ...doneTasks.map((item) => createTaskElement(item, false, listTitleById)),
    );
  }

  function refreshShareDialogState(listId: string): void {
    const urlInput = document.getElementById('shareInviteUrlInput') as HTMLInputElement;
    const unshareBtn = document.getElementById('unshareListBtn') as HTMLButtonElement;
    const existingUrl = store.getInviteUrl(
      listId,
      getShareBaseOrigin(window.location.origin, store.serverUrl),
    );
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
      store.getPairingUrl(getShareBaseOrigin(window.location.origin, store.serverUrl));
    (document.getElementById('shareSyncKeyCode') as HTMLElement).textContent = store.syncKey;

    const canNativeShare = typeof navigator.share === 'function';
    (document.getElementById('nativeShareInviteBtn') as HTMLButtonElement).hidden = !canNativeShare;
    (document.getElementById('nativeSharePairBtn') as HTMLButtonElement).hidden = !canNativeShare;

    store.forceFullSync();
    void runSyncNow();
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
      toggleBtn.setAttribute('aria-pressed', String(step.completed));
      toggleBtn.setAttribute(
        'aria-label',
        `${t(store.locale, 'task.stepToggleAria')}: ${step.title}`,
      );
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
      removeBtn.setAttribute(
        'aria-label',
        `${t(store.locale, 'task.stepDeleteAria')}: ${step.title}`,
      );
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
    (document.getElementById('detailNewStepInput') as HTMLInputElement).value = '';

    const listSelect = document.getElementById('detailListSelect') as HTMLSelectElement | null;
    if (listSelect) {
      listSelect.replaceChildren();
      for (const list of store.getActiveLists()) {
        const opt = document.createElement('option');
        opt.value = list.id;
        opt.textContent = list.title;
        listSelect.appendChild(opt);
      }
      listSelect.value = task.listId;
    }

    const myDayBtn = document.getElementById('detailMyDayBtn') as HTMLButtonElement;
    const inMyDay = task.myDayDate === today;
    myDayBtn.setAttribute('aria-pressed', String(inMyDay));
    myDayBtn.textContent = inMyDay
      ? t(store.locale, 'myDay.removeFromMyDay')
      : t(store.locale, 'myDay.addToMyDay');

    const starBtn = document.getElementById('detailStarBtn') as HTMLButtonElement;
    starBtn.setAttribute('aria-pressed', String(task.starred));
    starBtn.textContent = `${task.starred ? '★' : '☆'} ${t(store.locale, 'nav.starred')}`;

    renderDetailSteps(task);
    if (!taskDialog.open) {
      taskDialog.showModal();
    }
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
      closeMobileDrawer();
      render();
    });
  });

  searchInput?.addEventListener('input', () => {
    window.clearTimeout(searchDebounceTimer);
    searchDebounceTimer = window.setTimeout(() => {
      searchQuery = searchInput.value;
      render();
    }, 150);
  });

  clearSearchBtn?.addEventListener('click', () => {
    window.clearTimeout(searchDebounceTimer);
    searchQuery = '';
    if (searchInput) {
      searchInput.value = '';
      searchInput.focus();
    }
    render();
  });

  window.addEventListener('popstate', () => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get('view') as SmartViewId | null;
    activeView = v && VALID_VIEWS.has(v) ? v : 'my-day';
    const l = params.get('list')?.trim();
    if (l && store.getActiveLists().some((item) => item.id === l)) {
      activeListId = l;
    }
    searchQuery = params.get('q') ?? '';
    if (searchInput) searchInput.value = searchQuery;
    render();
  });

  document.getElementById('newListForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('newListInput') as HTMLInputElement;
    if (!input.value.trim()) return;
    const created = store.addList(input.value);
    input.value = '';
    activeView = 'lists';
    activeListId = created.id;
    trackDiagnostic('list_created');
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
    trackDiagnostic('task_created');
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

  async function copyWithFeedback(
    text: string,
    fallbackInput: HTMLInputElement | null,
    successToastKey: TranslationKey,
  ): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(text);
      showToast(t(store.locale, successToastKey));
    } catch {
      if (fallbackInput) {
        fallbackInput.focus();
        fallbackInput.select();
      }
      showToast(t(store.locale, 'toast.copyFallback'));
    }
  }

  document.getElementById('copySettingsPairUrlBtn')?.addEventListener('click', async () => {
    store.forceFullSync();
    void runSyncNow();
    const pairUrl = store.getPairingUrl(
      getShareBaseOrigin(window.location.origin, store.serverUrl),
    );
    const input = document.getElementById('settingsSyncKeyInput') as HTMLInputElement | null;
    await copyWithFeedback(pairUrl, input, 'share.pairCopied');
  });

  document.getElementById('shareListBtn')?.addEventListener('click', openShareModal);
  document.getElementById('shareListSelect')?.addEventListener('change', (event) => {
    refreshShareDialogState((event.target as HTMLSelectElement).value);
  });

  document.getElementById('copyInviteUrlBtn')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget as HTMLButtonElement;
    const listId = (document.getElementById('shareListSelect') as HTMLSelectElement).value;
    btn.dataset.loading = 'true';
    btn.disabled = true;
    try {
      const { inviteUrl } = store.shareList(
        listId,
        getShareBaseOrigin(window.location.origin, store.serverUrl),
      );
      refreshShareDialogState(listId);
      render();
      void runSyncNow();
      trackDiagnostic('list_shared');
      const input = document.getElementById('shareInviteUrlInput') as HTMLInputElement | null;
      await copyWithFeedback(inviteUrl, input, 'list.inviteCopied');
    } finally {
      delete btn.dataset.loading;
      btn.disabled = false;
    }
  });

  document.getElementById('copyPairUrlBtn')?.addEventListener('click', async () => {
    store.forceFullSync();
    void runSyncNow();
    const input = document.getElementById('sharePairUrlInput') as HTMLInputElement | null;
    const val = input?.value ?? '';
    await copyWithFeedback(val, input, 'share.pairCopied');
  });

  document.getElementById('nativeShareInviteBtn')?.addEventListener('click', async () => {
    const listId = (document.getElementById('shareListSelect') as HTMLSelectElement).value;
    const { inviteUrl } = store.shareList(
      listId,
      getShareBaseOrigin(window.location.origin, store.serverUrl),
    );
    refreshShareDialogState(listId);
    render();
    void runSyncNow();
    trackDiagnostic('list_shared');
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
    store.forceFullSync();
    void runSyncNow();
    const url = (document.getElementById('sharePairUrlInput') as HTMLInputElement).value;
    await navigator
      .share?.({ title: 'Plinglist Sync', text: t(store.locale, 'share.pairSectionTitle'), url })
      .catch(() => undefined);
  });

  document.getElementById('joinSharedListForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = document.getElementById('joinSharedListInput') as HTMLInputElement;
    const btn = document.getElementById('joinSharedListBtn') as HTMLButtonElement;
    const rawValue = input.value.trim();
    if (!rawValue) return;
    btn.dataset.loading = 'true';
    btn.disabled = true;
    try {
      const looksLikePairing =
        rawValue.includes('pair=') ||
        rawValue.includes('key=') ||
        extractSyncKeyFromInput(rawValue).startsWith('pling-');
      if (looksLikePairing) {
        store.setSyncKey(rawValue, { forceReset: true });
        await store.syncWithServer();
        selectBestViewAfterPairing();
        hasSyncedOnce = true;
        input.value = '';
        trackDiagnostic('device_paired');
        await closeTopLayer(shareDialog);
        showToast(t(store.locale, 'toast.devicePaired'));
        render();
        return;
      }
      const joinedList = await store.joinSharedListByToken(rawValue);
      hasSyncedOnce = true;
      activeView = 'lists';
      activeListId = joinedList.id;
      input.value = '';
      trackDiagnostic('list_joined');
      await closeTopLayer(shareDialog);
      showToast(`${joinedList.title} (${t(store.locale, 'list.sharedBadge')})`);
      render();
    } catch {
      showToast(t(store.locale, 'toast.joinFailed'));
    } finally {
      delete btn.dataset.loading;
      btn.disabled = false;
    }
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

  function addPendingStepFromDetailInput(): void {
    if (!editingTaskId) return;
    const input = document.getElementById('detailNewStepInput') as HTMLInputElement;
    if (!input.value.trim()) return;
    const updated = store.addTaskStep(editingTaskId, input.value);
    input.value = '';
    renderDetailSteps(updated);
    render();
  }

  document.getElementById('detailAddStepBtn')?.addEventListener('click', addPendingStepFromDetailInput);

  document.getElementById('detailNewStepInput')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      addPendingStepFromDetailInput();
    }
  });

  document.getElementById('detailDeleteBtn')?.addEventListener('click', () => {
    if (!editingTaskId) return;
    const taskIdToDelete = editingTaskId;
    requestDeleteConfirmation(t(store.locale, 'confirm.deleteTaskPrompt'), () => {
      editingTaskId = null;
      store.deleteTask(taskIdToDelete);
      void closeTopLayer(taskDialog);
      render();
    });
  });

  function commitTaskDetailEdits(): void {
    if (!editingTaskId) return;
    addPendingStepFromDetailInput();
    const recurrenceVal = (
      document.getElementById('detailRecurrenceSelect') as HTMLSelectElement
    ).value;
    const reminderAt =
      (document.getElementById('detailReminderInput') as HTMLInputElement).value || null;
    if (reminderAt && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => undefined);
    }
    const listSelect = document.getElementById('detailListSelect') as HTMLSelectElement | null;
    const nextListId = listSelect?.value;
    store.updateTask(editingTaskId, {
      title: (document.getElementById('detailTitleInput') as HTMLInputElement).value,
      dueDate: (document.getElementById('detailDueDateInput') as HTMLInputElement).value || null,
      reminderAt,
      recurrence: (recurrenceVal || null) as RecurrencePattern | null,
      note: (document.getElementById('detailNoteInput') as HTMLTextAreaElement).value,
      ...(nextListId ? { listId: nextListId } : {}),
    });
  }

  document.getElementById('taskDetailForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!editingTaskId) return;
    commitTaskDetailEdits();
    editingTaskId = null;
    void closeTopLayer(taskDialog);
    render();
  });

  taskDialog.addEventListener('close', () => {
    if (!editingTaskId) return;
    commitTaskDetailEdits();
    editingTaskId = null;
    render();
  });

  document.getElementById('openImportBtn')?.addEventListener('click', () => {
    closeMobileDrawer();
    if (settingsDialog.open) {
      void closeTopLayer(settingsDialog);
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
      trackDiagnostic('import_completed');
      showToast(
        `${t(store.locale, 'importer.success')}: +${stats.importedLists} / +${stats.importedTasks}`,
      );
      render();
    } catch {
      errEl.textContent = t(store.locale, 'importer.error');
      errEl.hidden = false;
    }
  });

  function wireTablistKeyboard(
    tablist: HTMLElement | null,
    onSelect: (tab: HTMLButtonElement) => void,
  ): void {
    if (!tablist) return;
    tablist.addEventListener('keydown', (event) => {
      const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
      const currentIdx = tabs.indexOf(document.activeElement as HTMLButtonElement);
      if (currentIdx < 0) return;
      let nextIdx = -1;
      if (event.key === 'ArrowRight') nextIdx = (currentIdx + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') nextIdx = (currentIdx - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') nextIdx = 0;
      else if (event.key === 'End') nextIdx = tabs.length - 1;
      if (nextIdx >= 0) {
        event.preventDefault();
        tabs[nextIdx].focus();
        onSelect(tabs[nextIdx]);
      }
    });
  }

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

  wireTablistKeyboard(settingsDialog.querySelector('[role="tablist"]'), (tab) => {
    const target = tab.dataset.settingsTab as 'general' | 'lists' | 'sync' | undefined;
    if (target) selectSettingsTab(target);
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
    const syncEnabledCheckbox = document.getElementById(
      'settingsSyncEnabledCheckbox',
    ) as HTMLInputElement | null;
    if (syncEnabledCheckbox) syncEnabledCheckbox.checked = store.preferences.syncEnabled;
    const telemetrySupported = store.isTelemetrySupported();
    const telemetryCheckbox = document.getElementById(
      'settingsTelemetryCheckbox',
    ) as HTMLInputElement;
    telemetryCheckbox.checked = telemetrySupported && store.preferences.telemetryEnabled;
    telemetryCheckbox.disabled = !telemetrySupported;
    const telemetryHint = document.getElementById(
      'settingsTelemetrySelfHostedHint',
    ) as HTMLElement | null;
    if (telemetryHint) telemetryHint.hidden = telemetrySupported;
    updateSyncLabels();
    (document.getElementById('settingsErrorText') as HTMLElement).hidden = true;
    settingsDialog.showModal();
  });

  function selectLegalTab(tabName: 'imprint' | 'privacy'): void {
    document.querySelectorAll<HTMLButtonElement>('[data-legal-tab]').forEach((tab) => {
      tab.setAttribute('aria-selected', String(tab.dataset.legalTab === tabName));
    });
    document.querySelectorAll<HTMLElement>('[data-legal-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.legalPanel !== tabName;
    });
  }

  document.querySelectorAll<HTMLButtonElement>('[data-legal-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.legalTab as 'imprint' | 'privacy' | undefined;
      if (target) selectLegalTab(target);
    });
  });

  wireTablistKeyboard(legalDialog.querySelector('[role="tablist"]'), (tab) => {
    const target = tab.dataset.legalTab as 'imprint' | 'privacy' | undefined;
    if (target) selectLegalTab(target);
  });

  const openHelpModal = (): void => {
    closeMobileDrawer();
    if (settingsDialog.open) void closeTopLayer(settingsDialog);
    helpDialog.showModal();
  };
  const openLegalModal = (tabName: 'imprint' | 'privacy' = 'imprint'): void => {
    closeMobileDrawer();
    if (settingsDialog.open) void closeTopLayer(settingsDialog);
    selectLegalTab(tabName);
    legalDialog.showModal();
  };
  document.getElementById('openHelpBtn')?.addEventListener('click', openHelpModal);
  document.getElementById('openSettingsHelpBtn')?.addEventListener('click', openHelpModal);
  document.getElementById('openImprintBtn')?.addEventListener('click', () => openLegalModal('imprint'));
  document
    .getElementById('openSettingsImprintBtn')
    ?.addEventListener('click', () => openLegalModal('imprint'));
  document.getElementById('openPrivacyBtn')?.addEventListener('click', () => openLegalModal('privacy'));
  document
    .getElementById('openSettingsPrivacyBtn')
    ?.addEventListener('click', () => openLegalModal('privacy'));

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
    if (btn) {
      btn.disabled = true;
      btn.dataset.loading = 'true';
    }
    try {
      store.forceFullSync();
      await runSyncNow();
      updateSyncLabels();
    } finally {
      if (btn) {
        delete btn.dataset.loading;
        btn.disabled = false;
      }
    }
  });

  document.getElementById('deleteWorkspaceBtn')?.addEventListener('click', () => {
    const btn = document.getElementById('deleteWorkspaceBtn') as HTMLButtonElement | null;
    requestDeleteConfirmation(t(store.locale, 'confirm.deleteWorkspacePrompt'), () => {
      void (async () => {
        if (btn) {
          btn.disabled = true;
          btn.dataset.loading = 'true';
        }
        try {
          await store.deleteCloudAndResetLocal();
          hasSyncedOnce = false;
          activeView = 'my-day';
          activeListId = store.getDefaultTasksListId();
          searchQuery = '';
          if (searchInput) searchInput.value = '';
          if (settingsDialog.open) void closeTopLayer(settingsDialog);
          showToast(t(store.locale, 'toast.workspaceDeleted'));
          render();
        } finally {
          if (btn) {
            delete btn.dataset.loading;
            btn.disabled = false;
          }
        }
      })();
    });
  });

  document.getElementById('settingsForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errEl = document.getElementById('settingsErrorText') as HTMLElement;
    const nextLocale = (document.getElementById('settingsLocaleSelect') as HTMLSelectElement)
      .value as 'de' | 'en';
    const nextSyncKey = (document.getElementById('settingsSyncKeyInput') as HTMLInputElement).value;
    const nextUrl = (document.getElementById('settingsServerUrlInput') as HTMLInputElement).value;
    const nextSound = (document.getElementById('settingsSoundCheckbox') as HTMLInputElement)
      .checked;
    const syncEnabledEl = document.getElementById(
      'settingsSyncEnabledCheckbox',
    ) as HTMLInputElement | null;
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
      syncEnabled: syncEnabledEl ? syncEnabledEl.checked : store.preferences.syncEnabled,
      telemetryEnabled:
        store.isTelemetrySupported() &&
        (document.getElementById('settingsTelemetryCheckbox') as HTMLInputElement).checked,
    };

    const prevSyncKey = store.syncKey;
    let keyChanged = false;
    try {
      keyChanged = store.setSyncKey(nextSyncKey) !== prevSyncKey;
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
      syncTelemetryRuntime();
      errEl.hidden = true;
      await closeTopLayer(settingsDialog);
      if (keyChanged) {
        const res = await store.syncWithServer();
        if (res.synced) {
          hasSyncedOnce = true;
          selectBestViewAfterPairing();
          showToast(t(store.locale, 'toast.devicePaired'));
        } else {
          showToast(t(store.locale, 'toast.settingsSaved'));
        }
        trackDiagnostic('device_paired');
        render();
        return;
      }
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
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkDueReminders();
      void runSyncNow();
    }
  });
  window.setInterval(() => {
    checkDueReminders();
    if (document.visibilityState !== 'hidden') {
      void runSyncNow();
    }
  }, 15_000);

  if ('serviceWorker' in navigator) {
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloadingForSwUpdate = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloadingForSwUpdate) return;
      reloadingForSwUpdate = true;
      window.location.reload();
    });
    void navigator.serviceWorker
      .register('./sw.js', { updateViaCache: 'none' })
      .catch(() => undefined);
  }

  let lastHandledDeepLinkUrl = '';
  let lastHandledDeepLinkAt = 0;

  function syncDialogKeyFieldsAfterDeepLink(): void {
    const settingsSyncInput = document.getElementById(
      'settingsSyncKeyInput',
    ) as HTMLInputElement | null;
    if (settingsSyncInput) settingsSyncInput.value = store.syncKey;
    const shareSyncKeyEl = document.getElementById('shareSyncKeyCode');
    if (shareSyncKeyEl) shareSyncKeyEl.textContent = store.syncKey;
    if (settingsDialog.open) void closeTopLayer(settingsDialog);
    if (shareDialog.open) void closeTopLayer(shareDialog);
  }

  async function handleIncomingDeepLinkUrl(rawUrl: string): Promise<void> {
    const trimmed = rawUrl.trim();
    if (!trimmed) return;
    const nowMs = Date.now();
    if (trimmed === lastHandledDeepLinkUrl && nowMs - lastHandledDeepLinkAt < 3000) {
      return;
    }
    lastHandledDeepLinkUrl = trimmed;
    lastHandledDeepLinkAt = nowMs;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return;
    }

    const legal = parsed.searchParams.get('legal');
    if (legal === 'imprint' || legal === 'privacy') {
      openLegalModal(legal);
    }

    const pairCandidate = parsed.searchParams.get('pair') ?? parsed.searchParams.get('key');
    if (pairCandidate?.trim()) {
      try {
        store.setSyncKey(extractSyncKeyFromInput(trimmed), { forceReset: true });
        await store.syncWithServer();
        selectBestViewAfterPairing();
        hasSyncedOnce = true;
        syncDialogKeyFieldsAfterDeepLink();
        trackDiagnostic('device_paired');
        showToast(t(store.locale, 'toast.devicePaired'));
        render();
      } catch {
        showToast(t(store.locale, 'toast.pairFailed'));
      }
    }

    const joinCandidate = extractInviteTokenFromInput(trimmed);
    const hasJoinSignal =
      Boolean(parsed.searchParams.get('join') || parsed.searchParams.get('token')) ||
      /\/join\/[^/?#]+/.test(parsed.pathname);
    if (hasJoinSignal && joinCandidate) {
      try {
        const joinedList = await store.joinSharedListByToken(joinCandidate);
        hasSyncedOnce = true;
        activeView = 'lists';
        activeListId = joinedList.id;
        syncDialogKeyFieldsAfterDeepLink();
        trackDiagnostic('list_joined');
        showToast(`${joinedList.title} (${t(store.locale, 'list.sharedBadge')})`);
        render();
      } catch {
        showToast(t(store.locale, 'toast.joinFailed'));
      }
    }
  }

  window.addEventListener('plinglist:open-url', (event) => {
    const detailUrl = (event as CustomEvent<{ url?: string }>).detail?.url;
    if (typeof detailUrl === 'string') {
      void handleIncomingDeepLinkUrl(detailUrl);
    }
  });

  function handleNativeBackNavigation(): boolean {
    const openDialogOrder: HTMLDialogElement[] = [
      confirmDeleteDialog,
      renameListDialog,
      taskDialog,
      shareDialog,
      importDialog,
      settingsDialog,
      helpDialog,
      legalDialog,
    ];
    const topmostOpen = openDialogOrder.find((dlg) => dlg.open);
    if (topmostOpen) {
      void closeTopLayer(topmostOpen);
      return true;
    }
    if (sidebar.classList.contains('is-open')) {
      closeMobileDrawer();
      return true;
    }
    return false;
  }

  const capacitorAppPlugin = (
    window as {
      Capacitor?: {
        Plugins?: {
          App?: {
            addListener?: (
              eventName: string,
              cb: (data: { url?: string }) => void,
            ) => void;
            getLaunchUrl?: () => Promise<{ url?: string } | null | undefined>;
            exitApp?: () => Promise<void> | void;
            minimizeApp?: () => Promise<void> | void;
          };
        };
      };
    }
  ).Capacitor?.Plugins?.App;
  capacitorAppPlugin?.addListener?.('appUrlOpen', (data) => {
    if (typeof data?.url === 'string') {
      void handleIncomingDeepLinkUrl(data.url);
    }
  });
  capacitorAppPlugin?.addListener?.('backButton', () => {
    if (!handleNativeBackNavigation()) {
      void capacitorAppPlugin?.exitApp?.();
    }
  });

  function showNativeAppHandoff(kind: 'pair' | 'join', value: string): void {
    if (
      isNativeShellOrigin() ||
      !nativeAppHandoffBanner ||
      !nativeAppHandoffText ||
      !nativeAppHandoffLink
    ) {
      return;
    }
    nativeAppHandoffLink.href =
      kind === 'pair'
        ? `plinglist://pair?key=${encodeURIComponent(value)}`
        : `plinglist://join?token=${encodeURIComponent(value)}`;
    nativeAppHandoffText.textContent = t(
      store.locale,
      kind === 'pair' ? 'handoff.pairPrompt' : 'handoff.joinPrompt',
    );
    nativeAppHandoffLink.textContent = t(store.locale, 'handoff.openApp');
    nativeAppHandoffBanner.hidden = false;
  }

  async function handleJoinParamOnStartup(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const legalParam = params.get('legal');
    if (legalParam === 'imprint' || legalParam === 'privacy') {
      openLegalModal(legalParam);
    }

    let didStartupSync = false;
    const pairKey = params.get('pair');
    if (pairKey) {
      showNativeAppHandoff('pair', pairKey);
      params.delete('pair');
      const cleanQuery = params.toString();
      const cleanUrl = `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', cleanUrl);
      try {
        // Apply syncKey synchronously before any await so focus/visibility listeners never sync the throwaway key.
        store.setSyncKey(pairKey, { forceReset: true });
        await store.syncWithServer();
        selectBestViewAfterPairing();
        hasSyncedOnce = true;
        didStartupSync = true;
        trackDiagnostic('device_paired');
        showToast(t(store.locale, 'toast.devicePaired'));
        render();
      } catch {
        showToast(t(store.locale, 'toast.pairFailed'));
      }
    }

    try {
      const launchData = await capacitorAppPlugin?.getLaunchUrl?.();
      if (typeof launchData?.url === 'string' && launchData.url.trim()) {
        await handleIncomingDeepLinkUrl(launchData.url);
        didStartupSync = true;
      }
    } catch {
      // Ignore platforms where App.getLaunchUrl is unavailable
    }

    const nativeLaunchWin = window as { __PLINGLIST_LAUNCH_URL__?: string };
    const bootLaunchUrl = nativeLaunchWin.__PLINGLIST_LAUNCH_URL__;
    if (typeof bootLaunchUrl === 'string' && bootLaunchUrl.trim()) {
      delete nativeLaunchWin.__PLINGLIST_LAUNCH_URL__;
      await handleIncomingDeepLinkUrl(bootLaunchUrl);
      didStartupSync = true;
    }

    const joinToken = params.get('join');
    if (!joinToken) {
      if (!didStartupSync) {
        void runSyncNow();
      }
      return;
    }
    showNativeAppHandoff('join', joinToken);
    params.delete('join');
    const cleanQuery = params.toString();
    const cleanUrl = `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', cleanUrl);
    try {
      const joinedList = await store.joinSharedListByToken(joinToken);
      hasSyncedOnce = true;
      activeView = 'lists';
      activeListId = joinedList.id;
      trackDiagnostic('list_joined');
      showToast(`${joinedList.title} (${t(store.locale, 'list.sharedBadge')})`);
      render();
    } catch {
      showToast(t(store.locale, 'toast.joinFailed'));
      void runSyncNow();
    }
  }

  render();
  syncTelemetryRuntime();
  checkDueReminders();
  void handleJoinParamOnStartup();
}

initApp();
