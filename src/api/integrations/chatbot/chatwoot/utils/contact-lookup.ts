type ContactRecord = {
  id?: number;
  identifier?: string | null;
  [key: string]: unknown;
};

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

const contactRecords = (result: ContactRecord[] | { payload?: ContactRecord[] } | undefined) => {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.payload) ? result.payload : [];
};

export async function findExactContactByIdentifier(
  contactsApi: ContactsApi,
  accountId: number,
  identifier: string,
  logger: Logger,
) {
  try {
    const searchResult = await contactsApi.search({ accountId, q: identifier, sort: 'name' });
    const exactContact = (searchResult?.payload || []).find((contact) => contact.identifier === identifier);
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
    return contactRecords(filterResult).find((contact) => contact.identifier === identifier) || null;
  } catch (error) {
    logger.warn(
      `Contact identifier filter failed for ${identifier}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return null;
  }
}

export function contactIdentifierCandidates(body: any, phoneNumber: string) {
  return [...new Set([body?.key?.remoteJid, body?.key?.remoteJidAlt, phoneNumber])].filter(
    (identifier): identifier is string => typeof identifier === 'string' && identifier.includes('@'),
  );
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
