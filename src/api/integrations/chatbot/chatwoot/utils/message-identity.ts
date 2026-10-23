import { WAMessageKey } from 'baileys';

export const buildChatwootMessageIdentity = (key?: WAMessageKey) => {
  if (!key?.id) return null;

  return {
    sourceId: `WAID:${key.id}`,
    contentAttributes: { whatsapp_message_key: key },
  };
};
