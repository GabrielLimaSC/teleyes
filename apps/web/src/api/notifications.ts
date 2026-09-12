import { apiRequest, jsonHeaders } from './http'

export interface TestNotificationResponse {
  delivered: boolean
  status: string
  recipient_id: number
  chat_id: string
}

export const testNotification = (
  csrfToken: string,
  chatId: string,
  text: string,
): Promise<TestNotificationResponse> =>
  apiRequest<TestNotificationResponse>('/notifications/test', {
    method: 'POST',
    headers: jsonHeaders(csrfToken),
    body: JSON.stringify({ chat_id: chatId, text }),
  })
