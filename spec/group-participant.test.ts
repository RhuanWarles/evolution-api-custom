import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeGroupParticipant,
  resolveParticipantPhoneJid,
} from '../src/api/integrations/chatbot/chatwoot/utils/group-participant';

const groupJid = '120363000000000001@g.us';
const lid = '215041026556054@lid';

// Shape emitted by the Baileys placeholder resend: author outside the key, key fields missing.
const placeholderResend = () => ({
  key: { remoteJid: groupJid, fromMe: false, id: 'ID1' } as any,
  participant: lid,
  pushName: undefined as string | undefined,
});

test('copies the outer participant into the key and maps the LID to a phone', async () => {
  const message = placeholderResend();
  const lookups: string[] = [];

  await normalizeGroupParticipant(message, async (jid) => {
    lookups.push(jid);
    return '5511999990000:7@s.whatsapp.net';
  });

  assert.deepEqual(lookups, [lid]);
  assert.equal(message.key.participant, lid);
  assert.equal(message.key.participantAlt, '5511999990000@s.whatsapp.net');
  assert.equal(message.key.addressingMode, 'lid');
});

test('keeps delivering when the LID lookup throws or returns nothing', async () => {
  const errors: unknown[] = [];
  const failing = placeholderResend();
  await normalizeGroupParticipant(
    failing,
    async () => {
      throw new Error('lookup failed');
    },
    (error) => errors.push(error),
  );

  assert.equal(errors.length, 1);
  assert.equal(failing.key.participant, lid);
  assert.equal(failing.key.participantAlt, undefined);
  assert.equal(failing.key.addressingMode, 'lid');
  assert.equal(resolveParticipantPhoneJid(failing), null);

  const empty = placeholderResend();
  await normalizeGroupParticipant(empty, async () => null);
  assert.equal(empty.key.participantAlt, undefined);
});

test('does not overwrite values already present', async () => {
  const message = {
    key: {
      remoteJid: groupJid,
      participant: '5511111110000@s.whatsapp.net',
      participantAlt: '5511222220000@s.whatsapp.net',
      addressingMode: 'pn',
    },
    participant: lid,
  };
  const lidKey = {
    key: { remoteJid: groupJid, participant: lid, participantAlt: '5511333330000@s.whatsapp.net' } as any,
  };
  let lookups = 0;
  const resolver = async () => {
    lookups += 1;
    return '5511999990000@s.whatsapp.net';
  };

  await normalizeGroupParticipant(message, resolver);
  await normalizeGroupParticipant(lidKey, resolver);

  assert.equal(message.key.participant, '5511111110000@s.whatsapp.net');
  assert.equal(message.key.participantAlt, '5511222220000@s.whatsapp.net');
  assert.equal(message.key.addressingMode, 'pn');
  assert.equal(lidKey.key.participantAlt, '5511333330000@s.whatsapp.net');
  assert.equal(lookups, 0);
});

test('does not touch non-group messages and tolerates a message without participant', async () => {
  const direct = { key: { remoteJid: '5511999990000@s.whatsapp.net' } as any, participant: lid };
  await normalizeGroupParticipant(direct);
  assert.equal(direct.key.participant, undefined);

  const none = { key: { remoteJid: groupJid } as any };
  await normalizeGroupParticipant(none, async () => {
    throw new Error('must not be called');
  });
  assert.deepEqual(none.key, { remoteJid: groupJid });
});

test('resolveParticipantPhoneJid never returns a LID and strips the device suffix', () => {
  assert.equal(resolveParticipantPhoneJid({ key: { participant: lid } }), null);
  assert.equal(resolveParticipantPhoneJid({ key: {} }), null);
  assert.equal(resolveParticipantPhoneJid(null), null);
  assert.equal(
    resolveParticipantPhoneJid({ key: { participant: lid, participantAlt: '5511999990000:3@s.whatsapp.net' } }),
    '5511999990000@s.whatsapp.net',
  );
  assert.equal(
    resolveParticipantPhoneJid({ key: { participant: '5511888880000@s.whatsapp.net', participantAlt: lid } }),
    '5511888880000@s.whatsapp.net',
  );
});
