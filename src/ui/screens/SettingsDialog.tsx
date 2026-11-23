import { useState } from "react";
import { Modal } from "../components/Modal";
import { Segmented, Switch } from "../components/Controls";
import type { Settings, ThemeChoice } from "../settings";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onResetRecord: () => void;
}

export function SettingsDialog({ open, onClose, settings, onChange, onResetRecord }: SettingsDialogProps) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title="Settings" size="sm">
      <div className="settings">
        <Switch
          id="set-sound"
          label="Sound effects"
          checked={settings.sound}
          onChange={(v) => onChange({ sound: v })}
        />
        <Switch
          id="set-routes"
          label="Show routes"
          note="Dotted lines along each racer's shortest way home"
          checked={settings.routes}
          onChange={(v) => onChange({ routes: v })}
        />
        <Switch
          id="set-coords"
          label="Board coordinates"
          note="Files a–i and ranks 1–9, as used in the move list"
          checked={settings.coords}
          onChange={(v) => onChange({ coords: v })}
        />
        <div className="field">
          <span className="eyebrow">Theme</span>
          <Segmented<ThemeChoice>
            name="theme"
            label="Theme"
            value={settings.theme}
            onChange={(v) => onChange({ theme: v })}
            choices={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </div>
        <div className="settings__danger">
          <div>
            <div className="switch-row__label">Win/loss record</div>
            <div className="switch-row__note">Clears your results against every bot level.</div>
          </div>
          <button
            type="button"
            className={`btn ${confirming ? "btn--danger" : ""}`}
            onClick={() => {
              if (!confirming) return setConfirming(true);
              onResetRecord();
              setConfirming(false);
            }}
            onBlur={() => setConfirming(false)}
          >
            {confirming ? "Tap again to clear" : "Reset"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
