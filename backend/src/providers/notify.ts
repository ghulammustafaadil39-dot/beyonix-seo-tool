import nodemailer from 'nodemailer';
import { config, hasSmtp, hasTelegram } from '../config.js';
import type { NotifyProvider } from './types.js';

class RealNotifyProvider implements NotifyProvider {
  name = 'notify';
  private mailer = hasSmtp()
    ? nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpPort === 465,
        auth: { user: config.smtpUser, pass: config.smtpPass },
      })
    : null;

  async sendEmail(to: string, subject: string, html: string): Promise<void> {
    if (!this.mailer) {
      console.log(`[notify:mock-email] to=${to} subject=${subject}`);
      return;
    }
    await this.mailer.sendMail({ from: config.smtpFrom, to, subject, html });
  }

  async sendTelegram(chatId: string, text: string): Promise<void> {
    if (!hasTelegram()) {
      console.log(`[notify:mock-telegram] chat=${chatId} text=${text.slice(0, 120)}`);
      return;
    }
    const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // B2-M5: fire-and-forget notification — never let a stalled Telegram
      // call hold a request/job; 10s is generous for a sendMessage call.
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`Telegram error: ${res.status} ${await res.text()}`);
  }
}

let cached: NotifyProvider | null = null;
export function getNotify(): NotifyProvider {
  if (!cached) {
    if (!hasSmtp() && !hasTelegram()) console.log('[provider] notify in log-only mock mode (no SMTP/Telegram configured)');
    cached = new RealNotifyProvider();
  }
  return cached;
}
