import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BodyOf, ResponseOf } from '@between-pages/contracts';
import { callApi } from '../api/client.ts';

// The caller's own email reminder settings (email-reminders D8), shared by the settings page
// and the home notice.

export type MailSettings = ResponseOf<'mail'>['mail'];
export type MailCategory = ResponseOf<'unsubscribeCategory'>['category'];

export const mailKey = ['mail'] as const;

export const useMailSettings = () =>
  useQuery({ queryKey: mailKey, queryFn: async () => (await callApi('mail')).mail });

/** Saves a change and puts the server's answer in the cache. */
export function useSaveMail() {
  const client = useQueryClient();
  return async (body: BodyOf<'saveMail'>) => {
    const { mail } = await callApi('saveMail', { body });
    client.setQueryData(mailKey, mail);
    return mail;
  };
}

/** What each category is called on the pages and in the mails' unsubscribe question. */
export const CATEGORY_NAME: Record<MailCategory, string> = {
  new_content: '有新内容',
  anniversary: '纪念日',
  backup: '备份',
};
