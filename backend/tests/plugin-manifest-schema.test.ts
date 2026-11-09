import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateConfigSchema, validatePluginManifest } from '../src/plugins/manifest.js';

/**
 * `configSchema` validation (ADR-0017 §7): a malformed schema fails the package
 * loudly at install/load. These cases cover the parts the console RENDERS or
 * COERCES against — `title`/`desc` (label + hint), `min`/`max` (number bounds)
 * and `default` — because each of them used to pass validation and then break
 * silently: an unvalidated `title` printed as `[object Object]`, a numeric bound
 * stored as a string invalidated every value so the field always fell back.
 */

const wrap = (field: Record<string, unknown>): unknown[] => [field];

describe('configSchema: title/desc', () => {
  it('accepts a plain string and a locale map', () => {
    assert.doesNotThrow(() =>
      validateConfigSchema(
        wrap({ key: 'a', type: 'string', title: 'Capture traffic', desc: { 'zh-CN': '抓取流量', 'en-US': 'Capture traffic' } }),
        'plugin'
      )
    );
  });

  it('rejects a non-text title', () => {
    assert.throws(() => validateConfigSchema(wrap({ key: 'a', type: 'string', title: 42 }), 'plugin'), /title must be a string or a locale map/);
  });

  it('rejects a locale map holding a non-string value', () => {
    assert.throws(
      () => validateConfigSchema(wrap({ key: 'a', type: 'string', desc: { 'en-US': 7 } }), 'plugin'),
      /desc must be a string or a locale map/
    );
  });

  it('rejects an array given where a locale map belongs', () => {
    assert.throws(() => validateConfigSchema(wrap({ key: 'a', type: 'string', title: ['x'] }), 'plugin'), /title must be a string/);
  });
});

describe('configSchema: bounds and defaults', () => {
  it('rejects a non-numeric min/max', () => {
    assert.throws(() => validateConfigSchema(wrap({ key: 'n', type: 'number', min: '1' }), 'plugin'), /min must be a number/);
    assert.throws(() => validateConfigSchema(wrap({ key: 'n', type: 'number', max: null }), 'plugin'), /max must be a number/);
  });

  it('rejects a default that does not match the declared type', () => {
    assert.throws(() => validateConfigSchema(wrap({ key: 'b', type: 'boolean', default: 'true' }), 'plugin'), /default must be a boolean/);
    assert.throws(() => validateConfigSchema(wrap({ key: 'n', type: 'number', default: '3' }), 'plugin'), /default must be a finite number/);
    assert.throws(() => validateConfigSchema(wrap({ key: 's', type: 'string', default: 0 }), 'plugin'), /default must be a string/);
    assert.throws(() => validateConfigSchema(wrap({ key: 'l', type: 'string[]', default: 'a' }), 'plugin'), /default must be a string array/);
  });

  it('rejects an enum default outside the declared values', () => {
    assert.throws(
      () => validateConfigSchema(wrap({ key: 'm', type: 'enum', values: ['fast'], default: 'warp' }), 'plugin'),
      /default must be one of the declared enum values/
    );
  });

  it('rejects a numeric default outside its own bounds', () => {
    assert.throws(
      () => validateConfigSchema(wrap({ key: 'n', type: 'number', default: 10, min: 1, max: 5 }), 'plugin'),
      /default must be <= max \(5\)/
    );
    assert.throws(
      () => validateConfigSchema(wrap({ key: 'n', type: 'number', default: 0, min: 1 }), 'plugin'),
      /default must be >= min \(1\)/
    );
  });
});

describe('configSchema: enumLabels', () => {
  const base = { key: 'mode', type: 'enum', values: ['none', 'custom', 'follow'] };

  it('accepts a string and a locale map per declared value', () => {
    assert.doesNotThrow(() =>
      validateConfigSchema(
        wrap({ ...base, enumLabels: { none: 'Unset', follow: { 'zh-CN': '跟随 API Key', 'en-US': 'Follow API key' } } }),
        'plugin'
      )
    );
  });

  it('rejects a label for a value the field never holds', () => {
    assert.throws(
      () => validateConfigSchema(wrap({ ...base, enumLabels: { inherit: 'Inherit' } }), 'plugin'),
      /enumLabels names undeclared value 'inherit'/
    );
  });

  it('rejects enumLabels on a non-enum field', () => {
    assert.throws(
      () => validateConfigSchema(wrap({ key: 's', type: 'string', enumLabels: { a: 'A' } }), 'plugin'),
      /only meaningful on an enum field/
    );
  });

  it('rejects a non-text label', () => {
    assert.throws(
      () => validateConfigSchema(wrap({ ...base, enumLabels: { none: 1 } }), 'plugin'),
      /enumLabels\['none'\] must be a string or a locale map/
    );
  });
});

