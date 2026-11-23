export type SupportedLocale = 'en' | 'de';

export const TRANSLATIONS = {
  en: {
    'app.tagline': 'Pling. Done. – The simple to-do list that stays.',
    'nav.myDay': 'My Day',
    'nav.starred': 'Starred',
    'nav.planned': 'Planned',
    'nav.lists': 'Lists',
    'myDay.suggestionsTitle': 'Suggestions for today',
    'myDay.resetHint': 'Resets automatically at midnight',
    'task.addPlaceholder': 'Add a task...',
    'task.steps': 'Steps',
    'task.dueDate': 'Due date',
    'task.reminder': 'Remind me',
    'task.recurrence': 'Repeat',
    'task.note': 'Add note',
    'list.share': 'Share list',
    'importer.title': 'Import from Wunderlist or Microsoft To Do',
    'sync.offline': 'Offline – changes saved locally',
    'sync.synced': 'Synced',
    'settings.serverUrl': 'Server URL',
  },
  de: {
    'app.tagline': 'Pling. Done. – The simple to-do list that stays.',
    'nav.myDay': 'Mein Tag',
    'nav.starred': 'Wichtig',
    'nav.planned': 'Geplant',
    'nav.lists': 'Listen',
    'myDay.suggestionsTitle': 'Vorschläge für heute',
    'myDay.resetHint': 'Setzt sich um Mitternacht automatisch zurück',
    'task.addPlaceholder': 'Aufgabe hinzufügen...',
    'task.steps': 'Schritte',
    'task.dueDate': 'Fälligkeitsdatum',
    'task.reminder': 'Erinnern',
    'task.recurrence': 'Wiederholen',
    'task.note': 'Notiz hinzufügen',
    'list.share': 'Liste teilen',
    'importer.title': 'Aus Wunderlist oder Microsoft To Do importieren',
    'sync.offline': 'Offline – Änderungen lokal gespeichert',
    'sync.synced': 'Synchronisiert',
    'settings.serverUrl': 'Server-URL',
  },
} as const;

export type TranslationKey = keyof typeof TRANSLATIONS.en;

export function t(locale: SupportedLocale, key: TranslationKey): string {
  return TRANSLATIONS[locale][key];
}
