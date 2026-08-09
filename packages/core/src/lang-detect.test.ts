import { describe, expect, it } from 'vitest';
import { checkLanguage, proseOnly } from './lang-detect.js';
import { NARRATE_LANGS, type NarrateLang } from './model.js';

/**
 * One representative sentence per supported language, written the way the
 * pipeline's own prose reads: a stage overview, with a technical term or two.
 */
const SAMPLES: Record<NarrateLang, string> = {
  en: 'This stage is the front desk of the system. It takes the raw command line and turns it into a structured configuration that the rest of the application can safely use later on.',
  zh: '本阶段是系统的前台：它接收原始的命令行文本，并把它转换成应用其余部分可以安全使用的结构化配置对象。这一步在任何搜索开始之前运行。',
  ja: 'このステージはシステムの受付です。生のコマンドラインを受け取り、アプリケーションの他の部分が安全に利用できる構造化された設定に変換します。',
  ru: 'Этот этап — стойка регистрации системы. Он принимает необработанную командную строку и превращает её в структурированную конфигурацию, которую остальная часть приложения может безопасно использовать.',
  hi: 'यह stage सिस्टम का स्वागत डेस्क है। यह कच्ची कमांड लाइन लेता है और उसे एक संरचित कॉन्फ़िगरेशन में बदल देता है जिसे बाकी एप्लिकेशन सुरक्षित रूप से उपयोग कर सकता है।',
  es: 'Esta etapa es la recepción del sistema. Toma la línea de comandos en bruto y la convierte en una configuración estructurada que el resto de la aplicación puede usar con seguridad más adelante.',
  pt: 'Esta etapa é a recepção do sistema. Ela recebe a linha de comando bruta e a converte em uma configuração estruturada que o restante da aplicação pode usar com segurança mais adiante.',
  de: 'Diese Etappe ist die Anmeldung des Systems. Sie nimmt die rohe Kommandozeile entgegen und wandelt sie in eine strukturierte Konfiguration um, die der Rest der Anwendung sicher verwenden kann.',
};

describe('checkLanguage — every supported language recognises itself', () => {
  it('covers all eight, so a new language cannot be added without a sample', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...NARRATE_LANGS].sort());
  });

  for (const lang of NARRATE_LANGS) {
    it(`accepts ${lang} prose as ${lang}`, () => {
      const verdict = checkLanguage(SAMPLES[lang], lang);
      expect(verdict.decided, verdict.detail).toBe(true);
      expect(verdict.ok, verdict.detail).toBe(true);
    });
  }
});

describe('checkLanguage — every wrong pairing is caught', () => {
  it('catches all 56 cross-language combinations', () => {
    const missed: string[] = [];
    for (const wrote of NARRATE_LANGS) {
      for (const wanted of NARRATE_LANGS) {
        if (wrote === wanted) continue;
        const verdict = checkLanguage(SAMPLES[wrote], wanted);
        if (!(verdict.decided && !verdict.ok))
          missed.push(`${wrote} passed as ${wanted} (${verdict.detail})`);
      }
    }
    expect(missed).toEqual([]);
  });

  it('separates Chinese from Japanese, which share ideographs', () => {
    // The pair the script test could most easily get wrong in both directions.
    expect(checkLanguage(SAMPLES.ja, 'zh')).toMatchObject({ ok: false, decided: true, looksLike: 'ja' });
    expect(checkLanguage(SAMPLES.zh, 'ja')).toMatchObject({ ok: false, decided: true, looksLike: 'zh' });
  });

  it('catches non-Latin prose when a Latin language was asked for', () => {
    // Regression: this used to score "too few words to judge" and sail through
    // as no-opinion — the loudest failure the check exists to catch.
    for (const wrote of ['zh', 'ja', 'ru', 'hi'] as NarrateLang[]) {
      for (const wanted of ['en', 'es', 'pt', 'de'] as NarrateLang[]) {
        const verdict = checkLanguage(SAMPLES[wrote], wanted);
        expect(verdict.decided && !verdict.ok, `${wrote} as ${wanted}: ${verdict.detail}`).toBe(true);
      }
    }
  });
});

describe('checkLanguage — refuses to judge text that carries no language', () => {
  /**
   * A false accusation costs a retry and, worse, teaches whoever reads the
   * report to ignore it. Silence is the correct answer here.
   */
  const noSignal = [
    ['identifiers only', 'parseConfig -> Config; loadAll(); Uploader.send'],
    ['a path', 'src/ingest/loader.ts'],
    ['a signature', 'export async function loadAll(root: string): Promise<Source[]>'],
    ['empty', ''],
    ['a number', '42'],
  ] as const;

  for (const [what, text] of noSignal) {
    it(`says nothing about ${what}`, () => {
      for (const lang of NARRATE_LANGS) {
        const verdict = checkLanguage(text, lang);
        expect(verdict.decided, `${lang}: ${verdict.detail}`).toBe(false);
      }
    });
  }

  it('does not mistake a code block inside prose for the prose', () => {
    const mixed = 'このステージは設定を読み込みます。\n\n```ts\nexport function load(): Config {}\n```';
    expect(checkLanguage(mixed, 'ja')).toMatchObject({ ok: true, decided: true });
    expect(proseOnly(mixed)).not.toContain('export function');
  });
});
