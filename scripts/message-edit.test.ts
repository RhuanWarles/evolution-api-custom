import assert from 'node:assert/strict';
import {
  buildChatwootMessageEditRequest,
  extractEditedMessageEvent,
  extractEditedMessageText,
  whatsappMessageKeysMatch,
} from '../src/api/integrations/chatbot/chatwoot/utils/message-edit';
import { aesEncryptGCM, hkdf, proto } from 'baileys';
import { decryptSecretMessageEdit, isSecretMessageEdit } from '../src/api/integrations/channel/whatsapp/utils/secret-message-edit';

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

const updateEvent = extractEditedMessageEvent({
  key: { id: 'envelope-id', remoteJid: '281449391493336@lid', fromMe: false },
  messageTimestamp: 1729688040,
  message: {
    editedMessage: {
      message: {
        protocolMessage: {
          key: incomingKey,
          editedMessage: { conversation: 'Mensagem corrigida' },
        },
      },
    },
  },
});

assert.equal(updateEvent?.key.id, 'wamid-1');
assert.equal(updateEvent?.key.remoteJid, '281449391493336@lid');
assert.equal(updateEvent?.key.remoteJidAlt, '556294665004@s.whatsapp.net');
assert.equal(updateEvent?.editedMessage.conversation, 'Mensagem corrigida');

assert.deepEqual(
  buildChatwootMessageEditRequest({
    accountId: 48,
    conversationId: 4,
    messageId: 8797,
    content: 'Mensagem corrigida',
    instanceName: 'account-48-85652885f634bc05',
    editedAt: '2026-10-23T19:00:00.000Z',
    key: incomingKey,
  }),
  {
    method: 'POST',
    url: '/api/v1/accounts/48/conversations/4/messages/8797/evolution_edit',
    body: {
      content: 'Mensagem corrigida',
      instance_name: 'account-48-85652885f634bc05',
      edited_at: '2026-10-23T19:00:00.000Z',
      whatsapp_message_key: incomingKey,
    },
  },
);

assert.equal(
  extractEditedMessageText({ editedMessage: { editedMessage: { conversation: 'Nested' } } }),
  'Nested',
);

console.log('message-edit contract tests passed');

const messageSecret = Buffer.alloc(32, 7);
const targetKey = {
  id: 'original-inbound-id',
  remoteJid: '181419536064672@lid',
  remoteJidAlt: '556291212010@s.whatsapp.net',
  fromMe: false,
};
const editorKey = {
  id: 'envelope-id',
  remoteJid: '181419536064672@lid',
  remoteJidAlt: '556291212010@s.whatsapp.net',
  fromMe: false,
};
const originalSenderJid = targetKey.remoteJid;
const editorJid = editorKey.remoteJid;
const editContext = Buffer.concat([
  Buffer.from(targetKey.id),
  Buffer.from(originalSenderJid),
  Buffer.from(editorJid),
  Buffer.from('Message Edit'),
]);
const innerEdit = proto.Message.create({
  protocolMessage: proto.Message.ProtocolMessage.create({
    type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
    key: targetKey,
    editedMessage: proto.Message.create({ conversation: 'Mensagem inbound corrigida' }),
    timestampMs: 1729688040000,
  }),
});
void (async () => {
  const editKey = await hkdf(messageSecret, 32, { info: editContext.toString('latin1') });
  const editEnvelope = {
    targetMessageKey: targetKey,
    encPayload: aesEncryptGCM(proto.Message.encode(innerEdit).finish(), editKey, Buffer.alloc(12, 3), Buffer.alloc(0)),
    encIv: Buffer.alloc(12, 3),
    secretEncType: proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT,
  };

  assert.equal(isSecretMessageEdit({ secretEncryptedMessage: editEnvelope }), true);
  const secretEdit = await decryptSecretMessageEdit({
    envelope: editEnvelope,
    messageKey: editorKey,
    targetMessage: {
      key: { ...targetKey, remoteJid: targetKey.remoteJidAlt },
      messageContextInfo: { messageSecret },
    },
    meId: '556294665004@s.whatsapp.net',
    meLid: '181419536064672@lid',
    resolveLidToPn: async () => originalSenderJid,
    fallbackTimestamp: 1729688000,
  });
  assert.equal(secretEdit?.key.id, targetKey.id);
  assert.equal(secretEdit?.key.remoteJid, targetKey.remoteJid);
  assert.equal(secretEdit?.key.remoteJidAlt, targetKey.remoteJidAlt);
  assert.equal(secretEdit?.key.fromMe, false);
  assert.equal(secretEdit?.editedMessage.conversation, 'Mensagem inbound corrigida');
  assert.equal(
    await decryptSecretMessageEdit({
      envelope: editEnvelope,
      messageKey: editorKey,
      targetMessage: { messageContextInfo: { messageSecret: Buffer.alloc(32, 8) } },
      meId: '556294665004@s.whatsapp.net',
      meLid: '181419536064672@lid',
      resolveLidToPn: async () => '556291212010@s.whatsapp.net',
    }),
    null,
  );
  assert.equal(isSecretMessageEdit({ secretEncryptedMessage: { ...editEnvelope, secretEncType: 1 } }), false);
  assert.equal(
    await decryptSecretMessageEdit({
      envelope: { ...editEnvelope, secretEncType: 1 },
      messageKey: editorKey,
      targetMessage: { messageContextInfo: { messageSecret } },
      meId: '556294665004@s.whatsapp.net',
      meLid: '181419536064672@lid',
      resolveLidToPn: async () => originalSenderJid,
    }),
    null,
  );

  console.log('secret message edit contract tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
