import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatwootService } from '../src/api/integrations/chatbot/chatwoot/services/chatwoot.service';

const groupJid = '120363000000000001@g.us';
const instance = { instanceName: 'inst-test', instanceId: 'id-test' } as any;

function buildHarness() {
  const store = new Map<string, unknown>();
  const cache = {
    has: async (key: string) => store.has(key),
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    setIfNotExists: async (key: string, value: unknown) => {
      if (store.has(key)) return false;
      store.set(key, value);
      return true;
    },
  };
  const waInstance = {
    client: { groupMetadata: async () => ({ subject: 'Group subject' }) },
    profilePicture: async () => ({ profilePictureUrl: null }),
  };
  const waMonitor = { waInstances: { [instance.instanceName]: waInstance } };
  const service: any = new ChatwootService(waMonitor as any, {} as any, {} as any, cache as any);

  const calls = { findContact: [] as string[], createContact: [] as any[], updateContact: [] as any[] };
  service.provider = { accountId: 1, nameInbox: 'inbox', reopenConversation: false, conversationPending: false };
  service.clientCw = async () => ({
    conversations: { create: async () => ({ id: 77 }), get: async () => ({ id: 77 }) },
    contacts: { listConversations: async () => ({ payload: [] }) },
  });
  service.getInbox = async () => ({ id: 1 });
  service.findContact = async (_instance: unknown, phone: string) => {
    calls.findContact.push(phone);
    return null;
  };
  service.createContact = async (...args: any[]) => {
    calls.createContact.push(args);
    return { id: 100 + calls.createContact.length };
  };
  service.findContactForMessage = async () => ({ contact: null, fallback: null, identifierContact: null });
  service.updateContact = async (...args: any[]) => {
    calls.updateContact.push(args);
    return null;
  };

  return { service, calls };
}

const participantContactCalls = (calls: { createContact: any[] }) =>
  calls.createContact.filter((args) => args[3] === false);

test('group message without any participant is still delivered to the group conversation', async () => {
  const { service, calls } = buildHarness();
  const body = { pushName: '215041026556054@lid', key: { remoteJid: groupJid, fromMe: false, id: 'MSG1' } };

  assert.equal(await service.createConversation(instance, body), 77);
  assert.equal(participantContactCalls(calls).length, 0);
  assert.equal(
    calls.createContact.some((args) => args[1] === groupJid && args[3] === true),
    true,
  );
});

test('group message with only a LID participant never creates a contact whose phone is the LID', async () => {
  const { service, calls } = buildHarness();
  const body = {
    pushName: 'Maria',
    key: { remoteJid: groupJid, fromMe: false, participant: '215041026556054@lid', addressingMode: 'lid' },
  };

  assert.equal(await service.createConversation(instance, body), 77);
  assert.equal(participantContactCalls(calls).length, 0);
  assert.equal(
    calls.findContact.some((phone) => phone.includes('215041026556054')),
    false,
  );
});

test('group message with a LID participant and a mapped phone creates the participant contact by phone', async () => {
  const { service, calls } = buildHarness();
  const body = {
    pushName: 'Maria',
    key: {
      remoteJid: groupJid,
      fromMe: false,
      participant: '215041026556054@lid',
      participantAlt: '5511999990000@s.whatsapp.net',
      addressingMode: 'lid',
    },
  };

  assert.equal(await service.createConversation(instance, body), 77);
  const [participantCall] = participantContactCalls(calls);
  assert.equal(participantCall[1], '5511999990000');
  assert.equal(participantCall[4], 'Maria');
  assert.equal(participantCall[6], '5511999990000@s.whatsapp.net');
});

test('regular group message with a phone participant keeps creating the participant contact', async () => {
  const { service, calls } = buildHarness();
  const body = {
    pushName: 'Joao',
    key: { remoteJid: groupJid, fromMe: false, participant: '5511888880000@s.whatsapp.net' },
  };

  assert.equal(await service.createConversation(instance, body), 77);
  const [participantCall] = participantContactCalls(calls);
  assert.equal(participantCall[1], '5511888880000');
  assert.equal(participantCall[4], 'Joao');
});

test('fromMe group message with a phone participant still resolves the conversation', async () => {
  const { service } = buildHarness();
  const body = {
    pushName: 'Eu',
    key: { remoteJid: groupJid, fromMe: true, participant: '5511777770000@s.whatsapp.net' },
  };

  assert.equal(await service.createConversation(instance, body), 77);
});

test('individual conversation is unchanged', async () => {
  const { service, calls } = buildHarness();
  const body = { pushName: 'Ana', key: { remoteJid: '5511666660000@s.whatsapp.net', fromMe: false } };

  assert.equal(await service.createConversation(instance, body), 77);
  assert.equal(participantContactCalls(calls).length, 1);
  assert.equal(participantContactCalls(calls)[0][1], '5511666660000');
});

test('a missing pushName is never used as the participant contact name', async () => {
  const { service, calls } = buildHarness();
  const body = {
    key: { remoteJid: groupJid, fromMe: false, participantAlt: '5511555550000@s.whatsapp.net', addressingMode: 'lid' },
  };

  assert.equal(await service.createConversation(instance, body), 77);
  const [participantCall] = participantContactCalls(calls);
  assert.equal(participantCall[4], undefined);
});
