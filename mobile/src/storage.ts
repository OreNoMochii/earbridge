// Remembers the settings between launches, in a small JSON file in the app's documents.

import { File, Paths } from 'expo-file-system';

import type { KeyValueStore } from '../../client/src/settings.ts';

const file = new File(Paths.document, 'earbridge-settings.json');
let cache: Record<string, string> | undefined;

function read(): Record<string, string> {
  if (cache) return cache;
  cache = {};
  try {
    if (file.exists) {
      const data: unknown = JSON.parse(file.textSync());
      if (data && typeof data === 'object') {
        for (const [key, value] of Object.entries(data)) {
          if (typeof value === 'string') cache[key] = value;
        }
      }
    }
  } catch {
    // A damaged file only loses the settings.
  }
  return cache;
}

export const storage: KeyValueStore = {
  getItem(key) {
    return read()[key] ?? null;
  },
  setItem(key, value) {
    const data = read();
    data[key] = value;
    try {
      if (!file.exists) file.create();
      file.write(JSON.stringify(data));
    } catch {
      // Not saved: the app keeps working with the settings in memory.
    }
  },
};
