// The library's refresh state, shared by every screen that shows it.
import { useEffect, useState } from 'react';
import type { LibraryView } from '../../shared/protocol.js';
import { selecta } from '../api.js';

export function useLibrary(): LibraryView | undefined {
  const [view, setView] = useState<LibraryView>();

  useEffect(() => {
    let live = true;
    const unsubscribe = selecta.on((event) => {
      if (event.event === 'library') setView(event.data);
    });

    // A failed read leaves the button, which is still the way to try.
    void selecta.call('library.state').then(
      (next) => live && setView((current) => current ?? next),
      () => undefined,
    );

    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return view;
}

export const refreshLibrary = () => selecta.call('library.refresh');
