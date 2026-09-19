import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'fitstealer.device_id';

let pending: Promise<string> | null = null;

function newDeviceId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const rand = Math.floor(Math.random() * 16);
    const value = char === 'x' ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}

async function loadOrCreate(): Promise<string> {
  const existing = await AsyncStorage.getItem(STORAGE_KEY);
  if (existing) return existing;
  const id = newDeviceId();
  await AsyncStorage.setItem(STORAGE_KEY, id);
  return id;
}

export function getDeviceId(): Promise<string> {
  if (!pending) pending = loadOrCreate();
  return pending;
}
