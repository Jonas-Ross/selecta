// The menu a record opens on right-click, or ContextMenu / Shift+F10 when focused.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export type MenuItem = { label: string; key?: string; disabled?: boolean; run: () => void };

export function RecordMenu({
  x,
  y,
  title,
  items,
  onClose,
}: {
  x: number;
  y: number;
  title: string;
  items: MenuItem[];
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);

  // Focus goes back where it was, unless what the item opened takes it.
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;

    return () => before?.focus({ preventScroll: true });
  }, []);

  // Kept inside the window, and the first item takes focus so the keyboard can carry on.
  useLayoutEffect(() => {
    const node = menu.current!;
    const left = Math.max(8, Math.min(x, innerWidth - node.offsetWidth - 8));
    const top = Math.max(8, Math.min(y, innerHeight - node.offsetHeight - 8));

    node.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [x, y]);

  useEffect(() => {
    const away = (e: PointerEvent) => !menu.current?.contains(e.target as Node) && onClose();

    document.addEventListener('pointerdown', away, true);
    window.addEventListener('blur', onClose);

    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  function key(e: React.KeyboardEvent) {
    const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const dir = { ArrowDown: 1, ArrowUp: -1 }[e.key];

    if (dir !== undefined) {
      e.preventDefault();
      buttons[(at + dir + buttons.length) % buttons.length]?.focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      onClose();
    }
  }

  return createPortal(
    <div className="menu" role="menu" aria-label={title} ref={menu} onKeyDown={key}>
      <div className="menu-head mono">{title}</div>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.run();
          }}
        >
          {item.label}
          {item.key && <kbd className="mono">{item.key}</kbd>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
