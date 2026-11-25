import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatwootService } from '../src/api/integrations/chatbot/chatwoot/services/chatwoot.service';
import {
  classifyChatwootError,
  DEFAULT_RETRY_DELAYS_MS,
  OrderedRetryQueue,
} from '../src/api/integrations/chatbot/chatwoot/utils/delivery-retry';

const instance = { instanceName: 'inst-test', instanceId: 'id-test' } as any;
const chatA = '5511900000001@s.whatsapp.net';
const chatB = '5511900000002@s.whatsapp.net';

const networkError = (code = 'ECONNREFUSED') => Object.assign(new Error(code), { code, isAxiosError: true });
const apiError = (status: number, body: unknown) =>
  Object.assign(new Error('ApiError'), { name: 'ApiError', status, body });

test('classifies errors: retry on network/timeout/429/5xx, permanent on programming and definitive 4xx errors', () => {
  assert.equal(classifyChatwootError(networkError('ECONNREFUSED')), 'retry');
  assert.equal(classifyChatwootError(networkError('ETIMEDOUT')), 'retry');
  assert.equal(classifyChatwootError(Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } })), 'retry');
  assert.equal(classifyChatwootError(apiError(429, { error: 'slow down' })), 'retry');
  assert.equal(classifyChatwootError(apiError(502, '<html>Bad Gateway</html>')), 'retry');
  assert.equal(classifyChatwootError(apiError(503, '')), 'retry');
  assert.equal(classifyChatwootError(apiError(400, { error: 'bad' })), 'permanent');
  assert.equal(classifyChatwootError(apiError(401, { error: 'unauthorized' })), 'permanent');
  assert.equal(classifyChatwootError(apiError(422, { error: 'invalid' })), 'permanent');
  assert.equal(classifyChatwootError(new TypeError("Cannot read properties of null (reading 'split')")), 'permanent');
  assert.equal(classifyChatwootError(null), 'permanent');
});

test('404 is retried only when it looks like a proxy without backend, not a real Chatwoot resource error', () => {
  assert.equal(classifyChatwootError(apiError(404, '404 page not found')), 'retry');
  assert.equal(classifyChatwootError(apiError(404, '<html><body>Not Found</body></html>')), 'retry');
  assert.equal(classifyChatwootError(apiError(404, undefined)), 'retry');
  assert.equal(classifyChatwootError(apiError(404, { error: 'Resource could not be found' })), 'permanent');
  assert.equal(classifyChatwootError(apiError(404, '{"error":"Conversation not found"}')), 'permanent');
  assert.equal(classifyChatwootError({ response: { status: 404, data: { error: 'not found' } } }), 'permanent');
});

test('the default backoff covers at least three minutes', () => {
  assert.ok(DEFAULT_RETRY_DELAYS_MS.reduce((total, ms) => total + ms, 0) >= 180_000);
});

test('queue keeps order per conversation and does not block other conversations', async () => {
  const events: string[] = [];
  const queue = new OrderedRetryQueue([1, 1, 1], async () => undefined);
  let firstAttempts = 0;

  queue.enqueue('a', {
    label: 'a1',
    attempt: async () => {
      firstAttempts += 1;
      events.push(`a1#${firstAttempts}`);
      return firstAttempts < 3 ? 'retry' : 'delivered';
    },
    onExhausted: () => events.push('a1-exhausted'),
  });
  queue.enqueue('a', {
    label: 'a2',
    immediate: true,
    attempt: async () => {
      events.push('a2');
      return 'delivered';
    },
    onExhausted: () => undefined,
  });
  queue.enqueue('b', {
    label: 'b1',
    immediate: true,
    attempt: async () => {
      events.push('b1');
      return 'delivered';
    },
    onExhausted: () => undefined,
  });

  await Promise.all([queue.idle('a'), queue.idle('b')]);
  assert.deepEqual(
    events.filter((event) => event.startsWith('a')),
    ['a1#1', 'a1#2', 'a1#3', 'a2'],
  );
  assert.ok(events.indexOf('b1') < events.indexOf('a1#3'));
});

function buildHarness(options: { existingAfterFirstFailure?: boolean } = {}) {
  const store = new Map<string, unknown>();
  const cache = {
    has: async (key: string) => store.has(key),
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    setIfNotExists: async () => true,
  };
  const updates: any[] = [];
  const prismaRepository = {
    message: {
      findFirst: async () => null,
      updateMany: async (args: any) => {
        updates.push(args);
        return { count: 1 };
      },
    },
  };
  const waMonitor = { waInstances: { [instance.instanceName]: {} } };
  const service: any = new ChatwootService(waMonitor as any, {} as any, prismaRepository as any, cache as any);

  const calls = { createMessage: [] as any[], createConversation: 0, lookups: 0 };
  const stored = new Map<string, { chatwootMessageId: number; chatwootConversationId: number }>();
  const behavior = {
    createConversation: (): Promise<number> | number => 77,
    createMessage: (_id: string): any => ({ id: 900, conversation_id: 77, inbox_id: 1 }),
  };

  service.provider = { accountId: 1, nameInbox: 'inbox' };
  service.clientCw = async () => ({});
  service.createConversation = async () => {
    calls.createConversation += 1;
    return behavior.createConversation();
  };
  service.createMessage = async (...args: any[]) => {
    calls.createMessage.push(args);
    return behavior.createMessage(args[7]);
  };
  service.findChatwootMessageByKey = async (_instance: unknown, key: any) => {
    calls.lookups += 1;
    return stored.get(key.id) || null;
  };
  service.retryQueue = new OrderedRetryQueue([1, 1, 1, 1, 1], async () => undefined);

  return { service, calls, updates, stored, behavior, store, options };
}

