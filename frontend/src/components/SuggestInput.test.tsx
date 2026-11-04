import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SuggestInput } from './SuggestInput';

function Harness({ suggestions = ['http', 'stdio'], onChange }: { suggestions?: string[]; onChange?: (v: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <SuggestInput
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      suggestions={suggestions}
      placeholder="transport"
    />
  );
}

describe('SuggestInput', () => {
  it('opens the themed panel and filters suggestions as the user types', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole('combobox') as HTMLInputElement;

    await user.click(input);
    expect(await screen.findByRole('option', { name: 'http' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'stdio' })).toBeTruthy();
    expect(document.querySelector('[data-suggest-panel]')).toBeTruthy();

    await user.type(input, 'st');
    expect(input.value).toBe('st');
    expect(screen.queryByRole('option', { name: 'http' })).toBeNull();
    expect(screen.getByRole('option', { name: 'stdio' })).toBeTruthy();

    await user.click(screen.getByRole('option', { name: 'stdio' }));
    expect(input.value).toBe('stdio');
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('keeps text the suggestions do not contain', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole('combobox') as HTMLInputElement;

    await user.click(input);
    await user.type(input, 'sse');

    expect(input.value).toBe('sse');
    expect(onChange).toHaveBeenLastCalledWith('sse');
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('picks the active suggestion with the keyboard', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole('combobox') as HTMLInputElement;

    await user.click(input);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(input.value).toBe('stdio');
  });

  it('does not open a panel when there is nothing to suggest', async () => {
    const user = userEvent.setup();
    render(<Harness suggestions={[]} />);
    const input = screen.getByRole('combobox') as HTMLInputElement;

    await user.click(input);
    expect(screen.queryByRole('option')).toBeNull();
    await user.type(input, 'anything');
    expect(input.value).toBe('anything');
    expect(screen.queryByRole('option')).toBeNull();
  });
});
