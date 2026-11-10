import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGroupMessageContent,
  formatGroupParticipantHeader,
} from '../src/api/integrations/chatbot/chatwoot/utils/group-participant-header';

const groupJid = '120363417176051812@g.us';
const phoneHeader = '+55 62 99466 5004';

test('fromMe group message with a LID participant and no participantAlt does not throw and keeps only the text', () => {
  const body = {
    pushName: 'Eu',
    key: {
      remoteJid: groupJid,
      fromMe: true,
      id: '3EB0C288DBCF0519F7FC0F',
      participant: '215041026556054@lid',
      addressingMode: 'lid',
    },
  };

  assert.equal(formatGroupParticipantHeader(body), '');
  assert.equal(buildGroupMessageContent(body, 'olá grupo'), 'olá grupo');
});

test('fromMe group message ignores participantAlt and never adds a header', () => {
  const body = {
    pushName: 'Eu',
    key: { fromMe: true, participant: '215041026556054@lid', participantAlt: '5562994665004@s.whatsapp.net' },
  };

  assert.equal(buildGroupMessageContent(body, 'olá'), 'olá');
});

test('received group message with participantAlt gets the international phone header', () => {
  const body = {
    pushName: 'Maria',
    key: {
      remoteJid: groupJid,
      fromMe: false,
      participant: '215041026556054@lid',
      participantAlt: '5562994665004@s.whatsapp.net',
      addressingMode: 'lid',
    },
  };

  assert.equal(formatGroupParticipantHeader(body), `**${phoneHeader} - Maria:**`);
  assert.equal(buildGroupMessageContent(body, 'oi'), `**${phoneHeader} - Maria:**\n\noi`);
});

test('received group message with only a LID falls back to the name without throwing', () => {
  const body = {
    pushName: 'Maria',
    key: { remoteJid: groupJid, fromMe: false, participant: '215041026556054@lid', addressingMode: 'lid' },
  };

  assert.equal(formatGroupParticipantHeader(body), '**Maria:**');
  assert.equal(buildGroupMessageContent(body, 'oi'), '**Maria:**\n\noi');
});

test('received group message with only a LID and no name falls back to the raw identifier', () => {
  const body = { key: { fromMe: false, participant: '215041026556054@lid', addressingMode: 'lid' } };

  assert.equal(formatGroupParticipantHeader(body), '**215041026556054:**');
});

test('group message without participant in the key does not throw', () => {
  assert.equal(buildGroupMessageContent({ pushName: 'Maria', key: { fromMe: true } }, 'oi'), 'oi');
  assert.equal(buildGroupMessageContent({ pushName: 'Maria', key: { fromMe: false } }, 'oi'), '**Maria:**\n\noi');
  assert.equal(buildGroupMessageContent({ key: { fromMe: false } }, 'oi'), 'oi');
  assert.equal(buildGroupMessageContent({}, 'oi'), 'oi');
});

test('uses body.participant when the key has no participant', () => {
  const body = { pushName: 'Maria', participant: '5562994665004@s.whatsapp.net', key: { fromMe: false } };

  assert.equal(formatGroupParticipantHeader(body), `**${phoneHeader} - Maria:**`);
});

test('keeps the existing header when the participant is already a phone JID', () => {
  const pnAddressing = {
    pushName: 'Maria',
    key: { fromMe: false, participant: '5562994665004@s.whatsapp.net', addressingMode: 'pn' },
  };
  const legacyDevice = {
    pushName: 'Maria',
    key: { fromMe: false, participant: '5562994665004:12@s.whatsapp.net' },
  };
  // In "pn" addressing participantAlt may hold the LID: it must not replace the phone number.
  const pnWithLidAlt = {
    pushName: 'Maria',
    key: {
      fromMe: false,
      participant: '5562994665004@s.whatsapp.net',
      participantAlt: '215041026556054@lid',
      addressingMode: 'pn',
    },
  };

  for (const body of [pnAddressing, legacyDevice, pnWithLidAlt]) {
    assert.equal(formatGroupParticipantHeader(body), `**${phoneHeader} - Maria:**`);
  }
});

test('an unparseable number degrades to the name instead of throwing', () => {
  const body = { pushName: 'Maria', key: { fromMe: false, participant: 'abc@s.whatsapp.net' } };

  assert.equal(formatGroupParticipantHeader(body), '**Maria:**');
});

test('received group media without caption keeps only the header, and fromMe media is empty', () => {
  const received = { pushName: 'Maria', key: { fromMe: false, participantAlt: '5562994665004@s.whatsapp.net' } };
  const sent = { pushName: 'Eu', key: { fromMe: true, participant: '215041026556054@lid' } };

  assert.equal(buildGroupMessageContent(received, ''), `**${phoneHeader} - Maria:**`);
  assert.equal(buildGroupMessageContent(received, undefined), `**${phoneHeader} - Maria:**`);
  assert.equal(buildGroupMessageContent(sent, ''), '');
  assert.equal(buildGroupMessageContent(sent, undefined), '');
});
