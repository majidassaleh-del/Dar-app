/** KeyValueStore over AsyncStorage. It holds only ciphertext and counters. Not device-tested (see secure-store-vault.ts). */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { KeyValueStore } from '@herp/offline';

export const asyncStorageKv: KeyValueStore = {
  get: (k) => AsyncStorage.getItem(k),
  set: (k, v) => AsyncStorage.setItem(k, v),
  delete: (k) => AsyncStorage.removeItem(k),
  keys: async (prefix) => (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(prefix)),
};
