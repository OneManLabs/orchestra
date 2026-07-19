import { activeDeviceMention, deviceMentionSuggestions, type Device, type DeviceMentionSuggestion } from '@fleet/shared';
import { AtSign, Cpu } from 'lucide-react';
import { useEffect, useMemo, useState, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react';

export function useDeviceMentionComposer(
  value: string,
  setValue: (value: string) => void,
  devices: Device[],
  inputRef: RefObject<HTMLTextAreaElement | null>,
) {
  const [caret, setCaret] = useState(value.length);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const active = useMemo(() => activeDeviceMention(value, caret), [value, caret]);
  const suggestions = useMemo(
    () => active ? deviceMentionSuggestions(devices, active.query).slice(0, 8) : [],
    [active?.query, devices],
  );
  const open = Boolean(active && suggestions.length);

  useEffect(() => setSelectedIndex(0), [active?.query]);

  function trackCaret(event: SyntheticEvent<HTMLTextAreaElement>): void {
    setCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
  }

  function select(suggestion: DeviceMentionSuggestion): void {
    if (!active) return;
    const next = `${value.slice(0, active.start)}@${suggestion.alias} ${value.slice(active.end)}`;
    const nextCaret = active.start + suggestion.alias.length + 2;
    setValue(next);
    setCaret(nextCaret);
    queueMicrotask(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open) return false;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((current) => (current + 1) % suggestions.length);
      return true;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      select(suggestions[selectedIndex] ?? suggestions[0]!);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setCaret(-1);
      return true;
    }
    return false;
  }

  return {
    open,
    suggestions,
    selectedIndex,
    select,
    onKeyDown,
    trackCaret,
    setCaret,
  };
}

export function DeviceMentionMenu({
  suggestions,
  selectedIndex,
  onSelect,
}: {
  suggestions: DeviceMentionSuggestion[];
  selectedIndex: number;
  onSelect(suggestion: DeviceMentionSuggestion): void;
}) {
  return <div className="device-mention-popover" role="listbox" aria-label="Orchestra devices">
    <header><AtSign size={14} /><span><strong>Target a fleet device</strong><small>Arrow keys to navigate · Enter to insert</small></span></header>
    <div>{suggestions.map((suggestion, index) => <button
      key={suggestion.deviceId}
      type="button"
      role="option"
      aria-selected={index === selectedIndex}
      className={index === selectedIndex ? 'is-keyboard-active' : ''}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onSelect(suggestion)}
    >
      <span><Cpu size={13} /></span>
      <span><strong>@{suggestion.alias}</strong><small>{suggestion.label}</small></span>
      <code>{suggestion.detail}</code>
    </button>)}</div>
  </div>;
}
