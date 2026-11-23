import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SERVER_URL, normalizeServerUrl } from '../src/config.ts';
import { TRANSLATIONS, t } from '../src/i18n.ts';
import { resolveCompletionSoundSource } from '../src/audio.ts';

test('i18n dictionaries have 100% key parity between en and de', () => {
  const enKeys = Object.keys(TRANSLATIONS.en).sort();
  const deKeys = Object.keys(TRANSLATIONS.de).sort();

  assert.deepEqual(deKeys, enKeys);
  assert.equal(t('de', 'nav.myDay'), 'Mein Tag');
  assert.equal(t('en', 'nav.myDay'), 'My Day');
});

test('normalizeServerUrl defaults to official API and validates self-hosted URLs', () => {
  assert.equal(normalizeServerUrl(), DEFAULT_SERVER_URL);
  assert.equal(normalizeServerUrl('  '), DEFAULT_SERVER_URL);
  assert.equal(
    normalizeServerUrl('https://todo.example.org///'),
    'https://todo.example.org',
  );
  assert.equal(
    normalizeServerUrl('http://localhost:3001/'),
    'http://localhost:3001',
  );
  assert.throws(() => normalizeServerUrl('ftp://invalid.example.com'));
  assert.throws(() => normalizeServerUrl('not-a-url'));
});

test('public audio defaults to CC0 synth unless brand overlay is applied', () => {
  assert.equal(resolveCompletionSoundSource(false), 'cc0-synth');
  assert.equal(resolveCompletionSoundSource(true), 'brand-overlay');
});