describe('configSchema: control vocabulary', () => {
  it('accepts the console controls on the types they can drive', () => {
    assert.doesNotThrow(() =>
      validateConfigSchema(
        [
          { key: 'prompt', type: 'string', control: 'textarea' },
          { key: 'label', type: 'string', control: 'text' },
          { key: 'model', type: 'string', control: 'model' },
          { key: 'models', type: 'string[]', control: 'models' },
          { key: 'mode', type: 'enum', values: ['none', 'custom', 'follow'], control: 'segmented' },
        ],
        'plugin'
      )
    );
  });

  it('rejects an unknown control (the vocabulary belongs to the console)', () => {
    assert.throws(
      () => validateConfigSchema(wrap({ key: 's', type: 'string', control: 'richEditor' }), 'plugin'),
      /unknown control 'richEditor'/
    );
  });

  it('rejects a control that cannot drive the field type', () => {
    assert.throws(
      () => validateConfigSchema(wrap({ key: 'm', type: 'string', control: 'models' }), 'plugin'),
      /control 'models' cannot drive a string field/
    );
    assert.throws(
      () => validateConfigSchema(wrap({ key: 'n', type: 'number', control: 'textarea' }), 'plugin'),
      /cannot drive a number field/
    );
    assert.throws(
      () => validateConfigSchema(wrap({ key: 'b', type: 'boolean', control: 'model' }), 'plugin'),
      /cannot drive a boolean field/
    );
    // `segmented` is the closed-choice switch: a free-text field has no closed
    // set to render as buttons, so the pair is rejected at install time.
    assert.throws(
      () => validateConfigSchema(wrap({ key: 's', type: 'string', control: 'segmented' }), 'plugin'),
      /control 'segmented' cannot drive a string field/
    );
  });
});

describe('configSchema: visibleWhen', () => {
  const mode = { key: 'mode', type: 'enum', values: ['none', 'custom'], default: 'none' };
  const list = (when: unknown): unknown[] => [mode, { key: 'list', type: 'string[]', visibleWhen: when }];

  it('accepts equals on an enum sibling and in on a boolean sibling', () => {
    assert.doesNotThrow(() => validateConfigSchema(list({ key: 'mode', equals: 'custom' }), 'plugin'));
    assert.doesNotThrow(() =>
      validateConfigSchema(
        [
          { key: 'enabled', type: 'boolean', default: false },
          { key: 'cap', type: 'number', visibleWhen: { key: 'enabled', in: [true] } },
        ],
        'plugin'
      )
    );
  });

  it('rejects an unknown or self reference', () => {
    assert.throws(() => validateConfigSchema(list({ key: 'nope', equals: 'x' }), 'plugin'), /references unknown field 'nope'/);
    assert.throws(() => validateConfigSchema(list({ key: 'list', equals: 'x' }), 'plugin'), /cannot reference itself/);
  });

  it('rejects a target with no discrete values', () => {
    assert.throws(
      () =>
        validateConfigSchema(
          [
            { key: 'text', type: 'string', default: '' },
            { key: 'list', type: 'string[]', visibleWhen: { key: 'text', equals: 'x' } },
          ],
          'plugin'
        ),
      /not an enum or boolean field/
    );
  });

  it('requires exactly one of equals / in', () => {
    assert.throws(() => validateConfigSchema(list({ key: 'mode' }), 'plugin'), /exactly one of equals \/ in/);
    assert.throws(() => validateConfigSchema(list({ key: 'mode', equals: 'custom', in: ['none'] }), 'plugin'), /exactly one of/);
  });

  it('rejects a condition value the target can never hold', () => {
    assert.throws(() => validateConfigSchema(list({ key: 'mode', equals: 'follow' }), 'plugin'), /never holds/);
    assert.throws(() => validateConfigSchema(list({ key: 'mode', in: ['custom', 'follow'] }), 'plugin'), /never holds/);
  });

  it('rejects a visibility cycle', () => {
    assert.throws(
      () =>
        validateConfigSchema(
          [
            { key: 'a', type: 'boolean', default: false, visibleWhen: { key: 'b', equals: true } },
            { key: 'b', type: 'boolean', default: false, visibleWhen: { key: 'a', equals: true } },
          ],
          'plugin'
        ),
      /visibleWhen cycle/
    );
  });
});

