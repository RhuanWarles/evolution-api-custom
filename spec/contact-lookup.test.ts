import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contactIdentityKey,
  contactIdentifierCandidates,
  contactPhoneCandidatesFromContext,
  findContactByIdentifiers,
  normalizeWhatsAppPhone,
  selectPreferredPhoneContact,
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

test('correlates LID, remoteJidAlt and normalized phone before contact creation', () => {
  const body = {
    key: {
      remoteJid: '281449391493336@lid',
      remoteJidAlt: '556294665004@s.whatsapp.net',
    },
  };

  assert.deepEqual(contactPhoneCandidatesFromContext({ ...body.key }), ['+556294665004']);
  assert.equal(contactIdentityKey({ ...body.key }), 'phone:556294665004');
  assert.equal(normalizeWhatsAppPhone('+55 (62) 94665-004'), '556294665004');
});

test('reuses the phone contact when a duplicate identifier contact already exists', () => {
  const phoneContact = { id: 30, phone_number: '+556294665004', identifier: null, contact_inboxes: [{ id: 136 }] };
  const identifierContact = {
    id: 153,
    phone_number: '+556294665004',
    identifier: '556294665004@s.whatsapp.net',
    contact_inboxes: [],
  };

  assert.equal(selectPreferredPhoneContact([identifierContact, phoneContact], ['556294665004@s.whatsapp.net'])?.id, 30);
});

test('selects the oldest deterministic contact when duplicate phone formats have no inbox', () => {
  const selected = selectPreferredPhoneContact(
    [
      { id: 42, phone_number: '+556294665004', contact_inboxes: [] },
      { id: 41, phone_number: '556294665004', contact_inboxes: [] },
    ],
    ['+556294665004'],
  );

  assert.equal(selected?.id, 41);
});

test('does not select a partial or unrelated phone result', () => {
  const selected = selectPreferredPhoneContact(
    [{ id: 90, phone_number: '+5511999999999', contact_inboxes: [] }],
    ['+556294665004'],
  );

  assert.equal(selected, null);
});
