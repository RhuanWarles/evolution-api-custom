import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contactIdentifierCandidates,
  findContactByIdentifiers,
} from '../src/api/integrations/chatbot/chatwoot/utils/contact-lookup';

const logger = { warn: () => undefined };

test('resolves a LID message through remoteJidAlt without using client.get', async () => {
  const calls: string[] = [];
  const contactsApi = {
    get: () => {
      throw new Error('client.get must not be called');
    },
    search: async ({ q }: { q: string }) => {
      calls.push(`search:${q}`);
      return {
        payload: q === '556294665004@s.whatsapp.net' ? [{ id: 153, identifier: q }] : [],
      };
    },
    filter: async () => {
      calls.push('filter');
      return [];
    },
  };

  const body = {
    key: {
      remoteJid: '281449391493336@lid',
      remoteJidAlt: '556294665004@s.whatsapp.net',
    },
  };
  const identifiers = contactIdentifierCandidates(body, body.key.remoteJidAlt);
  const result = await findContactByIdentifiers(contactsApi, 1, identifiers, logger);

  assert.deepEqual(identifiers, ['281449391493336@lid', '556294665004@s.whatsapp.net']);
  assert.deepEqual(calls, ['search:281449391493336@lid', 'filter', 'search:556294665004@s.whatsapp.net']);
  assert.equal(result.contact?.id, 153);
  assert.equal(result.identifier, '556294665004@s.whatsapp.net');
});

test('returns no identifier contact so phone fallback can continue', async () => {
  const contactsApi = {
    search: async () => ({ payload: [] }),
    filter: async () => [],
  };

  const result = await findContactByIdentifiers(
    contactsApi,
    1,
    ['281449391493336@lid', '556294665004@s.whatsapp.net'],
    logger,
  );

  assert.equal(result.contact, null);
  assert.equal(result.identifier, null);
});
