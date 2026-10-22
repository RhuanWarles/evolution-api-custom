import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGroupContactUpdate } from '../src/api/integrations/chatbot/chatwoot/utils/group-contact-metadata';

test('updates a stale group subject and avatar without changing the group identity', () => {
  assert.deepEqual(
    buildGroupContactUpdate(
      { name: 'Old subject', thumbnail: 'https://cdn.example/group-avatar-old.jpg?token=old' },
      { subject: 'Official subject', profilePictureUrl: 'https://cdn.example/group-avatar-new.jpg?token=new' },
    ),
    {
      name: 'Official subject',
      avatar_url: 'https://cdn.example/group-avatar-new.jpg?token=new',
    },
  );
});

test('does not overwrite an official subject with a participant name', () => {
  assert.deepEqual(
    buildGroupContactUpdate(
      { name: 'Official subject', thumbnail: 'https://cdn.example/group-avatar.jpg?token=old' },
      { subject: 'Official subject', profilePictureUrl: 'https://cdn.example/group-avatar.jpg?token=new' },
    ),
    {},
  );
});

test('preserves the current avatar when the photo lookup fails', () => {
  assert.deepEqual(
    buildGroupContactUpdate(
      { name: 'Old subject', thumbnail: 'https://cdn.example/group-avatar.jpg' },
      { subject: 'New subject', profilePictureUrl: null },
    ),
    { name: 'New subject' },
  );
});
