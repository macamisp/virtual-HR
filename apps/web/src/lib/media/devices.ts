'use client';

/** FR-MEET-011: the user's chosen devices and defaults, remembered in this browser only. */
export interface DevicePrefs {
  audioInput: string;
  videoInput: string;
  audioOutput: string;
  micOn: boolean;
  camOn: boolean;
}

const KEY = 'hrvo.media.devices';
const DEFAULTS: DevicePrefs = { audioInput: 'default', videoInput: 'default', audioOutput: 'default', micOn: true, camOn: false };

export function loadPrefs(): DevicePrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<DevicePrefs>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function savePrefs(p: DevicePrefs): void {
  try { window.localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
}
