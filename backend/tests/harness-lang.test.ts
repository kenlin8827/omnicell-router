import { describe, expect, it } from 'bun:test';
import { scriptLanguage } from '../src/harness/lang.js';

/**
 * Script evidence for a third-party document (ADR-0015 §D6 "readmeLang").
 *
 * The verdict is a NEGATIVE filter with positive exceptions: only scripts that cannot be confused are
 * named, everything Latin answers `null` (never "English"), and too little prose answers `null`
 * rather than a guess. A wrong `zh`/`ja` verdict silently skips a translation the operator needed.
 */

const ZH = '这是一个用于测试的中文段落，描述了插件的用途、安装方式和限制条件，足够长以便超过字母阈值。';
const JA = 'これはテスト用の日本語の段落です。プラグインの用途とインストール方法、制限事項について説明しています。';
const KO = '이것은 테스트용 한국어 문단입니다. 플러그인의 용도와 설치 방법, 제한 사항을 자세히 설명하고 있으며, 처음 설치하는 사용자에게 필요한 주의 사항도 함께 안내합니다.';

describe('scriptLanguage', () => {
  it('names Han-dominant prose as Chinese', () => {
    expect(scriptLanguage(ZH)).toBe('zh');
  });

  it('names kana-bearing prose as Japanese even though it is Han-heavy', () => {
    // A Japanese page is mostly Han plus kana: kana wins over the Han ratio, which is why the order
    // of the checks matters.
    expect(scriptLanguage(JA)).toBe('ja');
  });

  it('names Hangul prose as Korean', () => {
    expect(scriptLanguage(KO)).toBe('ko');
  });

  it('answers null — never "English" — for Latin-script prose', () => {
    expect(scriptLanguage('A plugin that turns images into structured evidence for agents. '.repeat(4))).toBeNull();
  });

  it('answers null when there is too little prose to judge', () => {
    expect(scriptLanguage('中文')).toBeNull();
    expect(scriptLanguage('![badge](https://img.shields.io/x.svg)')).toBeNull();
  });

  it('ignores fenced code: a Chinese sample inside a block is not the document language', () => {
    const english = 'This package installs a bridge between the runtime and the gateway. '.repeat(2);
    expect(scriptLanguage(`${english}\n\n\`\`\`bash\n${ZH}\n\`\`\`\n`)).toBeNull();
  });

  it('answers null for a mixed document below the Han threshold', () => {
    // 8 Han among 40 letters (0.2): Latin technical prose quoting a Chinese product name is not a
    // Chinese document, and translating it would be the wrong spend.
    const mixed = `${'plugin gateway runtime router '.repeat(8)}技能技能技能技能技能技能技能技能`;
    expect(scriptLanguage(mixed)).toBeNull();
  });
});