describe('configSchema: configSections grouping', () => {
  const sections = [{ id: 'a', title: { 'zh-CN': '甲', 'en-US': 'A' } }, { id: 'b', title: 'B', advanced: true }];
  const fields = [
    { key: 'one', type: 'string', default: '', section: 'a' },
    { key: 'two', type: 'string', default: '', section: 'b' },
  ];

  it('accepts declared sections referenced by fields', () => {
    assert.doesNotThrow(() => validateConfigSchema(fields, 'plugin', sections));
  });

  it('rejects a field naming an undeclared section', () => {
    assert.throws(
      () => validateConfigSchema([{ key: 'one', type: 'string', default: '', section: 'nope' }], 'plugin', sections),
      /names unknown configSections id 'nope'/
    );
  });

  it('rejects a declared section nothing references', () => {
    assert.throws(
      () => validateConfigSchema([{ key: 'one', type: 'string', default: '', section: 'a' }], 'plugin', sections),
      /id 'b' is not referenced by any field/
    );
  });

  it('rejects duplicate ids, bad titles and non-boolean advanced', () => {
    assert.throws(
      () => validateConfigSchema(fields, 'plugin', [{ id: 'a' }, { id: 'a' }]),
      /duplicate configSections id 'a'/
    );
    assert.throws(
      () => validateConfigSchema(fields, 'plugin', [{ id: 'a', title: 7 }, { id: 'b' }]),
      /title must be a string or a locale map/
    );
    assert.throws(
      () => validateConfigSchema(fields, 'plugin', [{ id: 'a', advanced: 'yes' }, { id: 'b' }]),
      /advanced must be a boolean/
    );
  });

  it('rejects grouping declared without a schema (in the manifest validator)', () => {
    assert.throws(
      () =>
        validatePluginManifest(
          {
            id: 'p',
            name: 'P',
            version: '1.0.0',
            apiVersion: 1,
            type: 'client-gateway',
            hosts: ['example.test'],
            configSections: [{ id: 'a' }],
          },
          'plugin'
        ),
      /configSections without configSchema/
    );
  });
});

describe('manifest: apiVersion contract', () => {
  const base = { id: 'p', name: 'P', version: '1.0.0', type: 'model-service', wires: ['w'] };

  it('requires a positive integer apiVersion', () => {
    assert.throws(() => validatePluginManifest(base, 'plugin'), /apiVersion must be a positive integer/);
    assert.throws(() => validatePluginManifest({ ...base, apiVersion: 0 }, 'plugin'), /apiVersion/);
    assert.throws(() => validatePluginManifest({ ...base, apiVersion: 1.5 }, 'plugin'), /apiVersion/);
    assert.doesNotThrow(() => validatePluginManifest({ ...base, apiVersion: 1 }, 'plugin'));
  });

  it('requires the id to be a lowercase slug (it is a directory name)', () => {
    // The id addresses `<pluginsRoot>/<id>.zip` and `<pluginsRoot>/unpacked/<id>/`,
    // so anything path-shaped would let a package steer install/unpack outside
    // the plugins root, and casing would bypass the `ocr-` reservation.
    assert.throws(() => validatePluginManifest({ ...base, id: '' }, 'plugin'), /id must be a non-empty string/);
    for (const id of ['../evil', '../../x', 'a/b', 'a\\b', 'C:x', 'Ocr-x', 'OCR-x', 'a_b', 'a.b', '-lead', ' pad']) {
      assert.throws(() => validatePluginManifest({ ...base, id }, 'plugin'), /must be a lowercase slug/, id);
    }
    for (const id of ['a', 'ab', 'ab-1', 'cursor-gateway', 'ocr-x']) {
      assert.doesNotThrow(() => validatePluginManifest({ ...base, apiVersion: 1, id }, 'plugin'), id);
    }
  });
});

// The `cursor-gateway` plugin lives in the gitignored dev tree (/plugins/ is
// in .gitignore) and is absent on a fresh clone / CI — registration stays
// conditional (bun's node:test compat layer ignores a `skip` option).
const cursorGatewayPluginJson = path.resolve(import.meta.dirname, '../../plugins/cursor-gateway/plugin.json');
if (fs.existsSync(cursorGatewayPluginJson)) {
  describe('configSchema: the shipped cursor-gateway manifest', () => {
    it('passes the same validation the loader and the packager run', () => {
      const manifest = JSON.parse(fs.readFileSync(cursorGatewayPluginJson, 'utf8')) as unknown;
      assert.doesNotThrow(() => validatePluginManifest(manifest, cursorGatewayPluginJson));
    });

    it('labels every field for both en-US and zh-CN', () => {
      const manifest = JSON.parse(fs.readFileSync(cursorGatewayPluginJson, 'utf8')) as {
        configSchema: { key: string; title?: string | Record<string, string> }[];
      };
      const untranslated = manifest.configSchema.filter(
        (f) => typeof f.title !== 'object' || !f.title['en-US'] || !f.title['zh-CN']
      );
      assert.deepEqual(untranslated.map((f) => f.key), [], 'every config field needs an en-US + zh-CN title');
    });
  });
}
