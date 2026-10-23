import assert from 'node:assert/strict';
import { buildChatwootMessageIdentity } from '../src/api/integrations/chatbot/chatwoot/utils/message-identity';

const key = {
  id: '3EB0AFB1ED6FC0DE59F5FD',
  remoteJid: '281449391493336@lid',
  remoteJidAlt: '556294665004@s.whatsapp.net',
  fromMe: true,
};

assert.deepEqual(buildChatwootMessageIdentity(key), {
  sourceId: 'WAID:3EB0AFB1ED6FC0DE59F5FD',
  contentAttributes: { whatsapp_message_key: key },
});
assert.equal(buildChatwootMessageIdentity(undefined), null);
assert.equal(buildChatwootMessageIdentity({} as any), null);

console.log('message-identity contract tests passed');
