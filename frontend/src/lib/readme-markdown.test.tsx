import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReadmeMarkdown, readmeBaseHref, resolveReadmeHref } from './readme-markdown';

describe('readmeBaseHref', () => {
  it('roots links in the repository tree whenever a repo is known, even for an npm row', () => {
    expect(
      readmeBaseHref({
        repo: 'ByteDance/dsh-tui',
        packageKey: 'npm:@deepseek-harness-tui/dsh-tui',
        url: 'https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui',
      })
    ).toBe('https://github.com/ByteDance/dsh-tui/blob/HEAD/');
  });

  it('anchors a selected README file to its own directory', () => {
    expect(readmeBaseHref({ repo: 'o/r', path: 'docs/README.zh.md' })).toBe(
      'https://github.com/o/r/blob/HEAD/docs/'
    );
    expect(readmeBaseHref({ repo: 'o/r', path: 'README.zh.md' })).toBe('https://github.com/o/r/blob/HEAD/');
  });

  it('falls back to the row public page, treated as a directory', () => {
    expect(readmeBaseHref({ packageKey: 'npm:@scope/pkg' })).toBe('https://www.npmjs.com/package/@scope/pkg/');
    expect(readmeBaseHref({ url: 'https://clawhub.ai/o/skills/s' })).toBe('https://clawhub.ai/o/skills/s/');
    expect(readmeBaseHref({ url: 'https://clawhub.ai/o/skills/s/' })).toBe('https://clawhub.ai/o/skills/s/');
  });

  it('names no base when the row names no source page', () => {
    expect(readmeBaseHref({})).toBeUndefined();
    expect(readmeBaseHref({ repo: 'not a repo' })).toBeUndefined();
  });
});

describe('resolveReadmeHref', () => {
  const base = 'https://github.com/o/r/blob/HEAD/';

  it('joins a relative path onto the README source tree', () => {
    expect(resolveReadmeHref('./docs/guide.md', base)).toBe('https://github.com/o/r/blob/HEAD/docs/guide.md');
    expect(resolveReadmeHref('../LICENSE', base)).toBe('https://github.com/o/r/blob/HEAD/LICENSE');
  });

  it('treats a root-relative link as repository-root-relative', () => {
    expect(resolveReadmeHref('/docs/guide.md', `${base}docs/`)).toBe('https://github.com/o/r/blob/HEAD/docs/guide.md');
    expect(resolveReadmeHref('/docs/guide.md', 'https://www.npmjs.com/package/pkg/')).toBeNull();
  });

  it('keeps absolute links as authored', () => {
    expect(resolveReadmeHref('https://example.com/a?b=1', base)).toBe('https://example.com/a?b=1');
    expect(resolveReadmeHref('mailto:a@b.c', base)).toBe('mailto:a@b.c');
    expect(resolveReadmeHref('//example.com/a', base)).toBe('https://example.com/a');
  });

  it('refuses a relative path with no base and any other scheme', () => {
    expect(resolveReadmeHref('docs/guide.md', undefined)).toBeNull();
    expect(resolveReadmeHref('javascript:alert(1)', base)).toBeNull();
    expect(resolveReadmeHref(undefined, base)).toBeNull();
  });
});

describe('ReadmeMarkdown', () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  it('resolves a relative link against the repository instead of the console origin', () => {
    render(<ReadmeMarkdown source="[guide](./docs/guide.md)" base="https://github.com/o/r/blob/HEAD/" />);
    const link = screen.getByRole('link', { name: 'guide' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://github.com/o/r/blob/HEAD/docs/guide.md');
    expect(link.target).toBe('_blank');
  });

  it('renders a relative link as plain text when the row names no source page', () => {
    render(<ReadmeMarkdown source="[guide](./docs/guide.md)" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('guide')).toBeTruthy();
  });

  it('scrolls to a slugged heading instead of navigating the console to the fragment', () => {
    render(<ReadmeMarkdown source={'## Quick start\n\n[Jump](#quick-start)'} />);
    const heading = document.getElementById('user-content-quick-start');
    expect(heading).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Jump' }));

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(heading);
  });

  it('loads a relative README image from the repository raw tree', () => {
    render(
      <ReadmeMarkdown
        source={'<p align="center"><img src="docs/assets/logo.svg" alt="logo" width="560"></p>'}
        base="https://github.com/o/r/blob/HEAD/"
      />
    );
    const img = screen.getByAltText('logo') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://raw.githubusercontent.com/o/r/HEAD/docs/assets/logo.svg');
  });

  it('resolves a relative image from a README inside a subdirectory', () => {
    render(<ReadmeMarkdown source="![logo](logo.svg)" base="https://github.com/o/r/blob/HEAD/docs/" />);
    const img = screen.getByAltText('logo') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://raw.githubusercontent.com/o/r/HEAD/docs/logo.svg');
  });

  it('resolves a root-relative image at the repository root, not under the README directory', () => {
    render(<ReadmeMarkdown source="![logo](/assets/logo.svg)" base="https://github.com/o/r/blob/HEAD/docs/" />);
    const img = screen.getByAltText('logo') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://raw.githubusercontent.com/o/r/HEAD/assets/logo.svg');
  });

  it('keeps a parent-directory image inside the repository', () => {
    render(<ReadmeMarkdown source="![logo](../logo.svg)" base="https://github.com/o/r/blob/HEAD/" />);
    const img = screen.getByAltText('logo') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://raw.githubusercontent.com/o/r/HEAD/logo.svg');
  });

  it('drops a relative image when there is no repository to resolve it against', () => {
    render(<ReadmeMarkdown source="![logo](docs/assets/logo.svg)" base="https://www.npmjs.com/package/pkg/" />);
    expect(screen.queryByAltText('logo')).toBeNull();
  });

  it('resolves a picture source list and keeps the plain img fallback', () => {
    const { container } = render(
      <ReadmeMarkdown
        source={
          '<picture><source media="(prefers-color-scheme: dark)" srcset="dark.svg 1x, wide.svg 2x"><img src="light.svg" alt="logo"></picture>'
        }
        base="https://github.com/o/r/blob/HEAD/docs/"
      />
    );
    expect(container.querySelector('source')!.getAttribute('srcset')).toBe(
      'https://raw.githubusercontent.com/o/r/HEAD/docs/dark.svg 1x, https://raw.githubusercontent.com/o/r/HEAD/docs/wide.svg 2x'
    );
    expect(container.querySelector('source')!.getAttribute('media')).toBe('(prefers-color-scheme: dark)');
    expect((screen.getByAltText('logo') as HTMLImageElement).getAttribute('src')).toBe(
      'https://raw.githubusercontent.com/o/r/HEAD/docs/light.svg'
    );
  });

  it('drops a picture source that cannot be resolved so the img fallback renders', () => {
    const { container } = render(
      <ReadmeMarkdown
        source={'<picture><source srcset="dark.svg"><img src="https://cdn.example/light.svg" alt="logo"></picture>'}
        base="https://www.npmjs.com/package/pkg/"
      />
    );
    expect(container.querySelector('source')).toBeNull();
    expect((screen.getByAltText('logo') as HTMLImageElement).getAttribute('src')).toBe('https://cdn.example/light.svg');
  });
});
