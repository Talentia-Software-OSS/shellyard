import { useState } from 'react';
import type { EffectsLevel } from '../effects.js';
import { setEffects, setSound, setTheme, useStore } from '../store.js';
import type { ThemeChoice } from '../theme.js';
import { SettingsIcon } from './icons.js';
import { Popover } from './Popover.js';
import { SoundsDialog } from './SoundsDialog.js';

/** Theme, effects and sound, the same choices as before, behind one button in the header. */
export function SettingsMenu({ onRecentErrors, onPhoneAccess }: { onRecentErrors: () => void; onPhoneAccess: () => void }): React.JSX.Element {
  const { effects, sound, themeChoice } = useStore();
  // Outside the panel, so that the dialog stays open when the panel closes.
  const [sounds, setSounds] = useState(false);
  return (
    <>
      <Popover label="Theme, effects and sound" button={<SettingsIcon size={20} />}>
        {(close) => (
          <div className="settings-panel">
            <label>
              <span>Theme</span>
              <select value={themeChoice} onChange={(e) => setTheme(e.target.value as ThemeChoice)}>
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="talentia">Talentia</option>
              </select>
            </label>
            <label>
              <span>Effects</span>
              <select value={effects} onChange={(e) => setEffects(e.target.value as EffectsLevel)}>
                <option value="full">Full</option>
                <option value="reduced">Reduced</option>
                <option value="off">Off</option>
              </select>
            </label>
            <label className="check" title="A soft chime when a session starts waiting for you">
              <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} />
              <span>Sound</span>
            </label>
            <button
              type="button"
              onClick={() => {
                close();
                setSounds(true);
              }}
            >
              Sounds…
            </button>
            <button
              type="button"
              onClick={() => {
                close();
                onPhoneAccess();
              }}
            >
              Phone access…
            </button>
            <button
              type="button"
              onClick={() => {
                close();
                onRecentErrors();
              }}
            >
              Recent errors…
            </button>
          </div>
        )}
      </Popover>
      {sounds && <SoundsDialog onClose={() => setSounds(false)} />}
    </>
  );
}
