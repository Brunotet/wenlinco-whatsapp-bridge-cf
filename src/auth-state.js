import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';

// Baileys normally persists WhatsApp session credentials to local files via
// useMultiFileAuthState(). Workers/Durable Objects have no filesystem, so
// this reimplements the same interface Baileys expects, backed by the
// Durable Object's own transactional storage instead.
export async function useDurableObjectAuthState(storage) {
  const credsRaw = await storage.get('creds');
  const creds = credsRaw ? JSON.parse(credsRaw, BufferJSON.reviver) : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const keys = ids.map((id) => `key-${type}-${id}`);
          const stored = await storage.get(keys); // batch get, returns a Map
          const result = {};
          for (const id of ids) {
            const raw = stored.get(`key-${type}-${id}`);
            if (raw !== undefined) {
              result[id] = JSON.parse(raw, BufferJSON.reviver);
            }
          }
          return result;
        },
        set: async (data) => {
          const toPut = {};
          const toDelete = [];
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              const key = `key-${type}-${id}`;
              const value = data[type][id];
              if (value) {
                toPut[key] = JSON.stringify(value, BufferJSON.replacer);
              } else {
                toDelete.push(key);
              }
            }
          }
          if (Object.keys(toPut).length) await storage.put(toPut); // batch put
          if (toDelete.length) await storage.delete(toDelete); // batch delete
        },
      },
    },
    saveCreds: async () => {
      await storage.put('creds', JSON.stringify(creds, BufferJSON.replacer));
    },
  };
}
