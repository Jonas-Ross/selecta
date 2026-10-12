// The settings every screen reads, and whether the panel is open. Changes save
// as they're made; main's menu opens the panel (Cmd+,).
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';
import { selecta } from '../api.js';
import { loadSettings, storeSettings, type Settings } from '../settings.js';

type SettingsContext = {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
};

const Context = createContext<SettingsContext | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(loadSettings);
  const [open, setOpen] = useState(false);

  useEffect(
    () =>
      selecta.on((event) => {
        if (event.event === 'settings.open') setOpen(true);
      }),
    [],
  );

  // The stylesheets' reduced-motion rules key off this as well as the system's; set
  // before the first paint so a saved Reduce never shows the entrance animations.
  useLayoutEffect(() => {
    document.documentElement.dataset.motion = settings.motion;
  }, [settings.motion]);

  const update = (patch: Partial<Settings>) =>
    setSettings((current) => {
      const next = { ...current, ...patch };

      storeSettings(next);

      return next;
    });

  return (
    <Context.Provider value={{ settings, update, open, setOpen }}>{children}</Context.Provider>
  );
}

export function useSettings(): SettingsContext {
  const context = useContext(Context);

  if (!context) throw new Error('useSettings needs a SettingsProvider');

  return context;
}