const textMessage = (id: string, remoteJid = chatA) => ({
  key: { remoteJid, fromMe: false, id },
  pushName: 'Maria',
  messageType: 'conversation',
  message: { conversation: 'texto de teste' },
});

const settle = (service: any, remoteJid = chatA) => service.retryQueue.idle(`${instance.instanceName}:${remoteJid}`);

test('temporary failure then success delivers the message exactly once and links the stored row', async () => {
  const { service, calls, updates, behavior } = buildHarness();
  let failures = 2;
  behavior.createConversation = () => {
    if (failures-- > 0) throw networkError();
    return 77;
  };

  const first = await service.eventWhatsapp('messages.upsert', instance, textMessage('ID-1'));
  assert.equal(first, null);
  await settle(service);

  assert.equal(calls.createMessage.length, 1);
  assert.equal(calls.createMessage[0][7], 'WAID:ID-1');
  assert.deepEqual(updates[0].data, { chatwootMessageId: 900, chatwootConversationId: 77, chatwootInboxId: 1 });
  assert.equal(service.inFlightDeliveries.size, 0);
});

test('Chatwoot stored the message but the response was lost: no duplicate is created', async () => {
  const { service, calls, updates, stored, behavior } = buildHarness();
  behavior.createMessage = (sourceId: string) => {
    stored.set(sourceId.replace('WAID:', ''), { chatwootMessageId: 555, chatwootConversationId: 77 });
    throw networkError('ETIMEDOUT');
  };

  await service.eventWhatsapp('messages.upsert', instance, textMessage('ID-2'));
  await settle(service);

  assert.equal(calls.createMessage.length, 1);
  assert.equal(calls.lookups >= 1, true);
  assert.deepEqual(updates[0].data, { chatwootMessageId: 555, chatwootConversationId: 77 });
});

test('definitive errors are not retried', async () => {
  const definitive = [apiError(422, { error: 'invalid' }), apiError(404, { error: 'Resource could not be found' })];

  for (const error of definitive) {
    const { service, calls, behavior } = buildHarness();
    behavior.createMessage = () => {
      throw error;
    };

    assert.ok((await service.eventWhatsapp('messages.upsert', instance, textMessage('ID-3'))) == null);
    assert.equal(service.retryQueue.hasPending(`${instance.instanceName}:${chatA}`), false);
    assert.equal(calls.createMessage.length, 1);
  }

  const { service, calls, behavior } = buildHarness();
  behavior.createMessage = () => {
    throw new TypeError("Cannot read properties of null (reading 'split')");
  };
  await service.eventWhatsapp('messages.upsert', instance, textMessage('ID-4'));
  assert.equal(service.retryQueue.hasPending(`${instance.instanceName}:${chatA}`), false);
  assert.equal(calls.createMessage.length, 1);
});

test('gives up after the last attempt and logs instance, id and remoteJid without the message content', async () => {
  const { service, calls, behavior } = buildHarness();
  behavior.createConversation = () => {
    throw networkError();
  };
  const logged: string[] = [];
  service.logger = Object.assign(Object.create(service.logger), {
    warn: () => undefined,
    error: (text: string) => logged.push(String(text)),
  });

  await service.eventWhatsapp('messages.upsert', instance, textMessage('ID-5'));
  await settle(service);

  assert.equal(calls.createMessage.length, 0);
  const abandoned = logged.find((line) => line.includes('abandoned'));
  assert.ok(abandoned);
  assert.ok(abandoned.includes('inst-test') && abandoned.includes('ID-5') && abandoned.includes(chatA));
  assert.equal(abandoned.includes('texto de teste'), false);
});

test('while a conversation is being retried, later messages wait in order and other chats are not blocked', async () => {
  const { service, behavior } = buildHarness();
  const delivered: string[] = [];
  let failures = 2;
  behavior.createMessage = (sourceId: string) => {
    if (sourceId === 'WAID:ID-A1' && failures-- > 0) throw networkError();
    delivered.push(sourceId);
    return { id: 1, conversation_id: 77, inbox_id: 1 };
  };

  await service.eventWhatsapp('messages.upsert', instance, textMessage('ID-A1', chatA));
  await service.eventWhatsapp('messages.upsert', instance, textMessage('ID-A2', chatA));
  await service.eventWhatsapp('messages.upsert', instance, textMessage('ID-B1', chatB));

  assert.deepEqual(delivered, ['WAID:ID-B1']);
  await settle(service, chatA);
  assert.deepEqual(delivered, ['WAID:ID-B1', 'WAID:ID-A1', 'WAID:ID-A2']);
});

test('a pending delivery stored before a restart is resumed from the stored message and then cleared', async () => {
  const { service, calls, store } = buildHarness();
  const pendingKey = `chatwoot:pendingDeliveries:${instance.instanceName}`;
  store.set(pendingKey, [{ id: 'ID-7', remoteJid: chatA, event: 'messages.upsert', enqueuedAt: Date.now() }]);
  service.prismaRepository.message.findFirst = async () => textMessage('ID-7');

  await service.resumePendingDeliveries(instance);
  await settle(service);

  assert.equal(calls.createMessage.length, 1);
  assert.equal(calls.createMessage[0][7], 'WAID:ID-7');
  assert.equal(store.has(pendingKey), false);
});
