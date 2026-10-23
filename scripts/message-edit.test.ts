import assert from 'node:assert/strict';
import {
  extractEditedMessageText,
  whatsappMessageKeysMatch,
} from '../src/api/integrations/chatbot/chatwoot/utils/message-edit';

const incomingKey = {
  id: 'wamid-1',
  remoteJid: '281449391493336@lid',
  remoteJidAlt: '556294665004@s.whatsapp.net',
  fromMe: false,
};

assert.equal(
  extractEditedMessageText({
    editedMessage: { conversation: ' Ola editada ' },
  }),
  'Ola editada',
);

assert.equal(
  whatsappMessageKeysMatch({ id: 'wamid-1', remoteJid: '281449391493336@lid', fromMe: false }, incomingKey),
  true,
);

assert.equal(
  whatsappMessageKeysMatch({ id: 'wamid-1', remoteJid: '556294665004@s.whatsapp.net', fromMe: false }, incomingKey),
  true,
);

assert.equal(
  whatsappMessageKeysMatch({ id: 'wamid-1', remoteJid: '556294665004@s.whatsapp.net', fromMe: true }, incomingKey),
  false,
);

console.log('message-edit contract tests passed');
