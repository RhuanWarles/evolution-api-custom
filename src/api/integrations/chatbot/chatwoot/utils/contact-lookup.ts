type ContactRecord = {
  id?: number;
  identifier?: string | null;
  [key: string]: unknown;
};

type UnknownRecord = Record<string, any>;

type ContactsApi = {
  search: (params: { accountId: number; q: string; sort: 'name' }) => Promise<any>;
  filter: (params: {
    accountId: number;
    payload: Array<{
      attribute_key: 'identifier';
      filter_operator: 'equal_to';
      values: string[];
      query_operator: null;
    }>;
  }) => Promise<any>;
};

type Logger = {
  warn: (message: string) => void;
};

export type ContactIdentityContext = {
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  phoneNumber?: string | null;
};

export function normalizeChatwootContact(response: unknown): ContactRecord | null {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;

  const value = response as UnknownRecord;
  const candidates = [value, value.payload, value.payload?.contact, value.contact];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;

    const id = Number((candidate as UnknownRecord).id);
    if (Number.isInteger(id) && id > 0) {
      return { ...(candidate as ContactRecord), id };
    }
  }

  return null;
}

export function normalizeChatwootContacts(response: unknown): ContactRecord[] {
  const values = Array.isArray(response)
    ? response
    : response && typeof response === 'object' && Array.isArray((response as UnknownRecord).payload)
      ? (response as UnknownRecord).payload
      : [];

  return values.map(normalizeChatwootContact).filter((contact): contact is ContactRecord => Boolean(contact));
}

export async function findExactContactByIdentifier(
  contactsApi: ContactsApi,
  accountId: number,
  identifier: string,
  logger: Logger,
) {
  try {
    const searchResult = await contactsApi.search({ accountId, q: identifier, sort: 'name' });
    const exactContact = normalizeChatwootContacts(searchResult).find((contact) => contact.identifier === identifier);
    if (exactContact) return exactContact;
  } catch (error) {
    logger.warn(
      `Contact identifier search failed for ${identifier}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  try {
    const filterResult = await contactsApi.filter({
      accountId,
      payload: [
        {
          attribute_key: 'identifier',
          filter_operator: 'equal_to',
          values: [identifier],
          query_operator: null,
        },
      ],
    });
    return normalizeChatwootContacts(filterResult).find((contact) => contact.identifier === identifier) || null;
  } catch (error) {
    logger.warn(
      `Contact identifier filter failed for ${identifier}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return null;
  }
}

export function contactIdentifierCandidates(body: any, phoneNumber: string) {
  return contactIdentifierCandidatesFromContext({
    remoteJid: body?.key?.remoteJid,
    remoteJidAlt: body?.key?.remoteJidAlt,
    phoneNumber,
  });
}

export async function findContactByIdentifiers(
  contactsApi: ContactsApi,
  accountId: number,
  identifiers: string[],
  logger: Logger,
) {
  for (const identifier of identifiers) {
    const contact = await findExactContactByIdentifier(contactsApi, accountId, identifier, logger);
    if (contact) return { contact, identifier };
  }

  return { contact: null, identifier: null };
}

export function normalizeWhatsAppPhone(value?: string | null) {
  if (!value || value.endsWith('@lid') || value.endsWith('@g.us') || value === 'status@broadcast') {
    return null;
  }

  const number = value.split('@')[0].split(':')[0].replace(/\D/g, '');
  return number || null;
}

export function normalizeWhatsAppPhoneWithPlus(value?: string | null) {
  const number = normalizeWhatsAppPhone(value);
  return number ? `+${number}` : null;
}

export function contactIdentifierCandidatesFromContext(context: ContactIdentityContext) {
  const candidates = [context.remoteJid, context.remoteJidAlt, context.phoneNumber]
    .filter((value): value is string => typeof value === 'string' && value.includes('@'))
    .filter((value) => !value.endsWith('@g.us'));

  const phoneJid = normalizeWhatsAppPhoneWithPlus(context.remoteJidAlt || context.phoneNumber);
  if (phoneJid) {
    candidates.push(`${phoneJid.slice(1)}@s.whatsapp.net`);
  }

  return [...new Set(candidates)];
}

export function contactPhoneCandidatesFromContext(context: ContactIdentityContext) {
  return [context.remoteJidAlt, context.remoteJid, context.phoneNumber]
    .map((value) => normalizeWhatsAppPhoneWithPlus(value))
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
}

export function contactIdentityKey(context: ContactIdentityContext) {
  const phone = [context.remoteJidAlt, context.phoneNumber, context.remoteJid]
    .map((value) => normalizeWhatsAppPhone(value))
    .find(Boolean);
  if (phone) return `phone:${phone}`;

  const identifier = context.remoteJid || context.remoteJidAlt || context.phoneNumber;
  return `jid:${identifier || 'unknown'}`;
}

export function selectPreferredPhoneContact(contacts: ContactRecord[], phoneNumbers: string[]) {
  const normalizedPhoneNumbers = phoneNumbers.map((phoneNumber) => normalizeWhatsAppPhone(phoneNumber));
  const matches = contacts.filter((contact) =>
    normalizedPhoneNumbers.includes(normalizeWhatsAppPhone(String(contact.phone_number))),
  );
  if (!matches.length) return null;

  return [...matches].sort((left, right) => {
    const leftHasInbox = Array.isArray(left.contact_inboxes) && left.contact_inboxes.length > 0 ? 0 : 1;
    const rightHasInbox = Array.isArray(right.contact_inboxes) && right.contact_inboxes.length > 0 ? 0 : 1;
    return leftHasInbox - rightHasInbox || Number(left.id || 0) - Number(right.id || 0);
  })[0];
}
