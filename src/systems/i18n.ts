/** i18n — 18 languages. Locale dictionaries live in ./locales/. */

import { en, Dict } from './locales/en';
import { zh } from './locales/zh';
import { hi } from './locales/hi';
import { es } from './locales/es';
import { ar } from './locales/ar';
import { fr } from './locales/fr';
import { bn } from './locales/bn';
import { pt } from './locales/pt';
import { id } from './locales/id';
import { ur } from './locales/ur';
import { ru } from './locales/ru';
import { de } from './locales/de';
import { ja } from './locales/ja';
import { pcm } from './locales/pcm';
import { mr } from './locales/mr';
import { te } from './locales/te';
import { tr } from './locales/tr';
import { az } from './locales/az';

export type Lang =
  | 'en' | 'zh' | 'hi' | 'es' | 'ar' | 'fr' | 'bn' | 'pt' | 'id'
  | 'ur' | 'ru' | 'de' | 'ja' | 'pcm' | 'mr' | 'te' | 'tr' | 'az';

export interface LangMeta {
  code: Lang;
  /** name in its own script, for the picker */
  native: string;
  /** english name, for accessibility */
  english: string;
  /** BCP-47 for html lang */
  bcp47: string;
  rtl: boolean;
}

export const LANGS: readonly LangMeta[] = [
  { code: 'en',  native: 'English',            english: 'English',             bcp47: 'en',    rtl: false },
  { code: 'zh',  native: '中文',               english: 'Chinese (Simplified)', bcp47: 'zh-CN', rtl: false },
  { code: 'hi',  native: 'हिन्दी',              english: 'Hindi',               bcp47: 'hi',    rtl: false },
  { code: 'es',  native: 'Español',            english: 'Spanish',             bcp47: 'es',    rtl: false },
  { code: 'ar',  native: 'العربية',            english: 'Arabic',              bcp47: 'ar',    rtl: true },
  { code: 'fr',  native: 'Français',           english: 'French',              bcp47: 'fr',    rtl: false },
  { code: 'bn',  native: 'বাংলা',              english: 'Bengali',             bcp47: 'bn',    rtl: false },
  { code: 'pt',  native: 'Português',          english: 'Portuguese',          bcp47: 'pt',    rtl: false },
  { code: 'id',  native: 'Bahasa Indonesia',   english: 'Indonesian',          bcp47: 'id',    rtl: false },
  { code: 'ur',  native: 'اردو',               english: 'Urdu',                bcp47: 'ur',    rtl: true },
  { code: 'ru',  native: 'Русский',            english: 'Russian',             bcp47: 'ru',    rtl: false },
  { code: 'de',  native: 'Deutsch',            english: 'German',              bcp47: 'de',    rtl: false },
  { code: 'ja',  native: '日本語',              english: 'Japanese',            bcp47: 'ja',    rtl: false },
  { code: 'pcm', native: 'Naija (Pidgin)',     english: 'Nigerian Pidgin',     bcp47: 'pcm',   rtl: false },
  { code: 'mr',  native: 'मराठी',               english: 'Marathi',             bcp47: 'mr',    rtl: false },
  { code: 'te',  native: 'తెలుగు',              english: 'Telugu',              bcp47: 'te',    rtl: false },
  { code: 'tr',  native: 'Türkçe',             english: 'Turkish',             bcp47: 'tr',    rtl: false },
  { code: 'az',  native: 'Azərbaycanca',       english: 'Azerbaijani',         bcp47: 'az',    rtl: false },
];

const DICTS: Record<Lang, Dict> = {
  en, zh, hi, es, ar, fr, bn, pt, id, ur, ru, de, ja, pcm, mr, te, tr, az,
};

let current: Lang = 'en';

export function detectLang(): Lang {
  if (typeof navigator === 'undefined') return 'en';
  const candidates: string[] = [];
  if (navigator.languages) candidates.push(...navigator.languages);
  if (navigator.language) candidates.push(navigator.language);
  for (const raw of candidates) {
    const nav = raw.toLowerCase();
    for (const meta of LANGS) {
      if (nav.startsWith(meta.code)) return meta.code;
    }
    // regional aliases not covered by the primary code
    if (nav.startsWith('zh-hant') || nav.startsWith('zh-tw') || nav.startsWith('zh-hk')) return 'zh';
    if (nav.startsWith('pt-br')) return 'pt';
    if (nav.startsWith('cmn')) return 'zh';
  }
  return 'en';
}

export function setLang(l: Lang | 'auto'): void {
  current = l === 'auto' ? detectLang() : l;
}

export function getLang(): Lang {
  return current;
}

export function isRTL(): boolean {
  return LANGS.find(m => m.code === current)?.rtl ?? false;
}

export function langMeta(l: Lang): LangMeta {
  return LANGS.find(m => m.code === l) ?? LANGS[0];
}

/** t('gemsEarned', {n: 40}) → "+40 gems" */
export function t(key: keyof Dict, vars?: Record<string, string | number>): string {
  let s = DICTS[current][key] ?? DICTS.en[key] ?? String(key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(`{${k}}`, String(v));
    }
  }
  return s;
}
