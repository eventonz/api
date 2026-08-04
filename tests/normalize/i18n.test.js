const { i18n, groupLabel } = require('../../src/services/rrpublish/normalize/i18n');

describe('i18n decode', () => {
  test('plain strings pass through', () => {
    expect(i18n('Marathon', 'en')).toBe('Marathon');
  });
  test('picks requested language', () => {
    expect(i18n('{EN:Overall|DE:Gesamt}', 'de')).toBe('Gesamt');
  });
  test('falls back to EN', () => {
    expect(i18n('{FR:Général|EN:Overall}', 'de')).toBe('Overall');
  });
  test('falls back to first when no EN', () => {
    expect(i18n('{FR:Général|DE:Gesamt}', 'es')).toBe('Général');
  });
  test('adjacent-braces form', () => {
    expect(i18n('{EN:Men}{DE:Männer}', 'de')).toBe('Männer');
  });
  test('cz aliases to cs', () => {
    expect(i18n('{CS:Muži|EN:Men}', 'cz')).toBe('Muži');
  });
  test('/// becomes space', () => {
    expect(i18n('Half///Marathon', 'en')).toBe('Half Marathon');
  });
  test('non-i18n braces untouched', () => {
    expect(i18n('{whatever}', 'en')).toBe('{whatever}');
  });
});

describe('groupLabel', () => {
  test('strips #N_ sort prefix', () => {
    expect(groupLabel('#1_Marathon', 'en')).toBe('Marathon');
  });
  test('prefix plus i18n', () => {
    expect(groupLabel('#2_{EN:Men|DE:Männer}', 'de')).toBe('Männer');
  });
  test('plain key untouched', () => {
    expect(groupLabel('Marathon', 'en')).toBe('Marathon');
  });
});
