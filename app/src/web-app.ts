import {
  computeNextDueDate,
  extractHashtags,
  filterPlannedTasks,
  filterTasksByQuery,
  getAllOpenTasks,
  getAssignedTasks,
  getDueReminderTasks,
  getListTasks,
  getMyDaySuggestions,
  getMyDayTasks,
  getPlannedTasks,
  getStarredTasks,
  isTaskOverdue,
  sortTasksForView,
  type PlannedFilterId,
  type RecurrencePattern,
  type SmartViewId,
  type TaskItem,
  type TaskList,
  type TaskSortMode,
} from '../../packages/core/src/index.ts';
import { CC0_CHIME_NOTES, CHIME_MASTER_GAIN } from './audio.ts';
import {
  APP_VERSION,
  APTABASE_APP_KEY,
  APTABASE_HOST,
  UMAMI_APP_WEBSITE_ID,
  UMAMI_SCRIPT_URL,
  extractInviteTokenFromInput,
  extractSyncKeyFromInput,
  getShareBaseOrigin,
  isNativeShellOrigin,
} from './config.ts';
import { t, type TranslationKey } from './i18n.ts';
import { PlinglistStore, SharedListLimitError, getLocalIsoDate } from './store.ts';

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
    'assigned',
    'lists',
    'trash',
  ]);
  const initialViewParam = startupParams.get('view') as SmartViewId | null;
  let activeView: SmartViewId =
    initialViewParam && VALID_VIEWS.has(initialViewParam) ? initialViewParam : 'my-day';
  let activePlannedFilter: PlannedFilterId = 'all';
  let activeSortMode: TaskSortMode = 'default';
  let draggedTaskId: string | null = null;
  let lastScheduledNotificationsSig = '';
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
  let deviceLimitNotified = false;
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
        deviceLimitNotified = false;
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
      } else if (store.lastSyncErrorCode === 'DEVICE_LIMIT_REACHED' && !deviceLimitNotified) {
        deviceLimitNotified = true;
        showToast(t(store.locale, 'toast.deviceLimitReached'));
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
  let aptabaseLaunchTracked = false;
  let aptabaseSessionId = '';
  let aptabaseLastEventAt = 0;
  let nativeAppVersion = APP_VERSION;
  let nativeAppBuild = '1';
  let nativeAppInfoLoaded = false;

  function detectNativeOsInfo(): { osName: string; osVersion: string } {
    const capPlatform = (
      window as { Capacitor?: { getPlatform?: () => string } }
    ).Capacitor?.getPlatform?.();
    const ua = navigator.userAgent || '';
    const androidMatch = ua.match(/Android\s+([\d.]+)/i);
    if (androidMatch || capPlatform === 'android') {
      return { osName: 'Android', osVersion: androidMatch?.[1] ?? 'unknown' };
    }
    const iosMatch = ua.match(/(?:iPhone|iPad|CPU)\s+OS\s+([\d_]+)/i);
    if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) {
      return { osName: 'iPadOS', osVersion: (iosMatch?.[1] ?? 'unknown').replace(/_/g, '.') };
    }
    if (/iPhone|iPod/i.test(ua) || capPlatform === 'ios') {
      return { osName: 'iOS', osVersion: (iosMatch?.[1] ?? 'unknown').replace(/_/g, '.') };
    }
    const macMatch = ua.match(/Mac OS X\s+([\d_]+)/i);
    if (/Macintosh/i.test(ua)) {
      return { osName: 'macOS', osVersion: (macMatch?.[1] ?? 'unknown').replace(/_/g, '.') };
    }
    return { osName: 'Web', osVersion: 'unknown' };
  }

  function getAptabaseSessionId(): string {
    const now = Date.now();
    if (!aptabaseSessionId || now - aptabaseLastEventAt > 3_600_000) {
      const rand =
        typeof globalThis.crypto?.randomUUID === 'function'
          ? globalThis.crypto.randomUUID().replace(/-/g, '')
          : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      aptabaseSessionId = rand.slice(0, 24);
    }
    aptabaseLastEventAt = now;
    return aptabaseSessionId;
  }

  async function sendAptabaseEvent(eventName: string): Promise<void> {
    if (!store.isTelemetryActive() || !isNativeShellOrigin()) return;
    if (!nativeAppInfoLoaded) {
      nativeAppInfoLoaded = true;
      try {
        const info = await capacitorAppPlugin?.getInfo?.();
        if (info?.version) nativeAppVersion = info.version;
        if (info?.build) nativeAppBuild = info.build;
      } catch {
        // Fallback to bundled APP_VERSION
      }
    }
    const { osName, osVersion } = detectNativeOsInfo();
    const payload = {
      timestamp: new Date().toISOString(),
      sessionId: getAptabaseSessionId(),
      eventName,
      systemProps: {
        isDebug: false,
        osName,
        osVersion,
        locale: navigator.language || store.locale,
        appVersion: nativeAppVersion,
        appBuildNumber: nativeAppBuild,
        sdkVersion: 'aptabase-web@0.1.0',
      },
      props: {
        locale: store.locale,
      },
    };
    void fetch(`${APTABASE_HOST}/api/v0/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'App-Key': APTABASE_APP_KEY,
      },
      body: JSON.stringify(payload),
    }).catch(() => undefined);
  }

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

    if (isNativeShellOrigin()) {
      existingScript?.remove();
      if (!aptabaseLaunchTracked) {
        aptabaseLaunchTracked = true;
        void sendAptabaseEvent('app_started');
      }
      return;
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
    if (isNativeShellOrigin()) {
      void sendAptabaseEvent(eventName);
      return;
    }
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

  function createCustomListGlyphSvg(shared: boolean): SVGSVGElement {
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (shared) {
      const circle = document.createElementNS(svgNs, 'circle');
      circle.setAttribute('cx', '9');
      circle.setAttribute('cy', '7');
      circle.setAttribute('r', '4');
      svg.appendChild(circle);
      for (const d of [
        'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
        'M22 21v-2a4 4 0 0 0-3-3.87',
        'M16 3.13a4 4 0 0 1 0 7.75',
      ]) {
        const p = document.createElementNS(svgNs, 'path');
        p.setAttribute('d', d);
        svg.appendChild(p);
      }
    } else {
      const p = document.createElementNS(svgNs, 'path');
      p.setAttribute('d', 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01');
      svg.appendChild(p);
    }
    return svg;
  }

  function formatShortDate(rawDate: string): string {
    const parsed = new Date(`${rawDate}T12:00:00`);
    if (Number.isNaN(parsed.getTime())) return rawDate;
    return new Intl.DateTimeFormat(store.locale === 'de' ? 'de-DE' : 'en-US', {
      day: 'numeric',
      month: 'short',
    }).format(parsed);
  }

  function setStarButtonState(btn: HTMLButtonElement, starred: boolean): void {
    btn.setAttribute('aria-pressed', String(starred));
    let svg = btn.querySelector<SVGSVGElement>('svg.star-icon');
    if (!svg) {
      const svgNs = 'http://www.w3.org/2000/svg';
      svg = document.createElementNS(svgNs, 'svg');
      svg.setAttribute('class', 'star-icon');
      svg.setAttribute('width', '18');
      svg.setAttribute('height', '18');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      const polygon = document.createElementNS(svgNs, 'polygon');
      polygon.setAttribute(
        'points',
        '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2',
      );
      svg.appendChild(polygon);
      btn.replaceChildren(svg);
    }
    svg.setAttribute('fill', starred ? 'currentColor' : 'none');
  }

  function updateQuickAddDateChip(): void {
    const dueInput = document.getElementById('newTaskDueDate') as HTMLInputElement | null;
    const dueLabel = document.getElementById('newTaskDueDateLabel') as HTMLElement | null;
    const chip = dueInput?.closest('.date-chip');
    if (!dueInput || !dueLabel || !chip) return;
    const rawDate = dueInput.value.trim();
    if (!rawDate) {
      chip.classList.remove('is-active');
      dueLabel.textContent = t(store.locale, 'task.dueDate');
      return;
    }
    chip.classList.add('is-active');
    dueLabel.textContent = formatShortDate(rawDate);
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

    updateQuickAddDateChip();
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
    orderedVisibleIds?: string[],
  ): HTMLLIElement {
    const li = document.createElement('li');
    li.className = `task-row${task.completed ? ' is-completed' : ''}`;
    const readOnly = store.isReadOnlyList(task.listId);
    const today = getLocalIsoDate();

    if (!isSuggestion && !readOnly && !task.completed) {
      li.draggable = true;
      li.addEventListener('dragstart', (event) => {
        draggedTaskId = task.id;
        li.classList.add('is-dragging');
        event.dataTransfer?.setData('text/plain', task.id);
      });
      li.addEventListener('dragend', () => {
        draggedTaskId = null;
        li.classList.remove('is-dragging');
      });
      li.addEventListener('dragover', (event) => {
        if (draggedTaskId && draggedTaskId !== task.id) {
          event.preventDefault();
        }
      });
      li.addEventListener('drop', (event) => {
        event.preventDefault();
        const sourceId = draggedTaskId ?? event.dataTransfer?.getData('text/plain');
        if (sourceId && sourceId !== task.id) {
          activeSortMode = 'default';
          if (store.moveTaskOrder(sourceId, task.id, orderedVisibleIds)) {
            render();
          }
        }
      });
    }

    const leftBtn = document.createElement('button');
    leftBtn.type = 'button';
    if (isSuggestion) {
      leftBtn.className = 'btn-secondary btn-compact';
      leftBtn.textContent = '+';
      leftBtn.title = t(store.locale, 'myDay.addToMyDay');
      leftBtn.setAttribute('aria-label', t(store.locale, 'myDay.addToMyDay'));
      leftBtn.disabled = readOnly;
      leftBtn.addEventListener('click', () => {
        store.toggleTaskMyDay(task.id, getLocalIsoDate());
        render();
      });
    } else {
      leftBtn.className = 'task-check-btn';
      leftBtn.setAttribute('aria-label', t(store.locale, 'task.completeAria'));
      leftBtn.setAttribute('aria-pressed', String(task.completed));
      leftBtn.disabled = readOnly;
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

    const mainCol = document.createElement('div');
    mainCol.className = 'task-main-col';

    const mainBtn = document.createElement('button');
    mainBtn.type = 'button';
    mainBtn.className = 'task-main-btn';
    mainBtn.addEventListener('click', () => openTaskDetail(task.id));

    const titleSpan = document.createElement('span');
    titleSpan.className = 'task-title';
    titleSpan.textContent = task.title;
    mainBtn.appendChild(titleSpan);
    mainCol.appendChild(mainBtn);

    const metaDiv = document.createElement('div');
    metaDiv.className = 'task-meta';
    const appendMetaText = (text: string): void => {
      const span = document.createElement('span');
      span.textContent = text;
      metaDiv.appendChild(span);
    };

    if (listTitleById && activeView !== 'lists') {
      const listName = listTitleById.get(task.listId);
      if (listName) appendMetaText(listName);
    }
    if (task.steps.length > 0) {
      const doneSteps = task.steps.filter((s) => s.completed).length;
      appendMetaText(`${doneSteps}/${task.steps.length} ${t(store.locale, 'task.steps')}`);
    }
    if (task.dueDate) {
      const dueSpan = document.createElement('span');
      dueSpan.className = isTaskOverdue(task, today)
        ? 'task-due-badge is-overdue'
        : 'task-due-badge';
      dueSpan.textContent = formatShortDate(task.dueDate);
      metaDiv.appendChild(dueSpan);
    }
    if (task.reminderAt) appendMetaText('⏰');
    if (task.recurrence) {
      appendMetaText(`↻ ${t(store.locale, RECURRENCE_LABEL_KEYS[task.recurrence])}`);
    }
    if (task.note.trim()) appendMetaText('📝');
    if (task.assignee?.trim()) appendMetaText(`@${task.assignee.trim()}`);
    for (const tag of extractHashtags(task.title)) {
      const tagBtn = document.createElement('button');
      tagBtn.type = 'button';
      tagBtn.className = 'task-tag-chip';
      tagBtn.textContent = tag;
      tagBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        searchQuery = tag;
        if (searchInput) searchInput.value = tag;
        render();
      });
      metaDiv.appendChild(tagBtn);
    }

    if (metaDiv.childNodes.length > 0) {
      mainCol.appendChild(metaDiv);
    }

    const starBtn = document.createElement('button');
    starBtn.type = 'button';
    starBtn.className = 'task-star-btn';
    starBtn.setAttribute('aria-label', t(store.locale, 'task.starAria'));
    starBtn.disabled = readOnly;
    setStarButtonState(starBtn, task.starred);
    starBtn.addEventListener('click', () => {
      store.toggleTaskStarred(task.id);
      render();
    });

    li.append(leftBtn, mainCol, starBtn);
    return li;
  }

  function createTrashRowElement(
    entry: { kind: 'list'; item: TaskList } | { kind: 'task'; item: TaskItem },
  ): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'task-row';

    const spacer = document.createElement('span');
    spacer.className = 'nav-glyph';
    spacer.setAttribute('aria-hidden', 'true');
    spacer.textContent = entry.kind === 'list' ? '▤' : '○';

    const mainDiv = document.createElement('div');
    mainDiv.className = 'task-main-btn';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'task-title';
    titleSpan.textContent = entry.item.title;
    mainDiv.appendChild(titleSpan);

    const metaParts: string[] = [];
    if (entry.kind === 'list') {
      metaParts.push(t(store.locale, 'trash.listBadge'));
    }
    if (entry.item.deletedAt) {
      metaParts.push(formatShortDate(entry.item.deletedAt.slice(0, 10)));
    }
    if (metaParts.length > 0) {
      const metaDiv = document.createElement('div');
      metaDiv.className = 'task-meta';
      metaDiv.textContent = metaParts.join(' · ');
      mainDiv.appendChild(metaDiv);
    }

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'trash-row-actions';

    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'btn-secondary btn-compact';
    restoreBtn.textContent = t(store.locale, 'trash.restoreBtn');
    restoreBtn.addEventListener('click', () => {
      if (entry.kind === 'list') {
        store.restoreList(entry.item.id);
      } else {
        store.restoreTask(entry.item.id);
      }
      showToast(t(store.locale, 'toast.restored'));
      render();
    });

    const permDeleteBtn = document.createElement('button');
    permDeleteBtn.type = 'button';
    permDeleteBtn.className = 'btn-ghost btn-compact';
    permDeleteBtn.textContent = '×';
    permDeleteBtn.title = t(store.locale, 'trash.deletePermanentBtn');
    permDeleteBtn.setAttribute('aria-label', t(store.locale, 'trash.deletePermanentBtn'));
    permDeleteBtn.addEventListener('click', () => {
      if (entry.kind === 'list') {
        store.permanentlyDeleteList(entry.item.id);
      } else {
        store.permanentlyDeleteTask(entry.item.id);
      }
      render();
    });

    actionsDiv.append(restoreBtn, permDeleteBtn);
    li.append(spacer, mainDiv, actionsDiv);
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
    const plannedItems = filterPlannedTasks(store.tasks, activePlannedFilter, today);
    const allPlannedCount = getPlannedTasks(store.tasks).length;
    const allItems = getAllOpenTasks(store.tasks);
    const assignedItems = getAssignedTasks(store.tasks, store.preferences.displayName);
    const systemTasksItems = getListTasks(store.tasks, defaultTasksId);
    const suggestions = getMyDaySuggestions(
      store.tasks,
      today,
      store.preferences.autoAddDueTodayToMyDay,
    );

    const openStarredCount = starredItems.length;
    const openPlannedCount = allPlannedCount;
    const openAllCount = allItems.length;
    const openAssignedCount = assignedItems.length;
    const openSystemTasksCount = systemTasksItems.filter((item) => !item.completed).length;
    const deletedLists = store.getDeletedLists();
    const deletedTasks = store.getDeletedTasks();
    const trashCount = deletedLists.length + deletedTasks.length;

    (document.getElementById('countMyDay') as HTMLElement).textContent = String(
      myDayItems.filter((item) => !item.completed).length,
    );
    (document.getElementById('countStarred') as HTMLElement).textContent = String(openStarredCount);
    (document.getElementById('countPlanned') as HTMLElement).textContent = String(openPlannedCount);
    (document.getElementById('countAll') as HTMLElement).textContent = String(openAllCount);
    (document.getElementById('countTasks') as HTMLElement).textContent = String(openSystemTasksCount);
    const countAssignedEl = document.getElementById('countAssigned');
    if (countAssignedEl) countAssignedEl.textContent = String(openAssignedCount);
    const countTrashEl = document.getElementById('countTrash');
    if (countTrashEl) countTrashEl.textContent = String(trashCount);

    const navStarred = document.getElementById('navSmartStarred') as HTMLButtonElement | null;
    const navPlanned = document.getElementById('navSmartPlanned') as HTMLButtonElement | null;
    const navAll = document.getElementById('navSmartAll') as HTMLButtonElement | null;
    const navAssigned = document.getElementById('navSmartAssigned') as HTMLButtonElement | null;
    const navTrash = document.getElementById('navSmartTrash') as HTMLButtonElement | null;
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
    if (navAssigned) {
      navAssigned.hidden =
        openAssignedCount === 0 &&
        !store.preferences.displayName.trim() &&
        activeView !== 'assigned';
    }
    if (navTrash) {
      navTrash.hidden =
        store.preferences.autoHideEmptySmartLists && trashCount === 0 && activeView !== 'trash';
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
      activeView === 'lists' ||
        activeView === 'tasks' ||
        activeView === 'all' ||
        activeView === 'assigned' ||
        activeView === 'trash'
        ? 'page'
        : 'false',
    );

    const listsNav = document.getElementById('customListsNav') as HTMLElement;
    listsNav.replaceChildren();
    const createCustomListNavButton = (list: TaskList): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-item';
      btn.setAttribute(
        'aria-current',
        activeView === 'lists' && activeListId === list.id ? 'page' : 'false',
      );

      const labelWrap = document.createElement('span');
      labelWrap.className = 'nav-label-wrap';
      const glyphSpan = document.createElement('span');
      glyphSpan.className = 'nav-glyph';
      glyphSpan.setAttribute('aria-hidden', 'true');
      glyphSpan.appendChild(createCustomListGlyphSvg(list.shared));

      const labelSpan = document.createElement('span');
      labelSpan.className = 'nav-label';
      labelSpan.textContent = list.shared
        ? `${list.title} (${t(store.locale, 'list.sharedBadge')})`
        : list.title;
      labelWrap.append(glyphSpan, labelSpan);

      const countSpan = document.createElement('span');
      countSpan.className = 'nav-count';
      countSpan.textContent = String(
        getListTasks(store.tasks, list.id).filter((item) => !item.completed).length,
      );

      btn.append(labelWrap, countSpan);
      btn.addEventListener('click', () => {
        activeView = 'lists';
        activeListId = list.id;
        closeMobileDrawer();
        render();
      });
      return btn;
    };

    const listsByFolder = new Map<string, TaskList[]>();
    const ungroupedLists: TaskList[] = [];
    for (const list of customLists) {
      const folderName = list.folder?.trim();
      if (folderName) {
        const group = listsByFolder.get(folderName) ?? [];
        group.push(list);
        listsByFolder.set(folderName, group);
      } else {
        ungroupedLists.push(list);
      }
    }
    for (const [folderName, folderLists] of listsByFolder.entries()) {
      const details = document.createElement('details');
      details.className = 'list-folder';
      details.open = true;
      const summary = document.createElement('summary');
      summary.className = 'list-folder-summary';
      summary.textContent = folderName;
      const itemsWrap = document.createElement('div');
      itemsWrap.className = 'list-folder-items';
      for (const list of folderLists) {
        itemsWrap.appendChild(createCustomListNavButton(list));
      }
      details.append(summary, itemsWrap);
      listsNav.appendChild(details);
    }
    for (const list of ungroupedLists) {
      listsNav.appendChild(createCustomListNavButton(list));
    }

    const viewTitle = document.getElementById('viewTitle') as HTMLElement;
    const viewSubtitle = document.getElementById('viewSubtitle') as HTMLElement;
    const suggestionsSection = document.getElementById('suggestionsSection') as HTMLElement;
    const currentList =
      activeView === 'lists' ? customLists.find((l) => l.id === activeListId) : undefined;
    const isCustomList = Boolean(currentList);
    const isForeignList = Boolean(currentList && store.isForeignJoinedList(currentList));
    const isReadOnlyList = Boolean(currentList && currentList.accessRole === 'viewer');
    const renameListBtn = document.getElementById('renameListBtn') as HTMLButtonElement | null;
    const duplicateListBtn = document.getElementById('duplicateListBtn') as HTMLButtonElement | null;
    const deleteListBtn = document.getElementById('deleteListBtn') as HTMLButtonElement | null;
    const shareListBtn = document.getElementById('shareListBtn') as HTMLButtonElement | null;
    const emptyTrashBtn = document.getElementById('emptyTrashBtn') as HTMLButtonElement | null;
    const viewSortSelect = document.getElementById('viewSortSelect') as HTMLSelectElement | null;
    const plannedFilterBar = document.getElementById('plannedFilterBar') as HTMLElement | null;
    if (renameListBtn) {
      renameListBtn.hidden = !isCustomList || isForeignList;
    }
    if (duplicateListBtn) {
      duplicateListBtn.hidden = !isCustomList || isForeignList;
    }
    if (shareListBtn) {
      shareListBtn.hidden = !isCustomList || isForeignList;
    }
    if (viewSortSelect) {
      viewSortSelect.hidden = activeView === 'trash';
      viewSortSelect.value = activeSortMode;
    }
    if (plannedFilterBar) {
      plannedFilterBar.hidden = activeView !== 'planned';
      plannedFilterBar.querySelectorAll<HTMLButtonElement>('[data-planned-filter]').forEach((btn) => {
        btn.setAttribute('aria-pressed', String(btn.dataset.plannedFilter === activePlannedFilter));
      });
    }
    if (deleteListBtn) {
      deleteListBtn.hidden = !isCustomList || (!isForeignList && Boolean(currentList?.shared));
      const deleteLabel = isForeignList
        ? t(store.locale, 'list.leaveBtn')
        : t(store.locale, 'list.delete');
      deleteListBtn.setAttribute('aria-label', deleteLabel);
      deleteListBtn.title = deleteLabel;
    }
    if (emptyTrashBtn) {
      emptyTrashBtn.hidden = activeView !== 'trash' || trashCount === 0;
    }

    const addTaskFormEl = document.getElementById('addTaskForm') as HTMLFormElement | null;
    if (addTaskFormEl) {
      addTaskFormEl.hidden = activeView === 'trash' || isReadOnlyList;
    }

    let visibleTasks: TaskItem[] = [];
    suggestionsSection.hidden = activeView !== 'my-day' || suggestions.length === 0;

    if (activeView === 'trash') {
      viewTitle.textContent = t(store.locale, 'nav.trash');
      viewSubtitle.textContent = t(store.locale, 'trash.subtitle');
      viewSubtitle.hidden = false;

      const activeListEl = document.getElementById('activeTasksList') as HTMLUListElement;
      const trashRows: HTMLLIElement[] = [
        ...deletedLists.map((list) => createTrashRowElement({ kind: 'list', item: list })),
        ...deletedTasks.map((task) => createTrashRowElement({ kind: 'task', item: task })),
      ];
      activeListEl.replaceChildren(...trashRows);

      const emptyEl = document.getElementById('emptyStateText') as HTMLElement;
      emptyEl.hidden = trashRows.length > 0;
      emptyEl.textContent = t(store.locale, 'trash.empty');

      const completedSection = document.getElementById('completedSection') as HTMLElement;
      completedSection.hidden = true;
      (document.getElementById('completedTasksList') as HTMLUListElement).replaceChildren();
      return;
    }

    if (activeView === 'my-day') {
      viewTitle.textContent = t(store.locale, 'nav.myDay');
      viewSubtitle.textContent = new Intl.DateTimeFormat(store.locale === 'de' ? 'de-DE' : 'en-US', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      }).format(new Date());
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
    } else if (activeView === 'assigned') {
      viewTitle.textContent = t(store.locale, 'nav.assigned');
      viewSubtitle.textContent = store.preferences.displayName.trim()
        ? `@${store.preferences.displayName.trim().replace(/^@+/, '')}`
        : '';
      visibleTasks = assignedItems;
    } else {
      viewTitle.textContent = currentList?.title ?? t(store.locale, 'nav.lists');
      const folderPrefix = currentList?.folder?.trim() ? `${currentList.folder.trim()} · ` : '';
      viewSubtitle.textContent = isReadOnlyList
        ? `${folderPrefix}${t(store.locale, 'list.sharedBadge')} · ${t(store.locale, 'list.readOnlyBadge')}`
        : currentList?.shared
          ? `${folderPrefix}${t(store.locale, 'list.sharedBadge')}`
          : currentList?.folder?.trim() ?? '';
      visibleTasks = currentList ? getListTasks(store.tasks, currentList.id) : [];
    }
    viewSubtitle.hidden = viewSubtitle.textContent.length === 0;

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
      activeSortMode,
    );
    const doneTasks = filteredVisible.filter((item) => item.completed);
    const openTaskIds = openTasks.map((item) => item.id);

    const activeListEl = document.getElementById('activeTasksList') as HTMLUListElement;
    activeListEl.replaceChildren(
      ...openTasks.map((item) => createTaskElement(item, false, listTitleById, openTaskIds)),
    );

    const emptyEl = document.getElementById('emptyStateText') as HTMLElement;
    emptyEl.hidden = openTasks.length > 0;
    emptyEl.textContent = hasSearch
      ? t(store.locale, 'task.emptySearch')
      : t(store.locale, 'task.emptyView');

    const completedSection = document.getElementById('completedSection') as HTMLElement;
    const completedListEl = document.getElementById('completedTasksList') as HTMLUListElement;
    const clearCompletedBtn = document.getElementById('clearCompletedBtn') as HTMLButtonElement | null;
    completedSection.hidden = doneTasks.length === 0;
    if (clearCompletedBtn) {
      clearCompletedBtn.hidden = doneTasks.length === 0 || isReadOnlyList;
    }
    (document.getElementById('completedCount') as HTMLElement).textContent = String(doneTasks.length);
    completedListEl.replaceChildren(
      ...doneTasks.map((item) => createTaskElement(item, false, listTitleById)),
    );
    void syncNativeLocalNotifications();
  }

  function refreshShareDialogState(listId: string): void {
    const urlInput = document.getElementById('shareInviteUrlInput') as HTMLInputElement;
    const unshareBtn = document.getElementById('unshareListBtn') as HTMLButtonElement;
    const copyBtn = document.getElementById('copyInviteUrlBtn') as HTMLButtonElement | null;
    const nativeBtn = document.getElementById('nativeShareInviteBtn') as HTMLButtonElement | null;
    const freeLimitHint = document.getElementById('shareFreeLimitHint') as HTMLElement | null;
    const existingUrl = store.getInviteUrl(
      listId,
      getShareBaseOrigin(window.location.origin, store.serverUrl),
    );
    const allowedToShare = listId ? store.canShareAnotherOwnedList(listId) : false;
    if (freeLimitHint) {
      freeLimitHint.hidden = allowedToShare || !listId;
    }
    if (copyBtn) copyBtn.disabled = !listId || !allowedToShare;
    if (nativeBtn) nativeBtn.disabled = !listId || !allowedToShare;
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
      .filter((list) => !store.isSystemTasksList(list.id) && !store.isForeignJoinedList(list));
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
    const detailAssigneeInput = document.getElementById(
      'detailAssigneeInput',
    ) as HTMLInputElement | null;
    if (detailAssigneeInput) detailAssigneeInput.value = task.assignee ?? '';
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

    const isReadOnly = store.isReadOnlyList(task.listId);
    const detailControls: Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement | null> = [
      document.getElementById('detailTitleInput') as HTMLInputElement | null,
      document.getElementById('detailDueDateInput') as HTMLInputElement | null,
      document.getElementById('detailReminderInput') as HTMLInputElement | null,
      document.getElementById('detailRecurrenceSelect') as HTMLSelectElement | null,
      document.getElementById('detailNoteInput') as HTMLTextAreaElement | null,
      document.getElementById('detailAssigneeInput') as HTMLInputElement | null,
      document.getElementById('presetDueTodayBtn') as HTMLButtonElement | null,
      document.getElementById('presetDueTomorrowBtn') as HTMLButtonElement | null,
      document.getElementById('presetDueNextWeekBtn') as HTMLButtonElement | null,
      document.getElementById('presetRemTodayBtn') as HTMLButtonElement | null,
      document.getElementById('presetRemTomorrowBtn') as HTMLButtonElement | null,
      document.getElementById('detailNewStepInput') as HTMLInputElement | null,
      document.getElementById('detailAddStepBtn') as HTMLButtonElement | null,
      document.getElementById('detailDeleteBtn') as HTMLButtonElement | null,
      listSelect,
      myDayBtn,
      starBtn,
      document.querySelector('#taskDetailForm button[type="submit"]') as HTMLButtonElement | null,
    ];
    for (const ctrl of detailControls) {
      if (ctrl) ctrl.disabled = isReadOnly;
    }

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
    setStarButtonState(newTaskStarBtn, quickAddStarred);
  });

  const newTaskDueDateInput = document.getElementById('newTaskDueDate') as
    | (HTMLInputElement & { showPicker?: () => void })
    | null;
  newTaskDueDateInput?.addEventListener('change', updateQuickAddDateChip);
  newTaskDueDateInput?.addEventListener('click', () => {
    try {
      newTaskDueDateInput.showPicker?.();
    } catch {
      // Ignore if picker is already open or unsupported in current WebView
    }
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
    updateQuickAddDateChip();
    quickAddStarred = false;
    setStarButtonState(newTaskStarBtn, false);
    trackDiagnostic('task_created');
    render();
  });

  document.getElementById('renameListBtn')?.addEventListener('click', () => {
    const currentList = store.getActiveLists().find((l) => l.id === activeListId);
    if (!currentList) return;
    (document.getElementById('renameListInput') as HTMLInputElement).value = currentList.title;
    const folderInput = document.getElementById('renameListFolderInput') as HTMLInputElement | null;
    if (folderInput) folderInput.value = currentList.folder ?? '';
    const datalist = document.getElementById('folderSuggestionsList');
    if (datalist) {
      datalist.replaceChildren(
        ...store.getListFolders().map((name) => {
          const opt = document.createElement('option');
          opt.value = name;
          return opt;
        }),
      );
    }
    renameListDialog.showModal();
  });

  document.getElementById('renameListForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('renameListInput') as HTMLInputElement;
    const folderInput = document.getElementById('renameListFolderInput') as HTMLInputElement | null;
    if (!input.value.trim()) return;
    store.renameList(activeListId, input.value, folderInput ? folderInput.value : undefined);
    void closeTopLayer(renameListDialog);
    showToast(t(store.locale, 'list.renamedToast'));
    render();
  });

  document.getElementById('duplicateListBtn')?.addEventListener('click', () => {
    const currentList = store.getActiveLists().find((l) => l.id === activeListId);
    if (!currentList || store.isSystemTasksList(activeListId) || store.isForeignJoinedList(currentList)) {
      return;
    }
    const copy = store.duplicateList(currentList.id);
    activeView = 'lists';
    activeListId = copy.id;
    showToast(t(store.locale, 'list.duplicatedToast'));
    render();
  });

  document.getElementById('viewSortSelect')?.addEventListener('change', (event) => {
    activeSortMode = (event.target as HTMLSelectElement).value as TaskSortMode;
    render();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-planned-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activePlannedFilter = (btn.dataset.plannedFilter as PlannedFilterId) || 'all';
      render();
    });
  });

  document.getElementById('clearCompletedBtn')?.addEventListener('click', () => {
    const count = store.clearCompletedTasks(
      activeView === 'lists' ? activeListId : undefined,
    );
    if (count > 0) {
      showToast(t(store.locale, 'toast.completedCleared'));
      render();
    }
  });

  document.getElementById('deleteListBtn')?.addEventListener('click', () => {
    const currentList = store.getActiveLists().find((l) => l.id === activeListId);
    if (!currentList || store.isSystemTasksList(activeListId) || store.getActiveLists().length <= 1) {
      return;
    }
    if (store.isForeignJoinedList(currentList)) {
      store.leaveSharedList(currentList.id);
      activeView = 'my-day';
      activeListId = store.getDefaultTasksListId();
      showToast(t(store.locale, 'toast.leftSharedList'));
      render();
      return;
    }
    if (currentList.shared) {
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

  document.getElementById('emptyTrashBtn')?.addEventListener('click', () => {
    requestDeleteConfirmation(t(store.locale, 'trash.emptyBtn'), () => {
      store.emptyTrash();
      showToast(t(store.locale, 'toast.trashEmptied'));
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
    } catch (err) {
      if (err instanceof SharedListLimitError) {
        refreshShareDialogState(listId);
        showToast(t(store.locale, 'toast.shareLimitReached'));
      } else {
        throw err;
      }
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
    try {
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
    } catch (err) {
      if (err instanceof SharedListLimitError) {
        refreshShareDialogState(listId);
        showToast(t(store.locale, 'toast.shareLimitReached'));
      }
    }
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

  const joinSharedListInputEl = document.getElementById(
    'joinSharedListInput',
  ) as HTMLInputElement | null;
  const stripJoinInputUrl = (): void => {
    if (!joinSharedListInputEl || !/[/:?=\s]/.test(joinSharedListInputEl.value)) return;
    const raw = joinSharedListInputEl.value;
    const looksLikePairing =
      raw.includes('pair=') ||
      raw.includes('key=') ||
      extractSyncKeyFromInput(raw).startsWith('pling-');
    const stripped = looksLikePairing
      ? extractSyncKeyFromInput(raw)
      : extractInviteTokenFromInput(raw);
    if (stripped && stripped !== raw) {
      joinSharedListInputEl.value = stripped;
    }
  };
  joinSharedListInputEl?.addEventListener('input', stripJoinInputUrl);
  joinSharedListInputEl?.addEventListener('change', stripJoinInputUrl);

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
        await store.syncWithServer(undefined, { replaceOldestDevice: true });
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
    const currentTask = store.tasks.find((item) => item.id === editingTaskId);
    if (!currentTask || store.isReadOnlyList(currentTask.listId)) return;
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
    const assigneeInput = document.getElementById(
      'detailAssigneeInput',
    ) as HTMLInputElement | null;
    store.updateTask(editingTaskId, {
      title: (document.getElementById('detailTitleInput') as HTMLInputElement).value,
      dueDate: (document.getElementById('detailDueDateInput') as HTMLInputElement).value || null,
      reminderAt,
      recurrence: (recurrenceVal || null) as RecurrencePattern | null,
      note: (document.getElementById('detailNoteInput') as HTMLTextAreaElement).value,
      ...(assigneeInput ? { assignee: assigneeInput.value } : {}),
      ...(nextListId ? { listId: nextListId } : {}),
    });
  }

  document.getElementById('presetDueTodayBtn')?.addEventListener('click', () => {
    (document.getElementById('detailDueDateInput') as HTMLInputElement).value = getLocalIsoDate();
  });
  document.getElementById('presetDueTomorrowBtn')?.addEventListener('click', () => {
    (document.getElementById('detailDueDateInput') as HTMLInputElement).value = computeNextDueDate(
      getLocalIsoDate(),
      'daily',
    );
  });
  document.getElementById('presetDueNextWeekBtn')?.addEventListener('click', () => {
    (document.getElementById('detailDueDateInput') as HTMLInputElement).value = computeNextDueDate(
      getLocalIsoDate(),
      'weekly',
    );
  });
  document.getElementById('presetRemTodayBtn')?.addEventListener('click', () => {
    (document.getElementById('detailReminderInput') as HTMLInputElement).value =
      `${getLocalIsoDate()}T18:00`;
  });
  document.getElementById('presetRemTomorrowBtn')?.addEventListener('click', () => {
    const tomorrow = computeNextDueDate(getLocalIsoDate(), 'daily');
    (document.getElementById('detailReminderInput') as HTMLInputElement).value =
      `${tomorrow}T09:00`;
  });

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
    const displayNameInput = document.getElementById(
      'settingsDisplayNameInput',
    ) as HTMLInputElement | null;
    if (displayNameInput) displayNameInput.value = store.preferences.displayName;
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

  const settingsSyncKeyInputEl = document.getElementById(
    'settingsSyncKeyInput',
  ) as HTMLInputElement | null;
  const stripSettingsSyncKeyInputUrl = (): void => {
    if (!settingsSyncKeyInputEl || settingsSyncKeyInputEl.readOnly) return;
    if (!/[/:?=\s]/.test(settingsSyncKeyInputEl.value)) return;
    const stripped = extractSyncKeyFromInput(settingsSyncKeyInputEl.value);
    if (stripped && stripped !== settingsSyncKeyInputEl.value) {
      settingsSyncKeyInputEl.value = stripped;
    }
  };
  settingsSyncKeyInputEl?.addEventListener('input', stripSettingsSyncKeyInputUrl);
  settingsSyncKeyInputEl?.addEventListener('change', stripSettingsSyncKeyInputUrl);

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
    const errEl = document.getElementById('settingsErrorText') as HTMLElement | null;
    const syncKeyInput = document.getElementById('settingsSyncKeyInput') as HTMLInputElement | null;
    const serverUrlInput = document.getElementById(
      'settingsServerUrlInput',
    ) as HTMLInputElement | null;
    const editBtn = document.getElementById('editSettingsSyncKeyBtn') as HTMLButtonElement | null;

    if (serverUrlInput && serverUrlInput.value.trim()) {
      try {
        store.setServerUrl(serverUrlInput.value);
      } catch {
        if (errEl) {
          selectSettingsTab('sync');
          errEl.textContent = t(store.locale, 'settings.serverUrlInvalid');
          errEl.hidden = false;
        }
        return;
      }
    }

    let keyChanged = false;
    if (syncKeyInput) {
      const candidate = extractSyncKeyFromInput(syncKeyInput.value);
      if (candidate !== store.syncKey) {
        try {
          store.setSyncKey(syncKeyInput.value, { forceReset: true });
          syncKeyInput.value = store.syncKey;
          syncKeyInput.readOnly = true;
          if (editBtn) editBtn.hidden = false;
          keyChanged = true;
        } catch {
          if (errEl) {
            selectSettingsTab('sync');
            errEl.textContent = t(store.locale, 'settings.syncKeyInvalid');
            errEl.hidden = false;
          }
          return;
        }
      }
    }
    if (errEl) errEl.hidden = true;

    if (btn) {
      btn.disabled = true;
      btn.dataset.loading = 'true';
    }
    try {
      store.forceFullSync();
      if (keyChanged) {
        const res = await store.syncWithServer(undefined, { replaceOldestDevice: true });
        if (res.synced) {
          hasSyncedOnce = true;
          selectBestViewAfterPairing();
          showToast(t(store.locale, 'toast.devicePaired'));
        } else {
          showToast(t(store.locale, 'toast.pairFailed'));
        }
        trackDiagnostic('device_paired');
        render();
      } else {
        await runSyncNow();
      }
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
      displayName:
        (
          document.getElementById('settingsDisplayNameInput') as HTMLInputElement | null
        )?.value
          .trim()
          .replace(/^@+/, '') ?? store.preferences.displayName,
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
        const res = await store.syncWithServer(undefined, { replaceOldestDevice: true });
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

  async function syncNativeLocalNotifications(): Promise<void> {
    if (!isNativeShellOrigin()) return;
    const localNotifications = (
      window as {
        Capacitor?: {
          Plugins?: {
            LocalNotifications?: {
              checkPermissions?: () => Promise<{ display?: string }>;
              requestPermissions?: () => Promise<{ display?: string }>;
              getPending?: () => Promise<{ notifications?: Array<{ id: number }> }>;
              cancel?: (opts: { notifications: Array<{ id: number }> }) => Promise<void>;
              schedule?: (opts: {
                notifications: Array<{
                  id: number;
                  title: string;
                  body: string;
                  schedule: { at: Date };
                }>;
              }) => Promise<void>;
            };
          };
        };
      }
    ).Capacitor?.Plugins?.LocalNotifications;
    if (!localNotifications?.schedule) return;

    const nowMs = Date.now();
    const upcoming = store.tasks
      .filter((task) => {
        if (task.deletedAt !== null || task.completed || !task.reminderAt) return false;
        const atMs = Date.parse(task.reminderAt);
        return Number.isFinite(atMs) && atMs > nowMs + 2000;
      })
      .map((task) => {
        let hash = 2166136261;
        const key = `${task.id}:${task.reminderAt}`;
        for (let i = 0; i < key.length; i += 1) {
          hash ^= key.charCodeAt(i);
          hash = Math.imul(hash, 16777619);
        }
        return {
          id: (hash & 0x7fffffff) || 1,
          title: 'Plinglist',
          body: task.title,
          atIso: task.reminderAt!,
          schedule: { at: new Date(task.reminderAt!) },
        };
      });

    const sig = upcoming.map((n) => `${n.id}@${n.atIso}:${n.body}`).join('|');
    if (sig === lastScheduledNotificationsSig) return;
    lastScheduledNotificationsSig = sig;

    try {
      const perm = await localNotifications.checkPermissions?.();
      if (perm?.display !== 'granted' && upcoming.length > 0) {
        const requested = await localNotifications.requestPermissions?.();
        if (requested?.display !== 'granted') return;
      }
      const pending = await localNotifications.getPending?.();
      if (pending?.notifications?.length) {
        await localNotifications.cancel?.({ notifications: pending.notifications });
      }
      if (upcoming.length > 0) {
        await localNotifications.schedule({
          notifications: upcoming.map(({ id, title, body, schedule }) => ({
            id,
            title,
            body,
            schedule,
          })),
        });
      }
    } catch {
      // Ignore environments without LocalNotifications permissions
    }
  }

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
        await store.syncWithServer(undefined, { replaceOldestDevice: true });
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
            getInfo?: () => Promise<{ version?: string; build?: string } | null | undefined>;
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

  async function handleJoinParamOnStartup(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const legalParam = params.get('legal');
    if (legalParam === 'imprint' || legalParam === 'privacy') {
      openLegalModal(legalParam);
    }

    let didStartupSync = false;
    const pairKey = params.get('pair');
    if (pairKey) {
      params.delete('pair');
      const cleanQuery = params.toString();
      const cleanUrl = `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', cleanUrl);
      try {
        // Apply syncKey synchronously before any await so focus/visibility listeners never sync the throwaway key.
        store.setSyncKey(pairKey, { forceReset: true });
        await store.syncWithServer(undefined, { replaceOldestDevice: true });
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
