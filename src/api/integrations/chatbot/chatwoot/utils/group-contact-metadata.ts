type GroupContact = {
  name?: string | null;
  thumbnail?: string | null;
};

type GroupMetadata = {
  subject?: string | null;
  profilePictureUrl?: string | null;
};

function pictureKey(url?: string | null) {
  return url?.split('#')[0].split('?')[0].split('/').pop() || '';
}

export function buildGroupContactUpdate(contact: GroupContact, metadata: GroupMetadata) {
  const subject = metadata.subject?.trim();
  const avatarUrl = metadata.profilePictureUrl?.trim();
  const update: { name?: string; avatar_url?: string } = {};

  if (subject && contact.name !== subject) {
    update.name = subject;
  }

  if (avatarUrl && pictureKey(avatarUrl) !== pictureKey(contact.thumbnail)) {
    update.avatar_url = avatarUrl;
  }

  return update;
}
