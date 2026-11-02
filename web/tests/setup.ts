// Installs indexedDB, IDBRequest, IDBKeyRange and friends as globals.
import 'fake-indexeddb/auto';

import { IDBFactory } from 'fake-indexeddb';
import { beforeEach } from 'vitest';

import { resetDbHandleForTests } from '../src/lib/idb';
import { resetSyncStateForTests } from '../src/lib/sync';

// A brand new database per test: no cross-test leakage, and no deleteDatabase
// race with a handle some earlier test left open.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbHandleForTests();
  resetSyncStateForTests();
});
